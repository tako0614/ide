import fsSync from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Workspace, Deck } from '../types.js';
import { getWorkspaceKey } from './path.js';

export type PersistedTerminal = {
  id: string;
  deckId: string;
  title: string;
  command: string | null;
  buffer: string;
  createdAt: string;
};

export function checkDatabaseIntegrity(dbPath: string): boolean {
  try {
    const tempDb = new DatabaseSync(dbPath);
    const result = tempDb.prepare('PRAGMA integrity_check').get();
    tempDb.close();
    return result && typeof result === 'object' && 'integrity_check' in result && result.integrity_check === 'ok';
  } catch {
    return false;
  }
}

export function handleDatabaseCorruption(dbPath: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const corruptedPath = `${dbPath}.corrupted-${timestamp}`;
  console.error('CRITICAL: Database corruption detected!');
  try {
    fsSync.renameSync(dbPath, corruptedPath);
    console.log(`Corrupted database moved to: ${corruptedPath}`);
  } catch (err) {
    console.error('Failed to move corrupted database:', err);
  }
}

export function initializeDatabase(db: DatabaseSync): void {
  // Enable WAL mode for better concurrent access
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      normalized_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS decks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS terminals (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL,
      title TEXT NOT NULL,
      command TEXT,
      buffer TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  // Create indexes for better query performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decks_workspace_id ON decks(workspace_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_terminals_deck_id ON terminals(deck_id);`);
}

export function loadPersistedState(
  db: DatabaseSync,
  workspaces: Map<string, Workspace>,
  workspacePathIndex: Map<string, string>,
  decks: Map<string, Deck>
): void {
  const workspaceRows = db
    .prepare(
      'SELECT id, name, path, created_at FROM workspaces ORDER BY created_at ASC'
    )
    .all();
  workspaceRows.forEach((row) => {
    const id = String(row.id);
    const name = String(row.name);
    const workspacePath = String(row.path);
    const createdAt = String(row.created_at);
    const workspace: Workspace = {
      id,
      name,
      path: workspacePath,
      createdAt
    };
    workspaces.set(id, workspace);
    workspacePathIndex.set(getWorkspaceKey(workspacePath), id);
  });

  const deckRows = db
    .prepare(
      'SELECT id, name, root, workspace_id, created_at FROM decks ORDER BY created_at ASC'
    )
    .all();
  deckRows.forEach((row) => {
    const workspaceId = String(row.workspace_id);
    if (!workspaces.has(workspaceId)) return;
    const deck: Deck = {
      id: String(row.id),
      name: String(row.name),
      root: String(row.root),
      workspaceId,
      createdAt: String(row.created_at)
    };
    decks.set(deck.id, deck);
  });
}

// Terminal persistence functions
export function loadPersistedTerminals(db: DatabaseSync, decks: Map<string, Deck>): PersistedTerminal[] {
  const rows = db
    .prepare(
      'SELECT id, deck_id, title, command, buffer, created_at FROM terminals ORDER BY created_at ASC'
    )
    .all();

  const terminals: PersistedTerminal[] = [];
  rows.forEach((row) => {
    const deckId = String(row.deck_id);
    // Only load terminals for existing decks
    if (!decks.has(deckId)) {
      // Clean up orphaned terminal
      db.prepare('DELETE FROM terminals WHERE id = ?').run(String(row.id));
      return;
    }
    terminals.push({
      id: String(row.id),
      deckId,
      title: String(row.title),
      command: row.command ? String(row.command) : null,
      buffer: String(row.buffer || ''),
      createdAt: String(row.created_at)
    });
  });

  return terminals;
}

export function saveTerminal(
  db: DatabaseSync,
  id: string,
  deckId: string,
  title: string,
  command: string | null,
  createdAt: string
): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO terminals (id, deck_id, title, command, buffer, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run(id, deckId, title, command, '', createdAt);
}

export function updateTerminalBuffer(db: DatabaseSync, id: string, buffer: string): void {
  const stmt = db.prepare('UPDATE terminals SET buffer = ? WHERE id = ?');
  stmt.run(buffer, id);
}

export function deleteTerminal(db: DatabaseSync, id: string): void {
  const stmt = db.prepare('DELETE FROM terminals WHERE id = ?');
  stmt.run(id);
}

export function saveAllTerminalBuffers(
  db: DatabaseSync,
  terminals: Map<string, { id: string; buffer: string }>
): void {
  const stmt = db.prepare('UPDATE terminals SET buffer = ? WHERE id = ?');
  terminals.forEach((session) => {
    stmt.run(session.buffer, session.id);
  });
}
