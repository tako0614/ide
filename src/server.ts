import fsSync from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  hasStatic,
  distDir,
  dbPath,
} from './config.js';
import { securityHeaders } from './middleware/security.js';
import { corsMiddleware } from './middleware/cors.js';
import { basicAuthMiddleware, generateWsToken, isBasicAuthEnabled } from './middleware/auth.js';
import {
  checkDatabaseIntegrity,
  handleDatabaseCorruption,
  initializeDatabase,
  loadPersistedState,
  clearOrphanedTerminals,
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

export async function createServer() {
  // Check database integrity before opening
  if (fsSync.existsSync(dbPath) && !checkDatabaseIntegrity(dbPath)) {
    handleDatabaseCorruption(dbPath);
  }

  const db = new DatabaseSync(dbPath);
  initializeDatabase(db);
  clearOrphanedTerminals(db);

  // Initialize state
  const workspaces = new Map<string, Workspace>();
  const workspacePathIndex = new Map<string, string>();
  const decks = new Map<string, Deck>();
  const terminals = new Map<string, TerminalSession>();

  loadPersistedState(db, workspaces, workspacePathIndex, decks);

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
  app.route('/api/decks', createDeckRouter(db, workspaces, decks, terminals));

  const terminalRouter = createTerminalRouter(db, decks, terminals);
  app.route('/api/terminals', terminalRouter);
  app.route('/api/git', createGitRouter(workspaces));

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
    console.log(`  - Basic Auth: ${BASIC_AUTH_USER && BASIC_AUTH_PASSWORD ? 'enabled' : 'DISABLED'}`);
    console.log(`  - Max File Size: ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`);
    console.log(`  - Max Request Body: ${Math.round(MAX_REQUEST_BODY_SIZE / 1024)}KB`);
    console.log(`  - Trust Proxy: ${TRUST_PROXY ? 'enabled' : 'disabled'}`);
    console.log(`  - CORS Origin: ${CORS_ORIGIN || (NODE_ENV === 'development' ? '*' : 'NOT SET')}`);
    console.log(`  - Environment: ${NODE_ENV}`);
  });

  // Graceful shutdown
  let shutdownPromise: Promise<void> | null = null;
  const onShutdown = () => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      // Kill all terminals
      terminals.forEach((session) => {
        session.sockets.forEach((socket) => {
          try { socket.close(1000, 'Server shutting down'); } catch { /* ignore */ }
        });
        session.kill();
      });
      terminals.clear();

      try { db.close(); } catch { /* ignore */ }
    })();

    return shutdownPromise;
  };

  process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Received SIGINT...');
    void onShutdown().finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] Received SIGTERM...');
    void onShutdown().finally(() => process.exit(0));
  });

  process.on('SIGHUP', () => {
    console.log('[SHUTDOWN] Received SIGHUP...');
    void onShutdown().finally(() => process.exit(0));
  });

  // HTTP shutdown endpoint
  app.post('/api/shutdown', async (c) => {
    setTimeout(() => {
      console.log('[SHUTDOWN] Shutdown requested via HTTP API');
      void onShutdown().finally(() => process.exit(0));
    }, 50);
    return c.json({ ok: true });
  });

  const originalExceptionHandler = process.listeners('uncaughtException')[0] as ((err: Error) => void) | undefined;
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (error: Error) => {
    if (error.message?.includes('AttachConsole failed')) {
      console.log('[node-pty] AttachConsole error suppressed');
      return;
    }
    console.error('[SHUTDOWN] Uncaught exception...');
    void onShutdown().finally(() => {
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
