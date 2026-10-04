import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { TerminalSession } from './types.js';
import { PORT, TRUST_PROXY } from './config.js';
import { logSecurityEvent } from './middleware/security.js';
import { checkRequestOrigin, resolveHostHeader } from './middleware/origin.js';
import { isAuthEnabled, onSessionRevoked, validWebSocketOrigin, verifyWebSocketAuth } from './middleware/auth.js';
import { alignToUtf8Start, alignToUtf8End } from './utils/utf8.js';
import type { AgentBrowserService } from './utils/agent-browser.js';
import type { DesktopComputer } from './computer/desktop.js';
import type { ComputerStreamTickets } from './computer/stream-tickets.js';
import { RfbServerProtocolError } from './computer/rfb.js';

const MIN_TERMINAL_SIZE = 1;
const MAX_TERMINAL_SIZE = 500;
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB max message size
const MAX_SOCKET_BUFFERED_AMOUNT = 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

type ClientControlMessage =
  | { type: 'claim' }
  | { type: 'resize'; cols: number; rows: number; explicit: true };

type ServerControlMessage =
  | { type: 'sync'; offsetBase: number; reset: boolean; cols: number; rows: number; epoch: string; snapshotBytes: number }
  | { type: 'ready' }
  // この接続が「主」クライアントか。端末クエリ（DSR/DA など）への応答は
  // 主クライアントのみが返し、複数クライアント時の二重応答を防ぐ。
  | { type: 'primary'; value: boolean };

// Configurable connection limit per IP (default: 1000)
let maxConnectionsPerIP = 1000;

// Track connections per IP
const connectionsByIP = new Map<string, Set<WebSocket>>();
const MAX_GLOBAL_CONNECTIONS = 256;
let totalConnections = 0;

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
  totalConnections = 0;
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
  if (totalConnections >= MAX_GLOBAL_CONNECTIONS) return false;
  let connections = connectionsByIP.get(ip);
  if (!connections) {
    connections = new Set();
    connectionsByIP.set(ip, connections);
  }
  if (connections.size >= maxConnectionsPerIP) {
    if (connections.size === 0) connectionsByIP.delete(ip);
    return false;
  }
  connections.add(socket);
  totalConnections++;
  return true;
}

function untrackConnection(ip: string, socket: WebSocket): void {
  const connections = connectionsByIP.get(ip);
  if (connections) {
    if (connections.delete(socket)) totalConnections--;
    if (connections.size === 0) {
      connectionsByIP.delete(ip);
    }
  }
}

/**
 * Decide whether a WebSocket handshake may proceed.
 *
 * Browsers do not apply CORS to WebSocket upgrades, so this is the only thing
 * between a page the user happens to visit and a live PTY on this machine. It
 * is therefore never skipped — in particular `CORS_ORIGIN='*'` does not
 * disable it, since widening who may read a response says nothing about who
 * may open a socket.
 *
 * Delegates to the same Host+Origin decision the HTTP API uses, so the socket
 * path cannot end up more permissive than the routes it mirrors: `Origin`
 * rejects cross-site pages, and `Host` rejects DNS rebinding, which would
 * otherwise let an attacker's domain resolve to loopback and appear
 * same-origin.
 *
 * A handshake with no Origin is not a browser request; those are constrained
 * by the bind address (loopback unless the operator opts out) and by
 * verifyWebSocketAuth.
 */
function wsOriginRefusal(req: IncomingMessage): 'host' | 'origin' | null {
  const hostHeader = resolveHostHeader(
    req.headers.host,
    req.headers['x-forwarded-host'] as string | undefined
  );
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  return checkRequestOrigin(origin, hostHeader);
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

function readBufferedRange(session: TerminalSession, startOffset: number, endOffset: number, align = true): Buffer {
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

  if (!align) return raw;

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
  ensureAttached?: (id: string) => Promise<void>,
  computerStream?: { computer: DesktopComputer; tickets: ComputerStreamTickets }
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_MESSAGE_SIZE,
    perMessageDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      threshold: 1024,
    },
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

  wss.on('connection', async (socket: WebSocket, req) => {
    // wss.clients includes sockets in their close handshake, including after
    // an administrative clear. Cap the actual live set as well as tracked IPs.
    if (wss.clients.size > MAX_GLOBAL_CONNECTIONS) {
      socket.terminate();
      return;
    }
    const socketId = crypto.randomUUID();
    const clientIP = getClientIP(req);
    heartbeatState.set(socket, true);
    // Install cleanup before asynchronous restore/capture: a viewer may leave
    // while either barrier is still pending.
    socket.on('close', () => {
      heartbeatState.delete(socket);
      untrackConnection(clientIP, socket);
    });

    // Validate Origin to prevent Cross-Site WebSocket Hijacking. Never skipped:
    // these sockets carry PTY input/output and agent-browser control.
    const originRefusal = wsOriginRefusal(req);
    if (originRefusal || (isAuthEnabled() && !validWebSocketOrigin(req))) {
      logSecurityEvent(
        originRefusal === 'host' ? 'WS_INVALID_HOST' : 'WS_INVALID_ORIGIN',
        { ip: clientIP, origin: req.headers['origin'], host: req.headers.host }
      );
      socket.close(1008, originRefusal === 'host' ? 'Invalid host' : 'Invalid origin');
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

    const authSessionKey = verifyWebSocketAuth(req);
    if (!authSessionKey) {
      logSecurityEvent('WS_AUTH_FAILED', { ip: clientIP });
      untrackConnection(clientIP, socket);
      socket.close(1008, 'Unauthorized');
      return;
    }
    const unsubscribe = onSessionRevoked(authSessionKey, () => socket.terminate());
    socket.on('close', unsubscribe);

    const url = new URL(req.url || '', `http://localhost:${PORT}`);
    const streamPath = '/api/computer/vnc/ws';
    const token = url.searchParams.get('token') ?? '';
    if (url.pathname !== streamPath && computerStream?.tickets.reserved(token)) {
      socket.close(1008, 'Desktop stream ticket has a different route');
      return;
    }
    if (url.pathname === streamPath) {
      const epoch = Number(url.searchParams.get('epoch'));
      if (!isAuthEnabled() || !computerStream || !Number.isSafeInteger(epoch) ||
          !url.searchParams.has('epoch') || !computerStream.tickets.consume(token, authSessionKey, epoch)) {
        socket.close(1008, 'Invalid desktop stream ticket');
        return;
      }
      // RFB is a byte stream: preserve ordering and close a slow peer rather
      // than dropping a fragment. The backend gates every client message.
      void computerStream.computer.attachVncSocket(`browser:${authSessionKey}`, epoch).then(({ socket: upstream, gate, close }) => {
        if (socket.readyState !== WebSocket.OPEN) { close(); return; }
        const rejectRfb = (phase: string, reason: string) => {
          logSecurityEvent('WS_DESKTOP_RFB_CLOSED', { phase, reason, code: 1008 });
          close();
          if (socket.readyState === WebSocket.OPEN) socket.close(1008, 'Invalid desktop protocol');
        };
        socket.once('close', close);
        upstream.once('close', () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          try { gate.assertServerComplete(); }
          catch (error) {
            if (error instanceof RfbServerProtocolError) rejectRfb(error.phase, error.reason);
            else rejectRfb('server', 'unexpected');
            return;
          }
          socket.close(1000, 'Desktop stream ended');
        });
        upstream.once('error', () => { if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Desktop stream unavailable'); });
        upstream.on('data', (data: Buffer) => {
          if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_SOCKET_BUFFERED_AMOUNT) {
            close();
            if (socket.readyState === WebSocket.OPEN) socket.close(1009, 'Desktop viewer too slow');
            return;
          }
          try {
            for (const part of gate.observeServer(data))
              socket.send(part, { binary: true }, (error) => { if (error) close(); });
          } catch (error) {
            if (error instanceof RfbServerProtocolError) rejectRfb(error.phase, error.reason);
            else rejectRfb('server', 'unexpected');
          }
        });
        socket.on('message', (raw: RawData) => {
          try {
            if (upstream.writableLength > MAX_SOCKET_BUFFERED_AMOUNT) throw new Error('Desktop input overflow');
            for (const message of gate.acceptClient(rawDataToBuffer(raw))) upstream.write(message);
          } catch {
            rejectRfb('client', 'invalid_or_unauthorized');
          }
        });
        upstream.resume();
      }).catch(() => { if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Desktop stream unavailable'); });
      return;
    }
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
    if (ensureAttached && !terminals.get(id)?.available) {
      try { await ensureAttached(id); } catch {
        untrackConnection(clientIP, socket);
        socket.close(1013, 'Terminal transport unavailable');
        return;
      }
    }
    const session = terminals.get(id);
    if (!session) {
      untrackConnection(clientIP, socket);
      socket.close(1000, 'Terminal not found');
      return;
    }

    session.lastActive = Date.now();
    // A full canonical snapshot has its own byte length; offset remains a cursor
    // in the live display stream. Subscribe only after snapshot+queued tail are sent.
    let snapshot: Awaited<ReturnType<TerminalSession['snapshot']>>;
    try {
      snapshot = await session.snapshot();
      // Output may have advanced beyond the bounded raw tail during capture.
      // A fresh barrier replaces that missing prefix; never join across a gap.
      for (let attempt = 0; snapshot.offset < session.bufferBase; attempt++) {
        if (attempt === 2) throw new Error('Terminal output advanced beyond snapshot tail');
        snapshot = await session.snapshot();
      }
    }
    catch {
      untrackConnection(clientIP, socket);
      heartbeatState.delete(socket);
      socket.close(1013, 'Terminal snapshot unavailable');
      return;
    }
    if (socket.readyState !== WebSocket.OPEN || terminals.get(id) !== session || !session.available) {
      untrackConnection(clientIP, socket);
      heartbeatState.delete(socket);
      if (socket.readyState === WebSocket.OPEN) socket.close(1013, 'Terminal transport unavailable');
      return;
    }
    if (!sendControl(socket, {
      type: 'sync', offsetBase: snapshot.offset, reset: true,
      cols: snapshot.cols, rows: snapshot.rows, epoch: session.bufferEpoch,
      snapshotBytes: snapshot.data.length,
    })) return;
    if (snapshot.data.length) socket.send(snapshot.data, { binary: true });
    const bufferEnd = session.bufferBase + session.bufferLength;
    if (bufferEnd > snapshot.offset) {
      // These bytes may finish a fragment included in the snapshot parser tail.
      // Do not trim UTF-8 or ANSI at either edge of this exact live-stream range.
      socket.send(readBufferedRange(session, snapshot.offset, bufferEnd, false), { binary: true });
    }
    session.sockets.add(socket);
    sendControl(socket, { type: 'ready' });
    sendControl(socket, { type: 'primary', value: false }); // The headless display bridge owns query replies.

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
            sendControl(socket, { type: 'primary', value: false });
            return;
          }

          if (control?.type === 'resize') {
            // Legacy viewer fit events cannot change the canonical tmux window.
            if (control.explicit !== true) return;
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
