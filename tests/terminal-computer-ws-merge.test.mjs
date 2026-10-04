import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

test('private desktop tickets stay on their route while tmux restore callback stays fourth', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-ws-computer-'));
  const saved = new Map(['DECKIDE_DATA_DIR', 'DECKIDE_TMUX_RUNTIME_DIR', 'PORT', 'HOST',
    'CODEX_HOME', 'DECKIDE_MCP_ACCESS_TOKEN', 'DECKIDE_COMPUTER_SESSION_CAPABILITY',
    'DECKIDE_AUTH_USER', 'DECKIDE_AUTH_PASSWORD', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD']
    .map((key) => [key, process.env[key]]));
  let terminalAdapter;
  t.after(async () => {
    if (terminalAdapter) for (const meta of terminalAdapter.list()) terminalAdapter.close(meta);
    await rm(dir, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  process.env.DECKIDE_DATA_DIR = dir;
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  for (const key of ['DECKIDE_AUTH_USER', 'DECKIDE_AUTH_PASSWORD',
    'BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD']) delete process.env[key];

  const { hashPassword } = await import('../dist/auth/password.js');
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ authEnabled: true,
    authUser: 'owner', authPasswordHash: await hashPassword('test-password-only-2026') }));
  const [{ initializeCredentials }, auth, { ComputerStreamTickets },
    { setupWebSocketServer, getConnectionStats }] = await Promise.all([
    import('../dist/auth/credentials.js'),
    import('../dist/middleware/auth.js'),
    import('../dist/computer/stream-tickets.js'),
    import('../dist/websocket.js'),
  ]);
  await initializeCredentials();
  const app = new Hono();
  app.post('/api/auth/login', auth.login);
  const login = await app.request(origin + '/api/auth/login', {
    method: 'POST', headers: { Host: `127.0.0.1:${port}`, Origin: origin, 'X-DeckIDE-CSRF': '1',
      'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'test-password-only-2026' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const sessionKey = crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  const tickets = new ComputerStreamTickets();
  const attached = [];
  const computer = {
    async attachVncSocket(actor, epoch) {
      const upstream = new PassThrough();
      const accepted = [];
      upstream.write = (message) => { accepted.push(Buffer.from(message)); return true; };
      const close = () => upstream.destroy();
      attached.push({ actor, epoch, upstream, accepted });
      return { socket: upstream, gate: { acceptClient: (raw) => [raw] }, close };
    },
  };
  const restoreCalls = [];
  const wss = setupWebSocketServer(server, new Map(), undefined,
    async (id) => { restoreCalls.push(id); }, { computer, tickets });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    for (const socket of wss.clients) socket.terminate();
    server.closeAllConnections();
    wss.close();
    server.close();
  });
  const connect = (route, token, epoch) => {
    const params = new URLSearchParams({ token });
    if (epoch !== undefined) params.set('epoch', String(epoch));
    const socket = new WebSocket(`${origin.replace('http', 'ws')}${route}?${params}`, {
      headers: { Cookie: cookie, Origin: origin },
    });
    sockets.push(socket);
    return socket;
  };
  const closeReason = async (socket) => {
    const [code, reason] = await once(socket, 'close');
    return { code, reason: reason.toString() };
  };

  const wrongRoute = connect('/api/terminals/missing', tickets.issue(sessionKey, 7));
  assert.deepEqual(await closeReason(wrongRoute),
    { code: 1008, reason: 'Desktop stream ticket has a different route' });
  assert.deepEqual(restoreCalls, [], 'desktop ticket cannot enter tmux restore');

  const ordinary = connect('/api/terminals/missing', auth.generateWsToken(sessionKey));
  assert.deepEqual(await closeReason(ordinary), { code: 1000, reason: 'Terminal not found' });
  assert.deepEqual(restoreCalls, ['missing'], 'fourth argument remains the tmux restore callback');

  const wrongEpoch = connect('/api/computer/vnc/ws', tickets.issue(sessionKey, 7), 8);
  assert.deepEqual(await closeReason(wrongEpoch),
    { code: 1008, reason: 'Invalid desktop stream ticket' });
  const ticket = tickets.issue(sessionKey, 7);
  const socket = connect('/api/computer/vnc/ws', ticket, 7);
  await once(socket, 'open');
  for (let attempt = 0; attached.length === 0 && attempt < 40; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(attached.length, 1);
  assert.deepEqual([attached[0].actor, attached[0].epoch], [`browser:${sessionKey}`, 7]);
  const output = once(socket, 'message');
  attached[0].upstream.push(Buffer.from([0, 1, 2, 255]));
  const [chunk, binary] = await output;
  assert.equal(binary, true);
  assert.deepEqual(Buffer.from(chunk), Buffer.from([0, 1, 2, 255]));
  socket.send(Buffer.from([3, 4, 5]));
  for (let attempt = 0; attached[0].accepted.length === 0 && attempt < 40; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(attached[0].accepted, [Buffer.from([3, 4, 5])]);
  socket.close();
  await once(socket, 'close');
  assert.equal(attached[0].upstream.destroyed, true);
  const replay = connect('/api/computer/vnc/ws', ticket, 7);
  assert.deepEqual(await closeReason(replay), { code: 1008, reason: 'Unauthorized' });
  assert.equal(attached.length, 1);
  assert.equal(getConnectionStats().reduce((sum, item) => sum + item.count, 0), 0);

  // Exercise the real tmux lifecycle with a host-session spy: a fresh shell
  // gets a scoped value, while a detached/restored shell retains its PID and
  // never receives a second capability.
  const { createTerminalRouter } = await import('../dist/routes/terminals.js');
  const { TmuxTerminalAdapter } = await import('../dist/terminal/tmuxAdapter.js');
  const root = path.join(dir, 'workspace');
  await mkdir(root);
  process.env.DECKIDE_TMUX_RUNTIME_DIR = path.join(dir, 'tmux');
  process.env.CODEX_HOME = path.join(dir, 'codex-home');
  process.env.DECKIDE_MCP_ACCESS_TOKEN = 'inherited-token-must-be-removed';
  process.env.DECKIDE_COMPUTER_SESSION_CAPABILITY = 'inherited-capability-must-be-removed';
  const workspace = { id: 'workspace', name: 'workspace', path: root, createdAt: '' };
  const deck = { id: 'deck', name: 'deck', root, workspaceId: workspace.id, createdAt: '' };
  const terminals = new Map();
  const issueCalls = [];
  const activationCalls = [];
  const revocations = [];
  const capability = 'host-session-test-capability';
  const hostSessions = {
    issueForTerminal(id, candidate, creator) {
      issueCalls.push({ id, candidate, creator });
      return capability;
    },
    activateTerminal(id, pid, session) {
      activationCalls.push({ id, pid, session });
      return true;
    },
    revokeTerminal(id) { revocations.push(id); },
  };
  const router = createTerminalRouter(new Map([[deck.id, deck]]), terminals,
    { hostSessions, workspaces: new Map([[workspace.id, workspace]]) });
  const terminalApp = new Hono();
  terminalApp.route('/api/terminals', router);
  const terminalRequest = (method, route, body) => terminalApp.request(origin + route, {
    method, headers: { Host: `127.0.0.1:${port}`, Origin: origin,
      'X-DeckIDE-CSRF': '1', Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  terminalAdapter = new TmuxTerminalAdapter({ runtimeDir: process.env.DECKIDE_TMUX_RUNTIME_DIR });
  const created = await terminalRequest('POST', '/api/terminals', { deckId: deck.id });
  assert.equal(created.status, 201, await created.clone().text());
  const first = await created.json();
  assert.equal(issueCalls.length, 1);
  assert.deepEqual(issueCalls[0].creator, { kind: 'browser', sessionKey });
  assert.deepEqual([activationCalls[0].id, activationCalls[0].pid], [first.id, first.pid]);
  const environment = await readFile(`/proc/${first.pid}/environ`);
  assert.ok(environment.includes(Buffer.from(`DECKIDE_COMPUTER_SESSION_CAPABILITY=${capability}\0`)));
  assert.ok(environment.includes(Buffer.from(`CODEX_HOME=${process.env.CODEX_HOME}\0`)));
  assert.ok(!environment.includes(Buffer.from('inherited-token-must-be-removed')));
  assert.ok(!environment.includes(Buffer.from('inherited-capability-must-be-removed')));

  terminals.get(first.id).detach();
  await router.restoreSessions();
  assert.equal(terminals.get(first.id).pid, first.pid, 'restore reattaches the same shell');
  assert.equal(issueCalls.length, 1, 'restore never issues a new host capability');
  assert.equal(activationCalls.length, 1, 'restore never replaces the pinned host session');
  const deleted = await terminalRequest('DELETE', `/api/terminals/${first.id}`);
  assert.equal(deleted.status, 204);
  assert.ok(revocations.includes(first.id), 'explicit terminal deletion revokes the host binding');

  const commandResponse = await terminalRequest('POST', '/api/terminals',
    { deckId: deck.id, command: 'sleep 20' });
  assert.equal(commandResponse.status, 201, await commandResponse.clone().text());
  const command = await commandResponse.json();
  assert.equal(issueCalls.length, 1, 'a command terminal cannot mint a host capability');
  const commandEnv = await readFile(`/proc/${command.pid}/environ`);
  assert.ok(!commandEnv.includes(Buffer.from('inherited-capability-must-be-removed')));
  assert.ok(!commandEnv.includes(Buffer.from('inherited-token-must-be-removed')));
  assert.equal((await terminalRequest('DELETE', `/api/terminals/${command.id}`)).status, 204);
});
