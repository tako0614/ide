/** Narrow, independent tmux creation process. It never owns a display client or terminal registry. */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_UNIX_SOCKET_BYTES = 107;
const TMUX_BINARY = '/usr/bin/tmux';
const TOKEN_RE = /'(?:[^']|'\\'')*'/y;
const PENDING_KEYS = [
  'id', 'deckId', 'title', 'createdAt', 'cols', 'rows',
  'socketPath', 'sessionName', 'generation',
].sort().join(',');

type CreationRequest = { args: string[]; env: Record<string, string> };

function privateDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory ||
      fs.realpathSync(directory) !== directory) throw new Error('Invalid broker directory');
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe broker directory');
}

function privateFile(file: string): void {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe broker input');
}

function absent(file: string): boolean {
  try { fs.lstatSync(file); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function canonicalShellCommand(command: string): boolean {
  if (!command.startsWith('exec ') || command.includes('\0')) return false;
  let index = 5;
  let count = 0;
  while (index < command.length) {
    TOKEN_RE.lastIndex = index;
    const match = TOKEN_RE.exec(command);
    if (!match || (count === 0 && match[0] === "''")) return false;
    count++;
    index = TOKEN_RE.lastIndex;
    if (index === command.length) return true;
    if (command[index] !== ' ') return false;
    index++;
  }
  return false;
}

function exactConfig(generation: string): string {
  const lines = [
    'set-option -g default-shell /bin/sh',
    'set-option -g status off',
    'set-option -g aggressive-resize off',
    'set-option -g destroy-unattached off',
    'set-option -g update-environment ""',
    'set-option -g remain-on-exit on',
    `set-option -g @deckide_generation ${generation}`,
  ];
  return `${lines.join('\n')}\n`;
}

function validateRequest(value: unknown, runtimeDir: string): CreationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'args,env') throw new Error('Invalid broker request');
  const request = value as CreationRequest;
  if (!Array.isArray(request.args) || request.args.length !== 15 ||
      request.args.some((part) => typeof part !== 'string')) throw new Error('Invalid tmux creation arguments');
  const args = request.args;
  const [socketFlag, socketPath, configFlag, configPath, verb, detached,
    sessionFlag, sessionName, colsFlag, colsText, rowsFlag, rowsText,
    cwdFlag, cwd, shellCommand] = args;
  // The adapter's create call has exactly 15 entries; every position is named
  // so an injected option cannot be skipped.
  if (socketFlag !== '-S' || configFlag !== '-f' || verb !== 'new-session' ||
      detached !== '-d' || sessionFlag !== '-s' || colsFlag !== '-x' ||
      rowsFlag !== '-y' || cwdFlag !== '-c') throw new Error('Invalid tmux creation arguments');
  const id = sessionName.slice('deckide-'.length);
  if (sessionName !== `deckide-${id}` || !ID_RE.test(id)) throw new Error('Invalid tmux session');
  const expectedSocket = path.join(runtimeDir, `s-${id.replace(/-/g, '').slice(0, 16)}.sock`);
  const expectedConfig = path.join(runtimeDir, `${id}.conf`);
  if (socketPath !== expectedSocket || configPath !== expectedConfig ||
      Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_BYTES || !absent(socketPath)) {
    throw new Error('Invalid tmux creation path');
  }
  const cols = Number(colsText);
  const rows = Number(rowsText);
  if (!/^[1-9]\d*$/.test(colsText) || !/^[1-9]\d*$/.test(rowsText) ||
      cols < 1 || cols > 500 || rows < 1 || rows > 500 ||
      !path.isAbsolute(cwd) || cwd.includes('\0') || !canonicalShellCommand(shellCommand)) {
    throw new Error('Invalid tmux creation settings');
  }
  const cwdInfo = fs.statSync(cwd);
  if (!cwdInfo.isDirectory()) throw new Error('Invalid tmux working directory');
  const pendingPath = path.join(runtimeDir, `${id}.pending.json`);
  privateFile(pendingPath);
  privateFile(configPath);
  if (fs.statSync(pendingPath).size > 64 * 1024 || fs.statSync(configPath).size > 4096) {
    throw new Error('Oversized broker input');
  }
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as Record<string, unknown>;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending) ||
      Object.keys(pending).sort().join(',') !== PENDING_KEYS ||
      pending.id !== id || pending.sessionName !== sessionName ||
      pending.socketPath !== socketPath || pending.cols !== cols || pending.rows !== rows ||
      typeof pending.deckId !== 'string' || typeof pending.title !== 'string' ||
      typeof pending.createdAt !== 'string' ||
      typeof pending.generation !== 'string' || !ID_RE.test(pending.generation)) {
    throw new Error('Invalid pending tmux creation');
  }
  const config = fs.readFileSync(configPath, 'utf8');
  if (config !== exactConfig(pending.generation)) throw new Error('Invalid tmux configuration');
  if (!request.env || typeof request.env !== 'object' || Array.isArray(request.env)) {
    throw new Error('Invalid tmux environment');
  }
  for (const [name, content] of Object.entries(request.env)) {
    if (!name || name.includes('=') || name.includes('\0') ||
        typeof content !== 'string' || content.includes('\0')) throw new Error('Invalid tmux environment');
  }
  return request;
}

function runCreation(value: unknown, runtimeDir: string): void {
  const { args, env } = validateRequest(value, runtimeDir);
  // Never resolve the executable through the caller's PATH. The environment is
  // passed intact to the one tmux process so its new server inherits it.
  execFileSync(TMUX_BINARY, args, {
    env, timeout: 3000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function handleConnection(socket: net.Socket, runtimeDir: string): void {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let rejected = false;
  socket.setTimeout(5000, () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) { rejected = true; chunks = []; socket.destroy(); return; }
    chunks.push(chunk);
  });
  socket.on('end', () => {
    if (rejected) return;
    try {
      runCreation(JSON.parse(Buffer.concat(chunks).toString('utf8')), runtimeDir);
      socket.end('{"ok":true}');
    } catch {
      // tmux stderr and request values can contain credentials or shell text.
      socket.end('{"ok":false}');
    }
    chunks = [];
  });
  socket.on('error', () => undefined);
}

function probeExistingSocket(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.setTimeout(300, () => probe.destroy());
    probe.once('connect', () => { probe.destroy(); reject(new Error('Broker socket already active')); });
    probe.once('error', () => reject(new Error('Broker socket exists; operator review required')));
    probe.once('close', () => resolve());
  });
}

export async function serveTmuxBroker(): Promise<net.Server> {
  const socketPath = process.env.DECKIDE_TMUX_BROKER_SOCKET;
  const runtimeDir = process.env.DECKIDE_TMUX_RUNTIME_DIR;
  if (!socketPath || !runtimeDir || !path.isAbsolute(socketPath) ||
      path.normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_BYTES) {
    throw new Error('Invalid tmux broker socket');
  }
  privateDirectory(path.dirname(socketPath));
  privateDirectory(runtimeDir);
  if (!absent(socketPath)) {
    const info = fs.lstatSync(socketPath);
    if (!info.isSocket() || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe broker socket');
    await probeExistingSocket(socketPath);
    // Never unlink an existing socket, even when the probe says it is stale.
    throw new Error('Broker socket exists; operator review required');
  }
  const server = net.createServer({ allowHalfOpen: true }, (socket) => handleConnection(socket, runtimeDir));
  const priorUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    const info = fs.lstatSync(socketPath);
    if (!info.isSocket() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe broker socket');
  } catch (error) {
    server.close();
    throw error;
  } finally {
    process.umask(priorUmask);
  }
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--serve') process.exitCode = 1;
  else serveTmuxBroker().then((server) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => server.close(() => { process.exitCode = 0; }));
    }
  }).catch(() => { process.exitCode = 1; });
}
