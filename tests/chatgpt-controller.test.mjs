import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ChatgptController } from '../src/computer/chatgpt-controller.ts';

const SESSION_ID = 'a'.repeat(32);
const readyStatus = { running: true, transport: 'private-rfb' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, options = {}) {
  const root = path.join(process.cwd(), 'tmp');
  await fs.mkdir(root, { recursive: true });
  const producer = await fs.mkdtemp(path.join(root, 'chatgpt-controller-'));
  t.after(() => fs.rm(producer, { recursive: true, force: true }));
  const events = [];
  const snapshot = { lifecycleMode: 'deckide-owned', sessionId: SESSION_ID };
  const lease = { check: () => snapshot };
  const owner = {
    starts: 0, closes: 0,
    async start() {
      this.starts++;
      events.push('owner.start');
      if (options.startGate) await options.startGate.promise;
      if (options.startError) throw new Error('private start detail');
      return { lease, snapshot };
    },
    async close() {
      this.closes++;
      events.push('owner.close');
      if (options.ownerCloseError) throw new Error('private stop detail');
    },
  };
  const desktop = {
    attached: null, attaches: 0, detaches: 0, path: null,
    async attachBorrowedDesktop(candidate, dir, framebuffer) {
      this.attaches++;
      this.path = dir;
      this.framebuffer = framebuffer;
      events.push('desktop.attach');
      if (options.attachGate) await options.attachGate.promise;
      if (options.attachError) throw new Error('private attach detail');
      this.attached = candidate;
      return readyStatus;
    },
    async detachBorrowedDesktop(candidate) {
      this.detaches++;
      events.push('desktop.detach');
      if (options.detachError) throw new Error('private detach detail');
      if (this.attached === candidate) this.attached = null;
    },
    async status() {
      events.push('desktop.status');
      return this.attached ? readyStatus : { running: false, transport: 'sampled-jpeg' };
    },
  };
  return { producer, events, owner, desktop, lease, snapshot,
    controller: new ChatgptController(owner, desktop, producer,
      options.framebuffer ?? { width: 1440, height: 960 }) };
}

test('construction is inert and concurrent explicit prepare shares one owner and attach', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { startGate: gate });
  assert.deepEqual(f.events, []);
  const first = f.controller.prepare();
  const second = f.controller.prepare();
  assert.equal(first, second);
  assert.equal(f.owner.starts, 1);
  gate.resolve();
  assert.equal((await first).transport, 'private-rfb');
  assert.equal(f.desktop.attaches, 1);
  assert.equal(f.desktop.path, f.producer);
  assert.deepEqual(f.desktop.framebuffer, { width: 1440, height: 960 });
  await assert.rejects(f.controller.prepare(), /generation is unavailable/);
  assert.equal(f.owner.starts, 1, 'later prepare cannot adopt or restart a generation');
});

test('trusted geometry is snapshotted before an asynchronous owned prepare', async (t) => {
  const framebuffer = { width: 1440, height: 960 };
  const f = await fixture(t, { framebuffer });
  framebuffer.width = 1280;
  framebuffer.height = 720;
  await f.controller.prepare();
  assert.deepEqual(f.desktop.framebuffer, { width: 1440, height: 960 });
  assert.equal(Object.isFrozen(f.desktop.framebuffer), true);
});

test('v1 and malformed owner lease are refused before attaching', async (t) => {
  for (const variant of ['v1', 'id']) {
    const f = await fixture(t);
    f.lease.check = () => variant === 'v1'
      ? { lifecycleMode: 'bounded', sessionId: SESSION_ID }
      : { lifecycleMode: 'deckide-owned', sessionId: 'wrong' };
    await assert.rejects(f.controller.prepare(), /generation is unavailable/);
    assert.equal(f.desktop.attaches, 0);
    assert.equal(f.owner.closes, 1);
    await assert.rejects(f.controller.prepare(), /generation is unavailable/);
    assert.equal(f.owner.starts, 1);
  }
});

test('busy foreign desktop is never stopped when owned attach fails', async (t) => {
  const f = await fixture(t, { attachError: true });
  const foreign = { foreign: true };
  f.desktop.attached = foreign;
  await assert.rejects(f.controller.prepare(), /generation is unavailable/);
  assert.equal(f.desktop.attached, foreign);
  assert.equal(f.desktop.detaches, 1);
  assert.equal(f.owner.closes, 1);
  assert.deepEqual(f.events, ['owner.start', 'desktop.attach', 'desktop.detach', 'owner.close']);
});

test('a changed lease after attach is detached and cannot be reused', async (t) => {
  const f = await fixture(t);
  let checks = 0;
  f.lease.check = () => ++checks === 1 ? f.snapshot
    : { lifecycleMode: 'deckide-owned', sessionId: 'b'.repeat(32) };
  await assert.rejects(f.controller.prepare(), /generation is unavailable/);
  assert.equal(f.desktop.detaches, 1);
  assert.equal(f.owner.closes, 1);
  assert.equal(f.desktop.attached, null);
  await assert.rejects(f.controller.prepare(), /generation is unavailable/);
  assert.equal(f.owner.starts, 1);
});

test('explicit close detaches its lease before guarded owner close', async (t) => {
  const f = await fixture(t);
  await f.controller.prepare();
  const status = await f.controller.close();
  assert.equal(status.running, false);
  assert.deepEqual(f.events, ['owner.start', 'desktop.attach', 'desktop.detach',
    'owner.close', 'desktop.status']);
  assert.equal(f.desktop.attached, null);
  await assert.rejects(f.controller.prepare(), /generation is unavailable/);
});

test('foreign replacement is retained during close; no foreign lease is adopted', async (t) => {
  const f = await fixture(t);
  await f.controller.prepare();
  const foreign = { check: () => ({ lifecycleMode: 'bounded' }) };
  f.desktop.attached = foreign;
  const status = await f.controller.close();
  assert.equal(status.running, true);
  assert.equal(f.desktop.attached, foreign);
  assert.equal(f.owner.closes, 1);
  assert.equal(f.desktop.detaches, 1);
});

test('close during pending attach waits, then detaches before owner close', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { attachGate: gate });
  const preparing = f.controller.prepare();
  assert.deepEqual(f.events, ['owner.start']);
  await Promise.resolve();
  assert.deepEqual(f.events, ['owner.start', 'desktop.attach']);
  const closing = f.controller.close();
  gate.resolve();
  await assert.rejects(preparing, /generation is unavailable/);
  await closing;
  assert.deepEqual(f.events, ['owner.start', 'desktop.attach', 'desktop.detach',
    'owner.close', 'desktop.status']);
});

test('detach failure prevents owner close and close is never retried', async (t) => {
  const f = await fixture(t, { detachError: true });
  await f.controller.prepare();
  const closing = f.controller.close();
  await assert.rejects(closing, /generation is unavailable/);
  await assert.rejects(f.controller.close(), /generation is unavailable/);
  assert.equal(f.desktop.detaches, 1);
  assert.equal(f.owner.closes, 0);
  await assert.rejects(f.controller.prepare(), /generation is unavailable/);
});

test('owner close failure is retained without a replacement or retry', async (t) => {
  const f = await fixture(t, { ownerCloseError: true });
  await f.controller.prepare();
  await assert.rejects(f.controller.shutdown(), /generation is unavailable/);
  assert.equal(f.desktop.detaches, 1);
  assert.equal(f.owner.closes, 1);
  await assert.rejects(f.controller.close(), /generation is unavailable/);
  assert.equal(f.owner.closes, 1);
  assert.equal(f.owner.starts, 1);
});

test('failed prepare caches teardown and a later close does not retry owner stop', async (t) => {
  const f = await fixture(t, { attachError: true, ownerCloseError: true });
  await assert.rejects(f.controller.prepare(), /generation is unavailable/);
  assert.equal(f.owner.closes, 1);
  await assert.rejects(f.controller.close(), /generation is unavailable/);
  assert.equal(f.desktop.detaches, 1);
  assert.equal(f.owner.closes, 1);
  assert.equal(f.owner.starts, 1);
});
