import fsSync from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Workspace, Deck, AgentSessionData } from '../types.js';
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      messages TEXT NOT NULL DEFAULT '[]',
      total_cost_usd REAL,
      max_cost_usd REAL,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Migration: add max_cost_usd column if missing (existing databases)
  try {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN max_cost_usd REAL');
  } catch {
    // Column already exists
  }

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

// Agent session persistence functions
export function saveAgentSession(db: DatabaseSync, session: AgentSessionData): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO agent_sessions (id, provider, prompt, cwd, status, messages, total_cost_usd, max_cost_usd, duration_ms, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  stmt.run(
    session.id,
    session.provider,
    session.prompt,
    session.cwd,
    session.status,
    JSON.stringify(session.messages),
    session.totalCostUsd ?? null,
    session.maxCostUsd ?? null,
    session.durationMs ?? null,
    session.error ?? null,
    session.createdAt
  );
}

export function updateAgentSession(
  db: DatabaseSync,
  id: string,
  updates: Partial<Pick<AgentSessionData, 'status' | 'messages' | 'totalCostUsd' | 'durationMs' | 'error'>>
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.messages !== undefined) {
    fields.push('messages = ?');
    values.push(JSON.stringify(updates.messages));
  }
  if (updates.totalCostUsd !== undefined) {
    fields.push('total_cost_usd = ?');
    values.push(updates.totalCostUsd);
  }
  if (updates.durationMs !== undefined) {
    fields.push('duration_ms = ?');
    values.push(updates.durationMs);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agent_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function loadAgentSessions(db: DatabaseSync): AgentSessionData[] {
  const rows = db
    .prepare('SELECT * FROM agent_sessions ORDER BY created_at ASC')
    .all();

  return rows.map((row) => ({
    id: String(row.id),
    provider: String(row.provider) as AgentSessionData['provider'],
    prompt: String(row.prompt),
    cwd: String(row.cwd),
    status: String(row.status) as AgentSessionData['status'],
    messages: JSON.parse(String(row.messages || '[]')),
    createdAt: String(row.created_at),
    totalCostUsd: row.total_cost_usd != null ? Number(row.total_cost_usd) : undefined,
    maxCostUsd: row.max_cost_usd != null ? Number(row.max_cost_usd) : undefined,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
    error: row.error ? String(row.error) : undefined
  }));
}

export function deleteAgentSession(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id);
}
