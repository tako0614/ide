// Re-export shared types
export type { Workspace, Deck } from './shared/types.js';

export type TerminalSession = {
  id: string;
  deckId: string;
  title: string;
  command: string | null;
  createdAt: string;
  sockets: Set<import('ws').WebSocket>;
  /** Socket currently allowed to drive PTY size updates. */
  resizeOwner: import('ws').WebSocket | null;
  /** Buffered PTY output retained for reconnect replay. */
  bufferChunks: Buffer[];
  /** Total bytes currently retained across bufferChunks. */
  bufferLength: number;
  /** Absolute byte count dropped from buffer start (for replay offset tracking). */
  bufferBase: number;
  lastActive: number;
  /** Send keyboard input to the PTY. */
  write: (data: string | Uint8Array | Buffer) => void;
  /** Resize the PTY. */
  resize: (cols: number, rows: number) => void;
  /** Kill the PTY process. */
  kill: () => void;
};

export type HttpError = Error & { status?: number };
