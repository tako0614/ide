/** One isolated tmux server per DeckIDE terminal. tmux owns the shell; this process owns only a display client. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { spawn as spawnPty } from 'node-pty';
import type { IPty } from 'node-pty';
import { runTmuxCreationInBroker } from './tmuxBrokerClient.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRODUCTION_RUNTIME = '/var/lib/deckide-tmux/terminal-tmux';
const MAX_SOCKET_BYTES = 107; // Linux sockaddr_un.sun_path includes a trailing NUL.
const SNAPSHOT_FORMAT = '#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{window_width}\t#{window_height}\t#{pane_dead}';

export type TmuxTerminalMeta = {
  id: string;
  deckId: string;
  title: string;
  /** Command text may contain credentials; only the live handle retains it. */
  command: string | null;
  createdAt: string;
  cols: number;
  rows: number;
  pid: number;
  socketPath: string;
  sessionName: string;
  serverPid: number;
  sessionId: string;
  windowId: string;
  paneId: string;
  generation: string;
};

export type TmuxCreateOptions = {
  id: string;
  deckId: string;
  title: string;
  command?: string | null;
  createdAt: string;
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
};

export type TmuxAdapterDependencies = {
  /** Receives tmux arguments without a shell. Creation receives only the supplied environment. */
  run?: (args: string[], env?: Record<string, string>) => string;
  /** Receives the normal tmux display client, never the shell process. */
  ptySpawn?: (file: string, args: string[], options: object) => IPty;
  /** Test seam; production verifies an owner-only Unix socket. */
  assertSocket?: (socketPath: string) => void;
  socketExists?: (socketPath: string) => boolean;
};

type Identity = {
  serverPid: number;
  sessionId: string;
  windowId: string;
  paneId: string;
  panePid: number;
  cols: number;
  rows: number;
  dead: boolean;
};

type PendingTmuxTerminal = Pick<TmuxTerminalMeta,
  'id' | 'deckId' | 'title' | 'createdAt' | 'cols' | 'rows' |
  'socketPath' | 'sessionName' | 'generation'>;

const META_KEYS = new Set([
  'id', 'deckId', 'title', 'command', 'createdAt', 'cols', 'rows', 'pid',
  'socketPath', 'sessionName', 'serverPid', 'sessionId', 'windowId', 'paneId', 'generation',
]);
const PENDING_KEYS = new Set([
  'id', 'deckId', 'title', 'createdAt', 'cols', 'rows',
  'socketPath', 'sessionName', 'generation',
]);

function assertExactKeys(value: unknown, keys: Set<string>, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const actual = Object.keys(value);
  // Do not echo unexpected key names: they can themselves contain private data.
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    throw new Error(`Unexpected ${label} fields`);
  }
}

function quotePosix(value: string): string {
  if (value.includes('\0')) throw new Error('NUL in shell argument');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function checkedSize(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 500) throw new Error(`Invalid ${name}`);
  return value;
}

function parsePositive(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid tmux ${name}`);
  return n;
}

function parseIdentity(output: string): Identity {
  const parts = output.trim().split('\t');
  if (parts.length !== 8) throw new Error('Invalid tmux identity response');
  const [pid, sessionId, windowId, paneId, panePid, cols, rows, dead] = parts;
  if (!/^\$\d+$/.test(sessionId) || !/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId) || !/^[01]$/.test(dead)) {
    throw new Error('Invalid tmux native IDs');
  }
  return {
    serverPid: parsePositive(pid, 'server PID'), sessionId, windowId, paneId,
    // tmux versions may clear pane_pid after a remain-on-exit pane has died.
    panePid: dead === '1' && (panePid === '' || panePid === '0') ? 0 : parsePositive(panePid, 'pane PID'),
    cols: checkedSize(Number(cols), 'tmux columns'),
    rows: checkedSize(Number(rows), 'tmux rows'), dead: dead === '1',
  };
}

function brokerRequired(runtimeDir: string): boolean {
  const flag = process.env.DECKIDE_TMUX_BROKER_REQUIRED;
  if (flag !== undefined && flag !== '' && flag !== '1') {
    throw new Error('Invalid tmux broker requirement flag');
  }
  return path.resolve(runtimeDir) === PRODUCTION_RUNTIME || flag === '1';
}

function requireBrokerSocket(runtimeDir: string): void {
  if (brokerRequired(runtimeDir) && !process.env.DECKIDE_TMUX_BROKER_SOCKET?.trim()) {
    throw new Error('tmux creation broker socket is required; refusing direct shell creation');
  }
}

function realRun(args: string[], env?: Record<string, string>): string {
  if (env && args[4] === 'new-session') {
    requireBrokerSocket(path.dirname(args[1]));
    if (process.env.DECKIDE_TMUX_BROKER_SOCKET) return runTmuxCreationInBroker(args, env);
  }
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('tmux is unavailable; install a supported tmux binary before creating or restoring terminals');
    }
    // Do not echo tmux stderr: startup failures may include the user's command text.
    throw new Error('tmux command failed; inspect the terminal runtime and socket ownership');
  }
}

function assertPrivateDirectory(directory: string): void {
  if (!path.isAbsolute(directory)) throw new Error('Terminal runtime directory must be absolute');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Terminal runtime directory must be owner-only and not a symlink');
  }
}

function assertOwnedFile(file: string, kind: 'socket' | 'file'): void {
  const info = fs.lstatSync(file);
  if ((kind === 'socket' && !info.isSocket()) || (kind === 'file' && !info.isFile()) ||
      info.isSymbolicLink() || (info.mode & 0o077) ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Unsafe terminal ${kind}`);
  }
}

function pathExists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function validateMeta(value: unknown, runtimeDir: string): TmuxTerminalMeta {
  assertExactKeys(value, META_KEYS, 'terminal registry entry');
  const meta = value as TmuxTerminalMeta;
  if (!ID_RE.test(meta.id) || typeof meta.deckId !== 'string' || typeof meta.title !== 'string' ||
      typeof meta.createdAt !== 'string' || meta.command !== null ||
      meta.sessionName !== `deckide-${meta.id}` ||
      meta.socketPath !== path.join(runtimeDir, `s-${meta.id.replace(/-/g, '').slice(0, 16)}.sock`) ||
      !ID_RE.test(meta.generation) || !Number.isSafeInteger(meta.serverPid) || meta.serverPid < 1 ||
      !Number.isSafeInteger(meta.pid) || meta.pid < 1 ||
      !/^\$\d+$/.test(meta.sessionId) || !/^@\d+$/.test(meta.windowId) || !/^%\d+$/.test(meta.paneId)) {
    throw new Error('Invalid terminal registry identity');
  }
  checkedSize(meta.cols, 'registry columns'); checkedSize(meta.rows, 'registry rows');
  return meta;
}

function validatePending(value: unknown, runtimeDir: string): PendingTmuxTerminal {
  assertExactKeys(value, PENDING_KEYS, 'pending terminal record');
  const item = value as PendingTmuxTerminal;
  if (!ID_RE.test(item.id) || typeof item.deckId !== 'string' || typeof item.title !== 'string' ||
      typeof item.createdAt !== 'string' || !ID_RE.test(item.generation) ||
      item.sessionName !== `deckide-${item.id}` ||
      item.socketPath !== path.join(runtimeDir, `s-${item.id.replace(/-/g, '').slice(0, 16)}.sock`)) {
    throw new Error('Invalid pending terminal identity');
  }
  checkedSize(item.cols, 'pending columns'); checkedSize(item.rows, 'pending rows');
  return item;
}

export class TmuxTerminalAdapter {
  readonly runtimeDir: string;
  private run: NonNullable<TmuxAdapterDependencies['run']>;
  private ptySpawn: NonNullable<TmuxAdapterDependencies['ptySpawn']>;
  private assertSocket: NonNullable<TmuxAdapterDependencies['assertSocket']>;
  private socketExists: NonNullable<TmuxAdapterDependencies['socketExists']>;

  constructor(options: { runtimeDir: string; dependencies?: TmuxAdapterDependencies }) {
    this.runtimeDir = options.runtimeDir;
    this.run = options.dependencies?.run ?? realRun;
    this.ptySpawn = options.dependencies?.ptySpawn ?? ((file, args, ptyOptions) => spawnPty(file, args, ptyOptions as any));
    this.assertSocket = options.dependencies?.assertSocket ?? ((socketPath) => assertOwnedFile(socketPath, 'socket'));
    this.socketExists = options.dependencies?.socketExists ?? pathExists;
    assertPrivateDirectory(this.runtimeDir);
  }

  private socketPath(id: string): string {
    const socket = path.join(this.runtimeDir, `s-${id.replace(/-/g, '').slice(0, 16)}.sock`);
    if (Buffer.byteLength(socket) > MAX_SOCKET_BYTES) throw new Error('Terminal runtime path is too long for a Unix socket');
    return socket;
  }

  private registryPath(id: string): string { return path.join(this.runtimeDir, `${id}.json`); }
  private pendingPath(id: string): string { return path.join(this.runtimeDir, `${id}.pending.json`); }
  private configPath(id: string): string { return path.join(this.runtimeDir, `${id}.conf`); }
  private tmuxArgs(socketPath: string, ...command: string[]): string[] {
    return ['-S', socketPath, '-N', ...command];
  }

  private query(meta: Pick<TmuxTerminalMeta, 'socketPath' | 'sessionName'> & Partial<Pick<TmuxTerminalMeta, 'paneId'>>): Identity {
    this.assertSocket(meta.socketPath);
    return parseIdentity(this.run(this.tmuxArgs(meta.socketPath,
      'display-message', '-p', '-t', meta.paneId ?? `=${meta.sessionName}:0.0`, SNAPSHOT_FORMAT)));
  }

  private generation(meta: Pick<TmuxTerminalMeta, 'socketPath' | 'sessionName'>): string {
    return this.run(this.tmuxArgs(meta.socketPath,
      'show-options', '-gv', '@deckide_generation')).trim();
  }

  private setManualWindow(socketPath: string, windowId: string, cols: number, rows: number): void {
    // tmux 3.6 exits during server startup if `window-size manual` is in -f.
    // The first session is detached, so configure both its window and the
    // global default before any display or external client can attach.
    this.run(this.tmuxArgs(socketPath, 'set-option', '-gw', 'window-size', 'manual'));
    this.run(this.tmuxArgs(socketPath, 'set-option', '-w', '-t', windowId, 'window-size', 'manual'));
    this.run(this.tmuxArgs(socketPath, 'resize-window', '-t', windowId,
      '-x', String(cols), '-y', String(rows)));
  }

  verify(meta: TmuxTerminalMeta): Identity {
    validateMeta(meta, this.runtimeDir);
    const actual = this.query(meta);
    if (actual.serverPid !== meta.serverPid || actual.sessionId !== meta.sessionId ||
        actual.windowId !== meta.windowId || actual.paneId !== meta.paneId ||
        (actual.panePid !== 0 && actual.panePid !== meta.pid) ||
        (!actual.dead && actual.panePid === 0) ||
        this.generation(meta) !== meta.generation) {
      throw new Error('Terminal identity changed; refusing to attach or mutate');
    }
    return actual;
  }

  private save(meta: TmuxTerminalMeta): void {
    const file = this.registryPath(meta.id);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    const persisted = { ...meta, command: null };
    validateMeta(persisted, this.runtimeDir);
    fs.writeFileSync(temp, JSON.stringify(persisted) + '\n', { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temp, file); } catch (error) { fs.unlinkSync(temp); throw error; }
  }

  private recoverPending(onUnavailable?: (id: string, error: unknown) => void): void {
    const pendingFiles = fs.readdirSync(this.runtimeDir).filter((name) =>
      name.endsWith('.pending.json') && ID_RE.test(name.slice(0, -'.pending.json'.length)));
    for (const name of pendingFiles) {
      const id = name.slice(0, -'.pending.json'.length);
      try {
        const file = path.join(this.runtimeDir, name);
        assertOwnedFile(file, 'file');
        const pending = validatePending(JSON.parse(fs.readFileSync(file, 'utf8')), this.runtimeDir);
        if (name !== `${pending.id}.pending.json`) throw new Error('Pending terminal ID mismatch');
        if (!this.socketExists(pending.socketPath)) continue; // No evidence the shell was ever launched.
        const identity = this.query(pending);
        if (this.generation(pending) !== pending.generation) {
          throw new Error('Pending tmux generation changed; refusing to adopt');
        }
        const meta: TmuxTerminalMeta = {
          ...pending, command: null, pid: identity.panePid, serverPid: identity.serverPid,
          sessionId: identity.sessionId, windowId: identity.windowId, paneId: identity.paneId,
        };
        if (pathExists(this.registryPath(pending.id))) {
          const recorded = this.load(pending.id);
          if (recorded.generation !== pending.generation) throw new Error('Pending terminal generation conflict');
          this.verify(recorded);
        } else {
          if (identity.dead) {
            // A dead pane may no longer report a PID. No live process needs adoption.
            this.run(this.tmuxArgs(pending.socketPath, 'kill-session', '-t', `=${pending.sessionName}`));
            fs.unlinkSync(file);
            fs.unlinkSync(this.configPath(pending.id));
            continue;
          }
          if (identity.cols !== pending.cols || identity.rows !== pending.rows) {
            throw new Error('Pending tmux geometry changed; refusing to adopt');
          }
          this.setManualWindow(pending.socketPath, identity.windowId, pending.cols, pending.rows);
          this.save(meta);
        }
        fs.unlinkSync(file);
      } catch (error) {
        if (!onUnavailable) throw error;
        onUnavailable(id, error);
      }
    }
  }

  private load(id: string): TmuxTerminalMeta {
    if (!ID_RE.test(id)) throw new Error('Invalid terminal ID');
    const file = this.registryPath(id);
    assertOwnedFile(file, 'file');
    const meta = validateMeta(JSON.parse(fs.readFileSync(file, 'utf8')), this.runtimeDir);
    if (meta.id !== id) throw new Error('Terminal registry ID mismatch');
    return meta;
  }

  /** Enumerate owned sessions. Only a positively identified dead pane is reaped. */
  list(
    onUnavailable?: (id: string, error: unknown) => void,
    onExited?: (id: string) => void,
  ): TmuxTerminalMeta[] {
    assertPrivateDirectory(this.runtimeDir);
    this.recoverPending(onUnavailable);
    const records = fs.readdirSync(this.runtimeDir).filter((name) => ID_RE.test(name.slice(0, -5)) && name.endsWith('.json'));
    return records.flatMap((name) => {
      const id = name.slice(0, -5);
      try {
        const meta = this.load(id);
        const identity = this.verify(meta);
        if (identity.dead) {
          this.finishExited(meta);
          onExited?.(id);
          return [];
        }
        return [meta];
      } catch (error) {
        if (!onUnavailable) throw error;
        onUnavailable(id, error);
        return [];
      }
    });
  }

  create(options: TmuxCreateOptions): TmuxTerminalHandle {
    if (process.platform === 'win32') throw new Error('tmux terminals require a POSIX host');
    if (!ID_RE.test(options.id)) throw new Error('Invalid terminal ID');
    checkedSize(options.cols, 'columns'); checkedSize(options.rows, 'rows');
    if (!path.isAbsolute(options.cwd) || !options.shell || !Array.isArray(options.args)) throw new Error('Invalid terminal startup');
    requireBrokerSocket(this.runtimeDir); // Before any tmux call or pending/config write.
    assertPrivateDirectory(this.runtimeDir);
    this.run(['-V']); // Fail before writing registry/config when tmux is absent.
    const socketPath = this.socketPath(options.id);
    if (pathExists(socketPath) || pathExists(this.registryPath(options.id)) ||
        pathExists(this.pendingPath(options.id)) || pathExists(this.configPath(options.id))) {
      throw new Error('Terminal ID or tmux socket already exists');
    }
    const sessionName = `deckide-${options.id}`;
    const generation = crypto.randomUUID();
    // A single tmux shell-command is run as /bin/sh -c. exec replaces that bootstrap
    // process, preserving the original shell argv (including zero arguments).
    const shellCommand = `exec ${[options.shell, ...options.args].map(quotePosix).join(' ')}`;
    const config = [
      'set-option -g default-shell /bin/sh',
      'set-option -g status off',
      'set-option -g aggressive-resize off',
      'set-option -g destroy-unattached off',
      'set-option -g update-environment ""',
      'set-option -g remain-on-exit on',
      `set-option -g @deckide_generation ${generation}`,
      '',
    ].join('\n');
    const pending: PendingTmuxTerminal = {
      id: options.id, deckId: options.deckId, title: options.title,
      createdAt: options.createdAt, cols: options.cols, rows: options.rows,
      socketPath, sessionName, generation,
    };
    fs.writeFileSync(this.pendingPath(options.id), JSON.stringify(pending) + '\n', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(this.configPath(options.id), config, { mode: 0o600, flag: 'wx' });
    // The first tmux invocation seeds this dedicated server with precisely the
    // terminal creation environment; no environment values enter argv or registry.
    this.run(['-S', socketPath, '-f', this.configPath(options.id),
      'new-session', '-d', '-s', sessionName, '-x', String(options.cols), '-y', String(options.rows),
      '-c', options.cwd, shellCommand], options.env);
    this.assertSocket(socketPath);
    const identity = this.query({ socketPath, sessionName });
    const meta: TmuxTerminalMeta = {
      id: options.id, deckId: options.deckId, title: options.title, command: null,
      createdAt: options.createdAt, cols: options.cols, rows: options.rows, pid: identity.panePid,
      socketPath, sessionName, serverPid: identity.serverPid, sessionId: identity.sessionId,
      windowId: identity.windowId, paneId: identity.paneId, generation,
    };
    if (identity.cols !== options.cols || identity.rows !== options.rows || this.generation(meta) !== generation) {
      throw new Error('tmux initial geometry or generation mismatch');
    }
    this.setManualWindow(socketPath, identity.windowId, options.cols, options.rows);
    this.save(meta);
    fs.unlinkSync(this.pendingPath(options.id));
    return this.attach(meta);
  }

  nativeAttachment(id: string, readOnly = false): { id: string; meta: TmuxTerminalMeta; binary: string; args: string[] } {
    const meta = this.load(id);
    const actual = this.verify(meta);
    if (actual.dead) throw new Error('Terminal pane has exited');
    return { id, meta, binary: 'tmux', args: this.tmuxArgs(meta.socketPath, 'attach-session', '-E', '-f', readOnly ? 'ignore-size,read-only' : 'ignore-size', '-t', `=${meta.sessionName}`) };
  }

  attach(value: string | TmuxTerminalMeta): TmuxTerminalHandle {
    const id = typeof value === 'string' ? value : value.id;
    const meta = this.load(id);
    if (typeof value !== 'string' && (value.sessionId !== meta.sessionId || value.pid !== meta.pid ||
        value.generation !== meta.generation)) throw new Error('Terminal metadata changed');
    const identity = this.verify(meta);
    if (identity.dead) throw new Error('Terminal shell already exited');
    const clientEnv: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    delete clientEnv.TMUX; // The display client must be an independent outer client.
    const pty = this.ptySpawn('tmux', this.tmuxArgs(meta.socketPath,
      'attach-session', '-E', '-f', 'ignore-size', '-t', `=${meta.sessionName}`), {
      cwd: this.runtimeDir, cols: meta.cols, rows: meta.rows,
      env: clientEnv, encoding: null,
    });
    return new TmuxTerminalHandle(this, meta, pty);
  }

  resize(meta: TmuxTerminalMeta, pty: IPty, cols: number, rows: number): void {
    checkedSize(cols, 'columns'); checkedSize(rows, 'rows');
    this.verify(meta);
    this.run(this.tmuxArgs(meta.socketPath, 'resize-window', '-t', meta.windowId,
      '-x', String(cols), '-y', String(rows)));
    pty.resize(cols, rows);
    meta.cols = cols; meta.rows = rows;
    this.save(meta);
  }

  close(meta: TmuxTerminalMeta): void {
    this.verify(meta);
    this.run(this.tmuxArgs(meta.socketPath, 'kill-session', '-t', `=${meta.sessionName}`));
    fs.unlinkSync(this.registryPath(meta.id));
    // tmux exits its per-terminal server after the final session is killed.
    // The configuration file is nonsecret, but is no longer needed.
    fs.unlinkSync(this.configPath(meta.id));
  }

  paneState(meta: TmuxTerminalMeta): { dead: boolean; exitCode: number } {
    this.verify(meta);
    const output = this.run(this.tmuxArgs(meta.socketPath, 'display-message', '-p',
      '-t', meta.paneId, '#{pane_dead}\t#{pane_dead_status}')).trim().split('\t');
    if (output[0] !== '0' && output[0] !== '1') throw new Error('Invalid tmux pane state');
    return { dead: output[0] === '1', exitCode: Number(output[1]) || 0 };
  }

  finishExited(meta: TmuxTerminalMeta): void {
    if (!this.paneState(meta).dead) throw new Error('Terminal pane is still alive');
    this.close(meta);
  }
}

export class TmuxTerminalHandle extends EventEmitter {
  private attached = true;
  private closed = false;
  private displayDisposed = false;
  private queued: Buffer[] = [];
  private queuedBytes = 0;
  private poller: NodeJS.Timeout;
  private exitEvent: { exitCode: number } | null = null;
  private disconnectEvent: { reason: string } | null = null;

  constructor(private adapter: TmuxTerminalAdapter, readonly meta: TmuxTerminalMeta, private pty: IPty) {
    super();
    pty.onData((data) => {
      if (!this.attached) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      if (!this.listenerCount('data')) {
        this.queued.push(chunk); this.queuedBytes += chunk.length;
        while (this.queuedBytes > 1024 * 1024) this.queuedBytes -= this.queued.shift()!.length;
      } else this.emit('data', chunk);
    });
    pty.onExit(() => { if (this.attached && !this.closed) this.checkPane(true); });
    this.poller = setInterval(() => this.checkPane(false), 2000);
    this.poller.unref();
  }

  get pid(): number { return this.meta.pid; }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === 'data') {
      for (const chunk of this.queued) listener(chunk);
      this.queued = []; this.queuedBytes = 0;
    }
    if (event === 'exit' && this.exitEvent) queueMicrotask(() => listener(this.exitEvent));
    if (event === 'disconnect' && this.disconnectEvent) queueMicrotask(() => listener(this.disconnectEvent));
    return this;
  }

  onExit(listener: (event: { exitCode: number }) => void): { dispose: () => void } {
    this.on('exit', listener);
    return { dispose: () => this.off('exit', listener) };
  }

  private checkPane(displayExited: boolean): void {
    if (!this.attached || this.closed) return;
    if (displayExited) this.displayDisposed = true;
    let state: { dead: boolean; exitCode: number };
    try {
      state = this.adapter.paneState(this.meta);
    } catch {
      // Missing socket, tmux failure, and identity mismatch do not prove shell death.
      this.detach();
      this.disconnectEvent = { reason: 'tmux identity unavailable; shell state uncertain' };
      this.emit('disconnect', this.disconnectEvent);
      return;
    }
    if (state.dead) {
      this.closed = true; // Ignore any display exit caused by killing this session.
      try { this.adapter.finishExited(this.meta); } catch {
        this.closed = false;
        this.detach();
        this.disconnectEvent = { reason: 'tmux pane exited but cleanup is incomplete' };
        this.emit('disconnect', this.disconnectEvent);
        return;
      }
      this.detach();
      this.exitEvent = { exitCode: state.exitCode };
      this.emit('exit', this.exitEvent);
    } else if (displayExited) {
      this.detach();
      this.disconnectEvent = { reason: 'tmux display client exited; shell remains live' };
      this.emit('disconnect', this.disconnectEvent);
    }
  }

  write(data: string | Uint8Array | Buffer): void {
    if (!this.attached || this.closed) throw new Error('Terminal display client disconnected');
    this.pty.write(Buffer.isBuffer(data) ? data as any : Buffer.from(data) as any);
  }

  resize(cols: number, rows: number): void {
    if (!this.attached || this.closed) throw new Error('Terminal display client disconnected');
    this.adapter.resize(this.meta, this.pty, cols, rows);
  }

  // A slow browser must not stop the persistent tmux display drain or shell.
  // The HTTP bridge evicts slow WebSocket consumers independently.
  pause(): void {}
  resume(): void {}

  detach(): void {
    this.attached = false; clearInterval(this.poller);
    if (this.displayDisposed) return;
    this.displayDisposed = true;
    try { this.pty.kill(); } catch { /* Display may already have exited. */ }
    // Only the normal tmux display client is stopped; tmux's pane persists.
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.adapter.close(this.meta);
    this.closed = true;
    this.detach();
  }
}
