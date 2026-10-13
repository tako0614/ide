import type { Deck, Workspace } from './types';
import { API_BASE } from './constants';

/** Mirrors DeckIdeEvent in src/utils/events.ts. */
export type ServerEvent =
  | { type: 'workspace.created'; workspace: Workspace }
  | { type: 'workspace.deleted'; workspaceId: string }
  | { type: 'deck.created'; deck: Deck }
  | { type: 'deck.updated'; deck: Deck }
  | { type: 'deck.deleted'; deckId: string }
  | { type: 'decks.reordered'; deckIds: string[] }
  | { type: 'terminal.created'; deckId: string; terminal: { id: string; title: string; createdAt: string } }
  | { type: 'terminal.updated'; previousDeckId: string; deckId: string; terminal: { id: string; title: string; createdAt: string } }
  | { type: 'terminal.removed'; deckId: string; terminalId: string; reason: 'deleted' | 'exited' }
  | { type: 'ui.focus'; deckId: string; terminalId?: string }
  // Synthetic: the stream reconnected and events may have been missed.
  | { type: 'resync' };

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let hasConnected = false;

function dispatch(event: ServerEvent): void {
  listeners.forEach((listener) => {
    try {
      listener(event);
    } catch (error) {
      console.error('[events] listener failed:', error);
    }
  });
}

function open(): void {
  if (source || listeners.size === 0 || typeof EventSource === 'undefined') return;
  const stream = new EventSource(`${API_BASE}/api/events`, { withCredentials: true });
  source = stream;
  stream.addEventListener('open', () => {
    // Anything that happened while disconnected was missed: reload state.
    if (hasConnected) dispatch({ type: 'resync' });
    hasConnected = true;
  });
  stream.addEventListener('deckide', (message) => {
    try {
      dispatch(JSON.parse((message as MessageEvent<string>).data) as ServerEvent);
    } catch {
      // Ignore malformed frames.
    }
  });
  stream.addEventListener('error', () => {
    // The browser retries on its own unless the response was an error status
    // (e.g. 401 before login); then retry ourselves.
    if (stream.readyState !== EventSource.CLOSED) return;
    stream.close();
    if (source === stream) source = null;
    if (retryTimer === null && listeners.size > 0) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        open();
      }, 5000);
    }
  });
}

/** Subscribe to server state changes (one shared EventSource per page). */
export function subscribeServerEvents(listener: Listener): () => void {
  listeners.add(listener);
  open();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source?.close();
      source = null;
      hasConnected = false;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    }
  };
}
