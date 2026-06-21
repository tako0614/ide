import { Hono } from 'hono';
import type { Context } from 'hono';
import type { CodeServerService } from '../utils/code-server.js';

// Hop-by-hop / encoding headers that must not be forwarded verbatim. undici's
// fetch already decompresses the body, so leaving content-encoding/length on the
// response would make the browser try to decompress decoded bytes.
const STRIP_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];

async function proxy(c: Context, codeServer: CodeServerService): Promise<Response> {
  const wsId = c.req.param('wsId');
  if (!wsId) {
    return c.json({ error: 'workspace id required' }, 400);
  }

  let port: number;
  try {
    port = await codeServer.ensure(wsId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 503);
  }

  const url = new URL(c.req.url);
  const prefix = `/codeserver/${wsId}`;
  let upstreamPath = url.pathname.slice(prefix.length) || '/';
  if (!upstreamPath.startsWith('/')) {
    upstreamPath = `/${upstreamPath}`;
  }
  const target = `http://127.0.0.1:${port}${upstreamPath}${url.search}`;

  const headers = new Headers(c.req.raw.headers);
  headers.set('host', `127.0.0.1:${port}`);
  // Ask code-server not to compress; we re-stream the body raw.
  headers.set('accept-encoding', 'identity');

  const method = c.req.method;
  const init: RequestInit & { duplex?: string } = {
    method,
    headers,
    redirect: 'manual',
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = c.req.raw.body;
    init.duplex = 'half';
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init as RequestInit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: `code-server proxy failed: ${message}` }, 502);
  }

  const respHeaders = new Headers(upstream.headers);
  for (const name of STRIP_RESPONSE_HEADERS) {
    respHeaders.delete(name);
  }
  // Let code-server's service worker claim the whole subpath scope.
  respHeaders.set('service-worker-allowed', `/codeserver/${wsId}/`);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export function createCodeServerRouter(codeServer: CodeServerService) {
  const router = new Hono();

  // Capability/status (must be registered before the :wsId catch-all).
  router.get('/status', async (c) => {
    const wsId = c.req.query('wsId') || undefined;
    return c.json(await codeServer.getStatus(wsId));
  });

  router.post('/stop', async (c) => {
    const wsId = c.req.query('wsId');
    if (wsId) {
      await codeServer.stop(wsId);
    }
    return c.json(await codeServer.getStatus(wsId || undefined));
  });

  // Reverse-proxy everything else under /codeserver/:wsId/* to that workspace's
  // code-server instance (prefix stripped).
  router.all('/:wsId/*', (c) => proxy(c, codeServer));
  router.all('/:wsId', (c) => proxy(c, codeServer));

  return router;
}
