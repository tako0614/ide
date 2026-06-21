import { Hono } from 'hono';
import type { BrowserNavigateRequest } from '../shared/types.js';
import { AgentBrowserService } from '../utils/agent-browser.js';
import { handleError, readJson } from '../utils/error.js';

export function createBrowserRouter(browserService: AgentBrowserService) {
  const router = new Hono();

  router.get('/status', async (c) => {
    return c.json(await browserService.getStatus());
  });

  router.post('/start', async (c) => {
    try {
      await browserService.start();
      return c.json(await browserService.getStatus());
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.post('/stop', async (c) => {
    try {
      await browserService.stop();
      return c.json(await browserService.getStatus());
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.post('/navigate', async (c) => {
    try {
      const body = await readJson<BrowserNavigateRequest>(c);
      if (!body?.url || typeof body.url !== 'string') {
        return c.json({ error: 'url is required' }, 400);
      }
      await browserService.navigate(body.url);
      return c.json(await browserService.getStatus());
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
