import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeDatabase } from '../src/utils/database.js';

test('existing terminal database migrates without losing rows, commands or history', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE terminals (
    id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, title TEXT NOT NULL, command TEXT,
    buffer TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  ); INSERT INTO terminals VALUES ('existing', 'deck', 'saved title', 'keep command',
    'preserved history', '2026-10-13');`);
  initializeDatabase(db);
  initializeDatabase(db); // Idempotent on subsequent restarts.
  assert.deepEqual({ ...db.prepare('SELECT * FROM terminals WHERE id = ?').get('existing') }, {
    id: 'existing', deck_id: 'deck', title: 'saved title', command: 'keep command',
    buffer: 'preserved history', created_at: '2026-10-13', cols: 120, rows: 32, tmux_socket: null,
  });
  db.prepare(`INSERT INTO terminals (id, deck_id, title, command, created_at, cols, rows, tmux_socket)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('new', 'deck', 'new title', null, '2026-10-14', 80, 24, '/isolated/tmux.sock');
  assert.equal(db.prepare('SELECT buffer FROM terminals WHERE id = ?').get('new')!.buffer, '');
  db.prepare('UPDATE terminals SET deck_id = ?, title = ? WHERE id = ?').run('moved', 'renamed', 'new');
  assert.equal(db.prepare('SELECT deck_id FROM terminals WHERE id = ?').get('new')!.deck_id, 'moved');
});
