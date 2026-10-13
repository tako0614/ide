import { WebSocket } from 'ws';
import type { TerminalSession } from '../types.js';

export const MIN_TERMINAL_SIZE = 1;
export const MAX_TERMINAL_SIZE = 500;
const MAX_SOCKET_BUFFERED_AMOUNT = 1024 * 1024;

/**
 * Control frames (JSON text) sent to terminal clients. Binary frames carry
 * PTY output.
 *
 * - sync:    a replay follows. `reset` clears the client first; `snapshot`
 *            means the next binary frame is a serialized screen that does not
 *            count toward the client's byte offset. cols/rows is the size the
 *            replay was produced at — apply it before writing.
 * - ready:   replay finished; live output follows.
 * - primary: whether this client drives the PTY size and answers terminal
 *            queries (DSR/DA/...). Exactly one attached client is primary.
 * - size:    the PTY was resized; render at this size from here on.
 */
export type ServerControlMessage =
  | { type: 'sync'; offsetBase: number; reset: boolean; cols: number; rows: number; snapshot?: boolean }
  | { type: 'ready' }
  | { type: 'primary'; value: boolean }
  | { type: 'size'; cols: number; rows: number };

/**
 * Control frames from clients.
 *
 * - resize: the size this client's viewport could show. Stored for every
 *           client; applied to the PTY only while the client is primary.
 * - claim:  make this client primary (the user is interacting with it) and
 *           resize the PTY to its viewport.
 * - resync: resend the current screen (snapshot) and resume live output.
 */
export type ClientControlMessage =
  | { type: 'claim'; cols?: number; rows?: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'resync' };

export function clampTerminalSize(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_TERMINAL_SIZE, Math.max(MIN_TERMINAL_SIZE, Math.floor(value)));
}

export function canSendToSocket(socket: WebSocket): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_AMOUNT) {
    try { socket.close(1009, 'Terminal output overflow'); } catch { /* ignore */ }
    return false;
  }
  return true;
}

export function sendTerminalControl(socket: WebSocket, message: ServerControlMessage): boolean {
  if (!canSendToSocket(socket)) {
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    try { socket.close(1011, 'Terminal control send failed'); } catch { /* ignore */ }
    return false;
  }
}

/**
 * The only way the PTY should be resized: keeps the mirror in step and tells
 * every client, so all of them render at exactly the PTY's cols×rows. A client
 * rendering at any other width is what tears TUIs apart.
 */
export function resizeTerminal(session: TerminalSession, cols: number, rows: number): boolean {
  const nextCols = clampTerminalSize(cols, session.cols);
  const nextRows = clampTerminalSize(rows, session.rows);
  if (nextCols === session.cols && nextRows === session.rows) {
    return false;
  }
  try {
    session.resize(nextCols, nextRows);
  } catch (error) {
    console.error(`Failed to resize terminal ${session.id}:`, error);
    return false;
  }
  session.cols = nextCols;
  session.rows = nextRows;
  session.lastResizeOffset = session.bufferBase + session.bufferLength;
  session.resizeEpoch++;
  session.mirror?.resize(nextCols, nextRows);
  for (const socket of session.sockets) {
    sendTerminalControl(socket, { type: 'size', cols: nextCols, rows: nextRows });
  }
  return true;
}

/**
 * Hand control (size + query answering) to `socket` and resize the PTY to its
 * viewport. `touch` records it as the most recently active client, which is
 * what promotion falls back to when the primary leaves.
 */
export function assignResizeOwner(session: TerminalSession, socket: WebSocket, touch = true): void {
  const client = session.clients.get(socket);
  if (client && touch) client.activeAt = Date.now();
  const previous = session.resizeOwner;
  if (previous !== socket) {
    session.resizeOwner = socket;
    if (previous && session.sockets.has(previous)) {
      sendTerminalControl(previous, { type: 'primary', value: false });
    }
    // A socket still waiting for its replay learns its role after `ready`.
    if (session.sockets.has(socket)) {
      sendTerminalControl(socket, { type: 'primary', value: true });
    }
  }
  if (client?.desired) {
    resizeTerminal(session, client.desired.cols, client.desired.rows);
  }
}

/** Forget a client; if it was primary, promote the most recently active one. */
export function releaseTerminalClient(session: TerminalSession, socket: WebSocket): void {
  session.sockets.delete(socket);
  session.clients.delete(socket);
  if (session.resizeOwner !== socket) return;
  session.resizeOwner = null;
  let next: WebSocket | null = null;
  let nextActiveAt = -Infinity;
  for (const [candidate, client] of session.clients) {
    if (!session.sockets.has(candidate)) continue;
    if (client.activeAt > nextActiveAt) {
      next = candidate;
      nextActiveAt = client.activeAt;
    }
  }
  if (next) assignResizeOwner(session, next, false);
}

/** Close every client of a terminal that is going away. */
export function closeTerminalClients(session: TerminalSession, reason: string): void {
  for (const socket of session.clients.keys()) {
    try { socket.close(1000, reason); } catch { /* ignore */ }
  }
  for (const socket of session.sockets) {
    try { socket.close(1000, reason); } catch { /* ignore */ }
  }
  session.sockets.clear();
  session.clients.clear();
  session.resizeOwner = null;
  session.mirror?.dispose();
  session.mirror = null;
}
