import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCanonicalTerminalFrame,
  createTerminalReplayAccounting,
  normalizeTerminalPointerPoint,
  terminalCellAtPoint
} from '../web/src/components/terminalFrame.ts';

test('viewport and font changes only alter local frame geometry', () => {
  const frame = createCanonicalTerminalFrame(120, 32);
  const before = frame.getSize();
  const compact = frame.layout(8, 16, { width: 720, height: 300 });
  const largerFont = frame.layout(11, 22, { width: 900, height: 420 });
  const hidden = frame.layout(11, 22, { width: 0, height: 0 });

  assert.deepEqual(before, { cols: 120, rows: 32 });
  assert.deepEqual(frame.getSize(), before);
  assert.deepEqual([compact.cols, compact.rows], [120, 32]);
  assert.deepEqual([largerFont.cols, largerFont.rows], [120, 32]);
  assert.ok(compact.scale > 0 && largerFont.scale > 0);
  assert.equal(hidden.scale, 0);
  assert.equal(hidden.width, 0);
  assert.equal(hidden.height, 0);
  assert.deepEqual(frame.getSize(), before, 'hidden zero-size views do not produce a PTY resize');
});

test('uniform scaling preserves Japanese wide-cell pointer geometry', () => {
  const frame = createCanonicalTerminalFrame(120, 32);
  const layouts = [
    frame.layout(8, 16, { width: 500, height: 260 }),
    frame.layout(12, 24, { width: 960, height: 520 })
  ];

  for (const layout of layouts) {
    const scale = layout.scale;
    const padding = layout.padding * scale;
    // A Japanese glyph occupies columns 14 and 15. A pointer in its second
    // cell must resolve to column 15 after either local scale is applied.
    const point = {
      x: padding + (15.25 * layout.cellWidth * scale),
      y: padding + (7.5 * layout.cellHeight * scale)
    };
    assert.deepEqual(terminalCellAtPoint(point.x, point.y, layout), { col: 15, row: 7 });
  }
});

test('scaled pointer coordinates match xterm cell and selection calculations', () => {
  const screenOrigin = { left: 37, top: 91 };
  const cellWidth = 8;
  const cellHeight = 16;
  const unscaledPoint = { x: 15.25 * cellWidth, y: 7.5 * cellHeight };

  for (const scale of [0.35, 0.72, 1]) {
    const scaledPoint = {
      x: screenOrigin.left + unscaledPoint.x * scale,
      y: screenOrigin.top + unscaledPoint.y * scale
    };
    const normalized = normalizeTerminalPointerPoint(
      scaledPoint.x,
      scaledPoint.y,
      screenOrigin,
      scale
    );
    const localX = normalized.clientX - screenOrigin.left;
    const localY = normalized.clientY - screenOrigin.top;

    // Match xterm's getCoords math: floor for mouse reporting, ceil with a
    // half-cell offset for text selection. Both stay on the same cell.
    assert.deepEqual(
      [Math.floor(localX / cellWidth), Math.floor(localY / cellHeight)],
      [15, 7]
    );
    assert.deepEqual(
      [Math.ceil((localX + cellWidth / 2) / cellWidth), Math.ceil(localY / cellHeight)],
      [16, 8]
    );
  }
});

test('only an explicit server size changes the canonical cell grid', () => {
  const frame = createCanonicalTerminalFrame(120, 32);
  frame.layout(9, 18, { width: 720, height: 360 });
  frame.layout(13, 26, { width: 400, height: 220 });
  assert.equal(frame.applyServerSize(0, 40), null);
  assert.equal(frame.applyServerSize(120, 32), null);
  assert.deepEqual(frame.getSize(), { cols: 120, rows: 32 });

  assert.deepEqual(frame.applyServerSize(100, 28), { cols: 100, rows: 28 });
  assert.deepEqual(frame.getSize(), { cols: 100, rows: 28 });
  assert.deepEqual(
    [frame.layout(9, 18, { width: 720, height: 360 }).cols, frame.layout(13, 26, { width: 400, height: 220 }).rows],
    [100, 28]
  );
});

test('snapshot display bytes do not advance the raw PTY replay offset', () => {
  const replay = createTerminalReplayAccounting();
  replay.begin(100, 5);

  const first = replay.consumeFrame(3);
  assert.deepEqual(first, { snapshotBytes: 3, liveBytes: 0 });
  assert.equal(replay.getSnapshotRemaining(), 2);
  assert.equal(replay.advanceProcessedOffset(first.liveBytes), 100);

  const boundary = replay.consumeFrame(5);
  assert.deepEqual(boundary, { snapshotBytes: 2, liveBytes: 3 });
  assert.equal(replay.getSnapshotRemaining(), 0);
  assert.equal(replay.advanceProcessedOffset(boundary.liveBytes), 103);

  const live = replay.consumeFrame(4);
  assert.deepEqual(live, { snapshotBytes: 0, liveBytes: 4 });
  assert.equal(replay.advanceProcessedOffset(live.liveBytes), 107);
});
