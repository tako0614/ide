import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { Workspace, Deck } from '../types.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { requireWorkspace } from './workspaces.js';
import { emitDeckIdeEvent } from '../utils/events.js';
import type { TerminalRecordStatus } from '../terminal/tmuxAdapter.js';

type DeckBlocker = Omit<TerminalRecordStatus, 'source'> & { source: TerminalRecordStatus['source'] | 'memory' };

export function createDeckRouter(
  db: DatabaseSync,
  workspaces: Map<string, Workspace>,
  decks: Map<string, Deck>,
  terminals: Map<string, import('../types.js').TerminalSession>,
  options: {
    hasNativeTerminals?: (deckId: string) => boolean;
    revokeTerminal?: (id: string) => void;
    inspectNativeTerminals?: (deckId: string) => TerminalRecordStatus[];
    inspectTerminalRecord?: (id: string, socketPath?: string | null) => TerminalRecordStatus;
    pruneNativeTerminals?: (deckId: string, expected?: TerminalRecordStatus[]) => { terminalIds: string[] };
  } = {}
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

  router.patch('/:id', async (c) => {
    try {
      const deck = decks.get(c.req.param('id'));
      if (!deck) throw createHttpError('Deck not found', 404);
      const body = await readJson<Record<string, unknown>>(c);
      if (!body || Array.isArray(body) || Object.keys(body).some((key) => key !== 'name') ||
          typeof body.name !== 'string' || !body.name.trim()) {
        throw createHttpError('name must be a non-empty string', 400);
      }
      const name = body.name.trim();
      const result = db.prepare('UPDATE decks SET name = ? WHERE id = ?').run(name, deck.id);
      if (result.changes !== 1) throw createHttpError('Deck not found', 404);
      deck.name = name;
      emitDeckIdeEvent({ type: 'deck.updated', deck });
      return c.json(deck);
    } catch (error) { return handleError(c, error); }
  });

  const deleteDeckStmt = db.prepare(`DELETE FROM decks WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM terminals WHERE deck_id = ?)
    AND NOT EXISTS (SELECT 1 FROM terminal_metadata WHERE deck_id = ?)`);

  function inspectBlockers(deckId: string): DeckBlocker[] {
    const blockers: DeckBlocker[] = [];
    try {
      if (options.inspectNativeTerminals) blockers.push(...options.inspectNativeTerminals(deckId));
      else if (options.hasNativeTerminals?.(deckId)) blockers.push({ terminalId: 'unknown', source: 'registry',
        state: 'unavailable', reason: 'Native terminal records remain; classification unavailable' });
    } catch {
      blockers.push({ terminalId: 'unknown', source: 'registry', state: 'unavailable',
        reason: 'Terminal registry cannot be safely inspected', entry: '<runtime>' });
    }
    const inspectRow = (id: string, socketPath?: string | null): TerminalRecordStatus => {
      try {
        return options.inspectTerminalRecord?.(id, socketPath) ?? { terminalId: id, source: 'legacy-db',
          state: 'unavailable', reason: 'Native terminal classification unavailable' };
      } catch {
        return { terminalId: id, source: 'legacy-db', state: 'unavailable', reason: 'Terminal identity cannot be safely inspected' };
      }
    };
    for (const [table, source] of [['terminals', 'legacy-db'], ['terminal_metadata', 'native-db']] as const) {
      const rows = db.prepare(`SELECT id, tmux_socket FROM ${table} WHERE deck_id = ?`).all(deckId);
      for (const row of rows) {
        const id = String(row.id);
        blockers.push({ ...inspectRow(id, row.tmux_socket == null ? null : String(row.tmux_socket)), source });
      }
    }
    for (const session of terminals.values()) {
      if (session.deckId !== deckId) continue;
      blockers.push(session.available === false
        ? { ...inspectRow(session.id, session.tmux?.socketPath), source: 'memory' }
        : { terminalId: session.id, source: 'memory', state: 'live', reason: 'Terminal has an active display; close or move it first' });
    }
    return blockers;
  }

  function blocked(c: import('hono').Context, blockers: DeckBlocker[]) {
    const diagnostics: DeckBlocker[] = blockers.length > 128
      ? [...blockers.slice(0, 127), { terminalId: 'unknown', source: 'registry', state: 'unavailable',
          reason: `${blockers.length - 127} additional blockers; inspect registry and database before retrying` }]
      : blockers;
    return c.json({ error: 'Deck deletion blocked', code: 'deck_delete_blocked', blockers: diagnostics.map((item) => ({ ...item,
      terminalId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.terminalId) ? item.terminalId : 'unknown' })),
      hint: blockers.some((entry) => entry.state === 'dead')
        ? 'Use deckide deck delete <id> --prune-stale to remove records proven dead. Live or unavailable records are never pruned.'
        : 'Close or move live terminals. Unavailable records require identity verification; --prune-stale will not remove them.' }, 409);
  }

  router.delete('/:id', async (c) => {
    try {
      const deckId = c.req.param('id');
      if (!decks.has(deckId)) throw createHttpError('Deck not found', 404);
      const pruneValue = c.req.query('pruneStale');
      if (pruneValue !== undefined && pruneValue !== 'true') throw createHttpError('pruneStale must be true', 400);
      const prune = pruneValue === 'true';
      const before = inspectBlockers(deckId);
      if (before.length && (!prune || before.some((entry) => entry.state !== 'dead'))) return blocked(c, before);
      const pruned: DeckBlocker[] = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        // Recheck under the DB writer lock. Every filesystem removal separately rechecks native death.
        const current = inspectBlockers(deckId);
        if (current.length && (!prune || current.some((entry) => entry.state !== 'dead'))) {
          db.exec('ROLLBACK');
          return blocked(c, current);
        }
        if (current.length) {
          const native = current.filter((entry): entry is TerminalRecordStatus => entry.source === 'registry' || entry.source === 'pending');
          if (native.length) {
            if (!options.pruneNativeTerminals) throw createHttpError('Safe registry pruning unavailable', 409);
            options.pruneNativeTerminals(deckId, native);
          }
          for (const entry of current) {
            if (entry.source !== 'native-db' && entry.source !== 'legacy-db') continue;
            const rechecked = options.inspectTerminalRecord?.(entry.terminalId,
              (db.prepare(`SELECT tmux_socket FROM ${entry.source === 'native-db' ? 'terminal_metadata' : 'terminals'} WHERE id=? AND deck_id=?`)
                .get(entry.terminalId, deckId)?.tmux_socket as string | null) ?? null);
            if (rechecked?.state !== 'dead') {
              throw createHttpError('Terminal changed during stale cleanup', 409);
            }
            db.prepare(`DELETE FROM ${entry.source === 'native-db' ? 'terminal_metadata' : 'terminals'} WHERE id=? AND deck_id=?`)
              .run(entry.terminalId, deckId);
          }
          pruned.push(...current);
        }
        // Filesystem may have gained a new record while an external broker was working.
        const remaining = options.inspectNativeTerminals?.(deckId) ?? [];
        if (remaining.length) {
          db.exec('ROLLBACK');
          return blocked(c, remaining);
        }
        const result = deleteDeckStmt.run(deckId, deckId, deckId);
        if (result.changes !== 1) throw createHttpError('Deck changed during deletion', 409);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
        if ((error as { status?: number }).status === 409 || prune) {
          const remaining = inspectBlockers(deckId);
          return blocked(c, remaining.length ? remaining : [{ terminalId: 'unknown', source: 'registry', state: 'unavailable',
            reason: 'Stale cleanup could not complete safely; retained database rows and deck' }]);
        }
        throw error;
      }
      for (const id of new Set(pruned.map((entry) => entry.terminalId))) options.revokeTerminal?.(id);
      for (const entry of pruned) {
        if (entry.source !== 'memory') continue;
        const session = terminals.get(entry.terminalId);
        terminals.delete(entry.terminalId);
        session?.sockets.forEach((socket) => {
          try { socket.close(1000, 'Terminal exited'); } catch { /* dead display only */ }
        });
        session?.sockets.clear();
        emitDeckIdeEvent({ type: 'terminal.removed', deckId, terminalId: entry.terminalId, reason: 'exited' });
      }
      decks.delete(deckId);
      emitDeckIdeEvent({ type: 'deck.deleted', deckId });
      return c.json({ deleted: true, pruned });
    } catch (error) { return handleError(c, error); }
  });

  return router;
}
