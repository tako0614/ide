import crypto from 'node:crypto';
import net from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { TerminalClient, TerminalSession } from './types.js';
import { PORT, TRUST_PROXY } from './config.js';
import { logSecurityEvent } from './middleware/security.js';
import { checkRequestOrigin, resolveHostHeader } from './middleware/origin.js';
import { isAuthEnabled, onSessionRevoked, validWebSocketOrigin, verifyWebSocketAuth } from './middleware/auth.js';
import { isCliRequest } from './auth/cli-token.js';
import { alignToUtf8Start, alignToUtf8End } from './utils/utf8.js';
import {
  assignResizeOwner,
  canSendToSocket,
  clampTerminalSize,
  releaseTerminalClient,
  resizeTerminal,
  sendTerminalControl as sendControl,
  type ClientControlMessage,
} from './utils/terminal-control.js';
import type { AgentBrowserService } from './utils/agent-browser.js';
import type { SharedDesktop } from './desktop/shared-desktop.js';

const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB max message size
const HEARTBEAT_INTERVAL_MS = 30_000;
// A snapshot is retaken when output trimmed the replay buffer or the PTY was
// resized while it was being rendered; give up on consistency after this many.
const MAX_SNAPSHOT_ATTEMPTS = 3;

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

function parseRequestedSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  const c = typeof cols === 'string' ? Number(cols) : cols;
  const r = typeof rows === 'string' ? Number(rows) : rows;
  if (typeof c !== 'number' || typeof r !== 'number' || !Number.isFinite(c) || !Number.isFinite(r) || c < 1 || r < 1) {
    return null;
  }
  return { cols: clampTerminalSize(c, 1), rows: clampTerminalSize(r, 1) };
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

// Pause reading from VNC when the browser is this far behind.
const VNC_HIGH_WATER = 8 * 1024 * 1024;

/**
 * Bridge a browser VNC viewer (noVNC) to the shared desktop's x11vnc, which
 * listens on loopback only. Frames are already compressed by VNC, so they
 * skip per-message deflate.
 */
function attachVncBridge(socket: WebSocket, desktop: SharedDesktop): void {
  const pending: Buffer[] = [];
  let upstream: net.Socket | null = null;
  let closed = false;
  socket.on('message', (data) => {
    const chunk = rawDataToBuffer(data);
    if (upstream) upstream.write(chunk);
    else pending.push(chunk);
  });
  socket.on('close', () => {
    closed = true;
    upstream?.destroy();
  });
  desktop.vnc().then(({ port }) => {
    if (closed) return;
    const tcp = net.connect(port, '127.0.0.1');
    upstream = tcp;
    tcp.setNoDelay(true);
    tcp.on('connect', () => {
      for (const chunk of pending.splice(0)) tcp.write(chunk);
    });
    let resumeTimer: NodeJS.Timeout | null = null;
    tcp.on('data', (chunk) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(chunk, { binary: true, compress: false });
      if (socket.bufferedAmount > VNC_HIGH_WATER && !resumeTimer) {
        tcp.pause();
        resumeTimer = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount < VNC_HIGH_WATER / 4) {
            clearInterval(resumeTimer!);
            resumeTimer = null;
            tcp.resume();
          }
        }, 50);
      }
    });
    tcp.on('close', () => {
      if (resumeTimer) clearInterval(resumeTimer);
      try { socket.close(1000, 'Desktop VNC closed'); } catch { /* ignore */ }
    });
    tcp.on('error', () => { /* close follows */ });
  }).catch(() => {
    try { socket.close(1011, 'Desktop unavailable'); } catch { /* ignore */ }
  });
}

export function setupWebSocketServer(
  server: HttpServer | HttpsServer,
  terminals: Map<string, TerminalSession>,
  browserService?: AgentBrowserService,
  desktop?: SharedDesktop | null
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

  wss.on('connection', (socket: WebSocket, req) => {
    // wss.clients includes sockets in their close handshake, including after
    // an administrative clear. Cap the actual live set as well as tracked IPs.
    if (wss.clients.size > MAX_GLOBAL_CONNECTIONS) {
      socket.terminate();
      return;
    }
    const socketId = crypto.randomUUID();
    const clientIP = getClientIP(req);
    heartbeatState.set(socket, true);

    // Validate Origin to prevent Cross-Site WebSocket Hijacking. Never skipped:
    // these sockets carry PTY input/output and agent-browser control.
    const originRefusal = wsOriginRefusal(req);
    if (originRefusal || (isAuthEnabled() && !validWebSocketOrigin(req) && !isCliRequest(req))) {
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

    if (url.pathname === '/api/desktop/vnc') {
      if (!desktop) {
        untrackConnection(clientIP, socket);
        socket.close(1011, 'Desktop disabled');
        return;
      }
      socket.on('close', () => {
        heartbeatState.delete(socket);
        untrackConnection(clientIP, socket);
      });
      attachVncBridge(socket, desktop);
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

    const params = url.searchParams;
    // proto=2 clients understand snapshots and server-driven sizes.
    const proto = Number(params.get('proto') || '1');
    const kindParam = params.get('client');
    const wantsClaim = params.get('claim') === '1';
    const clientIdParam = params.get('cid');
    const client: TerminalClient = {
      id: clientIdParam && /^[A-Za-z0-9_-]{8,64}$/.test(clientIdParam) ? clientIdParam : null,
      desired: parseRequestedSize(params.get('cols'), params.get('rows')),
      activeAt: wantsClaim ? Date.now() : 0,
      kind: kindParam === 'cli' ? 'cli' : kindParam === 'web' ? 'web' : 'other',
    };
    // A client that reconnects before its old socket was detected as dead
    // (phone woke from sleep, network switch) takes over that socket's role
    // instead of being left as a viewer behind a ghost primary.
    const stale = client.id
      ? Array.from(session.clients.entries()).filter(([, other]) => other.id === client.id)
      : [];
    const inheritsControl = stale.some(([other]) => other === session.resizeOwner);
    if (stale.length > 0) {
      client.activeAt = Math.max(client.activeAt, ...stale.map(([, other]) => other.activeAt));
    }
    session.clients.set(socket, client);
    session.lastActive = Date.now();
    if (inheritsControl) {
      assignResizeOwner(session, socket, false);
    }
    for (const [other] of stale) {
      releaseTerminalClient(session, other);
      try { other.terminate(); } catch { /* already gone */ }
    }

    // The PTY follows the most recently active client. A client that claims
    // on connect (it is being used, or was primary before a reconnect), or the
    // first client to attach, takes control now — before its replay — so the
    // replay is already rendered at its size.
    if (wantsClaim || !session.resizeOwner) {
      assignResizeOwner(session, socket, wantsClaim);
    }

    const stillAttached = () =>
      socket.readyState === WebSocket.OPEN && session.clients.has(socket) && terminals.get(id) === session;

    // Start live output after the replay; nothing is broadcast to the socket
    // until then, so replay and live bytes can never interleave.
    const finishAttach = () => {
      if (!stillAttached()) return;
      session.sockets.add(socket);
      // The primary may have left while this socket was still replaying
      // (promotion skips pending sockets); never leave the terminal without one.
      if (!session.resizeOwner) {
        assignResizeOwner(session, socket, false);
      }
      sendControl(socket, { type: 'ready' });
      // この接続が現在の主クライアントかを通知する。
      sendControl(socket, { type: 'primary', value: session.resizeOwner === socket });
    };

    const sendRawReplay = (clientOffset: number) => {
      // bufferOffset: absolute byte count the client already processed
      // bufferBase: absolute byte position of buffer[0] (bytes dropped from start)
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
      if (!sendControl(socket, {
        type: 'sync', offsetBase: replayStartOffset, reset: resetTerminal, cols: session.cols, rows: session.rows,
      })) {
        return;
      }
      if (replayStartOffset < bufferEnd) {
        try {
          const bufferToSend = readBufferedRange(session, replayStartOffset, bufferEnd);
          if (bufferToSend.length > 0 && canSendToSocket(socket)) {
            socket.send(bufferToSend, { binary: true });
          }
        } catch (error) {
          console.error(`Failed to send buffer to socket ${socketId}:`, error);
        }
      }
      finishAttach();
    };

    // Hand the client the current screen rendered by the server-side mirror,
    // then the bytes that arrived while it was being serialized.
    const sendSnapshot = (attempt = 1): void => {
      const mirror = session.mirror;
      if (!mirror) {
        sendRawReplay(0);
        return;
      }
      const epoch = session.resizeEpoch;
      mirror.snapshot().then((snap) => {
        if (!stillAttached()) return;
        // A resize after the snapshot was requested (even one undone by a
        // second resize) means the tail bytes were drawn at another size.
        const inconsistent = snap.offset < session.bufferBase || session.resizeEpoch !== epoch ||
          snap.cols !== session.cols || snap.rows !== session.rows;
        if (inconsistent && attempt < MAX_SNAPSHOT_ATTEMPTS) {
          sendSnapshot(attempt + 1);
          return;
        }
        if (!sendControl(socket, {
          type: 'sync', offsetBase: snap.offset, reset: true, cols: snap.cols, rows: snap.rows, snapshot: true,
        })) {
          return;
        }
        try {
          socket.send(Buffer.from(snap.data, 'utf8'), { binary: true });
          // Still racing resizes after the retries: output since the
          // snapshot is mostly post-resize, so switch size before it.
          if (snap.cols !== session.cols || snap.rows !== session.rows) {
            sendControl(socket, { type: 'size', cols: session.cols, rows: session.rows });
          }
          const tailStart = Math.max(snap.offset, session.bufferBase);
          const tail = readBufferedRange(session, tailStart, session.bufferBase + session.bufferLength);
          if (tail.length > 0 && canSendToSocket(socket)) {
            socket.send(tail, { binary: true });
          }
        } catch (error) {
          console.error(`Failed to send snapshot to socket ${socketId}:`, error);
        }
        finishAttach();
      }).catch(() => {
        if (stillAttached()) sendRawReplay(0);
      });
    };

    const offsetParam = params.get('bufferOffset');
    const clientOffset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0;
    const bufferEnd = session.bufferBase + session.bufferLength;
    // A reconnecting client whose screen is intact only needs the bytes it
    // missed — unless the PTY was resized in that gap, in which case those
    // bytes were drawn for a size it never rendered at.
    const canSendDelta = clientOffset > 0 &&
      clientOffset >= session.bufferBase &&
      clientOffset <= bufferEnd &&
      clientOffset >= session.lastResizeOffset;

    if (proto < 2 || canSendDelta) {
      sendRawReplay(clientOffset);
    } else {
      sendSnapshot();
    }

    socket.on('message', (data, isBinary) => {
      try {
        const messageSize = rawDataByteLength(data);
        if (messageSize > MAX_MESSAGE_SIZE) {
          logSecurityEvent('WS_MESSAGE_TOO_LARGE', { ip: clientIP, size: messageSize });
          socket.close(1009, 'Message too large');
          return;
        }

        session.lastActive = Date.now();

        // Text frames carry JSON control messages (claim, resize, resync).
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
            const requested = parseRequestedSize(control.cols, control.rows);
            if (requested) client.desired = requested;
            assignResizeOwner(session, socket);
            return;
          }

          if (control?.type === 'resize') {
            const requested = parseRequestedSize(control.cols, control.rows);
            if (!requested) return;
            // Every client reports what it could show; only the primary's
            // report moves the PTY. The rest render at the PTY size.
            client.desired = requested;
            if (!session.resizeOwner) {
              assignResizeOwner(session, socket, false);
            } else if (session.resizeOwner === socket) {
              resizeTerminal(session, requested.cols, requested.rows);
            }
            return;
          }

          if (control?.type === 'resync') {
            if (session.sockets.delete(socket)) {
              sendSnapshot();
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
        client.activeAt = Date.now();
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
      // 主クライアントが去ったら、最後に操作していた接続を主に昇格させ、
      // その表示サイズへ PTY を合わせる。
      releaseTerminalClient(session, socket);
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

