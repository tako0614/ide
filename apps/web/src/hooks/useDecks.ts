import { useCallback, useEffect, useState } from 'react';
import type { Deck } from '../types';
import {
  listDecks,
  createDeck as apiCreateDeck,
  createTerminal as apiCreateTerminal,
  deleteTerminal as apiDeleteTerminal,
  listTerminals
} from '../api';
import { getErrorMessage, createEmptyDeckState } from '../utils';

interface UseDecksProps {
  setStatusMessage: (message: string) => void;
  initializeDeckStates: (deckIds: string[]) => void;
  updateDeckState: (deckId: string, updater: (state: import('../types').DeckState) => import('../types').DeckState) => void;
  deckStates: Record<string, import('../types').DeckState>;
  setDeckStates: React.Dispatch<React.SetStateAction<Record<string, import('../types').DeckState>>>;
  initialDeckIds?: string[];
}

export const useDecks = ({
  setStatusMessage,
  initializeDeckStates,
  updateDeckState,
  deckStates,
  setDeckStates,
  initialDeckIds
}: UseDecksProps) => {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [activeDeckIds, setActiveDeckIds] = useState<string[]>(initialDeckIds ?? []);

  useEffect(() => {
    let alive = true;
    listDecks()
      .then((data) => {
        if (!alive) return;
        setDecks(data);
        initializeDeckStates(data.map((deck) => deck.id));
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setStatusMessage(
          `デッキを取得できませんでした: ${getErrorMessage(error)}`
        );
      });

    return () => {
      alive = false;
    };
  }, [setStatusMessage, initializeDeckStates]);

  useEffect(() => {
    // Don't do anything until decks are loaded
    if (decks.length === 0) {
      return;
    }
    // Filter out invalid deck IDs
    const validIds = activeDeckIds.filter((id) => decks.some((deck) => deck.id === id));
    // If all IDs are valid, keep them
    if (validIds.length === activeDeckIds.length && validIds.length > 0) {
      return;
    }
    // If we have some valid IDs, use them; otherwise fall back to first deck
    if (validIds.length > 0) {
      setActiveDeckIds(validIds);
    } else if (decks[0]) {
      setActiveDeckIds([decks[0].id]);
    }
  }, [decks, activeDeckIds]);

  // Load terminals for all active decks
  useEffect(() => {
    activeDeckIds.forEach((deckId) => {
      const current = deckStates[deckId];
      if (current?.terminalsLoaded) return;
      listTerminals(deckId)
        .then((sessions) => {
          updateDeckState(deckId, (state) => ({
            ...state,
            terminals: sessions,
            terminalsLoaded: true
          }));
        })
        .catch((error: unknown) => {
          updateDeckState(deckId, (state) => ({
            ...state,
            terminalsLoaded: true
          }));
          setStatusMessage(
            `ターミナルを取得できませんでした: ${getErrorMessage(error)}`
          );
        });
    });
  }, [activeDeckIds, deckStates, updateDeckState, setStatusMessage]);

  const handleCreateDeck = useCallback(
    async (name: string, workspaceId: string) => {
      try {
        const deck = await apiCreateDeck(name, workspaceId);
        setDecks((prev) => [...prev, deck]);
        setActiveDeckIds((prev) => [...prev.filter((id) => id !== deck.id), deck.id]);
        setDeckStates((prev) => ({
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

  const handleCreateTerminal = useCallback(
    async (deckId: string, terminalsCount: number, command?: string, customTitle?: string) => {
      try {
        const index = terminalsCount + 1;
        const title = customTitle || `ターミナル ${index}`;
        const session = await apiCreateTerminal(deckId, title, command);
        updateDeckState(deckId, (state) => {
          const terminal = {
            id: session.id,
            title: session.title || title
          };
          return {
            ...state,
            terminals: [...state.terminals, terminal],
            terminalsLoaded: true
          };
        });
      } catch (error: unknown) {
        setStatusMessage(
          `ターミナルを起動できませんでした: ${getErrorMessage(error)}`
        );
      }
    },
    [updateDeckState, setStatusMessage]
  );

  const handleDeleteTerminal = useCallback(
    async (deckId: string, terminalId: string) => {
      try {
        await apiDeleteTerminal(terminalId);
        updateDeckState(deckId, (state) => ({
          ...state,
          terminals: state.terminals.filter((t) => t.id !== terminalId)
        }));
      } catch (error: unknown) {
        setStatusMessage(
          `ターミナルを削除できませんでした: ${getErrorMessage(error)}`
        );
      }
    },
    [updateDeckState, setStatusMessage]
  );

  return {
    decks,
    activeDeckIds,
    setActiveDeckIds,
    handleCreateDeck,
    handleCreateTerminal,
    handleDeleteTerminal
  };
};
