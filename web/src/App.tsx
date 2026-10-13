import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import clsx from 'clsx';
import { DeckModal } from './components/DeckModal';
import { StatusMessage } from './components/StatusMessage';
import { WorkspaceModal } from './components/WorkspaceModal';
import { DeckTerminals } from './components/DeckTerminals';
import { SettingsModal } from './components/SettingsModal';
import { DesktopPane } from './components/DesktopPane';
import { AgentSessionsPane } from './components/AgentSessionsPane';
import { apiJson, AUTH_SESSION_REFRESH_EVENT, getConfig, getWsBase, saveDeckOrder } from './api';
import { AuthGate } from './components/AuthGate';
import { useWorkspaceState } from './hooks/useWorkspaceState';
import { useDeckState } from './hooks/useDeckState';
import { useWorkspaces } from './hooks/useWorkspaces';
import { useDecks } from './hooks/useDecks';
import { useTheme } from './hooks/useTheme';
import { useModalState } from './hooks/useModalState';
import {
  DEFAULT_ROOT_FALLBACK,
  SAVED_MESSAGE_TIMEOUT,
  MESSAGE_SAVED,
  MESSAGE_SELECT_WORKSPACE
} from './constants';
import { parseUrlState } from './utils/urlUtils';
import { createEmptyDeckState } from './utils/stateUtils';

const MAX_ACTIVE_DECKS = 3;
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

function AuthenticatedApp() {
  const initialUrlState = parseUrlState();
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const ignoreNextDeckClickRef = useRef(false);
  const [defaultRoot, setDefaultRoot] = useState(DEFAULT_ROOT_FALLBACK);
  const [statusMessage, setStatusMessage] = useState('');
  const [draggingDeckId, setDraggingDeckId] = useState<string | null>(null);
  const [dragOverDeckId, setDragOverDeckId] = useState<string | null>(null);
  const [isSplitDropTargetActive, setIsSplitDropTargetActive] = useState(false);
  const [isDesktopDragEnabled, setIsDesktopDragEnabled] = useState(false);
  const [isComputerPaneOpen, setIsComputerPaneOpen] = useState(false);
  const [isAgentSessionsOpen, setIsAgentSessionsOpen] = useState(false);
  const [deckContextMenu, setDeckContextMenu] = useState<{ deckId: string; x: number; y: number } | null>(null);

  const { handleToggleTheme } = useTheme();

  // 端末が OSC 0/2 で設定した動的タイトル（terminalId -> title）。
  // 切替ドロップダウンの表示に使う。
  const [liveTitles, setLiveTitles] = useState<Record<string, string | null>>({});
  const handleTerminalTitle = useCallback((terminalId: string, title: string | null) => {
    setLiveTitles((prev) => {
      if (prev[terminalId] === title) return prev;
      return { ...prev, [terminalId]: title };
    });
  }, []);

  // Track visual viewport height for mobile keyboard visibility.
  // キーボード表示時はアプリ高さがキーボード上の可視領域まで縮むため、
  // そのままだと下部ナビバー(48px)+ステータス(22px)がターミナルを圧迫する。
  // 「観測した最大高さとの差」でキーボード表示を検出し、html.keyboard-open を
  // 付与する。CSS 側でこのときだけ下部バーを畳んでターミナルを最大化する。
  // （interactive-widget=resizes-content では innerHeight も縮むため、
  //  innerHeight - vv.height の差分ではキーボードを検出できない。）
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // キーボード非表示時の基準高さ。回転時は次の resize で再取得する。
    let baseline = vv.height;
    let pendingReset = false;
    const root = document.documentElement;
    const update = () => {
      if (pendingReset) {
        baseline = vv.height;
        pendingReset = false;
      } else if (vv.height > baseline) {
        baseline = vv.height;
      }
      // 150px はソフトキーボードの最小高さ目安。URL バーの開閉(~100px)を
      // キーボードと誤検出しないためのしきい値。
      const keyboardOpen = baseline - vv.height > 150;
      root.style.setProperty('--viewport-height', `${vv.height}px`);
      root.classList.toggle('keyboard-open', keyboardOpen);
    };
    const handleOrientation = () => {
      // 回転で基準高さが変わるので次の更新で取り直す。
      pendingReset = true;
      window.setTimeout(update, 300);
    };
    update();
    vv.addEventListener('resize', update);
    window.addEventListener('orientationchange', handleOrientation);
    return () => {
      vv.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', handleOrientation);
      root.classList.remove('keyboard-open');
    };
  }, []);

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

  const { setWorkspaceStates, initializeWorkspaceStates } =
    useWorkspaceState();
  const { deckStates, setDeckStates, updateDeckState, initializeDeckStates } =
    useDeckState();

  const { workspaces, handleCreateWorkspace } =
    useWorkspaces({
      setStatusMessage,
      defaultRoot,
      initializeWorkspaceStates,
      setWorkspaceStates
    });

  const { decks, activeDeckIds, setActiveDeckIds, handleCreateDeck, handleDeleteDeck, handleReorderDecks, handleCreateTerminal, handleDeleteTerminal, handleRemoveTerminalLocal } =
    useDecks({
      setStatusMessage,
      initializeDeckStates,
      updateDeckState,
      setDeckStates,
      initialDeckIds: initialUrlState.deckIds
    });

  const defaultDeckState = useMemo(() => createEmptyDeckState(), []);
  const wsBase = getWsBase();
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );
  const orderedDecks = decks;

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
    const params = new URLSearchParams(window.location.search);
    params.delete('view');
    params.delete('workspace');
    params.delete('mode');
    if (activeDeckIds.length > 0) params.set('decks', activeDeckIds.join(','));
    else params.delete('decks');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `${window.location.pathname}?${query}` : window.location.pathname);
  }, [activeDeckIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(pointer: fine) and (min-width: 721px)');
    const syncDragCapability = () => setIsDesktopDragEnabled(mediaQuery.matches);
    syncDragCapability();
    mediaQuery.addEventListener('change', syncDragCapability);
    return () => mediaQuery.removeEventListener('change', syncDragCapability);
  }, []);

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

  const handleOpenDeckModal = useCallback(() => {
    if (workspaces.length === 0) {
      openWorkspaceModal();
      return;
    }
    openDeckModal();
  }, [workspaces.length, openDeckModal, openWorkspaceModal]);

  const handleSubmitDeck = useCallback(
    async (name: string, workspaceId: string) => {
      if (!workspaceId) {
        setStatusMessage(MESSAGE_SELECT_WORKSPACE);
        return;
      }
      const deck = await handleCreateDeck(name, workspaceId);
      if (deck) {
        await handleCreateTerminal(deck.id, 0);
        closeDeckModal();
      }
    },
    [handleCreateDeck, handleCreateTerminal, closeDeckModal]
  );

  const handleSaveSettings = useCallback(async (settings: { port: number; authEnabled: boolean; authUser: string; authPassword?: string }) => {
    try {
      const result = await apiJson<{ success: boolean; requiresRestart: boolean; sessionRevoked: boolean }>('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (result.sessionRevoked) {
        window.dispatchEvent(new Event(AUTH_SESSION_REFRESH_EVENT));
      }
      setStatusMessage(MESSAGE_SAVED);
    } catch (error: unknown) {
      console.error('Failed to save settings:', error);
      throw error;
    }
  }, []);

  const handleSubmitWorkspace = useCallback(
    async (path: string) => {
      const created = await handleCreateWorkspace(path);
      if (created) {
        closeWorkspaceModal();
        if (decks.length === 0) {
          const deck = await handleCreateDeck('', created.id);
          if (deck) await handleCreateTerminal(deck.id, 0);
        }
      }
    },
    [handleCreateWorkspace, closeWorkspaceModal, decks.length, handleCreateDeck, handleCreateTerminal]
  );

  const handleNewTerminalForDeck = useCallback((deckId: string) => {
    const deckState = deckStates[deckId] || defaultDeckState;
    handleCreateTerminal(deckId, deckState.terminals.length);
  }, [deckStates, defaultDeckState, handleCreateTerminal]);

  const handleTerminalDeleteForDeck = useCallback(
    (deckId: string, terminalId: string) => {
      handleDeleteTerminal(deckId, terminalId);
    },
    [handleDeleteTerminal]
  );

  const handleTerminalExitForDeck = useCallback(
    (deckId: string, terminalId: string) => {
      handleRemoveTerminalLocal(deckId, terminalId);
    },
    [handleRemoveTerminalLocal]
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

  const handleDeckContextMenu = useCallback((e: React.MouseEvent, deckId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDeckContextMenu({ deckId, x: e.clientX, y: e.clientY });
  }, []);

  const handleDeleteDeckFromMenu = useCallback(() => {
    if (!deckContextMenu) return;
    const { deckId } = deckContextMenu;
    setDeckContextMenu(null);
    if (!window.confirm('\u3053\u306e\u30c7\u30c3\u30ad\u3092\u5b8c\u5168\u306b\u524a\u9664\u3057\u307e\u3059\u304b\uff1f\n\u30bf\u30fc\u30df\u30ca\u30eb\u3082\u3059\u3079\u3066\u524a\u9664\u3055\u308c\u307e\u3059\u3002')) return;
    handleDeleteDeck(deckId);
  }, [deckContextMenu, handleDeleteDeck]);

  const closeDeckContextMenu = useCallback(() => {
    setDeckContextMenu(null);
  }, []);

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
    handleReorderDecks((prev) => {
      const ids = prev.map((d) => d.id);
      const reordered = moveItemBefore(ids, sourceDeckId, deckId);
      const deckById = new Map(prev.map((d) => [d.id, d]));
      return reordered.map((id) => deckById.get(id)!);
    });
    setActiveDeckIds((prev) => moveItemBefore(prev, sourceDeckId, deckId));
    suppressNextDeckClick();
    resetDeckDragState();
  }, [draggingDeckId, isDesktopDragEnabled, resetDeckDragState, setActiveDeckIds, suppressNextDeckClick, handleReorderDecks]);

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
                onClick={() => {
                  setIsAgentSessionsOpen(false);
                  handleSelectDeck(deck.id);
                }}
                onContextMenu={(e) => handleDeckContextMenu(e, deck.id)}
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
        <div className="shell-toolbar-actions">
          <button
            type="button"
            className={clsx('topbar-btn-sm', isAgentSessionsOpen && 'codex-toolbar-active')}
            onClick={() => setIsAgentSessionsOpen((open) => !open)}
            aria-expanded={isAgentSessionsOpen}
          >
            AIセッション
          </button>
          <button type="button" className="topbar-btn-sm" onClick={openWorkspaceModal} title="作業ディレクトリを登録" aria-label="作業ディレクトリを登録">⌂＋</button>
          <button type="button" className="topbar-btn-sm" onClick={handleToggleTheme} title="テーマ切替" aria-label="テーマ切替">◐</button>
          <button
            type="button"
            className={clsx('topbar-btn-sm', isComputerPaneOpen && 'computer-toolbar-button-active')}
            onClick={() => setIsComputerPaneOpen((open) => !open)}
            title="デスクトップ"
            aria-label="デスクトップ"
            aria-expanded={isComputerPaneOpen}
          >
            ▣
          </button>
          <button type="button" className="topbar-btn-sm" onClick={openSettingsModal} title="設定" aria-label="設定">⚙</button>
        </div>
      </div>
      <div
        className={clsx('terminal-split-container', isSplitDropTargetActive && 'is-drop-target')}
        hidden={isAgentSessionsOpen}
        ref={splitContainerRef}
        style={{ gridTemplateColumns: `repeat(${activeDeckIds.length}, minmax(0, 1fr))` }}
        onDragOver={handleSplitContainerDragOver}
        onDragLeave={handleSplitContainerDragLeave}
        onDrop={handleSplitContainerDrop}
      >
        {activeDeckIds.length === 0 ? (
          <div className="panel flex flex-col items-center justify-center gap-3 text-muted text-[13px] p-5">
            <span>{workspaces.length === 0 ? '作業ディレクトリを登録して shell を作成してください。' : 'shell を作成してください。'}</span>
            {workspaces.length === 0 ? (
              <button type="button" className="bg-accent text-white border-0 px-3.5 py-1.5 text-[13px] font-medium rounded-[2px] cursor-pointer hover:opacity-90" onClick={openWorkspaceModal}>
                作業ディレクトリを登録
              </button>
            ) : (
              <button type="button" className="bg-accent text-white border-0 px-3.5 py-1.5 text-[13px] font-medium rounded-[2px] cursor-pointer hover:opacity-90" onClick={handleOpenDeckModal}>
                shell を作成
              </button>
            )}
          </div>
        ) : (
          activeDeckIds.map((deckId) => {
            const deck = decks.find((d) => d.id === deckId);
            const deckState = deckStates[deckId] || defaultDeckState;
            if (!deck) return null;
            return (
              <div key={deckId} className="deck-split-pane">
                <DeckTerminals
                  deck={deck}
                  deckState={deckState}
                  wsBase={wsBase}
                  liveTitles={liveTitles}
                  showName={activeDeckIds.length > 1}
                  onNewTerminal={handleNewTerminalForDeck}
                  onSetActiveTerminal={(id, terminalId) => updateDeckState(id, (s) => ({ ...s, activeTerminalId: terminalId }))}
                  onDeleteTerminal={handleTerminalDeleteForDeck}
                  onExitTerminal={handleTerminalExitForDeck}
                  onTerminalTitle={handleTerminalTitle}
                />
              </div>
            );
          })
        )}
      </div>
      {isAgentSessionsOpen && (
        <AgentSessionsPane
          decks={decks}
          activeDeckId={activeDeckIds[0]}
          onClose={() => setIsAgentSessionsOpen(false)}
          onTerminal={({ id, deckId }) => {
            setActiveDeckIds([deckId]);
            updateDeckState(deckId, (state) => ({ ...state, activeTerminalId: id }));
            setIsAgentSessionsOpen(false);
          }}
          onResume={async (task, deckId) => {
            if (!task.resumeCommand) throw new Error('このタスクはCLIで再開できません。');
            const created = await handleCreateTerminal(
              deckId,
              (deckStates[deckId] || defaultDeckState).terminals.length,
              task.resumeCommand,
              `${task.tool} · ${task.title}`
            );
            if (!created) throw new Error('ターミナルで再開できませんでした。');
            setActiveDeckIds([deckId]);
            setIsAgentSessionsOpen(false);
          }}
        />
      )}
    </div>
  );

  return (
    <div className="app shell-only-app" data-view="terminal">
      <main className="main">
        <div className="computer-shell-layout">
          <div className="computer-shell-main">{terminalView}</div>
          {isComputerPaneOpen && <DesktopPane onClose={() => setIsComputerPaneOpen(false)} />}
        </div>
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
      {deckContextMenu && (
        <>
          <div className="fixed inset-0 z-[999]" onClick={closeDeckContextMenu} onContextMenu={(e) => { e.preventDefault(); closeDeckContextMenu(); }} />
          <div
            className="fixed z-[1000] bg-panel border border-border shadow-lg rounded-[2px] py-1 min-w-[140px]"
            style={{ left: deckContextMenu.x, top: deckContextMenu.y }}
          >
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 text-[13px] text-red-400 bg-transparent border-0 cursor-pointer hover:bg-list-hover"
              onClick={handleDeleteDeckFromMenu}
            >
              {'\u30c7\u30c3\u30ad\u3092\u524a\u9664'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function App() {
  return <AuthGate><AuthenticatedApp /></AuthGate>;
}
