import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDeckRouter } from '../src/routes/decks.js';
import { initializeDatabase } from '../src/utils/database.js';
import { onDeckIdeEvent } from '../src/utils/events.js';
import type { Deck, TerminalSession, Workspace } from '../src/types.js';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);
  t.after(() => db.close());
  const deck: Deck = { id: 'deck', name: 'original', root: '/tmp', workspaceId: 'workspace', createdAt: '2026-10-13' };
  db.prepare('INSERT INTO decks (id, name, root, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(deck.id, deck.name, deck.root, deck.workspaceId, deck.createdAt);
  const decks = new Map([[deck.id, deck]]);
  const terminals = new Map<string, TerminalSession>();
  const router = createDeckRouter(db, new Map<string, Workspace>(), decks, terminals);
  const events: any[] = [];
  t.after(onDeckIdeEvent((event) => events.push(event)));
  const patch = (body: unknown, id = deck.id) => router.request('/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const remove = (id = deck.id) => router.request('/' + id, { method: 'DELETE' });
  const persisted = () => db.prepare('SELECT * FROM decks WHERE id = ?').get(deck.id);
  const addRow = (socket: string | null = null) => db.prepare(
    'INSERT INTO terminals (id, deck_id, title, created_at, cols, rows, tmux_socket) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('terminal', deck.id, 'shell', deck.createdAt, 80, 24, socket);
  return { db, deck, decks, terminals, router, events, patch, remove, persisted, addRow };
}

test('deck rename updates DB and the same memory object, preserving other fields', async (t) => {
  const f = fixture(t);
  const before = { ...f.deck };
  assert.equal((await f.patch({ name: '  renamed 日本語  ', root: '/elsewhere' })).status, 200);
  assert.equal(f.decks.get('deck'), f.deck);
  assert.deepEqual(f.deck, { ...before, name: 'renamed 日本語' });
  assert.equal(f.persisted()!.name, f.deck.name);
  assert.equal((await (await f.router.request('/')).json())[0].name, f.deck.name);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'deck.updated');
  assert.equal(f.events[0].deck.name, f.deck.name);
  assert.equal((await f.patch({ name: f.deck.name })).status, 200);
});

test('deck rename rejects invalid names and unknown decks without changes', async (t) => {
  const f = fixture(t);
  const original = f.persisted();
  for (const body of [null, [], {}, { title: 'name' }, { name: null }, { name: 7 }, { name: '' }, { name: '  ' }]) {
    assert.equal((await f.patch(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.router.request('/deck', { method: 'PATCH', body: '{invalid' })).status, 400);
  assert.equal((await f.patch({ name: 'new' }, 'missing')).status, 404);
  assert.deepEqual(f.persisted(), original);
  assert.equal(f.deck.name, 'original');
  assert.equal(f.events.length, 0);
});

test('failed rename or delete leaves memory and events intact', async (t) => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON decks
    BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;
    CREATE TRIGGER reject_delete BEFORE DELETE ON decks
    BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;`);
  assert.equal((await f.patch({ name: 'new' })).status, 500);
  assert.equal((await f.remove()).status, 500);
  assert.equal(f.deck.name, 'original');
  assert.equal(f.decks.get('deck'), f.deck);
  assert.equal(f.persisted()!.name, 'original');
  assert.equal(f.events.length, 0);
});

test('missing DB metadata cannot become a memory-only rename or deletion', async (t) => {
  const f = fixture(t);
  f.db.prepare('DELETE FROM decks WHERE id = ?').run('deck');
  assert.equal((await f.patch({ name: 'new' })).status, 409);
  assert.equal((await f.remove()).status, 409);
  assert.equal(f.deck.name, 'original');
  assert.equal(f.decks.get('deck'), f.deck);
  assert.equal(f.events.length, 0);
});

test('deck deletion refuses a live terminal without touching its process or clients', async (t) => {
  const f = fixture(t);
  const forbidden = () => assert.fail('deck deletion touched a live terminal');
  const socket = { close: forbidden, send: forbidden };
  const terminal = { id: 'terminal', deckId: 'deck', kill: forbidden, detach: forbidden,
    write: forbidden, resize: forbidden, sockets: new Set([socket]),
    clients: new Map([[socket, {}]]), mirror: { dispose: forbidden } } as unknown as TerminalSession;
  f.terminals.set(terminal.id, terminal); // Memory alone must also prevent deletion.
  const response = await f.remove();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /terminals/i);
  assert.equal(f.terminals.get('terminal'), terminal);
  assert.equal(f.decks.get('deck'), f.deck);
  assert.equal(f.persisted()!.name, 'original');
  assert.equal(f.events.length, 0);
});

for (const socket of [null, '/test-instance/tmux.sock', '/other-instance/tmux.sock']) {
  test(`deck deletion refuses persisted, unattached terminals (socket: ${socket})`, async (t) => {
    const f = fixture(t);
    f.addRow(socket);
    assert.equal((await f.remove()).status, 409);
    assert.equal(f.persisted()!.name, 'original');
    assert.equal(f.db.prepare('SELECT tmux_socket FROM terminals WHERE id = ?').get('terminal')!.tmux_socket, socket);
    assert.equal(f.decks.get('deck'), f.deck);
    assert.equal(f.events.length, 0);
  });
}

test('empty deck deletion updates DB and memory and emits one deletion', async (t) => {
  const f = fixture(t);
  assert.equal((await f.remove()).status, 200);
  assert.equal(f.persisted(), undefined);
  assert.equal(f.decks.has('deck'), false);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'deck.deleted');
  assert.equal((await f.remove()).status, 404);
  assert.equal((await f.remove('missing')).status, 404);
});
