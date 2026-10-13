import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createTerminalRouter } from '../src/routes/terminals.js';
import { initializeDatabase } from '../src/utils/database.js';
import { onDeckIdeEvent } from '../src/utils/events.js';
import type { Deck, TerminalSession } from '../src/types.js';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);
  t.after(() => db.close());
  const decks = new Map<string, Deck>(['source', 'destination'].map((id) => [id, {
    id, name: id, root: '/tmp', workspaceId: 'workspace', createdAt: '2026-10-13T00:00:00Z',
  }]));
  const forbidden = () => { assert.fail('metadata update touched the terminal process or connection'); };
  const socket = { close: forbidden, send: forbidden, readyState: 1 };
  const session = {
    id: 'terminal', deckId: 'source', title: 'original', command: 'sleep 300',
    createdAt: '2026-10-13T00:00:00Z', cols: 120, rows: 32, lastActive: 1234,
    sockets: new Set([socket]), clients: new Map([[socket, { kind: 'cli' }]]), resizeOwner: socket,
    mirror: { title: () => 'live title', dispose: forbidden }, bufferChunks: [Buffer.from('output')],
    bufferBase: 0, bufferLength: 6, resizeEpoch: 0, lastResizeOffset: 0,
    write: forbidden, resize: forbidden, kill: forbidden, detach: forbidden,
  } as unknown as TerminalSession;
  db.prepare(`INSERT INTO terminals (id, deck_id, title, command, created_at, cols, rows)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(session.id, session.deckId, session.title, session.command, session.createdAt, 120, 32);
  const terminals = new Map([[session.id, session]]);
  const router = createTerminalRouter(decks, terminals, db);
  const events: any[] = [];
  t.after(onDeckIdeEvent((event) => events.push(event)));
  const patch = (body: unknown, id = session.id) => router.request('/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const persisted = () => db.prepare('SELECT * FROM terminals WHERE id = ?').get(session.id)!;
  return { db, session, terminals, patch, persisted, events, router };
}

test('PATCH changes deck and title together without touching the live session', async (t) => {
  const f = fixture(t);
  const before = { ...f.session };
  const response = await f.patch({ deckId: 'destination', title: '  renamed 日本語  ' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, 'renamed 日本語');
  assert.equal(f.terminals.get('terminal'), f.session);
  assert.equal(f.session.deckId, 'destination');
  assert.equal(f.session.title, 'renamed 日本語');
  assert.equal(f.persisted().deck_id, 'destination');
  assert.equal(f.persisted().title, 'renamed 日本語');
  for (const key of Object.keys(before).filter((key) => !['deckId', 'title'].includes(key))) {
    assert.equal((f.session as any)[key], (before as any)[key], key);
  }
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'terminal.updated');
  assert.equal(f.events[0].previousDeckId, 'source');
  assert.equal(f.events[0].deckId, 'destination');
  assert.equal((await (await f.router.request('/?deckId=source')).json()).length, 0);
  assert.equal((await (await f.router.request('/?deckId=destination')).json())[0].id, 'terminal');
});

test('PATCH supports either field and idempotent updates', async (t) => {
  const f = fixture(t);
  assert.equal((await f.patch({ title: 'name' })).status, 200);
  assert.equal(f.persisted().deck_id, 'source');
  assert.equal((await f.patch({ deckId: 'destination' })).status, 200);
  assert.equal(f.persisted().title, 'name');
  assert.equal((await f.patch({ deckId: 'destination', title: 'name' })).status, 200);
});

test('PATCH rejects invalid bodies and missing terminals/decks atomically', async (t) => {
  const f = fixture(t);
  const original = f.persisted();
  for (const body of [null, [], {}, { command: 'bad' }, { title: null }, { title: 7 },
    { title: '  ' }, { deckId: 5 }, { deckId: '' }, { deckId: null },
    { deckId: 'destination', title: '' }, { deckId: [], title: 'valid' }]) {
    assert.equal((await f.patch(body)).status, 400, JSON.stringify(body));
    assert.deepEqual(f.persisted(), original);
  }
  assert.equal((await f.router.request('/terminal', { method: 'PATCH', body: '{invalid' })).status, 400);
  assert.equal((await f.patch({ deckId: 'missing', title: 'valid' })).status, 404);
  assert.equal((await f.patch({ title: 'valid' }, 'missing')).status, 404);
  assert.deepEqual(f.persisted(), original);
  assert.equal(f.session.deckId, 'source');
  assert.equal(f.session.title, 'original');
  assert.equal(f.events.length, 0);
});

test('SQLite write failure leaves memory, connections and events unchanged', async (t) => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON terminals
    BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`);
  assert.equal((await f.patch({ deckId: 'destination', title: 'new' })).status, 500);
  assert.equal(f.session.deckId, 'source');
  assert.equal(f.session.title, 'original');
  assert.equal(f.persisted().title, 'original');
  assert.equal(f.events.length, 0);
});

test('missing persisted row cannot create a memory-only update', async (t) => {
  const f = fixture(t);
  f.db.prepare('DELETE FROM terminals WHERE id = ?').run('terminal');
  assert.equal((await f.patch({ title: 'new' })).status, 409);
  assert.equal(f.session.title, 'original');
  assert.equal(f.events.length, 0);
});

test('deck cleanup includes unattached metadata and preserves another socket owner', (t) => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO terminals (id, deck_id, title, created_at, cols, rows, tmux_socket) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('unattached', 'source', 'orphan', '2026-10-13', 80, 24, null);
  f.db.prepare('INSERT INTO terminals (id, deck_id, title, created_at, cols, rows, tmux_socket) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('foreign', 'source', 'foreign', '2026-10-13', 80, 24, '/other-instance/tmux.sock');
  f.router.deleteUnattachedDeckTerminals('source');
  assert.equal(f.db.prepare('SELECT id FROM terminals WHERE id = ?').get('unattached'), undefined);
  assert.equal(f.db.prepare('SELECT id FROM terminals WHERE id = ?').get('foreign')!.id, 'foreign');
  assert.equal(f.persisted().title, 'original');
});
