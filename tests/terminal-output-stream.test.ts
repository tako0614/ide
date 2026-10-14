import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocket } from 'ws';
import type { TerminalSession } from '../src/types.ts';
import {
  cancelOutputFlush,
  flushOutput,
  registerViewer,
  scheduleOutputFlush,
  setViewerVisible,
  viewerState,
} from '../src/websocket.ts';

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  frames: Buffer[] = [];
  closed: number | null = null;
  send(data: Buffer, _options: unknown, callback?: (error?: Error) => void) {
    this.frames.push(Buffer.from(data));
    callback?.();
  }
  close(code: number) { this.closed = code; this.readyState = 3; }
}

function session(): TerminalSession {
  return {
    id: 'fixture', deckId: 'deck', title: 'fixture', command: null, createdAt: '',
    cols: 80, rows: 24, pid: 1, tmux: {} as TerminalSession['tmux'], available: true,
    bufferEpoch: 'epoch', snapshot: async () => ({ data: Buffer.alloc(0), offset: 0, sequence: 0, cols: 80, rows: 24 }),
    detach: () => {}, sockets: new Set(), bufferChunks: [], bufferLength: 0, bufferBase: 0,
    lastActive: 0, write: () => {}, resize: () => {}, kill: async () => {},
  };
}

function append(target: TerminalSession, text: string | Buffer, delayMs = 20): void {
  const chunk = Buffer.isBuffer(text) ? text : Buffer.from(text);
  target.bufferChunks.push(chunk);
  target.bufferLength += chunk.length;
  scheduleOutputFlush(target, chunk.length, delayMs);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('many small output chunks are coalesced into one frame per interval', async (t) => {
  const s = session();
  t.after(() => cancelOutputFlush(s));
  const viewer = new FakeSocket();
  registerViewer(s, viewer as unknown as WebSocket, 0, () => assert.fail('no resync expected'));
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴'];
  for (let n = 0; n < 60; n++) append(s, `\x1b[2;1H${spinner[n % spinner.length]} working`);
  assert.equal(viewer.frames.length, 0, 'nothing is written per chunk');
  await wait(40);
  assert.equal(viewer.frames.length, 1);
  assert.deepEqual(viewer.frames[0], Buffer.concat(s.bufferChunks));
  append(s, 'next');
  await wait(40);
  assert.deepEqual(viewer.frames.map((frame) => frame.toString()).at(-1), 'next');
});

test('frames preserve byte order and never split or trim multibyte or escape sequences', async (t) => {
  const s = session();
  t.after(() => cancelOutputFlush(s));
  const viewer = new FakeSocket();
  registerViewer(s, viewer as unknown as WebSocket, 0, () => {});
  const text = Buffer.from('日本語🙂\x1b[38;2;10;20;30m色\x1b[0m');
  for (let i = 0; i < text.length; i++) append(s, text.subarray(i, i + 1), 5);
  await wait(25);
  assert.deepEqual(Buffer.concat(viewer.frames), text);
});

test('large bursts flush without waiting for the timer', (t) => {
  const s = session();
  t.after(() => cancelOutputFlush(s));
  const viewer = new FakeSocket();
  registerViewer(s, viewer as unknown as WebSocket, 0, () => {});
  append(s, Buffer.alloc(70 * 1024, 0x41), 1000);
  assert.equal(viewer.frames.length, 1);
});

test('hidden viewers receive nothing and catch up with exactly the missed bytes', async (t) => {
  const s = session();
  t.after(() => cancelOutputFlush(s));
  const shown = new FakeSocket();
  const hidden = new FakeSocket();
  registerViewer(s, shown as unknown as WebSocket, 0, () => {});
  registerViewer(s, hidden as unknown as WebSocket, 0, () => {});
  append(s, 'before|');
  await wait(30);
  setViewerVisible(s, hidden as unknown as WebSocket, false);
  for (let n = 0; n < 20; n++) append(s, `frame${n}|`);
  await wait(30);
  assert.equal(hidden.frames.length, 1, 'hidden viewer got only pre-hide output');
  assert.ok(shown.frames.length >= 2);
  setViewerVisible(s, hidden as unknown as WebSocket, true);
  assert.equal(hidden.frames.length, 2, 'becoming visible replays immediately in one frame');
  assert.deepEqual(Buffer.concat(hidden.frames), Buffer.concat(shown.frames));
  assert.equal(viewerState(hidden as unknown as WebSocket)?.sentOffset, s.bufferLength);
});

test('a hidden viewer whose missed output was trimmed is resynchronized from a snapshot', async (t) => {
  const s = session();
  t.after(() => cancelOutputFlush(s));
  const viewer = new FakeSocket();
  let resyncs = 0;
  registerViewer(s, viewer as unknown as WebSocket, 0, () => { resyncs++; });
  setViewerVisible(s, viewer as unknown as WebSocket, false);
  append(s, 'old output');
  await wait(30);
  // Simulate the ring buffer dropping the bytes the hidden viewer missed.
  s.bufferBase = 10; s.bufferChunks = [Buffer.from('new')]; s.bufferLength = 3;
  setViewerVisible(s, viewer as unknown as WebSocket, true);
  assert.equal(resyncs, 1);
  assert.equal(viewer.frames.length, 0, 'no frame joins across a gap');
  assert.equal(viewerState(viewer as unknown as WebSocket)?.resyncing, true);
});

test('a viewer returning after a very long redraw stream gets a snapshot instead of a replay', async (t) => {
  const s = session();
  t.after(() => cancelOutputFlush(s));
  const viewer = new FakeSocket();
  let resyncs = 0;
  registerViewer(s, viewer as unknown as WebSocket, 0, () => { resyncs++; });
  setViewerVisible(s, viewer as unknown as WebSocket, false);
  for (let n = 0; n < 5; n++) append(s, Buffer.alloc(60 * 1024, 0x42), 5);
  await wait(20);
  setViewerVisible(s, viewer as unknown as WebSocket, true);
  assert.equal(resyncs, 1);
  assert.equal(viewer.frames.length, 0);
});

test('resize barriers include hidden viewers and slow viewers are evicted', () => {
  const s = session();
  const hidden = new FakeSocket();
  const slow = new FakeSocket();
  registerViewer(s, hidden as unknown as WebSocket, 0, () => {});
  registerViewer(s, slow as unknown as WebSocket, 0, () => {});
  setViewerVisible(s, hidden as unknown as WebSocket, false);
  slow.bufferedAmount = 2 * 1024 * 1024;
  s.bufferChunks = [Buffer.from('pre-resize')]; s.bufferLength = 10;
  flushOutput(s, undefined, true);
  assert.deepEqual(hidden.frames.map(String), ['pre-resize']);
  assert.equal(slow.closed, 1009);
  assert.ok(!s.sockets.has(slow as unknown as WebSocket));
});
