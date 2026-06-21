import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { TerminalSession } from './types.js';
import { PORT, TRUST_PROXY, CORS_ORIGIN, NODE_ENV } from './config.js';
import { logSecurityEvent } from './middleware/security.js';
import { verifyWebSocketAuth } from './middleware/auth.js';
import { alignToUtf8Start, alignToUtf8End } from './utils/utf8.js';
import type { AgentBrowserService } from './utils/agent-browser.js';
import type { CodeServerService } from './utils/code-server.js';

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
  | { type: 'ready' }
  // この接続が「主」クライアントか。端末クエリ（DSR/DA など）への応答は
  // 主クライアントのみが返し、複数クライアント時の二重応答を防ぐ。
  | { type: 'primary'; value: boolean };

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

function validateTerminalSize(value: number | undefined): number {
  if (value == null) return MIN_TERMINAL_SIZE;
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
  // data is Buffer
  return Buffer.isBuffer(data) ? data : Buffer.from(data as Buffer);
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

// 制御権（resizeOwner = 主クライアント）を付け替え、新旧クライアントへ
// primary 状態を通知する。主クライアントだけが端末クエリへ応答する。
function assignResizeOwner(session: TerminalSession, socket: WebSocket): void {
  const previous = session.resizeOwner;
  if (previous === socket) {
    return;
  }
  session.resizeOwner = socket;
  if (previous) {
    sendControl(previous, { type: 'primary', value: false });
  }
  sendControl(socket, { type: 'primary', value: true });
}

function readBufferedRange(session: TerminalSession, startOffset: number, endOffset: number): Buffer {
  const relativeStart = Math.max(0, startOffset - session.bufferBase);
  const relativeEnd = Math.max(relativeStart, Math.min(session.bufferLength, endOffset - session.bufferBase));

  if (relativeEnd <= relativeStart || session.bufferChunks.length === 0) {
    return Buffer.alloc(0);
  }

  // Materialize the raw range into a contiguous copy so the caller
  // is not affected if buffer chunks are later trimmed or reassigned.
  let raw: Buffer;

  if (session.bufferChunks.length === 1) {
    raw = Buffer.from(session.bufferChunks[0].subarray(relativeStart, relativeEnd));
  } else {
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

    raw = Buffer.concat(slices); // concat always creates a new Buffer
  }

  // Align start: skip orphaned continuation bytes
  const alignedStart = alignToUtf8Start(raw, 0);
  // Align end: don't cut a multi-byte character in half
  const alignedEnd = alignToUtf8End(raw, raw.length);

  if (alignedStart === 0 && alignedEnd === raw.length) {
    return raw;
  }
  return Buffer.from(raw.subarray(alignedStart, alignedEnd));
}

export function setupWebSocketServer(
  server: HttpServer | HttpsServer,
  terminals: Map<string, TerminalSession>,
  browserService?: AgentBrowserService,
  codeServerService?: CodeServerService
): WebSocketServer {
  // noServer mode: we own the HTTP 'upgrade' event so code-server's WebSocket can
  // be reverse-proxied alongside the app's own sockets. Everything that isn't a
  // /codeserver/ upgrade is handed to wss exactly as before.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_SIZE });

  server.on('upgrade', (req, socket: Duplex, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url || '', `http://localhost:${PORT}`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (codeServerService && pathname.startsWith('/codeserver/')) {
      if (!verifyWebSocketAuth(req)) {
        socket.destroy();
        return;
      }
      const rest = pathname.slice('/codeserver/'.length);
      const slash = rest.indexOf('/');
      const wsId = slash === -1 ? rest : rest.slice(0, slash);
      const prefix = `/codeserver/${wsId}`;
      const original = req.url || '';
      req.url = original.slice(prefix.length) || '/';
      if (!req.url.startsWith('/')) {
        req.url = `/${req.url}`;
      }
      codeServerService
        .ensure(wsId)
        .then(() => codeServerService.proxyUpgrade(wsId, req, socket, head))
        .catch(() => {
          try { socket.destroy(); } catch { /* ignore */ }
        });
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
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
    if (url.pathname === '/api/browser/ws') {
      if (!browserService) {
        untrackConnection(clientIP, socket);
        socket.close(1011, 'Browser service unavailable');
        return;
      }

      socket.on('close', () => {
        heartbeatState.delete(socket);
        untrackConnection(clientIP, socket);
      });
      browserService.attachWebSocket(socket);
      return;
    }

    if (url.pathname === '/api/browser/audio/ws') {
      if (!browserService) {
        untrackConnection(clientIP, socket);
        socket.close(1011, 'Browser service unavailable');
        return;
      }

      socket.on('close', () => {
        heartbeatState.delete(socket);
        untrackConnection(clientIP, socket);
      });
      browserService.attachAudioWebSocket(socket);
      return;
    }

    if (url.pathname === '/api/browser/webrtc/ws') {
      if (!browserService) {
        untrackConnection(clientIP, socket);
        socket.close(1011, 'Browser service unavailable');
        return;
      }

      socket.on('close', () => {
        heartbeatState.delete(socket);
        untrackConnection(clientIP, socket);
      });
      browserService.attachWebRtcWebSocket(socket);
      return;
    }

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
    // この接続が現在の主クライアントかを通知（既定では先頭接続が主）。
    sendControl(socket, { type: 'primary', value: session.resizeOwner === socket });

    socket.on('message', (data, isBinary) => {
      try {
        const messageSize = rawDataByteLength(data);
        if (messageSize > MAX_MESSAGE_SIZE) {
          logSecurityEvent('WS_MESSAGE_TOO_LARGE', { ip: clientIP, size: messageSize });
          socket.close(1009, 'Message too large');
          return;
        }

        session.lastActive = Date.now();

        // Text frames carry JSON control messages (claim, resize).
        // Note: the ws library delivers text frames as Buffer by default,
        // so we use the isBinary flag rather than typeof === 'string'.
        if (!isBinary) {
          const text = typeof data === 'string'
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data).toString('utf8')
              : Buffer.from(data as ArrayBuffer).toString('utf8');

          let control: ClientControlMessage | null = null;
          try {
            control = JSON.parse(text) as ClientControlMessage;
          } catch {
            control = null;
          }

          if (control?.type === 'claim') {
            assignResizeOwner(session, socket);
            return;
          }

          if (control?.type === 'resize') {
            if (session.resizeOwner && session.resizeOwner !== socket) {
              return;
            }

            assignResizeOwner(session, socket);
            const cols = validateTerminalSize(control.cols);
            const rows = validateTerminalSize(control.rows);

            try {
              session.resize(cols, rows);
            } catch (resizeError) {
              console.error(`Failed to resize terminal ${id}:`, resizeError);
            }
            return;
          }

          // Unknown text frame — still forward to terminal for compatibility
          try {
            session.write(Buffer.from(text, 'utf8'));
          } catch (writeError) {
            console.error(`Failed to write text input to terminal ${id}:`, writeError);
          }
          return;
        }

        // Binary frames carry terminal input (keystrokes, paste, etc.)
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
        // 主クライアントが去ったら、残っている接続のいずれかを主に昇格させ、
        // 端末クエリへ応答するクライアントが居なくならないようにする。
        const next = session.sockets.values().next().value;
        if (next) {
          assignResizeOwner(session, next);
        }
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

