import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmux = spawnSync('tmux', ['-V']).status === 0;
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

test('queue CLI uses a throwaway backend/native TUI, CR-only input and JSON refusal with no dialog input', { skip: !tmux && 'tmux unavailable' }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'deckide-queue-live-'));
  const data = path.join(temp, 'data');
  const home = path.join(temp, 'home');
  const workspace = path.join(temp, 'workspace');
  await Promise.all([data, home, workspace].map((dir) => mkdir(dir)));
  const listener = http.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  // Explicit env -u removes every inherited DECKIDE_* and TMUX* before
  // installing only this instance's settings. A minimal child environment
  // also prevents inherited DB paths, browser settings and credentials.
  const stripped = Object.keys(process.env).filter((key) => /^(?:DECKIDE_|TMUX)/.test(key)).flatMap((key) => ['-u', key]);
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, SHELL: '/bin/sh', TERM: 'xterm-256color',
    LANG: 'C.UTF-8', CODEX_HOME: path.join(temp, 'codex'), NODE_ENV: 'test',
    DECKIDE_DATA_DIR: data, DECKIDE_TMUX_RUNTIME_DIR: path.join(temp, 'tmux'),
    HOST: '127.0.0.1', PORT: String(port), DEFAULT_ROOT: workspace,
    AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false' };
  const service = spawn('env', [...stripped, ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    process.execPath, 'dist/index.js'], { cwd: root, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; const keep = (data) => { output = (output + data.toString()).slice(-10000); };
  service.stdout.on('data', keep); service.stderr.on('data', keep);
  const sockets = new Set();
  const cli = (...args) => {
    try { return { code: 0, stdout: execFileSync(process.execPath, ['bin/deckide.js', 'session', ...args], { cwd: root, env, encoding: 'utf8', timeout: 12000 }) }; }
    catch (error) { return { code: error.status, stdout: error.stdout, stderr: error.stderr }; }
  };
  t.after(async () => {
    // Persistent terminals outlive HTTP; kill only verified fixture-owned sockets.
    for (const socket of sockets) spawnSync('tmux', ['-S', socket, '-N', 'kill-server'], { env, timeout: 2000 });
    if (service.exitCode === null) {
      const exited = once(service, 'exit'); service.kill('SIGTERM');
      await Promise.race([exited, delay(5000)]);
      if (service.exitCode === null) { service.kill('SIGKILL'); await exited; }
    }
    assert.notEqual(service.exitCode, null, 'throwaway HTTP process stopped');
    for (const socket of sockets) assert.notEqual(spawnSync('tmux', ['-S', socket, '-N', 'list-sessions'], { env, timeout: 2000 }).status, 0);
    // Codex may daemonize its local app server. Only processes carrying this
    // newly allocated HOME/CODEX_HOME belong to this test; recheck before kill.
    const owned = async () => {
      const pids = [];
      for (const item of await readdir('/proc')) {
        if (!/^\d+$/.test(item)) continue;
        try {
          const vars = (await readFile(`/proc/${item}/environ`, 'utf8')).split('\0');
          if (vars.includes('HOME=' + home) || vars.includes('CODEX_HOME=' + env.CODEX_HOME)) pids.push(Number(item));
        } catch {}
      }
      return pids;
    };
    for (const pid of await owned()) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await delay(100);
    for (const pid of await owned()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await delay(100);
    assert.deepEqual(await owned(), [], 'no test Codex/app-server/sleeper processes remain');
    await rm(temp, { recursive: true, force: true });
  });
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    assert.equal(service.exitCode, null, output);
    await delay(100);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, output);
  // Read control only from our private instance; never a default production socket.
  const { sessionRpc } = await import('../bin/deckide-session.js');
  const rpc = (method, args) => sessionRpc(method, args, path.join(data, 'cli/control.sock'));
  for (const mode of ['queue', 'approval', 'question']) {
    const log = path.join(temp, mode + '.bytes');
    const terminal = await rpc('terminals.create', { cwd: workspace, title: 'queue-test-' + mode, cols: 120, rows: 32,
      command: ['/usr/bin/python3', path.join(root, 'tests/fixtures/queue/codex-tui.py'), mode, log].map(quote).join(' ') });
    const attachment = await rpc('terminals.attach', { id: terminal.id, readOnly: true });
    assert.ok(attachment.meta.socketPath.startsWith(temp + path.sep));
    sockets.add(attachment.meta.socketPath);
    await delay(300);
    const shown = cli('queue', 'show', terminal.id);
    if (mode === 'queue') {
      assert.equal(shown.code, 0, shown.stdout);
      assert.deepEqual(JSON.parse(shown.stdout).messages, ['Keep the first follow-up', 'Replace the last follow-up']);
      const replaced = cli('queue', 'replace', terminal.id, '新しい follow-up');
      assert.equal(replaced.code, 0, replaced.stdout);
      assert.deepEqual(JSON.parse(replaced.stdout), { id: terminal.id, count: 2, messages: ['Keep the first follow-up', '新しい follow-up'], replaced: true });
      assert.deepEqual(JSON.parse(cli('queue', 'show', terminal.id).stdout).messages, ['Keep the first follow-up', '新しい follow-up']);
      const bytes = (await readFile(log, 'utf8')).trim().split('\n').flatMap(JSON.parse);
      assert.equal(bytes.filter((byte) => byte === 13).length, 1);
      assert.ok(!bytes.includes(10) && !bytes.includes(9), 'no LF or Tab submitted');
    } else {
      assert.equal(shown.code, 1);
      assert.deepEqual(JSON.parse(shown.stdout), { ok: false, error: 'queue_dialog_open' });
      const replaced = cli('queue', 'replace', terminal.id, 'must not type');
      assert.equal(replaced.code, 1);
      assert.deepEqual(JSON.parse(replaced.stdout), { ok: false, error: 'queue_dialog_open' });
      await assert.rejects(readFile(log), { code: 'ENOENT' }, 'no terminal input in dialogs');
    }
    await rpc('terminals.delete', { id: terminal.id });
  }
  const codexBinary = process.env.DECKIDE_QUEUE_CODEX_TEST_BINARY;
  if (codexBinary) {
    const codexHome = env.CODEX_HOME;
    await mkdir(codexHome);
    await writeFile(path.join(codexHome, 'config.toml'), [
      'model = "queue-test"', 'model_provider = "queue_test"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
      '[model_providers.queue_test]', 'name = "Offline queue test"', 'base_url = "http://127.0.0.1:1/v1"',
      'wire_api = "responses"', 'requires_openai_auth = false', `[projects.${JSON.stringify(workspace)}]`, 'trust_level = "trusted"', '',
    ].join('\n'));
    const version = execFileSync(codexBinary, ['--version'], { env, encoding: 'utf8' }).trim();
    // Codex's built-in user-shell mode queues Submitted (CR) input while its
    // shell is running. This exercises a real supported queue without a model,
    // credentials, production config, network requests, or persisted settings.
    const terminal = await rpc('terminals.create', { cwd: workspace, title: 'real-codex-queue-test', cols: 160, rows: 40,
      command: [codexBinary, '--no-alt-screen', '-C', workspace, '!sleep 45'].map(quote).join(' ') });
    const attachment = await rpc('terminals.attach', { id: terminal.id, readOnly: true });
    sockets.add(attachment.meta.socketPath);
    const { captureScreen } = await import('../bin/deckide-session.js');
    const waitScreen = async (pattern, timeout = 15000) => {
      const until = Date.now() + timeout; let value;
      do { value = await captureScreen(attachment); if (pattern.test(value)) return value; await delay(100); } while (Date.now() < until);
      assert.fail('real Codex screen did not reach ' + pattern + '\n' + value);
    };
    await waitScreen(/Working.*esc to interrupt/);
    for (const text of ['Keep real Codex first', 'Replace real Codex last']) {
      await rpc('terminals.input', { id: terminal.id, data: text }); await delay(250);
      await rpc('terminals.input', { id: terminal.id, data: '\r' });
      await waitScreen(new RegExp('↳ ' + text));
    }
    const shown = cli('queue', 'show', terminal.id);
    assert.equal(shown.code, 0, shown.stdout + '\n' + await captureScreen(attachment));
    assert.deepEqual(JSON.parse(shown.stdout).messages, ['Keep real Codex first', 'Replace real Codex last']);
    const replaced = cli('queue', 'replace', terminal.id, 'Real Codex replacement');
    assert.equal(replaced.code, 0, replaced.stdout + '\n' + await captureScreen(attachment));
    assert.deepEqual(JSON.parse(replaced.stdout).messages, ['Keep real Codex first', 'Real Codex replacement']);
    assert.deepEqual(JSON.parse(cli('queue', 'show', terminal.id).stdout).messages, ['Keep real Codex first', 'Real Codex replacement']);
    await rpc('terminals.delete', { id: terminal.id });
    t.diagnostic(`${version}: real TUI shell-only queue show/replace passed (160x40)`);
  }
  assert.deepEqual(await rpc('terminals.list', {}), [], 'all test terminals removed');
  t.diagnostic(`throwaway instance port=${port}; data=${data}; env -u entries=${stripped.length / 2}; all ${codexBinary ? 4 : 3} fixture terminals deleted`);
});
