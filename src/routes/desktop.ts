import { Hono } from 'hono';
import { MAX_DESKTOP_TEXT, type SharedDesktop } from '../desktop/shared-desktop.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';

// Mounted beneath /api/* sessionGuard: the same people who may open a root
// terminal may use the shared desktop. The VNC stream is /api/desktop/vnc (WS).
export function createDesktopRouter(desktop: SharedDesktop) {
  const router = new Hono();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    return next();
  });
  router.get('/', async (c) => {
    try { return c.json(await desktop.status()); }
    catch (error) { return handleError(c, error); }
  });
  router.post('/start', async (c) => {
    try { return c.json(await desktop.start()); }
    catch (error) { return handleError(c, error); }
  });
  router.post('/restart', async (c) => {
    try { return c.json(await desktop.restart()); }
    catch (error) { return handleError(c, error); }
  });
  router.post('/type', async (c) => {
    try {
      const body = await readJson<{ text?: unknown }>(c);
      const text = body?.text;
      if (typeof text !== 'string' || !text || text.length > MAX_DESKTOP_TEXT)
        throw createHttpError('text must be 1-4000 characters', 400);
      await desktop.type(text);
      return c.json({ ok: true });
    } catch (error) { return handleError(c, error); }
  });
  return router;
}
