import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pty from 'node-pty';
import { findDetachKey, isTerminalReport, matchTerminal } from '../bin/cli-client.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(root, 'bin', 'deckide.js');

test('terminal selectors resolve by number, id prefix and title', () => {
  const terminals = [
    { index: 1, id: 'aaaa1111-0000', title: 'shell', liveTitle: null },
    { index: 2, id: 'aaaa2222-0000', title: 'claude', liveTitle: 'Claude Code' },
  ];
  assert.equal(matchTerminal(terminals, '2').id, 'aaaa2222-0000');
  assert.equal(matchTerminal(terminals, 'aaaa1').id, 'aaaa1111-0000');
  assert.equal(matchTerminal(terminals, 'CLAUDE').id, 'aaaa2222-0000');
  assert.equal(matchTerminal(terminals, 'claude code').id, 'aaaa2222-0000');
  assert.equal(matchTerminal(terminals, 'nothing'), null);
  assert.throws(() => matchTerminal(terminals, 'aaaa'), /several/);
});

test('terminal emulator replies are told apart from typing', () => {
  for (const reply of ['\x1b[12;40R', '\x1b[?62;22c', '\x1b[>1;10;0c', '\x1b]11;rgb:1818/1818/1818\x07',
    '\x1b[I', '\x1b[O', '\x1bP>|xterm(1)\x1b\\', '\x1b[?2004;1$y', '\x1b[12;40R\x1b[?62c']) {
    assert.ok(isTerminalReport(reply), JSON.stringify(reply));
  }
  for (const typed of ['a', 'ls\r', '\x1b[A', '\x03', '\x1b', 'x\x1b[12;40R']) {
    assert.ok(!isTerminalReport(typed), JSON.stringify(typed));
  }
});

test('Ctrl+] detaches however the local terminal encodes it', () => {
  assert.equal(findDetachKey('ab\x1d'), 2);
  assert.equal(findDetachKey('x\x1b[93;5u'), 1);   // kitty keyboard protocol
  assert.equal(findDetachKey('\x1b[93;5:1u'), 0);   // kitty with event type
  assert.equal(findDetachKey('\x1b[27;5;93~'), 0);  // xterm modifyOtherKeys
  assert.equal(findDetachKey('\x1b[93;3u'), -1);    // Alt+], not a detach
  assert.equal(findDetachKey('plain'), -1);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'deckide-cli-client-'));
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'deckide-cli-work-'));
  const port = await freePort();
  await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ port }));
  const env = { ...process.env, DECKIDE_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
    AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false', SHELL: '/bin/sh' };
  const child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  });
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The CLI must not pick up the deck/terminal of whatever runs this test.
  const cliEnv = { ...process.env, DECKIDE_DATA_DIR: dataDir };
  for (const key of ['DECKIDE_TERMINAL_ID', 'DECKIDE_DECK_ID', 'DECKIDE_PORT', 'DECKIDE_URL', 'DECKIDE_TOKEN']) delete cliEnv[key];
  const run = (...args) => spawnSync(process.execPath, [cliPath, ...args], { cwd: workdir, env: cliEnv, encoding: 'utf8' });
  return { run, cliEnv, workdir };
}

test('open, ls, send, attach (with resize and detach) and kill from the CLI', async (t) => {
  const { run, cliEnv, workdir } = await startServer(t);

  const opened = run('open', '-t', 'work');
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, /Registered workspace/);
  const listed = JSON.parse(run('ls', '--json').stdout);
  assert.equal(listed.decks.length, 1);
  assert.equal(listed.terminals[0].title, 'work');

  // Reopening the same directory reuses its deck.
  assert.equal(run('open', '-t', 'second').status, 0);
  assert.equal(JSON.parse(run('ls', '--json').stdout).decks.length, 1);

  assert.equal(run('send', 'work', 'echo sent-$((20+3))').status, 0);

  const attached = pty.spawn(process.execPath, [cliPath, 'attach', 'work'], {
    cols: 90, rows: 20, cwd: workdir, env: cliEnv,
  });
  let screen = '';
  attached.onData((data) => { screen += data; });
  const exited = new Promise((resolve) => attached.onExit(resolve));
  const waitFor = async (predicate, label) => {
    for (let n = 0; n < 80; n++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timeout: ${label}\n${screen.slice(-400)}`);
  };
  const work = () => JSON.parse(run('ls', '--json').stdout).terminals.find((term) => term.title === 'work');

  await waitFor(() => screen.includes('sent-23'), 'snapshot shows earlier output');
  await waitFor(() => work().cols === 90, 'PTY follows the attached tty');
  assert.equal(work().clients.primary, 'cli');

  attached.resize(70, 22);
  await waitFor(() => work().cols === 70 && work().rows === 22, 'PTY follows a local resize');

  attached.write('echo typed-$((1+1))\r');
  await waitFor(() => screen.includes('typed-2'), 'typed input reaches the PTY');

  attached.write('\x1d');
  const { exitCode } = await exited;
  assert.equal(exitCode, 0);
  assert.match(screen, /detached from work/);
  assert.equal(work().clients.cli, 0);

  const killed = run('kill', 'work');
  assert.equal(killed.status, 0, killed.stderr);
  assert.deepEqual(JSON.parse(run('ls', '--json').stdout).terminals.map((term) => term.title), ['second']);

  const missing = run('send', 'nope', 'x');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No terminal matches/);
});
