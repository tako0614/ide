import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import { parseExec, listDesktopApps } from '../dist/desktop/apps.js';
import { SharedDesktop } from '../dist/desktop/shared-desktop.js';
import { DesktopComputer } from '../dist/computer/desktop.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const haveX = ['Xvfb', 'xauth', 'xdpyinfo', 'xprop', 'openbox', 'x11vnc', 'xdotool']
  .every((bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0);

// Never the live :99 — pick an unused display number for every test.
let nextDisplay = 150 + (process.pid % 50);
function freeDisplay() {
  for (let n = nextDisplay; n < 400; n++) {
    if (!fs.existsSync(`/tmp/.X${n}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${n}`)) {
      nextDisplay = n + 1;
      return `:${n}`;
    }
  }
  throw new Error('no free X display');
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lockPid = (display) => Number(fs.readFileSync(`/tmp/.X${display.slice(1)}-lock`, 'utf8').trim());
const until = async (predicate, label, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout: ${label}`);
};
const xenv = (env) => ({ ...process.env, DISPLAY: env.display, ...(env.xauthority ? { XAUTHORITY: env.xauthority } : {}) });

test('Exec lines are split per the desktop entry spec', () => {
  assert.deepEqual(parseExec('grok-bot %U'), ['grok-bot']);
  assert.deepEqual(parseExec('"/opt/Grok Bot/grok-bot" --flag=%u'), ['/opt/Grok Bot/grok-bot', '--flag=']);
  assert.deepEqual(parseExec('env A=1 app "say \\\\"hi\\\\"" 100%%'), ['env', 'A=1', 'app', 'say "hi"', '100%']);
  assert.deepEqual(parseExec('sh -c "echo \\\\$HOME"'), ['sh', '-c', 'echo $HOME']);
});

test('apps come from .desktop files; Electron apps are flagged for --no-sandbox', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-apps-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'Fake Bot');
  await mkdir(appDir);
  await writeFile(path.join(appDir, 'fake-bot'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(appDir, 'fake-bot'), 0o755);
  await writeFile(path.join(appDir, 'chrome-sandbox'), '');
  const applications = path.join(dir, 'applications');
  await mkdir(applications);
  await writeFile(path.join(applications, 'fake-bot.desktop'),
    `[Desktop Entry]\nType=Application\nName=Fake Bot\nName[ja]=フェイク\nExec="${appDir}/fake-bot" %U\n`);
  await writeFile(path.join(applications, 'hidden.desktop'), '[Desktop Entry]\nType=Application\nName=Hidden\nExec=sh\nNoDisplay=true\n');
  await writeFile(path.join(applications, 'tui.desktop'), '[Desktop Entry]\nType=Application\nName=TUI\nExec=sh\nTerminal=true\n');
  await writeFile(path.join(applications, 'missing.desktop'), '[Desktop Entry]\nType=Application\nName=Missing\nExec=/nonexistent/app\n');
  const apps = (await listDesktopApps([applications])).filter((app) => ['fake-bot', 'hidden', 'tui', 'missing'].includes(app.id));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].chromium, true);
  assert.deepEqual(apps[0].exec, [`${appDir}/fake-bot`]);
  assert.match(apps[0].name, /フェイク|Fake Bot/);
});

test('shared desktop: starts detached, survives a Deck IDE restart, serves VNC, launches apps, stops', { skip: !haveX }, async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'deckide-desktop-'));
  const display = freeDisplay();
  const first = new SharedDesktop({ display, width: 1024, height: 768, stateDir });
  t.after(async () => {
    try { await new SharedDesktop({ display, width: 1024, height: 768, stateDir }).stop(); } catch { /* best effort */ }
    await rm(stateDir, { recursive: true, force: true });
  });

  const env = await first.ensure();
  const status = await first.status();
  assert.deepEqual([status.running, status.owned, status.width, status.height], [true, true, 1024, 768]);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(env.xauthority).mode & 0o777, 0o600);
  const xvfbPid = lockPid(display);
  // A window manager is running, so app windows can be moved and focused.
  await until(() => /window id/.test(spawnSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { env: xenv(env), encoding: 'utf8' }).stdout), 'openbox');

  // VNC: loopback only, password required.
  const { port, password } = await first.vnc();
  assert.equal(password.length, 8);
  const banner = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('data', (chunk) => { socket.destroy(); resolve(chunk.toString()); });
    socket.once('error', reject);
  });
  assert.equal(banner, 'RFB 003.008\n');

  // An app launched on the desktop runs as an X client of it.
  const launched = await first.launch({ command: 'exec xprop -spy -root _NET_ACTIVE_WINDOW' });
  await until(() => alive(launched.pid), 'app running');
  const appEnv = fs.readFileSync(`/proc/${launched.pid}/environ`, 'utf8').split('\0');
  assert.ok(appEnv.includes(`DISPLAY=${display}`));
  assert.ok(!appEnv.some((entry) => entry.startsWith('DECKIDE_')));

  // "Restart": the old instance goes away without stopping the desktop.
  first.shutdown();
  const second = new SharedDesktop({ display, width: 1024, height: 768, stateDir });
  await second.ensure();
  assert.equal(lockPid(display), xvfbPid);
  assert.equal((await second.status()).owned, true);
  assert.ok(alive(launched.pid), 'apps survive a restart');

  await second.stop();
  await until(() => !alive(xvfbPid), 'Xvfb stopped');
  await until(() => !alive(launched.pid), 'apps end with the display');
  assert.equal((await second.status()).running, false);
});

test('attaching to a display someone else runs never stops it', { skip: !haveX }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-foreign-'));
  const display = freeDisplay();
  const authority = path.join(dir, 'auth');
  await writeFile(authority, '', { mode: 0o600 });
  spawnSync('xauth', ['-f', authority, 'add', display, '.', 'ab'.repeat(16)]);
  const foreign = spawn('Xvfb', [display, '-screen', '0', '800x600x24', '-nolisten', 'tcp', '-auth', authority], { stdio: 'ignore' });
  t.after(async () => {
    foreign.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  });
  await until(() => fs.existsSync(`/tmp/.X${display.slice(1)}-lock`), 'foreign Xvfb');
  const desktop = new SharedDesktop({ display, width: 1600, height: 900, stateDir: path.join(dir, 'state') });
  const env = await desktop.ensure();
  assert.equal(env.xauthority, authority);
  const status = await desktop.status();
  assert.deepEqual([status.owned, status.width, status.height], [false, 800, 600]);

  // The computer tools attach to the same display and map coordinates to it.
  const computer = new DesktopComputer(undefined, desktop);
  assert.equal((await computer.prepare()).running, true);
  const shot = await computer.screenshot('actor');
  assert.equal(shot.width, 960);
  assert.equal(computer.runtime.native.width, 800);
  await computer.input('actor', { observationId: shot.observationId, action: 'click', x: 959, y: 539 });
  const location = spawnSync('xdotool', ['getmouselocation'], { env: xenv(env), encoding: 'utf8' }).stdout;
  assert.match(location, /x:799 y:599/);
  await computer.stop();

  await desktop.stop();
  desktop.shutdown();
  assert.ok(alive(foreign.pid), 'a foreign X server is left running');
});

test('the browser VNC viewer reaches the desktop through the authenticated WebSocket bridge', { skip: !haveX }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'deckide-desktop-server-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ port }));
  const display = freeDisplay();
  const env = { ...process.env, DECKIDE_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
    AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false', DECKIDE_DESKTOP_DISPLAY: display,
    DECKIDE_DESKTOP_SIZE: '1024x640' };
  const child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}`;
  let token = null;
  const api = async (method, url, body) => {
    const response = await fetch(origin + url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    try { await api('POST', '/api/desktop/stop'); } catch { /* server gone */ }
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await until(async () => {
    try { return (await fetch(origin + '/health')).ok; } catch { return false; }
  }, 'server up', 10000);
  token = JSON.parse(await readFile(path.join(dataDir, 'cli.json'), 'utf8')).token;

  const started = await api('POST', '/api/desktop/start');
  assert.equal(started.status, 200);
  assert.deepEqual([started.body.running, started.body.width, started.body.display], [true, 1024, display]);
  const credentials = await api('POST', '/api/desktop/vnc');
  assert.equal(credentials.body.password.length, 8);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/desktop/vnc`, { headers: { Authorization: `Bearer ${token}` } });
  const banner = await new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()));
    socket.once('error', reject);
    socket.once('close', (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
  });
  assert.equal(banner, 'RFB 003.008\n');
  socket.close();

  // Unauthenticated handshakes are refused before reaching VNC.
  const refused = await new Promise((resolve) => {
    const anonymous = new WebSocket(`ws://127.0.0.1:${port}/api/desktop/vnc`, { headers: { Origin: 'http://evil.example' } });
    anonymous.once('close', (code) => resolve(code));
    anonymous.once('error', () => resolve('error'));
  });
  assert.notEqual(refused, undefined);
  assert.ok(refused === 1008 || refused === 'error', `refused with ${refused}`);
});
