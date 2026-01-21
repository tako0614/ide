import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeckModal } from './components/DeckModal';
import { DiffViewer } from './components/DiffViewer';
import { EditorPane } from './components/EditorPane';
import { FileTree } from './components/FileTree';
import { SettingsModal } from './components/SettingsModal';
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
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
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

  const { decks, activeDeckIds, setActiveDeckIds, handleCreateDeck, handleCreateTerminal, handleDeleteTerminal } =
    useDecks({
      setStatusMessage,
      initializeDeckStates,
      updateDeckState,
      deckStates,
      setDeckStates,
      initialDeckIds: initialUrlState.deckIds
    });

  // Grid config state per deck
  const [deckGridConfigs, setDeckGridConfigs] = useState<Record<string, { cols: number; rows: number }>>({});

  // Load grid configs from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('deck-grid-configs');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setDeckGridConfigs(parsed);
      } catch {
        // ignore
      }
    }
  }, []);

  const getDeckGridConfig = useCallback((deckId: string) => {
    return deckGridConfigs[deckId] || { cols: 2, rows: 2 };
  }, [deckGridConfigs]);

  const setDeckGridConfig = useCallback((deckId: string, cols: number, rows: number) => {
    setDeckGridConfigs((prev) => {
      const next = { ...prev, [deckId]: { cols, rows } };
      localStorage.setItem('deck-grid-configs', JSON.stringify(next));
      return next;
    });
  }, []);

  const defaultWorkspaceState = useMemo(() => createEmptyWorkspaceState(), []);
  const defaultDeckState = useMemo(() => createEmptyDeckState(), []);
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === editorWorkspaceId) || null;
  const activeWorkspaceState = editorWorkspaceId
    ? workspaceStates[editorWorkspaceId] || defaultWorkspaceState
    : defaultWorkspaceState;

  const {
    savingFileId,
    handleRefreshTree,
    handleToggleDir,
    handleOpenFile,
    handleFileChange,
    handleSaveFile,
    handleCloseFile,
    handleCreateFile,
    handleCreateDirectory,
    handleDeleteFile,
    handleDeleteDirectory
  } = useFileOperations({
    editorWorkspaceId,
    activeWorkspaceState,
    updateWorkspaceState,
    setStatusMessage
  });

  const {
    gitState,
    refreshGitStatus,
    handleSelectRepo,
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
      setActiveDeckIds(next.deckIds);
      setWorkspaceMode(next.workspaceMode);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setEditorWorkspaceId, setActiveDeckIds]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('view', view);
    if (view === 'workspace' && editorWorkspaceId) {
      params.set('workspace', editorWorkspaceId);
    }
    if (activeDeckIds.length > 0) {
      params.set('decks', activeDeckIds.join(','));
    }
    if (view === 'workspace' && workspaceMode === 'editor' && editorWorkspaceId) {
      params.set('mode', 'editor');
    }
    const query = params.toString();
    const nextUrl = query
      ? `${window.location.pathname}?${query}`
      : window.location.pathname;
    window.history.replaceState(null, '', nextUrl);
  }, [view, editorWorkspaceId, activeDeckIds, workspaceMode]);

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
    if (workspaceMode !== 'editor' || !editorWorkspaceId) {
      treeLoadedRef.current = null;
      return;
    }

    // Only load if we haven't loaded for this workspace yet
    if (treeLoadedRef.current !== editorWorkspaceId) {
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

  const handleSaveSettings = useCallback(async (settings: { port: number; basicAuthEnabled: boolean; basicAuthUser: string; basicAuthPassword: string }) => {
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Failed to save settings');
      }

      const result = await response.json();
      setStatusMessage('設定を保存しました。ブラウザをリロードしてください。');

      // Reload after 2 seconds to apply settings
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } catch (error: unknown) {
      console.error('Failed to save settings:', error);
      throw error;
    }
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

  const handleNewTerminalForDeck = useCallback((deckId: string) => {
    const deckState = deckStates[deckId] || defaultDeckState;
    handleCreateTerminal(deckId, deckState.terminals.length);
  }, [deckStates, defaultDeckState, handleCreateTerminal]);

  const handleNewClaudeTerminalForDeck = useCallback((deckId: string) => {
    const deckState = deckStates[deckId] || defaultDeckState;
    handleCreateTerminal(deckId, deckState.terminals.length, 'claude', 'Claude Code');
  }, [deckStates, defaultDeckState, handleCreateTerminal]);

  const handleNewCodexTerminalForDeck = useCallback((deckId: string) => {
    const deckState = deckStates[deckId] || defaultDeckState;
    handleCreateTerminal(deckId, deckState.terminals.length, 'codex', 'Codex');
  }, [deckStates, defaultDeckState, handleCreateTerminal]);

  const handleTerminalDeleteForDeck = useCallback(
    (deckId: string, terminalId: string) => {
      handleDeleteTerminal(deckId, terminalId);
    },
    [handleDeleteTerminal]
  );

  const handleToggleDeck = useCallback((deckId: string) => {
    setActiveDeckIds((prev) => {
      if (prev.includes(deckId)) {
        // Remove deck (but keep at least one)
        if (prev.length > 1) {
          return prev.filter((id) => id !== deckId);
        }
        return prev;
      } else {
        // Add deck (max 3 for horizontal split)
        if (prev.length < 3) {
          return [...prev, deckId];
        }
        // Replace first one if at max
        return [...prev.slice(1), deckId];
      }
    });
  }, [setActiveDeckIds]);


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
        <div className="activity-bar">
          <button
            type="button"
            className={`activity-bar-item ${sidebarPanel === 'files' ? 'active' : ''}`}
            onClick={() => setSidebarPanel('files')}
            title="エクスプローラー"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className={`activity-bar-item ${sidebarPanel === 'git' ? 'active' : ''}`}
            onClick={() => {
              setSidebarPanel('git');
              refreshGitStatus();
            }}
            title="ソースコントロール"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 3v12M18 9a3 3 0 110 6 3 3 0 010-6zM6 21a3 3 0 110-6 3 3 0 010 6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M18 12c0 3-3 4-6 4s-6-1-6-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {gitChangeCount > 0 && (
              <span className="activity-bar-badge">{gitChangeCount}</span>
            )}
          </button>
        </div>
        <div className="sidebar-panel">
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
                onCreateFile={handleCreateFile}
                onCreateDirectory={handleCreateDirectory}
                onDeleteFile={handleDeleteFile}
                onDeleteDirectory={handleDeleteDirectory}
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
                repos={gitState.repos}
                selectedRepoPath={gitState.selectedRepoPath}
                onSelectRepo={handleSelectRepo}
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
      <div className="terminal-topbar">
        <div className="topbar-left">
          <div className="deck-tabs">
            {decks.map((deck) => (
              <button
                key={deck.id}
                type="button"
                className={`deck-tab ${activeDeckIds.includes(deck.id) ? 'active' : ''}`}
                onClick={() => handleToggleDeck(deck.id)}
                title={workspaceById.get(deck.workspaceId)?.path || deck.root}
              >
                {deck.name}
              </button>
            ))}
            <button
              type="button"
              className="deck-tab deck-tab-add"
              onClick={handleOpenDeckModal}
              title="デッキ作成"
            >
              +
            </button>
          </div>
        </div>
      </div>
      <div className="terminal-split-container" style={{ gridTemplateColumns: `repeat(${activeDeckIds.length}, 1fr)` }}>
        {activeDeckIds.length === 0 ? (
          <div className="panel empty-panel">
            {'デッキを作成してください。'}
          </div>
        ) : (
          activeDeckIds.map((deckId) => {
            const deck = decks.find((d) => d.id === deckId);
            const deckState = deckStates[deckId] || defaultDeckState;
            const gridConfig = getDeckGridConfig(deckId);
            if (!deck) return null;
            return (
              <div key={deckId} className="deck-split-pane">
                <div className="deck-split-header">
                  <span className="deck-split-title">{deck.name}</span>
                  <div className="deck-split-actions">
                    <div className="grid-control-sm">
                      <button
                        type="button"
                        className="grid-btn-sm"
                        onClick={() => setDeckGridConfig(deckId, Math.max(1, gridConfig.cols - 1), gridConfig.rows)}
                        disabled={gridConfig.cols <= 1}
                      >
                        −
                      </button>
                      <span className="grid-value-sm">{gridConfig.cols}</span>
                      <button
                        type="button"
                        className="grid-btn-sm"
                        onClick={() => setDeckGridConfig(deckId, Math.min(6, gridConfig.cols + 1), gridConfig.rows)}
                        disabled={gridConfig.cols >= 6}
                      >
                        +
                      </button>
                      <span className="grid-separator-sm">×</span>
                      <button
                        type="button"
                        className="grid-btn-sm"
                        onClick={() => setDeckGridConfig(deckId, gridConfig.cols, Math.max(1, gridConfig.rows - 1))}
                        disabled={gridConfig.rows <= 1}
                      >
                        −
                      </button>
                      <span className="grid-value-sm">{gridConfig.rows}</span>
                      <button
                        type="button"
                        className="grid-btn-sm"
                        onClick={() => setDeckGridConfig(deckId, gridConfig.cols, Math.min(6, gridConfig.rows + 1))}
                        disabled={gridConfig.rows >= 6}
                      >
                        +
                      </button>
                    </div>
                    <span className="deck-split-divider" />
                    <button
                      type="button"
                      className="topbar-btn-sm"
                      onClick={() => handleNewTerminalForDeck(deckId)}
                      title="ターミナル追加"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="topbar-btn-sm topbar-btn-claude"
                      onClick={() => handleNewClaudeTerminalForDeck(deckId)}
                      title="Claude"
                    >
                      C
                    </button>
                    <button
                      type="button"
                      className="topbar-btn-sm topbar-btn-codex"
                      onClick={() => handleNewCodexTerminalForDeck(deckId)}
                      title="Codex"
                    >
                      X
                    </button>
                  </div>
                </div>
                <TerminalPane
                  terminals={deckState.terminals}
                  wsBase={wsBase}
                  onDeleteTerminal={(terminalId) => handleTerminalDeleteForDeck(deckId, terminalId)}
                  gridCols={gridConfig.cols}
                  gridRows={gridConfig.rows}
                />
              </div>
            );
          })
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
        onOpenSettings={() => setIsSettingsModalOpen(true)}
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
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
