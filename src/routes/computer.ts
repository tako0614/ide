import { Hono, type Context } from 'hono';
import { DesktopComputer, type DesktopInput } from '../computer/desktop.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';

// Mounted beneath /api/* sessionGuard. The caller derives a stable opaque ID
// from a verified browser session or authorized MCP grant. In particular,
// never use a client-provided JSON/header actor without verifying it upstream.
export function createComputerRouter(
  computer: DesktopComputer,
  resolveActor: (context: Context) => string | null,
) {
  const router = new Hono();
  const actor = (c: Context): string => {
    const value = resolveActor(c);
    if (!value) throw createHttpError('Desktop session required', 401);
    return value;
  };

  router.get('/status', async (c) => {
    try { return c.json(await computer.status()); }
    catch (error) { return handleError(c, error); }
  });

  router.post('/prepare', async (c) => {
    try { actor(c); return c.json(await computer.prepare()); }
    catch (error) { return handleError(c, error); }
  });

  router.post('/stop', async (c) => {
    try { actor(c); return c.json(await computer.stop()); }
    catch (error) { return handleError(c, error); }
  });

  router.post('/launch', async (c) => {
    try {
      actor(c);
      const body = await readJson<unknown>(c);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw createHttpError('Invalid launch request', 400);
      const request = body as { app?: unknown; url?: unknown };
      if (request.app !== 'browser' && request.app !== 'terminal')
        throw createHttpError('Choose browser or terminal', 400);
      if (request.url !== undefined && typeof request.url !== 'string')
        throw createHttpError('Invalid URL', 400);
      return c.json(await computer.launch({ app: request.app, url: request.url as string | undefined }));
    } catch (error) { return handleError(c, error); }
  });

  router.post('/screenshot', async (c) => {
    try {
      const body = await readJson<unknown>(c);
      if (body === null || typeof body !== 'object' || Array.isArray(body))
        throw createHttpError('Invalid screenshot request', 400);
      const previousHash = (body as { previousHash?: unknown }).previousHash;
      if (previousHash !== undefined && typeof previousHash !== 'string')
        throw createHttpError('Invalid previous hash', 400);
      return c.json(await computer.screenshot(actor(c), previousHash as string | undefined));
    } catch (error) { return handleError(c, error); }
  });

  router.post('/input', async (c) => {
    try {
      const body = await readJson<unknown>(c);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw createHttpError('Invalid desktop input', 400);
      return c.json(await computer.input(actor(c), body as DesktopInput));
    } catch (error) { return handleError(c, error); }
  });

  return router;
}
