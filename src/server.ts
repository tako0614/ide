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
  CORS_ORIGIN,
  MAX_FILE_SIZE,
  MAX_REQUEST_BODY_SIZE,
  TRUST_PROXY,
  hasStatic,
  distDir,
  dbPath,
  AGENT_BROWSER_REAP_MCP,
  AGENT_BROWSER_CDP_PORT,
  AGENT_BROWSER_MAX_MCP_PER_AGENT,
  AGENT_BROWSER_MCP_IDLE_MS,
  DATA_DIR,
  DESKTOP_ENABLED,
  DESKTOP_DISPLAY,
  DESKTOP_WIDTH,
  DESKTOP_HEIGHT,
} from './config.js';
import { securityHeaders } from './middleware/security.js';
import { corsMiddleware } from './middleware/cors.js';
import { originGuard } from './middleware/origin.js';
import { currentSession, generateWsToken, isAuthEnabled, login, logout, onSessionRevoked, sessionGuard, sessionStatus, validBrowserMutation, verifiedInternalActor } from './middleware/auth.js';
import { initializeCredentials } from './auth/credentials.js';
import { initializeCliToken, removeCliToken } from './auth/cli-token.js';
import { createEventsRouter } from './utils/events.js';
import { closeTerminalClients } from './utils/terminal-control.js';
import { SharedDesktop } from './desktop/shared-desktop.js';
import { createDesktopRouter } from './routes/desktop.js';
import {
  checkDatabaseIntegrity,
  handleDatabaseCorruption,
  initializeDatabase,
  loadPersistedState,
} from './utils/database.js';
import { createWorkspaceRouter, getConfigHandler } from './routes/workspaces.js';
import { createDeckRouter } from './routes/decks.js';
import { createFileRouter } from './routes/files.js';
import { createTerminalRouter } from './routes/terminals.js';
import { createGitRouter } from './routes/git.js';
import { createSettingsRouter } from './routes/settings.js';
import { createMcpRouter } from './routes/mcp.js';
import { createBrowserRouter } from './routes/browser.js';
import { AgentBrowserService } from './utils/agent-browser.js';
import { DesktopComputer } from './computer/desktop.js';
import { createComputerRouter } from './routes/computer.js';
import { startMcpReaper } from './utils/browser-maintenance.js';
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
  await initializeCredentials();
  initializeCliToken();
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
  const sharedDesktop = DESKTOP_ENABLED
    ? new SharedDesktop({
        display: DESKTOP_DISPLAY,
        width: DESKTOP_WIDTH,
        height: DESKTOP_HEIGHT,
        stateDir: path.join(DATA_DIR, 'desktop'),
      })
    : null;
  const browserService = new AgentBrowserService();
  browserService.useSharedDesktop(sharedDesktop);
  // The computer tools observe and drive the same shared desktop.
  const computer = new DesktopComputer(undefined, sharedDesktop ?? undefined);

  // 共有ブラウザを起動時から常駐させ、BrowserPane を開いていなくても
  // Codex/Claude の chrome MCP（--browserUrl 127.0.0.1:9222）が常に使えるようにする。
  // 失敗してもサーバ起動は継続（Chrome 未導入の環境などを考慮）。AGENT_BROWSER_AUTOSTART=false で無効化可。
  if (process.env.AGENT_BROWSER_AUTOSTART !== 'false') {
    void browserService.start().catch((err) => {
      console.error('[browser] 共有ブラウザの自動起動に失敗:', err instanceof Error ? err.message : err);
    });
  }

  // Periodically reap leaked chrome-devtools-mcp servers (agents spawn one per
  // session against our CDP port and can leave them disconnected — wedging the
  // agent's chrome tools and leaking GBs). Safe: only disconnected + idle ones.
  const stopMcpReaper = AGENT_BROWSER_REAP_MCP
    ? startMcpReaper({
        cdpPort: AGENT_BROWSER_CDP_PORT,
        maxPerAgent: AGENT_BROWSER_MAX_MCP_PER_AGENT,
        idleMs: AGENT_BROWSER_MCP_IDLE_MS,
        intervalMs: 120_000,
      })
    : null;

  loadPersistedState(db, workspaces, workspacePathIndex, decks);

  // Create Hono app
  const app = new Hono();

  app.use('*', securityHeaders);
  app.use('*', corsMiddleware);
  app.use('*', requestIdMiddleware);

  // Runs after corsMiddleware so OPTIONS preflights are already answered, and
  // before bodyLimit/auth so a cross-site request is dropped before any work.
  app.use('/api/*', originGuard);
  app.use('/mcp', originGuard);
  app.use('/oauth/*', originGuard);

  app.use('/api/*', bodyLimit({
    maxSize: MAX_REQUEST_BODY_SIZE,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }));
  app.use('/mcp', bodyLimit({
    maxSize: MAX_REQUEST_BODY_SIZE,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }));
  app.use('/oauth/*', bodyLimit({
    maxSize: MAX_REQUEST_BODY_SIZE,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }));

  app.get('/api/auth/session', sessionStatus);
  app.post('/api/auth/login', login);
  app.post('/api/auth/logout', logout);
  app.use('/api/*', sessionGuard);
  app.use('/api/computer/*', async (c, next) => {
    if (c.req.method !== 'GET' && !verifiedInternalActor(c) && !validBrowserMutation(c)) {
      return c.json({ error: 'Invalid desktop origin or CSRF header' }, 403);
    }
    return next();
  });

  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() })
  );

  // Mount routers
  app.route('/api/desktop', createDesktopRouter(sharedDesktop));
  app.route('/api/events', createEventsRouter((c, close) => {
    const session = currentSession(c);
    return session ? onSessionRevoked(session.key, close) : () => {};
  }));
  app.route('/api/settings', createSettingsRouter());
  app.route('/api/workspaces', createWorkspaceRouter(db, workspaces, workspacePathIndex));
  const terminalRouter = createTerminalRouter(decks, terminals, db);
  terminalRouter.restoreSessions();
  app.route('/api/decks', createDeckRouter(db, workspaces, decks, terminals, terminalRouter.deleteUnattachedDeckTerminals));
  app.route('/api/terminals', terminalRouter);
  app.route('/api/git', createGitRouter(workspaces));
  app.route('/api/browser', createBrowserRouter(browserService));
  app.route('/api/computer', createComputerRouter(computer, (c) => {
    const session = currentSession(c);
    return session ? 'browser:' + session.key : verifiedInternalActor(c);
  }));

  app.get('/api/config', getConfigHandler());

  app.post('/api/ws-token', (c) => {
    const authEnabled = isAuthEnabled();
    const session = currentSession(c);
    if (authEnabled && !session) return c.json({ error: 'Authentication required' }, 401);
    return c.json({ token: authEnabled && session ? generateWsToken(session.key) : '', authEnabled });
  });

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
  app.route('/', createMcpRouter({
    apiFetch: (request) => Promise.resolve(app.fetch(request)),
    terminals,
  }));

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
  setupWebSocketServer(server, terminals, browserService, sharedDesktop);

  server.on('listening', () => {
    const baseUrl = `http://localhost:${PORT}`;
    console.log(`Deck IDE server listening on ${baseUrl}`);
    console.log(`UI: ${baseUrl}`);
    console.log(`API: ${baseUrl}/api`);
    console.log(`MCP: ${baseUrl}/mcp`);
    console.log(`Health: ${baseUrl}/health`);
    console.log('');
    console.log('Security Status:');
    console.log(`  - Session Auth: ${isAuthEnabled() ? 'enabled' : 'DISABLED'}`);
    console.log(`  - Max File Size: ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`);
    console.log(`  - Max Request Body: ${Math.round(MAX_REQUEST_BODY_SIZE / 1024)}KB`);
    console.log('  - MCP OAuth: enabled');
    console.log(`  - Trust Proxy: ${TRUST_PROXY ? 'enabled' : 'disabled'}`);
    console.log(`  - CORS Origin: ${CORS_ORIGIN || (NODE_ENV === 'development' ? '*' : 'NOT SET')}`);
    console.log(`  - Environment: ${NODE_ENV}`);
  });

  // Graceful shutdown
  let shutdownPromise: Promise<void> | null = null;
  const onShutdown = () => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      // Close our display clients; tmux-owned shells survive server restarts.
      terminals.forEach((session) => {
        closeTerminalClients(session, 'Server shutting down');
        session.detach();
      });
      terminals.clear();
      removeCliToken();
      stopMcpReaper?.();
      await computer.shutdown();
      await browserService.stop();
      // Leave the desktop and its apps running for the next start.
      sharedDesktop?.shutdown();

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
