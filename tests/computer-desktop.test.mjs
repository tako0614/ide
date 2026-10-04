import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DesktopComputer, desktopInputCommands } from '../src/computer/desktop.ts';

test('input validation rejects option injection and validates a whole drag before execution', () => {
  assert.deepEqual(desktopInputCommands({ action: 'type', text: '--help' }),
    [['type', '--clearmodifiers', '--delay', '1', '--', '--help']]);
  assert.deepEqual(desktopInputCommands({ action: 'key', key: 'Ctrl+L' }),
    [['key', '--clearmodifiers', '--', 'ctrl+l']]);
  assert.throws(() => desktopInputCommands({ action: 'key', key: '--help' }), /Invalid key/);
  assert.throws(() => desktopInputCommands({ action: 'key', key: 'Ctrl+Alt+Shift+Super+Meta+L' }), /Invalid key/);
  assert.throws(() => desktopInputCommands({ action: 'drag', x: 1, y: 1, toX: 960, toY: 1 }),
    /Coordinates are outside/);
  assert.throws(() => desktopInputCommands({ action: 'scroll', direction: 'down', steps: 11 }),
    /Scroll steps/);
  assert.deepEqual(desktopInputCommands({ action: 'click', x: 959, y: 539 }),
    [['mousemove', '--sync', '1279', '719', 'click', '1']]);
});

test('native desktop isolates state, binds observations, bounds apps, and cleans up', async (t) => {
  const computer = new DesktopComputer();
  const initial = await computer.status();
  if (!initial.supported) return t.skip(initial.message ?? 'Native Linux X11 tools unavailable');
  const sentinel = process.env.DECKIDE_COMPUTER_TEST_SECRET;
  process.env.DECKIDE_COMPUTER_TEST_SECRET = 'private-sentinel';
  let dir;
  try {
    const preparation = computer.prepare();
    await assert.rejects(computer.prepare(), /Desktop is busy/);
    assert.equal((await preparation).running, true);
    dir = computer.runtime.dir;
    const xvfbPid = computer.runtime.xvfb.pid;
    assert.ok(dir.startsWith(os.tmpdir() + path.sep));
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dir, 'Xauthority'))).mode & 0o777, 0o600);
    assert.equal(computer.runtime.env.DECKIDE_COMPUTER_TEST_SECRET, undefined);
    assert.equal(computer.runtime.env.WAYLAND_DISPLAY, undefined);

    const first = await computer.screenshot('actor-a');
    assert.equal(first.width, 960);
    assert.equal(first.height, 540);
    assert.equal(first.image.mimeType, 'image/jpeg');
    assert.ok(Buffer.from(first.image.data, 'base64').length < 3 * 1024 * 1024);
    await assert.rejects(computer.input('actor-b', {
      observationId: first.observationId, action: 'click', x: 2, y: 2,
    }), /fresh screenshot/);
    await assert.rejects(computer.input('actor-a', {
      observationId: first.observationId, action: 'drag', x: 2, y: 2, toX: 960, toY: 3,
    }), /Coordinates are outside/);
    // Invalid actions do not consume a valid observation. A successful action
    // consumes it and invalidates all actors' observations of the old screen.
    const peer = await computer.screenshot('actor-b');
    assert.deepEqual(await computer.input('actor-a', {
      observationId: first.observationId, action: 'click', x: 2, y: 2,
    }), { executed: true, requiresObservation: true });
    await assert.rejects(computer.input('actor-b', {
      observationId: peer.observationId, action: 'key', key: 'Enter',
    }), /fresh screenshot/);
    const unchanged = await computer.screenshot('actor-a', first.hash);
    assert.equal(unchanged.unchanged, true);
    assert.equal('image' in unchanged, false);
    assert.notEqual(unchanged.observationId, first.observationId);
    computer.observations.get(unchanged.observationId).createdAt -= 31_000;
    await assert.rejects(computer.input('actor-a', {
      observationId: unchanged.observationId, action: 'key', key: 'Enter',
    }), /fresh screenshot/);

    for (let index = 0; index < 4; index++) {
      assert.equal((await computer.launch({ app: 'terminal' })).running, true);
    }
    await assert.rejects(computer.launch({ app: 'terminal' }), /app limit/);
    assert.equal((await computer.stop()).running, false);
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
    await assert.rejects(computer.screenshot('actor-a'), /Prepare the desktop first/);
    assert.equal((await computer.status()).running, false);
    assert.equal(computer.owned.size, 0);
    await assert.rejects(fs.stat(`/proc/${xvfbPid}`), { code: 'ENOENT' });
  } finally {
    await computer.stop().catch(() => undefined);
    if (sentinel === undefined) delete process.env.DECKIDE_COMPUTER_TEST_SECRET;
    else process.env.DECKIDE_COMPUTER_TEST_SECRET = sentinel;
  }
});

test('shutdown during prepare still reclaims the private display', async (t) => {
  const computer = new DesktopComputer();
  if (!(await computer.status()).supported) return t.skip('Native Linux X11 tools unavailable');
  const preparing = computer.prepare();
  const shutdown = computer.shutdown();
  await shutdown;
  await assert.rejects(preparing, /stopped|shutting down/);
  assert.equal((await computer.status()).running, false);
  assert.equal(computer.owned.size, 0);
  assert.equal(computer.preparingDir, null);
});

test('shutdown during capture kills the display and rejects further work', async (t) => {
  const computer = new DesktopComputer();
  if (!(await computer.status()).supported) return t.skip('Native Linux X11 tools unavailable');
  await computer.prepare();
  const dir = computer.runtime.dir;
  const xvfbPid = computer.runtime.xvfb.pid;
  const capture = computer.screenshot('actor').catch(() => undefined);
  await computer.shutdown();
  await capture;
  assert.equal((await computer.status()).running, false);
  assert.equal(computer.owned.size, 0);
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`/proc/${xvfbPid}`), { code: 'ENOENT' });
  await assert.rejects(computer.prepare(), /shutting down/);
});

test('unexpected Xvfb death cleans its desktop and permits fresh preparation', async (t) => {
  const computer = new DesktopComputer();
  if (!(await computer.status()).supported) return t.skip('Native Linux X11 tools unavailable');
  try {
    await computer.prepare();
    const dir = computer.runtime.dir;
    process.kill(computer.runtime.xvfb.pid, 'SIGKILL');
    const deadline = Date.now() + 3_000;
    while ((await computer.status()).running && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await computer.status()).running, false);
    while (computer.pendingCleanup && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(computer.pendingCleanup, null);
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
    assert.equal((await computer.prepare()).running, true);
  } finally { await computer.shutdown(); }
});

test('Xvfb exit between readiness and registration cannot report running', async (t) => {
  const computer = new DesktopComputer();
  if (!(await computer.status()).supported) return t.skip('Native Linux X11 tools unavailable');
  const originalReadFile = fs.readFile;
  let injected = false;
  fs.readFile = async (...args) => {
    const result = await originalReadFile(...args);
    if (!injected && /^\/tmp\/\.X\d+-lock$/.test(String(args[0]))) {
      const xvfb = [...computer.owned].find((entry) => entry.role === 'desktop')?.process;
      assert.ok(xvfb?.pid);
      injected = true;
      const exited = new Promise((resolve) => xvfb.once('exit', resolve));
      process.kill(xvfb.pid, 'SIGKILL');
      await exited;
    }
    return result;
  };
  try {
    await assert.rejects(computer.prepare(), /X11 display exited during preparation/);
    assert.equal(injected, true);
    assert.equal((await computer.status()).running, false);
  } finally {
    fs.readFile = originalReadFile;
    await computer.shutdown();
  }
});

test('root process refuses unsandboxed browser launch', async (t) => {
  if (process.getuid?.() !== 0) return t.skip('Applies only to root process');
  const computer = new DesktopComputer();
  if (!(await computer.status()).supported) return t.skip('Native Linux X11 tools unavailable');
  try {
    await computer.prepare();
    await assert.rejects(computer.launch({ app: 'browser', url: 'https://example.com/' }),
      /non-root DeckIDE process/);
  } finally { await computer.stop(); }
});
