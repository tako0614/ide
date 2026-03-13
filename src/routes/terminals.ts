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

const DEFAULT_TERMINAL_TITLE = 'ターミナル';
const MAX_SOCKET_BUFFERED_AMOUNT = 1024 * 1024;

export function createTerminalRouter(
  db: DatabaseSync,
  decks: Map<string, Deck>,
  terminals: Map<string, TerminalSession>
) {
  const router = new Hono();

  function toBuffer(data: Buffer | string): Buffer {
    return Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  }

  function appendToTerminalBuffer(session: TerminalSession, data: Buffer | string): void {
    const chunk = toBuffer(data);
    if (chunk.length === 0) {
      return;
    }

    if (chunk.length >= TERMINAL_BUFFER_LIMIT) {
      const retainedChunk = Buffer.from(chunk.subarray(chunk.length - TERMINAL_BUFFER_LIMIT));
      session.bufferBase += session.bufferLength + (chunk.length - TERMINAL_BUFFER_LIMIT);
      session.bufferChunks = [retainedChunk];
      session.bufferLength = retainedChunk.length;
      return;
    }

    session.bufferChunks.push(Buffer.from(chunk));
    session.bufferLength += chunk.length;

    while (session.bufferLength > TERMINAL_BUFFER_LIMIT && session.bufferChunks.length > 0) {
      const overflow = session.bufferLength - TERMINAL_BUFFER_LIMIT;
      const firstChunk = session.bufferChunks[0];

      if (firstChunk.length <= overflow) {
        session.bufferChunks.shift();
        session.bufferBase += firstChunk.length;
        session.bufferLength -= firstChunk.length;
        continue;
      }

      session.bufferChunks[0] = Buffer.from(firstChunk.subarray(overflow));
      session.bufferBase += overflow;
      session.bufferLength -= overflow;
    }
  }

  function getUniqueTerminalTitle(deckId: string, requestedTitle?: string): string {
    const trimmedTitle = requestedTitle?.trim();
    const baseTitle = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : null;
    const existingTitles = new Set(
      Array.from(terminals.values())
        .filter((session) => session.deckId === deckId)
        .map((session) => session.title)
    );

    if (!baseTitle) {
      let index = 1;
      while (existingTitles.has(`${DEFAULT_TERMINAL_TITLE} ${index}`)) {
        index++;
      }
      return `${DEFAULT_TERMINAL_TITLE} ${index}`;
    }

    if (!existingTitles.has(baseTitle)) {
      return baseTitle;
    }

    let suffix = 2;
    while (existingTitles.has(`${baseTitle} ${suffix}`)) {
      suffix++;
    }
    return `${baseTitle} ${suffix}`;
  }

  function broadcastToSockets(session: TerminalSession, data: Buffer | string): void {
    const payload = toBuffer(data);
    const deadSockets = new Set<WebSocket>();
    session.sockets.forEach((socket) => {
      try {
        if (socket.readyState !== 1) {
          deadSockets.add(socket);
          return;
        }
        if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_AMOUNT) {
          try { socket.close(1009, 'Terminal output overflow'); } catch { /* ignore */ }
          deadSockets.add(socket);
          return;
        }
        socket.send(payload, { binary: true }, (error) => {
          if (error) {
            try { socket.close(1011, 'Terminal stream error'); } catch { /* ignore */ }
          }
        });
      } catch {
        deadSockets.add(socket);
      }
    });
    deadSockets.forEach((s) => {
      session.sockets.delete(s);
      if (session.resizeOwner === s) {
        session.resizeOwner = null;
      }
    });
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
    session.resizeOwner = null;
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
      encoding: null,
      ...(isWindows ? { useConpty: true } : {}),
    } as any);

    console.log(`[TERMINAL] Created terminal ${id}: shell=${shell}, cwd=${deck.root}, pid=${term.pid}`);

    const resolvedTitle = getUniqueTerminalTitle(deck.id, title);
    const createdAt = new Date().toISOString();

    const session: TerminalSession = {
      id,
      deckId: deck.id,
      title: resolvedTitle,
      command: command || null,
      createdAt,
      sockets: new Set(),
      resizeOwner: null,
      bufferChunks: [],
      bufferLength: 0,
      bufferBase: 0,
      lastActive: Date.now(),
      write: (data) => {
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
        try { term.write(payload); } catch { /* terminal may be dying */ }
      },
      resize: (cols, rows) => { try { term.resize(cols, rows); } catch { /* terminal may be dying */ } },
      kill: () => { try { term.kill(); } catch { /* already dead */ } },
    };

    // Wire up PTY output → buffer + WebSocket broadcast
    (term as unknown as { on(eventName: 'data', listener: (data: Buffer | string) => void): void }).on('data', (data) => {
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
      session.resizeOwner = null;

      session.kill();

      return c.body(null, 204);
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
