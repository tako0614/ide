import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { Workspace, Deck } from '../types.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { closeTerminalClients } from '../utils/terminal-control.js';
import { emitDeckIdeEvent } from '../utils/events.js';
import { requireWorkspace } from './workspaces.js';

export function createDeckRouter(
  db: DatabaseSync,
  workspaces: Map<string, Workspace>,
  decks: Map<string, Deck>,
  terminals: Map<string, import('../types.js').TerminalSession>,
  deleteUnattachedTerminals?: (deckId: string) => void
) {
  const router = new Hono();

  const insertDeck = db.prepare(
    'INSERT INTO decks (id, name, root, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  function createDeck(name: string | undefined, workspaceId: string): Deck {
    const workspace = requireWorkspace(workspaces, workspaceId);
    const deck: Deck = {
      id: crypto.randomUUID(),
      name: name || `${workspace.name} ${Array.from(decks.values()).filter((d) => d.workspaceId === workspaceId).length + 1}`,
      root: workspace.path,
      workspaceId,
      createdAt: new Date().toISOString()
    };
    insertDeck.run(
      deck.id,
      deck.name,
      deck.root,
      deck.workspaceId,
      deck.createdAt
    );
    decks.set(deck.id, deck);
    emitDeckIdeEvent({ type: 'deck.created', deck });
    return deck;
  }

  router.get('/', (c) => {
    return c.json(Array.from(decks.values()));
  });

  router.post('/', async (c) => {
    try {
      const body = await readJson<{ name?: string; workspaceId?: string }>(c);
      const workspaceId = body?.workspaceId;
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      const deck = createDeck(body?.name, workspaceId);
      return c.json(deck, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  const updateSortOrderStmt = db.prepare('UPDATE decks SET sort_order = ? WHERE id = ?');

  router.put('/order', async (c) => {
    try {
      const body = await readJson<{ deckIds?: string[] }>(c);
      const deckIds = body?.deckIds;
      if (!Array.isArray(deckIds)) {
        throw createHttpError('deckIds array is required', 400);
      }
      db.exec('BEGIN TRANSACTION');
      try {
        deckIds.forEach((id, index) => {
          updateSortOrderStmt.run(index, id);
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      // Re-order the in-memory map to match
      const entries = deckIds
        .filter((id) => decks.has(id))
        .map((id) => [id, decks.get(id)!] as const);
      // Add any decks not in the list at the end
      for (const [id, deck] of decks) {
        if (!deckIds.includes(id)) {
          entries.push([id, deck]);
        }
      }
      decks.clear();
      for (const [id, deck] of entries) {
        decks.set(id, deck);
      }
      emitDeckIdeEvent({ type: 'decks.reordered', deckIds: Array.from(decks.keys()) });
      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  const updateDeckNameStmt = db.prepare('UPDATE decks SET name = ? WHERE id = ?');

  router.patch('/:id', async (c) => {
    try {
      const deck = decks.get(c.req.param('id'));
      if (!deck) throw createHttpError('Deck not found', 404);
      const body = await readJson<{ name?: unknown }>(c);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          typeof body.name !== 'string' || !body.name.trim()) {
        throw createHttpError('name must be a nonblank string', 400);
      }
      const name = body.name.trim();
      // Persist first: a failed write must leave memory and subscribers intact.
      const result = updateDeckNameStmt.run(name, deck.id);
      if (result.changes !== 1) throw createHttpError('Deck metadata not found', 409);
      deck.name = name;
      emitDeckIdeEvent({ type: 'deck.updated', deck });
      return c.json(deck);
    } catch (error) {
      return handleError(c, error);
    }
  });

  const hasDeckTerminalsStmt = db.prepare('SELECT 1 FROM terminals WHERE deck_id = ? LIMIT 1');

  const deleteDeckStmt = db.prepare('DELETE FROM decks WHERE id = ?');

  router.delete('/:id', (c) => {
    try {
      const deckId = c.req.param('id');
      if (!decks.has(deckId)) {
        throw createHttpError('Deck not found', 404);
      }

      // CLI deletion has a server-side precondition, even with auth disabled.
      // Check persisted rows too: a terminal may have no attached display.
      const onlyIfEmpty = c.req.query('ifEmpty') === '1';
      if (onlyIfEmpty) {
        if (Array.from(terminals.values()).some((session) => session.deckId === deckId) ||
            hasDeckTerminalsStmt.get(deckId)) {
          throw createHttpError('Deck still contains terminals; delete or move them first', 409);
        }
      } else {
        // Preserve the existing explicit browser/MCP cascading delete behavior.
        deleteUnattachedTerminals?.(deckId);
        const deckTerminalIds = Array.from(terminals.values())
          .filter((session) => session.deckId === deckId)
          .map((session) => session.id);
        deckTerminalIds.forEach((terminalId) => {
          const session = terminals.get(terminalId);
          if (!session) return;
          session.kill();
          terminals.delete(terminalId);
          closeTerminalClients(session, 'Deck deleted');
        });
      }

      deleteDeckStmt.run(deckId);
      decks.delete(deckId);
      emitDeckIdeEvent({ type: 'deck.deleted', deckId });
      return c.json({ deleted: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
