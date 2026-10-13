import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { hashPassword } from '../dist/auth/password.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-terminal-sync-'));
  const port = await freePort();
  // Auth on: the CLI token must work where browser sessions are required.
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({
    port, authEnabled: true, authUser: 'tester', authPasswordHash: await hashPassword('correct horse battery'),
  }));
  const env = { ...process.env, DECKIDE_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1',
    AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false', SHELL: '/bin/sh' };
  for (const key of ['DECKIDE_AUTH_USER', 'DECKIDE_AUTH_PASSWORD', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD']) delete env[key];
  const child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const origin = 'http://127.0.0.1:' + port;
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error('Server exited: ' + logs);
    try {
      const response = await fetch(origin + '/health');
      if (response.ok) {
        const info = JSON.parse(await readFile(path.join(dir, 'cli.json'), 'utf8'));
        return { child, dir, origin, token: info.token, info, logs: () => logs };
      }
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error('Server did not start: ' + logs);
}

async function stopServer(fixture) {
  fixture.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => fixture.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => { fixture.child.kill('SIGKILL'); resolve(); }, 2000)),
  ]);
  await rm(fixture.dir, { recursive: true, force: true });
}

async function api(fixture, url, { method = 'GET', body, token = fixture.token } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(fixture.origin + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Terminal WebSocket client that records control frames and output text. */
function attach(fixture, terminalId, query = {}) {
  const params = new URLSearchParams({ proto: '2', client: 'web', ...query });
  const socket = new WebSocket(`${fixture.origin.replace('http', 'ws')}/api/terminals/${terminalId}?${params}`, {
    headers: { Authorization: 'Bearer ' + fixture.token },
  });
  const client = { socket, controls: [], output: '', binaryFrames: 0, waiters: [] };
  const check = () => {
    client.waiters = client.waiters.filter((waiter) => {
      if (!waiter.predicate(client)) return true;
      clearTimeout(waiter.timer);
      waiter.resolve();
      return false;
    });
  };
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      client.binaryFrames++;
      client.output += data.toString('utf8');
    } else {
      client.controls.push(JSON.parse(data.toString('utf8')));
    }
    check();
  });
  client.until = (predicate, label = 'condition') => new Promise((resolve, reject) => {
    if (predicate(client)) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}; controls=${JSON.stringify(client.controls)}`)), 4000);
    client.waiters.push({ predicate, resolve, timer });
  });
  client.send = (message) => socket.send(JSON.stringify(message));
  client.last = (type) => [...client.controls].reverse().find((message) => message.type === type);
  client.close = () => new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
    socket.once('close', resolve);
    socket.close();
  });
  return client;
}

const isReady = (client) => client.controls.some((message) => message.type === 'ready');

async function makeTerminal(fixture) {
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'deckide-ws-'));
  const workspace = await api(fixture, '/api/workspaces', { method: 'POST', body: { path: workdir } });
  assert.equal(workspace.status, 201, JSON.stringify(workspace.body));
  const deck = await api(fixture, '/api/decks', { method: 'POST', body: { name: 'sync', workspaceId: workspace.body.id } });
  assert.equal(deck.status, 201);
  const terminal = await api(fixture, '/api/terminals', { method: 'POST', body: { deckId: deck.body.id, cols: 80, rows: 24 } });
  assert.equal(terminal.status, 201);
  return { deckId: deck.body.id, terminalId: terminal.body.id, workdir };
}

test('PTY size follows the most recently active client and every client renders at it', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture));
  const { terminalId } = await makeTerminal(fixture);

  // First client takes control and its viewport size is applied before replay.
  const a = attach(fixture, terminalId, { cols: '100', rows: '30' });
  await a.until(isReady, 'A ready');
  const syncA = a.controls.find((message) => message.type === 'sync');
  assert.deepEqual([syncA.cols, syncA.rows, syncA.snapshot, syncA.reset], [100, 30, true, true]);
  await a.until((c) => c.last('primary')?.value === true, 'A primary');

  // A second client attaches as a viewer at the PTY size, not its own.
  const b = attach(fixture, terminalId, { cols: '50', rows: '20' });
  await b.until(isReady, 'B ready');
  const syncB = b.controls.find((message) => message.type === 'sync');
  assert.deepEqual([syncB.cols, syncB.rows], [100, 30]);
  await b.until((c) => c.last('primary') !== undefined, 'B role');
  assert.equal(b.last('primary').value, false);

  // A viewer's resize is remembered but does not move the PTY.
  b.send({ type: 'resize', cols: 52, rows: 21 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await api(fixture, `/api/terminals/${terminalId}`)).body.cols, 100);

  // Claiming hands control over and resizes everyone to the claimant.
  b.send({ type: 'claim' });
  await b.until((c) => c.last('size')?.cols === 52, 'B size');
  await a.until((c) => c.last('size')?.cols === 52 && c.last('primary')?.value === false, 'A demoted');
  assert.equal(b.last('primary')?.value, true);
  const info = (await api(fixture, `/api/terminals/${terminalId}`)).body;
  assert.deepEqual([info.cols, info.rows, info.clients.web], [52, 21, 2]);

  // When the primary leaves, the remaining client takes over at its own size.
  a.send({ type: 'resize', cols: 120, rows: 40 });
  await b.close();
  await a.until((c) => c.last('size')?.cols === 120 && c.last('primary')?.value === true, 'A promoted');
  await a.close();
});

test('a client that reconnects with the same id takes over its ghost socket as primary', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture));
  const { terminalId } = await makeTerminal(fixture);

  const phone = attach(fixture, terminalId, { cols: '40', rows: '20', cid: 'phone-tile-1' });
  await phone.until((c) => c.last('primary')?.value === true, 'phone primary');
  const desktop = attach(fixture, terminalId, { cols: '120', rows: '40', cid: 'desk-tile-1' });
  await desktop.until((c) => c.last('primary')?.value === false, 'desktop viewer');

  // The phone's old socket is still open (not yet detected dead) when it reconnects.
  const closed = new Promise((resolve) => phone.socket.once('close', resolve));
  const phoneAgain = attach(fixture, terminalId, { cols: '42', rows: '20', cid: 'phone-tile-1' });
  await phoneAgain.until((c) => c.last('primary')?.value === true, 'phone resumed primary');
  await closed;
  await desktop.until((c) => c.last('size')?.cols === 42, 'desktop follows resumed phone');
  assert.equal(desktop.last('primary').value, false);
  const info = (await api(fixture, `/api/terminals/${terminalId}`)).body;
  assert.equal(info.clients.web, 2);
  await phoneAgain.close();
  await desktop.close();
});

test('a late joiner gets the rendered screen and a reconnect gets only missed bytes', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture));
  const { terminalId } = await makeTerminal(fixture);

  const a = attach(fixture, terminalId, { cols: '80', rows: '24' });
  await a.until(isReady, 'A ready');
  const sent = await api(fixture, `/api/terminals/${terminalId}/input`, { method: 'POST', body: { data: 'echo snap-$((40+2))\n' } });
  assert.equal(sent.status, 200);
  await a.until((c) => c.output.includes('snap-42'), 'echo output');

  const late = attach(fixture, terminalId, { cols: '80', rows: '24' });
  await late.until(isReady, 'late ready');
  assert.equal(late.controls.find((m) => m.type === 'sync').snapshot, true);
  assert.match(late.output, /snap-42/);
  const offset = late.controls.find((m) => m.type === 'sync').offsetBase;
  assert.ok(offset > 0);
  await late.close();

  // Reconnect at the offset already rendered: nothing to replay, no reset.
  const resumed = attach(fixture, terminalId, { cols: '80', rows: '24', bufferOffset: String(offset) });
  await resumed.until(isReady, 'resumed ready');
  const sync = resumed.controls.find((m) => m.type === 'sync');
  assert.equal(sync.reset, false);
  assert.equal(sync.snapshot, undefined);
  assert.equal(sync.offsetBase, offset);

  // Output after that offset, then a resize: those bytes were drawn at the old
  // size, so the same offset must now get a fresh snapshot instead of a delta.
  await api(fixture, `/api/terminals/${terminalId}/input`, { method: 'POST', body: { data: 'echo more-$((1+1))\n' } });
  await resumed.until((c) => c.output.includes('more-2'), 'more output');
  await api(fixture, `/api/terminals/${terminalId}/resize`, { method: 'POST', body: { cols: 90, rows: 25 } });
  await resumed.until((c) => c.last('size')?.cols === 90, 'resize broadcast');
  await resumed.close();
  const stale = attach(fixture, terminalId, { cols: '90', rows: '25', bufferOffset: String(offset) });
  await stale.until(isReady, 'stale ready');
  assert.equal(stale.controls.find((m) => m.type === 'sync').snapshot, true);
  await stale.close();
  await a.close();
});

test('CLI token authenticates REST and WebSocket while auth is on; events stream state changes', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture));

  assert.equal((await api(fixture, '/api/decks', { token: null })).status, 401);
  assert.equal((await api(fixture, '/api/decks', { token: 'x'.repeat(43) })).status, 401);
  assert.equal((await api(fixture, '/api/decks')).status, 200);

  const controller = new AbortController();
  const events = [];
  const stream = await fetch(fixture.origin + '/api/events', {
    headers: { Authorization: 'Bearer ' + fixture.token }, signal: controller.signal,
  });
  assert.equal(stream.status, 200);
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  const { deckId, terminalId } = await makeTerminal(fixture);
  await api(fixture, `/api/terminals/${terminalId}/focus`, { method: 'POST' });
  await api(fixture, `/api/terminals/${terminalId}`, { method: 'DELETE' });
  for (let n = 0; n < 40 && !events.some((e) => e.type === 'terminal.removed'); n++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['workspace.created', 'deck.created', 'terminal.created', 'ui.focus', 'terminal.removed']);
  assert.equal(events[2].deckId, deckId);
  assert.equal(events[4].terminalId, terminalId);
});

test('the event stream of a browser session ends when the session is logged out', async (t) => {
  const fixture = await startServer();
  t.after(() => stopServer(fixture));
  const login = await fetch(fixture.origin + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: fixture.origin, 'X-DeckIDE-CSRF': '1' },
    body: JSON.stringify({ username: 'tester', password: 'correct horse battery' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const stream = await fetch(fixture.origin + '/api/events', { headers: { Cookie: cookie } });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read(); // hello
  const ended = (async () => { for (;;) { const { done } = await reader.read(); if (done) return true; } })();
  const logout = await fetch(fixture.origin + '/api/auth/logout', {
    method: 'POST', headers: { Cookie: cookie, Origin: fixture.origin, 'X-DeckIDE-CSRF': '1' },
  });
  assert.equal(logout.status, 204);
  const result = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]);
  assert.equal(result, true, 'stream still open after logout');
});
