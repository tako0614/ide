import { useEffect } from 'react';
import type { AppView, WorkspaceMode } from '../types';
import { parseUrlState } from '../utils/urlUtils';

interface UseUrlSyncProps {
  view: AppView;
  editorWorkspaceId: string | null;
  activeDeckIds: string[];
  workspaceMode: WorkspaceMode;
  setView: (view: AppView) => void;
  setEditorWorkspaceId: (id: string | null) => void;
  setActiveDeckIds: (ids: string[]) => void;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
}

export function useUrlSync({
  view,
  editorWorkspaceId,
  activeDeckIds,
  workspaceMode,
  setView,
  setEditorWorkspaceId,
  setActiveDeckIds,
  setWorkspaceMode
}: UseUrlSyncProps) {
  // Sync state back from popstate (browser back/forward)
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
  }, [setView, setEditorWorkspaceId, setActiveDeckIds, setWorkspaceMode]);

  // Push current state into URL
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
}
