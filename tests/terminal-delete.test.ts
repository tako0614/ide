import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createTerminalRouter } from '../src/routes/terminals.ts';
import { TmuxTerminalAdapter, type TmuxTerminalMeta } from '../src/terminal/tmuxAdapter.ts';
import { initializeDatabase, persistTerminalMetadata } from '../src/utils/database.ts';
import type { TerminalSession } from '../src/types.ts';

const ID = 'b1bd66d5-f62b-479e-a8b0-87da92244ee1';

function fixture(t: test.TestContext) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-delete-'));
  const previous = process.env.DECKIDE_TMUX_RUNTIME_DIR;
  process.env.DECKIDE_TMUX_RUNTIME_DIR = runtimeDir;
  const db = new DatabaseSync(':memory:'); initializeDatabase(db);
  const meta: TmuxTerminalMeta = {
    id: ID, deckId: 'deck-1', title: 'dead shell', command: null, createdAt: '2026-10-14T00:00:00Z',
    cols: 80, rows: 24, pid: 123456790, serverPid: 123456789,
    socketPath: path.join(runtimeDir, `s-${ID.replace(/-/g, '').slice(0, 16)}.sock`),
    sessionName: `deckide-${ID}`, sessionId: '$0', windowId: '@0', paneId: '%0', generation: ID,
  };
  persistTerminalMetadata(db, meta);
  db.prepare('INSERT INTO terminals (id,deck_id,title,created_at,tmux_socket) VALUES (?,?,?,?,?)')
    .run(ID, meta.deckId, meta.title, meta.createdAt, meta.socketPath);
  const terminals = new Map<string, TerminalSession>();
  const router = createTerminalRouter(new Map(), terminals, { db });
  t.after(() => {
    db.close(); fs.rmSync(runtimeDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DECKIDE_TMUX_RUNTIME_DIR;
    else process.env.DECKIDE_TMUX_RUNTIME_DIR = previous;
  });
  return { runtimeDir, db, meta, terminals, router };
}

test('DELETE removes an unavailable terminal, both DB projections and registry artifacts', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.runtimeDir, `${ID}.json`), JSON.stringify(f.meta), { mode: 0o600 });
  fs.writeFileSync(path.join(f.runtimeDir, `${ID}.conf`), 'set-option -g status off\n', { mode: 0o600 });
  const backend = new TmuxTerminalAdapter({ runtimeDir: f.runtimeDir });
  let closed = false;
  f.terminals.set(ID, { id: ID, deckId: f.meta.deckId, tmux: f.meta, available: false,
    kill: async () => backend.close(f.meta), sockets: new Set([{ close: () => { closed = true; } }]),
  } as unknown as TerminalSession);
  const response = await f.router.request(`/${ID}`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  assert.equal(f.terminals.has(ID), false); assert.equal(closed, true);
  assert.deepEqual(fs.readdirSync(f.runtimeDir), []);
  for (const table of ['terminal_metadata', 'terminals'])
    assert.equal(f.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(ID), undefined);
});

test('DELETE removes a DB-only row after registry files were already removed', async (t) => {
  const f = fixture(t);
  assert.equal((await f.router.request(`/${ID}`, { method: 'DELETE' })).status, 204);
  for (const table of ['terminal_metadata', 'terminals'])
    assert.equal(f.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(ID), undefined);
  assert.equal((await f.router.request(`/${ID}`, { method: 'DELETE' })).status, 404);
});

test('DELETE reaps a dead registry and its DB projections without an in-memory session', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.runtimeDir, `${ID}.json`), JSON.stringify(f.meta), { mode: 0o600 });
  fs.writeFileSync(path.join(f.runtimeDir, `${ID}.conf`), 'set-option -g status off\n', { mode: 0o600 });
  assert.equal((await f.router.request(`/${ID}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(fs.readdirSync(f.runtimeDir), []);
  assert.equal(f.db.prepare('SELECT id FROM terminal_metadata WHERE id=?').get(ID), undefined);
});

test('DELETE preserves DB rows when native termination fails', async (t) => {
  const f = fixture(t);
  f.terminals.set(ID, { id: ID, deckId: f.meta.deckId, available: true,
    kill: async () => { throw new Error('native identity changed'); }, sockets: new Set(),
  } as unknown as TerminalSession);
  assert.equal((await f.router.request(`/${ID}`, { method: 'DELETE' })).status, 500);
  assert.equal(f.terminals.has(ID), true);
  assert.ok(f.db.prepare('SELECT id FROM terminal_metadata WHERE id=?').get(ID));
});
