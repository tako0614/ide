import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import clsx from 'clsx';
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

const MAX_ACTIVE_DECKS = 3;
const DECK_ORDER_STORAGE_KEY = 'deck-ide.deck-order';

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function moveItemBefore(items: string[], source: string, target: string) {
  const sourceIndex = items.indexOf(source);
  const targetIndex = items.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return items;
  }
  const next = [...items];
  next.splice(sourceIndex, 1);
  const insertionIndex = next.indexOf(target);
  next.splice(insertionIndex, 0, source);
  return next;
}

function readDeckOrderFromStorage() {
  if (typeof window === 'undefined') return [];
  try {
    const rawValue = window.localStorage.getItem(DECK_ORDER_STORAGE_KEY);
    if (!rawValue) return [];
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

export default function App() {
  const initialUrlState = parseUrlState();
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const ignoreNextDeckClickRef = useRef(false);
  const [view, setView] = useState<AppView>(initialUrlState.view);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    initialUrlState.workspaceMode
  );
  const [defaultRoot, setDefaultRoot] = useState(DEFAULT_ROOT_FALLBACK);
  const [statusMessage, setStatusMessage] = useState('');
  const [deckOrderIds, setDeckOrderIds] = useState<string[]>(() =>
    readDeckOrderFromStorage()
  );
  const [draggingDeckId, setDraggingDeckId] = useState<string | null>(null);
  const [dragOverDeckId, setDragOverDeckId] = useState<string | null>(null);
  const [isSplitDropTargetActive, setIsSplitDropTargetActive] = useState(false);
  const [isDesktopDragEnabled, setIsDesktopDragEnabled] = useState(false);

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
  const orderedDecks = useMemo(() => {
    const deckById = new Map(decks.map((deck) => [deck.id, deck]));
    const inOrder = deckOrderIds
      .map((deckId) => deckById.get(deckId))
      .filter((deck): deck is (typeof decks)[number] => deck !== undefined);
    if (inOrder.length === decks.length) {
      return inOrder;
    }
    const inOrderSet = new Set(inOrder.map((deck) => deck.id));
    return [...inOrder, ...decks.filter((deck) => !inOrderSet.has(deck.id))];
  }, [decks, deckOrderIds]);

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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(pointer: fine) and (min-width: 721px)');
    const syncDragCapability = () => setIsDesktopDragEnabled(mediaQuery.matches);
    syncDragCapability();
    mediaQuery.addEventListener('change', syncDragCapability);
    return () => mediaQuery.removeEventListener('change', syncDragCapability);
  }, []);

  useEffect(() => {
    const validDeckIds = decks.map((deck) => deck.id);
    setDeckOrderIds((prev) => {
      const filtered = prev.filter((deckId) => validDeckIds.includes(deckId));
      const missing = validDeckIds.filter((deckId) => !filtered.includes(deckId));
      const next = [...filtered, ...missing];
      return arraysEqual(next, prev) ? prev : next;
    });
  }, [decks]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (deckOrderIds.length === 0) {
      window.localStorage.removeItem(DECK_ORDER_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(DECK_ORDER_STORAGE_KEY, JSON.stringify(deckOrderIds));
  }, [deckOrderIds]);

  const resetDeckDragState = useCallback(() => {
    setDraggingDeckId(null);
    setDragOverDeckId(null);
    setIsSplitDropTargetActive(false);
  }, []);

  const suppressNextDeckClick = useCallback(() => {
    ignoreNextDeckClickRef.current = true;
    window.setTimeout(() => {
      ignoreNextDeckClickRef.current = false;
    }, 100);
  }, []);

  useEffect(() => {
    if (!isDesktopDragEnabled) {
      resetDeckDragState();
    }
  }, [isDesktopDragEnabled, resetDeckDragState]);

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

  const handleSelectDeck = useCallback((deckId: string) => {
    if (ignoreNextDeckClickRef.current) {
      ignoreNextDeckClickRef.current = false;
      return;
    }
    setActiveDeckIds([deckId]);
  }, [setActiveDeckIds]);

  const handleSplitDeck = useCallback((deckId: string) => {
    setActiveDeckIds((prev) => {
      const next = [...prev.filter((id) => id !== deckId), deckId];
      if (next.length <= MAX_ACTIVE_DECKS) {
        return next;
      }
      return next.slice(next.length - MAX_ACTIVE_DECKS);
    });
  }, [setActiveDeckIds]);

  const handleCloseDeckTab = useCallback((deckId: string) => {
    setActiveDeckIds((prev) => {
      if (prev.length <= 1) {
        const other = orderedDecks.find((d) => d.id !== deckId);
        return other ? [other.id] : prev;
      }
      return prev.filter((id) => id !== deckId);
    });
  }, [orderedDecks, setActiveDeckIds]);

  const handleDeckTabDragStart = useCallback((event: ReactDragEvent<HTMLButtonElement>, deckId: string) => {
    if (!isDesktopDragEnabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', deckId);
    setDraggingDeckId(deckId);
    setDragOverDeckId(null);
    setIsSplitDropTargetActive(false);
  }, [isDesktopDragEnabled]);

  const handleDeckTabDragOver = useCallback((event: ReactDragEvent<HTMLButtonElement>, deckId: string) => {
    if (!isDesktopDragEnabled || !draggingDeckId || draggingDeckId === deckId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverDeckId(deckId);
    setIsSplitDropTargetActive(false);
  }, [isDesktopDragEnabled, draggingDeckId]);

  const handleDeckTabDragLeave = useCallback((event: ReactDragEvent<HTMLButtonElement>, deckId: string) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setDragOverDeckId((prev) => (prev === deckId ? null : prev));
  }, []);

  const handleDeckTabDrop = useCallback((event: ReactDragEvent<HTMLButtonElement>, deckId: string) => {
    if (!isDesktopDragEnabled) return;
    event.preventDefault();
    const sourceDeckId = draggingDeckId || event.dataTransfer.getData('text/plain');
    if (!sourceDeckId || sourceDeckId === deckId) {
      resetDeckDragState();
      return;
    }
    setDeckOrderIds((prev) => moveItemBefore(prev, sourceDeckId, deckId));
    setActiveDeckIds((prev) => moveItemBefore(prev, sourceDeckId, deckId));
    suppressNextDeckClick();
    resetDeckDragState();
  }, [draggingDeckId, isDesktopDragEnabled, resetDeckDragState, setActiveDeckIds, suppressNextDeckClick]);

  const handleSplitContainerDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isDesktopDragEnabled || !draggingDeckId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setIsSplitDropTargetActive(true);
  }, [isDesktopDragEnabled, draggingDeckId]);

  const handleSplitContainerDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsSplitDropTargetActive(false);
  }, []);

  const handleSplitContainerDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isDesktopDragEnabled) return;
    event.preventDefault();
    const sourceDeckId = draggingDeckId || event.dataTransfer.getData('text/plain');
    if (!sourceDeckId) {
      resetDeckDragState();
      return;
    }
    handleSplitDeck(sourceDeckId);
    suppressNextDeckClick();
    resetDeckDragState();
  }, [draggingDeckId, handleSplitDeck, isDesktopDragEnabled, resetDeckDragState, suppressNextDeckClick]);

  const handleSelectFile = useCallback((fileId: string) => {
    if (!editorWorkspaceId) return;
    updateWorkspaceState(editorWorkspaceId, (state) => ({
      ...state,
      activeFileId: fileId
    }));
  }, [editorWorkspaceId, updateWorkspaceState]);

  const isWorkspaceEditorOpen = workspaceMode === 'editor' && Boolean(editorWorkspaceId);

  const workspaceView = (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex flex-col items-center gap-4 p-6 flex-shrink-0 border-b border-border">
        <button
          type="button"
          className="bg-accent text-white border-0 px-3.5 py-1.5 text-[13px] font-medium rounded-[2px] cursor-pointer hover:opacity-90"
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
            {orderedDecks.map((deck) => (
              <button
                key={deck.id}
                type="button"
                className={clsx('deck-tab', activeDeckIds.includes(deck.id) && 'active', draggingDeckId === deck.id && 'is-dragging', dragOverDeckId === deck.id && 'is-drag-over')}
                onClick={() => handleSelectDeck(deck.id)}
                draggable={isDesktopDragEnabled}
                onDragStart={(event) => handleDeckTabDragStart(event, deck.id)}
                onDragOver={(event) => handleDeckTabDragOver(event, deck.id)}
                onDragLeave={(event) => handleDeckTabDragLeave(event, deck.id)}
                onDrop={(event) => handleDeckTabDrop(event, deck.id)}
                onDragEnd={resetDeckDragState}
                title={isDesktopDragEnabled
                  ? `${workspaceById.get(deck.workspaceId)?.path || deck.root}\nドラッグで並び替え / メインにドロップで分割表示`
                  : `${workspaceById.get(deck.workspaceId)?.path || deck.root}`
                }
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
      <div
        className={clsx('terminal-split-container', isSplitDropTargetActive && 'is-drop-target')}
        ref={splitContainerRef}
        style={{ gridTemplateColumns: `repeat(${activeDeckIds.length}, 1fr)` }}
        onDragOver={handleSplitContainerDragOver}
        onDragLeave={handleSplitContainerDragLeave}
        onDrop={handleSplitContainerDrop}
      >
        {activeDeckIds.length === 0 ? (
          <div className="panel flex items-center justify-center text-muted text-[13px] p-5">
            {'デッキを作成してください。'}
          </div>
        ) : (
          activeDeckIds.map((deckId) => {
            const deck = decks.find((d) => d.id === deckId);
            const deckState = deckStates[deckId] || defaultDeckState;
            if (!deck) return null;
            return (
              <div key={deckId} className="deck-split-pane">
                <div className="flex items-center justify-between px-2 py-1 border-b border-border bg-sidebar gap-2 min-h-[28px]">
                  {activeDeckIds.length > 1 && <span className="flex-1 min-w-0 text-[11px] font-semibold text-ink-muted overflow-hidden text-ellipsis whitespace-nowrap">{deck.name}</span>}
                  <div className="flex items-center gap-1 ml-auto">
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
