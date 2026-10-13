import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { hashPassword } from '../dist/auth/password.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function startServer(settings, { ttlMs } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-session-test-'));
  const port = await freePort();
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ ...settings, port }));
  const env = { ...process.env, DECKIDE_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1',
    AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false',
    ...(ttlMs ? { NODE_ENV: 'test', DECKIDE_TEST_SESSION_TTL_MS: String(ttlMs) } : {}) };
  delete env.DECKIDE_AUTH_USER;
  delete env.DECKIDE_AUTH_PASSWORD;
  delete env.BASIC_AUTH_USER;
  delete env.BASIC_AUTH_PASSWORD;
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const origin = 'http://127.0.0.1:' + port;
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error('Server exited: ' + logs);
    try {
      const response = await fetch(origin + '/health');
      if (response.ok) return { child, dir, origin, logs: () => logs };
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error('Server did not start: ' + logs);
}
async function stopServer(fixture) {
  fixture.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => fixture.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => { fixture.child.kill('SIGKILL'); resolve(); }, 2000)),
  ]);
  await rm(fixture.dir, { recursive: true, force: true });
}
function request(fixture, url, { method = 'GET', cookie, body, origin = true, csrf = true, authorization } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  if (origin) headers.Origin = origin === true ? fixture.origin : origin;
  if (csrf) headers['X-DeckIDE-CSRF'] = '1';
  if (authorization) headers.Authorization = authorization;
  return fetch(fixture.origin + url, { method, headers, body, redirect: 'manual' });
}
function websocketClose(fixture, token, { cookie, origin = fixture.origin, authorization } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(fixture.origin.replace('http', 'ws') + '/api/terminals/missing' +
      (token ? '?token=' + encodeURIComponent(token) : ''), {
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}),
        ...(authorization ? { Authorization: authorization } : {}) },
    });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('WS close timeout')); }, 2000);
    socket.on('error', reject);
    socket.on('close', (code, reason) => { clearTimeout(timeout); resolve({ code, reason: reason.toString() }); });
  });
}
async function openTerminalWebSocket(fixture, terminalId, token, cookie) {
  const socket = new WebSocket(fixture.origin.replace('http', 'ws') +
    '/api/terminals/' + terminalId + '?token=' + encodeURIComponent(token), {
    headers: { Cookie: cookie, Origin: fixture.origin },
  });
  await Promise.race([
    new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('WS open timeout')), 2000)),
  ]);
  return socket;
}

test('session auth rejects Basic, enforces CSRF, binds tickets and revokes on rotation', async (t) => {
  const password = 'correct-horse-battery-staple';
  const fixture = await startServer({ authEnabled: true, authUser: 'owner',
    authPasswordHash: await hashPassword(password) });
  t.after(() => stopServer(fixture));

  const status = await request(fixture, '/api/auth/session');
  assert.deepEqual(await status.json(), { authEnabled: true, authenticated: false });
  assert.equal(status.headers.get('cache-control'), 'no-store');
  const basic = 'Basic ' + Buffer.from('owner:' + password).toString('base64');
  const denied = await request(fixture, '/api/settings', { authorization: basic });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), null);
  assert.equal((await websocketClose(fixture, null, { authorization: basic })).reason, 'Unauthorized');
  assert.equal((await request(fixture, '/api/auth/login', { method: 'POST', body: { username: 'owner', password }, origin: false })).status, 403);
  assert.equal((await request(fixture, '/api/auth/login', { method: 'POST', body: { username: 'owner', password }, csrf: false })).status, 403);
  assert.equal((await request(fixture, '/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'wrong' } })).status, 401);

  const login = await request(fixture, '/api/auth/login', { method: 'POST', body: { username: 'owner', password } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.match(cookie, /^deckide_session=[A-Za-z0-9_-]{43}$/);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await request(fixture, '/api/settings', { cookie })).status, 200);
  const settings = await (await request(fixture, '/api/settings', { cookie })).json();
  assert.deepEqual(settings, { port: Number(new URL(fixture.origin).port), authEnabled: true,
    authUser: 'owner', passwordConfigured: true });
  assert.ok(!JSON.stringify(settings).includes(password));
  assert.equal((await request(fixture, '/api/settings', { method: 'POST', cookie, body: { port: settings.port }, origin: false })).status, 403);
  assert.equal((await request(fixture, '/api/settings', { method: 'POST', cookie, body: { port: settings.port }, csrf: false })).status, 403);
  assert.equal((await request(fixture, '/api/ws-token', { method: 'POST', cookie, origin: false })).status, 403);
  const ticketResponse = await request(fixture, '/api/ws-token', { method: 'POST', cookie });
  assert.equal(ticketResponse.status, 200);
  const ticket = (await ticketResponse.json()).token;
  assert.equal((await websocketClose(fixture, ticket)).reason, 'Unauthorized');
  assert.equal((await websocketClose(fixture, ticket, { cookie, origin: 'http://evil.example' })).reason, 'Invalid origin');
  assert.equal((await websocketClose(fixture, ticket, { cookie })).reason, 'Terminal not found');
  assert.equal((await websocketClose(fixture, ticket, { cookie })).reason, 'Unauthorized');

  // OAuth's bearer authority stays independent, while tool calls use a private
  // in-process bridge instead of forwarding the operator password.
  const redirectUri = 'http://127.0.0.1:9999/callback';
  const registration = await request(fixture, '/oauth/register', { method: 'POST',
    body: { redirect_uris: [redirectUri] } });
  assert.equal(registration.status, 201);
  const clientId = (await registration.json()).client_id;
  const verifier = 'v'.repeat(64);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorization = new URLSearchParams({ response_type: 'code', client_id: clientId,
    redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'test-state' });
  const oauthPath = '/oauth/authorize?' + authorization;
  const unauthConsent = await request(fixture, oauthPath);
  assert.equal(unauthConsent.status, 302);
  assert.match(unauthConsent.headers.get('location'), /^\/?\?returnTo=/);
  const consent = await request(fixture, oauthPath, { cookie });
  assert.equal(consent.status, 200);
  const csrf = (await consent.text()).match(/name="deckide_csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  const injectedConsent = await request(fixture, oauthPath + '&decision=approve', { cookie });
  assert.equal(injectedConsent.status, 200);
  assert.ok(!(await injectedConsent.text()).includes('<input type="hidden" name="decision" value="approve"'));
  const denyForm = new URLSearchParams(authorization);
  denyForm.set('deckide_csrf', csrf);
  denyForm.append('decision', 'approve');
  denyForm.append('decision', 'deny');
  const deniedConsent = await fetch(fixture.origin + '/oauth/authorize', {
    method: 'POST', headers: { Cookie: cookie, Origin: fixture.origin,
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: denyForm, redirect: 'manual',
  });
  assert.equal(deniedConsent.status, 302);
  assert.equal(new URL(deniedConsent.headers.get('location')).searchParams.get('error'), 'access_denied');
  const form = new URLSearchParams(authorization);
  form.set('deckide_csrf', csrf);
  form.set('decision', 'approve');
  const missingConsentOrigin = await fetch(fixture.origin + '/oauth/authorize', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form, redirect: 'manual',
  });
  assert.equal(missingConsentOrigin.status, 403);
  const approved = await fetch(fixture.origin + '/oauth/authorize', {
    method: 'POST', headers: { Cookie: cookie, Origin: fixture.origin,
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: form, redirect: 'manual',
  });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  assert.ok(code);
  const exchanged = await fetch(fixture.origin + '/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: redirectUri, code_verifier: verifier }),
  });
  assert.equal(exchanged.status, 200);
  const accessToken = (await exchanged.json()).access_token;
  const toolCall = await request(fixture, '/mcp', { method: 'POST',
    authorization: 'Bearer ' + accessToken,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'deckide.settings.get', arguments: {} } } });
  assert.equal(toolCall.status, 200);
  const toolResult = await toolCall.json();
  assert.ok(!JSON.stringify(toolResult).includes(password));
  assert.ok(JSON.stringify(toolResult).includes('passwordConfigured'));
  assert.ok(!JSON.stringify(toolResult).includes('authPasswordHash'));
  const extraLogin = await request(fixture, '/api/auth/login', { method: 'POST',
    body: { username: 'owner', password } });
  const extraCookie = extraLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(fixture, '/api/auth/logout', { method: 'POST', cookie: extraCookie })).status, 204);
  assert.equal((await request(fixture, '/mcp', { method: 'POST',
    authorization: 'Bearer ' + accessToken,
    body: { jsonrpc: '2.0', id: 2, method: 'ping' } })).status, 200);

  const workspacePath = path.join(fixture.dir, 'workspace');
  await mkdir(workspacePath);
  const workspaceResponse = await request(fixture, '/api/workspaces', { method: 'POST', cookie,
    body: { path: workspacePath } });
  assert.equal(workspaceResponse.status, 201);
  const workspace = await workspaceResponse.json();
  const deckResponse = await request(fixture, '/api/decks', { method: 'POST', cookie,
    body: { workspaceId: workspace.id, name: 'test' } });
  assert.equal(deckResponse.status, 201);
  const deck = await deckResponse.json();
  const terminalResponse = await request(fixture, '/api/terminals', { method: 'POST', cookie,
    body: { deckId: deck.id, command: 'sleep 60' } });
  assert.equal(terminalResponse.status, 201);
  const terminal = await terminalResponse.json();
  const liveTicket = (await (await request(fixture, '/api/ws-token', { method: 'POST', cookie })).json()).token;
  const liveSocket = await openTerminalWebSocket(fixture, terminal.id, liveTicket, cookie);
  const closedOnRotation = new Promise((resolve) => liveSocket.once('close', resolve));
  const pendingTicket = (await (await request(fixture, '/api/ws-token', { method: 'POST', cookie })).json()).token;
  const rotated = await request(fixture, '/api/settings', { method: 'POST', cookie,
    body: { authPassword: 'new-correct-password-12' } });
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.json()).sessionRevoked, true);
  await Promise.race([closedOnRotation, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('WS survived credential rotation')), 2000))]);
  assert.equal((await request(fixture, '/api/settings', { cookie })).status, 401);
  assert.equal((await request(fixture, '/mcp', { method: 'POST',
    authorization: 'Bearer ' + accessToken,
    body: { jsonrpc: '2.0', id: 3, method: 'ping' } })).status, 401);
  assert.equal((await websocketClose(fixture, pendingTicket, { cookie })).reason, 'Unauthorized');
  const stored = JSON.parse(await readFile(path.join(fixture.dir, 'settings.json'), 'utf8'));
  assert.ok(!JSON.stringify(stored).includes('new-correct-password-12'));
  assert.ok(!('basicAuthPassword' in stored));
  assert.equal((await request(fixture, '/api/auth/login', { method: 'POST',
    body: { username: 'owner', password } })).status, 401);
  const secondLogin = await request(fixture, '/api/auth/login', { method: 'POST',
    body: { username: 'owner', password: 'new-correct-password-12' } });
  assert.equal(secondLogin.status, 200);
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  const logoutTicket = (await (await request(fixture, '/api/ws-token', {
    method: 'POST', cookie: secondCookie })).json()).token;
  const logoutSocket = await openTerminalWebSocket(fixture, terminal.id, logoutTicket, secondCookie);
  const closedOnLogout = new Promise((resolve) => logoutSocket.once('close', resolve));
  const logout = await request(fixture, '/api/auth/logout', { method: 'POST', cookie: secondCookie });
  assert.equal(logout.status, 204);
  await Promise.race([closedOnLogout, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('WS survived logout')), 2000))]);
  assert.equal((await request(fixture, '/api/settings', { cookie: secondCookie })).status, 401);
});

test('failed logins are rate limited and cannot be reset with spoofed forwarding headers', async (t) => {
  const fixture = await startServer({ authEnabled: true, authUser: 'owner',
    authPasswordHash: await hashPassword('correct-password-12') });
  t.after(() => stopServer(fixture));
  for (let n = 0; n < 5; n++) {
    const response = await fetch(fixture.origin + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: fixture.origin, 'X-DeckIDE-CSRF': '1', 'Content-Type': 'application/json',
        'X-Forwarded-For': '192.0.2.' + n },
      body: JSON.stringify({ username: 'owner', password: 'wrong-' + n }),
    });
    assert.equal(response.status, 401);
  }
  const blocked = await request(fixture, '/api/auth/login', { method: 'POST',
    body: { username: 'owner', password: 'correct-password-12' } });
  assert.equal(blocked.status, 429);
});

test('an idle live WebSocket closes at the session expiry deadline', async (t) => {
  const fixture = await startServer({ authEnabled: true, authUser: 'owner',
    authPasswordHash: await hashPassword('correct-password-12') }, { ttlMs: 1500 });
  t.after(() => stopServer(fixture));
  const login = await request(fixture, '/api/auth/login', { method: 'POST',
    body: { username: 'owner', password: 'correct-password-12' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const workspacePath = path.join(fixture.dir, 'workspace');
  await mkdir(workspacePath);
  const workspace = await (await request(fixture, '/api/workspaces', { method: 'POST', cookie,
    body: { path: workspacePath } })).json();
  const deck = await (await request(fixture, '/api/decks', { method: 'POST', cookie,
    body: { workspaceId: workspace.id } })).json();
  const terminal = await (await request(fixture, '/api/terminals', { method: 'POST', cookie,
    body: { deckId: deck.id, command: 'sleep 60' } })).json();
  assert.ok(terminal.id);
  const ticket = (await (await request(fixture, '/api/ws-token', { method: 'POST', cookie })).json()).token;
  const socket = await openTerminalWebSocket(fixture, terminal.id, ticket, cookie);
  await Promise.race([
    new Promise((resolve) => socket.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('WS survived expiry')), 3000)),
  ]);
  assert.equal((await request(fixture, '/api/settings', { cookie })).status, 401);
});

test('enabling auth closes existing anonymous WebSockets immediately', async (t) => {
  const fixture = await startServer({ authEnabled: false });
  t.after(() => stopServer(fixture));
  const workspacePath = path.join(fixture.dir, 'workspace');
  await mkdir(workspacePath);
  const workspace = await (await request(fixture, '/api/workspaces', { method: 'POST',
    body: { path: workspacePath } })).json();
  const deck = await (await request(fixture, '/api/decks', { method: 'POST',
    body: { workspaceId: workspace.id } })).json();
  const terminal = await (await request(fixture, '/api/terminals', { method: 'POST',
    body: { deckId: deck.id, command: 'sleep 60' } })).json();
  assert.ok(terminal.id);
  const socket = await openTerminalWebSocket(fixture, terminal.id, '', '');
  const closed = new Promise((resolve) => socket.once('close', resolve));
  const enabled = await request(fixture, '/api/settings', { method: 'POST',
    body: { authEnabled: true, authUser: 'owner', authPassword: 'correct-password-12' } });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).sessionRevoked, true);
  await Promise.race([closed, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('anonymous WS survived auth enable')), 2000))]);
  assert.equal((await request(fixture, '/api/settings')).status, 401);
});

test('weak or incomplete environment credentials fail before binding', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-env-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = await freePort();
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ authEnabled: false, port }));
  for (const credentials of [
    { DECKIDE_AUTH_USER: 'owner', DECKIDE_AUTH_PASSWORD: 'short' },
    { DECKIDE_AUTH_USER: '  ', DECKIDE_AUTH_PASSWORD: 'long-password-123' },
    { DECKIDE_AUTH_USER: 'x'.repeat(129), DECKIDE_AUTH_PASSWORD: 'long-password-123' },
    { DECKIDE_AUTH_USER: 'owner' },
  ]) {
    const env = { ...process.env, DECKIDE_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1',
      AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false', ...credentials };
    delete env.BASIC_AUTH_USER;
    delete env.BASIC_AUTH_PASSWORD;
    if (!('DECKIDE_AUTH_PASSWORD' in credentials)) delete env.DECKIDE_AUTH_PASSWORD;
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.notEqual(code, 0);
    assert.match(stderr, /CRITICAL: auth environment credentials/);
    await assert.rejects(fetch('http://127.0.0.1:' + port + '/health'));
  }
});
