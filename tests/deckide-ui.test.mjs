import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { fit, readKey, renderTerminalRow, textWidth } from '../bin/deckide-ui.js';

const { Terminal } = headless;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'deckide.js');
const haveTmux = spawnSync('sh', ['-c', 'command -v tmux']).status === 0;

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ['DECKIDE_TMUX_BROKER_REQUIRED', 'DECKIDE_TMUX_BROKER_SOCKET', 'DECKIDE_ALLOWED_HOSTS',
    'DECKIDE_SESSION_SOCKET', 'DECKIDE_TERMINAL_ID', 'DECKIDE_DECK_ID']) delete env[key];
  return env;
}

test('chrome text fits cells, counting CJK and emoji as two', () => {
  assert.equal(textWidth('abc'), 3);
  assert.equal(textWidth('日本語'), 6);
  assert.equal(textWidth('✅'), 1);
  assert.equal(textWidth('😀'), 2);
  assert.equal(fit('abc', 5), 'abc  ');
  assert.equal(textWidth(fit('日本語のデッキ名', 7)), 7);
  assert.equal(fit('a\x1b[31mb', 4), 'a [3');
});

test('keys are decoded from raw input', () => {
  assert.deepEqual(readKey('\x1b[A'), { name: 'up', length: 3 });
  assert.deepEqual(readKey('\x1bOD'), { name: 'left', length: 3 });
  assert.equal(readKey('\x1d').name, 'ctrl-]');
  assert.equal(readKey('\r').name, 'enter');
  assert.equal(readKey('\x1b').name, 'escape');
  const japanese = Buffer.from('あ', 'utf8').toString('latin1');
  assert.deepEqual(readKey(japanese + 'x'), { name: 'text', text: japanese, length: 3 });
});

test('a headless terminal row renders with its colours and exact width', async () => {
  const term = new Terminal({ cols: 12, rows: 2, allowProposedApi: true });
  await new Promise((resolve) => term.write('\x1b[31mred\x1b[0m 日本\x1b[1;38;5;208mX', resolve));
  const row = renderTerminalRow(term, 0, 10);
  assert.match(row, /\x1b\[0;31mred/);
  assert.match(row, /\x1b\[0;1;38;5;208mX/);
  const visible = row.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(textWidth(visible), 10);
  term.dispose();
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('deckide ui shows the decks and terminals, drives them, and leaves them running', { skip: !haveTmux }, async (t) => {
  const dataDir = mkdtempSync('/tmp/dku-');
  const runtimeDir = mkdtempSync('/tmp/dkv-');
  const work = mkdtempSync(path.join(os.tmpdir(), 'deckide-ui-work-'));
  const port = await freePort();
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port }));
  const env = cleanEnv({ DECKIDE_DATA_DIR: dataDir, DECKIDE_TMUX_RUNTIME_DIR: runtimeDir, PORT: String(port),
    HOST: '127.0.0.1', AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false', SHELL: '/bin/sh' });
  const server = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}`;
  const session = (...args) => spawnSync(process.execPath, [cli, 'session', ...args], { cwd: work, env, encoding: 'utf8' });
  const list = () => JSON.parse(session('list').stdout);
  t.after(async () => {
    for (const terminal of (() => { try { return list(); } catch { return []; } })()) {
      await fetch(`${origin}/api/terminals/${terminal.id}`, { method: 'DELETE' }).catch(() => undefined);
    }
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    for (const dir of [dataDir, runtimeDir, work]) rmSync(dir, { recursive: true, force: true });
  });
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(origin + '/health')).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(session('new', '--cwd', work, '--title', 'alpha', '--json').status, 0);
  assert.equal(session('new', '--cwd', work, '--title', 'beta', '--json').status, 0);

  const cols = 100;
  const rows = 24;
  const outer = new Terminal({ cols, rows, allowProposedApi: true });
  const ui = pty.spawn(process.execPath, [cli, 'ui'], { name: 'xterm-256color', cols, rows, cwd: work, env });
  ui.onData((data) => outer.write(data));
  const exited = new Promise((resolve) => ui.onExit(resolve));
  const screen = () => new Promise((resolve) => outer.write('', () => {
    const buffer = outer.buffer.active;
    resolve(Array.from({ length: rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '').join('\n'));
  }));
  const until = async (predicate, label) => {
    for (let n = 0; n < 120; n++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timeout: ${label}\n${await screen()}`);
  };

  const deckName = path.basename(work);
  await until(async () => (await screen()).includes('1:alpha') && (await screen()).includes('2:beta'), 'both panes');
  assert.ok((await screen()).split('\n')[0].includes(deckName), 'deck tab');
  // Opening the grid fits every shown terminal to its pane.
  await until(() => list().every((terminal) => terminal.cols < 60), 'panes take their sizes');

  ui.write('echo ui-$((6*7))\r');
  await until(async () => (await screen()).includes('ui-42'), 'typing reaches the focused terminal');

  ui.write('\x1dn');
  await until(() => list().length === 3, 'Ctrl+] n creates a terminal');
  await until(async () => (await screen()).includes('3:'), 'third pane shown');

  ui.write('\x1dq');
  const { exitCode } = await exited;
  assert.equal(exitCode, 0);
  assert.equal(list().length, 3, 'leaving the UI leaves every terminal running');
});
