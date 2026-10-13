import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Never inherit a production DeckIDE's broker/runtime from the calling shell.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ['DECKIDE_TMUX_BROKER_REQUIRED', 'DECKIDE_TMUX_BROKER_SOCKET', 'DECKIDE_ALLOWED_HOSTS',
    'DECKIDE_SESSION_SOCKET', 'DECKIDE_TERMINAL_ID', 'DECKIDE_DECK_ID', 'NODE_ENV']) delete env[key];
  return env;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('the shared desktop: status, typed-text validation and a two-way VNC relay', async (t) => {
  const dataDir = mkdtempSync('/tmp/dkd-');
  const runtimeDir = mkdtempSync('/tmp/dkt-');
  const vncDir = mkdtempSync('/tmp/dkv-');
  const socketPath = path.join(vncDir, 'vnc.sock');
  // Stand-in for Xvnc's Unix socket: greets like an RFB server, then echoes.
  const vnc = net.createServer((client) => {
    client.write('RFB 003.008\n');
    client.on('data', (data) => client.write(data));
  });
  await new Promise((resolve) => vnc.listen(socketPath, resolve));
  const port = await freePort();
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port }));
  const env = cleanEnv({ DECKIDE_DATA_DIR: dataDir, DECKIDE_TMUX_RUNTIME_DIR: runtimeDir, PORT: String(port),
    HOST: '127.0.0.1', AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false',
    DECKIDE_DESKTOP_SOCKET: socketPath, DECKIDE_DESKTOP_DISPLAY: ':9999',
    DECKIDE_DESKTOP_UNIT: 'deckide-desktop-test-absent.service' });
  const server = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await new Promise((resolve) => vnc.close(resolve));
    for (const dir of [dataDir, runtimeDir, vncDir]) rmSync(dir, { recursive: true, force: true });
  });
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(origin + '/health')).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const status = async () => (await fetch(origin + '/api/desktop')).json();

  // The VNC socket exists but no X server answers on the display yet.
  assert.deepEqual(await status(), { display: ':9999', width: null, height: null, installed: true,
    running: false, message: 'The desktop is starting or not responding.' });

  const type = (body) => fetch(origin + '/api/desktop/type', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Deckide-Csrf': '1' },
  });
  assert.equal((await type({})).status, 400);
  assert.equal((await type({ text: 'x'.repeat(4001) })).status, 400);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/desktop/vnc`, { headers: { Origin: origin } });
  const received = [];
  ws.on('message', (data) => received.push(Buffer.from(data).toString()));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const until = async (predicate, label) => {
    for (let n = 0; n < 100 && !predicate(); n++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(predicate(), label);
  };
  await until(() => received.join('') === 'RFB 003.008\n', 'server greeting is relayed');
  ws.send(Buffer.from('RFB 003.008\n'));
  await until(() => received.join('') === 'RFB 003.008\nRFB 003.008\n', 'client bytes reach the VNC server');
  const closed = new Promise((resolve) => ws.once('close', resolve));
  ws.close();
  await closed;

  // Without the socket or the systemd unit, the UI is told how to install it.
  unlinkSync(socketPath);
  const missing = await status();
  assert.equal(missing.installed, false);
  assert.equal(missing.running, false);
  assert.match(missing.message, /ops\/desktop\/install\.sh/);
});
