import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDeckRouter } from '../src/routes/decks.js';
import { commitTerminalMetadata, initializeDatabase, persistTerminalMetadata } from '../src/utils/database.js';
import { onDeckIdeEvent } from '../src/utils/events.js';
import type { TmuxTerminalMeta } from '../src/terminal/tmuxAdapter.js';
import type { Deck, TerminalSession, Workspace } from '../src/types.js';

const CREATED_AT = '2026-10-13T00:00:00.000Z';

function terminalMeta(): TmuxTerminalMeta {
  return {
    id: 'native', deckId: 'deck', title: 'before', command: null, createdAt: CREATED_AT,
    cols: 120, rows: 32, pid: 101, socketPath: '/isolated/native.sock',
    sessionName: 'session', serverPid: 102, sessionId: '$1', windowId: '@1', paneId: '%1',
    generation: 'b1bd66d5-f62b-479e-a8b0-87da92244ee1',
  };
}

function terminalMetadataRow(db: DatabaseSync) {
  return db.prepare('SELECT deck_id, title, generation, tmux_socket FROM terminal_metadata WHERE id = ?')
    .get('native');
}

function transactionFixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);
  t.after(() => db.close());
  const previous = terminalMeta();
  const next = { ...previous, deckId: 'another-deck', title: 'after' };
  persistTerminalMetadata(db, previous);
  let registry = { ...previous };
  let writes = 0;
  let restores = 0;
  const writeRegistry = () => { writes++; registry = { ...next }; };
  const restoreRegistry = () => { restores++; registry = { ...previous }; };
  return { db, previous, next, get registry() { return registry; }, get writes() { return writes; },
    get restores() { return restores; }, writeRegistry, restoreRegistry };
}

function deferCommitFailure(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE commit_parent (id TEXT PRIMARY KEY);
    CREATE TABLE commit_child (parent_id TEXT REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_metadata_commit AFTER UPDATE ON terminal_metadata
      BEGIN INSERT INTO commit_child(parent_id) VALUES ('missing'); END;`);
}

test('metadata transaction commits registry and DB together', (t) => {
  const f = transactionFixture(t);
  commitTerminalMetadata(f.db, f.next, f.writeRegistry, f.restoreRegistry);
  assert.deepEqual(f.registry, f.next);
  assert.deepEqual({ ...terminalMetadataRow(f.db) }, {
    deck_id: f.next.deckId, title: f.next.title, generation: f.next.generation,
    tmux_socket: f.next.socketPath,
  });
  assert.equal(f.writes, 1);
  assert.equal(f.restores, 0);
});

test('metadata DB upsert failure leaves registry and DB unchanged', (t) => {
  const f = transactionFixture(t);
  f.db.exec(`CREATE TRIGGER reject_metadata_update BEFORE UPDATE ON terminal_metadata
    BEGIN SELECT RAISE(ABORT, 'injected upsert failure'); END;`);
  assert.throws(() => commitTerminalMetadata(f.db, f.next, f.writeRegistry, f.restoreRegistry),
    /injected upsert failure/);
  assert.deepEqual(f.registry, f.previous);
  assert.equal(terminalMetadataRow(f.db)!.title, f.previous.title);
  assert.equal(f.writes, 0);
  assert.equal(f.restores, 0);
});

test('metadata registry write failure rolls back the DB upsert', (t) => {
  const f = transactionFixture(t);
  assert.throws(() => commitTerminalMetadata(f.db, f.next,
    () => { throw new Error('injected registry write failure'); }, f.restoreRegistry),
  /injected registry write failure/);
  assert.deepEqual(f.registry, f.previous);
  assert.equal(terminalMetadataRow(f.db)!.title, f.previous.title);
  assert.equal(f.restores, 0);
});

test('metadata COMMIT failure restores registry and rolls back DB', (t) => {
  const f = transactionFixture(t);
  deferCommitFailure(f.db);
  assert.throws(() => commitTerminalMetadata(f.db, f.next, f.writeRegistry, f.restoreRegistry),
    /FOREIGN KEY constraint failed/);
  assert.deepEqual(f.registry, f.previous);
  assert.equal(terminalMetadataRow(f.db)!.title, f.previous.title);
  assert.equal(f.writes, 1);
  assert.equal(f.restores, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM commit_child').get()!.count, 0);
});

test('metadata compensation failure reports uncertain state after COMMIT failure', (t) => {
  const f = transactionFixture(t);
  deferCommitFailure(f.db);
  assert.throws(() => commitTerminalMetadata(f.db, f.next, f.writeRegistry,
    () => { throw new Error('injected compensation failure'); }),
  (error: unknown) => {
    assert.equal((error as { metadataUncertain?: boolean }).metadataUncertain, true);
    assert.match((error as Error).message, /compensation failed/i);
    return true;
  });
  assert.deepEqual(f.registry, f.next);
  assert.equal(terminalMetadataRow(f.db)!.title, f.previous.title);
});

function fixture(t: test.TestContext, hasNativeTerminals = (_deckId: string) => false) {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);
  t.after(() => db.close());
  const workspace: Workspace = { id: 'workspace', name: 'work', path: '/tmp', createdAt: CREATED_AT };
  const deck: Deck = { id: 'deck', name: 'original', root: '/tmp', workspaceId: workspace.id, createdAt: CREATED_AT };
  db.prepare('INSERT INTO workspaces (id, name, path, normalized_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(workspace.id, workspace.name, workspace.path, workspace.path, workspace.createdAt);
  db.prepare('INSERT INTO decks (id, name, root, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(deck.id, deck.name, deck.root, deck.workspaceId, deck.createdAt);
  const decks = new Map([[deck.id, deck]]);
  const terminals = new Map<string, TerminalSession>();
  const router = createDeckRouter(db, new Map([[workspace.id, workspace]]), decks, terminals, { hasNativeTerminals });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  t.after(onDeckIdeEvent((event) => events.push(event)));
  const patch = (body: unknown, id = deck.id) => router.request('/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const remove = (id = deck.id) => router.request('/' + id, { method: 'DELETE' });
  const savedDeck = () => db.prepare('SELECT name FROM decks WHERE id = ?').get(deck.id) as { name: string } | undefined;
  return { db, deck, decks, terminals, router, events, patch, remove, savedDeck };
}

test('legacy terminal migration preserves all rows, command/history and adds only compatible columns', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE terminals (
      id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, title TEXT NOT NULL,
      command TEXT, buffer TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    )`);
    const insert = db.prepare('INSERT INTO terminals (id, deck_id, title, command, buffer, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 9; i++) insert.run(`legacy-${i}`, `deck-${i}`, `title-${i}`, `private-command-${i}`, `history-${i}`, CREATED_AT);
    const before = db.prepare('SELECT id, deck_id, title, command, buffer, created_at FROM terminals ORDER BY id').all();
    initializeDatabase(db);
    initializeDatabase(db);
    assert.deepEqual(db.prepare('SELECT id, deck_id, title, command, buffer, created_at FROM terminals ORDER BY id').all(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM terminals').get()!.count, 9);
    const columns = new Set(db.prepare('PRAGMA table_info(terminals)').all().map((row) => String(row.name)));
    for (const name of ['cols', 'rows', 'tmux_socket']) assert.ok(columns.has(name), name);
    const migrated = db.prepare('SELECT cols, rows, tmux_socket FROM terminals WHERE id = ?').get('legacy-0')!;
    assert.deepEqual({ ...migrated }, { cols: 120, rows: 32, tmux_socket: null });
    const nativeColumns = new Set(db.prepare('PRAGMA table_info(terminal_metadata)').all().map((row) => String(row.name)));
    for (const name of ['id', 'deck_id', 'title', 'created_at', 'cols', 'rows', 'generation', 'tmux_socket']) {
      assert.ok(nativeColumns.has(name), name);
    }
  } finally { db.close(); }
});

test('deck PATCH persists a trimmed name and emits once without changing other fields', async (t) => {
  const f = fixture(t);
  const before = { ...f.deck };
  const response = await f.patch({ name: '  日本語 with spaces  ' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...before, name: '日本語 with spaces' });
  assert.equal(f.decks.get(f.deck.id), f.deck);
  assert.equal(f.savedDeck()?.name, '日本語 with spaces');
  assert.deepEqual(f.deck, { ...before, name: '日本語 with spaces' });
  assert.deepEqual(f.events.map((event) => event.type), ['deck.updated']);
});

test('deck PATCH rejects malformed names and unknown fields without changing DB, memory or events', async (t) => {
  const f = fixture(t);
  for (const body of [null, [], {}, { title: 'wrong' }, { name: '' }, { name: '  ' }, { name: 7 },
    { name: 'valid', root: '/elsewhere' }, { name: 'valid', workspaceId: 'other' }]) {
    assert.equal((await f.patch(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.router.request('/deck', { method: 'PATCH', body: '{invalid' })).status, 400);
  assert.equal((await f.patch({ name: 'valid' }, 'missing')).status, 404);
  assert.equal(f.deck.name, 'original');
  assert.equal(f.savedDeck()?.name, 'original');
  assert.equal(f.events.length, 0);
});

test('deck rename and empty deletion retain memory and events when SQLite rejects a write', async (t) => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER reject_rename BEFORE UPDATE ON decks BEGIN SELECT RAISE(ABORT, 'injected'); END;
    CREATE TRIGGER reject_delete BEFORE DELETE ON decks BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
  assert.equal((await f.patch({ name: 'new' })).status, 500);
  assert.equal((await f.remove()).status, 500);
  assert.equal(f.savedDeck()?.name, 'original');
  assert.equal(f.decks.get(f.deck.id), f.deck);
  assert.equal(f.deck.name, 'original');
  assert.equal(f.events.length, 0);
});

test('deck deletion refuses live, legacy, native, and unavailable registry terminals without touching them', async (t) => {
  const scenarios: Array<{
    name: string;
    setup: (f: ReturnType<typeof fixture>) => void;
  }> = [
    { name: 'live map', setup: (f) => {
      const fail = () => assert.fail('live terminal was touched');
      f.terminals.set('live', { id: 'live', deckId: f.deck.id, kill: fail, detach: fail,
        sockets: new Set([{ close: fail }]) } as unknown as TerminalSession);
    } },
    { name: 'legacy DB row', setup: (f) => {
      f.db.prepare('INSERT INTO terminals (id, deck_id, title, created_at) VALUES (?, ?, ?, ?)')
        .run('legacy', f.deck.id, 'saved', CREATED_AT);
    } },
    { name: 'native DB row', setup: (f) => {
      f.db.prepare(`INSERT INTO terminal_metadata
        (id, deck_id, title, created_at, cols, rows, generation, tmux_socket)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('native', f.deck.id, 'saved', CREATED_AT, 120, 32,
        'b1bd66d5-f62b-479e-a8b0-87da92244ee1', '/isolated/native.sock');
    } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const f = fixture(subtest);
      scenario.setup(f);
      const response = await f.remove();
      assert.equal(response.status, 409);
      assert.equal(f.savedDeck()?.name, 'original');
      assert.equal(f.decks.get(f.deck.id), f.deck);
      assert.equal(f.events.length, 0);
    });
  }
  await t.test('unavailable or pending registry', async (subtest) => {
    const f = fixture(subtest, (deckId) => deckId === 'deck');
    assert.equal((await f.remove()).status, 409);
    assert.equal(f.savedDeck()?.name, 'original');
    assert.equal(f.events.length, 0);
  });
});

test('empty deck deletion updates DB and memory once; missing deck remains 404', async (t) => {
  const f = fixture(t);
  assert.equal((await f.remove()).status, 200);
  assert.equal(f.savedDeck(), undefined);
  assert.equal(f.decks.has(f.deck.id), false);
  assert.deepEqual(f.events.map((event) => event.type), ['deck.deleted']);
  assert.equal((await f.remove()).status, 404);
});
