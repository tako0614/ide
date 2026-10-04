import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TerminalSnapshot } from '../dist/terminal/snapshot.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const snapshotWrite = (snapshot, data) => new Promise((resolve) => snapshot.write(data, resolve));

function makeTerminal(cols, rows) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  const unicode = new Unicode11Addon();
  terminal.loadAddon(unicode);
  terminal.unicode.activeVersion = '11';
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  return { terminal, serializer };
}

for (const [name, prefix, suffix] of [
  ['UTF-8', Buffer.from([0xe6]), Buffer.from([0x97, 0xa5])],
  ['emoji UTF-8', Buffer.from([0xf0, 0x9f]), Buffer.from([0x98, 0x80])],
  ['CSI', Buffer.from('\x1b['), Buffer.from('2;1HCSI')],
  ['OSC', Buffer.from('\x1b]0;TITLE'), Buffer.from('\x07OSC')],
  ['CSI C0', Buffer.from('\x1b[\n'), Buffer.from('2;1HCSI')],
  ['DCS BEL', Buffer.from('\x1bP$q\x07'), Buffer.from('m\x1b\\DCS')],
  ['DCS', Buffer.from('\x1bP$q'), Buffer.from('m\x1b\\DCS')],
]) {
  test(`snapshot restores incomplete ${name}`, async () => {
    const host = makeTerminal(20, 5);
    const clone = makeTerminal(20, 5);
    const snapshot = new TerminalSnapshot({ cols: 20, rows: 5 });
    try {
      await write(host.terminal, prefix);
      await snapshotWrite(snapshot, prefix);
      const captured = await snapshot.capture();
      assert.equal(captured.offset, prefix.length);
      await write(clone.terminal, captured.data);

      await write(host.terminal, suffix);
      await snapshotWrite(snapshot, suffix);
      await write(clone.terminal, suffix);
      assert.equal(clone.serializer.serialize(), host.serializer.serialize());
    } finally {
      await snapshot.dispose();
      host.terminal.dispose();
      clone.terminal.dispose();
    }
  });
}

test('snapshot orders alternate-screen Unicode output around a resize', async () => {
  const host = makeTerminal(100, 30);
  const clone = makeTerminal(100, 30);
  const snapshot = new TerminalSnapshot({ cols: 100, rows: 30 });
  const callbacks = [];
  const beforeResize = Buffer.from('\x1b[?1049h\x1b[2J\x1b[HCLI TUI 日本語 😀');
  const afterResize = Buffer.from('\x1b[4;1HAFTER RESIZE');
  try {
    await write(host.terminal, beforeResize);
    const first = new Promise((resolve) => snapshot.write(beforeResize, () => { callbacks.push('first'); resolve(); }));
    const resize = snapshot.resize(40, 18, () => callbacks.push('resize'));
    assert.deepEqual(resize, { offset: beforeResize.length, sequence: 2 });
    host.terminal.resize(40, 18);
    await write(host.terminal, afterResize);
    const last = new Promise((resolve) => snapshot.write(afterResize, () => { callbacks.push('last'); resolve(); }));
    await Promise.all([first, last]);

    const captured = await snapshot.capture();
    assert.equal(captured.offset, beforeResize.length + afterResize.length);
    assert.equal(captured.sequence, 3);
    assert.equal(captured.cols, 40);
    assert.equal(captured.rows, 18);
    assert.deepEqual(callbacks, ['first', 'resize', 'last']);
    clone.terminal.resize(captured.cols, captured.rows);
    await write(clone.terminal, captured.data);
    assert.equal(clone.terminal.cols, host.terminal.cols);
    assert.equal(clone.terminal.rows, host.terminal.rows);
    assert.equal(clone.serializer.serialize(), host.serializer.serialize());
    assert.equal(clone.terminal.buffer.active.cursorX, host.terminal.buffer.active.cursorX);
    assert.equal(clone.terminal.buffer.active.cursorY, host.terminal.buffer.active.cursorY);
  } finally {
    await snapshot.dispose();
    host.terminal.dispose();
    clone.terminal.dispose();
  }
});

test('capture does not generate terminal query responses', async () => {
  const responses = [];
  const snapshot = new TerminalSnapshot({ cols: 20, rows: 5, onResponse: (data) => responses.push(data) });
  try {
    await snapshotWrite(snapshot, Buffer.from('\x1b[6n'));
    assert.ok(responses.length > 0, 'headless xterm should answer a live DSR query');
    const responseCount = responses.length;
    await snapshot.capture();
    assert.equal(responses.length, responseCount);
  } finally {
    await snapshot.dispose();
  }
});

test('a failed publish callback fails future captures once without an unhandled rejection', async () => {
  const failure = new Error('fixture publish failed');
  const failures = [];
  const snapshot = new TerminalSnapshot({ cols: 20, rows: 5, onFailure: (error) => failures.push(error) });
  try {
    snapshot.write(Buffer.from('ready'), () => { throw failure; });
    await assert.rejects(() => snapshot.capture(), (error) => error === failure);
    assert.deepEqual(failures, [failure]);
    await assert.rejects(() => snapshot.capture(), (error) => error === failure);
    assert.deepEqual(failures, [failure]);
  } finally {
    await snapshot.dispose();
  }
});
