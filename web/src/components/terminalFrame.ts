export interface TerminalFrameLayout {
  cols: number;
  rows: number;
  scale: number;
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  padding: number;
}

export interface TerminalFrameSize {
  width: number;
  height: number;
}

export interface TerminalScreenOrigin {
  left: number;
  top: number;
}

/** Largest grid that fits the viewport at the current cell size (native display mode). */
export function fitTerminalGrid(
  cellWidth: number,
  cellHeight: number,
  viewport: TerminalFrameSize,
  padding = 10,
  scrollbar = 15
): { cols: number; rows: number } | null {
  if (![cellWidth, cellHeight, viewport.width, viewport.height].every((value) => Number.isFinite(value) && value > 0)) return null;
  const cols = Math.floor((viewport.width - padding * 2 - scrollbar) / cellWidth);
  const rows = Math.floor((viewport.height - padding * 2) / cellHeight);
  return cols < 2 || rows < 2 ? null : { cols: Math.min(500, cols), rows: Math.min(500, rows) };
}

/** Convert transformed screen coordinates to xterm's unscaled CSS-pixel space. */
export function normalizeTerminalPointerPoint(
  clientX: number,
  clientY: number,
  screenOrigin: TerminalScreenOrigin,
  scale: number
): { clientX: number; clientY: number } {
  if (!Number.isFinite(scale) || scale <= 0) return { clientX, clientY };
  return {
    clientX: screenOrigin.left + (clientX - screenOrigin.left) / scale,
    clientY: screenOrigin.top + (clientY - screenOrigin.top) / scale
  };
}

export interface CanonicalTerminalFrame {
  getSize(): { cols: number; rows: number };
  layout(cellWidth: number, cellHeight: number, viewport: TerminalFrameSize, padding?: number): TerminalFrameLayout;
  applyServerSize(cols: number, rows: number): { cols: number; rows: number } | null;
}

export interface TerminalReplayAccounting {
  begin(offsetBase: number, snapshotBytes: number): void;
  consumeFrame(byteLength: number): { snapshotBytes: number; liveBytes: number };
  advanceProcessedOffset(liveBytes: number): number;
  getProcessedOffset(): number;
  getSnapshotRemaining(): number;
}

/** Track serialized snapshot bytes separately from raw PTY bytes in the live tail. */
export function createTerminalReplayAccounting(): TerminalReplayAccounting {
  let processedOffset = 0;
  let snapshotRemaining = 0;
  return {
    begin: (offsetBase, snapshotBytes) => {
      processedOffset = Number.isFinite(offsetBase) ? Math.max(0, Math.floor(offsetBase)) : 0;
      snapshotRemaining = Number.isFinite(snapshotBytes) ? Math.max(0, Math.floor(snapshotBytes)) : 0;
    },
    consumeFrame: (byteLength) => {
      const length = Number.isFinite(byteLength) ? Math.max(0, Math.floor(byteLength)) : 0;
      const snapshotBytes = Math.min(snapshotRemaining, length);
      snapshotRemaining -= snapshotBytes;
      return { snapshotBytes, liveBytes: length - snapshotBytes };
    },
    advanceProcessedOffset: (liveBytes) => {
      if (Number.isFinite(liveBytes) && liveBytes > 0) {
        processedOffset += Math.floor(liveBytes);
      }
      return processedOffset;
    },
    getProcessedOffset: () => processedOffset,
    getSnapshotRemaining: () => snapshotRemaining
  };
}

/** Compute a local display scale without changing the terminal's cell grid. */
export function computeTerminalFrameLayout(
  cols: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
  viewport: TerminalFrameSize,
  padding = 10
): TerminalFrameLayout {
  const safeCols = Math.max(1, Math.floor(cols));
  const safeRows = Math.max(1, Math.floor(rows));
  const safeCellWidth = Number.isFinite(cellWidth) && cellWidth > 0 ? cellWidth : 1;
  const safeCellHeight = Number.isFinite(cellHeight) && cellHeight > 0 ? cellHeight : 1;
  const safePadding = Number.isFinite(padding) && padding > 0 ? padding : 0;
  const width = safeCols * safeCellWidth + safePadding * 2;
  const height = safeRows * safeCellHeight + safePadding * 2;
  const visible = viewport.width > 0 && viewport.height > 0;
  const scale = visible
    ? Math.min(1, viewport.width / width, viewport.height / height)
    : 0;

  return {
    cols: safeCols,
    rows: safeRows,
    scale,
    width: width * scale,
    height: height * scale,
    cellWidth: safeCellWidth,
    cellHeight: safeCellHeight,
    padding: safePadding
  };
}

/** Keep viewport-driven layout separate from server-authoritative cell changes. */
export function createCanonicalTerminalFrame(cols: number, rows: number): CanonicalTerminalFrame {
  let canonicalCols = Math.max(1, Math.floor(cols));
  let canonicalRows = Math.max(1, Math.floor(rows));
  return {
    getSize: () => ({ cols: canonicalCols, rows: canonicalRows }),
    layout: (cellWidth, cellHeight, viewport, padding) =>
      computeTerminalFrameLayout(canonicalCols, canonicalRows, cellWidth, cellHeight, viewport, padding),
    applyServerSize: (nextCols, nextRows) => {
      if (!Number.isInteger(nextCols) || !Number.isInteger(nextRows) || nextCols < 1 || nextRows < 1) return null;
      if (nextCols === canonicalCols && nextRows === canonicalRows) return null;
      canonicalCols = nextCols;
      canonicalRows = nextRows;
      return { cols: canonicalCols, rows: canonicalRows };
    }
  };
}

/** Map a point in the scaled frame back to its terminal cell. */
export function terminalCellAtPoint(
  x: number,
  y: number,
  layout: TerminalFrameLayout
): { col: number; row: number } | null {
  if (layout.scale <= 0) return null;
  return {
    col: Math.max(0, Math.min(layout.cols - 1, Math.floor((x / layout.scale - layout.padding) / layout.cellWidth))),
    row: Math.max(0, Math.min(layout.rows - 1, Math.floor((y / layout.scale - layout.padding) / layout.cellHeight)))
  };
}
