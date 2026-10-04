import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

// Native app work is fake; session issuance, authentication, Origin and CSRF
// checks are the actual product middleware, with disposable credentials only.
test('owned app start and close require a signed browser and its control lease', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deckide-owned-route-'));
  const previous = process.env.DECKIDE_DATA_DIR;
  process.env.DECKIDE_DATA_DIR = directory;
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DECKIDE_DATA_DIR;
    else process.env.DECKIDE_DATA_DIR = previous;
  });
  const [{ initializeCredentials }, { hashPassword }, auth, { originGuard },
    { createComputerRouter }] = await Promise.all([
    import('../dist/auth/credentials.js'), import('../dist/auth/password.js'),
    import('../dist/middleware/auth.js'), import('../dist/middleware/origin.js'),
    import('../dist/routes/computer.js'),
  ]);
  const settings = (enabled) => writeFile(path.join(directory, 'settings.json'),
    JSON.stringify({ authEnabled: enabled, authUser: 'fixture-owner', authPasswordHash: passwordHash }));
  const passwordHash = await hashPassword('disposable-test-password');
  await settings(false);
  await initializeCredentials();
  const events = [];
  let controllingActor;
  const desktop = {
    assertLifecycleControl(actor) {
      if (controllingActor && controllingActor !== actor)
        throw Object.assign(new Error('Control lease belongs to another actor'), { status: 409 });
    },
    async status() { return { running: events.at(-1) === 'prepare' }; },
    async prepare() { throw new Error('Generic desktop prepare must not run'); },
    async stop() { throw new Error('Generic desktop stop must not run'); },
  };
  const app = new Hono();
  app.use('/api/*', originGuard);
  app.get('/api/auth/session', auth.sessionStatus);
  app.post('/api/auth/login', auth.login);
  app.use('/api/*', auth.sessionGuard);
  app.use('/api/computer/*', async (c, next) => {
    if (c.req.method !== 'GET' && !auth.verifiedInternalActor(c) && !auth.validBrowserMutation(c))
      return c.json({ error: 'Invalid desktop origin or CSRF header' }, 403);
    return next();
  });
  app.route('/api/computer', createComputerRouter(desktop, (c) => {
    const session = auth.currentSession(c);
    return session ? 'browser:' + session.key : auth.verifiedInternalActor(c);
  }, undefined, {
    async prepare() { events.push('prepare'); },
    async close() { events.push('close'); },
  }));
  const origin = 'http://127.0.0.1:8787';
  const request = (route, { cookie, method = 'POST', body = {}, csrf = true,
    withOrigin = true, spoof = false } = {}) => {
    const headers = { Host: '127.0.0.1:8787', 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (withOrigin) headers.Origin = origin;
    if (csrf) headers['X-DeckIDE-CSRF'] = '1';
    if (spoof) {
      headers['X-DeckIDE-Actor'] = controllingActor || 'browser:forged';
      headers['X-DeckIDE-Internal'] = 'forged';
      headers.Authorization = 'Bearer forged';
    }
    return app.request(origin + route, { method, headers,
      ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
  };
  const guest = await request('/api/auth/session', { method: 'GET' });
  const guestCookie = guest.headers.get('set-cookie').split(';')[0];
  for (const route of ['/api/computer/prepare', '/api/computer/stop']) {
    assert.equal((await request(route, { cookie: guestCookie })).status, 403);
    assert.equal((await request(route, { spoof: true })).status, 401);
  }
  assert.deepEqual(events, []);
  await settings(true);
  await initializeCredentials();
  const login = async () => {
    const response = await request('/api/auth/login', {
      body: { username: 'fixture-owner', password: 'disposable-test-password' },
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const ownerCookie = await login();
  const otherCookie = await login();
  for (const route of ['/api/computer/prepare', '/api/computer/stop']) {
    assert.equal((await request(route, { cookie: ownerCookie, csrf: false })).status, 403);
    assert.equal((await request(route, { cookie: ownerCookie, withOrigin: false })).status, 403);
    assert.equal((await request(route, { cookie: ownerCookie, body: { actor: 'browser:forged' } })).status, 400);
    assert.equal((await request(route, { cookie: guestCookie })).status, 401);
  }
  assert.deepEqual(events, []);
  assert.equal((await request('/api/computer/prepare', { cookie: ownerCookie })).status, 200);
  const ownerSession = auth.currentSession({ req: { header: (name) => name.toLowerCase() === 'cookie' ? ownerCookie : undefined } });
  controllingActor = 'browser:' + ownerSession.key;
  for (const route of ['/api/computer/prepare', '/api/computer/stop'])
    assert.equal((await request(route, { cookie: otherCookie, spoof: true })).status, 409);
  assert.deepEqual(events, ['prepare']);
  assert.equal((await request('/api/computer/stop', { cookie: ownerCookie })).status, 200);
  assert.deepEqual(events, ['prepare', 'close']);
});
