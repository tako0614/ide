import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const haveTmux = spawnSync('tmux', ['-V']).status === 0;
const until = async (predicate, label) => {
  for (let n = 0; n < 100; n++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timeout: ' + label);
};

async function fixture(t, persistent) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-metadata-'));
  const dataDir = path.join(dir, 'data');
  const workdir = path.join(dir, 'work');
  const runtimeDir = path.join(dir, 'tmux');
  const commandsDir = path.join(dir, 'commands');
  await mkdir(dataDir);
  await mkdir(workdir);
  await mkdir(commandsDir);
  if (persistent) {
    const binary = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
    await writeFile(path.join(commandsDir, 'tmux'), `#!/bin/sh\nfor argument in "$@"; do\n  if [ "$argument" = 'has-session' ] && [ -f '${dir}/query-unavailable' ]; then\n    printf 'injected lookup failure' >&2; exit 1\n  fi\ndone\nexec '${binary}' "$@"\n`, { mode: 0o700 });
  }
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ port }));
  // Do not inherit the invoking terminal's DB, tokens, desktop or tmux settings.
  const env = { PATH: `${commandsDir}:${process.env.PATH}`, HOME: os.homedir(), SHELL: '/bin/sh', LANG: 'C.UTF-8',
    NODE_ENV: 'test', DECKIDE_DATA_DIR: dataDir, DB_PATH: path.join(dataDir, 'deck-ide.db'),
    PORT: String(port), HOST: '127.0.0.1', DECKIDE_DESKTOP: 'false',
    AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false',
    ...(persistent ? { DECKIDE_TMUX_RUNTIME_DIR: runtimeDir } : {}) };
  let child;
  let logs = '';
  const start = async () => {
    child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    await until(async () => {
      if (child.exitCode !== null) throw new Error('Server exited: ' + logs);
      try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; }
    }, 'server listening');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM'); // Only the Node server started by this fixture.
    await exited;
  };
  const run = (...args) => spawnSync(process.execPath, ['bin/deckide.js', ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
  const cli = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const api = async (route, method = 'GET', body) => {
    const { token } = JSON.parse(await readFile(path.join(dataDir, 'cli.json'), 'utf8'));
    return fetch(`http://127.0.0.1:${port}/api${route}`, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const tmux = (...args) => execFileSync('tmux', ['-S', path.join(runtimeDir, 'tmux.sock'), ...args], { encoding: 'utf8' }).trim();
  t.after(async () => {
    // Let our workload and shells finish normally; never kill a tmux session/server.
    await writeFile(path.join(workdir, 'finish'), 'done');
    if (persistent) {
      let sessions = [];
      try { sessions = tmux('list-sessions', '-F', '#{session_name}').split('\n'); } catch { /* already exited */ }
      for (const name of sessions.filter((name) => name.startsWith('deckide-'))) {
        try { tmux('send-keys', '-t', `=${name}:0.0`, 'exit', 'Enter'); } catch { /* already exited */ }
      }
      await until(() => {
        try { tmux('list-sessions'); return false; } catch { return true; }
      }, 'test shells finish');
    }
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  await start();
  return { dir, workdir, dataDir, start, stop, cli, run, api, tmux, env };
}

for (const persistent of [false, true]) {
  test(`session move/rename keeps live output and processes (${persistent ? 'tmux + restart' : 'direct PTY'})`,
    { skip: persistent && !haveTmux, timeout: 30000 }, async (t) => {
      const f = await fixture(t, persistent);
      f.cli('open', f.workdir, '-t', 'original');
      const state = JSON.parse(f.cli('ls', '--json'));
      const terminal = state.terminals[0];
      const deck = state.decks[0];
      const destination = await (await f.api('/decks', 'POST', { workspaceId: deck.workspaceId, name: 'destination' })).json();
      const name = `deckide-${terminal.id}`;
      const identity = persistent ? f.tmux('display-message', '-p', '-t', `=${name}:0.0`, '#{session_id}:#{pane_id}:#{pane_pid}') : null;
      const { token } = JSON.parse(await readFile(path.join(f.dataDir, 'cli.json'), 'utf8'));
      const socket = new WebSocket(`ws://127.0.0.1:${f.env.PORT}/api/terminals/${terminal.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      t.after(() => socket.terminate());
      let output = '';
      socket.on('message', (data, binary) => { if (binary) output += data.toString(); });
      await once(socket, 'open');
      // Keep both shell-local state and a child process across metadata changes.
      const workload = path.join(f.workdir, 'workload.cjs');
      await writeFile(workload, `const fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(path.join(f.workdir, 'child.pid'))}, String(process.pid));\nconst timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(path.join(f.workdir, 'finish'))})) clearInterval(timer); }, 50);\n`);
      f.cli('send', terminal.id, `KEEP_STATE=survived; printf '%s' "$$" > '${f.workdir}/shell.pid'; '${process.execPath}' '${workload}' &`);
      await until(async () => { try { return Number(await readFile(path.join(f.workdir, 'child.pid'), 'utf8')) > 0; } catch { return false; } }, 'child started');
      const shellPid = Number(await readFile(path.join(f.workdir, 'shell.pid'), 'utf8'));
      const childPid = Number(await readFile(path.join(f.workdir, 'child.pid'), 'utf8'));
      const originalStart = process.platform === 'linux' ? await readFile(`/proc/${childPid}/stat`, 'utf8') : null;
      f.cli('session', 'move', terminal.id.slice(0, 8), destination.id);
      f.cli('session', 'rename', terminal.id, 'renamed 日本語 with spaces');
      assert.equal(socket.readyState, WebSocket.OPEN);
      f.cli('send', terminal.id, 'printf "state-%s-pid-%s\\n" "$KEEP_STATE" "$$"');
      await until(() => output.includes(`state-survived-pid-${shellPid}`), 'same connection receives output after move/rename');
      const verifyState = async () => {
        const current = JSON.parse(f.cli('ls', '--json')).terminals.find((value) => value.id === terminal.id);
        assert.equal(current.deckId, destination.id);
        assert.equal(current.title, 'renamed 日本語 with spaces');
        const db = new DatabaseSync(path.join(f.dataDir, 'deck-ide.db'), { readOnly: true });
        try {
          const row = db.prepare('SELECT deck_id, title FROM terminals WHERE id = ?').get(terminal.id);
          assert.equal(row.deck_id, destination.id);
          assert.equal(row.title, current.title);
        } finally { db.close(); }
        process.kill(shellPid, 0);
        process.kill(childPid, 0);
        if (originalStart) assert.equal((await readFile(`/proc/${childPid}/stat`, 'utf8')).split(' ')[21], originalStart.split(' ')[21]);
        if (persistent) assert.equal(f.tmux('display-message', '-p', '-t', `=${name}:0.0`, '#{session_id}:#{pane_id}:#{pane_pid}'), identity);
      };
      await verifyState();
      for (const args of [['session'], ['session', 'move', terminal.id], ['session', 'rename', terminal.id, ' '],
        ['session', 'rename', terminal.id, 'a', 'b'], ['session', 'move', terminal.id, 'missing'], ['session', 'rename', 'missing', 'name']]) {
        assert.equal(f.run(...args).status, 1, JSON.stringify(args));
      }
      await verifyState();
      if (persistent) {
        await writeFile(path.join(f.dir, 'query-unavailable'), 'inject temporary failure');
        const displayClient = f.tmux('list-clients', '-t', `=${name}`, '-F', '#{client_name}');
        f.tmux('detach-client', '-t', displayClient);
        await until(() => socket.readyState === WebSocket.CLOSED, 'display disconnect closes its old connection');
        await verifyState(); // A failed lookup must not erase the row or its owner.
        await rm(path.join(f.dir, 'query-unavailable'));
        await until(() => JSON.parse(f.cli('ls', '--json')).terminals.some((value) => value.id === terminal.id), 'display is restored');
        await verifyState();
        await f.stop();
        assert.equal(f.tmux('display-message', '-p', '-t', `=${name}:0.0`, '#{session_id}:#{pane_id}:#{pane_pid}'), identity);
        process.kill(childPid, 0);
        await f.start();
        await verifyState();
        // The restored terminal can still interact with the same shell.
        f.cli('send', terminal.id, `printf '%s:%s' "$KEEP_STATE" "$$" > '${f.workdir}/after-restart'`);
        await until(async () => { try { return (await readFile(path.join(f.workdir, 'after-restart'), 'utf8')) === `survived:${shellPid}`; } catch { return false; } }, 'shell state after restart');
      }
      await writeFile(path.join(f.workdir, 'finish'), 'done');
      f.cli('send', terminal.id, `wait; printf done > '${f.workdir}/child-finished'`);
      await until(async () => { try { return (await readFile(path.join(f.workdir, 'child-finished'), 'utf8')) === 'done'; } catch { return false; } }, 'shell reaps its child');
      await until(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }, 'child finishes normally');
    });
}
