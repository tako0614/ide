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
  BrowserAudioStatus,
  BrowserWebRtcStatus,
  CodeServerStatus,
  BrowserStatus,
  BrowserTab,
  BrowserNavigateRequest,
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
} from '@shared/types';

export type AppView = 'workspace' | 'terminal' | 'browser';
export type WorkspaceMode = 'list' | 'editor';

// Drive shell tab model (code-server + Google-Drive-style UI).
export type TabKind = 'drive' | 'code' | 'browser' | 'terminal';
export interface TabDescriptor {
  id: string;
  kind: TabKind;
  title: string;
  // For 'code'/'drive' tabs: the workspace this tab is scoped to.
  wsId?: string;
}
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
