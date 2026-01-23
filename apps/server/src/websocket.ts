import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { TerminalSession } from './types.js';
import { PORT, TRUST_PROXY } from './config.js';
import { logSecurityEvent } from './middleware/security.js';
import { verifyWebSocketAuth } from './middleware/auth.js';

const MIN_TERMINAL_SIZE = 1;
const MAX_TERMINAL_SIZE = 500;
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB max message size

// Configurable connection limit per IP (default: 1000)
let maxConnectionsPerIP = 1000;

// Track connections per IP
const connectionsByIP = new Map<string, Set<WebSocket>>();

// Export for API access
export function getConnectionLimit(): number {
  return maxConnectionsPerIP;
}

export function setConnectionLimit(limit: number): void {
  maxConnectionsPerIP = Math.max(1, Math.floor(limit));
}

export function getConnectionStats(): { ip: string; count: number }[] {
  const stats: { ip: string; count: number }[] = [];
  for (const [ip, connections] of connectionsByIP) {
    stats.push({ ip, count: connections.size });
  }
  return stats;
}

export function clearAllConnections(): number {
  let closedCount = 0;
  for (const [ip, connections] of connectionsByIP) {
    for (const socket of connections) {
      try {
        socket.close(1000, 'Connection cleared by admin');
        closedCount++;
      } catch {
        // Socket might already be closed
      }
    }
  }
  connectionsByIP.clear();
  return closedCount;
}

function getClientIP(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string') {
      return realIp;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

function trackConnection(ip: string, socket: WebSocket): boolean {
  let connections = connectionsByIP.get(ip);
  if (!connections) {
    connections = new Set();
    connectionsByIP.set(ip, connections);
  }
  if (connections.size >= maxConnectionsPerIP) {
    return false;
  }
  connections.add(socket);
  return true;
}

function untrackConnection(ip: string, socket: WebSocket): void {
  const connections = connectionsByIP.get(ip);
  if (connections) {
    connections.delete(socket);
    if (connections.size === 0) {
      connectionsByIP.delete(ip);
    }
  }
}

function validateTerminalSize(value: number): number {
  const intValue = Math.floor(value);
  if (!Number.isFinite(intValue) || intValue < MIN_TERMINAL_SIZE) {
    return MIN_TERMINAL_SIZE;
  }
  if (intValue > MAX_TERMINAL_SIZE) {
    return MAX_TERMINAL_SIZE;
  }
  return intValue;
}

export function setupWebSocketServer(
  server: HttpServer | HttpsServer,
  terminals: Map<string, TerminalSession>
): WebSocketServer {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket: WebSocket, req) => {
    const socketId = crypto.randomUUID();
    const clientIP = getClientIP(req);

    // Add error handler for socket
    socket.on('error', (error) => {
      console.error(`WebSocket error for socket ${socketId}:`, error.message);
      try {
        socket.close(1011, 'Internal error');
      } catch {
        // Socket might already be closed
      }
    });

    // Check connection limit per IP
    if (!trackConnection(clientIP, socket)) {
      logSecurityEvent('WS_CONNECTION_LIMIT_EXCEEDED', { ip: clientIP });
      socket.close(1013, 'Too many connections');
      return;
    }

    if (!verifyWebSocketAuth(req)) {
      logSecurityEvent('WS_AUTH_FAILED', { ip: clientIP });
      untrackConnection(clientIP, socket);
      socket.close(1008, 'Unauthorized');
      return;
    }

    const url = new URL(req.url || '', `http://localhost:${PORT}`);
    const match = url.pathname.match(/\/api\/terminals\/(.+)/);
    if (!match) {
      socket.close(1002, 'Invalid path');
      return;
    }

    const id = match[1];
    const session = terminals.get(id);
    if (!session) {
      socket.close(1002, 'Terminal not found');
      return;
    }

    const wsConnectTime = Date.now();
    console.log(`[PERF] WebSocket connected to terminal ${id} at ${wsConnectTime}`);

    session.sockets.add(socket);
    session.lastActive = Date.now();

    // Send buffer content if available
    if (session.buffer) {
      try {
        const bufferSize = session.buffer.length;
        console.log(`[PERF] Sending ${bufferSize} chars of buffered data to terminal ${id}`);
        socket.send(session.buffer);
      } catch (error) {
        console.error(`Failed to send buffer to socket ${socketId}:`, error);
      }
    }

    socket.on('message', (data) => {
      try {
        // Convert to string
        const message = data.toString('utf8');

        // Check message size
        const messageSize = Buffer.byteLength(message, 'utf8');
        if (messageSize > MAX_MESSAGE_SIZE) {
          logSecurityEvent('WS_MESSAGE_TOO_LARGE', { ip: clientIP, size: messageSize });
          socket.send('\r\n\x1b[31mMessage too large. Maximum size is 64KB.\x1b[0m\r\n');
          return;
        }

        session.lastActive = Date.now();

        // Debug: Log responses from client
        if (message.match(/\x1b\[\d+;\d+R/)) {
          console.log(`[RESPONSE] CPR (cursor position) from client to terminal ${id}`);
        }
        if (message.match(/\x1b\[\?[^;]+;[0-4]\$y/)) {
          const match = message.match(/\x1b\[\?(\d+);([0-4])\$y/);
          const mode = match ? match[1] : '?';
          const status = match ? match[2] : '?';
          console.log(`[RESPONSE] DECRQM mode ${mode} status ${status} from client to terminal ${id}`);
        }
        if (message.match(/\x1b\[\?[\d;]+c/)) {
          console.log(`[RESPONSE] DA1 from client to terminal ${id}`);
        }
        if (message.match(/\x1b\[>[^c]*c/)) {
          console.log(`[RESPONSE] DA2 from client to terminal ${id}`);
        }
        if (message.match(/\x1bP>[\|]/)) {
          console.log(`[RESPONSE] XTVERSION from client to terminal ${id}`);
        }
        if (message.match(/\x1b\]1[012];rgb:/)) {
          console.log(`[RESPONSE] OSC color from client to terminal ${id}`);
        }
        if (message.match(/\x1b\]4;\d+;rgb:/)) {
          console.log(`[RESPONSE] OSC 4 color palette from client to terminal ${id}`);
        }
        if (message.match(/\x1b\[8;\d+;\d+t/)) {
          console.log(`[RESPONSE] XTWINOPS window size from client to terminal ${id}`);
        }
        if (message.match(/\x1b\[\?\d+m/)) {
          console.log(`[RESPONSE] XTQMODKEYS from client to terminal ${id}`);
        }
        if (message.match(/\x1bP[01]\$r/)) {
          console.log(`[RESPONSE] DECRQSS/XTGETTCAP from client to terminal ${id}`);
        }

        // Check for resize message
        if (message.startsWith('\u0000resize:')) {
          const payload = message.slice('\u0000resize:'.length);
          const [colsRaw, rowsRaw] = payload.split(',');
          const cols = validateTerminalSize(Number(colsRaw));
          const rows = validateTerminalSize(Number(rowsRaw));

          try {
            session.term.resize(cols, rows);
          } catch (resizeError) {
            console.error(`Failed to resize terminal ${id}:`, resizeError);
          }
          return;
        }

        try {
          // Write user input to terminal
          session.term.write(message);
        } catch (writeError) {
          console.error(`Failed to write to terminal ${id}:`, writeError);
        }
      } catch (error) {
        console.error(`Error handling WebSocket message for socket ${socketId}:`, error);
      }
    });

    socket.on('close', (code, reason) => {
      console.log(`[WS] Socket ${socketId} closed for terminal ${id}: code=${code}, reason=${reason?.toString() || 'none'}`);
      session.sockets.delete(socket);
      session.lastActive = Date.now();
      untrackConnection(clientIP, socket);
    });
  });

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });

  return wss;
}

