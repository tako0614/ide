import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { TmuxTerminalAdapter } from '../src/terminal/tmuxAdapter.ts';

const ID = 'b1bd66d5-f62b-479e-a8b0-87da92244ee1';
const OTHER = 'a455393a-7bc2-4717-8e51-8ce4e0205e37';

function fixture(t: test.TestContext, hasUnixListener?: (socketPath: string) => boolean) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-stale-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const calls: string[][] = [];
  const state = { probe: 'absent', alive: false, generation: ID, identity: ID,
    changeOnProbe: null as (() => void) | null, processChecks: 0, flipAliveAt: 0 };
  const adapter = new TmuxTerminalAdapter({ runtimeDir, dependencies: {
    run: (args) => {
      calls.push(args);
      if (args.includes('has-session')) {
        state.changeOnProbe?.();
        if (state.probe === 'timeout') throw Object.assign(new Error('tmux probe timed out'), { code: 'ETIMEDOUT' });
        if (state.probe !== 'live') throw new Error('no server');
        return '';
      }
      if (args.includes('display-message')) return `123456789\t$0\t@0\t%0\t123456790\t80\t24\t0\n`;
      if (args.includes('show-options')) return `${state.generation}\n`;
      throw new Error('unexpected tmux command');
    },
    isProcessAlive: () => {
      state.processChecks++;
      if (state.flipAliveAt && state.processChecks >= state.flipAliveAt) state.alive = true;
      return state.alive;
    },
    ...(hasUnixListener ? { hasUnixListener } : {}),
  } });
  function socket(id = ID) { return path.join(runtimeDir, `s-${id.replace(/-/g, '').slice(0, 16)}.sock`); }
  function registry(id = ID, deckId = 'deck-1') {
    const meta = {
      id, deckId, title: 'shell', command: null, createdAt: '2026-10-13T00:00:00Z',
      cols: 80, rows: 24, pid: 123456790, socketPath: socket(id),
      sessionName: `deckide-${id}`, serverPid: 123456789,
      sessionId: '$0', windowId: '@0', paneId: '%0', generation: ID,
    };
    fs.writeFileSync(path.join(runtimeDir, `${id}.json`), JSON.stringify(meta) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(runtimeDir, `${id}.conf`), 'set-option -g status off\n', { mode: 0o600 });
    return meta;
  }
  function staleSocket(id = ID) {
    // Python leaves a genuine, owner-only Unix socket pathname after exiting.
    execFileSync('python3', ['-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])', socket(id)]);
    fs.chmodSync(socket(id), 0o600);
  }
  return { adapter, calls, runtimeDir, registry, socket, staleSocket, state };
}

test('prunes only a dead registry, config and stale Unix socket; repeated prune is empty', (t) => {
  const f = fixture(t);
  f.registry();
  f.staleSocket();
  const statuses = f.adapter.inspectDeckRecords('deck-1');
  assert.deepEqual(statuses.map((s) => [s.source, s.state, s.reason]),
    [['registry', 'dead', 'recorded-processes-gone']]);
  assert.deepEqual(f.adapter.pruneDeadRecords('deck-1', statuses), { terminalIds: [ID] });
  assert.deepEqual(fs.readdirSync(f.runtimeDir), []);
  assert.deepEqual(f.adapter.pruneDeadRecords('deck-1'), { terminalIds: [] });
  assert.ok(f.calls.every((args) => !['kill-session', 'new-session', 'attach-session', 'send-keys'].some((verb) => args.includes(verb))));
});

test('a verified live native session blocks pruning', (t) => {
  const f = fixture(t);
  f.registry(); f.staleSocket(); f.state.probe = 'live';
  assert.equal(f.adapter.inspectDeckRecords('deck-1')[0].state, 'live');
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1'), /live or unavailable/);
  assert.ok(fs.existsSync(path.join(f.runtimeDir, `${ID}.json`)));
  assert.ok(fs.existsSync(f.socket()));
});

test('a listening Unix socket blocks pruning even when tmux reports no target session', async (t) => {
  const f = fixture(t);
  f.registry();
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(f.socket(), resolve);
  });
  t.after(() => server.close());
  fs.chmodSync(f.socket(), 0o600);
  assert.equal(f.adapter.inspectDeckRecords('deck-1')[0].reason, 'unix-socket-has-listener');
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1'), /live or unavailable/);
  assert.ok(fs.existsSync(path.join(f.runtimeDir, `${ID}.json`)));
});

test('an unlinked but listening Unix socket blocks registry and DB-only classification', async (t) => {
  const f = fixture(t);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(f.socket(), resolve);
  });
  t.after(() => server.close());
  fs.unlinkSync(f.socket());
  assert.equal(fs.existsSync(f.socket()), false);
  assert.equal(f.adapter.inspectTerminalRecord(ID).reason, 'unix-socket-has-listener');
  f.registry();
  assert.equal(f.adapter.inspectDeckRecords('deck-1')[0].reason, 'unix-socket-has-listener');
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1'), /live or unavailable/);
});

test('canonical orphan files remain untouched and do not acquire another deck owner', (t) => {
  const f = fixture(t);
  f.registry();
  fs.writeFileSync(path.join(f.runtimeDir, `${OTHER}.conf`), 'orphan', { mode: 0o600 });
  f.staleSocket(OTHER);
  assert.deepEqual(f.adapter.inspectDeckRecords('deck-1').map((s) => s.state), ['dead']);
  assert.deepEqual(f.adapter.pruneDeadRecords('deck-1'), { terminalIds: [ID] });
  assert.deepEqual(fs.readdirSync(f.runtimeDir).sort(),
    [`${OTHER}.conf`, path.basename(f.socket(OTHER))].sort());
});

test('a timeout, live recorded PID, or changed native identity is unavailable', (t) => {
  const f = fixture(t);
  f.registry(); f.staleSocket();
  f.state.probe = 'timeout';
  assert.equal(f.adapter.inspectDeckRecords('deck-1')[0].reason, 'native-probe-timeout');
  f.state.probe = 'absent'; f.state.alive = true;
  assert.equal(f.adapter.inspectDeckRecords('deck-1')[0].reason, 'recorded-process-may-be-live');
  fs.unlinkSync(f.socket());
  assert.equal(f.adapter.inspectDeckRecords('deck-1')[0].reason, 'recorded-process-may-be-live');
  f.staleSocket(); f.state.alive = false; f.state.probe = 'live'; f.state.generation = OTHER;
  assert.equal(f.adapter.inspectDeckRecords('deck-1')[0].reason, 'native-identity-changed');
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1'), /live or unavailable/);
  assert.ok(fs.existsSync(path.join(f.runtimeDir, `${ID}.json`)));
});

test('pending, malformed, unowned and unclassified entries block every deck', (t) => {
  const f = fixture(t);
  const pending = {
    id: ID, deckId: 'deck-1', title: 'shell', createdAt: '2026-10-13T00:00:00Z',
    cols: 80, rows: 24, socketPath: f.socket(), sessionName: `deckide-${ID}`, generation: ID,
  };
  const pendingPath = path.join(f.runtimeDir, `${ID}.pending.json`);
  fs.writeFileSync(pendingPath, JSON.stringify(pending), { mode: 0o600 });
  assert.equal(f.adapter.inspectDeckRecords('deck-1')[0].reason, 'pending-creation');
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1'), /live or unavailable/);
  fs.unlinkSync(pendingPath);
  const registryPath = path.join(f.runtimeDir, `${ID}.json`);
  fs.writeFileSync(registryPath, '{broken', { mode: 0o600 });
  assert.equal(f.adapter.inspectDeckRecords('other-deck')[0].reason, 'unclassifiable-runtime-entry');
  fs.unlinkSync(registryPath);
  f.registry(ID, 'unrelated-deck');
  fs.chmodSync(registryPath, 0o644);
  assert.equal(f.adapter.inspectDeckRecords('other-deck')[0].reason, 'unclassifiable-runtime-entry');
  fs.chmodSync(registryPath, 0o600);
  fs.writeFileSync(path.join(f.runtimeDir, 'stray'), 'x', { mode: 0o600 });
  assert.ok(f.adapter.inspectDeckRecords('other-deck').some((s) => s.reason === 'unclassified-runtime-resource'));
  fs.writeFileSync(path.join(f.runtimeDir, 'private=secret.json'), '{}', { mode: 0o600 });
  const diagnostics = JSON.stringify(f.adapter.inspectDeckRecords('other-deck'));
  assert.doesNotMatch(diagnostics, /private=secret/);
  assert.ok(f.adapter.inspectDeckRecords('other-deck').some((s) =>
    s.reason === 'unrecognized-runtime-entry' && s.terminalId === 'unknown' && s.entry === '<unknown>'));
});

test('DB-only terminal requires canonical socket absence, and remembered foreign socket blocks', (t) => {
  const f = fixture(t);
  assert.equal(f.adapter.inspectTerminalRecord(ID).reason, 'no-managed-native-session');
  assert.equal(f.adapter.inspectTerminalRecord(ID, path.join(f.runtimeDir, 'foreign.sock')).reason,
    'noncanonical-remembered-socket');
  f.staleSocket();
  assert.equal(f.adapter.inspectTerminalRecord(ID).reason, 'orphan-native-socket');
});

test('PID becoming live before config unlink leaves config and registry untouched', (t) => {
  const f = fixture(t);
  f.registry();
  // Scan and initial plan each perform two PID checks; flip on the config gate.
  f.state.flipAliveAt = 5;
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1'), /native state changed/);
  assert.ok(fs.existsSync(path.join(f.runtimeDir, `${ID}.conf`)));
  assert.ok(fs.existsSync(path.join(f.runtimeDir, `${ID}.json`)));
});

test('registry rewrite during config gate leaves config and replacement untouched', (t) => {
  const f = fixture(t);
  f.registry(); f.staleSocket();
  const file = path.join(f.runtimeDir, `${ID}.json`);
  const replacement = JSON.parse(fs.readFileSync(file, 'utf8'));
  replacement.title = 'replacement';
  let probes = 0;
  f.state.changeOnProbe = () => {
    if (++probes === 3) fs.writeFileSync(file, JSON.stringify(replacement) + '\n', { mode: 0o600 });
  };
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1'), /registry changed/);
  assert.ok(fs.existsSync(path.join(f.runtimeDir, `${ID}.conf`)));
  assert.ok(fs.existsSync(f.socket()));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).title, 'replacement');
});

test('listener appearing before socket unlink leaves socket and registry untouched', (t) => {
  let checks = 0;
  const f = fixture(t, () => ++checks >= 4);
  f.registry(); f.staleSocket();
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1'), /native state changed/);
  assert.ok(fs.existsSync(f.socket()));
  assert.ok(fs.existsSync(path.join(f.runtimeDir, `${ID}.json`)));
});

test('DB-only record cannot claim a canonical socket shared with another UUID', (t) => {
  const f = fixture(t);
  const colliding = 'b1bd66d5-f62b-479e-9999-87da92244ee1';
  assert.equal(f.socket(colliding), f.socket(ID));
  f.registry(colliding, 'other-deck');
  assert.equal(f.adapter.inspectTerminalRecord(ID).reason, 'canonical-socket-shared');
});

test('changed registry bytes or native state during prune preserves replacement', (t) => {
  const f = fixture(t);
  f.registry();
  const expected = f.adapter.inspectDeckRecords('deck-1');
  const file = path.join(f.runtimeDir, `${ID}.json`);
  const replacement = JSON.parse(fs.readFileSync(file, 'utf8'));
  replacement.title = 'replacement';
  let changed = false;
  f.state.changeOnProbe = () => {
    if (changed) return;
    changed = true;
    fs.writeFileSync(file, JSON.stringify(replacement) + '\n', { mode: 0o600 });
  };
  // Missing socket has no tmux probe, so a pre-unlink read is the injection point.
  f.staleSocket();
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1', expected), /registry changed/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).title, 'replacement');
  assert.ok(fs.existsSync(f.socket()));
});

test('expected inspection rejects a dead registry replaced before pruning starts', (t) => {
  const f = fixture(t);
  f.registry();
  const expected = f.adapter.inspectDeckRecords('deck-1');
  const file = path.join(f.runtimeDir, `${ID}.json`);
  const replacement = JSON.parse(fs.readFileSync(file, 'utf8'));
  replacement.title = 'new record';
  fs.writeFileSync(file, JSON.stringify(replacement) + '\n', { mode: 0o600 });
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1', expected), /registry changed/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).title, 'new record');
});

test('runtime directory replacement fails closed', (t) => {
  const f = fixture(t);
  f.registry();
  const moved = `${f.runtimeDir}-old`;
  fs.renameSync(f.runtimeDir, moved);
  fs.mkdirSync(f.runtimeDir, { mode: 0o700 });
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  assert.throws(() => f.adapter.inspectDeckRecords('deck-1'), /runtime directory changed/);
  assert.throws(() => f.adapter.pruneDeadRecords('deck-1'), /runtime directory changed/);
});
