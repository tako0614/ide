import { Hono, type Context } from 'hono';
import { DesktopComputer, type DesktopInput } from '../computer/desktop.js';
import { validateLaunchRequest } from '../computer/catalog.js';
import { currentSession, isAuthEnabled, validBrowserMutation, verifiedInternalActor } from '../middleware/auth.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { ComputerStreamTickets } from '../computer/stream-tickets.js';

type OwnedDesktopLifecycle = {
  prepare(): Promise<unknown>;
  close(): Promise<unknown>;
};

// Mounted beneath /api/* sessionGuard and the computer Origin/CSRF guard.
// Identity always comes from a verified browser session or signed MCP bridge.
export function createComputerRouter(
  computer: DesktopComputer,
  resolveActor: (context: Context) => string | null,
  streamTickets?: ComputerStreamTickets,
  ownedDesktop?: OwnedDesktopLifecycle,
) {
  const router = new Hono();
  const actor = (c: Context): string => {
    const value = resolveActor(c);
    if (!value) throw createHttpError('Desktop session required', 401);
    return value;
  };
  const body = async (c: Context, keys: string[]): Promise<Record<string, unknown>> => {
    const value = await readJson<unknown>(c);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)))
      throw createHttpError('Invalid desktop request fields', 400);
    return value as Record<string, unknown>;
  };
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  router.get('/status', async (c) => {
    try { return c.json(await computer.status(actor(c))); }
    catch (error) { return handleError(c, error); }
  });
  router.get('/apps', async (c) => {
    try { return c.json(await computer.apps(actor(c))); }
    catch (error) { return handleError(c, error); }
  });
  const streamSession = (c: Context) => {
    const session = currentSession(c);
    if (!isAuthEnabled() || !session || session.session.guest || !validBrowserMutation(c))
      throw createHttpError('Signed-in browser desktop session required', 403);
    return session;
  };
  router.post('/vnc', async (c) => {
    try {
      const session = streamSession(c);
      await body(c, []);
      return c.json(await computer.streamInfo(`browser:${session.key}`));
    } catch (error) { return handleError(c, error); }
  });
  router.post('/vnc-ticket', async (c) => {
    try {
      const session = streamSession(c);
      const request = await body(c, ['epoch']);
      const status = await computer.status(`browser:${session.key}`);
      if (!status.running || request.epoch !== status.epoch)
        throw createHttpError('Desktop changed; reconnect', 409);
      if (!streamTickets) throw createHttpError('Desktop stream transport unavailable', 503);
      return c.json({ token: streamTickets.issue(session.key, status.epoch) });
    } catch (error) { return handleError(c, error); }
  });
  router.post('/prepare', async (c) => {
    try {
      const verified = actor(c);
      if (ownedDesktop) {
        streamSession(c);
        await body(c, []);
        computer.assertLifecycleControl(verified);
        await ownedDesktop.prepare();
        return c.json(await computer.status(verified));
      }
      return c.json(await computer.prepare(verified));
    }
    catch (error) { return handleError(c, error); }
  });
  router.post('/stop', async (c) => {
    try {
      const verified = actor(c);
      if (ownedDesktop) {
        streamSession(c);
        await body(c, []);
        computer.assertLifecycleControl(verified);
        await ownedDesktop.close();
        return c.json(await computer.status(verified));
      }
      return c.json(await computer.stop(verified));
    }
    catch (error) { return handleError(c, error); }
  });
  router.post('/launch', async (c) => {
    try {
      const verified = actor(c);
      return c.json(await computer.launch(validateLaunchRequest(await readJson(c)), verified));
    } catch (error) { return handleError(c, error); }
  });
  router.post('/focus', async (c) => {
    try {
      const verified = actor(c);
      const request = await body(c, ['instanceId', 'windowId']);
      if (typeof request.instanceId !== 'string' || typeof request.windowId !== 'string')
        throw createHttpError('Choose an owned app and window', 400);
      return c.json(await computer.focus(verified, { instanceId: request.instanceId, windowId: request.windowId }));
    } catch (error) { return handleError(c, error); }
  });
  router.post('/close', async (c) => {
    try {
      const verified = actor(c);
      const request = await body(c, ['instanceId']);
      if (typeof request.instanceId !== 'string') throw createHttpError('Choose an owned app', 400);
      return c.json(await computer.closeApp(verified, { instanceId: request.instanceId }));
    } catch (error) { return handleError(c, error); }
  });
  router.post('/register', async (c) => {
    try {
      const verified = actor(c);
      const request = await body(c, ['scopeId', 'executable', 'args', 'cwd']);
      if (verified.startsWith('oauth:')) {
        if (verifiedInternalActor(c) !== verified)
          throw createHttpError('Verified agent grant is required to register an executable', 403);
      } else {
        const session = currentSession(c);
        if (!session || session.session.guest || !isAuthEnabled() ||
          verified !== 'browser:' + session.key || !validBrowserMutation(c))
          throw createHttpError('Signed-in session is required to register an executable', 403);
      }
      // The backend resolves scopeId only against startup-supplied authority.
      // Agents can register their own workspace artifacts without per-app
      // human approval; callers cannot grant a root through this request.
      return c.json(await computer.registerDeveloped(verified, request));
    } catch (error) { return handleError(c, error); }
  });
  router.post('/control', async (c) => {
    try {
      const verified = actor(c);
      const request = await body(c, ['action']);
      if (!['claim', 'release', 'heartbeat'].includes(request.action as string))
        throw createHttpError('Invalid control action', 400);
      return c.json(await computer.control(verified,
        { action: request.action as 'claim' | 'release' | 'heartbeat' }));
    } catch (error) { return handleError(c, error); }
  });
  router.post('/screenshot', async (c) => {
    try {
      const verified = actor(c);
      const request = await readJson<unknown>(c);
      if (!request || typeof request !== 'object' || Array.isArray(request))
        throw createHttpError('Invalid screenshot request', 400);
      const previousHash = (request as { previousHash?: unknown }).previousHash;
      if (previousHash !== undefined && typeof previousHash !== 'string')
        throw createHttpError('Invalid previous hash', 400);
      return c.json(await computer.screenshot(verified, previousHash as string | undefined));
    } catch (error) { return handleError(c, error); }
  });
  router.post('/input', async (c) => {
    try {
      const verified = actor(c);
      const request = await readJson<unknown>(c);
      if (!request || typeof request !== 'object' || Array.isArray(request))
        throw createHttpError('Invalid desktop input', 400);
      return c.json(await computer.input(verified, request as DesktopInput));
    } catch (error) { return handleError(c, error); }
  });
  return router;
}
