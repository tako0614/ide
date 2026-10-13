// Re-export shared types
export type { Workspace, Deck } from './shared/types.js';

export type TerminalSize = { cols: number; rows: number };

/** Per-socket state for a client attached to a terminal. */
export type TerminalClient = {
  /** Stable id of the client instance across reconnects (e.g. one browser tile). */
  id: string | null;
  /** Size this client's viewport could display (fit result / local tty size). */
  desired: TerminalSize | null;
  /** Last time this client claimed control or sent input (ms epoch). */
  activeAt: number;
  /** 'web' for the browser UI, 'cli' for `deckide attach`, 'other' otherwise. */
  kind: 'web' | 'cli' | 'other';
};

/** Server-side headless terminal that mirrors PTY output for snapshots. */
export type TerminalMirrorHandle = {
  write: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  /** Serialize the screen once every byte written so far has been parsed. */
  snapshot: () => Promise<{ data: string; cols: number; rows: number; offset: number }>;
  /** Most recent OSC 0/2 title, if the program set one. */
  title: () => string | null;
  dispose: () => void;
};

export type TerminalSession = {
  id: string;
  deckId: string;
  title: string;
  command: string | null;
  createdAt: string;
  /** Sockets receiving live output (a joining socket is added after its replay). */
  sockets: Set<import('ws').WebSocket>;
  /** Every attached socket, including ones still waiting for their snapshot. */
  clients: Map<import('ws').WebSocket, TerminalClient>;
  /** Socket whose viewport size the PTY follows (the most recently active client). */
  resizeOwner: import('ws').WebSocket | null;
  /** Current PTY size. The server is the single source of truth for it. */
  cols: number;
  rows: number;
  /** Absolute output offset at the most recent resize (invalidates delta replay). */
  lastResizeOffset: number;
  /** Incremented on every resize (detects a resize while a snapshot renders). */
  resizeEpoch: number;
  mirror: TerminalMirrorHandle | null;
  /** Buffered PTY output retained for reconnect replay. */
  bufferChunks: Buffer[];
  /** Total bytes currently retained across bufferChunks. */
  bufferLength: number;
  /** Absolute byte count dropped from buffer start (for replay offset tracking). */
  bufferBase: number;
  lastActive: number;
  /** Send keyboard input to the PTY. */
  write: (data: string | Uint8Array | Buffer) => void;
  /** Resize the PTY. Use resizeTerminal() so clients and the mirror follow. */
  resize: (cols: number, rows: number) => void;
  /** Explicit deletion: terminate the terminal process. */
  kill: () => void;
  /** Server shutdown: detach a tmux client and preserve its shell and metadata. */
  detach: () => void;
};

export type HttpError = Error & { status?: number };
