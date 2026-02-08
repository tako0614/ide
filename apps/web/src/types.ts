// Re-export shared types from @deck-ide/shared
export type {
  FileEntryType,
  Workspace,
  Deck,
  FileSystemEntry,
  FileTreeNode,
  EditorFile,
  TerminalSession,
  WorkspaceState,
  DeckState,
  ApiError,
  ApiConfig,
  ApiFileResponse,
  ApiFileSaveResponse,
  ApiTerminalCreateResponse,
  CreateWorkspaceRequest,
  CreateDeckRequest,
  CreateTerminalRequest,
  SaveFileRequest,
  GetFileRequest,
  GetFilesRequest,
  GetPreviewRequest,
  GitFileStatusCode,
  GitFileStatus,
  GitStatus,
  GitDiff,
  GitRepoInfo,
  GitFileStatusWithRepo,
  MultiRepoGitStatus
} from '@deck-ide/shared/types';

export type AppView = 'workspace' | 'terminal' | 'agent';
export type WorkspaceMode = 'list' | 'editor';
export type ThemeMode = 'light' | 'dark';
export type SidebarPanel = 'files' | 'git';

export interface UrlState {
  view: AppView;
  workspaceId: string | null;
  deckId: string | null;
  workspaceMode: WorkspaceMode;
}

export interface DeckListItem {
  id: string;
  name: string;
  path: string;
}

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

export interface AgentSession {
  id: string;
  provider: AgentProvider;
  prompt: string;
  cwd: string;
  status: AgentStatus;
  messages: AgentMessage[];
  createdAt: string;
  totalCostUsd?: number;
  durationMs?: number;
  error?: string;
}

export interface CreateAgentRequest {
  provider: AgentProvider;
  prompt: string;
  cwd: string;
  maxCostUsd?: number;
}
