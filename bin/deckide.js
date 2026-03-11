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

function isServerRunning() {
  const port = getPort();
  try {
    execSync(`curl -sf -o /dev/null http://localhost:${port}/health`, {
      timeout: 2000, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
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

  deckide config                 Show all settings
  deckide config set <key> <val> Set a config value
  deckide config get <key>       Get a config value
  deckide config reset           Reset all settings

  deckide auth on [user] [pass]  Enable basic auth
  deckide auth off               Disable basic auth
  deckide auth status            Show auth status

Options (for start):
  -p, --port <port>              Port (default: 8787)
  --host <host>                  Host (default: 0.0.0.0)
  --no-open                      Don't open browser
  --fg                           Run in foreground

Config keys:
  port, host, cors, maxFileSize, trustProxy
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

  if (isServerRunning()) {
    console.log(`  server: \x1b[32mrunning\x1b[0m → http://localhost:${port}`);
  } else {
    console.log('  server: \x1b[31mstopped\x1b[0m');
  }

  // Check PID file
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      process.kill(pid, 0); // Check if process exists
      console.log(`  pid:    ${pid}`);
    } catch {
      // stale pid file
    }
  }

  const daemonInfoPath = path.join(dataDir, 'pty-daemon.json');
  if (fs.existsSync(daemonInfoPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonInfoPath, 'utf-8'));
      console.log(`  pty:    pid ${info.pid}, port ${info.port}`);
    } catch {}
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
  if (!isServerRunning()) {
    console.log('Server is not running.');
    process.exit(0);
  }
  const port = getPort();
  try {
    execSync(`curl -sf -X POST http://localhost:${port}/api/shutdown -H "Content-Type: application/json" -d '{"terminateDaemon":true}'`, {
      timeout: 5000, stdio: 'ignore',
    });
    // Clean up pid file
    try { fs.unlinkSync(pidFile); } catch {}
    console.log('Server stopped.');
  } catch {
    console.error('Failed to stop server.');
  }
  process.exit(0);
}

// ── deckide restart ──
if (command === 'restart') {
  if (isServerRunning()) {
    const port = getPort();
    try {
      execSync(`curl -sf -X POST http://localhost:${port}/api/shutdown -H "Content-Type: application/json" -d '{"terminateDaemon":true}'`, {
        timeout: 5000, stdio: 'ignore',
      });
      try { fs.unlinkSync(pidFile); } catch {}
      console.log('Server stopped.');
    } catch {}
    // Wait a moment for port to free
    await new Promise(r => setTimeout(r, 1000));
  }
  // Re-exec as start (background)
  const restartArgs = ['start', ...args.slice(1)];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...restartArgs], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code));
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

// Check if already running
if (isServerRunning()) {
  console.log(`Server is already running on http://localhost:${port}`);
  process.exit(0);
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
