import crypto from 'node:crypto';
import { Hono } from 'hono';
import { spawn } from 'node-pty';
import type { Deck, TerminalSession } from '../types.js';
import { TERMINAL_BUFFER_LIMIT } from '../config.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { getDefaultShell } from '../utils/shell.js';

// Track terminal index per deck for unique naming
const deckTerminalCounters = new Map<string, number>();

export function createTerminalRouter(
  decks: Map<string, Deck>,
  terminals: Map<string, TerminalSession>
) {
  const router = new Hono();

  function appendToTerminalBuffer(session: TerminalSession, data: string): void {
    // Limit buffer size to prevent memory issues
    const newBuffer = session.buffer + data;
    if (newBuffer.length > TERMINAL_BUFFER_LIMIT) {
      session.buffer = newBuffer.slice(newBuffer.length - TERMINAL_BUFFER_LIMIT);
    } else {
      session.buffer = newBuffer;
    }
  }

  function getNextTerminalIndex(deckId: string): number {
    const current = deckTerminalCounters.get(deckId) ?? 0;
    const next = current + 1;
    deckTerminalCounters.set(deckId, next);
    return next;
  }

  function createTerminalSession(deck: Deck, title?: string, command?: string): TerminalSession {
    const id = crypto.randomUUID();

    // Determine shell and arguments
    let shell: string;
    let shellArgs: string[] = [];

    if (command) {
      // Run custom command through shell
      const defaultShell = getDefaultShell();
      if (process.platform === 'win32') {
        // Windows: use powershell to run the command
        shell = defaultShell; // powershell.exe or cmd.exe
        if (defaultShell.toLowerCase().includes('powershell')) {
          shellArgs = ['-NoExit', '-Command', command];
        } else {
          // cmd.exe
          shellArgs = ['/K', command];
        }
      } else {
        // Unix: use shell with -c
        shell = defaultShell; // bash, zsh, etc.
        shellArgs = ['-c', command];
      }
    } else {
      // Default shell with no arguments
      shell = getDefaultShell();
    }

    const env: Record<string, string> = {};

    // Copy environment variables safely
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    // Set terminal capabilities for rich TUI support
    env.TERM = env.TERM || 'xterm-256color';
    env.COLORTERM = 'truecolor'; // Indicate 24-bit color support
    env.TERM_PROGRAM = 'xterm.js'; // Terminal program name
    env.TERM_PROGRAM_VERSION = '5.0.0'; // Version

    // Force UTF-8 for ConPTY
    if (process.platform === 'win32') {
      env.LANG = 'en_US.UTF-8';
    } else {
      env.LANG = env.LANG || 'en_US.UTF-8';
    }

    // Ensure LC_* variables are set for proper locale support
    env.LC_ALL = env.LC_ALL || 'en_US.UTF-8';
    env.LC_CTYPE = env.LC_CTYPE || 'en_US.UTF-8';

    const isWindows = process.platform === 'win32';
    let term;
    try {
      const spawnOptions: any = {
        cwd: deck.root,
        cols: 120,
        rows: 32,
        env
      };

      // Use ConPTY on Windows for better TUI support
      // Note: AttachConsole errors are suppressed in server.ts
      if (isWindows) {
        spawnOptions.useConpty = true;
      } else {
        spawnOptions.encoding = 'utf8';
      }

      const spawnStart = Date.now();
      term = spawn(shell, shellArgs, spawnOptions);
      const spawnTime = Date.now() - spawnStart;

      if (command) {
        console.log(`[TERMINAL] Created terminal ${id} with command="${command}" using shell=${shell} args=${JSON.stringify(shellArgs)}`);
      } else {
        console.log(`[TERMINAL] Created terminal ${id} with TERM=${env.TERM}, COLORTERM=${env.COLORTERM}, TERM_PROGRAM=${env.TERM_PROGRAM}`);
      }
      if (spawnTime > 100) {
        console.log(`[PERF] Terminal spawn took ${spawnTime}ms for deck ${deck.id}`);
      }
    } catch (spawnError) {
      const message = spawnError instanceof Error ? spawnError.message : 'Failed to spawn terminal';
      console.error(`Failed to spawn terminal for deck ${deck.id}:`, spawnError);
      throw createHttpError(`Failed to create terminal: ${message}`, 500);
    }

    const resolvedTitle = title || `Terminal ${getNextTerminalIndex(deck.id)}`;
    const sessionStart = Date.now();
    let firstDataReceived = false;

    const session: TerminalSession = {
      id,
      deckId: deck.id,
      title: resolvedTitle,
      createdAt: new Date().toISOString(),
      term,
      sockets: new Set(),
      buffer: '',
      lastActive: Date.now(),
      dispose: null
    };

    // Set up data handler
    try {
      session.dispose = term.onData((data: string | Buffer) => {
        // Track time to first data
        if (!firstDataReceived) {
          firstDataReceived = true;
          const timeToFirstData = Date.now() - sessionStart;
          if (timeToFirstData > 100) {
            console.log(`[PERF] Time to first data: ${timeToFirstData}ms for terminal ${id}`);
          }
        }

        try {
          // Convert to string for storage and transmission
          const strData = typeof data === 'string' ? data : data.toString('utf8');
          appendToTerminalBuffer(session, strData);
          session.lastActive = Date.now();

          // Debug: Log terminal queries sent to client
          if (strData.match(/\x1b\[(\?)?(\d*)n/)) {
            console.log(`[QUERY] DSR request from terminal ${id}`);
          }
          if (strData.match(/\x1b\[(\?)?c/) && !strData.match(/\x1b\[>/)) {
            console.log(`[QUERY] DA1 request from terminal ${id}`);
          }
          if (strData.match(/\x1b\[>c/) || strData.match(/\x1b\[>0?c/)) {
            console.log(`[QUERY] DA2 request from terminal ${id}`);
          }
          if (strData.match(/\x1b\[>\s*q/)) {
            console.log(`[QUERY] XTVERSION request from terminal ${id}`);
          }
          if (strData.match(/\x1b\[\?\d+\$p/)) {
            console.log(`[QUERY] DECRQM (mode query) from terminal ${id}`);
          }
          if (strData.match(/\x1b\]1[012];?\?/)) {
            const match = strData.match(/\x1b\]1([012]);?\?/);
            const type = match ? ['FG', 'BG', 'Cursor'][parseInt(match[1])] : 'unknown';
            console.log(`[QUERY] OSC ${10 + parseInt(match?.[1] || '0')} color query (${type}) from terminal ${id}`);
          }
          if (strData.match(/\x1b\]4;\d+;?\?/)) {
            console.log(`[QUERY] OSC 4 color palette query from terminal ${id}`);
          }
          if (strData.match(/\x1b\]52;/)) {
            console.log(`[QUERY] OSC 52 clipboard query from terminal ${id}`);
          }
          if (strData.match(/\x1b\[\d+t/)) {
            const match = strData.match(/\x1b\[(\d+)t/);
            const op = match ? match[1] : '?';
            console.log(`[QUERY] XTWINOPS (${op}t) from terminal ${id}`);
          }
          if (strData.match(/\x1b\[\?[^S]+S/)) {
            console.log(`[QUERY] XTSMGRAPHICS (sixel) from terminal ${id}`);
          }
          if (strData.match(/\x1b\[\?u/)) {
            console.log(`[QUERY] CSI u keyboard protocol query from terminal ${id}`);
          }
          if (strData.match(/\x1b\[\?\d+m/)) {
            console.log(`[QUERY] XTQMODKEYS (modifyOtherKeys) from terminal ${id}`);
          }
          if (strData.match(/\x1bP\$q/)) {
            console.log(`[QUERY] DECRQSS (status string) from terminal ${id}`);
          }
          if (strData.match(/\x1bP\+q/)) {
            console.log(`[QUERY] XTGETTCAP (termcap) from terminal ${id}`);
          }

          if (process.env.DEBUG_TERMINAL) {
            const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
            const hexDump = buffer.toString('hex').match(/.{1,2}/g)?.join(' ') || '';
            if (strData.includes('\x1b') || strData.includes('\x07')) {
              console.log(`[TERM ${id}] Escape seq (${strData.length} chars, ${buffer.length} bytes): ${hexDump.slice(0, 200)}`);
            }
          }

          // Send data to all connected websockets as UTF-8 string
          const deadSockets = new Set<WebSocket>();
          session.sockets.forEach((socket) => {
            try {
              if (socket.readyState === 1) {
                socket.send(strData);
              } else if (socket.readyState > 1) {
                deadSockets.add(socket);
              }
            } catch (sendError) {
              console.error(`Failed to send data to socket:`, sendError);
              deadSockets.add(socket);
            }
          });

          // Clean up dead sockets
          deadSockets.forEach(socket => session.sockets.delete(socket));
        } catch (dataError) {
          console.error(`Error in terminal data handler:`, dataError);
        }
      });
    } catch (onDataError) {
      console.error(`Failed to set up terminal data handler:`, onDataError);
      try {
        term.kill();
      } catch {
        // Ignore kill error
      }
      throw createHttpError('Failed to set up terminal', 500);
    }

    // Set up exit handler
    term.onExit(({ exitCode }) => {
      console.log(`Terminal ${id} exited with code ${exitCode}`);

      // Check if already cleaned up (by cleanup interval or delete endpoint)
      if (!terminals.has(id)) {
        return;
      }

      // Remove from map first
      terminals.delete(id);

      // Close all WebSocket connections
      session.sockets.forEach((socket) => {
        try {
          socket.close(1000, 'Terminal exited');
        } catch {
          // Ignore close errors
        }
      });
      session.sockets.clear();

      // Dispose the data listener
      if (session.dispose) {
        try {
          session.dispose.dispose();
          session.dispose = null;
        } catch {
          // Ignore dispose errors
        }
      }
    });

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
        sessions.push({
          id: session.id,
          title: session.title,
          createdAt: session.createdAt
        });
      }
    });
    sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return c.json(sessions);
  });

  router.post('/', async (c) => {
    try {
      const body = await readJson<{ deckId?: string; title?: string; command?: string }>(c);
      const deckId = body?.deckId;
      if (!deckId) {
        throw createHttpError('deckId is required', 400);
      }
      const deck = decks.get(deckId);
      if (!deck) {
        throw createHttpError('Deck not found', 404);
      }
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
      if (!session) {
        throw createHttpError('Terminal not found', 404);
      }

      // Remove from map first to prevent race conditions
      terminals.delete(terminalId);

      // Close all WebSocket connections
      session.sockets.forEach((socket) => {
        try {
          socket.close(1000, 'Terminal deleted');
        } catch {
          // Ignore close errors
        }
      });
      session.sockets.clear();

      // Dispose the data listener
      if (session.dispose) {
        try {
          session.dispose.dispose();
          session.dispose = null;
        } catch (disposeError) {
          console.error(`Failed to dispose terminal ${terminalId}:`, disposeError);
        }
      }

      // Kill the terminal process
      try {
        if (session.term) {
          session.term.kill();
        }
      } catch (killError) {
        console.error(`Failed to kill terminal ${terminalId}:`, killError);
      }

      return c.body(null, 204);
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
