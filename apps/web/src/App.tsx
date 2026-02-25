import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeckModal } from './components/DeckModal';
import { SideNav } from './components/SideNav';
import { StatusMessage } from './components/StatusMessage';
import { TerminalPane } from './components/TerminalPane';
import { WorkspaceList } from './components/WorkspaceList';
import { WorkspaceModal } from './components/WorkspaceModal';
import { WorkspaceEditor } from './components/WorkspaceEditor';
import { SettingsModal } from './components/SettingsModal';
import { getConfig, getWsBase } from './api';
import { useWorkspaceState } from './hooks/useWorkspaceState';
import { useDeckState } from './hooks/useDeckState';
import { useWorkspaces } from './hooks/useWorkspaces';
import { useDecks } from './hooks/useDecks';
import { useFileOperations } from './hooks/useFileOperations';
import { useGitState } from './hooks/useGitState';
import { useTheme } from './hooks/useTheme';
import { useUrlSync } from './hooks/useUrlSync';
import { useModalState } from './hooks/useModalState';
import type { AppView, WorkspaceMode, FileTreeNode } from './types';
import {
  DEFAULT_ROOT_FALLBACK,
  SAVED_MESSAGE_TIMEOUT,
  MESSAGE_SAVED,
  MESSAGE_WORKSPACE_REQUIRED,
  MESSAGE_SELECT_WORKSPACE
} from './constants';
import { parseUrlState } from './utils/urlUtils';
import { createEmptyWorkspaceState, createEmptyDeckState } from './utils/stateUtils';

export default function App() {
  const initialUrlState = parseUrlState();
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<AppView>(initialUrlState.view);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    initialUrlState.workspaceMode
  );
  const [defaultRoot, setDefaultRoot] = useState(DEFAULT_ROOT_FALLBACK);
  const [statusMessage, setStatusMessage] = useState('');

  const { theme, handleToggleTheme } = useTheme();

  const {
    isWorkspaceModalOpen,
    openWorkspaceModal,
    closeWorkspaceModal,
    isDeckModalOpen,
    openDeckModal,
    closeDeckModal,
    isSettingsModalOpen,
    openSettingsModal,
    closeSettingsModal
  } = useModalState();

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
      setDeckStates,
      initialDeckIds: initialUrlState.deckIds
    });

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

  useUrlSync({
    view,
    editorWorkspaceId,
    activeDeckIds,
    workspaceMode,
    setView,
    setEditorWorkspaceId,
    setActiveDeckIds,
    setWorkspaceMode
  });

  const wsBase = getWsBase();
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );

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

  useEffect(() => {
    if (workspaceMode !== 'editor' || !editorWorkspaceId) {
      treeLoadedRef.current = null;
      return;
    }
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
    openDeckModal();
  }, [workspaces.length, openDeckModal]);

  const handleSubmitDeck = useCallback(
    async (name: string, workspaceId: string) => {
      if (!workspaceId) {
        setStatusMessage(MESSAGE_SELECT_WORKSPACE);
        return;
      }
      const deck = await handleCreateDeck(name, workspaceId);
      if (deck) {
        closeDeckModal();
      }
    },
    [handleCreateDeck, closeDeckModal]
  );

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

      await response.json();
      setStatusMessage('設定を保存しました。ブラウザをリロードしてください。');

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

  const handleSubmitWorkspace = useCallback(
    async (path: string) => {
      const created = await handleCreateWorkspace(path);
      if (created) {
        closeWorkspaceModal();
      }
    },
    [handleCreateWorkspace, closeWorkspaceModal]
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

  const handleToggleDeck = useCallback((deckId: string, shiftKey = false) => {
    setActiveDeckIds((prev) => {
      if (prev.includes(deckId)) {
        if (prev.length > 1) {
          return prev.filter((id) => id !== deckId);
        }
        return prev;
      } else if (shiftKey) {
        if (prev.length < 3) {
          return [...prev, deckId];
        }
        return [...prev.slice(1), deckId];
      } else {
        return [deckId];
      }
    });
  }, [setActiveDeckIds]);

  const handleCloseDeckTab = useCallback((deckId: string) => {
    setActiveDeckIds((prev) => {
      if (prev.length <= 1) {
        const other = decks.find((d) => d.id !== deckId);
        return other ? [other.id] : prev;
      }
      return prev.filter((id) => id !== deckId);
    });
  }, [decks, setActiveDeckIds]);

  const handleDeckTabMobile = useCallback((deckId: string) => {
    const container = splitContainerRef.current;
    if (!container) return;
    const idx = activeDeckIds.indexOf(deckId);
    if (idx >= 0) {
      container.scrollTo({ left: container.clientWidth * idx, behavior: 'smooth' });
    } else {
      setActiveDeckIds((prev) => [...prev, deckId]);
      requestAnimationFrame(() => {
        const c = splitContainerRef.current;
        if (c) c.scrollTo({ left: c.scrollWidth, behavior: 'smooth' });
      });
    }
  }, [activeDeckIds, setActiveDeckIds]);

  const handleSelectFile = useCallback((fileId: string) => {
    if (!editorWorkspaceId) return;
    updateWorkspaceState(editorWorkspaceId, (state) => ({
      ...state,
      activeFileId: fileId
    }));
  }, [editorWorkspaceId, updateWorkspaceState]);

  const isWorkspaceEditorOpen = workspaceMode === 'editor' && Boolean(editorWorkspaceId);

  const workspaceView = (
    <div className="workspace-view">
      <div className="workspace-start">
        <button
          type="button"
          className="primary-button"
          onClick={openWorkspaceModal}
        >
          {'\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u8ffd\u52a0'}
        </button>
        <WorkspaceList
          workspaces={workspaces}
          selectedWorkspaceId={editorWorkspaceId}
          onSelect={handleSelectWorkspace}
        />
      </div>
      {isWorkspaceEditorOpen && (
        <WorkspaceEditor
          activeWorkspace={activeWorkspace}
          defaultRoot={defaultRoot}
          activeWorkspaceState={activeWorkspaceState}
          editorWorkspaceId={editorWorkspaceId}
          gitState={gitState}
          theme={theme}
          savingFileId={savingFileId}
          onCloseWorkspaceEditor={handleCloseWorkspaceEditor}
          onToggleDir={handleToggleDir}
          onOpenFile={handleOpenFile}
          onRefreshTree={handleRefreshTree}
          onCreateFile={handleCreateFile}
          onCreateDirectory={handleCreateDirectory}
          onDeleteFile={handleDeleteFile}
          onDeleteDirectory={handleDeleteDirectory}
          onRefreshGit={refreshGitStatus}
          onSelectRepo={handleSelectRepo}
          onStageFile={handleStageFile}
          onUnstageFile={handleUnstageFile}
          onStageAll={handleStageAll}
          onUnstageAll={handleUnstageAll}
          onCommit={handleCommit}
          onDiscardFile={handleDiscardFile}
          onShowDiff={handleShowDiff}
          onCloseDiff={handleCloseDiff}
          onPush={handlePush}
          onPull={handlePull}
          onLoadBranches={handleLoadBranches}
          onCheckoutBranch={handleCheckoutBranch}
          onCreateBranch={handleCreateBranch}
          onLoadLogs={handleLoadLogs}
          onSelectFile={handleSelectFile}
          onCloseFile={handleCloseFile}
          onChangeFile={handleFileChange}
          onSaveFile={handleSaveFile}
        />
      )}
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
                onClick={(e) => {
                  if (splitContainerRef.current && splitContainerRef.current.offsetWidth < splitContainerRef.current.scrollWidth + 2) {
                    handleDeckTabMobile(deck.id);
                  } else {
                    handleToggleDeck(deck.id, e.shiftKey);
                  }
                }}
                title={`${workspaceById.get(deck.workspaceId)?.path || deck.root}\nShift+クリックで分割表示`}
              >
                <span className="deck-tab-name">{deck.name}</span>
                <span
                  className="deck-tab-close"
                  role="button"
                  aria-label="閉じる"
                  onClick={(e) => { e.stopPropagation(); handleCloseDeckTab(deck.id); }}
                >
                  ×
                </span>
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
      <div className="terminal-split-container" ref={splitContainerRef} style={{ gridTemplateColumns: `repeat(${activeDeckIds.length}, 1fr)` }}>
        {activeDeckIds.length === 0 ? (
          <div className="panel empty-panel">
            {'デッキを作成してください。'}
          </div>
        ) : (
          activeDeckIds.map((deckId) => {
            const deck = decks.find((d) => d.id === deckId);
            const deckState = deckStates[deckId] || defaultDeckState;
            if (!deck) return null;
            return (
              <div key={deckId} className="deck-split-pane">
                <div className="deck-split-header">
                  {activeDeckIds.length > 1 && <span className="deck-split-title">{deck.name}</span>}
                  <div className="deck-split-actions">
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
        onOpenSettings={openSettingsModal}
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
        onClose={closeWorkspaceModal}
      />
      <DeckModal
        isOpen={isDeckModalOpen}
        workspaces={workspaces}
        onSubmit={handleSubmitDeck}
        onClose={closeDeckModal}
      />
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={closeSettingsModal}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
