#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(os.homedir(), '.deckide');
const settingsFile = path.join(dataDir, 'settings.json');

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
  console.log(`
Deck IDE - Browser-based IDE

Usage:
  deckide                        Start the server
  deckide config                 Show all settings
  deckide config set <key> <val> Set a config value
  deckide config get <key>       Get a config value
  deckide config reset           Reset all settings
  deckide auth on                Enable basic auth (interactive)
  deckide auth off               Disable basic auth
  deckide auth status            Show auth status
  deckide status                 Show server status
  deckide stop                   Stop running server

Start options:
  -p, --port <port>              Port to listen on
  --host <host>                  Host to bind to
  --no-open                      Don't open browser

Config keys:
  port                           Server port (default: 8787)
  host                           Bind host (default: 0.0.0.0)
  cors                           CORS origin
  maxFileSize                    Max file size in bytes
  trustProxy                     Trust proxy headers (true/false)
`);
  process.exit(0);
}

// ── deckide config ──
if (command === 'config') {
  const sub = args[1];
  const settings = loadSettings();

  if (!sub || sub === 'list') {
    // Show all config
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
    if (!key) {
      console.error('Usage: deckide config get <key>');
      process.exit(1);
    }
    const val = settings[key];
    if (val === undefined) {
      console.log(`${key}: (not set)`);
    } else if (key === 'basicAuthPassword') {
      console.log(`${key}: ********`);
    } else {
      console.log(`${key}: ${val}`);
    }
    process.exit(0);
  }

  if (sub === 'set') {
    const key = args[2];
    let value = args[3];
    if (!key || value === undefined) {
      console.error('Usage: deckide config set <key> <value>');
      process.exit(1);
    }
    // Type coercion
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

  if (sub === 'status') {
    if (settings.basicAuthEnabled) {
      console.log('Basic auth: enabled');
      console.log(`  user: ${settings.basicAuthUser || '(not set)'}`);
      console.log(`  password: ${settings.basicAuthPassword ? '********' : '(not set)'}`);
    } else {
      console.log('Basic auth: disabled');
    }
    process.exit(0);
  }

  if (sub === 'off') {
    settings.basicAuthEnabled = false;
    delete settings.basicAuthUser;
    delete settings.basicAuthPassword;
    saveSettings(settings);
    console.log('Basic auth disabled.');
    process.exit(0);
  }

  if (sub === 'on') {
    const user = args[2];
    const password = args[3];

    if (!user || !password) {
      // Generate random password if not provided
      const genUser = user || 'admin';
      const genPassword = crypto.randomBytes(16).toString('base64url');
      settings.basicAuthEnabled = true;
      settings.basicAuthUser = genUser;
      settings.basicAuthPassword = genPassword;
      saveSettings(settings);
      console.log('Basic auth enabled.');
      console.log(`  user: ${genUser}`);
      console.log(`  password: ${genPassword}`);
      console.log('');
      console.log('Restart the server for changes to take effect.');
      process.exit(0);
    }

    if (password.length < 8) {
      console.error('Error: password must be at least 8 characters.');
      process.exit(1);
    }

    settings.basicAuthEnabled = true;
    settings.basicAuthUser = user;
    settings.basicAuthPassword = password;
    saveSettings(settings);
    console.log('Basic auth enabled.');
    console.log(`  user: ${user}`);
    console.log('Restart the server for changes to take effect.');
    process.exit(0);
  }

  if (!sub) {
    // Default to status
    const enabled = settings.basicAuthEnabled;
    if (enabled) {
      console.log('Basic auth: enabled');
      console.log(`  user: ${settings.basicAuthUser || '(not set)'}`);
    } else {
      console.log('Basic auth: disabled');
    }
    console.log('');
    console.log('Usage:');
    console.log('  deckide auth on [user] [password]  Enable auth');
    console.log('  deckide auth off                   Disable auth');
    console.log('  deckide auth status                Show status');
    process.exit(0);
  }

  console.error(`Unknown auth command: ${sub}`);
  process.exit(1);
}

// ── deckide status ──
if (command === 'status') {
  const settings = loadSettings();
  const daemonInfoPath = path.join(dataDir, 'pty-daemon.json');

  console.log('Deck IDE status');
  console.log(`  data dir: ${dataDir}`);
  console.log(`  port: ${settings.port || 8787}`);
  console.log(`  auth: ${settings.basicAuthEnabled ? 'enabled' : 'disabled'}`);

  // Check if server is running
  const port = settings.port || 8787;
  try {
    const res = execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/health`, {
      timeout: 3000,
    }).toString().trim();
    console.log(`  server: running (port ${port})`);
  } catch {
    console.log('  server: not running');
  }

  // Check PTY daemon
  if (fs.existsSync(daemonInfoPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonInfoPath, 'utf-8'));
      console.log(`  pty daemon: running (pid ${info.pid}, port ${info.port})`);
    } catch {
      console.log('  pty daemon: unknown');
    }
  } else {
    console.log('  pty daemon: not running');
  }

  process.exit(0);
}

// ── deckide stop ──
if (command === 'stop') {
  const settings = loadSettings();
  const port = settings.port || 8787;
  try {
    execSync(`curl -s -X POST http://localhost:${port}/api/shutdown -H "Content-Type: application/json" -d '{"terminateDaemon":true}'`, {
      timeout: 5000,
    });
    console.log('Server stopped.');
  } catch {
    console.log('Server is not running or could not be reached.');
  }
  process.exit(0);
}

// ── deckide (start server) ──

// Parse start options
const startOptions = {
  port: null,
  host: null,
  open: true,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === '--port' || arg === '-p') && args[i + 1]) {
    startOptions.port = parseInt(args[i + 1], 10);
    i++;
  } else if (arg === '--host' && args[i + 1]) {
    startOptions.host = args[i + 1];
    i++;
  } else if (arg === '--no-open') {
    startOptions.open = false;
  } else if (arg && !arg.startsWith('-')) {
    console.error(`Unknown command: ${arg}`);
    console.error('Run "deckide help" for usage.');
    process.exit(1);
  }
}

// Load settings and apply CLI overrides
const settings = loadSettings();
const port = startOptions.port || settings.port || 8787;
const host = startOptions.host || settings.host || '0.0.0.0';

process.env.DECKIDE_DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.HOST = host;

// Import and start the server
const { createServer } = await import(path.join(__dirname, '..', 'dist', 'server.js'));
await createServer();

// Open browser after server starts
if (startOptions.open) {
  const url = `http://localhost:${port}`;
  setTimeout(() => {
    try {
      const platform = process.platform;
      if (platform === 'darwin') {
        execSync(`open ${url}`);
      } else if (platform === 'win32') {
        execSync(`start ${url}`);
      } else {
        execSync(`xdg-open ${url}`);
      }
    } catch {
      // Silently fail if browser can't be opened
    }
  }, 500);
}
