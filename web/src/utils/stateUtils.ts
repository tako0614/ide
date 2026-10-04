/**
 * State management utilities
 */

import type { WorkspaceState, DeckState, TerminalSession } from '../types';

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
    terminals: [],
    activeTerminalId: null
  };
}

/**
 * 表示すべきアクティブ端末の ID を解決する。
 * 保存された activeTerminalId が現在の端末一覧に存在すればそれを、
 * 無ければ先頭端末を、端末が無ければ null を返す。
 */
export function resolveActiveTerminalId(
  terminals: TerminalSession[],
  activeTerminalId: string | null | undefined
): string | null {
  if (activeTerminalId && terminals.some((t) => t.id === activeTerminalId)) {
    return activeTerminalId;
  }
  return terminals[0]?.id ?? null;
}
