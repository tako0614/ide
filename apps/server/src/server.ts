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

// Handle uncaught exceptions from node-pty's ConPTY (AttachConsole errors)
process.on('uncaughtException', (error: Error) => {
  // Suppress known node-pty ConPTY errors that don't affect functionality
  if (error.message?.includes('AttachConsole failed')) {
    console.log('[node-pty] AttachConsole error suppressed (terminal already exited)');
    return;
  }
  // Re-throw other uncaught exceptions
  console.error('Uncaught exception:', error);
  throw error;
});

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
import { apiRateLimitMiddleware } from './middleware/rateLimit.js';
import { checkDatabaseIntegrity, handleDatabaseCorruption, initializeDatabase, loadPersistedState } from './utils/database.js';
import { createWorkspaceRouter, getConfigHandler } from './routes/workspaces.js';
import { createDeckRouter } from './routes/decks.js';
import { createFileRouter } from './routes/files.js';
import { createTerminalRouter } from './routes/terminals.js';
import { createGitRouter } from './routes/git.js';
import { createSettingsRouter } from './routes/settings.js';
import { setupWebSocketServer, setupTerminalCleanup } from './websocket.js';

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

  // Body size limit for API routes (except file uploads which have their own limit)
  app.use('/api/*', bodyLimit({
    maxSize: MAX_REQUEST_BODY_SIZE,
    onError: (c) => {
      return c.json({ error: 'Request body too large' }, 413);
    }
  }));

  app.use('/api/*', apiRateLimitMiddleware);

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
  app.route('/api/terminals', createTerminalRouter(decks, terminals));
  app.route('/api/git', createGitRouter(workspaces));

  // Config endpoint
  app.get('/api/config', getConfigHandler());

  // WebSocket token endpoint (for authenticated WebSocket connections)
  app.get('/api/ws-token', (c) => {
    return c.json({
      token: generateWsToken(),
      authEnabled: isBasicAuthEnabled()
    });
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

  // Setup WebSocket and terminal cleanup
  setupWebSocketServer(server, terminals);
  setupTerminalCleanup(terminals);

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
    console.log(`  - Rate Limiting: ${NODE_ENV === 'development' && !process.env.ENABLE_RATE_LIMIT ? 'disabled (development mode)' : 'enabled'}`);
    console.log(`  - Max File Size: ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`);
    console.log(`  - Max Request Body: ${Math.round(MAX_REQUEST_BODY_SIZE / 1024)}KB`);
    console.log(`  - Trust Proxy: ${TRUST_PROXY ? 'enabled' : 'disabled'}`);
    console.log(`  - CORS Origin: ${CORS_ORIGIN || (NODE_ENV === 'development' ? '*' : 'NOT SET')}`);
    console.log(`  - Environment: ${NODE_ENV}`);
  });

  return server;
}
