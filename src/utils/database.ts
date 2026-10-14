import fsSync from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Workspace, Deck } from '../types.js';
import { getWorkspaceKey } from './path.js';

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
  db.exec('PRAGMA synchronous = FULL;');

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

  // Inspect columns instead of suppressing unrelated migration failures.
  const addColumn = (table: string, column: string, declaration: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((row) => row.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  };
  addColumn('decks', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  // Legacy rows are retained as deletion blockers, never adopted as native tmux sessions.
  db.exec(`CREATE TABLE IF NOT EXISTS terminals (
    id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, title TEXT NOT NULL,
    command TEXT, buffer TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    cols INTEGER NOT NULL DEFAULT 120, rows INTEGER NOT NULL DEFAULT 32, tmux_socket TEXT
  )`);
  addColumn('terminals', 'cols', 'INTEGER NOT NULL DEFAULT 120');
  addColumn('terminals', 'rows', 'INTEGER NOT NULL DEFAULT 32');
  addColumn('terminals', 'tmux_socket', 'TEXT');
  // Rebuildable projection of owner-verified native registry metadata.
  db.exec(`CREATE TABLE IF NOT EXISTS terminal_metadata (
    id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, title TEXT NOT NULL,
    created_at TEXT NOT NULL, cols INTEGER NOT NULL, rows INTEGER NOT NULL,
    generation TEXT NOT NULL, tmux_socket TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_metadata_deck ON terminal_metadata(deck_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminals_deck ON terminals(deck_id)');

  // Create indexes for better query performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decks_workspace_id ON decks(workspace_id);`);
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
      'SELECT id, name, root, workspace_id, created_at FROM decks ORDER BY sort_order ASC, created_at ASC'
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



export function persistTerminalMetadata(db: DatabaseSync, meta: import('../terminal/tmuxAdapter.js').TmuxTerminalMeta): void {
  // GET restoration repeats this upsert. An identical UPDATE would still
  // append to WAL and synchronously commit once per terminal.
  db.prepare(`INSERT INTO terminal_metadata (id, deck_id, title, created_at, cols, rows, generation, tmux_socket)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET deck_id=excluded.deck_id, title=excluded.title,
      created_at=excluded.created_at, cols=excluded.cols, rows=excluded.rows,
      generation=excluded.generation, tmux_socket=excluded.tmux_socket
    WHERE terminal_metadata.deck_id IS NOT excluded.deck_id
       OR terminal_metadata.title IS NOT excluded.title
       OR terminal_metadata.created_at IS NOT excluded.created_at
       OR terminal_metadata.cols IS NOT excluded.cols
       OR terminal_metadata.rows IS NOT excluded.rows
       OR terminal_metadata.generation IS NOT excluded.generation
       OR terminal_metadata.tmux_socket IS NOT excluded.tmux_socket`)
    .run(meta.id, meta.deckId, meta.title, meta.createdAt, meta.cols, meta.rows, meta.generation, meta.socketPath);
}

/** Registry is canonical. A crash between replacement and commit is repaired at restore. */
export function commitTerminalMetadata(
  db: DatabaseSync, next: import('../terminal/tmuxAdapter.js').TmuxTerminalMeta,
  writeRegistry: () => void, restoreRegistry: () => void,
): void {
  db.exec('BEGIN IMMEDIATE');
  let registryChanged = false;
  try {
    persistTerminalMetadata(db, next);
    writeRegistry();
    registryChanged = true;
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    if (registryChanged) {
      try { restoreRegistry(); }
      catch (restoreError) {
        throw Object.assign(new Error('Terminal metadata compensation failed', { cause: restoreError }), { metadataUncertain: true });
      }
    }
    throw error;
  }
}
