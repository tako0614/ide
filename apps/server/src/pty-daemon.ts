/**
 * PTY Daemon - standalone process that manages PTY sessions.
 *
 * Spawned as a detached child by the main server so it outlives server restarts.
 * Communicates with the server over a local TCP socket using newline-delimited JSON.
 *
 * Protocol (Server → Daemon):
 *   { type:"create", id, shell, shellArgs, cwd, env, cols, rows }
 *   { type:"input",  id, data }
 *   { type:"resize", id, cols, rows }
 *   { type:"kill",   id }
 *   { type:"attach", id, bufferOffset }  -- start streaming data for this terminal
 *   { type:"list" }                       -- list active terminal IDs
 *   { type:"shutdown" }                   -- terminate daemon and all PTYs
 *
 * Protocol (Daemon → Server):
 *   { type:"created",     id }
 *   { type:"data",        id, data }      -- only for attached terminals
 *   { type:"exit",        id, code }
 *   { type:"list_result", terminals: [{id, bufferLength}] }
 *   { type:"shutdown_ack" }
 *   { type:"error",       id?, message }
 */
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';

const DAEMON_INFO_PATH = process.env.DAEMON_INFO_PATH;
const BUFFER_LIMIT = Number(process.env.TERMINAL_BUFFER_LIMIT || 50000);

if (!DAEMON_INFO_PATH) {
  console.error('[pty-daemon] DAEMON_INFO_PATH env var is required');
  process.exit(1);
}

interface DaemonSession {
  id: string;
  term: IPty;
  buffer: string;
}

const sessions = new Map<string, DaemonSession>();
// IDs the server is currently subscribed to (receives live data for)
const attached = new Set<string>();
let serverSocket: net.Socket | null = null;
let shuttingDown = false;

function appendBuffer(session: DaemonSession, data: string): void {
  const combined = session.buffer + data;
  session.buffer =
    combined.length > BUFFER_LIMIT
      ? combined.slice(combined.length - BUFFER_LIMIT)
      : combined;
}

function sendToServer(msg: object): void {
  if (serverSocket && !serverSocket.destroyed) {
    try {
      serverSocket.write(JSON.stringify(msg) + '\n');
    } catch {
      // Socket may have just closed
    }
  }
}

function handleMessage(msg: any): void {
  switch (msg.type) {
    case 'create': {
      const { id, shell, shellArgs = [], cwd, env, cols = 120, rows = 32 } = msg;
      if (sessions.has(id)) {
        // Already exists - just ack
        sendToServer({ type: 'created', id });
        return;
      }
      try {
        const isWindows = process.platform === 'win32';
        const term = spawn(shell, shellArgs, {
          cwd,
          cols,
          rows,
          env,
          encoding: 'utf8',
          ...(isWindows ? { useConpty: true } : {}),
        } as any);

        const session: DaemonSession = { id, term, buffer: '' };
        sessions.set(id, session);

        term.onData((data: string) => {
          appendBuffer(session, data);
          if (attached.has(id)) {
            sendToServer({ type: 'data', id, data });
          }
        });

        term.onExit(({ exitCode }) => {
          sessions.delete(id);
          attached.delete(id);
          sendToServer({ type: 'exit', id, code: exitCode });
        });

        sendToServer({ type: 'created', id });
        console.log(`[pty-daemon] Created terminal ${id} (pid=${term.pid})`);
      } catch (err) {
        console.error(`[pty-daemon] Failed to create terminal ${id}:`, err);
        sendToServer({ type: 'error', id, message: String(err) });
      }
      break;
    }

    case 'input': {
      const session = sessions.get(msg.id);
      if (session) {
        try { session.term.write(msg.data); } catch { /* terminal may be dying */ }
      }
      break;
    }

    case 'resize': {
      const session = sessions.get(msg.id);
      if (session) {
        try { session.term.resize(msg.cols, msg.rows); } catch { /* terminal may be dying */ }
      }
      break;
    }

    case 'kill': {
      const session = sessions.get(msg.id);
      if (session) {
        sessions.delete(msg.id);
        attached.delete(msg.id);
        try { session.term.kill(); } catch { /* already dead */ }
        console.log(`[pty-daemon] Killed terminal ${msg.id}`);
      }
      break;
    }

    case 'attach': {
      const session = sessions.get(msg.id);
      if (!session) {
        sendToServer({ type: 'error', id: msg.id, message: 'Terminal not found' });
        return;
      }
      attached.add(msg.id);
      // Send buffered output the server hasn't seen yet
      const offset = Number(msg.bufferOffset) || 0;
      const delta = offset > 0 ? session.buffer.slice(offset) : session.buffer;
      if (delta) {
        sendToServer({ type: 'data', id: msg.id, data: delta });
      }
      break;
    }

    case 'list': {
      const terminals = Array.from(sessions.entries()).map(([id, s]) => ({
        id,
        bufferLength: s.buffer.length,
      }));
      sendToServer({ type: 'list_result', terminals });
      break;
    }

    case 'shutdown': {
      sendToServer({ type: 'shutdown_ack' });
      // ackを送信しきるため少し待ってから終了
      setTimeout(() => {
        shutdown();
      }, 10);
      break;
    }

    default:
      console.warn(`[pty-daemon] Unknown message type: ${msg.type}`);
  }
}

// TCP server - accepts one connection from the main server at a time
const tcpServer = net.createServer((socket) => {
  // Close previous connection if server reconnects
  if (serverSocket && !serverSocket.destroyed) {
    serverSocket.destroy();
  }
  serverSocket = socket;
  attached.clear(); // New connection starts with no subscriptions
  console.log('[pty-daemon] Main server connected');

  let lineBuf = '';
  socket.on('data', (chunk) => {
    lineBuf += chunk.toString('utf8');
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch (err) {
        console.error('[pty-daemon] Failed to parse message:', err);
      }
    }
  });

  socket.on('close', () => {
    if (serverSocket === socket) {
      serverSocket = null;
      attached.clear();
      console.log('[pty-daemon] Main server disconnected');
    }
  });

  socket.on('error', (err) => {
    console.error('[pty-daemon] Socket error:', err.message);
  });
});

tcpServer.on('error', (err) => {
  console.error('[pty-daemon] TCP server error:', err);
  process.exit(1);
});

// Listen on a random available port, then write info file for the server to find us
tcpServer.listen(0, '127.0.0.1', () => {
  const addr = tcpServer.address() as net.AddressInfo;
  const info = { pid: process.pid, port: addr.port };
  fs.writeFileSync(DAEMON_INFO_PATH!, JSON.stringify(info));
  console.log(
    `[pty-daemon] Running on port ${addr.port} (pid ${process.pid})`
  );
});

function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log('[pty-daemon] Shutting down...');
  sessions.forEach(({ term }) => {
    try { term.kill(); } catch { /* ignore */ }
  });
  sessions.clear();
  try { serverSocket?.destroy(); } catch { /* ignore */ }
  try { tcpServer.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(DAEMON_INFO_PATH!); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep the daemon alive even on unexpected errors
process.on('uncaughtException', (err) => {
  console.error('[pty-daemon] Uncaught exception (continuing):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[pty-daemon] Unhandled rejection (continuing):', err);
});
