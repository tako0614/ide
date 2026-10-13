import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pty from 'node-pty';
import { isTerminalReport, parseSessionArgs } from '../bin/deckide-session.js';
import { createLocalControl } from '../dist/agents/localControl.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'deckide.js');
const haveTmux = spawnSync('sh', ['-c', 'command -v tmux']).status === 0;

// Never inherit a production DeckIDE's broker/runtime from the calling shell.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ['DECKIDE_TMUX_BROKER_REQUIRED', 'DECKIDE_TMUX_BROKER_SOCKET', 'DECKIDE_ALLOWED_HOSTS',
    'DECKIDE_SESSION_SOCKET', 'DECKIDE_TERMINAL_ID', 'DECKIDE_DECK_ID']) delete env[key];
  return env;
}

test('session CLI argument checks and terminal-report detection', () => {
  assert.deepEqual(parseSessionArgs(['send', '2', 'echo', 'hi']).positionals, ['2', 'echo', 'hi']);
  assert.equal(parseSessionArgs(['send', '2', 'x', '--no-enter']).args['no-enter'], true);
  assert.throws(() => parseSessionArgs(['send', '2']), /invalid_terminal/);
  assert.throws(() => parseSessionArgs(['kill']), /invalid_terminal/);
  assert.throws(() => parseSessionArgs(['show', 'a', 'b']), /invalid_terminal/);
  assert.throws(() => parseSessionArgs(['focus']), /invalid_terminal/);
  assert.equal(parseSessionArgs(['show', '--lines', '200', '2']).args.lines, '200');
  assert.throws(() => parseSessionArgs(['show', '--lines', 'all', '2']), /invalid_lines/);
  assert.equal(parseSessionArgs(['new', '--title', 'x', '--', 'top']).args.title, 'x');
  for (const report of ['\x1b[12;40R', '\x1b[?62;22c', '\x1b[I', '\x1b]11;rgb:1818/1818/1818\x07', '\x1b[<35;1;1M']) {
    assert.ok(isTerminalReport(report), JSON.stringify(report));
  }
  for (const typed of ['a', 'ls\r', '\x1b[A', '\x03']) assert.ok(!isTerminalReport(typed), JSON.stringify(typed));
});

test('local control maps the new CLI methods onto the HTTP API', async () => {
  const calls = [];
  const control = createLocalControl({
    agents: null,
    attachment: () => null,
    api: async (route, method = 'GET', body) => {
      calls.push([method, route, body]);
      if (route === '/api/terminals' && method === 'POST') return { id: 't1', title: body.title || 'shell', cols: 80, rows: 24 };
      return { ok: true };
    },
  });
  await control({ method: 'terminals.resize', args: { id: 't1', cols: 90, rows: 30 } });
  await control({ method: 'terminals.input', args: { id: 't1', data: 'ls\r' } });
  await control({ method: 'terminals.focus', args: { id: 't1' } });
  await control({ method: 'terminals.delete', args: { id: 't1' } });
  const created = await control({ method: 'terminals.create', args: { deckId: 'd1', title: 'work', command: 'top' } });
  assert.deepEqual(created, { id: 't1', deckId: 'd1', title: 'work', cols: 80, rows: 24 });
  assert.deepEqual(calls, [
    ['PUT', '/api/terminals/t1/size', { cols: 90, rows: 30 }],
    ['POST', '/api/terminals/t1/input', { data: 'ls\r' }],
    ['POST', '/api/terminals/t1/focus', {}],
    ['DELETE', '/api/terminals/t1', undefined],
    ['POST', '/api/terminals', { deckId: 'd1', title: 'work', command: 'top', cols: undefined, rows: undefined }],
  ]);
  await assert.rejects(control({ method: 'terminals.resize', args: { id: 't1', cols: '90', rows: 30 } }), /invalid_request/);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('CLI and web share one tmux terminal: the client used last drives the size; changes stream live',
  { skip: !haveTmux }, async (t) => {
    // Short paths: tmux sockets are limited to 107 bytes.
    const dataDir = mkdtempSync('/tmp/dkf-');
    const runtimeDir = mkdtempSync('/tmp/dkr-');
    const work = mkdtempSync(path.join(os.tmpdir(), 'deckide-follow-work-'));
    const port = await freePort();
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port }));
    const env = cleanEnv({ DECKIDE_DATA_DIR: dataDir, DECKIDE_TMUX_RUNTIME_DIR: runtimeDir, PORT: String(port),
      HOST: '127.0.0.1', AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false', SHELL: '/bin/sh' });
    const server = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: 'ignore' });
    const origin = `http://127.0.0.1:${port}`;
    const session = (...args) => spawnSync(process.execPath, [cli, 'session', ...args], { cwd: work, env, encoding: 'utf8' });
    const list = () => JSON.parse(session('list').stdout);
    let terminalId = null;
    t.after(async () => {
      if (terminalId) await fetch(`${origin}/api/terminals/${terminalId}`, { method: 'DELETE' }).catch(() => undefined);
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
      for (const dir of [dataDir, runtimeDir, work]) rmSync(dir, { recursive: true, force: true });
    });
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(origin + '/health')).ok) break; } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Live event stream (what the web UI subscribes to).
    const events = [];
    const controller = new AbortController();
    const stream = await fetch(origin + '/api/events', { signal: controller.signal });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          pending += decoder.decode(value, { stream: true });
          let index;
          while ((index = pending.indexOf('\n\n')) !== -1) {
            const block = pending.slice(0, index);
            pending = pending.slice(index + 2);
            const data = block.split('\n').find((line) => line.startsWith('data:'));
            if (block.includes('event: deckide') && data) events.push(JSON.parse(data.slice(5)));
          }
        }
      } catch { /* aborted */ }
    })();
    t.after(() => { controller.abort(); return pump; });

    const created = session('new', '--cwd', work, '--title', 'shared', '--json');
    assert.equal(created.status, 0, created.stderr);
    terminalId = JSON.parse(created.stdout).id;
    assert.equal(session('send', 'shared', 'echo sent-$((40+2))').status, 0);

    const attached = pty.spawn(process.execPath, [cli, 'session', 'attach', '1'], { cols: 100, rows: 30, cwd: work, env });
    let screen = '';
    attached.onData((data) => { screen += data; });
    const exited = new Promise((resolve) => attached.onExit(resolve));
    const until = async (predicate, label) => {
      for (let n = 0; n < 100; n++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`timeout: ${label}\n${screen.slice(-300)}`);
    };
    await until(() => screen.includes('sent-42'), 'native tmux client shows earlier output');
    await until(() => list()[0].cols === 100 && list()[0].rows === 30, 'attaching takes the size');

    // Another client (the web UI) resizes; typing in the CLI takes it back.
    await fetch(`${origin}/api/terminals/${terminalId}/size`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: 140, rows: 40 }),
    });
    assert.equal(list()[0].cols, 140);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    attached.write('echo typed\r');
    await until(() => list()[0].cols === 100, 'typing re-asserts the CLI size');
    attached.resize(80, 24);
    await until(() => list()[0].cols === 80 && list()[0].rows === 24, 'resizing the CLI window follows');

    attached.write('\x02d'); // tmux detach: the shell keeps running
    const { exitCode } = await exited;
    assert.equal(exitCode, 0);
    assert.equal(list().length, 1);

    // show reads the screen and moves no web UI; only focus does.
    const shown = session('show', 'shared');
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /sent-42/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!events.some((event) => event.type === 'ui.focus'), 'show must not move the web UI');
    assert.equal(session('focus', 'shared').status, 0);
    await until(() => events.some((event) => event.type === 'ui.focus'), 'focus moves the web UI');
    assert.equal(session('kill', 'shared').status, 0);
    terminalId = null;
    await until(() => events.some((event) => event.type === 'terminal.removed'), 'removal event');
    const types = events.map((event) => event.type);
    for (const type of ['workspace.created', 'deck.created', 'terminal.created', 'ui.focus', 'terminal.removed']) {
      assert.ok(types.includes(type), `${type} in ${types}`);
    }
  });
