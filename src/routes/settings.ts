import { Hono } from 'hono';
import { getCredentials, updateCredentials, type SettingsUpdate } from '../auth/credentials.js';
import { revokeAllSessions } from '../middleware/auth.js';
import { revokeMcpGrants } from './mcp.js';

export function createSettingsRouter() {
  const router = new Hono();
  router.get('/', (c) => {
    const state = getCredentials();
    return c.json({ port: state.port, authEnabled: state.enabled,
      authUser: state.user, passwordConfigured: Boolean(state.hash) });
  });
  router.post('/', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid settings' }, 400);
    const input = body as SettingsUpdate;
    if (Object.keys(input).some((key) => !['port', 'authEnabled', 'authUser', 'authPassword'].includes(key))) {
      return c.json({ error: 'Unknown settings field' }, 400);
    }
    try {
      const oldPort = getCredentials().port;
      // Revocation runs synchronously inside the serialized credential commit.
      let sessionRevoked = false;
      await updateCredentials(input, () => {
        revokeAllSessions();
        revokeMcpGrants();
        sessionRevoked = true;
      });
      return c.json({ success: true, requiresRestart: input.port !== undefined && input.port !== oldPort, sessionRevoked });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid settings' }, 400);
    }
  });
  return router;
}
