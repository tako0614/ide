// Re-export shared types
export type { Workspace, Deck } from '@deck-ide/shared/types';

export type TerminalSession = {
  id: string;
  deckId: string;
  title: string;
  command: string | null;
  createdAt: string;
  sockets: Set<import('ws').WebSocket>;
  buffer: string;
  lastActive: number;
  /** Send keyboard input to the PTY. */
  write: (data: string) => void;
  /** Resize the PTY. */
  resize: (cols: number, rows: number) => void;
  /** Kill the PTY process. */
  kill: () => void;
};

export type HttpError = Error & { status?: number };
