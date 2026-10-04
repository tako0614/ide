// Re-export shared types
export type { Workspace, Deck } from './shared/types.js';

export type TerminalSession = {
  cols: number;
  rows: number;
  pid: number;
  tmux: import('./terminal/tmuxAdapter.js').TmuxTerminalMeta;
  available: boolean;
  bufferEpoch: string;
  snapshot: () => Promise<{ data: Buffer; offset: number; sequence: number; cols: number; rows: number }>;
  detach: () => void;
  id: string;
  deckId: string;
  title: string;
  command: string | null;
  createdAt: string;
  sockets: Set<import('ws').WebSocket>;
  /** Buffered PTY output retained for reconnect replay. */
  bufferChunks: Buffer[];
  /** Total bytes currently retained across bufferChunks. */
  bufferLength: number;
  /** Absolute byte count dropped from buffer start (for replay offset tracking). */
  bufferBase: number;
  lastActive: number;
  /** Send keyboard input to the PTY. */
  write: (data: string | Uint8Array | Buffer) => void;
  /** Explicitly change the canonical tmux window and display dimensions. */
  resize: (cols: number, rows: number) => void;
  /** Explicitly close this verified tmux session and its shell. */
  kill: () => Promise<void>;
};

export type HttpError = Error & { status?: number };
