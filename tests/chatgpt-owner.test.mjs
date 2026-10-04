import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ChatgptOwner } from '../src/computer/chatgpt-owner.ts';

const DEFAULT_DESCRIPTOR = '/root/dev/deckide-chatgpt-20261004/app-session.json';
const SESSION_ID = 'a'.repeat(32);

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
  }
  finish(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
  kill(signal) {
    this.signals.push(signal);
    this.finish(null, signal);
    return true;
  }
}

function fixture(options = {}) {
  const child = new FakeChild(50001);
  const stop = new FakeChild(50002);
  const calls = [];
  const identity = { pid: child.pid, start: 12345, uid: 0, gid: 0,
    ppid: process.pid, state: 'S' };
  let observed = identity;
  let snapshot = { lifecycleMode: 'deckide-owned', sessionId: SESSION_ID,
    expiresEpochMs: Date.now() + 10_000 };
  const lease = { check: () => snapshot };
  let binding = { sessionId: SESSION_ID, ownerPid: process.pid, supervisor: identity };
  const deps = {
    spawn(command, args, settings) {
      calls.push({ command, args, settings });
      if (args[0] === 'stop') {
        if (options.stopCode !== undefined) queueMicrotask(() => stop.finish(options.stopCode));
        return stop;
      }
      return child;
    },
    verifyLauncher: () => undefined,
    verifyStateRoot: () => undefined,
    processIdentity: () => observed,
    loadLease: async () => {
      if (options.loadError) throw new Error('private-secret-' + options.loadError);
      return lease;
    },
    readBinding: () => binding,
    readyTimeoutMs: 100,
    closeTimeoutMs: 100,
  };
  const owner = new ChatgptOwner(options.stateRoot, deps);
  const ready = (descriptor = DEFAULT_DESCRIPTOR) => child.stdout.write(descriptor + '\n');
  return { owner, child, stop, calls, ready, lease, identity,
    setIdentity(value) { observed = value; },
    setSnapshot(value) { snapshot = value; },
    setBinding(value) { binding = value; } };
}

test('concurrent start coalesces one direct foreground child with minimal environment', async () => {
  const f = fixture();
  const first = f.owner.start();
  const second = f.owner.start();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ['run', '--lifecycle', 'deckide-owned']);
  assert.match(f.calls[0].command, /\/ops\/chatgpt-launcher\/product\/launch-chatgpt\.sh$/);
  assert.deepEqual(f.calls[0].settings, { shell: false, detached: false,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'ignore'] });
  f.ready();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.lease, f.lease);
  assert.equal(b.lease, f.lease);
  assert.equal((await f.owner.start()).snapshot.sessionId, SESSION_ID);
  assert.equal(f.calls.length, 1);
});

test('explicit trusted state-root override is the only added child environment value', async () => {
  const f = fixture({ stateRoot: '/root/disposable-private-state' });
  const started = f.owner.start();
  assert.deepEqual(f.calls[0].settings.env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    CHATGPT_LAUNCHER_STATE_ROOT: '/root/disposable-private-state' });
  f.ready('/root/disposable-private-state/app-session.json');
  await started;
});

test('wrong or excessive stdout and private loader errors fail with no secret text', async () => {
  for (const variant of ['wrong', 'large', 'loader']) {
    const f = fixture({ loadError: variant === 'loader' ? 'hidden' : undefined });
    const started = f.owner.start();
    if (variant === 'wrong') f.ready('/tmp/foreign/app-session.json');
    else if (variant === 'large') f.child.stdout.write('x'.repeat(2048));
    else f.ready();
    await assert.rejects(started, (error) => {
      assert.equal(error.message, 'ChatGPT desktop ownership could not be verified');
      assert.doesNotMatch(error.stack, /private-secret|foreign/);
      return true;
    });
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    assert.equal(f.calls.length, 1);
  }
});

test('v1, changed generation, wrong binding and failed lease are denied', async () => {
  for (const variant of ['v1', 'generation', 'binding', 'failed']) {
    const f = fixture();
    if (variant === 'v1') f.setSnapshot({ lifecycleMode: 'bounded', sessionId: SESSION_ID });
    if (variant === 'generation') f.setSnapshot({ lifecycleMode: 'deckide-owned', sessionId: 'b'.repeat(32) });
    if (variant === 'binding') f.setBinding({ sessionId: SESSION_ID,
      ownerPid: process.pid, supervisor: { ...f.identity, start: 12346 } });
    if (variant === 'failed') f.lease.check = () => { throw new Error('private authority'); };
    const started = f.owner.start();
    f.ready();
    await assert.rejects(started, /ownership could not be verified/);
    assert.deepEqual(f.child.signals, ['SIGTERM']);
  }
});

test('uncertain retained child identity prevents failure cleanup signal', async () => {
  const f = fixture();
  const started = f.owner.start();
  f.setIdentity({ ...f.identity, start: 99999 });
  f.ready('/tmp/foreign/app-session.json');
  await assert.rejects(started, /ownership could not be verified/);
  assert.deepEqual(f.child.signals, []);
});

test('missing or unverifiable spawned PID consumes later errors without signalling an unknown child', async () => {
  for (const variant of ['missing', 'unverified']) {
    const f = fixture();
    if (variant === 'missing') f.child.pid = undefined;
    else f.setIdentity(null);
    await assert.rejects(f.owner.start(), /ownership could not be verified/);
    assert.doesNotThrow(() => f.child.emit('error', new Error('private-secret-spawn-error')));
    assert.deepEqual(f.child.signals, []);
    assert.equal(f.calls.length, 1);
  }
});

test('lowercase dead process state and late excess stdout revoke reuse', async () => {
  const dead = fixture();
  const first = dead.owner.start();
  dead.ready();
  await first;
  dead.setIdentity({ ...dead.identity, state: 'x' });
  await assert.rejects(dead.owner.start(), /ownership could not be verified/);
  const noisy = fixture();
  const second = noisy.owner.start();
  noisy.ready();
  await second;
  noisy.child.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120));
  await assert.rejects(noisy.owner.start(), /ownership could not be verified/);
  assert.equal(noisy.calls.length, 1);
});

test('graceful close uses one guarded stop then waits for retained child exit', async () => {
  const f = fixture({ stopCode: 0 });
  const started = f.owner.start();
  f.ready();
  await started;
  const closing = f.owner.close();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].args, ['stop', '--session-id', SESSION_ID]);
  assert.deepEqual(f.calls[1].settings, { shell: false, detached: false,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'ignore'] });
  queueMicrotask(() => f.child.finish(0));
  await closing;
  assert.deepEqual(f.child.signals, []);
  await f.owner.close();
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.owner.start(), /ownership could not be verified/);
});

test('an already exited foreground child cannot make close succeed or start a replacement', async () => {
  for (const [code, signal] of [[0, null], [1, null], [null, 'SIGKILL']]) {
    const f = fixture();
    const started = f.owner.start();
    f.ready();
    await started;
    f.child.finish(code, signal);
    await assert.rejects(f.owner.close(), /ownership could not be verified/);
    await assert.rejects(f.owner.close(), /ownership could not be verified/);
    await assert.rejects(f.owner.start(), /ownership could not be verified/);
    assert.equal(f.calls.length, 1);
  }
});

test('a successful guarded stop still requires normal supervisor exit', async () => {
  for (const [code, signal] of [[1, null], [null, 'SIGKILL']]) {
    const f = fixture({ stopCode: 0 });
    const started = f.owner.start();
    f.ready();
    await started;
    const closing = f.owner.close();
    f.child.finish(code, signal);
    await assert.rejects(closing, /ownership could not be verified/);
    await assert.rejects(f.owner.close(), /ownership could not be verified/);
    await assert.rejects(f.owner.start(), /ownership could not be verified/);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1].args, ['stop', '--session-id', SESSION_ID]);
  }
});

test('changed lease or stale stop failure never retries or adopts another generation', async () => {
  for (const variant of ['lease', 'stop']) {
    const f = fixture({ stopCode: variant === 'stop' ? 1 : undefined });
    const started = f.owner.start();
    f.ready();
    await started;
    if (variant === 'lease') f.setSnapshot({ lifecycleMode: 'deckide-owned', sessionId: 'b'.repeat(32) });
    await assert.rejects(f.owner.close(), /ownership could not be verified/);
    assert.equal(f.calls.length, variant === 'lease' ? 1 : 2);
    assert.deepEqual(f.child.signals, []);
    await assert.rejects(f.owner.close(), /ownership could not be verified/);
    assert.equal(f.calls.length, variant === 'lease' ? 1 : 2);
  }
});

test('unexpected foreground exit is latched and never restarts automatically', async () => {
  const f = fixture();
  const started = f.owner.start();
  f.ready();
  await started;
  f.child.finish(1);
  await assert.rejects(f.owner.start(), /ownership could not be verified/);
  assert.equal(f.calls.length, 1);
});
