import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { TerminalSession } from './types.js';
import { PORT, TRUST_PROXY, CORS_ORIGIN, NODE_ENV } from './config.js';
import { logSecurityEvent } from './middleware/security.js';
import { verifyWebSocketAuth } from './middleware/auth.js';

const MIN_TERMINAL_SIZE = 1;
const MAX_TERMINAL_SIZE = 500;
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB max message size
const MAX_SOCKET_BUFFERED_AMOUNT = 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

type ClientControlMessage =
  | { type: 'claim' }
  | { type: 'resize'; cols: number; rows: number };

type ServerControlMessage =
  | { type: 'sync'; offsetBase: number; reset: boolean }
  | { type: 'ready' };

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

function rawDataByteLength(data: RawData): number {
  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf8');
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.length, 0);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return data.length;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return data;
}

function canSendToSocket(socket: WebSocket): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_AMOUNT) {
    try { socket.close(1009, 'Terminal output overflow'); } catch { /* ignore */ }
    return false;
  }
  return true;
}

function sendControl(socket: WebSocket, message: ServerControlMessage): boolean {
  if (!canSendToSocket(socket)) {
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    try { socket.close(1011, 'Terminal control send failed'); } catch { /* ignore */ }
    return false;
  }
}

function readBufferedRange(session: TerminalSession, startOffset: number, endOffset: number): Buffer {
  const relativeStart = Math.max(0, startOffset - session.bufferBase);
  const relativeEnd = Math.max(relativeStart, Math.min(session.bufferLength, endOffset - session.bufferBase));
  const totalLength = relativeEnd - relativeStart;

  if (totalLength <= 0 || session.bufferChunks.length === 0) {
    return Buffer.alloc(0);
  }

  if (session.bufferChunks.length === 1) {
    return session.bufferChunks[0].subarray(relativeStart, relativeEnd);
  }

  const slices: Buffer[] = [];
  let traversed = 0;

  for (const chunk of session.bufferChunks) {
    const chunkStart = traversed;
    const chunkEnd = traversed + chunk.length;
    traversed = chunkEnd;

    if (chunkEnd <= relativeStart) {
      continue;
    }
    if (chunkStart >= relativeEnd) {
      break;
    }

    const startInChunk = Math.max(0, relativeStart - chunkStart);
    const endInChunk = Math.min(chunk.length, relativeEnd - chunkStart);
    slices.push(chunk.subarray(startInChunk, endInChunk));
  }

  return slices.length === 1 ? slices[0] : Buffer.concat(slices, totalLength);
}

export function setupWebSocketServer(
  server: HttpServer | HttpsServer,
  terminals: Map<string, TerminalSession>
): WebSocketServer {
  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_SIZE });
  const heartbeatState = new WeakMap<WebSocket, boolean>();
  const heartbeatInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (heartbeatState.get(socket) === false) {
        try { socket.terminate(); } catch { /* ignore */ }
        continue;
      }

      heartbeatState.set(socket, false);
      try {
        socket.ping();
      } catch {
        try { socket.terminate(); } catch { /* ignore */ }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref?.();

  const WS_ALLOWED_ORIGINS = new Set([
    `http://localhost:${PORT}`,
  ]);
  // Add dev origins only in development mode
  if (NODE_ENV !== 'production') {
    WS_ALLOWED_ORIGINS.add('http://localhost:5173');
    WS_ALLOWED_ORIGINS.add('http://localhost:3000');
  }
  // Allow configured CORS origin for WebSocket too
  if (CORS_ORIGIN && CORS_ORIGIN !== '*') {
    WS_ALLOWED_ORIGINS.add(CORS_ORIGIN);
  }

  wss.on('connection', (socket: WebSocket, req) => {
    const socketId = crypto.randomUUID();
    const clientIP = getClientIP(req);
    heartbeatState.set(socket, true);

    // Validate Origin header to prevent Cross-Site WebSocket Hijacking
    // Skip check if CORS_ORIGIN is '*' or unset in development mode
    const skipOriginCheck = CORS_ORIGIN === '*' || (!CORS_ORIGIN && NODE_ENV !== 'production');
    const origin = req.headers['origin'];
    if (origin && !skipOriginCheck && !WS_ALLOWED_ORIGINS.has(origin)) {
      logSecurityEvent('WS_INVALID_ORIGIN', { ip: clientIP, origin });
      socket.close(1008, 'Invalid origin');
      return;
    }

    // Add error handler for socket
    socket.on('error', (error) => {
      console.error(`WebSocket error for socket ${socketId}:`, error.message);
      try {
        socket.close(1011, 'Internal error');
      } catch {
        // Socket might already be closed
      }
    });
    socket.on('pong', () => {
      heartbeatState.set(socket, true);
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
      untrackConnection(clientIP, socket);
      socket.close(1002, 'Invalid path');
      return;
    }

    const id = match[1];
    const session = terminals.get(id);
    if (!session) {
      untrackConnection(clientIP, socket);
      socket.close(1000, 'Terminal not found');
      return;
    }

    const hadNoSockets = session.sockets.size === 0;
    session.sockets.add(socket);
    if (hadNoSockets && !session.resizeOwner) {
      session.resizeOwner = socket;
    }
    session.lastActive = Date.now();

    // Send buffer content if available
    // bufferOffset: absolute byte count the client already processed
    // bufferBase: absolute byte position of buffer[0] (bytes dropped from start)
    const offsetParam = url.searchParams.get('bufferOffset');
    const clientOffset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0;
    const bufferStart = session.bufferBase;
    const bufferEnd = session.bufferBase + session.bufferLength;
    let replayStartOffset = clientOffset;
    let resetTerminal = false;

    if (clientOffset <= bufferStart) {
      replayStartOffset = bufferStart;
      resetTerminal = session.bufferLength > 0;
    } else if (clientOffset >= bufferEnd) {
      replayStartOffset = bufferEnd;
    }

    if (!sendControl(socket, { type: 'sync', offsetBase: replayStartOffset, reset: resetTerminal })) {
      return;
    }

    if (session.bufferLength > 0) {
      try {
        let bufferToSend: Buffer = Buffer.alloc(0);

        if (clientOffset <= bufferStart) {
          // Client's last position is before (or at) what we have — send everything
          bufferToSend = readBufferedRange(session, bufferStart, bufferEnd);
        } else if (clientOffset >= bufferEnd) {
          // Client is fully up to date
          bufferToSend = Buffer.alloc(0);
        } else {
          // Send only the delta
          bufferToSend = readBufferedRange(session, clientOffset, bufferEnd);
        }

        if (bufferToSend.length > 0 && canSendToSocket(socket)) {
          socket.send(bufferToSend, { binary: true });
        }
      } catch (error) {
        console.error(`Failed to send buffer to socket ${socketId}:`, error);
      }
    }
    sendControl(socket, { type: 'ready' });

    socket.on('message', (data) => {
      try {
        const messageSize = rawDataByteLength(data);
        if (messageSize > MAX_MESSAGE_SIZE) {
          logSecurityEvent('WS_MESSAGE_TOO_LARGE', { ip: clientIP, size: messageSize });
          socket.close(1009, 'Message too large');
          return;
        }

        session.lastActive = Date.now();

        if (typeof data === 'string') {
          let control: ClientControlMessage | null = null;
          try {
            control = JSON.parse(data) as ClientControlMessage;
          } catch {
            control = null;
          }

          if (control?.type === 'claim') {
            session.resizeOwner = socket;
            return;
          }

          if (control?.type === 'resize') {
            if (session.resizeOwner && session.resizeOwner !== socket) {
              return;
            }

            session.resizeOwner = socket;
            const cols = validateTerminalSize(control.cols);
            const rows = validateTerminalSize(control.rows);

            try {
              session.resize(cols, rows);
            } catch (resizeError) {
              console.error(`Failed to resize terminal ${id}:`, resizeError);
            }
            return;
          }

          try {
            session.write(Buffer.from(data, 'utf8'));
          } catch (writeError) {
            console.error(`Failed to write text input to terminal ${id}:`, writeError);
          }
          return;
        }

        try {
          session.write(rawDataToBuffer(data));
        } catch (writeError) {
          console.error(`Failed to write to terminal ${id}:`, writeError);
        }
      } catch (error) {
        console.error(`Error handling WebSocket message for socket ${socketId}:`, error);
      }
    });

    socket.on('close', () => {
      session.sockets.delete(socket);
      if (session.resizeOwner === socket) {
        session.resizeOwner = null;
      }
      session.lastActive = Date.now();
      heartbeatState.delete(socket);
      untrackConnection(clientIP, socket);
    });
  });

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });
  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return wss;
}

