import { useCallback, useState } from 'react';
import type { DeckState } from '../types';
import { createEmptyDeckState } from '../utils';

export const useDeckState = () => {
  const [deckStates, setDeckStates] = useState<Record<string, DeckState>>({});

  const updateDeckState = useCallback(
    (deckId: string, updater: (state: DeckState) => DeckState) => {
      setDeckStates((prev) => {
        const current = prev[deckId] || createEmptyDeckState();
        return { ...prev, [deckId]: updater(current) };
      });
    },
    []
  );

  const initializeDeckStates = useCallback((deckIds: string[]) => {
    setDeckStates((prev) => {
      const next = { ...prev };
      deckIds.forEach((id) => {
        if (!next[id]) {
          next[id] = createEmptyDeckState();
        }
      });
      return next;
    });
  }, []);

  return {
    deckStates,
    setDeckStates,
    updateDeckState,
    initializeDeckStates
  };
};
