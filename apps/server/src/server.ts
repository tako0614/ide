import fsSync from 'node:fs';
import crypto from 'node:crypto';
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
  dbPath
} from './config.js';
import { securityHeaders } from './middleware/security.js';
import { corsMiddleware } from './middleware/cors.js';
import { basicAuthMiddleware, generateWsToken, isBasicAuthEnabled } from './middleware/auth.js';
import { checkDatabaseIntegrity, handleDatabaseCorruption, initializeDatabase, loadPersistedState, loadPersistedTerminals, saveAllTerminalBuffers } from './utils/database.js';
import { createWorkspaceRouter, getConfigHandler } from './routes/workspaces.js';
import { createDeckRouter } from './routes/decks.js';
import { createFileRouter } from './routes/files.js';
import { createTerminalRouter } from './routes/terminals.js';
import { createGitRouter } from './routes/git.js';
import { createSettingsRouter } from './routes/settings.js';
import { createAgentRouter } from './routes/agents.js';
import { setupWebSocketServer, getConnectionLimit, setConnectionLimit, getConnectionStats, clearAllConnections } from './websocket.js';

// Request ID and logging middleware
const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  // Use existing request ID or generate new one
  const requestId = c.req.header('x-request-id') || crypto.randomUUID().slice(0, 8);
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);

  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  // Log in production or if DEBUG is set
  if (NODE_ENV === 'production' || process.env.DEBUG) {
    console.log(`[${requestId}] ${method} ${path} ${status} ${duration}ms`);
  }
};

export function createServer() {
  // Check database integrity before opening
  if (fsSync.existsSync(dbPath) && !checkDatabaseIntegrity(dbPath)) {
    handleDatabaseCorruption(dbPath);
  }

  // Initialize database
  const db = new DatabaseSync(dbPath);
  initializeDatabase(db);

  // Initialize state
  const workspaces = new Map<string, Workspace>();
  const workspacePathIndex = new Map<string, string>();
  const decks = new Map<string, Deck>();
  const terminals = new Map<string, TerminalSession>();

  // Load persisted state
  loadPersistedState(db, workspaces, workspacePathIndex, decks);

  // Create Hono app
  const app = new Hono();

  // Global middleware
  app.use('*', securityHeaders);
  app.use('*', corsMiddleware);
  app.use('*', requestIdMiddleware);

  // Body size limit for API routes
  app.use('/api/*', bodyLimit({
    maxSize: MAX_REQUEST_BODY_SIZE,
    onError: (c) => {
      return c.json({ error: 'Request body too large' }, 413);
    }
  }));

  // Basic auth middleware
  if (basicAuthMiddleware) {
    app.use('/api/*', basicAuthMiddleware);
  }

  // Health check endpoint (no auth required for load balancers)
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // Mount routers
  app.route('/api/settings', createSettingsRouter());
  app.route('/api/workspaces', createWorkspaceRouter(db, workspaces, workspacePathIndex));
  app.route('/api/decks', createDeckRouter(db, workspaces, decks));
  const { router: terminalRouter, restoreTerminals } = createTerminalRouter(db, decks, terminals);
  app.route('/api/terminals', terminalRouter);
  const { router: agentRouter, abortAllAgents } = createAgentRouter(db, workspaces);
  app.route('/api/agents', agentRouter);
  app.route('/api/git', createGitRouter(workspaces));

  // Restore persisted terminals
  const persistedTerminals = loadPersistedTerminals(db, decks);
  if (persistedTerminals.length > 0) {
    console.log(`[TERMINAL] Restoring ${persistedTerminals.length} terminal(s) from database...`);
    restoreTerminals(persistedTerminals);
  }

  // Config endpoint
  app.get('/api/config', getConfigHandler());

  // WebSocket token endpoint (for authenticated WebSocket connections)
  app.get('/api/ws-token', (c) => {
    return c.json({
      token: generateWsToken(),
      authEnabled: isBasicAuthEnabled()
    });
  });

  // WebSocket management endpoints
  app.get('/api/ws/stats', (c) => {
    return c.json({
      limit: getConnectionLimit(),
      connections: getConnectionStats()
    });
  });

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

  // File routes - mount at /api to handle /api/files, /api/preview, /api/file
  const fileRouter = createFileRouter(workspaces);
  app.route('/api', fileRouter);

  // Serve static files
  if (hasStatic) {
    const serveAssets = serveStatic({ root: distDir });
    const serveIndex = serveStatic({ root: distDir, path: 'index.html' });
    app.use('/assets/*', serveAssets);
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api')) {
        return c.text('Not found', 404);
      }
      return serveIndex(c, next);
    });
  }

  // Start server
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }) as Server;

  // Setup WebSocket
  setupWebSocketServer(server, terminals);

  // Server startup
  server.on('listening', () => {
    const baseUrl = `http://localhost:${PORT}`;
    console.log(`Deck IDE server listening on ${baseUrl}`);
    console.log(`UI: ${baseUrl}`);
    console.log(`API: ${baseUrl}/api`);
    console.log(`Health: ${baseUrl}/health`);
    console.log('');
    console.log('Security Status:');
    console.log(`  - Basic Auth: ${BASIC_AUTH_USER && BASIC_AUTH_PASSWORD ? 'enabled (user: ' + BASIC_AUTH_USER + ')' : 'DISABLED (WARNING: API is publicly accessible!)'}`);
    console.log(`  - Max File Size: ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`);
    console.log(`  - Max Request Body: ${Math.round(MAX_REQUEST_BODY_SIZE / 1024)}KB`);
    console.log(`  - Trust Proxy: ${TRUST_PROXY ? 'enabled' : 'disabled'}`);
    console.log(`  - CORS Origin: ${CORS_ORIGIN || (NODE_ENV === 'development' ? '*' : 'NOT SET')}`);
    console.log(`  - Environment: ${NODE_ENV}`);
  });

  // Graceful shutdown handler - save terminal buffers and abort agents
  const saveTerminalBuffersOnShutdown = () => {
    abortAllAgents();
    if (terminals.size > 0) {
      console.log(`[SHUTDOWN] Saving ${terminals.size} terminal buffer(s)...`);
      saveAllTerminalBuffers(db, terminals);
      console.log('[SHUTDOWN] Terminal buffers saved.');
    }
  };

  // Handle various shutdown signals
  process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Received SIGINT, saving state...');
    saveTerminalBuffersOnShutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] Received SIGTERM, saving state...');
    saveTerminalBuffersOnShutdown();
    process.exit(0);
  });

  // Handle Windows shutdown (Ctrl+C in cmd/powershell)
  if (process.platform === 'win32') {
    process.on('SIGHUP', () => {
      console.log('[SHUTDOWN] Received SIGHUP, saving state...');
      saveTerminalBuffersOnShutdown();
      process.exit(0);
    });
  }

  // Handle uncaught exceptions - try to save state before crashing
  const originalExceptionHandler = process.listeners('uncaughtException')[0] as ((err: Error) => void) | undefined;
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (error: Error) => {
    // Suppress known node-pty ConPTY errors that don't affect functionality
    if (error.message?.includes('AttachConsole failed')) {
      console.log('[node-pty] AttachConsole error suppressed (terminal already exited)');
      return;
    }
    console.error('[SHUTDOWN] Uncaught exception, saving state before exit...');
    saveTerminalBuffersOnShutdown();
    if (originalExceptionHandler) {
      originalExceptionHandler(error);
    } else {
      console.error('Uncaught exception:', error);
      process.exit(1);
    }
  });

  return server;
}
