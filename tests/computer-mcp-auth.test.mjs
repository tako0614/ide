import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

// Exercise real OAuth issuance, MCP tool dispatch, the private API bridge,
// session/guest cookies, and the computer router. Native X11 is the only fake:
// it records which verified actor owns each observation.
test('MCP and guest desktop observations belong to the verified grant or cookie', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'deckide-computer-auth-'));
  const envKeys = ['DECKIDE_DATA_DIR', 'PORT', 'HOST', 'DECKIDE_AUTH_USER',
    'DECKIDE_AUTH_PASSWORD', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD'];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  process.env.DECKIDE_DATA_DIR = dataDir;
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  delete process.env.DECKIDE_AUTH_USER;
  delete process.env.DECKIDE_AUTH_PASSWORD;
  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASSWORD;
  await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ authEnabled: false, port }));

  const [{ initializeCredentials }, auth, { originGuard }, { createMcpRouter },
    { createComputerRouter }] = await Promise.all([
    import('../dist/auth/credentials.js'),
    import('../dist/middleware/auth.js'),
    import('../dist/middleware/origin.js'),
    import('../dist/routes/mcp.js'),
    import('../dist/routes/computer.js'),
  ]);
  await initializeCredentials();

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]).toString('base64');
  const observations = new Map();
  const fakeDesktop = {
    async status() { return { supported: true, running: true, width: 960, height: 540 }; },
    async prepare() { return { supported: true, running: true, width: 960, height: 540 }; },
    async stop() { observations.clear(); return { supported: true, running: false, width: 960, height: 540 }; },
    async launch() { return { supported: true, running: true, width: 960, height: 540 }; },
    async screenshot(actor) {
      const observationId = crypto.randomUUID();
      observations.set(observationId, actor);
      return { observationId, width: 960, height: 540, hash: 'fixture-hash',
        image: { type: 'image', mimeType: 'image/jpeg', data: jpeg } };
    },
    async input(actor, input) {
      if (observations.get(input.observationId) !== actor) {
        throw Object.assign(new Error('A fresh screenshot is required before desktop input'), { status: 409 });
      }
      observations.delete(input.observationId);
      return { success: true };
    },
  };

  const app = new Hono();
  app.use('/api/*', originGuard);
  app.use('/mcp', originGuard);
  app.use('/oauth/*', originGuard);
  app.get('/api/auth/session', auth.sessionStatus);
  app.use('/api/*', auth.sessionGuard);
  app.use('/api/computer/*', async (c, next) => {
    if (c.req.method !== 'GET' && !auth.verifiedInternalActor(c) && !auth.validBrowserMutation(c)) {
      return c.json({ error: 'Invalid desktop origin or CSRF header' }, 403);
    }
    return next();
  });
  app.route('/api/computer', createComputerRouter(fakeDesktop, (c) => {
    const session = auth.currentSession(c);
    return session ? 'browser:' + session.key : auth.verifiedInternalActor(c);
  }));
  app.route('/', createMcpRouter({ apiFetch: (request) => app.fetch(request), terminals: new Map() }));
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  if (!server.listening) await once(server, 'listening');

  const call = (route, { method = 'GET', body, cookie, bearer, form, withOrigin = false,
    csrf = false, actorHeader, bridgeHeader } = {}) => {
    const headers = { Host: '127.0.0.1:' + port };
    if (cookie) headers.Cookie = cookie;
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (withOrigin) headers.Origin = origin;
    if (csrf) headers['X-DeckIDE-CSRF'] = '1';
    if (actorHeader) headers['X-DeckIDE-Actor'] = actorHeader;
    if (bridgeHeader) headers['X-DeckIDE-Internal'] = bridgeHeader;
    let requestBody;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body);
    } else if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      requestBody = new URLSearchParams(form);
    }
    return fetch(origin + route, { method, headers, body: requestBody, redirect: 'manual' });
  };
  const rpc = async (bearer, name, args = {}) => {
    const response = await call('/mcp', { method: 'POST', bearer,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const grant = async () => {
    const redirectUri = 'http://127.0.0.1:9999/callback';
    const registration = await call('/oauth/register', { method: 'POST',
      body: { redirect_uris: [redirectUri] } });
    assert.equal(registration.status, 201);
    const clientId = (await registration.json()).client_id;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authorization = {
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256',
    };
    const approval = await call('/oauth/authorize', { method: 'POST', withOrigin: true,
      form: { ...authorization, decision: 'approve' } });
    assert.equal(approval.status, 302);
    const code = new URL(approval.headers.get('location')).searchParams.get('code');
    assert.ok(code);
    const exchange = await call('/oauth/token', { method: 'POST',
      form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: clientId, code_verifier: verifier } });
    assert.equal(exchange.status, 200);
    return (await exchange.json()).access_token;
  };

  const firstGrant = await grant();
  const secondGrant = await grant();
  assert.notEqual(firstGrant, secondGrant);
  const actor1 = 'oauth:' + crypto.createHash('sha256').update(firstGrant).digest('hex');
  const actor2 = 'oauth:' + crypto.createHash('sha256').update(secondGrant).digest('hex');
  assert.notEqual(actor1, actor2);

  const screenshot = await rpc(firstGrant, 'deckide.computer.screenshot');
  assert.equal(screenshot.isError, false);
  assert.match(screenshot.structuredContent.observationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(screenshot.content.map((item) => item.type), ['text', 'image']);
  assert.equal(screenshot.content[1].mimeType, 'image/jpeg');
  assert.equal(screenshot.content[1].data, jpeg);
  assert.equal(screenshot.structuredContent.image, undefined);
  assert.ok(!screenshot.content[0].text.includes(jpeg));
  const firstObservation = screenshot.structuredContent.observationId;
  assert.equal(observations.get(firstObservation), actor1);

  const deniedByOtherGrant = await rpc(secondGrant, 'deckide.computer.input',
    { observationId: firstObservation, action: 'click', x: 10, y: 10 });
  assert.equal(deniedByOtherGrant.isError, true);
  assert.equal(deniedByOtherGrant.structuredContent.status, 409);
  const deniedByGenericSpoof = await rpc(secondGrant, 'deckide.api.request',
    { method: 'POST', path: '/api/computer/input',
      body: { observationId: firstObservation, action: 'click', x: 10, y: 10, actor: actor1 } });
  assert.equal(deniedByGenericSpoof.isError, true);
  assert.equal(deniedByGenericSpoof.structuredContent.status, 409);
  const acceptedByGeneric = await rpc(firstGrant, 'deckide.api.request',
    { method: 'POST', path: '/api/computer/input',
      body: { observationId: firstObservation, action: 'click', x: 10, y: 10 } });
  assert.equal(acceptedByGeneric.isError, false);

  const guest1 = await call('/api/auth/session');
  const guest2 = await call('/api/auth/session');
  const cookie1 = guest1.headers.get('set-cookie')?.split(';')[0];
  const cookie2 = guest2.headers.get('set-cookie')?.split(';')[0];
  assert.match(cookie1, /^deckide_session=/);
  assert.match(cookie2, /^deckide_session=/);
  assert.notEqual(cookie1, cookie2);
  const prepare = await call('/api/computer/prepare', { method: 'POST', cookie: cookie1,
    withOrigin: true, csrf: true, body: {} });
  assert.equal(prepare.status, 200);
  assert.equal((await call('/api/computer/screenshot', { method: 'POST', cookie: cookie1,
    withOrigin: true, body: {} })).status, 403);
  const guestShot = await call('/api/computer/screenshot', { method: 'POST', cookie: cookie1,
    withOrigin: true, csrf: true, body: {} });
  assert.equal(guestShot.status, 200);
  const guestObservation = (await guestShot.json()).observationId;
  assert.match(observations.get(guestObservation), /^browser:[a-f0-9]{64}$/);
  assert.equal((await call('/api/computer/input', { method: 'POST', cookie: cookie2,
    withOrigin: true, csrf: true,
    body: { observationId: guestObservation, action: 'click', x: 10, y: 10 } })).status, 409);
  assert.equal((await call('/api/computer/input', { method: 'POST', cookie: cookie2,
    withOrigin: true, csrf: true, actorHeader: observations.get(guestObservation),
    body: { observationId: guestObservation, action: 'click', x: 10, y: 10 } })).status, 409);
  assert.equal((await call('/api/computer/input', { method: 'POST', withOrigin: true, csrf: true,
    actorHeader: actor1, bridgeHeader: 'forged',
    body: { observationId: guestObservation, action: 'click', x: 10, y: 10 } })).status, 401);
  const grantCannotUseGuest = await rpc(firstGrant, 'deckide.computer.input',
    { observationId: guestObservation, action: 'click', x: 10, y: 10 });
  assert.equal(grantCannotUseGuest.isError, true);
  assert.equal(grantCannotUseGuest.structuredContent.status, 409);
  assert.equal((await call('/api/computer/input', { method: 'POST', cookie: cookie1,
    withOrigin: true, csrf: true,
    body: { observationId: guestObservation, action: 'click', x: 10, y: 10 } })).status, 200);
});
