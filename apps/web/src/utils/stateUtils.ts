/**
 * State management utilities
 */

import type { WorkspaceState, DeckState } from '../types';

/**
 * Creates an empty workspace state object
 */
export function createEmptyWorkspaceState(): WorkspaceState {
  return {
    files: [],
    activeFileId: null,
    tree: [],
    treeLoading: false,
    treeError: null
  };
}

/**
 * Creates an empty deck state object
 */
export function createEmptyDeckState(): DeckState {
  return {
    terminals: []
  };
}
