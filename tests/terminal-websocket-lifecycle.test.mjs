import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';

// A protocol fixture, not a mocked claim about tmux process persistence.
test('snapshot ordering, fixed grid, reconnect input and close use disposable WebSocket viewers', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-ws-'));
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.DECKIDE_DATA_DIR = dir;
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  for (const key of ['DECKIDE_AUTH_USER', 'DECKIDE_AUTH_PASSWORD', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD']) delete process.env[key];
  const { initializeCredentials } = await import('../dist/auth/credentials.js');
  await initializeCredentials(); // Empty settings in this disposable fixture only.
  const { setupWebSocketServer, getConnectionStats } = await import('../dist/websocket.js');
  const id = crypto.randomUUID();
  const inputs = [];
  const resizes = [];
  const snapshot = Buffer.from('\x1b[?1049h\x1b[2J\x1b[H日本語');
  // The live suffix finishes a UTF-8 fragment. A snapshot's parser tail owns
  // its leading bytes, so reconnect must not trim these continuation bytes.
  const liveTail = Buffer.from([0x9c, 0xac, 0x1b, 0x5b]);
  let captures = 0;
  const session = {
    id, deckId: 'fixture', title: 'fixture', command: null, createdAt: new Date().toISOString(),
    available: true, cols: 120, rows: 32, pid: 1234,
    bufferEpoch: crypto.randomUUID(), sockets: new Set(),
    bufferChunks: [], bufferLength: 0, bufferBase: 100, lastActive: 0,
    snapshot: async () => {
      captures++;
      if (captures === 1) {
        // A write completing while capture resolves must be sent after the
        // snapshot and before the viewer begins receiving live broadcasts.
        session.bufferChunks = [liveTail]; session.bufferLength = liveTail.length;
      }
      return { data: snapshot, offset: 100, sequence: 1, cols: session.cols, rows: session.rows };
    },
    write: (data) => inputs.push(Buffer.from(data)),
    resize: (cols, rows) => { session.cols = cols; session.rows = rows; resizes.push([cols, rows]); },
    detach: () => {}, kill: async () => {}, tmux: {},
  };
  const terminals = new Map([[id, session]]);
  const wss = setupWebSocketServer(server, terminals);
  const viewers = [];
  t.after(async () => {
    for (const viewer of viewers) viewer.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const connect = async (query = '') => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}${query}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    viewers.push(socket);
    const messages = [];
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    socket.on('message', (data, binary) => {
      messages.push(binary ? Buffer.from(data) : JSON.parse(data.toString()));
      if (!binary && messages.at(-1).type === 'ready') resolveReady();
    });
    let timer;
    const failure = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('viewer ready timeout')), 2000);
      socket.on('error', reject);
    });
    try { await Promise.race([ready, failure]); } finally { clearTimeout(timer); }
    return { socket, messages };
  };
  const first = await connect();
  assert.deepEqual(first.messages[0], { type: 'sync', offsetBase: 100, reset: true, cols: 120, rows: 32,
    epoch: session.bufferEpoch, snapshotBytes: snapshot.length });
  assert.deepEqual(first.messages[1], snapshot);
  assert.deepEqual(first.messages[2], liveTail);
  assert.equal(first.messages[3].type, 'ready');
  assert.deepEqual(first.messages[4], { type: 'primary', value: false });
  const second = await connect('?bufferOffset=999999&epoch=old-http-epoch');
  for (const [viewer, cols, rows] of [[first, 40, 10], [second, 200, 70]]) {
    viewer.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
  second.socket.send(Buffer.from('日本語🙂\r'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(resizes, [], 'viewer geometry cannot resize the shared TUI');
  assert.deepEqual([session.cols, session.rows], [120, 32]);
  assert.deepEqual(inputs, [Buffer.from('日本語🙂\r')]);
  for (let n = 0; n < 3; n++) {
    const viewer = await connect(`?bufferOffset=100&epoch=${session.bufferEpoch}`);
    viewer.socket.send(Buffer.from(`once-${n}\r`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    viewer.socket.close();
    await once(viewer.socket, 'close');
  }
  assert.deepEqual(inputs.map((value) => value.toString()), ['日本語🙂\r', 'once-0\r', 'once-1\r', 'once-2\r']);
  first.socket.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24, explicit: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(resizes, [[80, 24]], 'only explicit shared-size requests are accepted');
  assert.equal(getConnectionStats().reduce((sum, item) => sum + item.count, 0), 2);

  let gapCaptures = 0;
  session.snapshot = async () => {
    gapCaptures++;
    session.bufferBase = 300;
    return { data: snapshot, offset: gapCaptures === 1 ? 200 : 304, sequence: 10,
      cols: session.cols, rows: session.rows };
  };
  const afterGap = await connect();
  assert.equal(gapCaptures, 2, 'a trimmed live suffix requires a fresh complete snapshot');
  assert.equal(afterGap.messages[0].offsetBase, 304);
  afterGap.socket.close();
  await once(afterGap.socket, 'close');

  let releaseCapture;
  session.snapshot = () => new Promise((resolve) => { releaseCapture = resolve; });
  const departing = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  viewers.push(departing);
  departing.on('error', () => {});
  await once(departing, 'open');
  departing.close();
  await once(departing, 'close');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getConnectionStats().reduce((sum, item) => sum + item.count, 0), 2,
    'a viewer that closes during capture releases its connection slot immediately');
  releaseCapture({ data: snapshot, offset: 304, sequence: 10, cols: 80, rows: 24 });
  terminals.delete(id);
  for (const viewer of [first, second]) {
    viewer.socket.close(1000, 'Terminal deleted');
    await once(viewer.socket, 'close');
  }
  assert.equal(getConnectionStats().reduce((sum, item) => sum + item.count, 0), 0);
});
