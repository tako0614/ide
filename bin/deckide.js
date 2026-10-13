#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DECKIDE_DATA_DIR || path.join(os.homedir(), '.deckide'));
const settingsFile = path.join(dataDir, 'settings.json');
const pidFile = path.join(dataDir, 'server.pid');
const logFile = path.join(dataDir, 'server.log');

// ─── Settings helpers ───────────────────────────────────────────

function loadSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('Settings file must contain a JSON object');
    }
    return settings;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Cannot read Deck IDE settings at ${settingsFile}: ${error.message}`, { cause: error });
  }
}

function saveSettings(settings) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const temporaryFile = path.join(dataDir, `.settings-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(temporaryFile, 0o600);
    fs.renameSync(temporaryFile, settingsFile);
    fs.chmodSync(settingsFile, 0o600);
  } finally {
    try { fs.unlinkSync(temporaryFile); } catch {}
  }
}

function getPort() {
  return validatePort(loadSettings().port) || 8787;
}

function validatePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

let passwordHelpers;
async function getPasswordHelpers() {
  passwordHelpers ??= import(path.join(__dirname, '..', 'dist', 'auth', 'password.js'));
  return passwordHelpers;
}

async function migrateLegacySettings(settings) {
  const legacyPassword = settings.basicAuthPassword;
  const legacyHash = settings.passwordHash;
  const hasLegacyFields = settings.basicAuthEnabled !== undefined || settings.basicAuthUser !== undefined ||
    settings.basicAuthPassword !== undefined || settings.passwordHash !== undefined;
  if (!hasLegacyFields) return settings;

  const migrated = { ...settings };
  delete migrated.basicAuthEnabled;
  delete migrated.basicAuthUser;
  delete migrated.basicAuthPassword;
  delete migrated.passwordHash;
  if (settings.authEnabled !== undefined && typeof settings.authEnabled !== 'boolean') {
    throw new Error('Invalid authEnabled setting; settings were not changed.');
  }
  if (settings.basicAuthEnabled !== undefined && typeof settings.basicAuthEnabled !== 'boolean') {
    throw new Error('Invalid legacy auth enabled setting; settings were not changed.');
  }
  const enabled = settings.authEnabled ?? (settings.basicAuthEnabled === true);
  const user = settings.authUser ?? settings.basicAuthUser;
  if (user !== undefined && (typeof user !== 'string' || !user.trim() || user.length > 128)) {
    throw new Error('Invalid stored auth user; settings were not changed.');
  }
  let hash = settings.authPasswordHash;
  if (hash !== undefined) {
    const { isPasswordHash } = await getPasswordHelpers();
    if (!isPasswordHash(hash)) throw new Error('Invalid stored auth password hash; settings were not changed.');
  } else if (legacyPassword) {
    if (typeof legacyPassword !== 'string') throw new Error('Invalid legacy auth password; settings were not changed.');
    const { hashPassword } = await getPasswordHelpers();
    hash = await hashPassword(legacyPassword);
  } else if (legacyHash !== undefined) {
    const { isPasswordHash } = await getPasswordHelpers();
    if (!isPasswordHash(legacyHash)) throw new Error('Invalid legacy password hash; settings were not changed.');
    hash = legacyHash;
  }
  if (enabled) {
    if (typeof user !== 'string' || !user.trim() || user.length > 128 || typeof hash !== 'string') {
      throw new Error('Legacy authentication is enabled without valid credentials; settings were not changed.');
    }
    const { isPasswordHash } = await getPasswordHelpers();
    if (!isPasswordHash(hash)) throw new Error('Authentication is enabled with an invalid password hash; settings were not changed.');
    migrated.authEnabled = true;
    migrated.authUser = user;
    migrated.authPasswordHash = hash;
  } else if (settings.authEnabled !== undefined || settings.basicAuthEnabled !== undefined) {
    migrated.authEnabled = Boolean(enabled);
    if (user !== undefined) migrated.authUser = user;
    if (hash !== undefined) migrated.authPasswordHash = hash;
  }
  saveSettings(migrated);
  return migrated;
}

/** Mirrors isLoopbackHost() in src/config.ts — keep the two in sync. */
function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false; // empty => Node binds every interface
  if (h === 'localhost') return true;
  if (h === '::1' || h === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isAuthConfigured(settings) {
  if ((process.env.DECKIDE_AUTH_USER && process.env.DECKIDE_AUTH_PASSWORD) ||
      (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD)) return true;
  return Boolean(settings.authEnabled && settings.authUser && settings.authPasswordHash);
}

function isServerRunningOnPort(port) {
  const checkedPort = validatePort(port);
  if (!checkedPort) return false;
  try {
    execFileSync('curl', ['-sf', '-o', '/dev/null', `http://localhost:${checkedPort}/health`], {
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

/** Stop only the process recorded as this data directory's server owner. */
function stopServer() {
  const pid = getRunningPid();
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

// `deckide ui`, or plain `deckide` in a terminal while the backend is running:
// the web UI's decks and terminals, in this terminal.
if (command === 'ui' || (!command && process.stdin.isTTY && process.stdout.isTTY)) {
  const { sessionRpc } = await import('./deckide-session.js');
  let backendUp = false;
  try { await sessionRpc('status'); backendUp = true; } catch { /* not running: fall through to start */ }
  if (backendUp) {
    const { runUi } = await import('./deckide-ui.js');
    try { await runUi(); }
    catch (error) {
      console.error(error?.message === 'terminal_required' ? 'deckide ui needs an interactive terminal.' : 'deckide ui failed: ' + (error?.message || error));
      process.exitCode = 1;
    }
    process.exit(process.exitCode || 0);
  } else if (command === 'ui') {
    console.error('Deck IDE is not running. Start it with "deckide start".');
    process.exit(1);
  }
}

// `deckide desktop mcp`: stdio MCP server for the shared XFCE desktop (ops/desktop).
if (command === 'desktop') {
  if (args[1] !== 'mcp') {
    console.error('Usage: deckide desktop mcp   (stdio MCP server: screenshots and input on the shared desktop)');
    process.exit(1);
  }
  const { runDesktopMcp } = await import('./deckide-desktop-mcp.js');
  await runDesktopMcp();
  process.exit(0);
}

if (command === 'session') {
  const { runSessionClient } = await import('./deckide-session.js');
  try { await runSessionClient(args.slice(1)); }
  catch { console.error('Session operation failed. Check the backend, socket, terminal ID and CLI installation.'); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}

if (command === 'deck') {
  const { runDeckClient } = await import('./deckide-session.js');
  try { await runDeckClient(args.slice(1)); }
  catch { console.error('Deck operation failed. Check the backend, socket, deck ID and CLI installation.'); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}

if (args.includes('--chatgpt-desktop') && (command !== 'start' || !args.includes('--fg'))) {
  console.error('--chatgpt-desktop is supported only with `deckide start --fg`.');
  process.exit(1);
}

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
  deckide ui                     Decks and terminals in this terminal (also plain
                                 "deckide" while the server runs; Ctrl+] for menu)
  deckide session <subcommand>   Share persistent terminals with Web/MCP
  deckide deck <subcommand>      List and manage decks
  deckide desktop mcp            Let an agent (Grok Bot, Claude…) use the shared desktop
  deckide logs                   Show server logs
  deckide computer <subcommand>  Use an inherited, temporary host session grant

  deckide port                   Show current port
  deckide port <number>          Change port (auto-restarts)

  deckide auth on [user] [pass]  Enable session auth
  deckide auth off               Disable session auth
  deckide auth status            Show auth status

  deckide config                 Show all settings
  deckide config set <key> <val> Set a config value
  deckide config get <key>       Get a config value
  deckide config reset           Reset all settings


Options (for start):
  -p, --port <port>              Port (default: 8787)
  --host <host>                  Host (default: 127.0.0.1, loopback only)
  --no-open                      Don't open browser
  --fg                           Run in foreground
  --computer-host-session        Pin this CLI's current directory as an ephemeral
                                GUI development scope (local authenticated use)
  --chatgpt-desktop              Enable explicit owned ChatGPT desktop launch (foreground only)

To reach Deck IDE from another device, bind a wider address AND enable auth:
  deckide auth on <user> <password>
  deckide config set host 0.0.0.0
Binding a non-loopback host without auth is refused: the terminal API runs
arbitrary commands as your user.
`);
  process.exit(0);
}

// Convert one-time legacy settings before commands read or mutate them.
if (command === 'computer') {
  const { runComputerClient } = await import('./deckide-computer.js');
  await runComputerClient(args.slice(1));
  process.exit(0);
}

if (args.includes('--computer-host-session') &&
    (command === 'restart' || !process.env.DECKIDE_DATA_DIR)) {
  console.error('--computer-host-session requires a fresh start and an explicit isolated DECKIDE_DATA_DIR.');
  process.exit(1);
}

await migrateLegacySettings(loadSettings());

// ── deckide config ──
if (command === 'config') {
  const sub = args[1];
  const settings = loadSettings();

  if (!sub || sub === 'list') {
    if (Object.keys(settings).length === 0) {
      console.log('No custom settings. Using defaults.');
      console.log('  port: 8787');
      console.log('  host: 127.0.0.1');
    } else {
      for (const [key, value] of Object.entries(settings)) {
        if (['authPasswordHash', 'basicAuthPassword', 'passwordHash'].includes(key) && value) {
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
    else if (['authPasswordHash', 'basicAuthPassword', 'passwordHash'].includes(key)) console.log(`${key}: ${val ? '********' : '(not set)'}`);
    else console.log(`${key}: ${val}`);
    process.exit(0);
  }

  if (sub === 'set') {
    const key = args[2];
    let value = args[3];
    if (!key || value === undefined) { console.error('Usage: deckide config set <key> <value>'); process.exit(1); }
    if (['basicAuthEnabled', 'basicAuthUser', 'basicAuthPassword', 'passwordHash', 'authPasswordHash'].includes(key)) {
      console.error(`Error: ${key} is a legacy or secret field. Use session auth settings.`);
      process.exit(1);
    }
    if (key === 'authPassword') {
      if (value.length < 12 || Buffer.byteLength(value) > 1024) {
        console.error('Error: password must be at least 12 characters and at most 1024 bytes.');
        process.exit(1);
      }
      const { hashPassword } = await getPasswordHelpers();
      settings.authPasswordHash = await hashPassword(value);
      delete settings.authPassword;
      saveSettings(settings);
      console.log('authPassword = ********');
      if (isServerRunning() || getRunningPid()) console.log('Run "deckide restart" to apply.');
      process.exit(0);
    }
    if (key === 'authEnabled') {
      if (value !== 'true' && value !== 'false') { console.error('Error: authEnabled must be true or false.'); process.exit(1); }
      value = value === 'true';
      if (value && !(settings.authUser && settings.authPasswordHash)) {
        console.error('Error: configure credentials with "deckide auth on <user> <password>" first.');
        process.exit(1);
      }
    } else if (key === 'authUser') {
      if (!value.trim() || value.length > 128) {
        console.error('Error: authUser must be 1 to 128 characters.');
        process.exit(1);
      }
    } else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);
    settings[key] = value;
    saveSettings(settings);
    console.log(`${key} = ${value}`);
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
    if (settings.authEnabled) {
      console.log('Session auth: enabled');
      console.log(`  user: ${settings.authUser || '(not set)'}`);
      console.log(`  password: ${settings.authPasswordHash ? '********' : '(not set)'}`);
    } else {
      console.log('Session auth: disabled');
    }
    if (!sub) {
      console.log('\nUsage:');
      console.log('  deckide auth on [user] [password]');
      console.log('  deckide auth off');
    }
    process.exit(0);
  }

  if (sub === 'off') {
    settings.authEnabled = false;
    delete settings.authUser;
    delete settings.authPasswordHash;
    delete settings.basicAuthEnabled;
    delete settings.basicAuthUser;
    delete settings.basicAuthPassword;
    delete settings.passwordHash;
    saveSettings(settings);
    console.log('Session auth disabled.');
    if (settings.host && !isLoopbackHost(settings.host)) {
      console.log(`Note: host is ${settings.host}, so the server will now refuse to start.`);
      console.log('Run "deckide config set host 127.0.0.1" or re-enable auth.');
    }
    if (isServerRunning()) console.log('Run "deckide restart" to apply.');
    process.exit(0);
  }

  if (sub === 'on') {
    const user = args[2];
    const password = args[3];
    const genUser = user === undefined ? 'admin' : user;
    const genPassword = password || crypto.randomBytes(16).toString('base64url');

    if (password && (password.length < 12 || Buffer.byteLength(password) > 1024)) {
      console.error('Error: password must be at least 12 characters and at most 1024 bytes.');
      process.exit(1);
    }

    if (!genUser.trim() || genUser.length > 128) {
      console.error('Error: username must be 1 to 128 characters.');
      process.exit(1);
    }

    const { hashPassword } = await getPasswordHelpers();
    settings.authEnabled = true;
    settings.authUser = genUser;
    settings.authPasswordHash = await hashPassword(genPassword);
    delete settings.basicAuthEnabled;
    delete settings.basicAuthUser;
    delete settings.basicAuthPassword;
    delete settings.passwordHash;
    saveSettings(settings);
    console.log('Session auth enabled.');
    console.log(`  user: ${genUser}`);
    if (!password) console.log(`  generated password: ${genPassword}`);
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
  console.log(`  auth:   ${settings.authEnabled ? 'enabled' : 'disabled'}`);

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
    await new Promise(() => {}); // Block until tail exits
  } else {
    const lines = fs.readFileSync(logFile, 'utf-8');
    // Show last 50 lines
    const arr = lines.split('\n');
    console.log(arr.slice(-51).join('\n'));
    process.exit(0);
  }
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
const startOptions = { port: null, host: null, open: true, fg: false, computerHostSession: false, chatgptDesktop: false };

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
  } else if (arg === '--computer-host-session') {
    startOptions.computerHostSession = true;
  } else if (arg === '--chatgpt-desktop') {
    startOptions.chatgptDesktop = true;
  }
}

const settings = loadSettings();
const port = startOptions.port || settings.port || 8787;
const host = startOptions.host || settings.host || '127.0.0.1';

if (startOptions.computerHostSession &&
    (process.platform !== 'linux' || !isLoopbackHost(host) || !isAuthConfigured(settings))) {
  console.error('--computer-host-session requires Linux, a loopback host and enabled session authentication.');
  process.exit(1);
}

// The server enforces this too (src/config.ts), but in background mode its
// stderr only reaches the log file — check here so the user sees why.
if (!isLoopbackHost(host) && !isAuthConfigured(settings) && process.env.DECKIDE_ALLOW_INSECURE_HOST !== 'true') {
  console.error(`Refusing to bind ${host} without authentication.`);
  console.error('Deck IDE\'s terminal API runs arbitrary commands as your user, so anyone');
  console.error('who can reach this port would get a shell on this machine.');
  console.error('');
  console.error('Fix with one of:');
  console.error('  deckide auth on <user> <password>   # require session auth, then retry');
  console.error('  deckide config set host 127.0.0.1   # listen on loopback only (default)');
  console.error('  DECKIDE_ALLOW_INSECURE_HOST=true    # only behind a trusted proxy/network');
  process.exit(1);
}

// Check if already running on the target port
if (isServerRunningOnPort(port)) {
  if (startOptions.computerHostSession) {
    console.error('--computer-host-session requires a fresh server; the target port is already in use.');
    process.exit(1);
  }
  console.log(`Server is already running on http://localhost:${port}`);
  process.exit(0);
}

// Kill old server if running on a different port (only in background mode,
// FG mode is always spawned by background mode which already handles this)
if (!startOptions.fg) {
  const oldPid = getRunningPid();
  if (oldPid) {
    if (startOptions.computerHostSession) {
      console.error('--computer-host-session will not stop or reuse an existing server.');
      process.exit(1);
    }
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
  if (startOptions.computerHostSession) fgArgs.push('--computer-host-session');
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
    if (isServerRunningOnPort(port)) { ready = true; break; }
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
    if (startOptions.computerHostSession) process.exit(1);
  }

  process.exit(0);
}

// ── Foreground mode (--fg) ──
process.env.DECKIDE_DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.HOST = host;

const { createServer } = await import(path.join(__dirname, '..', 'dist', 'server.js'));
const createServerOptions = {};
if (startOptions.chatgptDesktop) {
  const { ownedChatgptStartupOptions } = await import(path.join(__dirname, '..', 'dist', 'computer', 'chatgpt-startup.js'));
  Object.assign(createServerOptions, await ownedChatgptStartupOptions());
}
if (startOptions.computerHostSession) {
  createServerOptions.computerHostSessionRoot = fs.realpathSync(process.cwd());
}
await createServer(createServerOptions);

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
