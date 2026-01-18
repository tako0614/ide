import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeckList } from './components/DeckList';
import { DeckModal } from './components/DeckModal';
import { DiffViewer } from './components/DiffViewer';
import { EditorPane } from './components/EditorPane';
import { FileTree } from './components/FileTree';
import { SideNav } from './components/SideNav';
import { SourceControl } from './components/SourceControl';
import { StatusMessage } from './components/StatusMessage';
import { TerminalPane } from './components/TerminalPane';
import { WorkspaceList } from './components/WorkspaceList';
import { WorkspaceModal } from './components/WorkspaceModal';
import { getConfig, getWsBase } from './api';
import { useWorkspaceState } from './hooks/useWorkspaceState';
import { useDeckState } from './hooks/useDeckState';
import { useWorkspaces } from './hooks/useWorkspaces';
import { useDecks } from './hooks/useDecks';
import { useFileOperations } from './hooks/useFileOperations';
import { useGitState } from './hooks/useGitState';
import type { AppView, WorkspaceMode, SidebarPanel } from './types';
import {
  DEFAULT_ROOT_FALLBACK,
  SAVED_MESSAGE_TIMEOUT,
  MESSAGE_SAVED,
  MESSAGE_WORKSPACE_REQUIRED,
  MESSAGE_SELECT_WORKSPACE,
  MESSAGE_SELECT_DECK,
  STORAGE_KEY_THEME
} from './constants';
import { parseUrlState } from './utils/urlUtils';
import { getInitialTheme, type ThemeMode } from './utils/themeUtils';
import { createEmptyWorkspaceState, createEmptyDeckState } from './utils/stateUtils';

export default function App() {
  const initialUrlState = parseUrlState();
  const [view, setView] = useState<AppView>(initialUrlState.view);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    initialUrlState.workspaceMode
  );
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [defaultRoot, setDefaultRoot] = useState(DEFAULT_ROOT_FALLBACK);
  const [statusMessage, setStatusMessage] = useState('');
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isDeckModalOpen, setIsDeckModalOpen] = useState(false);
  const [isDeckDrawerOpen, setIsDeckDrawerOpen] = useState(false);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('files');

  const { workspaceStates, setWorkspaceStates, updateWorkspaceState, initializeWorkspaceStates } =
    useWorkspaceState();
  const { deckStates, setDeckStates, updateDeckState, initializeDeckStates } =
    useDeckState();

  const { workspaces, editorWorkspaceId, setEditorWorkspaceId, handleCreateWorkspace } =
    useWorkspaces({
      setStatusMessage,
      defaultRoot,
      initializeWorkspaceStates,
      setWorkspaceStates
    });

  const { decks, activeDeckId, setActiveDeckId, handleCreateDeck, handleCreateTerminal, handleDeleteTerminal } =
    useDecks({
      setStatusMessage,
      initializeDeckStates,
      updateDeckState,
      deckStates,
      setDeckStates
    });

  const defaultWorkspaceState = useMemo(() => createEmptyWorkspaceState(), []);
  const defaultDeckState = useMemo(() => createEmptyDeckState(), []);
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === editorWorkspaceId) || null;
  const activeWorkspaceState = editorWorkspaceId
    ? workspaceStates[editorWorkspaceId] || defaultWorkspaceState
    : defaultWorkspaceState;
  const activeDeckState = activeDeckId
    ? deckStates[activeDeckId] || defaultDeckState
    : defaultDeckState;

  const { savingFileId, handleRefreshTree, handleToggleDir, handleOpenFile, handleFileChange, handleSaveFile, handleCloseFile } =
    useFileOperations({
      editorWorkspaceId,
      activeWorkspaceState,
      updateWorkspaceState,
      setStatusMessage
    });

  const {
    gitState,
    refreshGitStatus,
    handleStageFile,
    handleUnstageFile,
    handleStageAll,
    handleUnstageAll,
    handleCommit,
    handleDiscardFile,
    handleShowDiff,
    handleCloseDiff,
    handlePush,
    handlePull,
    handleLoadBranches,
    handleCheckoutBranch,
    handleCreateBranch,
    handleLoadLogs
  } = useGitState(editorWorkspaceId, setStatusMessage);

  const wsBase = getWsBase();
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );
  const deckListItems = decks.map((deck) => ({
    id: deck.id,
    name: deck.name,
    path: workspaceById.get(deck.workspaceId)?.path || deck.root
  }));

  useEffect(() => {
    let alive = true;
    getConfig()
      .then((config) => {
        if (!alive) return;
        if (config?.defaultRoot) {
          setDefaultRoot(config.defaultRoot);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY_THEME, theme);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  useEffect(() => {
    const handlePopState = () => {
      const next = parseUrlState();
      setView(next.view);
      setEditorWorkspaceId(next.workspaceId ?? null);
      setActiveDeckId(next.deckId ?? null);
      setWorkspaceMode(next.workspaceMode);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setEditorWorkspaceId, setActiveDeckId]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('view', view);
    if (view === 'workspace' && editorWorkspaceId) {
      params.set('workspace', editorWorkspaceId);
    }
    if (activeDeckId) {
      params.set('deck', activeDeckId);
    }
    if (view === 'workspace' && workspaceMode === 'editor' && editorWorkspaceId) {
      params.set('mode', 'editor');
    }
    const query = params.toString();
    const nextUrl = query
      ? `${window.location.pathname}?${query}`
      : window.location.pathname;
    window.history.replaceState(null, '', nextUrl);
  }, [view, editorWorkspaceId, activeDeckId, workspaceMode]);

  useEffect(() => {
    if (statusMessage !== MESSAGE_SAVED) return;
    const timer = setTimeout(() => setStatusMessage(''), SAVED_MESSAGE_TIMEOUT);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    if (workspaceMode === 'editor' && !editorWorkspaceId) {
      setWorkspaceMode('list');
    }
  }, [workspaceMode, editorWorkspaceId]);

  // Track if we've loaded tree for current workspace
  const treeLoadedRef = useRef<string | null>(null);

  // Refresh file tree when opening workspace editor
  useEffect(() => {
    console.log('[App] useEffect triggered:', { workspaceMode, editorWorkspaceId, treeLoadedRef: treeLoadedRef.current });
    if (workspaceMode !== 'editor' || !editorWorkspaceId) {
      treeLoadedRef.current = null;
      return;
    }

    // Only load if we haven't loaded for this workspace yet
    if (treeLoadedRef.current !== editorWorkspaceId) {
      console.log('[App] Loading tree for workspace:', editorWorkspaceId);
      treeLoadedRef.current = editorWorkspaceId;
      handleRefreshTree();
      refreshGitStatus();
    }
  }, [workspaceMode, editorWorkspaceId, handleRefreshTree, refreshGitStatus]);

  const handleOpenDeckModal = useCallback(() => {
    if (workspaces.length === 0) {
      setStatusMessage(MESSAGE_WORKSPACE_REQUIRED);
      return;
    }
    setIsDeckModalOpen(true);
  }, [workspaces.length]);

  const handleSubmitDeck = useCallback(
    async (name: string, workspaceId: string) => {
      if (!workspaceId) {
        setStatusMessage(MESSAGE_SELECT_WORKSPACE);
        return;
      }
      const deck = await handleCreateDeck(name, workspaceId);
      if (deck) {
        setIsDeckModalOpen(false);
      }
    },
    [handleCreateDeck]
  );

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const handleSelectWorkspace = useCallback(
    (workspaceId: string) => {
      setEditorWorkspaceId(workspaceId);
      setWorkspaceMode('editor');
    },
    [setEditorWorkspaceId]
  );

  const handleCloseWorkspaceEditor = useCallback(() => {
    setWorkspaceMode('list');
  }, []);

  const handleOpenWorkspaceModal = useCallback(() => {
    setIsWorkspaceModalOpen(true);
  }, []);

  const handleSubmitWorkspace = useCallback(
    async (path: string) => {
      const created = await handleCreateWorkspace(path);
      if (created) {
        setIsWorkspaceModalOpen(false);
      }
    },
    [handleCreateWorkspace]
  );

  const handleNewTerminal = useCallback(() => {
    if (!activeDeckId) {
      setStatusMessage(MESSAGE_SELECT_DECK);
      return;
    }
    handleCreateTerminal(activeDeckId, activeDeckState.terminals.length);
  }, [activeDeckId, activeDeckState.terminals.length, handleCreateTerminal]);

  const handleTerminalDelete = useCallback(
    (terminalId: string) => {
      if (!activeDeckId) return;
      handleDeleteTerminal(activeDeckId, terminalId);
    },
    [activeDeckId, handleDeleteTerminal]
  );

  const handleToggleDeckList = useCallback(() => {
    setIsDeckDrawerOpen((prev) => !prev);
  }, []);

  const handleDeckHandleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleToggleDeckList();
      }
    },
    [handleToggleDeckList]
  );

  const isWorkspaceEditorOpen = workspaceMode === 'editor' && Boolean(editorWorkspaceId);

  const gitChangeCount = gitState.status?.files.length ?? 0;

  const workspaceEditor = isWorkspaceEditorOpen ? (
    <div className="workspace-editor-overlay">
      <div className="workspace-editor-header">
        <button
          type="button"
          className="ghost-button"
          onClick={handleCloseWorkspaceEditor}
        >
          {'\u4e00\u89a7\u306b\u623b\u308b'}
        </button>
        <div className="workspace-meta">
          {activeWorkspace ? (
            <span className="workspace-path">{activeWorkspace.path}</span>
          ) : null}
        </div>
      </div>
      <div className="workspace-editor-grid">
        <div className="sidebar-panel">
          <div className="sidebar-tabs">
            <button
              type="button"
              className={`sidebar-tab ${sidebarPanel === 'files' ? 'active' : ''}`}
              onClick={() => setSidebarPanel('files')}
            >
              <svg className="sidebar-tab-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="sidebar-tab-label">ファイル</span>
            </button>
            <button
              type="button"
              className={`sidebar-tab ${sidebarPanel === 'git' ? 'active' : ''}`}
              onClick={() => {
                setSidebarPanel('git');
                refreshGitStatus();
              }}
            >
              <svg className="sidebar-tab-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 3v12M18 9a3 3 0 110 6 3 3 0 010-6zM6 21a3 3 0 110-6 3 3 0 010 6z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M18 12c0 3-3 4-6 4s-6-1-6-4" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              <span className="sidebar-tab-label">Git</span>
              {gitChangeCount > 0 && (
                <span className="sidebar-tab-badge">{gitChangeCount}</span>
              )}
            </button>
          </div>
          <div className="sidebar-content">
            {sidebarPanel === 'files' ? (
              <FileTree
                root={activeWorkspace?.path || defaultRoot || ''}
                entries={activeWorkspaceState.tree}
                loading={activeWorkspaceState.treeLoading}
                error={activeWorkspaceState.treeError}
                onToggleDir={handleToggleDir}
                onOpenFile={handleOpenFile}
                onRefresh={handleRefreshTree}
                gitFiles={gitState.status?.files}
              />
            ) : (
              <SourceControl
                status={gitState.status}
                loading={gitState.loading}
                error={gitState.error}
                workspaceId={editorWorkspaceId}
                branchStatus={gitState.branchStatus}
                hasRemote={gitState.hasRemote}
                pushing={gitState.pushing}
                pulling={gitState.pulling}
                branches={gitState.branches}
                branchesLoading={gitState.branchesLoading}
                logs={gitState.logs}
                logsLoading={gitState.logsLoading}
                onRefresh={refreshGitStatus}
                onStageFile={handleStageFile}
                onUnstageFile={handleUnstageFile}
                onStageAll={handleStageAll}
                onUnstageAll={handleUnstageAll}
                onCommit={handleCommit}
                onDiscardFile={handleDiscardFile}
                onShowDiff={handleShowDiff}
                onPush={handlePush}
                onPull={handlePull}
                onLoadBranches={handleLoadBranches}
                onCheckoutBranch={handleCheckoutBranch}
                onCreateBranch={handleCreateBranch}
                onLoadLogs={handleLoadLogs}
              />
            )}
          </div>
        </div>
        <EditorPane
          files={activeWorkspaceState.files}
          activeFileId={activeWorkspaceState.activeFileId}
          onSelectFile={(fileId) => {
            if (!editorWorkspaceId) return;
            updateWorkspaceState(editorWorkspaceId, (state) => ({
              ...state,
              activeFileId: fileId
            }));
          }}
          onCloseFile={handleCloseFile}
          onChangeFile={handleFileChange}
          onSaveFile={handleSaveFile}
          savingFileId={savingFileId}
          theme={theme}
        />
      </div>
      {gitState.diffPath && (
        <DiffViewer
          diff={gitState.diff}
          loading={gitState.diffLoading}
          theme={theme}
          onClose={handleCloseDiff}
        />
      )}
    </div>
  ) : null;

  const workspaceView = (
    <div className="workspace-view">
      <div className="workspace-start">
        <button
          type="button"
          className="primary-button"
          onClick={handleOpenWorkspaceModal}
        >
          {'\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u8ffd\u52a0'}
        </button>
        <WorkspaceList
          workspaces={workspaces}
          selectedWorkspaceId={editorWorkspaceId}
          onSelect={handleSelectWorkspace}
        />
      </div>
      {workspaceEditor}
    </div>
  );

  const terminalView = (
    <div className="terminal-layout">
      <button
        type="button"
        className={`deck-handle ${isDeckDrawerOpen ? 'is-open' : ''}`}
        onClick={handleToggleDeckList}
        onKeyDown={handleDeckHandleKeyDown}
        aria-label={
          isDeckDrawerOpen
            ? '\u30c7\u30c3\u30ad\u3092\u9589\u3058\u308b'
            : '\u30c7\u30c3\u30ad\u3092\u958b\u304f'
        }
        title={
          isDeckDrawerOpen
            ? '\u30c7\u30c3\u30ad\u3092\u9589\u3058\u308b'
            : '\u30c7\u30c3\u30ad\u3092\u958b\u304f'
        }
      >
        <span className="deck-handle-bars" aria-hidden="true" />
      </button>
      <aside className={`deck-drawer ${isDeckDrawerOpen ? 'is-open' : ''}`}>
        <DeckList
          decks={deckListItems}
          activeDeckId={activeDeckId}
          onSelect={setActiveDeckId}
          onCreate={handleOpenDeckModal}
        />
      </aside>
      <div className="terminal-stage">
        {activeDeckId ? (
          <TerminalPane
            terminals={activeDeckState.terminals}
            wsBase={wsBase}
            onNewTerminal={handleNewTerminal}
            onDeleteTerminal={handleTerminalDelete}
          />
        ) : (
          <div className="panel empty-panel">
            {'\u30c7\u30c3\u30ad\u3092\u4f5c\u6210\u3057\u3066\u304f\u3060\u3055\u3044\u3002'}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="app" data-view={view}>
      <SideNav
        activeView={view}
        onSelect={setView}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />
      <main className="main">
        {view === 'workspace' && workspaceView}
        {view === 'terminal' && terminalView}
      </main>
      <StatusMessage message={statusMessage} />
      <WorkspaceModal
        isOpen={isWorkspaceModalOpen}
        defaultRoot={defaultRoot}
        onSubmit={handleSubmitWorkspace}
        onClose={() => setIsWorkspaceModalOpen(false)}
      />
      <DeckModal
        isOpen={isDeckModalOpen}
        workspaces={workspaces}
        onSubmit={handleSubmitDeck}
        onClose={() => setIsDeckModalOpen(false)}
      />
    </div>
  );
}
