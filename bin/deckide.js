#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(os.homedir(), '.deckide');
const settingsFile = path.join(dataDir, 'settings.json');
const pidFile = path.join(dataDir, 'server.pid');
const logFile = path.join(dataDir, 'server.log');

// ─── Settings helpers ───────────────────────────────────────────

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

function getPort() {
  return loadSettings().port || 8787;
}

function isServerRunningOnPort(port) {
  try {
    execSync(`curl -sf -o /dev/null http://localhost:${port}/health`, {
      timeout: 2000, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function isServerRunning() {
  return isServerRunningOnPort(getPort());
}

/** Get PID from pid file, or null if stale/missing */
function getRunningPid() {
  if (!fs.existsSync(pidFile)) return null;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    process.kill(pid, 0); // throws if not running
    return pid;
  } catch {
    try { fs.unlinkSync(pidFile); } catch {}
    return null;
  }
}

/** Wait for a process to exit, returns true if it exited */
function waitForExit(pid, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(pid, 0); } catch { return true; }
    execSync('sleep 0.2', { stdio: 'ignore' });
  }
  return false;
}

/** Build curl auth flags from settings */
function getAuthFlags() {
  const s = loadSettings();
  if (s.basicAuthEnabled && s.basicAuthUser && s.basicAuthPassword) {
    return `-u '${s.basicAuthUser}:${s.basicAuthPassword}'`;
  }
  return '';
}

/** Try HTTP shutdown on a specific port */
function tryHttpShutdown(port) {
  const auth = getAuthFlags();
  try {
    execSync(`curl -sf ${auth} -X POST http://localhost:${port}/api/shutdown -H "Content-Type: application/json" -d '{}'`, {
      timeout: 5000, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Stop server: try HTTP shutdown, SIGTERM, then SIGKILL as last resort */
function stopServer() {
  const port = getPort();
  const pid = getRunningPid();

  // Try HTTP shutdown on configured port
  if (isServerRunningOnPort(port) && tryHttpShutdown(port)) {
    if (pid) waitForExit(pid, 5000);
    try { fs.unlinkSync(pidFile); } catch {}
    return true;
  }

  // Try default port 8787 if different
  if (port !== 8787 && isServerRunningOnPort(8787) && tryHttpShutdown(8787)) {
    if (pid) waitForExit(pid, 5000);
    try { fs.unlinkSync(pidFile); } catch {}
    return true;
  }

  // Fall back to killing by PID
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      if (waitForExit(pid, 5000)) {
        try { fs.unlinkSync(pidFile); } catch {}
        return true;
      }
      // SIGKILL as last resort
      process.kill(pid, 'SIGKILL');
      waitForExit(pid, 2000);
      try { fs.unlinkSync(pidFile); } catch {}
      return true;
    } catch {
      // Process already gone
      try { fs.unlinkSync(pidFile); } catch {}
      return true;
    }
  }

  // No PID but clean up stale pid file
  try { fs.unlinkSync(pidFile); } catch {}
  return false;
}

// ─── CLI ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

// ── deckide version ──
if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  console.log(pkg.version);
  process.exit(0);
}

// ── deckide help ──
if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`Deck IDE - Browser-based IDE

Usage:
  deckide [start]                Start server (background)
  deckide start --fg             Start server (foreground)
  deckide stop                   Stop server
  deckide restart                Restart server
  deckide status                 Show server status
  deckide logs                   Show server logs

  deckide port                   Show current port
  deckide port <number>          Change port (auto-restarts)

  deckide auth on [user] [pass]  Enable basic auth
  deckide auth off               Disable basic auth
  deckide auth status            Show auth status

  deckide config                 Show all settings
  deckide config set <key> <val> Set a config value
  deckide config get <key>       Get a config value
  deckide config reset           Reset all settings

Options (for start):
  -p, --port <port>              Port (default: 8787)
  --host <host>                  Host (default: 0.0.0.0)
  --no-open                      Don't open browser
  --fg                           Run in foreground
`);
  process.exit(0);
}

// ── deckide config ──
if (command === 'config') {
  const sub = args[1];
  const settings = loadSettings();

  if (!sub || sub === 'list') {
    if (Object.keys(settings).length === 0) {
      console.log('No custom settings. Using defaults.');
      console.log('  port: 8787');
      console.log('  host: 0.0.0.0');
    } else {
      for (const [key, value] of Object.entries(settings)) {
        if (key === 'basicAuthPassword' && value) {
          console.log(`  ${key}: ********`);
        } else {
          console.log(`  ${key}: ${value}`);
        }
      }
    }
    process.exit(0);
  }

  if (sub === 'get') {
    const key = args[2];
    if (!key) { console.error('Usage: deckide config get <key>'); process.exit(1); }
    const val = settings[key];
    if (val === undefined) console.log(`${key}: (not set)`);
    else if (key === 'basicAuthPassword') console.log(`${key}: ********`);
    else console.log(`${key}: ${val}`);
    process.exit(0);
  }

  if (sub === 'set') {
    const key = args[2];
    let value = args[3];
    if (!key || value === undefined) { console.error('Usage: deckide config set <key> <value>'); process.exit(1); }
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);
    settings[key] = value;
    saveSettings(settings);
    console.log(`${key} = ${key === 'basicAuthPassword' ? '********' : value}`);
    if (isServerRunning() || getRunningPid()) console.log('Run "deckide restart" to apply.');
    process.exit(0);
  }

  if (sub === 'reset') {
    saveSettings({});
    console.log('Settings reset to defaults.');
    process.exit(0);
  }

  console.error(`Unknown config command: ${sub}`);
  process.exit(1);
}

// ── deckide port ──
if (command === 'port') {
  const newPort = args[1];
  const settings = loadSettings();
  const currentPort = settings.port || 8787;

  // Show current port
  if (!newPort) {
    console.log(`port: ${currentPort}`);
    process.exit(0);
  }

  const parsed = parseInt(newPort, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    console.error('Error: port must be 1-65535');
    process.exit(1);
  }

  if (parsed === currentPort) {
    console.log(`Already using port ${parsed}`);
    process.exit(0);
  }

  // Save new port
  settings.port = parsed;
  saveSettings(settings);
  console.log(`port: ${currentPort} → ${parsed}`);

  // Auto-restart if server is running
  const wasRunning = isServerRunningOnPort(currentPort) || getRunningPid();
  if (wasRunning) {
    stopServer();
    // Re-exec as start (background, no open)
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', '--no-open'], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    await new Promise(() => {});
  } else {
    process.exit(0);
  }
}

// ── deckide auth ──
if (command === 'auth') {
  const sub = args[1];
  const settings = loadSettings();

  if (!sub || sub === 'status') {
    if (settings.basicAuthEnabled) {
      console.log('Basic auth: enabled');
      console.log(`  user: ${settings.basicAuthUser || '(not set)'}`);
      console.log(`  password: ${settings.basicAuthPassword ? '********' : '(not set)'}`);
    } else {
      console.log('Basic auth: disabled');
    }
    if (!sub) {
      console.log('\nUsage:');
      console.log('  deckide auth on [user] [password]');
      console.log('  deckide auth off');
    }
    process.exit(0);
  }

  if (sub === 'off') {
    settings.basicAuthEnabled = false;
    delete settings.basicAuthUser;
    delete settings.basicAuthPassword;
    saveSettings(settings);
    console.log('Basic auth disabled.');
    if (isServerRunning()) console.log('Run "deckide restart" to apply.');
    process.exit(0);
  }

  if (sub === 'on') {
    const user = args[2];
    const password = args[3];
    const genUser = user || 'admin';
    const genPassword = password || crypto.randomBytes(16).toString('base64url');

    if (password && password.length < 8) {
      console.error('Error: password must be at least 8 characters.');
      process.exit(1);
    }

    settings.basicAuthEnabled = true;
    settings.basicAuthUser = genUser;
    settings.basicAuthPassword = genPassword;
    saveSettings(settings);
    console.log('Basic auth enabled.');
    console.log(`  user: ${genUser}`);
    if (!password) console.log(`  password: ${genPassword}`);
    if (isServerRunning()) console.log('Run "deckide restart" to apply.');
    process.exit(0);
  }

  console.error(`Unknown auth command: ${sub}`);
  process.exit(1);
}

// ── deckide status ──
if (command === 'status') {
  const settings = loadSettings();
  const port = settings.port || 8787;

  console.log('Deck IDE');
  console.log(`  data:   ${dataDir}`);
  console.log(`  port:   ${port}`);
  console.log(`  auth:   ${settings.basicAuthEnabled ? 'enabled' : 'disabled'}`);

  const pid = getRunningPid();
  if (isServerRunning()) {
    console.log(`  server: \x1b[32mrunning\x1b[0m → http://localhost:${port}`);
    if (pid) console.log(`  pid:    ${pid}`);
  } else if (pid) {
    console.log(`  server: \x1b[33mprocess alive (pid ${pid}) but not responding on port ${port}\x1b[0m`);
  } else {
    console.log('  server: \x1b[31mstopped\x1b[0m');
  }

  process.exit(0);
}

// ── deckide logs ──
if (command === 'logs') {
  if (!fs.existsSync(logFile)) {
    console.log('No logs found.');
    process.exit(0);
  }
  const follow = args.includes('-f') || args.includes('--follow');
  if (follow) {
    const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
    tail.on('exit', () => process.exit(0));
  } else {
    const lines = fs.readFileSync(logFile, 'utf-8');
    // Show last 50 lines
    const arr = lines.split('\n');
    console.log(arr.slice(-51).join('\n'));
  }
  if (!args.includes('-f') && !args.includes('--follow')) process.exit(0);
}

// ── deckide stop ──
if (command === 'stop') {
  const pid = getRunningPid();
  if (!isServerRunning() && !pid) {
    console.log('Server is not running.');
    process.exit(0);
  }
  if (stopServer()) {
    console.log('Server stopped.');
  } else {
    console.error('Failed to stop server.');
  }
  process.exit(0);
}

// ── deckide restart ──
if (command === 'restart') {
  if (isServerRunning() || getRunningPid()) {
    if (stopServer()) {
      console.log('Server stopped.');
    }
  }
  // Re-exec as start (background)
  const restartArgs = ['start', ...args.slice(1)];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...restartArgs], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  // Prevent fall-through to unknown command check
  await new Promise(() => {});
}

// ── deckide / deckide start ──

// Parse start options
const isStart = command === 'start' || !command;
if (!isStart) {
  console.error(`Unknown command: ${command}`);
  console.error('Run "deckide help" for usage.');
  process.exit(1);
}

const startArgs = command === 'start' ? args.slice(1) : args;
const startOptions = { port: null, host: null, open: true, fg: false };

for (let i = 0; i < startArgs.length; i++) {
  const arg = startArgs[i];
  if ((arg === '--port' || arg === '-p') && startArgs[i + 1]) {
    startOptions.port = parseInt(startArgs[i + 1], 10);
    i++;
  } else if (arg === '--host' && startArgs[i + 1]) {
    startOptions.host = startArgs[i + 1];
    i++;
  } else if (arg === '--no-open') {
    startOptions.open = false;
  } else if (arg === '--fg') {
    startOptions.fg = true;
  }
}

const settings = loadSettings();
const port = startOptions.port || settings.port || 8787;
const host = startOptions.host || settings.host || '0.0.0.0';

// Check if already running on the target port
if (isServerRunningOnPort(port)) {
  console.log(`Server is already running on http://localhost:${port}`);
  process.exit(0);
}

// Kill old server if running on a different port (only in background mode,
// FG mode is always spawned by background mode which already handles this)
if (!startOptions.fg) {
  const oldPid = getRunningPid();
  if (oldPid) {
    console.log('Stopping old server...');
    stopServer();
  }
}

// ── Background mode (default) ──
if (!startOptions.fg) {
  fs.mkdirSync(dataDir, { recursive: true });

  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');

  const fgArgs = ['start', '--fg', '--no-open', '-p', String(port), '--host', host];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...fgArgs], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, DECKIDE_DATA_DIR: dataDir },
  });

  // Write PID file
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();

  // Wait for server to be ready
  const startTime = Date.now();
  let ready = false;
  while (Date.now() - startTime < 8000) {
    await new Promise(r => setTimeout(r, 300));
    if (isServerRunning()) { ready = true; break; }
  }

  if (ready) {
    const url = `http://localhost:${port}`;
    console.log(`Deck IDE running at ${url} (pid: ${child.pid})`);

    if (startOptions.open) {
      try {
        if (process.platform === 'darwin') execSync(`open ${url}`);
        else if (process.platform === 'win32') execSync(`start ${url}`);
        else execSync(`xdg-open ${url}`);
      } catch {}
    }
  } else {
    console.error('Server failed to start. Check logs: deckide logs');
  }

  process.exit(0);
}

// ── Foreground mode (--fg) ──
process.env.DECKIDE_DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.HOST = host;

const { createServer } = await import(path.join(__dirname, '..', 'dist', 'server.js'));
await createServer();

if (startOptions.open) {
  const url = `http://localhost:${port}`;
  setTimeout(() => {
    try {
      if (process.platform === 'darwin') execSync(`open ${url}`);
      else if (process.platform === 'win32') execSync(`start ${url}`);
      else execSync(`xdg-open ${url}`);
    } catch {}
  }, 500);
}
