import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDeckRouter } from '../src/routes/decks.js';
import { initializeDatabase, loadPersistedState } from '../src/utils/database.js';
import { onDeckIdeEvent } from '../src/utils/events.js';
import type { Deck, TerminalSession, Workspace } from '../src/types.js';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);
  t.after(() => db.close());
  const workspace: Workspace = { id: 'workspace', name: 'work', path: '/tmp', createdAt: '2026-10-13' };
  const deck: Deck = { id: 'deck', name: 'original', root: '/tmp', workspaceId: workspace.id, createdAt: workspace.createdAt };
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run(workspace.id, workspace.name, workspace.path, workspace.path, workspace.createdAt);
  db.prepare('INSERT INTO decks (id, name, root, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(deck.id, deck.name, deck.root, deck.workspaceId, deck.createdAt);
  const decks = new Map([[deck.id, deck]]);
  const terminals = new Map<string, TerminalSession>();
  let cleanupCalls = 0;
  const router = createDeckRouter(db, new Map([[workspace.id, workspace]]), decks, terminals, () => { cleanupCalls++; });
  const events: any[] = [];
  t.after(onDeckIdeEvent((event) => events.push(event)));
  const patch = (body: unknown, id = deck.id) => router.request('/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const remove = () => router.request('/deck?ifEmpty=1', { method: 'DELETE' });
  const persisted = () => db.prepare('SELECT * FROM decks WHERE id = ?').get(deck.id);
  const insertTerminal = (socket: string | null = null) => db.prepare(`INSERT INTO terminals
    (id, deck_id, title, created_at, cols, rows, tmux_socket) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('terminal', deck.id, 'saved', deck.createdAt, 80, 24, socket);
  return { db, deck, decks, terminals, router, events, patch, remove, persisted, insertTerminal, cleanupCalls: () => cleanupCalls };
}

test('deck PATCH persists a trimmed name, updates the same object, emits an event and reloads', async (t) => {
  const f = fixture(t);
  const before = { ...f.deck };
  const response = await f.patch({ name: '  新しい名前 with spaces  ' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...before, name: '新しい名前 with spaces' });
  assert.equal(f.decks.get('deck'), f.deck);
  assert.equal(f.persisted()!.name, f.deck.name);
  for (const key of ['id', 'root', 'workspaceId', 'createdAt'] as const) assert.equal(f.deck[key], before[key]);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'deck.updated');
  assert.deepEqual(f.events[0].deck, f.deck);
  const restored = new Map<string, Deck>();
  loadPersistedState(f.db, new Map(), new Map(), restored);
  assert.equal(restored.get('deck')!.name, f.deck.name);
  assert.equal((await f.patch({ name: f.deck.name })).status, 200);
});

test('deck PATCH rejects invalid JSON, invalid names and missing decks without mutation', async (t) => {
  const f = fixture(t);
  const before = f.persisted();
  for (const body of [null, [], 'name', {}, { root: '/other' }, { name: null }, { name: 3 }, { name: false }, { name: '' }, { name: ' \n ' }]) {
    assert.equal((await f.patch(body)).status, 400, JSON.stringify(body));
    assert.deepEqual(f.persisted(), before);
  }
  assert.equal((await f.router.request('/deck', { method: 'PATCH', body: '{invalid' })).status, 400);
  assert.equal((await f.patch({ name: 'valid' }, 'missing')).status, 404);
  assert.equal(f.deck.name, 'original');
  assert.equal(f.events.length, 0);
});

test('deck rename and empty deletion leave memory and events intact on SQLite failure', async (t) => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER fail_rename BEFORE UPDATE ON decks BEGIN SELECT RAISE(ABORT, 'injected'); END;
    CREATE TRIGGER fail_delete BEFORE DELETE ON decks BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
  assert.equal((await f.patch({ name: 'new' })).status, 500);
  assert.equal((await f.remove()).status, 500);
  assert.equal(f.deck.name, 'original');
  assert.equal(f.persisted()!.name, 'original');
  assert.equal(f.decks.get('deck'), f.deck);
  assert.equal(f.cleanupCalls(), 0);
  assert.equal(f.events.length, 0);
});

test('deck PATCH refuses a missing persisted row before changing memory', async (t) => {
  const f = fixture(t);
  f.db.prepare('DELETE FROM decks WHERE id = ?').run(f.deck.id);
  assert.equal((await f.patch({ name: 'new' })).status, 409);
  assert.equal(f.deck.name, 'original');
  assert.equal(f.events.length, 0);
});

test('empty-only delete refuses a live terminal even without its DB row', async (t) => {
  const f = fixture(t);
  const session = { id: 'terminal', deckId: 'deck', kill: () => assert.fail('must not kill a terminal') } as unknown as TerminalSession;
  f.terminals.set(session.id, session);
  const response = await f.remove();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /terminal/i);
  assert.equal(f.terminals.get(session.id), session);
  assert.equal(f.decks.get('deck'), f.deck);
  assert.ok(f.persisted());
  assert.equal(f.cleanupCalls(), 0);
  assert.equal(f.events.length, 0);
});

test('empty-only delete refuses unattached, legacy and foreign-socket terminal rows', async (t) => {
  const f = fixture(t);
  for (const socket of [null, '/isolated/tmux.sock', '/foreign/tmux.sock']) {
    f.insertTerminal(socket);
    const before = f.db.prepare('SELECT * FROM terminals').all();
    assert.equal((await f.remove()).status, 409);
    assert.deepEqual(f.db.prepare('SELECT * FROM terminals').all(), before);
    assert.ok(f.persisted());
    assert.equal(f.cleanupCalls(), 0);
    assert.equal(f.events.length, 0);
    f.db.exec('DELETE FROM terminals');
  }
});

test('empty-only delete removes only the selected empty deck and emits its deletion', async (t) => {
  const f = fixture(t);
  f.db.prepare(`INSERT INTO terminals (id, deck_id, title, created_at, cols, rows) VALUES ('other', 'other-deck', 'other', '2026-10-13', 80, 24)`).run();
  assert.equal((await f.remove()).status, 200);
  assert.equal(f.decks.has('deck'), false);
  assert.equal(f.persisted(), undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM terminals').get()!.count, 1);
  assert.equal(f.cleanupCalls(), 0);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'deck.deleted');
  assert.equal(f.events[0].deckId, 'deck');
  assert.equal((await f.remove()).status, 404);
});

test('existing cascading delete without the empty-only condition retains its behavior', async (t) => {
  const f = fixture(t);
  let killed = 0;
  f.terminals.set('terminal', { id: 'terminal', deckId: 'deck', kill: () => { killed++; }, sockets: new Set(), clients: new Map() } as unknown as TerminalSession);
  assert.equal((await f.router.request('/deck', { method: 'DELETE' })).status, 200);
  assert.equal(killed, 1);
  assert.equal(f.cleanupCalls(), 1);
  assert.equal(f.terminals.size, 0);
  assert.equal(f.decks.size, 0);
});
