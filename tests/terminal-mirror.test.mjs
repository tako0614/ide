import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalMirror } from '../dist/utils/terminal-mirror.js';

function mirrorWithOffset(cols, rows, scrollback) {
  let offset = 0;
  const mirror = createTerminalMirror({ cols, rows, scrollback, currentOffset: () => offset });
  return {
    mirror,
    write(text) {
      const bytes = Buffer.from(text, 'utf8');
      offset += bytes.length;
      mirror.write(bytes);
    },
  };
}

test('snapshot reflects resizes queued behind earlier output', async (t) => {
  const { mirror, write } = mirrorWithOffset(40, 10, 100);
  t.after(() => mirror.dispose());
  write('\x1b]0;my title\x07hello\r\n');
  mirror.resize(20, 5);
  write('after');
  const snap = await mirror.snapshot();
  assert.deepEqual([snap.cols, snap.rows], [20, 5]);
  assert.match(snap.data, /hello/);
  assert.match(snap.data, /after/);
  assert.equal(snap.offset, Buffer.byteLength('\x1b]0;my title\x07hello\r\nafter'));
  assert.equal(mirror.title(), 'my title');
});

test('an oversized snapshot drops scrollback but keeps the screen', async (t) => {
  const { mirror, write } = mirrorWithOffset(400, 30, 3000);
  t.after(() => mirror.dispose());
  // Every cell a different colour: the serializer emits an SGR per cell.
  const line = Array.from({ length: 400 }, (_, i) => `\x1b[38;5;${i % 256}mx`).join('') + '\x1b[0m\r\n';
  for (let n = 0; n < 2000; n++) write(line);
  write('LAST-LINE');
  const snap = await mirror.snapshot();
  assert.ok(Buffer.byteLength(snap.data) <= 512 * 1024, `snapshot is ${Buffer.byteLength(snap.data)} bytes`);
  assert.match(snap.data, /LAST-LINE/);
});

test('garbage output is parsed silently (no server log flood)', async (t) => {
  const { mirror, write } = mirrorWithOffset(80, 24, 100);
  t.after(() => mirror.dispose());
  const logged = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const name of Object.keys(originals)) console[name] = (...args) => logged.push(args);
  try {
    let seed = 7;
    const bytes = Buffer.alloc(256 * 1024);
    for (let i = 0; i < bytes.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; bytes[i] = seed & 0xff; }
    write(bytes.toString('latin1'));
    await mirror.snapshot();
  } finally {
    Object.assign(console, originals);
  }
  assert.equal(logged.length, 0, `mirror logged ${logged.length} lines`);
});
