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

// Agent types
export type AgentProvider = 'claude' | 'codex';
export type AgentStatus = 'idle' | 'running' | 'completed' | 'error' | 'aborted';

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  toolName?: string;
}

export interface AgentSessionData {
  id: string;
  provider: AgentProvider;
  prompt: string;
  cwd: string;
  status: AgentStatus;
  messages: AgentMessage[];
  createdAt: string;
  totalCostUsd?: number;
  maxCostUsd?: number;
  durationMs?: number;
  error?: string;
}
