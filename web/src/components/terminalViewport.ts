/**
 * Pure helpers for rendering a terminal whose size is decided by the server.
 *
 * Every client renders at exactly the PTY's cols×rows — rendering at any other
 * width is what tears TUIs apart when several clients (PC + phone + CLI)
 * share a terminal. A client whose viewport is smaller than that grid scales
 * the grid down to fit instead of reflowing it.
 */

export interface Size {
  width: number;
  height: number;
}

/** Scale (≤ 1) that fits `natural` inside `available`; 1 when it already fits. */
export function computeViewportScale(natural: Size, available: Size): number {
  if (!(natural.width > 0 && natural.height > 0 && available.width > 0 && available.height > 0)) {
    return 1;
  }
  const scale = Math.min(1, available.width / natural.width, available.height / natural.height);
  // Sub-pixel rounding differences are not worth a blurry transform.
  return scale > 0.995 ? 1 : Math.max(0.05, scale);
}

// Data a terminal emits on its own rather than because a key was pressed:
// query replies (CPR/DECXCPR, DA, DECRPM, OSC, DCS, kitty flags, window size),
// focus in/out and mouse reports. Mirrors TERMINAL_REPORT in bin/cli-client.js.
const TERMINAL_REPORT = new RegExp('^(?:' + [
  '\\x1b\\[\\??\\d+;\\d+R',
  '\\x1b\\[[?>=][\\d;]*c',
  '\\x1b\\[\\??[\\d;]*\\$y',
  '\\x1b\\][\\d;]*[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
  '\\x1bP[\\s\\S]*?\\x1b\\\\',
  '\\x1b\\[[IO]',
  '\\x1b\\[\\?[\\d;]*u',
  '\\x1b\\[\\d+;\\d+;\\d+t',
  '\\x1b\\[<\\d+;\\d+;\\d+[Mm]',
  '\\x1b\\[M[\\s\\S]{3}',
].join('|') + ')+$');

/**
 * True for output the terminal generated itself (query replies, focus and
 * mouse reports). A client that is only viewing must neither forward these —
 * the primary already answers — nor treat them as the user typing.
 */
export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORT.test(data);
}

export interface TerminalSocketUrlOptions {
  token?: string;
  bufferOffset?: number;
  cols?: number;
  rows?: number;
  claim?: boolean;
  reconnect?: boolean;
}

/** WebSocket URL for attaching to a terminal (protocol 2: snapshots + server-driven size). */
export function buildTerminalSocketUrl(base: string, options: TerminalSocketUrlOptions): string {
  const params = new URLSearchParams();
  if (options.token) params.set('token', options.token);
  params.set('proto', '2');
  params.set('client', 'web');
  if (options.bufferOffset && options.bufferOffset > 0) params.set('bufferOffset', String(options.bufferOffset));
  if (options.cols && options.rows) {
    params.set('cols', String(options.cols));
    params.set('rows', String(options.rows));
  }
  if (options.claim) params.set('claim', '1');
  if (options.reconnect) params.set('reconnect', '1');
  return `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
}
