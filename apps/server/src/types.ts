// Re-export shared types
export type { Workspace, Deck } from '@deck-ide/shared/types';

export type TerminalSession = {
  id: string;
  deckId: string;
  title: string;
  command: string | null;
  createdAt: string;
  term: import('node-pty').IPty;
  sockets: Set<import('ws').WebSocket>;
  buffer: string;
  lastActive: number;
  dispose: import('node-pty').IDisposable | null;
};

export type HttpError = Error & { status?: number };
