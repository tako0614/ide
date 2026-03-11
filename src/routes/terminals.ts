import crypto from 'node:crypto';
import { Hono } from 'hono';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import type { DatabaseSync } from 'node:sqlite';
import type { Deck, TerminalSession } from '../types.js';
import { TERMINAL_BUFFER_LIMIT } from '../config.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { getDefaultShell } from '../utils/shell.js';
import { saveTerminal, deleteTerminal as deleteTerminalFromDb } from '../utils/database.js';

// Track terminal index per deck for unique naming
const deckTerminalCounters = new Map<string, number>();

export function createTerminalRouter(
  db: DatabaseSync,
  decks: Map<string, Deck>,
  terminals: Map<string, TerminalSession>
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

  function broadcastToSockets(session: TerminalSession, data: string): void {
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
  }

  function handleTerminalExit(id: string): void {
    const session = terminals.get(id);
    if (!session) return;

    console.log(`[TERMINAL] Terminal ${id} exited`);
    terminals.delete(id);
    deleteTerminalFromDb(db, id);

    session.sockets.forEach((socket) => {
      try { socket.close(1000, 'Terminal exited'); } catch { /* ignore */ }
    });
    session.sockets.clear();
  }

  function createTerminalSession(
    deck: Deck,
    title?: string,
    command?: string
  ): TerminalSession {
    const id = crypto.randomUUID();

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

    // Spawn PTY directly in this process
    const isWindows = process.platform === 'win32';
    const term: IPty = spawn(shell, shellArgs, {
      cwd: deck.root,
      cols: 120,
      rows: 32,
      env,
      encoding: 'utf8',
      ...(isWindows ? { useConpty: true } : {}),
    } as any);

    console.log(`[TERMINAL] Created terminal ${id}: shell=${shell}, cwd=${deck.root}, pid=${term.pid}`);

    const resolvedTitle = title || `Terminal ${getNextTerminalIndex(deck.id)}`;
    const createdAt = new Date().toISOString();

    const session: TerminalSession = {
      id,
      deckId: deck.id,
      title: resolvedTitle,
      command: command || null,
      createdAt,
      sockets: new Set(),
      buffer: '',
      lastActive: Date.now(),
      write: (data) => { try { term.write(data); } catch { /* terminal may be dying */ } },
      resize: (cols, rows) => { try { term.resize(cols, rows); } catch { /* terminal may be dying */ } },
      kill: () => { try { term.kill(); } catch { /* already dead */ } },
    };

    // Wire up PTY output → buffer + WebSocket broadcast
    term.onData((data: string) => {
      appendToTerminalBuffer(session, data);
      session.lastActive = Date.now();
      broadcastToSockets(session, data);
    });

    term.onExit(() => {
      handleTerminalExit(id);
    });

    saveTerminal(db, id, deck.id, resolvedTitle, command || null, createdAt);
    terminals.set(id, session);

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
      const session = createTerminalSession(deck, body?.title, body?.command);
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

      session.kill();

      return c.body(null, 204);
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
