import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { WebSocket } from 'ws';
import type { DatabaseSync } from 'node:sqlite';
import type { Deck, TerminalSession } from '../types.js';
import { TERMINAL_BUFFER_LIMIT } from '../config.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { getDefaultShell } from '../utils/shell.js';
import { saveTerminal, deleteTerminal as deleteTerminalFromDb, type PersistedTerminal } from '../utils/database.js';
import { PtyClient, type DaemonTerminalInfo } from '../pty-client.js';

// Track terminal index per deck for unique naming
const deckTerminalCounters = new Map<string, number>();

export function createTerminalRouter(
  db: DatabaseSync,
  decks: Map<string, Deck>,
  terminals: Map<string, TerminalSession>,
  ptyClient: PtyClient
) {
  const router = new Hono();

  function appendToTerminalBuffer(session: TerminalSession, data: string): void {
    const newBuffer = session.buffer + data;
    session.buffer =
      newBuffer.length > TERMINAL_BUFFER_LIMIT
        ? newBuffer.slice(newBuffer.length - TERMINAL_BUFFER_LIMIT)
        : newBuffer;
  }

  function getNextTerminalIndex(deckId: string): number {
    const current = deckTerminalCounters.get(deckId) ?? 0;
    const next = current + 1;
    deckTerminalCounters.set(deckId, next);
    return next;
  }

  // Central data handler: daemon streams output → update buffer → forward to WebSockets
  ptyClient.on('data', (id: string, data: string) => {
    const session = terminals.get(id);
    if (!session) return;

    appendToTerminalBuffer(session, data);
    session.lastActive = Date.now();

    const deadSockets = new Set<WebSocket>();
    session.sockets.forEach((socket) => {
      try {
        if (socket.readyState === 1) {
          socket.send(data);
        } else if (socket.readyState > 1) {
          deadSockets.add(socket);
        }
      } catch {
        deadSockets.add(socket);
      }
    });
    deadSockets.forEach((s) => session.sockets.delete(s));
  });

  // Central exit handler: PTY exited → close WebSockets, remove from map and DB
  ptyClient.on('exit', (id: string) => {
    const session = terminals.get(id);
    if (!session) return;

    console.log(`[TERMINAL] Terminal ${id} exited`);
    terminals.delete(id);
    deleteTerminalFromDb(db, id);

    session.sockets.forEach((socket) => {
      try { socket.close(1000, 'Terminal exited'); } catch { /* ignore */ }
    });
    session.sockets.clear();
  });

  async function createTerminalSession(
    deck: Deck,
    title?: string,
    command?: string,
    options?: { id?: string; initialBuffer?: string; skipDbSave?: boolean }
  ): Promise<TerminalSession> {
    const id = options?.id || crypto.randomUUID();

    // Resolve shell and arguments
    let shell: string;
    let shellArgs: string[] = [];

    if (command) {
      const defaultShell = getDefaultShell();
      shell = defaultShell;
      if (process.platform === 'win32') {
        if (defaultShell.toLowerCase().includes('powershell')) {
          shellArgs = ['-NoExit', '-Command', command];
        } else {
          shellArgs = ['/K', command];
        }
      } else {
        shellArgs = ['-c', command];
      }
    } else {
      shell = getDefaultShell();
    }

    // Build environment
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.TERM = env.TERM || 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'xterm.js';
    env.TERM_PROGRAM_VERSION = '5.0.0';
    if (process.platform === 'win32') {
      env.LANG = 'en_US.UTF-8';
    } else {
      env.LANG = env.LANG || 'en_US.UTF-8';
    }
    env.LC_ALL = env.LC_ALL || 'en_US.UTF-8';
    env.LC_CTYPE = env.LC_CTYPE || 'en_US.UTF-8';

    // Create PTY in the daemon
    await ptyClient.create({ id, shell, shellArgs, cwd: deck.root, env, cols: 120, rows: 32 });
    console.log(`[TERMINAL] Created terminal ${id} in daemon: shell=${shell}, cwd=${deck.root}`);

    const resolvedTitle = title || `Terminal ${getNextTerminalIndex(deck.id)}`;
    const createdAt = new Date().toISOString();

    const session: TerminalSession = {
      id,
      deckId: deck.id,
      title: resolvedTitle,
      command: command || null,
      createdAt,
      sockets: new Set(),
      buffer: options?.initialBuffer || '',
      lastActive: Date.now(),
      write: (data) => ptyClient.input(id, data),
      resize: (cols, rows) => ptyClient.resize(id, cols, rows),
      kill: () => ptyClient.kill(id),
    };

    if (!options?.skipDbSave) {
      saveTerminal(db, id, deck.id, resolvedTitle, command || null, createdAt);
    }

    terminals.set(id, session);

    // Subscribe to live output from daemon (delta since initialBuffer)
    ptyClient.attach(id, options?.initialBuffer?.length ?? 0);

    return session;
  }

  router.get('/', (c) => {
    const deckId = c.req.query('deckId');
    if (!deckId) {
      return c.json({ error: 'deckId is required' }, 400);
    }
    const sessions: Array<{ id: string; title: string; createdAt: string }> = [];
    terminals.forEach((session) => {
      if (session.deckId === deckId) {
        sessions.push({ id: session.id, title: session.title, createdAt: session.createdAt });
      }
    });
    sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return c.json(sessions);
  });

  router.post('/', async (c) => {
    try {
      const body = await readJson<{ deckId?: string; title?: string; command?: string }>(c);
      const deckId = body?.deckId;
      if (!deckId) throw createHttpError('deckId is required', 400);
      const deck = decks.get(deckId);
      if (!deck) throw createHttpError('Deck not found', 404);
      const session = await createTerminalSession(deck, body?.title, body?.command);
      return c.json({ id: session.id, title: session.title }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.delete('/:id', async (c) => {
    try {
      const terminalId = c.req.param('id');
      const session = terminals.get(terminalId);
      if (!session) throw createHttpError('Terminal not found', 404);

      terminals.delete(terminalId);
      deleteTerminalFromDb(db, terminalId);

      session.sockets.forEach((socket) => {
        try { socket.close(1000, 'Terminal deleted'); } catch { /* ignore */ }
      });
      session.sockets.clear();

      // Kill PTY in daemon
      session.kill();

      return c.body(null, 204);
    } catch (error) {
      return handleError(c, error);
    }
  });

  /**
   * Restore terminals after a server restart.
   * The daemon is the source of truth: only terminals alive in the daemon are restored.
   * DB provides metadata (title, deckId, buffer) for each daemon terminal.
   * Stale DB entries (no matching daemon terminal) are cleaned up.
   */
  async function restoreTerminals(
    persistedTerminals: PersistedTerminal[],
    daemonTerminals: DaemonTerminalInfo[]
  ): Promise<void> {
    const persistedById = new Map(persistedTerminals.map((t) => [t.id, t]));
    const daemonIds = new Set(daemonTerminals.map((t) => t.id));

    // Iterate daemon terminals — these are the only "real" ones
    for (const daemonInfo of daemonTerminals) {
      const persisted = persistedById.get(daemonInfo.id);
      const deck = persisted ? decks.get(persisted.deckId) : undefined;

      if (!persisted || !deck) {
        // No metadata to attach this terminal to a deck — kill it
        console.log(`[TERMINAL] Killing daemon terminal ${daemonInfo.id} (no deck metadata)`);
        try { await ptyClient.kill(daemonInfo.id); } catch { /* ignore */ }
        if (persisted) deleteTerminalFromDb(db, daemonInfo.id);
        continue;
      }

      try {
        console.log(`[TERMINAL] Re-attaching to live terminal ${persisted.id} (${persisted.title})`);

        const session: TerminalSession = {
          id: persisted.id,
          deckId: persisted.deckId,
          title: persisted.title,
          command: persisted.command,
          createdAt: persisted.createdAt,
          sockets: new Set(),
          buffer: persisted.buffer,
          lastActive: Date.now(),
          write: (data) => ptyClient.input(persisted.id, data),
          resize: (cols, rows) => ptyClient.resize(persisted.id, cols, rows),
          kill: () => ptyClient.kill(persisted.id),
        };

        terminals.set(persisted.id, session);
        ptyClient.attach(persisted.id, persisted.buffer.length);
      } catch (err) {
        console.error(`[TERMINAL] Failed to restore terminal ${daemonInfo.id}:`, err);
      }
    }

    // Clean up DB entries for terminals no longer alive in the daemon
    for (const persisted of persistedTerminals) {
      if (!daemonIds.has(persisted.id)) {
        console.log(`[TERMINAL] Removing stale terminal ${persisted.id} from DB`);
        deleteTerminalFromDb(db, persisted.id);
      }
    }
  }

  return { router, restoreTerminals };
}
