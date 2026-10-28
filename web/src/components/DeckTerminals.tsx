import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { TerminalPane } from './TerminalPane';
import { TerminalSwitcher } from './TerminalSwitcher';
import { TerminalKeyBar } from './TerminalKeyBar';
import { resolveActiveTerminalId } from '../utils/stateUtils';
import type { Deck, DeckState } from '../types';

interface DeckTerminalsProps {
  deck: Deck;
  deckState: DeckState;
  wsBase: string;
  liveTitles: Record<string, string | null>;
  // Show the deck name in the header (used in split view to disambiguate panes).
  showName?: boolean;
  onNewTerminal: (deckId: string) => void;
  onSetActiveTerminal: (deckId: string, terminalId: string) => void;
  onDeleteTerminal: (deckId: string, terminalId: string) => void;
  onExitTerminal: (deckId: string, terminalId: string) => void;
  onTerminalTitle: (terminalId: string, title: string | null) => void;
  // 指定された場合、デッキ画面ヘッダにデッキ削除ボタンを出す（破壊的操作を
  // ナビから外しデッキ画面側に集約するため）。
  onDeleteDeck?: () => void;
}

// One deck's terminal surface: header (name + terminal switcher + add-terminal
// button) over the TerminalPane.
export function DeckTerminals({
  deck,
  deckState,
  wsBase,
  liveTitles,
  showName,
  onNewTerminal,
  onSetActiveTerminal,
  onDeleteTerminal,
  onExitTerminal,
  onTerminalTitle,
  onDeleteDeck,
}: DeckTerminalsProps) {
  // Maximize a single terminal (show only the active one full-size) instead of
  // the auto grid — same single-view path used on mobile, on demand on desktop.
  // The toggle button now lives on each terminal tile (TerminalPane), but the
  // on/off state stays here so the deck header can surface the switcher.
  const [maximized, setMaximized] = useState(false);
  // 端末が1つ以下になったら最大化を解除（ボタンが消えて操作不能になり、
  // 単一ビューに取り残されるのを防ぐ）。
  useEffect(() => {
    if (maximized && deckState.terminals.length <= 1) {
      setMaximized(false);
    }
  }, [maximized, deckState.terminals.length]);
  const setActiveTerminal = useCallback((terminalId: string) => onSetActiveTerminal(deck.id, terminalId), [deck.id, onSetActiveTerminal]);
  const newTerminal = useCallback(() => onNewTerminal(deck.id), [deck.id, onNewTerminal]);
  const deleteTerminal = useCallback((terminalId: string) => onDeleteTerminal(deck.id, terminalId), [deck.id, onDeleteTerminal]);
  const exitTerminal = useCallback((terminalId: string) => onExitTerminal(deck.id, terminalId), [deck.id, onExitTerminal]);
  const toggleMaximize = useCallback(() => setMaximized((m) => !m), []);
  return (
    <>
      <div className={clsx('flex items-center justify-between px-2 py-1 border-b border-border bg-sidebar gap-2 min-h-[28px]', maximized && 'deck-terminals-single')}>
        {showName && (
          <span className="deck-pane-name flex-1 min-w-0 text-[11px] font-semibold text-ink-muted overflow-hidden text-ellipsis whitespace-nowrap">
            {deck.name}
          </span>
        )}
        {deckState.terminals.length > 0 && (
          <TerminalSwitcher
            terminals={deckState.terminals}
            liveTitles={liveTitles}
            value={resolveActiveTerminalId(deckState.terminals, deckState.activeTerminalId) ?? ''}
            onChange={setActiveTerminal}
          />
        )}
        <div className="flex items-center gap-1 ml-auto">
          <button type="button" className="topbar-btn-sm" onClick={() => onNewTerminal(deck.id)} title="ターミナルを追加" aria-label="ターミナルを追加">
            ＋ 端末
          </button>
          {onDeleteDeck && (
            <button type="button" className="topbar-btn-sm topbar-btn-danger" onClick={onDeleteDeck} title="このデッキを削除" aria-label="このデッキを削除">
              🗑
            </button>
          )}
        </div>
      </div>
      <TerminalPane
        terminals={deckState.terminals}
        wsBase={wsBase}
        activeTerminalId={deckState.activeTerminalId ?? null}
        singleView={maximized}
        onSetActiveTerminal={setActiveTerminal}
        onToggleMaximize={toggleMaximize}
        onNewTerminal={newTerminal}
        onDeleteTerminal={deleteTerminal}
        onExitTerminal={exitTerminal}
        onTerminalTitle={onTerminalTitle}
      />
      {deckState.terminals.length > 0 && (
        <TerminalKeyBar terminalId={resolveActiveTerminalId(deckState.terminals, deckState.activeTerminalId) ?? null} />
      )}
    </>
  );
}
