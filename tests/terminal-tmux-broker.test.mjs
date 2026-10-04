import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { runTmuxCreationInBroker } from '../dist/terminal/tmuxBrokerClient.js';

const brokerFile = path.resolve('dist/terminal/tmuxBroker.js');
const clientFile = path.resolve('dist/terminal/tmuxBrokerClient.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-broker-'));
  const runtimeDir = path.join(root, 'terminal');
  const brokerDir = path.join(root, 'broker');
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.mkdirSync(brokerDir, { mode: 0o700 });
  const brokerSocket = path.join(brokerDir, 'broker.sock');
  const sessions = [];
  const fixtureState = { brokerChild: null, brokerOutput: [], brokerErrors: [] };
  t.after(async () => {
    const child = fixtureState.brokerChild;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    for (const session of sessions) {
      try { execFileSync('/usr/bin/tmux', ['-S', session.socketPath, '-N', 'kill-session', '-t', `=${session.sessionName}`],
        { stdio: 'ignore', timeout: 2000 }); } catch { /* Session may already be gone. */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    DECKIDE_TMUX_BROKER_SOCKET: brokerSocket,
    DECKIDE_TMUX_RUNTIME_DIR: runtimeDir,
  };
  return { root, runtimeDir, brokerDir, brokerSocket, env, sessions, fixtureState };
}

async function startBroker(t, f) {
  const child = spawn(process.execPath, [brokerFile, '--serve'], {
    env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  f.fixtureState.brokerChild = child;
  child.stdout.on('data', (chunk) => f.fixtureState.brokerOutput.push(chunk));
  child.stderr.on('data', (chunk) => f.fixtureState.brokerErrors.push(chunk));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const stat = fs.lstatSync(f.brokerSocket);
      assert.ok(stat.isSocket());
      assert.equal(stat.mode & 0o777, 0o600);
      return child;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null) throw new Error('Broker exited before bind');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Broker did not bind its private socket');
}

function createRequest(f, id, overrides = {}) {
  const generation = crypto.randomUUID();
  const sessionName = `deckide-${id}`;
  const socketPath = path.join(f.runtimeDir, `s-${id.replace(/-/g, '').slice(0, 16)}.sock`);
  const configPath = path.join(f.runtimeDir, `${id}.conf`);
  const pendingPath = path.join(f.runtimeDir, `${id}.pending.json`);
  const pending = {
    id, deckId: 'deck-test', title: 'Test', createdAt: '2026-10-04T00:00:00Z',
    cols: 80, rows: 24, generation, sessionName, socketPath,
  };
  const config = [
    'set-option -g default-shell /bin/sh',
    'set-option -g status off',
    'set-option -g aggressive-resize off',
    'set-option -g destroy-unattached off',
    'set-option -g update-environment ""',
    'set-option -g remain-on-exit on',
    `set-option -g @deckide_generation ${generation}`,
    '',
  ].join('\n');
  fs.writeFileSync(pendingPath, JSON.stringify(pending) + '\n', { mode: 0o600 });
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  const args = [
    '-S', socketPath, '-f', configPath,
    'new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24',
    '-c', f.root, "exec '/bin/sleep' '60'",
  ];
  f.sessions.push({ socketPath, sessionName });
  return { args, env: {
    PATH: '/usr/bin:/bin', CODEX_HOME: '/synthetic/codex-home',
    DECKIDE_TEST_SECRET: `synthetic-secret-${id}`,
  },
    pendingPath, configPath, socketPath, sessionName, ...overrides };
}

function rawRequest(f) {
  return spawn(process.execPath, [clientFile, '--request'], {
    env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function sendRaw(f, request) {
  const child = rawRequest(f);
  child.stdin.end(JSON.stringify(request));
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

test('independent broker creates one tmux server with the original environment and survives its own exit', async (t) => {
  const f = fixture(t);
  const broker = await startBroker(t, f);
  const id = crypto.randomUUID();
  const request = createRequest(f, id);
  // The adapter's POSIX quoting must remain valid when an argument has an apostrophe.
  request.args[14] = String.raw`exec '/bin/sh' '-c' 'exec /bin/sleep 60 #it'\''s live'`;
  const previous = process.env.DECKIDE_TMUX_BROKER_SOCKET;
  process.env.DECKIDE_TMUX_BROKER_SOCKET = f.brokerSocket;
  try { assert.equal(runTmuxCreationInBroker(request.args, request.env), ''); }
  finally {
    if (previous === undefined) delete process.env.DECKIDE_TMUX_BROKER_SOCKET;
    else process.env.DECKIDE_TMUX_BROKER_SOCKET = previous;
  }
  const panePid = Number(execFileSync('/usr/bin/tmux', [
    '-S', request.socketPath, '-N', 'display-message', '-p', '-t', `=${request.sessionName}:0.0`, '#{pane_pid}',
  ], { encoding: 'utf8', timeout: 2000 }).trim());
  assert.ok(Number.isSafeInteger(panePid) && panePid > 0);
  const environment = fs.readFileSync(`/proc/${panePid}/environ`);
  for (const name of ['PATH', 'CODEX_HOME', 'DECKIDE_TEST_SECRET']) {
    assert.ok(environment.includes(Buffer.from(`${name}=${request.env[name]}\0`)));
  }
  for (const directory of [f.runtimeDir, f.brokerDir]) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const info = fs.lstatSync(file);
      if (!info.isFile()) continue;
      assert.equal(info.mode & 0o777, 0o600);
      assert.ok(!fs.readFileSync(file, 'utf8').includes(request.env.DECKIDE_TEST_SECRET));
    }
  }
  broker.kill('SIGTERM');
  await once(broker, 'close');
  assert.ok(!Buffer.concat(f.fixtureState.brokerOutput).includes(request.env.DECKIDE_TEST_SECRET));
  assert.ok(!Buffer.concat(f.fixtureState.brokerErrors).includes(request.env.DECKIDE_TEST_SECRET));
  assert.ok(!fs.existsSync(f.brokerSocket), 'graceful broker exit should remove its own listener');
  assert.equal(Number(execFileSync('/usr/bin/tmux', [
    '-S', request.socketPath, '-N', 'display-message', '-p', '-t', `=${request.sessionName}:0.0`, '#{pane_pid}',
  ], { encoding: 'utf8', timeout: 2000 }).trim()), panePid);
});

test('broker rejects injected arguments and mismatched ownership records without creating a server', async (t) => {
  const f = fixture(t);
  await startBroker(t, f);
  const id = crypto.randomUUID();
  const request = createRequest(f, id);
  const cases = [
    { ...request, args: [...request.args, '; touch /tmp/unwanted'] },
    { ...request, args: request.args.map((part, index) => index === 1 ? '/tmp/other.sock' : part) },
    { ...request, args: request.args.map((part, index) => index === 13 ? 'relative' : part) },
    { ...request, args: request.args.map((part, index) => index === 14 ? "exec '/bin/sh'; true" : part) },
  ];
  for (const candidate of cases) {
    const result = await sendRaw(f, { args: candidate.args, env: candidate.env });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(!fs.existsSync(request.socketPath));
  }
  const config = fs.readFileSync(request.configPath, 'utf8');
  fs.writeFileSync(request.configPath, config.replace(/@deckide_generation [^\n]+/, `@deckide_generation ${crypto.randomUUID()}`));
  const mismatch = await sendRaw(f, { args: request.args, env: request.env });
  assert.equal(mismatch.code, 1);
  assert.ok(!fs.existsSync(request.socketPath));
  assert.ok(!mismatch.stdout.includes(request.env.DECKIDE_TEST_SECRET));
  assert.ok(!mismatch.stderr.includes(request.env.DECKIDE_TEST_SECRET));

  fs.writeFileSync(request.configPath, config);
  fs.chmodSync(request.pendingPath, 0o644);
  assert.equal((await sendRaw(f, { args: request.args, env: request.env })).code, 1);
  assert.ok(!fs.existsSync(request.socketPath));
  fs.chmodSync(request.pendingPath, 0o600);
  fs.renameSync(request.configPath, `${request.configPath}.original`);
  fs.symlinkSync(`${request.configPath}.original`, request.configPath);
  assert.equal((await sendRaw(f, { args: request.args, env: request.env })).code, 1);
  assert.ok(!fs.existsSync(request.socketPath));
});

test('broker rejects unknown or mistyped pending metadata before executing tmux', async (t) => {
  const f = fixture(t);
  await startBroker(t, f);
  const request = createRequest(f, crypto.randomUUID());
  const pending = JSON.parse(fs.readFileSync(request.pendingPath, 'utf8'));
  for (const invalid of [
    { ...pending, env: { DECKIDE_TEST_SECRET: request.env.DECKIDE_TEST_SECRET } },
    { ...pending, deckId: null },
    { ...pending, title: 17 },
    { ...pending, createdAt: [] },
  ]) {
    fs.writeFileSync(request.pendingPath, JSON.stringify(invalid) + '\n');
    const result = await sendRaw(f, { args: request.args, env: request.env });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(!fs.existsSync(request.socketPath));
  }
  fs.writeFileSync(request.pendingPath, JSON.stringify(pending) + '\n');
  assert.ok(!Buffer.concat(f.fixtureState.brokerOutput).includes(request.env.DECKIDE_TEST_SECRET));
  assert.ok(!Buffer.concat(f.fixtureState.brokerErrors).includes(request.env.DECKIDE_TEST_SECRET));
});

test('private client refuses permissive or symlinked broker sockets before sending the environment', async (t) => {
  const f = fixture(t);
  await startBroker(t, f);
  const request = createRequest(f, crypto.randomUUID());
  const previous = process.env.DECKIDE_TMUX_BROKER_SOCKET;
  try {
    process.env.DECKIDE_TMUX_BROKER_SOCKET = f.brokerSocket;
    fs.chmodSync(f.brokerSocket, 0o660);
    assert.throws(() => runTmuxCreationInBroker(request.args, request.env), /broker unavailable or creation failed/);
    fs.chmodSync(f.brokerSocket, 0o600);
    const alias = path.join(f.brokerDir, 'broker-alias.sock');
    fs.symlinkSync(f.brokerSocket, alias);
    process.env.DECKIDE_TMUX_BROKER_SOCKET = alias;
    assert.throws(() => runTmuxCreationInBroker(request.args, request.env), /broker unavailable or creation failed/);
    assert.ok(!fs.existsSync(request.socketPath));
  } finally {
    fs.chmodSync(f.brokerSocket, 0o600);
    if (previous === undefined) delete process.env.DECKIDE_TMUX_BROKER_SOCKET;
    else process.env.DECKIDE_TMUX_BROKER_SOCKET = previous;
  }
});

test('broker refuses an existing socket path without deleting or replacing it', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.brokerSocket, 'operator-owned-marker', { mode: 0o600 });
  const child = spawn(process.execPath, [brokerFile, '--serve'], {
    env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(f.brokerSocket, 'utf8'), 'operator-owned-marker');
});

test('broker probes a stale owner-only socket but leaves it for operator review', async (t) => {
  const f = fixture(t);
  const owner = spawn(process.execPath, ['-e',
    "process.umask(0o177);const net=require('node:net');net.createServer().listen(process.argv[1],()=>process.stdout.write('ready'))",
    f.brokerSocket], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(owner.stdout, 'data');
  owner.kill('SIGKILL');
  await once(owner, 'exit');
  assert.ok(fs.lstatSync(f.brokerSocket).isSocket());
  const child = spawn(process.execPath, [brokerFile, '--serve'], {
    env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.ok(fs.lstatSync(f.brokerSocket).isSocket());
});
