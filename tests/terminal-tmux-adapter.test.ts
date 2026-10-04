import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { IPty } from 'node-pty';
import { TmuxTerminalAdapter } from '../src/terminal/tmuxAdapter.ts';

const ID = 'b1bd66d5-f62b-479e-a8b0-87da92244ee1';

class FakePty extends EventEmitter {
  pid = 500;
  cols = 120;
  rows = 32;
  writes: Array<string | Uint8Array> = [];
  kills = 0;
  paused = false;
  onData(cb: (data: string | Buffer) => void) { this.on('data', cb); return { dispose: () => this.off('data', cb) }; }
  onExit(cb: (event: {exitCode: number}) => void) { this.on('exit', cb); return { dispose: () => this.off('exit', cb) }; }
  write(data: string | Uint8Array) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  kill() { this.kills++; this.emit('exit', {exitCode: 0}); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
}

function fixture(t: test.TestContext) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'tmux-adapter-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const calls: Array<{args: string[]; env?: Record<string, string>}> = [];
  const displays: Array<{args: string[]; options: any; pty: FakePty}> = [];
  const state = {
    serverPid: 300, panePid: 400, cols: 120, rows: 32, dead: false,
    globalWindowSize: 'latest', localWindowSize: 'latest',
    generation: '', sessionId: '$0', windowId: '@0', paneId: '%0', killed: false,
    failIdentityOnce: false,
  };
  const run = (args: string[], env?: Record<string, string>) => {
    calls.push({args, env});
    const verb = args.find((part) => [
      '-V', 'new-session', 'display-message', 'show-options', 'resize-window', 'kill-session',
      'set-option',
    ].includes(part));
    if (verb === '-V') return 'tmux 3.5a\n';
    if (verb === 'new-session') {
      const conf = args[args.indexOf('-f') + 1];
      state.generation = readFileSync(conf, 'utf8').match(/@deckide_generation ([0-9a-f-]+)/)![1];
      return '';
    }
    if (verb === 'show-options') return `${state.generation}\n`;
    if (verb === 'set-option') {
      if (args.includes('-gw')) state.globalWindowSize = args.at(-1)!;
      if (args.includes('-w')) state.localWindowSize = args.at(-1)!;
      return '';
    }
    if (verb === 'display-message') {
      if (state.failIdentityOnce) { state.failIdentityOnce = false; throw new Error('temporary identity error'); }
      if (state.killed) throw new Error('session missing');
      if (args.at(-1) === '#{pane_dead}\t#{pane_dead_status}') return `${Number(state.dead)}\t7\n`;
      return `${state.serverPid}\t${state.sessionId}\t${state.windowId}\t${state.paneId}\t${state.panePid}\t${state.cols}\t${state.rows}\t${Number(state.dead)}\n`;
    }
    if (verb === 'resize-window') {
      state.cols = Number(args[args.indexOf('-x') + 1]);
      state.rows = Number(args[args.indexOf('-y') + 1]);
      return '';
    }
    if (verb === 'kill-session') { state.killed = true; return ''; }
    throw new Error(`Unexpected tmux command ${args.join(' ')}`);
  };
  const adapter = new TmuxTerminalAdapter({
    runtimeDir,
    dependencies: {
      run,
      assertSocket: () => undefined,
      socketExists: () => state.generation !== '' && !state.killed,
      ptySpawn: (_file, args, options) => {
        const pty = new FakePty();
        displays.push({args, options, pty});
        return pty as unknown as IPty;
      },
    },
  });
  const create = () => adapter.create({
    id: ID, deckId: 'deck-1', title: 'Terminal', command: 'private command',
    createdAt: '2026-10-04T00:00:00Z', shell: '/bin/bash',
    args: ['-c', `printf '%s' 'hello world'`], cwd: '/tmp',
    env: { PATH: '/usr/bin', CODEX_HOME: '/private/codex-home', SECRET: 'sentinel-secret' },
    cols: 120, rows: 32,
  });
  return { adapter, create, runtimeDir, calls, displays, state };
}

test('creation seeds a separate server with environment and fixed manual geometry', (t) => {
  const f = fixture(t);
  const handle = f.create();
  const newSession = f.calls.find((call) => call.args.includes('new-session'))!;
  assert.deepEqual(newSession.env, {
    PATH: '/usr/bin', CODEX_HOME: '/private/codex-home', SECRET: 'sentinel-secret',
  });
  assert.ok(newSession.args.includes('-d'));
  assert.deepEqual(newSession.args.slice(newSession.args.indexOf('-x'), newSession.args.indexOf('-x') + 4),
    ['-x', '120', '-y', '32']);
  assert.equal(newSession.args.at(-1), String.raw`exec '/bin/bash' '-c' 'printf '\''%s'\'' '\''hello world'\'''`);
  assert.ok(f.calls.some((call) => call.args.includes('resize-window')));
  assert.equal(f.state.globalWindowSize, 'manual');
  assert.equal(f.state.localWindowSize, 'manual');
  assert.ok(f.calls.some((call) => call.args.includes('set-option') && call.args.includes('-gw')));
  assert.ok(f.calls.some((call) => call.args.includes('set-option') && call.args.includes('-w')));
  assert.ok(f.displays[0].args.includes('ignore-size'));
  assert.ok(f.displays[0].args.includes('-E'));
  assert.equal(handle.pid, 400);
  const persisted = readFileSync(path.join(f.runtimeDir, `${ID}.json`), 'utf8');
  assert.ok(!persisted.includes('sentinel-secret'));
  assert.ok(!persisted.includes('private command'));
  assert.ok(!persisted.includes('CODEX_HOME'));
  assert.equal(JSON.parse(persisted).command, null);
  assert.ok(f.calls.every((call) => !call.args.join(' ').includes('sentinel-secret')));
  const config = readFileSync(path.join(f.runtimeDir, `${ID}.conf`), 'utf8');
  assert.doesNotMatch(config, /window-size manual/, 'tmux 3.6 rejects manual policy during server startup');
  assert.match(config, /status off/);
  assert.match(config, /destroy-unattached off/);
  assert.match(config, /remain-on-exit on/);
  assert.match(config, /set-option -g @deckide_generation/);
  handle.detach();
});

test('required broker with missing socket refuses creation before tmux or metadata writes', (t) => {
  const previousFlag = process.env.DECKIDE_TMUX_BROKER_REQUIRED;
  const previousSocket = process.env.DECKIDE_TMUX_BROKER_SOCKET;
  t.after(() => {
    if (previousFlag === undefined) delete process.env.DECKIDE_TMUX_BROKER_REQUIRED;
    else process.env.DECKIDE_TMUX_BROKER_REQUIRED = previousFlag;
    if (previousSocket === undefined) delete process.env.DECKIDE_TMUX_BROKER_SOCKET;
    else process.env.DECKIDE_TMUX_BROKER_SOCKET = previousSocket;
  });
  process.env.DECKIDE_TMUX_BROKER_REQUIRED = '1';
  delete process.env.DECKIDE_TMUX_BROKER_SOCKET;
  const f = fixture(t);
  assert.throws(() => f.create(), /broker socket is required/);
  assert.deepEqual(f.calls, [], 'tmux is never invoked');
  assert.deepEqual(f.displays, [], 'no display is spawned');
  assert.deepEqual(readdirSync(f.runtimeDir), [], 'no pending/config/registry metadata is written');
});

test('list and attach verify native identity without creating or replaying input', (t) => {
  const f = fixture(t);
  const first = f.create();
  first.detach();
  const before = f.calls.length;
  const records = f.adapter.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, ID);
  const restored = f.adapter.attach(records[0]);
  assert.equal(restored.pid, 400);
  assert.ok(f.calls.slice(before).every((call) => !call.args.includes('new-session')));
  assert.equal(f.displays.length, 2);
  assert.equal(f.displays[0].pty.writes.length, 0);
  assert.equal(f.displays[1].pty.writes.length, 0);
  assert.equal(f.displays[1].args.at(-1), `=deckide-${ID}`);
  restored.detach();
});

test('zero-argument shell is execed without a login or interactive flag', (t) => {
  const f = fixture(t);
  const handle = f.adapter.create({
    id: ID, deckId: 'deck-1', title: 'Terminal', createdAt: '2026-10-04T00:00:00Z',
    shell: '/bin/bash', args: [], cwd: '/tmp', env: { PATH: '/usr/bin' }, cols: 120, rows: 32,
  });
  const newSession = f.calls.find((call) => call.args.includes('new-session'))!;
  assert.equal(newSession.args.at(-1), "exec '/bin/bash'");
  handle.detach();
});

test('resize is explicit, persists only after tmux accepts, and display detach preserves shell', (t) => {
  const f = fixture(t);
  const handle = f.create();
  handle.resize(150, 41);
  assert.equal(f.state.cols, 150);
  assert.equal(f.state.rows, 41);
  assert.equal(f.displays[0].pty.cols, 150);
  assert.equal(JSON.parse(readFileSync(path.join(f.runtimeDir, `${ID}.json`), 'utf8')).cols, 150);
  const callsBeforeDetach = f.calls.length;
  handle.detach();
  assert.equal(f.displays[0].pty.kills, 1);
  assert.ok(f.calls.slice(callsBeforeDetach).every((call) => !call.args.includes('kill-session')));
  assert.equal(f.state.killed, false);
  assert.throws(() => handle.write('uncertain input'), /disconnected/);
});

test('identity mismatch fails closed before a new display client or destructive command', (t) => {
  const f = fixture(t);
  f.create().detach();
  f.state.serverPid++;
  const beforeDisplays = f.displays.length;
  assert.throws(() => f.adapter.attach(ID), /identity changed/);
  assert.equal(f.displays.length, beforeDisplays);
  assert.throws(() => f.adapter.list(), /identity changed/);
  assert.ok(f.calls.every((call) => !call.args.includes('kill-session')));
});

test('discovery isolates an unavailable registry entry without mutating it or blocking a healthy one', (t) => {
  const f = fixture(t);
  f.create().detach();
  const staleId = 'a455393a-7bc2-4717-8e51-8ce4e0205e37';
  const source = JSON.parse(readFileSync(path.join(f.runtimeDir, `${ID}.json`), 'utf8'));
  const stale = {
    ...source, id: staleId, sessionName: `deckide-${staleId}`,
    socketPath: path.join(f.runtimeDir, `s-${staleId.replace(/-/g, '').slice(0, 16)}.sock`),
    serverPid: source.serverPid + 1,
  };
  writeFileSync(path.join(f.runtimeDir, `${staleId}.json`), JSON.stringify(stale), { mode: 0o600 });
  const unavailable: string[] = [];
  const exited: string[] = [];
  const records = f.adapter.list((id) => unavailable.push(id), (id) => exited.push(id));
  assert.deepEqual(records.map((item) => item.id), [ID]);
  assert.deepEqual(unavailable, [staleId]);
  assert.deepEqual(exited, [], 'an identity mismatch never proves shell exit');
  assert.ok(readdirSync(f.runtimeDir).includes(`${staleId}.json`));
  assert.equal(f.state.killed, false);
  assert.ok(f.calls.every((call) => !call.args.includes('kill-session')));
  assert.throws(() => f.adapter.list(), /identity changed/);
});

test('registry metadata with private extra fields or an array never reaches attach or API discovery', (t) => {
  const f = fixture(t);
  f.create().detach();
  const file = path.join(f.runtimeDir, `${ID}.json`);
  const original = JSON.parse(readFileSync(file, 'utf8'));
  const polluted = { ...original, env: { SECRET: 'fixture-private-value' } };
  writeFileSync(file, JSON.stringify(polluted), { mode: 0o600 });
  const beforeCalls = f.calls.length;
  const beforeDisplays = f.displays.length;
  const unavailable: string[] = [];
  assert.deepEqual(f.adapter.list((id, error) => {
    unavailable.push(id);
    assert.match(String(error), /Unexpected terminal registry entry fields/);
    assert.doesNotMatch(String(error), /fixture-private-value/);
  }), []);
  assert.deepEqual(unavailable, [ID]);
  assert.throws(() => f.adapter.attach(ID), /Unexpected terminal registry entry fields/);
  assert.throws(() => f.adapter.list(), /Unexpected terminal registry entry fields/);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(polluted), 'unknown registry is preserved for review');
  assert.equal(f.calls.length, beforeCalls, 'no tmux query, shell launch, or kill follows validation failure');
  assert.equal(f.displays.length, beforeDisplays);
  assert.equal(f.state.killed, false);

  writeFileSync(file, '[]', { mode: 0o600 });
  assert.deepEqual(f.adapter.list((id) => unavailable.push(id)), []);
  assert.deepEqual(unavailable, [ID, ID]);
  assert.equal(readFileSync(file, 'utf8'), '[]');
  assert.equal(f.calls.length, beforeCalls);
});

test('direct metadata verification rejects persisted command text before querying tmux', (t) => {
  const f = fixture(t);
  f.create().detach();
  const meta = JSON.parse(readFileSync(path.join(f.runtimeDir, `${ID}.json`), 'utf8'));
  const beforeCalls = f.calls.length;
  assert.throws(() => f.adapter.verify({ ...meta, command: 'fixture-private-command' }),
    /Invalid terminal registry identity/);
  assert.equal(f.calls.length, beforeCalls);
  assert.equal(f.state.killed, false);
});

test('display loss reports disconnect, while only confirmed pane death reports exit and removes registry', (t) => {
  const f = fixture(t);
  const display = f.create();
  let disconnects = 0;
  let exits = 0;
  display.on('disconnect', () => disconnects++);
  display.onExit(() => exits++);
  f.displays[0].pty.emit('exit', {exitCode: 1});
  assert.equal(disconnects, 1);
  assert.equal(exits, 0);
  assert.ok(readdirSync(f.runtimeDir).includes(`${ID}.json`));
  const restored = f.adapter.attach(ID);
  restored.onExit((event) => { exits++; assert.equal(event.exitCode, 7); });
  f.state.dead = true;
  (restored as any).checkPane(false);
  assert.equal(exits, 1);
  assert.equal(f.state.killed, true);
  assert.ok(!readdirSync(f.runtimeDir).includes(`${ID}.json`));
});

test('identity polling failure disposes only the display and detach remains idempotent', (t) => {
  const f = fixture(t);
  const handle = f.create();
  let disconnects = 0;
  let exits = 0;
  handle.on('disconnect', () => disconnects++);
  handle.onExit(() => exits++);
  f.state.failIdentityOnce = true;
  (handle as any).checkPane(false);
  assert.equal(disconnects, 1);
  assert.equal(exits, 0);
  assert.equal(f.displays[0].pty.kills, 1);
  handle.detach();
  assert.equal(f.displays[0].pty.kills, 1);
  assert.equal(f.state.killed, false);
  assert.ok(readdirSync(f.runtimeDir).includes(`${ID}.json`));
});

test('list reaps a verified dead pane but never a changed identity', (t) => {
  const f = fixture(t);
  f.create().detach();
  f.state.dead = true;
  const exited: string[] = [];
  assert.deepEqual(f.adapter.list(undefined, (id) => exited.push(id)), []);
  assert.deepEqual(exited, [ID]);
  assert.equal(f.state.killed, true);
  assert.ok(!readdirSync(f.runtimeDir).includes(`${ID}.json`));
});

test('pending nonsecret record adopts a known tmux session after interrupted creation', (t) => {
  const f = fixture(t);
  f.state.failIdentityOnce = true;
  assert.throws(() => f.create(), /temporary identity error/);
  const pending = readFileSync(path.join(f.runtimeDir, `${ID}.pending.json`), 'utf8');
  assert.ok(!pending.includes('sentinel-secret'));
  assert.ok(!pending.includes('private command'));
  const before = f.calls.length;
  const records = f.adapter.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].pid, 400);
  assert.equal(f.state.globalWindowSize, 'manual');
  assert.equal(f.state.localWindowSize, 'manual');
  assert.ok(f.calls.slice(before).every((call) => !call.args.includes('new-session')));
  assert.ok(!readdirSync(f.runtimeDir).includes(`${ID}.pending.json`));
  const restored = f.adapter.attach(records[0]);
  assert.equal(restored.pid, 400);
  restored.detach();
});

test('pending record remains untouched while its tmux socket is unavailable', (t) => {
  const f = fixture(t);
  f.state.failIdentityOnce = true;
  assert.throws(() => f.create(), /temporary identity error/);
  f.state.killed = true; // Simulate a missing socket; its cause is unknown.
  const before = f.calls.length;
  assert.deepEqual(f.adapter.list(), []);
  assert.ok(readdirSync(f.runtimeDir).includes(`${ID}.pending.json`));
  assert.ok(f.calls.slice(before).every((call) => !call.args.includes('kill-session')));
});

test('unavailable pending creation is reported without blocking healthy registry discovery', (t) => {
  const f = fixture(t);
  f.create().detach();
  const pendingId = 'a455393a-7bc2-4717-8e51-8ce4e0205e37';
  const pending = {
    id: pendingId, deckId: 'deck-1', title: 'Pending', createdAt: '2026-10-04T00:00:00Z',
    cols: 120, rows: 32, generation: pendingId, sessionName: `deckide-${pendingId}`,
    socketPath: path.join(f.runtimeDir, `s-${pendingId.replace(/-/g, '').slice(0, 16)}.sock`),
  };
  writeFileSync(path.join(f.runtimeDir, `${pendingId}.pending.json`), JSON.stringify(pending), { mode: 0o600 });
  const unavailable: string[] = [];
  const records = f.adapter.list((id) => unavailable.push(id));
  assert.deepEqual(records.map((item) => item.id), [ID]);
  assert.deepEqual(unavailable, [pendingId]);
  assert.ok(readdirSync(f.runtimeDir).includes(`${pendingId}.pending.json`));
  assert.ok(f.calls.every((call) => !call.args.includes('kill-session')));
});

test('pending metadata with private extra fields or an array is retained without adoption or mutation', (t) => {
  const f = fixture(t);
  f.state.failIdentityOnce = true;
  assert.throws(() => f.create(), /temporary identity error/);
  const file = path.join(f.runtimeDir, `${ID}.pending.json`);
  const pending = JSON.parse(readFileSync(file, 'utf8'));
  const polluted = { ...pending, launchEnv: { SECRET: 'fixture-private-value' } };
  writeFileSync(file, JSON.stringify(polluted), { mode: 0o600 });
  const beforeCalls = f.calls.length;
  const unavailable: string[] = [];
  assert.deepEqual(f.adapter.list((id, error) => {
    unavailable.push(id);
    assert.match(String(error), /Unexpected pending terminal record fields/);
    assert.doesNotMatch(String(error), /fixture-private-value/);
  }), []);
  assert.deepEqual(unavailable, [ID]);
  assert.throws(() => f.adapter.list(), /Unexpected pending terminal record fields/);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(polluted));
  assert.ok(!readdirSync(f.runtimeDir).includes(`${ID}.json`), 'no registry adoption is written');
  assert.equal(f.calls.length, beforeCalls, 'no tmux query, launch, resize, or kill follows validation failure');
  assert.equal(f.displays.length, 0);
  assert.equal(f.state.killed, false);

  writeFileSync(file, '[]', { mode: 0o600 });
  assert.deepEqual(f.adapter.list((id) => unavailable.push(id)), []);
  assert.deepEqual(unavailable, [ID, ID]);
  assert.equal(readFileSync(file, 'utf8'), '[]');
  assert.equal(f.calls.length, beforeCalls);
});

test('explicit close kills only the exact owned session', async (t) => {
  const f = fixture(t);
  const handle = f.create();
  await handle.close();
  const kills = f.calls.filter((call) => call.args.includes('kill-session'));
  assert.equal(kills.length, 1);
  assert.equal(kills[0].args.at(-1), `=deckide-${ID}`);
  assert.ok(f.calls.every((call) => !call.args.includes('kill-server')));
  assert.ok(!readdirSync(f.runtimeDir).includes(`${ID}.json`));
});
