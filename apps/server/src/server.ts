import fsSync from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import type { Server } from 'node:http';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { DatabaseSync } from 'node:sqlite';
import type { Workspace, Deck, TerminalSession } from './types.js';
import {
  PORT,
  HOST,
  NODE_ENV,
  BASIC_AUTH_USER,
  BASIC_AUTH_PASSWORD,
  CORS_ORIGIN,
  MAX_FILE_SIZE,
  MAX_REQUEST_BODY_SIZE,
  TRUST_PROXY,
  TERMINAL_BUFFER_LIMIT,
  hasStatic,
  distDir,
  dbPath,
  daemonInfoPath,
} from './config.js';
import { securityHeaders } from './middleware/security.js';
import { corsMiddleware } from './middleware/cors.js';
import { basicAuthMiddleware, generateWsToken, isBasicAuthEnabled } from './middleware/auth.js';
import {
  checkDatabaseIntegrity,
  handleDatabaseCorruption,
  initializeDatabase,
  loadPersistedState,
  loadPersistedTerminals,
  saveAllTerminalBuffers,
} from './utils/database.js';
import { createWorkspaceRouter, getConfigHandler } from './routes/workspaces.js';
import { createDeckRouter } from './routes/decks.js';
import { createFileRouter } from './routes/files.js';
import { createTerminalRouter } from './routes/terminals.js';
import { createGitRouter } from './routes/git.js';
import { createSettingsRouter } from './routes/settings.js';
import {
  setupWebSocketServer,
  getConnectionLimit,
  setConnectionLimit,
  getConnectionStats,
  clearAllConnections,
} from './websocket.js';
import { PtyClient } from './pty-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Request ID and logging middleware
const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID().slice(0, 8);
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);

  const start = Date.now();
  const method = c.req.method;
  const path_ = c.req.path;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  if (NODE_ENV === 'production' || process.env.DEBUG) {
    console.log(`[${requestId}] ${method} ${path_} ${status} ${duration}ms`);
  }
};

/** Wait for the daemon to write its info file after startup. */
async function waitForDaemonInfo(maxWaitMs = 8000): Promise<{ pid: number; port: number }> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (fsSync.existsSync(daemonInfoPath)) {
      try {
        return JSON.parse(fsSync.readFileSync(daemonInfoPath, 'utf-8'));
      } catch {
        // File may be partially written, retry
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('PTY daemon did not start within 8 seconds');
}

/** Connect to an existing daemon or spawn a new one. Returns a connected PtyClient. */
async function ensureDaemon(): Promise<PtyClient> {
  const client = new PtyClient();

  // Try connecting to an existing daemon
  if (fsSync.existsSync(daemonInfoPath)) {
    try {
      const info = JSON.parse(fsSync.readFileSync(daemonInfoPath, 'utf-8'));
      await client.connect(info.port);
      console.log(`[SERVER] Connected to existing PTY daemon on port ${info.port} (pid ${info.pid})`);
      return client;
    } catch {
      console.log('[SERVER] Existing PTY daemon is gone, starting a new one...');
      try { fsSync.unlinkSync(daemonInfoPath); } catch { /* ignore */ }
    }
  }

  // Spawn a new daemon process (detached so it survives server restarts)
  const daemonScript = path.join(__dirname, 'pty-daemon.js');
  const child = childProcess.spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DAEMON_INFO_PATH: daemonInfoPath,
      TERMINAL_BUFFER_LIMIT: String(TERMINAL_BUFFER_LIMIT),
    },
  });
  child.unref(); // Don't keep this process alive

  const info = await waitForDaemonInfo();
  await client.connect(info.port);
  console.log(`[SERVER] Started PTY daemon on port ${info.port} (pid ${info.pid})`);
  return client;
}

export async function createServer() {
  // Check database integrity before opening
  if (fsSync.existsSync(dbPath) && !checkDatabaseIntegrity(dbPath)) {
    handleDatabaseCorruption(dbPath);
  }

  const db = new DatabaseSync(dbPath);
  initializeDatabase(db);

  // Initialize state
  const workspaces = new Map<string, Workspace>();
  const workspacePathIndex = new Map<string, string>();
  const decks = new Map<string, Deck>();
  const terminals = new Map<string, TerminalSession>();

  loadPersistedState(db, workspaces, workspacePathIndex, decks);

  // Start or reconnect to the PTY daemon
  const ptyClient = await ensureDaemon();

  // Create Hono app
  const app = new Hono();

  app.use('*', securityHeaders);
  app.use('*', corsMiddleware);
  app.use('*', requestIdMiddleware);

  app.use('/api/*', bodyLimit({
    maxSize: MAX_REQUEST_BODY_SIZE,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }));

  if (basicAuthMiddleware) {
    app.use('/api/*', basicAuthMiddleware);
  }

  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() })
  );

  // Mount routers
  app.route('/api/settings', createSettingsRouter());
  app.route('/api/workspaces', createWorkspaceRouter(db, workspaces, workspacePathIndex));
  app.route('/api/decks', createDeckRouter(db, workspaces, decks));

  const { router: terminalRouter, restoreTerminals } = createTerminalRouter(db, decks, terminals, ptyClient);
  app.route('/api/terminals', terminalRouter);
  app.route('/api/git', createGitRouter(workspaces));

  // Restore terminals: daemon is the source of truth for existence, DB provides metadata
  const daemonTerminals = await ptyClient.list();
  const persistedTerminals = loadPersistedTerminals(db, decks);
  if (daemonTerminals.length > 0 || persistedTerminals.length > 0) {
    console.log(
      `[TERMINAL] Restoring ${daemonTerminals.length} live terminal(s) ` +
      `(${persistedTerminals.length} DB entries)...`
    );
    await restoreTerminals(persistedTerminals, daemonTerminals);
  }

  app.get('/api/config', getConfigHandler());

  app.get('/api/ws-token', (c) =>
    c.json({ token: generateWsToken(), authEnabled: isBasicAuthEnabled() })
  );

  app.get('/api/ws/stats', (c) =>
    c.json({ limit: getConnectionLimit(), connections: getConnectionStats() })
  );

  app.put('/api/ws/limit', async (c) => {
    const body = await c.req.json<{ limit: number }>();
    if (typeof body.limit !== 'number' || body.limit < 1) {
      return c.json({ error: 'Invalid limit value' }, 400);
    }
    setConnectionLimit(body.limit);
    return c.json({ limit: getConnectionLimit() });
  });

  app.post('/api/ws/clear', (c) => {
    const closedCount = clearAllConnections();
    return c.json({ cleared: closedCount });
  });

  const fileRouter = createFileRouter(workspaces);
  app.route('/api', fileRouter);

  if (hasStatic) {
    const serveAssets = serveStatic({ root: distDir });
    const serveIndex = serveStatic({ root: distDir, path: 'index.html' });
    app.use('/assets/*', serveAssets);
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api')) return c.text('Not found', 404);
      return serveIndex(c, next);
    });
  }

  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }) as Server;
  setupWebSocketServer(server, terminals);

  server.on('listening', () => {
    const baseUrl = `http://localhost:${PORT}`;
    console.log(`Deck IDE server listening on ${baseUrl}`);
    console.log(`UI: ${baseUrl}`);
    console.log(`API: ${baseUrl}/api`);
    console.log(`Health: ${baseUrl}/health`);
    console.log('');
    console.log('Security Status:');
    console.log(`  - Basic Auth: ${BASIC_AUTH_USER && BASIC_AUTH_PASSWORD ? 'enabled (user: ' + BASIC_AUTH_USER + ')' : 'DISABLED'}`);
    console.log(`  - Max File Size: ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`);
    console.log(`  - Max Request Body: ${Math.round(MAX_REQUEST_BODY_SIZE / 1024)}KB`);
    console.log(`  - Trust Proxy: ${TRUST_PROXY ? 'enabled' : 'disabled'}`);
    console.log(`  - CORS Origin: ${CORS_ORIGIN || (NODE_ENV === 'development' ? '*' : 'NOT SET')}`);
    console.log(`  - Environment: ${NODE_ENV}`);
  });

  // Periodic buffer persistence (mirrors daemon buffer to DB every 30s)
  const bufferPersistInterval = setInterval(() => {
    if (terminals.size > 0) {
      try {
        saveAllTerminalBuffers(db, terminals);
      } catch (err) {
        console.error('[TERMINAL] Failed to periodically save terminal buffers:', err);
      }
    }
  }, 30_000);
  bufferPersistInterval.unref();

  // Graceful shutdown - save buffers to DB and optionally terminate daemon.
  let shutdownPromise: Promise<void> | null = null;
  let shouldTerminateDaemon = false;
  const onShutdown = (options: { terminateDaemon?: boolean } = {}) => {
    if (options.terminateDaemon) {
      shouldTerminateDaemon = true;
    }
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      clearInterval(bufferPersistInterval);
      if (terminals.size > 0) {
        console.log(`[SHUTDOWN] Saving ${terminals.size} terminal buffer(s)...`);
        try { saveAllTerminalBuffers(db, terminals); } catch { /* ignore */ }
      }

      if (shouldTerminateDaemon) {
        try {
          const stopped = await ptyClient.shutdown();
          if (!stopped) {
            console.warn('[SHUTDOWN] PTY daemon shutdown was not acknowledged');
          }
        } catch (err) {
          console.warn('[SHUTDOWN] Failed to request PTY daemon shutdown:', err);
        }
      }

      ptyClient.destroy();
      try { db.close(); } catch { /* ignore */ }
    })();

    return shutdownPromise;
  };

  process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Received SIGINT, saving state...');
    void onShutdown({ terminateDaemon: true }).finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] Received SIGTERM, saving state...');
    void onShutdown({ terminateDaemon: true }).finally(() => process.exit(0));
  });

  process.on('SIGHUP', () => {
    console.log('[SHUTDOWN] Received SIGHUP, saving state...');
    void onShutdown({ terminateDaemon: true }).finally(() => process.exit(0));
  });

  // HTTP shutdown endpoint — allows cross-platform graceful shutdown from Electron
  app.post('/api/shutdown', async (c) => {
    let terminateDaemon = false;
    try {
      const body = await c.req.json<{ terminateDaemon?: boolean }>();
      terminateDaemon = body?.terminateDaemon === true;
    } catch {
      // Body is optional; default is false.
    }

    setTimeout(() => {
      console.log(
        `[SHUTDOWN] Shutdown requested via HTTP API${terminateDaemon ? ' (terminate daemon)' : ''}`
      );
      void onShutdown({ terminateDaemon }).finally(() => process.exit(0));
    }, 50);
    return c.json({ ok: true, terminateDaemon });
  });

  const originalExceptionHandler = process.listeners('uncaughtException')[0] as ((err: Error) => void) | undefined;
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (error: Error) => {
    if (error.message?.includes('AttachConsole failed')) {
      console.log('[node-pty] AttachConsole error suppressed');
      return;
    }
    console.error('[SHUTDOWN] Uncaught exception, saving state before exit...');
    void onShutdown({ terminateDaemon: true }).finally(() => {
      if (originalExceptionHandler) {
        originalExceptionHandler(error);
      } else {
        console.error('Uncaught exception:', error);
        process.exit(1);
      }
    });
  });

  return server;
}
