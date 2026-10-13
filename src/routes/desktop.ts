import { Hono } from 'hono';
import type { SharedDesktop } from '../desktop/shared-desktop.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';

/**
 * The shared GUI desktop (see desktop/shared-desktop.ts): status, start/stop,
 * the app list, launching apps or commands, typing text, and the credentials
 * the browser's VNC viewer needs for the /api/desktop/vnc WebSocket.
 * Mounted beneath /api/* sessionGuard (browser session or local CLI token).
 */
export function createDesktopRouter(desktop: SharedDesktop | null) {
  const router = new Hono();
  const require = (): SharedDesktop => {
    if (!desktop) throw createHttpError('The shared desktop is disabled (DECKIDE_DESKTOP=false)', 503);
    return desktop;
  };

  router.get('/', async (c) => {
    try {
      if (!desktop) return c.json({ enabled: false, supported: false, running: false });
      return c.json({ enabled: true, ...(await desktop.status()) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.post('/start', async (c) => {
    try {
      const service = require();
      await service.ensure();
      return c.json({ enabled: true, ...(await service.status()) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.post('/stop', async (c) => {
    try {
      return c.json({ enabled: true, ...(await require().stop()) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.get('/apps', async (c) => {
    try {
      return c.json(await require().apps());
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.post('/launch', async (c) => {
    try {
      const body = await readJson<{ appId?: unknown; command?: unknown; cwd?: unknown }>(c);
      if (!body || typeof body !== 'object') throw createHttpError('Invalid launch request', 400);
      const result = await require().launch({
        appId: typeof body.appId === 'string' ? body.appId : undefined,
        command: typeof body.command === 'string' ? body.command : undefined,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
      });
      return c.json(result, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.post('/type', async (c) => {
    try {
      const body = await readJson<{ text?: unknown }>(c);
      await require().typeText(body?.text as string);
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.get('/env', async (c) => {
    try {
      const env = await require().ensure();
      return c.json(env);
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Password for the VNC viewer. Only reachable by authenticated clients; the
  // VNC server itself listens on loopback, reachable only via the bridge.
  router.post('/vnc', async (c) => {
    try {
      const { password } = await require().vnc();
      return c.json({ password, path: '/api/desktop/vnc' });
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
