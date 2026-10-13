import { EventEmitter } from 'node:events';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Deck, Workspace } from '../types.js';

/**
 * State changes broadcast to every connected UI and CLI, so a deck or
 * terminal created from one place (web, `deckide` CLI, MCP agent) shows up
 * everywhere without a reload.
 */
export type DeckIdeEvent =
  | { type: 'workspace.created'; workspace: Workspace }
  | { type: 'workspace.deleted'; workspaceId: string }
  | { type: 'deck.created'; deck: Deck }
  | { type: 'deck.updated'; deck: Deck }
  | { type: 'deck.deleted'; deckId: string }
  | { type: 'decks.reordered'; deckIds: string[] }
  | { type: 'terminal.created'; deckId: string; terminal: { id: string; title: string; createdAt: string } }
  | { type: 'terminal.updated'; previousDeckId: string; deckId: string; terminal: { id: string; title: string; createdAt: string } }
  | { type: 'terminal.removed'; deckId: string; terminalId: string; reason: 'deleted' | 'exited' }
  // Ask every open UI to bring a deck (and optionally a terminal) to the front.
  | { type: 'ui.focus'; deckId: string; terminalId?: string };

const bus = new EventEmitter();
bus.setMaxListeners(0);
let sequence = 0;

export function emitDeckIdeEvent(event: DeckIdeEvent): void {
  bus.emit('event', { ...event, seq: ++sequence, at: new Date().toISOString() });
}

export function onDeckIdeEvent(listener: (event: DeckIdeEvent & { seq: number; at: string }) => void): () => void {
  bus.on('event', listener);
  return () => { bus.off('event', listener); };
}

const HEARTBEAT_MS = 25_000;

/**
 * GET /api/events — Server-Sent Events stream of DeckIdeEvent.
 *
 * `onRevoked` ties the stream to the caller's login session (like terminal
 * sockets), so logout, a password change or expiry ends it.
 */
export function createEventsRouter(onRevoked: (c: Context, close: () => void) => () => void) {
  const router = new Hono();
  router.get('/', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = onDeckIdeEvent((event) => {
        queue.push(JSON.stringify(event));
        wake?.();
      });
      let closed = false;
      const close = () => {
        closed = true;
        wake?.();
      };
      stream.onAbort(close);
      const stopWatching = onRevoked(c, close);
      try {
        await stream.writeSSE({ event: 'hello', data: JSON.stringify({ seq: sequence }) });
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              const timer = setTimeout(resolve, HEARTBEAT_MS);
              timer.unref?.();
            });
            wake = null;
            if (queue.length === 0 && !closed) {
              await stream.write(': ping\n\n');
            }
            continue;
          }
          const data = queue.shift()!;
          await stream.writeSSE({ event: 'deckide', data });
        }
      } finally {
        unsubscribe();
        stopWatching();
      }
    });
  });
  return router;
}
