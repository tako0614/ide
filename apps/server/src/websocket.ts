import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { TerminalSession } from './types.js';
import {
  PORT,
  TERMINAL_IDLE_TIMEOUT_MS,
  WS_RATE_LIMIT_WINDOW_MS,
  WS_RATE_LIMIT_MAX_MESSAGES,
  TRUST_PROXY
} from './config.js';
import { checkWebSocketRateLimit, wsMessageRateLimits, logSecurityEvent } from './middleware/security.js';
import { verifyWebSocketAuth } from './middleware/auth.js';

const MIN_TERMINAL_SIZE = 1;
const MAX_TERMINAL_SIZE = 500;
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB max message size
const MAX_CONNECTIONS_PER_IP = 10;

// Track connections per IP
const connectionsByIP = new Map<string, Set<WebSocket>>();

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
  if (connections.size >= MAX_CONNECTIONS_PER_IP) {
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

    session.sockets.add(socket);
    session.lastActive = Date.now();

    // Send buffer content if available
    if (session.buffer) {
      try {
        socket.send(session.buffer);
      } catch (error) {
        console.error(`Failed to send buffer to socket ${socketId}:`, error);
      }
    }

    socket.on('message', (data) => {
      try {
        // Check message size
        const messageSize = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data.toString());
        if (messageSize > MAX_MESSAGE_SIZE) {
          logSecurityEvent('WS_MESSAGE_TOO_LARGE', { ip: clientIP, size: messageSize });
          socket.send('\r\n\x1b[31mMessage too large. Maximum size is 64KB.\x1b[0m\r\n');
          return;
        }

        if (!checkWebSocketRateLimit(socketId, WS_RATE_LIMIT_WINDOW_MS, WS_RATE_LIMIT_MAX_MESSAGES)) {
          logSecurityEvent('WS_RATE_LIMIT_EXCEEDED', { ip: clientIP, socketId });
          socket.send('\r\n\x1b[31mRate limit exceeded. Please slow down.\x1b[0m\r\n');
          return;
        }

        session.lastActive = Date.now();
        const message = data.toString();

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
          session.term.write(message);
        } catch (writeError) {
          console.error(`Failed to write to terminal ${id}:`, writeError);
        }
      } catch (error) {
        console.error(`Error handling WebSocket message for socket ${socketId}:`, error);
      }
    });

    socket.on('close', () => {
      session.sockets.delete(socket);
      session.lastActive = Date.now();
      wsMessageRateLimits.delete(socketId);
      untrackConnection(clientIP, socket);
    });
  });

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });

  return wss;
}

export function setupTerminalCleanup(terminals: Map<string, TerminalSession>): void {
  setInterval(() => {
    const now = Date.now();
    terminals.forEach((session, id) => {
      if (
        session.sockets.size === 0 &&
        now - session.lastActive > TERMINAL_IDLE_TIMEOUT_MS
      ) {
        try {
          if (session.dispose) {
            session.dispose.dispose();
          }
        } catch (error) {
          console.error(`Failed to dispose terminal ${id}:`, error);
        }

        try {
          session.term.kill();
        } catch (error) {
          console.error(`Failed to kill terminal ${id}:`, error);
        }

        terminals.delete(id);
      }
    });
  }, 60_000).unref();
}
