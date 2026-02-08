/**
 * URL and routing utilities
 */

type AppView = 'workspace' | 'terminal' | 'agent';
type WorkspaceMode = 'list' | 'editor';

export type UrlState = {
  view: AppView;
  workspaceId: string | null;
  deckIds: string[];
  workspaceMode: WorkspaceMode;
};

/**
 * Parses URL search parameters into application state
 */
export function parseUrlState(): UrlState {
  if (typeof window === 'undefined') {
    return {
      view: 'terminal',
      workspaceId: null,
      deckIds: [],
      workspaceMode: 'list'
    };
  }
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get('view');
  const modeParam = params.get('mode');
  const deckParam = params.get('decks') || params.get('deck');
  const deckIds = deckParam ? deckParam.split(',').filter(Boolean) : [];
  return {
    view: viewParam === 'workspace' ? 'workspace' : viewParam === 'agent' ? 'agent' : 'terminal',
    workspaceId: params.get('workspace'),
    deckIds,
    workspaceMode: modeParam === 'editor' ? 'editor' : 'list'
  };
}
