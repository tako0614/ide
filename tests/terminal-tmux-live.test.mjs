import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import pty from 'node-pty';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.DECKIDE_CANDIDATE_PACKAGE_ROOT || sourceRoot);
const testSecret = 'deckide-test-secret-not-real-2026-10-04';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const tmuxCheck = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
const tmuxPath = tmuxCheck.status === 0 ? findOnPath('tmux') : null;
const pythonPath = ['/usr/bin/python3', '/usr/local/bin/python3'].find((candidate) =>
  spawnSync(candidate, ['--version']).status === 0);

function findOnPath(command) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try { if (spawnSync(candidate, ['-V'], { encoding: 'utf8' }).status === 0) return candidate; }
    catch { /* Try the next PATH entry. */ }
  }
  return null;
}

const quotePosix = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const sleep = (ms) => delay(ms);

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(predicate, message, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(40);
  }
  throw new Error(message, lastError ? { cause: lastError } : undefined);
}

function startService(port, env) {
  const child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  const keep = (chunk) => { child.output = (child.output + chunk.toString()).slice(-32_000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.once('error', (error) => { child.startError = error; });
  return child;
}

async function waitForService(child, origin) {
  return waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`DeckIDE exited (${child.exitCode}):\n${child.output}`);
    if (child.startError) throw child.startError;
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  }, `DeckIDE did not become healthy:\n${child.output}`, 15_000);
}

async function stopService(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(8000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
  ]);
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
}

async function request(origin, route, method = 'GET', body) {
  return fetch(origin + route, {
    method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
}

async function getTerminals(origin, deckId) {
  const response = await request(origin, `/api/terminals?deckId=${encodeURIComponent(deckId)}`);
  if (response.status !== 200) throw new Error(`Terminal listing returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function connectViewer(origin, terminalId, query = '') {
  const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/terminals/${terminalId}${query}`, {
    headers: { Origin: origin },
  });
  const messages = [];
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  socket.on('message', (data, binary) => {
    let message;
    if (binary) message = Buffer.from(data);
    else {
      try { message = JSON.parse(data.toString()); } catch { message = data.toString(); }
    }
    messages.push(message);
    if (!binary && message?.type === 'ready') resolveReady();
  });
  socket.once('error', rejectReady);
  await Promise.race([ready, sleep(7000).then(() => { throw new Error('terminal WebSocket did not reach ready'); })]);
  socket.on('error', () => {});
  return { socket, messages };
}

const syncMessage = (viewer) => viewer.messages.find((message) => !Buffer.isBuffer(message) && message?.type === 'sync');
function snapshotBytes(viewer) {
  const syncIndex = viewer.messages.findIndex((message) => !Buffer.isBuffer(message) && message?.type === 'sync');
  const readyIndex = viewer.messages.findIndex((message) => !Buffer.isBuffer(message) && message?.type === 'ready');
  return Buffer.concat(viewer.messages.slice(syncIndex + 1, readyIndex).filter(Buffer.isBuffer));
}

async function assertAlternateSnapshot(data, cols, rows) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  const unicode = new Unicode11Addon();
  terminal.loadAddon(unicode);
  terminal.unicode.activeVersion = '11';
  try {
    await new Promise((resolve) => terminal.write(data, resolve));
    assert.equal(terminal.buffer.active.type, 'alternate', 'serialized snapshot restores the alternate buffer');
    const visible = Array.from({ length: rows }, (_, index) =>
      terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true) || '').join('\n');
    assert.ok(visible.includes('日本語'), 'restored alternate buffer contains its Unicode screen content');
  } finally { terminal.dispose(); }
}

async function closeViewer(viewer) {
  if (!viewer || viewer.socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { viewer.socket.terminate(); resolve(); }, 1500);
    viewer.socket.once('close', () => { clearTimeout(timer); resolve(); });
    if (viewer.socket.readyState === WebSocket.OPEN) viewer.socket.close(1000, 'fixture viewer done');
    else viewer.socket.terminate();
  });
}

async function probeEvents(file) {
  try {
    return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function assertSecretAbsent(value, surface) {
  assert.ok(!String(value).includes(testSecret), `synthetic secret was exposed in ${surface}`);
}

async function assertRuntimeFilesDoNotContainSecret(runtimeDir) {
  for (const name of await readdir(runtimeDir)) {
    if (!name.endsWith('.json') && !name.endsWith('.conf')) continue;
    assertSecretAbsent(await readFile(path.join(runtimeDir, name), 'utf8'), `runtime/${name}`);
  }
}

async function submitRejectedBrokerRequest(packageRoot, env) {
  const client = spawn(process.execPath, [path.join(packageRoot, 'dist/terminal/tmuxBrokerClient.js'), '--request'], {
    cwd: packageRoot, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  client.stdout.on('data', (chunk) => stdout.push(chunk));
  client.stderr.on('data', (chunk) => stderr.push(chunk));
  const exited = once(client, 'exit');
  client.stdin.end(JSON.stringify({ args: ['invalid', testSecret], env: { DECKIDE_TEST_SECRET: testSecret } }));
  const [code] = await exited;
  const out = Buffer.concat(stdout).toString('utf8');
  const err = Buffer.concat(stderr).toString('utf8');
  assert.equal(code, 1, 'broker rejects malformed creation arguments');
  assertSecretAbsent(out, 'broker client stdout after rejected request');
  assertSecretAbsent(err, 'broker client stderr after rejected request');
}

async function startBroker(root, socketPath, runtimeDir, env) {
  const child = spawn(process.execPath, [path.join(root, 'dist/terminal/tmuxBroker.js'), '--serve'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  const keep = (chunk) => { child.output = (child.output + chunk.toString()).slice(-8000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.once('error', (error) => { child.startError = error; });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`tmux broker exited (${child.exitCode}):\n${child.output}`);
    if (child.startError) throw child.startError;
    try {
      const info = await lstat(socketPath);
      assert.ok(info.isSocket());
      assert.equal(info.mode & 0o777, 0o600);
      return true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, `tmux broker did not bind its fixture socket (${runtimeDir}):\n${child.output}`, 5000);
  return child;
}

async function waitForBrokerSocket(socketPath) {
  return waitFor(async () => {
    try {
      const info = await lstat(socketPath);
      assert.ok(info.isSocket());
      assert.equal(info.mode & 0o777, 0o600);
      return true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, 'external tmux broker socket did not become ready', 5000);
}

async function stopBroker(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    sleep(3000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
  ]);
  if (child.exitCode === null) await once(child, 'exit');
}

test('real tmux terminal survives viewers and HTTP service restart, with fixed geometry and scoped deletion', {
  skip: !tmuxPath ? `tmux unavailable; real-tmux acceptance gate not run${tmuxCheck.error ? ` (${tmuxCheck.error.code})` : ''}`
    : !pythonPath ? 'python3 unavailable for disposable raw-PTY probe' : false,
}, async (t) => {
  const tempBase = path.resolve(process.env.TMPDIR || os.tmpdir());
  const tempRoot = await mkdtemp(path.join(tempBase, 'deckide-tmux-live-'));
  const dataDir = path.join(tempRoot, 'data');
  const ownRuntimeDir = path.join(tempRoot, 'tmux-runtime');
  const externalBrokerSocket = process.env.DECKIDE_TMUX_TEST_BROKER_SOCKET;
  const externalRuntimeDir = process.env.DECKIDE_TMUX_TEST_RUNTIME_DIR;
  const ownBrokerEnabled = process.env.DECKIDE_TMUX_TEST_WITH_BROKER === '1';
  assert.equal(ownBrokerEnabled && Boolean(externalBrokerSocket), false,
    'choose either a fixture-owned broker or an externally supplied broker');
  if (externalBrokerSocket) assert.ok(externalRuntimeDir,
    'DECKIDE_TMUX_TEST_RUNTIME_DIR must name the same private runtime directory configured for the external broker');
  const runtimeDir = externalRuntimeDir ? path.resolve(externalRuntimeDir) : ownRuntimeDir;
  const brokerDir = path.join(tempRoot, 'private-broker');
  const brokerSocket = externalBrokerSocket || (ownBrokerEnabled ? path.join(brokerDir, 'broker.sock') : undefined);
  const homeDir = path.join(tempRoot, 'home');
  const sentinelBin = path.join(tempRoot, 'sentinel-bin');
  const workspacePath = path.join(tempRoot, 'workspace');
  const probeLog = path.join(tempRoot, 'probe.jsonl');
  const launcherLog = path.join(tempRoot, 'launcher.log');
  const shellLauncher = path.join(tempRoot, 'probe-shell');
  const probePath = path.join(sourceRoot, 'tests/fixtures/tmux-probe.py');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const serviceEnv = {
    PATH: [sentinelBin, path.dirname(tmuxPath), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: homeDir,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    SHELL: shellLauncher,
    CODEX_HOME: path.join(tempRoot, 'sentinel-codex-home'),
    DECKIDE_DATA_DIR: dataDir,
    DECKIDE_TMUX_RUNTIME_DIR: runtimeDir,
    DECKIDE_TMUX_LAUNCH_LOG: launcherLog,
    DECKIDE_TMUX_PROBE_LOG: probeLog,
    DECKIDE_TEST_SECRET: testSecret,
    PORT: String(port),
    HOST: '127.0.0.1',
    AGENT_BROWSER_AUTOSTART: 'false',
    AGENT_BROWSER_REAP_MCP: 'false',
    NODE_ENV: 'test',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    ...(brokerSocket ? { DECKIDE_TMUX_BROKER_SOCKET: brokerSocket } : {}),
  };

  let service;
  let broker;
  let nativeAttach;
  let ownedSocketPath;
  const viewers = new Set();
  t.after(async () => {
    for (const viewer of viewers) await closeViewer(viewer);
    if (nativeAttach) { try { nativeAttach.kill(); } catch { /* already exited */ } }
    await stopService(service);
    if (ownedSocketPath) {
      spawnSync(tmuxPath, ['-S', ownedSocketPath, '-N', 'kill-server'], { env: serviceEnv, stdio: 'ignore', timeout: 1500 });
    }
    await stopBroker(broker);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await Promise.all([dataDir, homeDir, sentinelBin, workspacePath].map((directory) => mkdir(directory, { recursive: true })));
  if (externalBrokerSocket) {
    const relativeRuntime = path.relative(tempBase, runtimeDir);
    assert.ok(relativeRuntime && relativeRuntime !== '..' && !relativeRuntime.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeRuntime),
      'external broker runtime must be a disposable directory below TMPDIR');
    const runtimeStat = await lstat(runtimeDir);
    assert.ok(runtimeStat.isDirectory() && !runtimeStat.isSymbolicLink());
    assert.equal(runtimeStat.mode & 0o077, 0, 'external broker runtime must be owner-only');
    assert.deepEqual(await readdir(runtimeDir), [], 'external broker runtime starts empty');
  } else if (ownBrokerEnabled) {
    await mkdir(runtimeDir, { mode: 0o700 });
    await chmod(runtimeDir, 0o700);
    await mkdir(brokerDir, { mode: 0o700 });
    await chmod(brokerDir, 0o700);
  }
  if (brokerSocket) {
    if (ownBrokerEnabled) broker = await startBroker(root, brokerSocket, runtimeDir, serviceEnv);
    else await waitForBrokerSocket(brokerSocket);
  }
  const launcherText = [
    '#!/bin/sh',
    '{',
    `  printf 'argc=%s\\n' "$#"`,
    '  i=0',
    `  for arg do printf 'argv%s=%s\\n' "$i" "$arg"; i=$((i + 1)); done`,
    `  printf 'PATH=%s\\nCODEX_HOME=%s\\nHOME=%s\\n' "$PATH" "${'${CODEX_HOME-}'}" "$HOME"`,
    '} >> "$DECKIDE_TMUX_LAUNCH_LOG"',
    'exec /bin/sh "$@"',
    '',
  ].join('\n');
  await writeFile(shellLauncher, launcherText);
  await chmod(shellLauncher, 0o700);

  service = startService(port, serviceEnv);
  await waitForService(service, origin);
  const workspaceResponse = await request(origin, '/api/workspaces', 'POST', { path: workspacePath, name: 'tmux fixture' });
  if (workspaceResponse.status !== 201) throw new Error(`Workspace creation returned ${workspaceResponse.status}: ${await workspaceResponse.text()}`);
  const workspace = await workspaceResponse.json();
  const deckResponse = await request(origin, '/api/decks', 'POST', { workspaceId: workspace.id, name: 'tmux fixture deck' });
  if (deckResponse.status !== 201) throw new Error(`Deck creation returned ${deckResponse.status}: ${await deckResponse.text()}`);
  const deck = await deckResponse.json();

  const command = `exec ${pythonPath} ${quotePosix(probePath)}`;
  const createResponse = await request(origin, '/api/terminals', 'POST', {
    deckId: deck.id, title: 'real tmux acceptance', command, cols: 120, rows: 32,
  });
  if (createResponse.status !== 201) throw new Error(`Terminal creation returned ${createResponse.status}: ${await createResponse.text()}\n${service.output}`);
  const created = await createResponse.json();
  assertSecretAbsent(JSON.stringify(created), 'terminal creation metadata JSON');
  assertSecretAbsent(service.output, 'HTTP service stdout/stderr after terminal creation');
  await assertRuntimeFilesDoNotContainSecret(runtimeDir);
  if (broker) assertSecretAbsent(broker.output, 'fixture broker stdout/stderr after successful creation');
  ownedSocketPath = created.tmux.socketPath;
  assert.equal(created.cols, 120);
  assert.equal(created.rows, 32);
  assert.ok(created.pid > 0);

  const launcher = await readFile(launcherLog, 'utf8');
  assert.match(launcher, /argc=2\nargv0=-c\n/);
  assert.ok(launcher.includes(`argv1=${command}`), 'custom launcher receives the command as one argv entry');
  assert.ok(launcher.includes(`CODEX_HOME=${serviceEnv.CODEX_HOME}`));
  assert.ok(launcher.includes(`PATH=${serviceEnv.PATH}`), 'shell startup sees fixture-sentinel PATH');
  assert.ok(launcher.includes(`HOME=${homeDir}`), 'probe shell uses only its temporary HOME');

  const started = await waitFor(async () => (await probeEvents(probeLog)).find((event) => event.event === 'start'), 'probe shell did not start');
  assert.equal(started.pid, created.pid);
  assert.equal(started.cols, 120);
  assert.equal(started.rows, 32);
  assert.equal(started.codexHome, serviceEnv.CODEX_HOME);
  assert.equal(started.path, serviceEnv.PATH);
  assert.equal(started.testSecret, testSecret, 'probe receives the explicit synthetic environment secret');

  if (brokerSocket) {
    await submitRejectedBrokerRequest(root, serviceEnv);
    if (broker) assertSecretAbsent(broker.output, 'fixture broker stdout/stderr after rejected request');
    assertSecretAbsent(service.output, 'HTTP service stdout/stderr after rejected broker request');
    await assertRuntimeFilesDoNotContainSecret(runtimeDir);
  }

  const first = await connectViewer(origin, created.id);
  viewers.add(first);
  const firstSync = syncMessage(first);
  assert.ok(firstSync);
  assert.equal(firstSync.reset, true);
  assert.equal(firstSync.cols, 120);
  assert.equal(firstSync.rows, 32);
  assert.ok(snapshotBytes(first).toString('utf8').includes('日本語'), 'canonical alternate-screen snapshot preserves Unicode output');
  await assertAlternateSnapshot(snapshotBytes(first), firstSync.cols, firstSync.rows);

  const second = await connectViewer(origin, created.id);
  viewers.add(second);
  first.socket.send(JSON.stringify({ type: 'resize', cols: 40, rows: 10 }));
  second.socket.send(JSON.stringify({ type: 'resize', cols: 200, rows: 70 }));
  await sleep(100);
  let live = (await getTerminals(origin, deck.id)).find((entry) => entry.id === created.id);
  assertSecretAbsent(JSON.stringify(live), 'terminal list metadata JSON');
  assertSecretAbsent(service.output, 'HTTP service stdout/stderr after terminal list');
  await assertRuntimeFilesDoNotContainSecret(runtimeDir);
  assert.deepEqual([live.cols, live.rows], [120, 32], 'ordinary viewer resize messages do not change shared geometry');

  const signalsBeforeAttach = (await probeEvents(probeLog)).filter((event) => event.event === 'sigwinch').length;
  nativeAttach = pty.spawn(tmuxPath, ['-S', ownedSocketPath, '-N', 'attach-session', '-t', `=${created.tmux.sessionName}`], {
    name: 'xterm-256color', cols: 40, rows: 10, cwd: workspacePath, env: serviceEnv,
  });
  let attachOutput = '';
  nativeAttach.onData((data) => { attachOutput = (attachOutput + data).slice(-8192); });
  await waitFor(() => attachOutput.length > 0, 'native 40x10 tmux attach produced no display output');
  await sleep(250);
  const smallNativeGeometry = spawnSync(tmuxPath, ['-S', ownedSocketPath, '-N', 'display-message', '-p', '-t', created.tmux.sessionName, '#{window_width}x#{window_height}'], {
    encoding: 'utf8', env: serviceEnv, timeout: 2000,
  });
  assert.equal(smallNativeGeometry.status, 0, smallNativeGeometry.stderr);
  assert.equal(smallNativeGeometry.stdout.trim(), '120x32', 'manual window sizing retains canonical geometry for a 40x10 native client');
  nativeAttach.resize(200, 70);
  await sleep(250);
  const largeNativeGeometry = spawnSync(tmuxPath, ['-S', ownedSocketPath, '-N', 'display-message', '-p', '-t', created.tmux.sessionName, '#{window_width}x#{window_height}'], {
    encoding: 'utf8', env: serviceEnv, timeout: 2000,
  });
  assert.equal(largeNativeGeometry.status, 0, largeNativeGeometry.stderr);
  assert.equal(largeNativeGeometry.stdout.trim(), '120x32', 'manual window sizing retains canonical geometry after the native client resizes to 200x70');
  assert.equal((await probeEvents(probeLog)).filter((event) => event.event === 'sigwinch').length, signalsBeforeAttach,
    'viewers and native clients do not send SIGWINCH to the pane');
  const detachExit = new Promise((resolve) => nativeAttach.onExit(resolve));
  nativeAttach.write('\x02d');
  await Promise.race([detachExit, sleep(3000).then(() => { throw new Error('tmux Ctrl-b d did not detach the native display client'); })]);
  nativeAttach = undefined;

  const marker = 'PASTE_日本語🙂-once';
  first.socket.send(Buffer.from(marker + '\r'));
  await waitFor(async () => (await probeEvents(probeLog)).some((event) => event.event === 'input' && event.text.includes(marker)), 'Unicode paste did not reach the pane');
  const panePid = created.pid;
  await closeViewer(first);
  viewers.delete(first);
  const reconnected = await connectViewer(origin, created.id, `?bufferOffset=0&epoch=${firstSync.epoch}`);
  viewers.add(reconnected);
  assert.equal(syncMessage(reconnected).reset, true);
  await sleep(80);
  assert.equal((await probeEvents(probeLog)).filter((event) => event.event === 'input' && event.text.includes(marker)).length, 1,
    'reconnect does not replay previously submitted input');

  await stopService(service);
  service = undefined;
  assert.equal(await processIsAlive(panePid), true, 'SIGTERM detaches DeckIDE display clients but leaves the tmux pane alive');
  const afterStop = spawnSync(tmuxPath, ['-S', ownedSocketPath, '-N', 'display-message', '-p', '-t', created.tmux.paneId, '#{pane_pid}|#{window_width}x#{window_height}'], {
    encoding: 'utf8', env: serviceEnv, timeout: 2000,
  });
  assert.equal(afterStop.status, 0, afterStop.stderr);
  assert.equal(afterStop.stdout.trim(), `${panePid}|120x32`);

  service = startService(port, serviceEnv);
  await waitForService(service, origin);
  live = (await getTerminals(origin, deck.id)).find((entry) => entry.id === created.id);
  assertSecretAbsent(JSON.stringify(live), 'restored terminal list metadata JSON');
  assertSecretAbsent(service.output, 'HTTP service stdout/stderr after service restart and list');
  await assertRuntimeFilesDoNotContainSecret(runtimeDir);
  assert.ok(live, 'startup restores the existing tmux session');
  assert.equal(live.pid, panePid, 'restored service connects to the same pane process');
  assert.deepEqual([live.cols, live.rows], [120, 32]);
  const afterRestart = await connectViewer(origin, created.id);
  viewers.add(afterRestart);
  assert.equal(syncMessage(afterRestart).reset, true);
  assert.ok(snapshotBytes(afterRestart).toString('utf8').includes('日本語'));
  await assertAlternateSnapshot(snapshotBytes(afterRestart), syncMessage(afterRestart).cols, syncMessage(afterRestart).rows);
  assertSecretAbsent(service.output, 'HTTP service stdout/stderr after reconnect');
  assert.equal((await probeEvents(probeLog)).filter((event) => event.event === 'input' && event.text.includes(marker)).length, 1);

  const sentinelResponse = await request(origin, '/api/terminals', 'POST', {
    deckId: deck.id, title: 'delete isolation sentinel', command: 'exec /usr/bin/sleep 300', cols: 120, rows: 32,
  });
  if (sentinelResponse.status !== 201) throw new Error(`Sentinel creation returned ${sentinelResponse.status}: ${await sentinelResponse.text()}`);
  const sentinel = await sentinelResponse.json();
  assertSecretAbsent(JSON.stringify(sentinel), 'sibling terminal creation metadata JSON');
  assertSecretAbsent(service.output, 'HTTP service stdout/stderr after sibling creation');
  await assertRuntimeFilesDoNotContainSecret(runtimeDir);
  if (broker) assertSecretAbsent(broker.output, 'fixture broker stdout/stderr after sibling creation');
  const deleteResponse = await request(origin, `/api/terminals/${created.id}`, 'DELETE');
  assert.equal(deleteResponse.status, 204);
  await waitFor(() => processIsAlive(panePid).then((alive) => !alive), 'HTTP delete left the fixture pane process alive');
  assert.equal(await processIsAlive(sentinel.pid), true, 'deleting one terminal leaves a sibling fixture session alive');
  const ownedSession = spawnSync(tmuxPath, ['-S', ownedSocketPath, '-N', 'has-session', '-t', `=${created.tmux.sessionName}`], {
    env: serviceEnv, timeout: 1500, stdio: 'ignore',
  });
  assert.notEqual(ownedSession.status, 0, 'HTTP delete removed its own tmux session');
  const sentinelDelete = await request(origin, `/api/terminals/${sentinel.id}`, 'DELETE');
  assert.equal(sentinelDelete.status, 204);
  await waitFor(() => processIsAlive(sentinel.pid).then((alive) => !alive), 'sentinel fixture session did not clean up');
});
