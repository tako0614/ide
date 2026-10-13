import { useCallback, useEffect, useState } from 'react';
import type { Deck } from '../types';
import {
  listDecks,
  createDeck as apiCreateDeck,
  deleteDeck as apiDeleteDeck,
  saveDeckOrder as apiSaveDeckOrder,
  createTerminal as apiCreateTerminal,
  deleteTerminal as apiDeleteTerminal,
  listTerminals
} from '../api';
import { getErrorMessage, createEmptyDeckState } from '../utils';
import { subscribeServerEvents } from '../serverEvents';
import type { DeckState } from '../types';

function withoutTerminal(state: DeckState, terminalId: string): DeckState {
  if (!state.terminals.some((t) => t.id === terminalId)) return state;
  const terminals = state.terminals.filter((t) => t.id !== terminalId);
  // 削除したのがアクティブ端末なら、残りの末尾（最新）にフォールバック。
  const activeTerminalId =
    state.activeTerminalId === terminalId
      ? terminals[terminals.length - 1]?.id ?? null
      : state.activeTerminalId;
  return { ...state, terminals, activeTerminalId };
}

interface UseDecksProps {
  setStatusMessage: (message: string) => void;
  initializeDeckStates: (deckIds: string[]) => void;
  updateDeckState: (deckId: string, updater: (state: import('../types').DeckState) => import('../types').DeckState) => void;
  setDeckStates: React.Dispatch<React.SetStateAction<Record<string, import('../types').DeckState>>>;
  initialDeckIds?: string[];
}

export const useDecks = ({
  setStatusMessage,
  initializeDeckStates,
  updateDeckState,
  setDeckStates,
  initialDeckIds
}: UseDecksProps) => {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [activeDeckIds, setActiveDeckIds] = useState<string[]>(initialDeckIds ?? []);

  useEffect(() => {
    let alive = true;
    const loadAll = () => {
      listDecks()
        .then((data) => {
          if (!alive) return;
          setDecks(data);
          initializeDeckStates(data.map((deck) => deck.id));
          // Load terminals for all decks upfront
          data.forEach((deck) => {
            listTerminals(deck.id)
              .then((sessions) => {
                if (!alive) return;
                updateDeckState(deck.id, (state) => ({
                  ...state,
                  terminals: sessions.map(({ id, title, createdAt }) => ({ id, title, createdAt })),
                  // 既存の選択を尊重しつつ、未設定なら先頭端末をアクティブに。
                  activeTerminalId:
                    state.activeTerminalId &&
                    sessions.some((s) => s.id === state.activeTerminalId)
                      ? state.activeTerminalId
                      : sessions[0]?.id ?? null
                }));
              })
              .catch(() => undefined); // silent — deck just shows empty until retry
          });
        })
        .catch((error: unknown) => {
          if (!alive) return;
          setStatusMessage(`デッキを取得できませんでした: ${getErrorMessage(error)}`);
        });
    };
    loadAll();

    // Decks and terminals created or closed elsewhere — another browser, the
    // `deckide` CLI, an MCP agent — appear here without a reload.
    const unsubscribe = subscribeServerEvents((event) => {
      if (!alive) return;
      switch (event.type) {
        case 'resync':
          loadAll();
          return;
        case 'deck.created':
          setDecks((prev) => (prev.some((d) => d.id === event.deck.id) ? prev : [...prev, event.deck]));
          initializeDeckStates([event.deck.id]);
          return;
        case 'deck.deleted':
          setDecks((prev) => prev.filter((d) => d.id !== event.deckId));
          setActiveDeckIds((prev) => prev.filter((id) => id !== event.deckId));
          setDeckStates((prev) => {
            if (!(event.deckId in prev)) return prev;
            const next = { ...prev };
            delete next[event.deckId];
            return next;
          });
          return;
        case 'decks.reordered':
          setDecks((prev) => {
            const byId = new Map(prev.map((d) => [d.id, d]));
            const ordered = event.deckIds.map((id) => byId.get(id)).filter((d): d is Deck => Boolean(d));
            const rest = prev.filter((d) => !event.deckIds.includes(d.id));
            return [...ordered, ...rest];
          });
          return;
        case 'terminal.created':
          updateDeckState(event.deckId, (state) =>
            state.terminals.some((t) => t.id === event.terminal.id)
              ? state
              : {
                  ...state,
                  terminals: [...state.terminals, event.terminal],
                  activeTerminalId: state.activeTerminalId ?? event.terminal.id
                }
          );
          return;
        case 'terminal.removed':
          updateDeckState(event.deckId, (state) => withoutTerminal(state, event.terminalId));
          return;
        case 'ui.focus':
          setActiveDeckIds((prev) => (prev.includes(event.deckId) ? prev : [event.deckId]));
          if (event.terminalId) {
            const terminalId = event.terminalId;
            updateDeckState(event.deckId, (state) => ({ ...state, activeTerminalId: terminalId }));
          }
          return;
        default:
          return;
      }
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [setStatusMessage, initializeDeckStates, updateDeckState, setDeckStates]);

  useEffect(() => {
    if (decks.length === 0) return;
    const validIds = activeDeckIds.filter((id) => decks.some((deck) => deck.id === id));
    if (validIds.length === activeDeckIds.length && validIds.length > 0) return;
    if (validIds.length > 0) {
      setActiveDeckIds(validIds);
    } else if (decks[0]) {
      setActiveDeckIds([decks[0].id]);
    }
  }, [decks, activeDeckIds]);

  const handleCreateDeck = useCallback(
    async (name: string, workspaceId: string) => {
      try {
        const deck = await apiCreateDeck(name, workspaceId);
        // The deck.created event may have arrived first.
        setDecks((prev) => (prev.some((d) => d.id === deck.id) ? prev : [...prev, deck]));
        setActiveDeckIds((prev) => [...prev.filter((id) => id !== deck.id), deck.id]);
        setDeckStates((prev) => (prev[deck.id] ? prev : {
          ...prev,
          [deck.id]: createEmptyDeckState()
        }));
        return deck;
      } catch (error: unknown) {
        setStatusMessage(
          `デッキの作成に失敗しました: ${getErrorMessage(error)}`
        );
        return null;
      }
    },
    [setStatusMessage, setDeckStates]
  );

  const handleDeleteDeck = useCallback(
    async (deckId: string) => {
      try {
        await apiDeleteDeck(deckId);
        setDecks((prev) => prev.filter((d) => d.id !== deckId));
        setActiveDeckIds((prev) => prev.filter((id) => id !== deckId));
        setDeckStates((prev) => {
          const next = { ...prev };
          delete next[deckId];
          return next;
        });
      } catch (error: unknown) {
        setStatusMessage(
          `\u30c7\u30c3\u30ad\u306e\u524a\u9664\u306b\u5931\u6557\u3057\u307e\u3057\u305f: ${getErrorMessage(error)}`
        );
      }
    },
    [setStatusMessage, setDeckStates]
  );

  const handleReorderDecks = useCallback(
    (reorder: (prev: Deck[]) => Deck[]) => {
      setDecks((prev) => {
        const next = reorder(prev);
        apiSaveDeckOrder(next.map((d) => d.id)).catch(() => undefined);
        return next;
      });
    },
    []
  );

  const handleCreateTerminal = useCallback(
    async (deckId: string, _terminalsCount: number, command?: string, customTitle?: string) => {
      try {
        const session = await apiCreateTerminal(deckId, customTitle, command);
        updateDeckState(deckId, (state) => ({
          ...state,
          // The terminal.created event may have added it already.
          terminals: state.terminals.some((t) => t.id === session.id)
            ? state.terminals
            : [...state.terminals, { id: session.id, title: session.title }],
          // 新規端末は作成と同時にアクティブにする（新しいタブを開く挙動）。
          activeTerminalId: session.id
        }));
        return session;
      } catch (error: unknown) {
        setStatusMessage(
          `ターミナルを起動できませんでした: ${getErrorMessage(error)}`
        );
        return null;
      }
    },
    [updateDeckState, setStatusMessage]
  );

  const handleDeleteTerminal = useCallback(
    async (deckId: string, terminalId: string) => {
      try {
        await apiDeleteTerminal(terminalId);
        updateDeckState(deckId, (state) => withoutTerminal(state, terminalId));
      } catch (error: unknown) {
        setStatusMessage(
          `ターミナルを削除できませんでした: ${getErrorMessage(error)}`
        );
      }
    },
    [updateDeckState, setStatusMessage]
  );

  const handleRemoveTerminalLocal = useCallback(
    (deckId: string, terminalId: string) => {
      updateDeckState(deckId, (state) => withoutTerminal(state, terminalId));
    },
    [updateDeckState]
  );

  return {
    decks,
    activeDeckIds,
    setActiveDeckIds,
    handleCreateDeck,
    handleDeleteDeck,
    handleReorderDecks,
    handleCreateTerminal,
    handleDeleteTerminal,
    handleRemoveTerminalLocal
  };
};
