import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream, readFileSync, readdirSync, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { createHttpError } from '../utils/error.js';
import { desktopApp, desktopAppCatalog, validateLaunchRequest, type DesktopAppId } from './catalog.js';
import { systemDesktopApps, trustedBinary } from './system-catalog.js';
import { RfbClientGate } from './rfb.js';
import { allocatePrivateUnixSocket, cleanupPrivateUnixSocket, recordPrivateUnixSocket,
  verifyPrivateUnixSocket, type PrivateUnixEvent, type PrivateUnixLease } from './private-unix.js';
import { attestedPrivateVncLauncher, openPrivateVncDiagnostic, privateAcceptedUnixIdentity,
  privateVncLauncherArgs, privateVncNetworkIdentity,
  privateVncStdioContract, privateVncCredentialSucceeded, writePrivateVncFilter } from './vnc.js';
import { cleanupUnlessXDisplayCollision, launchAfterXDisplayCollisionGuard } from './x-display-collision.js';
import { BorrowedDesktopLease, type BorrowedDesktopSnapshot } from './borrowed-desktop.js';

const NATIVE_WIDTH = 1280;
const NATIVE_HEIGHT = 720;
const IMAGE_WIDTH = 960;
const IMAGE_HEIGHT = 540;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const OBSERVATION_MS = 30_000;
const MAX_OBSERVATIONS = 64;
const CONTROL_MS = 15_000;
const DEVELOPED_MS = 30 * 60_000;
const MAX_DEVELOPMENT_SCOPES = 32;
// Exact installed binaries whose help/source and setpriv pre-exec behavior
// this candidate was reviewed against. Package upgrades fail closed.
const VNC_BINARY_SHA256 = '35b7306bb13a4115118500ea7db2ee333eef4a6a0a3d9252a469ab8fe8d170d4';
const SETPRIV_BINARY_SHA256 = '9e0d70d26a02c1cb4b984ab6f49a582b7a2c3508b1063ac23adc60073292ae7e';
const LIBVNCSERVER_FILE = '/usr/lib/x86_64-linux-gnu/libvncserver.so.0.9.15';
const LIBVNCSERVER_SHA256 = 'cd4c970e3747af51c281fa82a0f1b8be8fda2d202dccc5b8d2a5c61225a6a6dc';

export type DevelopmentScope = { id: string; root: string };
export type DevelopmentScopeSource = readonly DevelopmentScope[] |
  ((actor: string) => readonly DevelopmentScope[] | Promise<readonly DevelopmentScope[]>);
export type VncSandboxPolicy = { expectedFilterSha256: string; expectedLauncherSha256: string };
type ResolvedDevelopmentScope = DevelopmentScope & { dev: number; ino: number };
type DevelopedRegistration = { label: string; command: string; args: string[];
  cwd: string; root: string; rootDev: number; rootIno: number;
  cwdDev: number; cwdIno: number; hash: string; size: number;
  ownerActor: string; scopeId: string; epoch: number; expiresAt: number };

type Action = 'click' | 'type' | 'key' | 'scroll' | 'drag';
export type DesktopAction = {
  action: Action;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  steps?: number;
  button?: 'left' | 'right' | 'middle';
  count?: 1 | 2;
};
export type DesktopInput = { observationId: string; actions?: DesktopAction[] } & Partial<DesktopAction>;
export type DesktopControl = { mode: 'shared' | 'human' | 'agent'; mine: boolean; expiresAt?: number };
export type DesktopStatus = {
  supported: boolean;
  running: boolean;
  width: number;
  height: number;
  epoch: number;
  transport: 'sampled-jpeg' | 'private-rfb';
  control: DesktopControl;
  capabilities: { unicode: false; clipboard: false; developedApps: boolean };
  capture: { ready: boolean; capturedAt?: number; error?: string };
  message?: string;
};
type Observation = { actor: string; createdAt: number; epoch: number; revision: number };
type OwnedChild = {
  process: ChildProcess;
  start: string | null;
  witnesses: Map<number, string>;
  epoch: number;
  role: 'desktop' | 'app' | 'vnc';
  instanceId?: string;
  app?: DesktopAppId;
  ownerActor?: string;
  developedScopeId?: string;
  label?: string;
  closed?: boolean;
};
type Runtime = { dir: string; display: string; authority: string; env: NodeJS.ProcessEnv;
  xvfb?: ChildProcess; borrowed?: BorrowedDesktopLease };
type VncStream = { epoch: number; runtime: Runtime; filterFile: string; binary: string; launcher: string;
  setpriv: string; passwordFile: string; passwordFileHash: string; password: string };
type VncConnection = { actor: string; epoch: number; socket: Socket; gate: RfbClientGate;
  controlled: boolean; closing?: boolean; child?: OwnedChild };

function withinRoot(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
}

async function executable(name: string): Promise<string | null> {
  return trustedBinary(name);
}

function safeEnvironment(dir: string, display?: string, authority?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: dir,
    LANG: process.env.LANG ?? 'C.UTF-8',
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: os.tmpdir(),
    XDG_SESSION_TYPE: 'x11',
    GDK_BACKEND: 'x11',
    QT_QPA_PLATFORM: 'xcb',
  };
  if (display) env.DISPLAY = display;
  if (authority) env.XAUTHORITY = authority;
  return env;
}

function safeVncEnvironment(runtime: Runtime): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', HOME: runtime.dir, LANG: 'C.UTF-8',
    TMPDIR: runtime.dir, DISPLAY: runtime.display, XAUTHORITY: runtime.authority,
    XDG_SESSION_TYPE: 'x11', GDK_BACKEND: 'x11', QT_QPA_PLATFORM: 'xcb' };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function vettedVncBinaries(): Promise<{ binary: string; setpriv: string } | null> {
  const binary = await executable('x11vnc');
  const setpriv = await executable('setpriv');
  if (binary !== '/usr/bin/x11vnc' || setpriv !== '/usr/bin/setpriv') return null;
  try {
    const libraryStat = await fs.lstat(LIBVNCSERVER_FILE);
    if (!libraryStat.isFile() || libraryStat.uid !== 0 ||
      (libraryStat.mode & 0o022) ||
      await fs.realpath(LIBVNCSERVER_FILE) !== LIBVNCSERVER_FILE) return null;
    const [vncHash, setprivHash, libraryHash] = await Promise.all([
      sha256File(binary), sha256File(setpriv), sha256File(LIBVNCSERVER_FILE),
    ]);
    if (vncHash !== VNC_BINARY_SHA256 || setprivHash !== SETPRIV_BINARY_SHA256 ||
      libraryHash !== LIBVNCSERVER_SHA256) return null;
    return { binary, setpriv };
  } catch { return null; }
}

async function privateVncAuthorityValid(runtime: Runtime): Promise<boolean> {
  if (runtime.authority !== path.join(runtime.dir, 'Xauthority')) return false;
  try {
    const stat = await fs.lstat(runtime.authority);
    return stat.isFile() && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1 &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid());
  } catch { return false; }
}

function processInfo(pid: number): { group: number; start: string } | null {
  try {
    // Linux /proc stat fields 5 and 22 are pgrp and process start tick.
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(') ') + 2).split(' ');
    const group = Number(fields[2]);
    const start = fields[19];
    return Number.isInteger(group) && start ? { group, start } : null;
  } catch { return null; }
}

function groupWitnesses(group: number): Map<number, string> {
  const witnesses = new Map<number, string>();
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const info = processInfo(pid);
      if (info?.group === group) witnesses.set(pid, info.start);
    }
  } catch { /* procfs unavailable */ }
  return witnesses;
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv,
  options: { input?: string; timeoutMs?: number; maxBytes?: number; argv0?: string } = {}): Promise<Buffer> {
  const max = options.maxBytes ?? 64 * 1024;
  const proc = spawn(command, args, {
    env,
    argv0: options.argv0,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  let length = 0;
  let tooLarge = false;
  const collect = (chunk: Buffer) => {
    length += chunk.length;
    if (length > max) { tooLarge = true; proc.kill('SIGKILL'); return; }
    chunks.push(chunk);
  };
  proc.stdout?.on('data', collect);
  // Read and discard stderr; no user content, Xauthority or command line is
  // reflected into HTTP responses or logs.
  proc.stderr?.resume();
  proc.stdin?.on('error', () => { /* child exited before consuming input */ });
  if (options.input !== undefined) proc.stdin?.end(options.input);
  const timer = setTimeout(() => proc.kill('SIGKILL'), options.timeoutMs ?? 5_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', resolve);
    });
    if (tooLarge || length > max || code !== 0) throw new Error('Desktop command failed');
    return Buffer.concat(chunks, length);
  } finally { clearTimeout(timer); }
}

function buttonPoint(value: number | undefined, upper: number): number {
  if (!Number.isInteger(value) || value! < 0 || value! >= upper)
    throw createHttpError('Coordinates are outside the captured display', 400);
  return Math.min(upper === IMAGE_WIDTH ? NATIVE_WIDTH - 1 : NATIVE_HEIGHT - 1,
    Math.floor((value! + 0.5) * (upper === IMAGE_WIDTH ? NATIVE_WIDTH : NATIVE_HEIGHT) / upper));
}

const namedKeys: Record<string, string> = {
  enter: 'Return', return: 'Return', escape: 'Escape', esc: 'Escape',
  tab: 'Tab', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert',
  space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
  minus: 'minus', plus: 'plus', equal: 'equal', comma: 'comma',
  period: 'period', slash: 'slash', backslash: 'backslash',
  semicolon: 'semicolon', apostrophe: 'apostrophe', grave: 'grave',
  bracketleft: 'bracketleft', bracketright: 'bracketright',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  ' ': 'space', '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period',
  '/': 'slash', '\\': 'backslash', ';': 'semicolon', "'": 'apostrophe',
  '`': 'grave', '[': 'bracketleft', ']': 'bracketright',
};
const modifiers: Record<string, string> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift',
  meta: 'Super_L', super: 'Super_L', cmd: 'Super_L',
};
function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < 1 || key.length > 64)
    throw createHttpError('Invalid key', 400);
  const parts = key.split('+').map((part) => part.trim().toLowerCase());
  if (parts.length > 5 || parts.some((part) => !part)) throw createHttpError('Invalid key', 400);
  const base = parts.pop()!;
  const seen = new Set<string>();
  const mapped = parts.map((part) => {
    const modifier = modifiers[part];
    if (!modifier || seen.has(modifier)) throw createHttpError('Invalid key', 400);
    seen.add(modifier);
    return modifier;
  });
  const f = /^f([1-9]|1[0-2])$/.exec(base);
  const mappedBase = namedKeys[base] ?? (f ? `F${f[1]}` : /^[a-z0-9]$/.test(base) ? base : null);
  if (!mappedBase) throw createHttpError('Invalid key', 400);
  return [...mapped, mappedBase].join('+');
}

/** Validate the entire action before executing its first command. */
export function desktopInputCommands(input: DesktopAction): string[][] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createHttpError('Invalid desktop input', 400);
  const allowed: Record<Action, string[]> = {
    click: ['action', 'x', 'y', 'button', 'count'],
    drag: ['action', 'x', 'y', 'toX', 'toY'],
    type: ['action', 'text'],
    key: ['action', 'key'],
    scroll: ['action', 'direction', 'steps', 'x', 'y'],
  };
  if (!Object.hasOwn(allowed, input.action) ||
    Object.keys(input).some((key) => !allowed[input.action]?.includes(key)))
    throw createHttpError('Invalid desktop action', 400);
  switch (input.action) {
    case 'click': {
      const x = buttonPoint(input.x, IMAGE_WIDTH), y = buttonPoint(input.y, IMAGE_HEIGHT);
      if (input.button !== undefined && !['left', 'right', 'middle'].includes(input.button))
        throw createHttpError('Invalid mouse button', 400);
      if (input.count !== undefined && input.count !== 1 && input.count !== 2)
        throw createHttpError('Invalid click count', 400);
      const button = { left: '1', middle: '2', right: '3' }[input.button ?? 'left'];
      // Avoid a motion wait when clicking at the current pointer position.
      // A single click still sends move/click on one ordered X connection.
      return input.count === 2
        ? [['mousemove', String(x), String(y)], ['click', button], ['click', button]]
        : [['mousemove', String(x), String(y), 'click', button]];
    }
    case 'drag': {
      const x = buttonPoint(input.x, IMAGE_WIDTH), y = buttonPoint(input.y, IMAGE_HEIGHT);
      const toX = buttonPoint(input.toX, IMAGE_WIDTH), toY = buttonPoint(input.toY, IMAGE_HEIGHT);
      return [
        ['mousemove', String(x), String(y)],
        ['mousedown', '1'],
        ['mousemove', String(toX), String(toY)],
        ['mouseup', '1'],
      ];
    }
    case 'type':
      if (typeof input.text !== 'string' || input.text.length < 1 ||
        Buffer.byteLength(input.text, 'utf8') > 10_000 || input.text.includes('\0'))
        throw createHttpError('Text must be 1-10000 bytes', 400);
      return [['type', '--clearmodifiers', '--delay', '1', '--', input.text]];
    case 'key':
      return [['key', '--clearmodifiers', '--', validateKey(input.key)]];
    case 'scroll': {
      if (input.direction !== 'up' && input.direction !== 'down')
        throw createHttpError('Invalid scroll direction', 400);
      if (input.steps !== undefined && (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 10))
        throw createHttpError('Scroll steps must be 1-10', 400);
      if ((input.x === undefined) !== (input.y === undefined))
        throw createHttpError('Scroll coordinates must include x and y', 400);
      const x = buttonPoint(input.x ?? Math.floor(IMAGE_WIDTH / 2), IMAGE_WIDTH);
      const y = buttonPoint(input.y ?? Math.floor(IMAGE_HEIGHT / 2), IMAGE_HEIGHT);
      return [['mousemove', String(x), String(y)],
        ...Array.from({ length: input.steps ?? 1 }, () => ['click', input.direction === 'up' ? '4' : '5'])];
    }
    default: throw createHttpError('Invalid desktop action', 400);
  }
}

export class DesktopComputer {
  private runtime: Runtime | null = null;
  private readonly owned = new Set<OwnedChild>();
  private readonly observations = new Map<string, Observation>();
  private epoch = 0;
  private revision = 0;
  private busy = false;
  private pendingCleanup: Promise<void> | null = null;
  private activeOperation: Promise<unknown> | null = null;
  private preparingDir: string | null = null;
  private readonly collisionRetainedDirs = new Set<string>();
  private closing = false;
  private shutdownPromise: Promise<void> | null = null;
  private message?: string;
  private captureState: DesktopStatus['capture'] = { ready: false };
  private lease: { actor: string; kind: 'human' | 'agent'; expiresAt: number } | null = null;
  private readonly developed = new Map<string, DevelopedRegistration>();
  private readonly developmentScopeSource: DevelopmentScopeSource;
  private readonly vncSandboxPolicy?: VncSandboxPolicy;
  private readonly vncSocketAudit?: (event: PrivateUnixEvent) => void;
  private vnc: VncStream | null = null;
  private readonly vncConnections = new Set<VncConnection>();
  private vncPending = 0;
  private borrowedTimer: NodeJS.Timeout | null = null;
  private borrowedWatcher: FSWatcher | null = null;
  private borrowedMode = false;
  private readonly borrowedProducerDirs = new Set<string>();

  /** Startup-only attachment. The producer directory contains only our VNC assets. */
  async attachBorrowedDesktop(lease: BorrowedDesktopLease, producerStateDir: string): Promise<DesktopStatus> {
    return this.withOperation(async () => {
      if (this.runtime || this.preparingDir || this.owned.size) throw createHttpError('Desktop is busy', 409);
      if (!(lease instanceof BorrowedDesktopLease)) throw createHttpError('Invalid desktop lease', 503);
      const snapshot = lease.check();
      const base = await fs.realpath(producerStateDir);
      const baseStat = await fs.lstat(base);
      if (base !== producerStateDir || !baseStat.isDirectory() ||
        base === snapshot.runtimeDir || base.startsWith(`${snapshot.runtimeDir}${path.sep}`) ||
        (baseStat.mode & 0o022) || baseStat.uid !== process.getuid())
        throw createHttpError('Producer state root is unsafe', 503);
      const dir = await fs.mkdtemp(path.join(base, 'deckide-borrowed-'));
      await fs.chmod(dir, 0o700);
      try {
        lease.check();
        const generation = ++this.epoch;
        this.borrowedMode = true;
        this.runtime = { dir, display: snapshot.display, authority: snapshot.authority,
          env: safeEnvironment(dir, snapshot.display, snapshot.authority), borrowed: lease };
        this.borrowedProducerDirs.add(dir);
        this.borrowedWatcher = lease.watch(() => { void this.revokeBorrowedDesktop(); });
        this.borrowedTimer = setInterval(() => {
          if (this.runtime?.borrowed !== lease || this.epoch !== generation) return;
          try { lease.check(); } catch { void this.revokeBorrowedDesktop(); }
        }, 1_000);
        this.borrowedTimer.unref();
        return this.status();
      } catch (error) {
        if (this.borrowedTimer) clearInterval(this.borrowedTimer);
        this.borrowedTimer = null;
        this.borrowedWatcher?.close();
        this.borrowedWatcher = null;
        if (this.runtime?.dir === dir) this.runtime = null;
        this.borrowedMode = false;
        this.borrowedProducerDirs.delete(dir);
        await fs.rm(dir, { recursive: true, force: true });
        throw error;
      }
    });
  }

  private borrowedSnapshot(runtime: Runtime): BorrowedDesktopSnapshot | null {
    if (!runtime.borrowed) return null;
    try { return runtime.borrowed.check(); }
    catch { void this.revokeBorrowedDesktop(); throw createHttpError('Borrowed desktop expired or changed', 503); }
  }

  private async revokeBorrowedDesktop(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.borrowed) return;
    this.runtime = null;
    this.epoch++;
    this.revision++;
    this.observations.clear();
    this.developed.clear();
    this.captureState = { ready: false };
    if (this.borrowedTimer) clearInterval(this.borrowedTimer);
    this.borrowedTimer = null;
    this.borrowedWatcher?.close();
    this.borrowedWatcher = null;
    this.closeVncConnections();
    const operation = this.activeOperation;
    const work = (async () => {
      if (operation) await operation.catch(() => undefined);
      await this.cleanup(runtime.dir);
    })();
    this.pendingCleanup = work;
    try { await work; } finally { if (this.pendingCleanup === work) this.pendingCleanup = null; }
  }

  private vncCapacityUsed(): number {
    return this.vncPending + [...this.owned].filter((child) => child.role === 'vnc').length;
  }

  // Runtime state is ephemeral and always outside the checkout. A private
  // per-instance directory prevents sharing Xauthority or Chrome profiles.
  constructor(private readonly tempRoot = os.tmpdir(), scopeSource: DevelopmentScopeSource = [],
    options: { vncSandbox?: VncSandboxPolicy;
      vncSocketAudit?: (event: PrivateUnixEvent) => void } = {}) {
    // Copy startup-authorized static scope data; no HTTP body can grant roots.
    this.developmentScopeSource = typeof scopeSource === 'function' ? scopeSource :
      scopeSource.map((scope) => ({ id: scope.id, root: scope.root }));
    this.vncSandboxPolicy = options.vncSandbox ? { ...options.vncSandbox } : undefined;
    this.vncSocketAudit = options.vncSocketAudit;
  }

  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw createHttpError('Desktop is shutting down', 503);
    if (this.busy || this.pendingCleanup) throw createHttpError('Desktop is busy; retry', 409);
    this.busy = true;
    const work = operation();
    this.activeOperation = work;
    try { return await work; }
    finally {
      if (this.activeOperation === work) this.activeOperation = null;
      this.busy = false;
    }
  }

  private assertOpen(epoch: number): void {
    if (this.closing || this.epoch !== epoch)
      throw createHttpError('Desktop operation was stopped', 409);
  }

  private async dependencies(): Promise<{ missing: string[]; bins: Record<string, string> }> {
    const required = ['Xvfb', 'xauth', 'xdotool', 'import', 'openbox'];
    const bins: Record<string, string> = {};
    for (const name of required) {
      const found = await executable(name);
      if (found) bins[name] = found;
    }
    return { missing: required.filter((name) => !bins[name]), bins };
  }

  private actorKind(actor: string): 'human' | 'agent' {
    if (typeof actor !== 'string' || actor.length > 256 || actor.length < 9)
      throw createHttpError('Invalid desktop actor', 400);
    if (actor.startsWith('browser:') && actor.length > 8) return 'human';
    if (actor.startsWith('oauth:') && actor.length > 6) return 'agent';
    throw createHttpError('Invalid desktop actor', 400);
  }

  private currentLease() {
    if (this.lease && this.lease.expiresAt <= Date.now()) {
      this.closeVncConnections(this.lease.actor);
      this.lease = null;
      this.observations.clear();
      this.revision++;
    }
    return this.lease;
  }

  private controlState(actor?: string): DesktopControl {
    const lease = this.currentLease();
    return lease ? { mode: lease.kind, mine: actor === lease.actor, expiresAt: lease.expiresAt }
      : { mode: 'shared', mine: false };
  }

  private requireControl(actor?: string): void {
    if (actor !== undefined) this.actorKind(actor);
    const lease = this.currentLease();
    if (lease && lease.actor !== actor) throw createHttpError('Desktop control is held by another actor', 409);
  }

  private closeVncConnection(connection: VncConnection): void {
    if (!this.vncConnections.delete(connection)) return;
    connection.closing = true;
    for (const release of connection.gate.releaseMessages()) {
      if (connection.socket.writable) connection.socket.write(release);
    }
    connection.socket.end();
    // Give queued releases a bounded chance to reach this viewer's child.
    const timer = setTimeout(() => {
      connection.socket.destroy();
      if (connection.child) this.terminateVncChild(connection.child);
    }, 250);
    timer.unref();
  }

  private terminateVncChild(child: OwnedChild): void {
    if (child.closed) return;
    child.closed = true;
    this.signalOwned(child, 'SIGTERM');
    const timer = setTimeout(() => {
      if (this.owned.has(child)) this.signalOwned(child, 'SIGKILL');
    }, 1_500);
    timer.unref();
  }

  private closeVncConnections(actor?: string): void {
    for (const connection of [...this.vncConnections]) {
      if (actor !== undefined && (!connection.controlled || connection.actor !== actor)) continue;
      this.closeVncConnection(connection);
    }
  }

  private vncInput(connection: VncConnection, _kind: 'key' | 'pointer', active: boolean): boolean {
    if (this.closing || this.pendingCleanup || !this.runtime || this.runtime !== this.vnc?.runtime ||
      connection.epoch !== this.epoch || this.vnc?.epoch !== this.epoch) return false;
    try { this.borrowedSnapshot(this.runtime); } catch { return false; }
    const lease = this.currentLease();
    if (!this.vncConnections.has(connection)) return false;
    // An in-flight API batch must not interleave a fresh press. Permit an
    // existing controller's release so a captured key/button cannot stick.
    if (this.busy && !(lease?.actor === connection.actor && connection.controlled && !active))
      return false;
    if (lease?.actor !== connection.actor) {
      if (!active || (lease && lease.kind === 'human')) return false;
      if (lease) this.closeVncConnections(lease.actor);
      this.lease = { actor: connection.actor, kind: 'human', expiresAt: Date.now() + CONTROL_MS };
      this.observations.clear();
      this.revision++;
    } else lease.expiresAt = Date.now() + CONTROL_MS;
    connection.controlled = true;
    this.observations.clear();
    this.revision++;
    return true;
  }

  private publishVncPreparation(code: number | null, signal: NodeJS.Signals | null,
    stream: VncStream): void {
    this.borrowedSnapshot(stream.runtime);
    if (!privateVncCredentialSucceeded(code, signal) || this.closing ||
      this.runtime !== stream.runtime || this.epoch !== stream.epoch)
      throw createHttpError('Private stream credential is unavailable', 503);
    this.vnc = stream;
  }

  /** Prepare a credential and attested filter. Each WebSocket gets its own child. */
  async streamInfo(actor: string): Promise<{ epoch: number; width: number; height: number; password: string }> {
    return this.withOperation(async () => {
      if (this.actorKind(actor) !== 'human') throw createHttpError('Browser session required', 403);
      if (!this.vncSandboxPolicy) throw createHttpError('Private VNC sandbox is disabled', 503);
      const runtime = this.requireStreamRuntime();
      const borrowed = this.borrowedSnapshot(runtime);
      if (this.vnc) {
        if (this.vnc.runtime !== runtime || this.vnc.epoch !== this.epoch)
          throw createHttpError('Private desktop stream is unavailable', 503);
        await this.validateVncPreparation(this.vnc);
        return { epoch: this.epoch, width: NATIVE_WIDTH, height: NATIVE_HEIGHT, password: this.vnc.password };
      }
      const binaries = await vettedVncBinaries();
      if (!binaries)
        throw createHttpError('Private VNC sandbox prerequisites are unavailable', 503);
      const { binary, setpriv } = binaries;
      const launcher = await attestedPrivateVncLauncher(this.vncSandboxPolicy.expectedLauncherSha256);
      if (!launcher) throw createHttpError('Private VNC launcher attestation failed', 503);
      if (!borrowed && !await privateVncAuthorityValid(runtime))
        throw createHttpError('Private VNC authority is unsafe', 503);
      let filterFile: string;
      try { filterFile = await writePrivateVncFilter(runtime.dir, this.vncSandboxPolicy.expectedFilterSha256); }
      catch { throw createHttpError('Private VNC sandbox attestation failed', 503); }
      const passwordFile = path.join(runtime.dir, 'rfb.passwd');
      try { await fs.lstat(passwordFile); throw createHttpError('Private stream path already exists', 503); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const password = randomBytes(12).toString('base64url').slice(0, 8);
      // The native launcher checks stdio and closes every other inherited FD.
      const diagnostic = await openPrivateVncDiagnostic(runtime.dir)
        .catch(() => { throw createHttpError('Private VNC diagnostic is unavailable', 503); });
      let credential: ChildProcess;
      try {
        const stdio: StdioOptions = ['ignore', 'ignore', diagnostic.fd];
        if (!privateVncStdioContract(stdio, null, diagnostic.fd)) throw new Error('Private child stdio changed');
        if (runtime !== this.runtime) throw new Error('Borrowed desktop changed');
        this.borrowedSnapshot(runtime);
        credential = await this.spawnOwned(launcher,
          borrowed
            ? privateVncLauncherArgs(runtime.dir, diagnostic, 'credential-borrowed', password,
              this.borrowedSnapshot(runtime)!)
            : privateVncLauncherArgs(runtime.dir, diagnostic, 'credential', password),
          safeVncEnvironment(runtime), runtime.dir, 'vnc', stdio);
      } finally { await diagnostic.close(); }
      const credentialOwned = [...this.owned].find((entry) => entry.process === credential);
      const timer = setTimeout(() => {
        if (credentialOwned) this.signalOwned(credentialOwned, 'SIGKILL');
      }, 3_000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          if (credential.exitCode !== null || credential.signalCode !== null)
            return resolve(credential.exitCode);
          credential.once('error', reject);
          credential.once('close', resolve);
        });
        if (!privateVncCredentialSucceeded(code, credential.signalCode) ||
          runtime !== this.runtime || this.closing ||
          (runtime.borrowed && !this.borrowedSnapshot(runtime)) ||
          (credentialOwned && this.verifiedMembers(credentialOwned).size))
          throw new Error('Credential generation failed');
      } catch {
        // A failed child may have created rfb.passwd. Its pathname can no longer
        // be attributed safely, so leave it for private runtime cleanup; a
        // retry fails closed until that runtime is reset.
        throw createHttpError('Private stream credential is unavailable', 503);
      }
      finally { clearTimeout(timer); }
      const passHandle = await fs.open(passwordFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await passHandle.stat();
        if (!before.isFile() || before.nlink !== 1 ||
          (typeof process.getuid === 'function' && before.uid !== process.getuid()))
          throw createHttpError('Private stream credential is unsafe', 503);
        await passHandle.chmod(0o600);
        const passStat = await fs.lstat(passwordFile);
        if (!passStat.isFile() || (passStat.mode & 0o7777) !== 0o600 ||
          passStat.nlink !== 1 ||
          passStat.dev !== before.dev || passStat.ino !== before.ino)
          throw createHttpError('Private stream credential is unsafe', 503);
      } finally { await passHandle.close(); }
      this.publishVncPreparation(credential.exitCode, credential.signalCode,
        { epoch: this.epoch, runtime, filterFile, binary, setpriv, launcher,
          passwordFile, passwordFileHash: await sha256File(passwordFile), password });
      return { epoch: this.epoch, width: NATIVE_WIDTH, height: NATIVE_HEIGHT, password };
    });
  }

  private async validateVncPreparation(stream: VncStream): Promise<void> {
    const binaries = await vettedVncBinaries();
    const borrowed = this.borrowedSnapshot(stream.runtime);
    if (!this.vncSandboxPolicy || !binaries ||
      (!borrowed && !await privateVncAuthorityValid(stream.runtime)) ||
      binaries.setpriv !== stream.setpriv || binaries.binary !== stream.binary ||
      await attestedPrivateVncLauncher(this.vncSandboxPolicy.expectedLauncherSha256) !== stream.launcher ||
      await writePrivateVncFilter(stream.runtime.dir, this.vncSandboxPolicy.expectedFilterSha256) !== stream.filterFile)
      throw createHttpError('Private VNC sandbox attestation failed', 503);
    const stat = await fs.lstat(stream.passwordFile);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 ||
      await sha256File(stream.passwordFile) !== stream.passwordFileHash ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
      throw createHttpError('Private stream credential is unsafe', 503);
  }

  /** The parent creates, accepts and unlinks a fresh private AF_UNIX endpoint.
   * Only the accepted side is duplicated into this viewer's child. */
  private async createVncPair(_runtime: Runtime): Promise<{ socket: Socket; accepted: Socket; inode: string }> {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
    let socket: Socket | null = null;
    let accepted: Socket | null = null;
    let lease: PrivateUnixLease | null = null;
    const pathnameOptions = { onEvent: this.vncSocketAudit };
    try {
      lease = await allocatePrivateUnixSocket(pathnameOptions);
      const socketPath = lease.socketPath;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path: socketPath, exclusive: true }, resolve);
      });
      lease = await recordPrivateUnixSocket(lease, pathnameOptions);
      const peer = new Promise<Socket>((resolve, reject) => {
        server.on('connection', (candidate) => {
          if (accepted) candidate.destroy();
          else { accepted = candidate; resolve(candidate); }
        });
        server.once('error', reject);
      });
      await verifyPrivateUnixSocket(lease, pathnameOptions);
      socket = createConnection({ path: socketPath, allowHalfOpen: true });
      const paired = Promise.all([peer,
        new Promise<void>((resolve, reject) => {
          socket!.once('connect', resolve);
          socket!.once('error', reject);
        })]);
      let connectionTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([paired, new Promise<never>((_resolve, reject) => {
          connectionTimer = setTimeout(() => reject(new Error('Private peer connection timed out')), 1_000);
        })]);
      } finally { if (connectionTimer) clearTimeout(connectionTimer); }
      server.close();
      const closingLease = lease;
      lease = null;
      await cleanupPrivateUnixSocket(closingLease, pathnameOptions);
      const inode = accepted && await privateAcceptedUnixIdentity(accepted);
      if (!inode || !socket || !accepted || !await privateAcceptedUnixIdentity(socket))
        throw new Error('Private accepted endpoint is not Unix');
      socket.pause();
      accepted.pause();
      // Prove the accepted FD is the peer of our outbound socket. A racing
      // connection by another same-UID process cannot receive this nonce.
      const challenge = randomBytes(32);
      const proof = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Private peer proof timed out')), 1_000);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          accepted!.off('readable', read);
          accepted!.off('error', finish);
          accepted!.off('close', closed);
          if (error) reject(error); else resolve();
        };
        const closed = () => finish(new Error('Private peer closed'));
        const read = () => {
          const received = accepted!.read(challenge.length) as Buffer | null;
          if (!received) return;
          if (!received.equals(challenge) || accepted!.readableLength !== 0)
            return finish(new Error('Private peer proof failed'));
          finish();
        };
        accepted!.on('readable', read);
        accepted!.once('error', finish);
        accepted!.once('close', closed);
        read();
      });
      socket.write(challenge);
      await proof;
      return { socket, accepted, inode };
    } catch (error) {
      socket?.destroy();
      accepted?.destroy();
      try { server.close(); } catch { /* not listening */ }
      if (lease) {
        try { await cleanupPrivateUnixSocket(lease, pathnameOptions); }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Private listener cleanup unresolved');
        }
      }
      throw error;
    }
  }

  private async awaitVncVersion(socket: Socket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Private stream did not send RFB')), 2_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.off('readable', read);
        socket.off('close', closed);
        socket.off('error', finish);
        if (error) reject(error); else resolve();
      };
      const closed = () => finish(new Error('Private stream closed'));
      const read = () => {
        const head = socket.read(12) as Buffer | null;
        if (!head) return;
        if (!['RFB 003.008\n', 'RFB 003.007\n', 'RFB 003.003\n'].includes(head.toString('ascii')))
          return finish(new Error('Private stream sent invalid RFB'));
        socket.unshift(head);
        finish();
      };
      socket.on('readable', read);
      socket.once('close', closed);
      socket.once('error', finish);
      read();
    });
  }

  /** Called only after signed-in WebSocket ticket validation. */
  async attachVncSocket(actor: string, epoch: number): Promise<{ socket: Socket; gate: RfbClientGate; close: () => void }> {
    if (this.actorKind(actor) !== 'human') throw createHttpError('Browser session required', 403);
    const stream = this.vnc;
    const runtime = this.runtime;
    if (!stream || !runtime || stream.runtime !== runtime || stream.epoch !== epoch || epoch !== this.epoch)
      throw createHttpError('Private desktop stream changed', 409);
    this.borrowedSnapshot(runtime);
    if (this.vncCapacityUsed() >= 4)
      throw createHttpError('Too many desktop stream viewers', 429);
    this.vncPending++;
    let socket: Socket | null = null;
    let accepted: Socket | null = null;
    let child: OwnedChild | undefined;
    try {
      await this.validateVncPreparation(stream);
      const pair = await this.createVncPair(runtime);
      socket = pair.socket;
      accepted = pair.accepted;
      if (stream !== this.vnc || runtime !== this.runtime || epoch !== this.epoch)
        throw new Error('Private stream changed during connection');
      const diagnostic = await openPrivateVncDiagnostic(runtime.dir);
      let proc: ChildProcess;
      try {
        if (await attestedPrivateVncLauncher(this.vncSandboxPolicy!.expectedLauncherSha256) !== stream.launcher)
          throw new Error('Private VNC launcher changed');
        const stdio: StdioOptions = [accepted, accepted, diagnostic.fd];
        if (!privateVncStdioContract(stdio, accepted, diagnostic.fd)) throw new Error('Private child stdio changed');
        if (runtime !== this.runtime) throw new Error('Borrowed desktop changed');
        this.borrowedSnapshot(runtime);
        proc = await this.spawnOwned(stream.launcher,
          runtime.borrowed
            ? privateVncLauncherArgs(runtime.dir, diagnostic, 'viewer-borrowed', runtime.display,
              pair.inode, this.borrowedSnapshot(runtime)!)
            : privateVncLauncherArgs(runtime.dir, diagnostic, 'viewer', runtime.display, pair.inode),
          safeVncEnvironment(runtime), runtime.dir, 'vnc', stdio);
      } finally { await diagnostic.close(); }
      child = [...this.owned].find((entry) => entry.process === proc);
      accepted.destroy();
      accepted = null;
      if (!child || !proc.pid || !child.start) throw new Error('Private child identity missing');
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (stream !== this.vnc || runtime !== this.runtime || epoch !== this.epoch ||
          proc.exitCode !== null || proc.signalCode !== null) break;
        const members = this.verifiedMembers(child);
        const before = processInfo(proc.pid);
        if (members.size === 1 && members.get(proc.pid) === child.start &&
          before?.start === child.start && before.group === proc.pid &&
          await privateVncNetworkIdentity(proc.pid, pair.inode, diagnostic)) {
          const after = processInfo(proc.pid);
          if (after?.start === child.start && after.group === proc.pid) { ready = true; break; }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error('Private child filter or socket attestation failed');
      await this.awaitVncVersion(socket);
      this.borrowedSnapshot(runtime);
      if (stream !== this.vnc || runtime !== this.runtime || epoch !== this.epoch ||
        this.verifiedMembers(child).get(proc.pid) !== child.start ||
        !await privateVncNetworkIdentity(proc.pid, pair.inode, diagnostic))
        throw new Error('Private child changed before RFB readiness');
      const finalWitness = processInfo(proc.pid);
      if (finalWitness?.start !== child.start || finalWitness.group !== proc.pid)
        throw new Error('Private child identity changed');
      const connection = {} as VncConnection;
      const gate = new RfbClientGate(NATIVE_WIDTH, NATIVE_HEIGHT,
        (kind, active) => this.vncInput(connection, kind, active));
      Object.assign(connection, { actor, epoch, socket, gate, controlled: false, child });
      this.vncConnections.add(connection);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => {
        this.vncConnections.delete(connection);
        if (child && !connection.closing) this.terminateVncChild(child);
      });
      return { socket, gate, close: () => this.closeVncConnection(connection) };
    } catch {
      socket?.destroy();
      accepted?.destroy();
      if (child) this.terminateVncChild(child);
      throw createHttpError('Could not establish private desktop stream', 503);
    } finally {
      this.vncPending--;
    }
  }

  private async developmentScopes(actor: string): Promise<ResolvedDevelopmentScope[]> {
    this.actorKind(actor);
    const source = this.developmentScopeSource;
    const offered = typeof source === 'function' ? await source(actor) : source;
    if (!Array.isArray(offered) || offered.length > MAX_DEVELOPMENT_SCOPES)
      throw createHttpError('Invalid configured development scopes', 503);
    const resolved: ResolvedDevelopmentScope[] = [];
    const ids = new Set<string>();
    for (const scope of offered) {
      if (!scope || typeof scope !== 'object' ||
        typeof scope.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(scope.id) ||
        ids.has(scope.id) || typeof scope.root !== 'string' ||
        !path.isAbsolute(scope.root) || scope.root.length > 4096 || scope.root.includes('\0'))
        throw createHttpError('Invalid configured development scope', 503);
      ids.add(scope.id);
      const root = await fs.realpath(scope.root).catch(() => '');
      const stat = root ? await fs.stat(root).catch(() => null) : null;
      if (stat?.isDirectory()) resolved.push({ id: scope.id, root, dev: stat.dev, ino: stat.ino });
    }
    return resolved;
  }

  private registrationScope(registration: DevelopedRegistration,
    scopes: readonly ResolvedDevelopmentScope[]): boolean {
    return scopes.some((scope) => scope.id === registration.scopeId &&
      scope.root === registration.root && scope.dev === registration.rootDev &&
      scope.ino === registration.rootIno);
  }

  private async pruneDeveloped(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.developed) {
      if (entry.expiresAt > now && entry.epoch === this.epoch) continue;
      if ([...this.owned].some((child) => child.app === id && this.verifiedMembers(child).size)) continue;
      this.developed.delete(id);
      // This is the private copy we created under the active runtime, never
      // the source artifact or a caller-supplied path.
      if (this.runtime && path.dirname(entry.command) === this.runtime.dir &&
        path.basename(entry.command).startsWith('developed-'))
        await fs.unlink(entry.command).catch(() => undefined);
    }
  }

  private terminateOwnedDeveloped(child: OwnedChild): void {
    if (child.closed || !this.signalOwned(child, 'SIGTERM')) return;
    child.closed = true;
    const timer = setTimeout(() => {
      if (this.owned.has(child) && child.closed && child.epoch === this.epoch)
        this.signalOwned(child, 'SIGKILL');
    }, 1_500);
    timer.unref();
  }

  /** Revoke only this actor's developed registrations and their owned groups. */
  revokeDevelopedScope(actor: string, scopeId: string): void {
    for (const [id, registration] of this.developed) {
      if (registration.ownerActor === actor && registration.scopeId === scopeId) {
        this.developed.delete(id);
        if (this.runtime && path.dirname(registration.command) === this.runtime.dir &&
          path.basename(registration.command).startsWith('developed-'))
          void fs.unlink(registration.command).catch(() => undefined);
      }
    }
    for (const child of this.owned) {
      if (child.role !== 'app' || child.ownerActor !== actor ||
        child.developedScopeId !== scopeId || child.closed) continue;
      this.terminateOwnedDeveloped(child);
    }
    for (const [id, observation] of this.observations)
      if (observation.actor === actor) this.observations.delete(id);
    if (this.lease?.actor === actor) {
      this.closeVncConnections(actor);
      this.lease = null;
    }
    this.revision++;
  }

  async control(actor: string, request: { action: 'claim' | 'release' | 'heartbeat' }): Promise<DesktopControl> {
    if (this.closing || this.busy || this.pendingCleanup)
      throw createHttpError('Desktop is busy; retry', 409);
    const kind = this.actorKind(actor);
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some((key) => key !== 'action') ||
      !['claim', 'release', 'heartbeat'].includes(request.action))
      throw createHttpError('Invalid control action', 400);
    const lease = this.currentLease();
    if (request.action === 'release') {
      if (lease?.actor !== actor) throw createHttpError('Desktop control is held by another actor', 409);
      this.closeVncConnections(actor);
      this.lease = null;
    } else if (request.action === 'heartbeat') {
      if (lease?.actor !== actor) throw createHttpError('Desktop control is held by another actor', 409);
      lease.expiresAt = Date.now() + CONTROL_MS;
    } else {
      if (lease && lease.actor !== actor && !(kind === 'human' && lease.kind === 'agent'))
        throw createHttpError('Desktop control is held by another actor', 409);
      if (lease && lease.actor !== actor) this.closeVncConnections(lease.actor);
      this.lease = { actor, kind, expiresAt: Date.now() + CONTROL_MS };
    }
    if (request.action !== 'heartbeat') {
      this.observations.clear();
      this.revision++;
    }
    return this.controlState(actor);
  }

  async status(actor?: string): Promise<DesktopStatus> {
    if (actor !== undefined) this.actorKind(actor);
    let borrowed = Boolean(this.runtime?.borrowed);
    if (borrowed) {
      try { this.borrowedSnapshot(this.runtime!); }
      catch { borrowed = false; }
    }
    const scopes = this.borrowedMode || actor === undefined ? [] : await this.developmentScopes(actor);
    const { missing } = process.platform === 'linux'
      ? await this.dependencies() : { missing: ['Linux'] };
    const supported = missing.length === 0;
    return { supported, running: Boolean(this.runtime) && (!this.runtime.borrowed || borrowed),
      width: this.borrowedMode ? NATIVE_WIDTH : IMAGE_WIDTH,
      height: this.borrowedMode ? NATIVE_HEIGHT : IMAGE_HEIGHT,
      epoch: this.epoch, transport: this.borrowedMode ? 'private-rfb' : 'sampled-jpeg',
      control: this.controlState(actor),
      capabilities: { unicode: false, clipboard: false, developedApps: scopes.length > 0 },
      capture: { ...this.captureState },
      ...(!supported ? { message: `Desktop requires ${missing.join(', ')}` } : this.message ? { message: this.message } : {}) };
  }

  private async spawnOwned(command: string, args: string[], env: NodeJS.ProcessEnv,
    cwd: string, role: 'desktop' | 'app' | 'vnc' = 'desktop', stdio: StdioOptions = 'ignore'): Promise<ChildProcess> {
    if (this.closing) throw createHttpError('Desktop is shutting down', 503);
    const proc = spawn(command, args, { env, cwd, detached: true, stdio, windowsHide: true });
    const epoch = this.epoch;
    const owned: OwnedChild = {
      process: proc, start: null, witnesses: new Map(), epoch, role,
    };
    this.owned.add(owned);
    proc.once('exit', () => {
      // A launcher can exit while its detached process group still has
      // descendants. Snapshot a living member before signalling the group;
      // the witness prevents a reused PGID from being targeted later.
      if (proc.pid) owned.witnesses = groupWitnesses(proc.pid);
      this.signalOwned(owned, 'SIGTERM');
      if (owned.witnesses.size) {
        const timer = setTimeout(() => {
          this.signalOwned(owned, 'SIGKILL');
          // A member stuck in uninterruptible sleep still consumes capacity.
          // Keep its verified group registered until runtime cleanup.
          if (!this.verifiedMembers(owned).size) this.owned.delete(owned);
        }, 1_500);
        timer.unref();
      } else this.owned.delete(owned);
      for (const connection of [...this.vncConnections])
        if (connection.child === owned) this.closeVncConnection(connection);
      if (this.runtime?.xvfb === proc && this.epoch === epoch) {
        const runtime = this.runtime;
        this.runtime = null;
        this.epoch++;
        this.revision++;
        this.observations.clear();
        this.developed.clear();
        this.captureState = { ready: false, error: 'Desktop process exited' };
        this.message = 'Desktop process exited; prepare it again';
        this.pendingCleanup = this.cleanup(runtime.dir).catch(() => undefined).finally(() => {
          this.pendingCleanup = null;
        });
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', resolve);
        proc.once('error', reject);
      });
      owned.start = proc.pid ? processInfo(proc.pid)?.start ?? null : null;
      if (!owned.start) {
        // No verified PID/start witness exists. Child stdio is closed by the
        // caller on failure; never signal a PID that may have been reused.
        throw new Error('Could not establish owned process identity');
      }
      if (this.closing) {
        this.signalOwned(owned, 'SIGTERM');
        throw new Error('Desktop is shutting down');
      }
      return proc;
    } catch {
      this.owned.delete(owned);
      throw createHttpError('Could not launch desktop process', 503);
    }
  }

  private signalOwned(child: OwnedChild, signal: NodeJS.Signals): boolean {
    const pid = child.process.pid;
    if (!pid) return false;
    const leader = processInfo(pid);
    const leaderMatches = Boolean(child.start && leader?.start === child.start && leader.group === pid);
    const witnessMatches = [...child.witnesses].some(([memberPid, start]) => {
      const current = processInfo(memberPid);
      return current?.group === pid && current.start === start;
    });
    if (!leaderMatches && !witnessMatches) return false;
    try { process.kill(-pid, signal); return true; } catch { return false; }
  }

  private verifiedMembers(child: OwnedChild): Map<number, string> {
    const pid = child.process.pid;
    if (!pid || child.epoch !== this.epoch || !this.owned.has(child)) return new Map();
    const leader = processInfo(pid);
    const trusted = Boolean(child.start && leader?.group === pid && leader.start === child.start) ||
      [...child.witnesses].some(([witnessPid, start]) => {
        const current = processInfo(witnessPid);
        return current?.group === pid && current.start === start;
      });
    return trusted ? groupWitnesses(pid) : new Map();
  }

  private async cleanup(dir: string): Promise<void> {
    if (this.collisionRetainedDirs.has(dir)) return;
    const hadVncConnections = this.vncConnections.size > 0;
    this.closeVncConnections();
    this.vnc = null;
    if (hadVncConnections) await new Promise((resolve) => setTimeout(resolve, 250));
    const children = [...this.owned];
    children.forEach((child) => this.signalOwned(child, 'SIGTERM'));
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(children.map(({ process: proc }) => new Promise<void>((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
          proc.once('exit', () => resolve());
        }))),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_500); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    children.forEach((child) => this.signalOwned(child, 'SIGKILL'));
    this.owned.clear();
    if (this.borrowedProducerDirs.has(dir)) {
      // Keep only the private directory we created for diagnostic review.
      // The borrowed runtime and authority are never cleanup targets.
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 ||
        stat.uid !== process.getuid() || await fs.realpath(dir) !== dir)
        throw new Error('Borrowed producer directory changed before retention');
      return;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }

  async prepare(actor?: string): Promise<DesktopStatus> {
    return this.withOperation(async () => {
      this.requireControl(actor);
      if (this.runtime) {
        this.borrowedSnapshot(this.runtime);
        return this.status(actor);
      }
      if (this.borrowedMode)
        throw createHttpError('Borrowed desktop is unavailable', 503);
      if (process.platform !== 'linux') throw createHttpError('Linux X11 desktop is unavailable', 501);
      const { missing, bins } = await this.dependencies();
      const generation = ++this.epoch;
      this.assertOpen(generation);
      if (missing.length) throw createHttpError(`Desktop requires ${missing.join(', ')}`, 503);
      const dir = await fs.mkdtemp(path.join(this.tempRoot, 'deckide-computer-'));
      this.preparingDir = dir;
      try {
        this.assertOpen(generation);
        await fs.chmod(dir, 0o700);
        const authority = path.join(dir, 'Xauthority');
        await fs.writeFile(authority, '', { mode: 0o600, flag: 'wx' });
        const envBase = safeEnvironment(dir);
        let launchFailures = 0;
        for (let number = 90; number < 210; number++) {
          this.assertOpen(generation);
          // Never reuse a display with either an existing lock or socket.
          // Xvfb still arbitrates races through its own lock; verify that lock
          // belongs to our child before making any readiness connection.
          let occupied = false;
          for (const existing of [`/tmp/.X${number}-lock`, `/tmp/.X11-unix/X${number}`]) {
            try { await fs.lstat(existing); occupied = true; break; }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          if (occupied) continue;
          const display = `:${number}`;
          await run(bins.xauth, ['-f', authority], envBase, {
            input: `add ${display} . ${randomBytes(32).toString('hex')}\n`, timeoutMs: 3_000,
          });
          this.assertOpen(generation);
          const env = safeEnvironment(dir, display, authority);
          const xvfb = await launchAfterXDisplayCollisionGuard(number, () =>
            this.spawnOwned(bins.Xvfb,
              [display, '-screen', '0', `${NATIVE_WIDTH}x${NATIVE_HEIGHT}x24`,
                '-nolisten', 'tcp', '-noreset', '-auth', authority], env, dir));
          let ready = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            this.assertOpen(generation);
            if (xvfb.exitCode !== null || xvfb.signalCode !== null) break;
            try {
              const lockPid = Number((await fs.readFile(`/tmp/.X${number}-lock`, 'utf8')).trim());
              if (lockPid !== xvfb.pid) break;
              const dimensions = (await run(bins.xdotool, ['getdisplaygeometry'], env,
                { timeoutMs: 500, maxBytes: 128 })).toString().trim();
              if (dimensions === `${NATIVE_WIDTH} ${NATIVE_HEIGHT}`) {
                ready = true;
                break;
              }
            } catch { /* wait for Xvfb */ }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          this.assertOpen(generation);
          if (!ready) {
            const own = [...this.owned].find((entry) => entry.process === xvfb);
            if (own) this.signalOwned(own, 'SIGTERM');
            if (++launchFailures >= 3)
              throw createHttpError('Could not start an isolated X11 display', 503);
            continue;
          }
          this.runtime = { dir, display, authority, env, xvfb };
          // The child may have exited after the last readiness/lock check,
          // before the exit handler could see it in this.runtime.
          if (xvfb.exitCode !== null || xvfb.signalCode !== null)
            throw createHttpError('X11 display exited during preparation', 503);
          this.revision++;
          this.captureState = { ready: false };
          this.assertOpen(generation);
          await this.spawnOwned(bins.openbox, ['--sm-disable'], env, dir);
          this.assertOpen(generation);
          this.message = undefined;
          return this.status(actor);
        }
        throw createHttpError('No free X11 display could be started', 503);
      } catch (error) {
        this.runtime = null;
        this.epoch++;
        this.observations.clear();
        this.developed.clear();
        // A fixed XKB output or lock collision leaves private preparation
        // assets in place; generic cleanup can signal children and remove dir.
        await cleanupUnlessXDisplayCollision(error, dir, this.collisionRetainedDirs,
          () => this.cleanup(dir));
        throw error;
      } finally {
        if (this.preparingDir === dir) this.preparingDir = null;
      }
    });
  }

  async stop(actor?: string): Promise<DesktopStatus> {
    return this.withOperation(async () => {
      this.requireControl(actor);
      const runtime = this.runtime;
      this.runtime = null;
      if (this.borrowedTimer) clearInterval(this.borrowedTimer);
      this.borrowedTimer = null;
      this.borrowedWatcher?.close();
      this.borrowedWatcher = null;
      this.epoch++;
      this.revision++;
      this.observations.clear();
      this.developed.clear();
      this.captureState = { ready: false };
      if (runtime) await this.cleanup(runtime.dir);
      this.message = undefined;
      return this.status(actor);
    });
  }

  /** Server shutdown must reclaim owned children even during a busy capture. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    const runtime = this.runtime;
    this.runtime = null;
    if (this.borrowedTimer) clearInterval(this.borrowedTimer);
    this.borrowedTimer = null;
    this.borrowedWatcher?.close();
    this.borrowedWatcher = null;
    this.epoch++;
    this.revision++;
    this.observations.clear();
    this.developed.clear();
    this.captureState = { ready: false };
    const operation = this.activeOperation;
    const existingCleanup = this.pendingCleanup;
    this.shutdownPromise = (async () => {
      // A prepared runtime cannot encounter a pre-spawn collision. A still
      // preparing directory must wait until prepare decides whether to retain it.
      if (runtime) await this.cleanup(runtime.dir);
      let operationSettled = true;
      if (operation) {
        let timer: NodeJS.Timeout | undefined;
        try {
          operationSettled = await Promise.race([
            operation.then(() => true, () => true),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 10_000); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      }
      if (existingCleanup) await existingCleanup;
      const lateDir = this.preparingDir;
      // If preparation has not settled, ownership of its assets is uncertain.
      if (operationSettled && lateDir) await this.cleanup(lateDir);
    })();
    return this.shutdownPromise;
  }

  private requireRuntime(): Runtime {
    if (!this.runtime) throw createHttpError('Prepare the desktop first', 409);
    if (this.runtime.borrowed)
      throw createHttpError('Borrowed desktop supports private streaming only', 403);
    return this.runtime;
  }

  private requireStreamRuntime(): Runtime {
    if (!this.runtime) throw createHttpError('Prepare the desktop first', 409);
    this.borrowedSnapshot(this.runtime);
    return this.runtime;
  }

  private async appBinary(app: DesktopAppId): Promise<string | null> {
    const entry = desktopApp(app);
    if (!entry) return null;
    for (const name of entry.binaries) {
      const found = await executable(name);
      if (found) return found;
    }
    return null;
  }

  async registerDeveloped(actor: string, request: unknown) {
    return this.withOperation(async () => {
      this.actorKind(actor);
      const runtime = this.requireRuntime();
      const generation = this.epoch;
      await this.pruneDeveloped();
      if (this.developed.size >= 8) throw createHttpError('Developed app registration limit reached', 409);
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some((key) => !['scopeId', 'executable', 'args', 'cwd'].includes(key)))
        throw createHttpError('Invalid developed app request', 400);
      const values = request as Record<string, unknown>;
      if (typeof values.scopeId !== 'string' || typeof values.executable !== 'string' ||
        typeof values.cwd !== 'string' || !values.executable || !values.cwd ||
        values.executable.length > 4096 || values.cwd.length > 4096 ||
        values.executable.includes('\0') || values.cwd.includes('\0') ||
        !Array.isArray(values.args) || values.args.length > 32 ||
        values.args.some((arg) => typeof arg !== 'string' || arg.length > 512 || arg.includes('\0')))
        throw createHttpError('Invalid developed app request', 400);
      const argv = values.args as string[];
      const scope = (await this.developmentScopes(actor)).find((entry) => entry.id === values.scopeId);
      if (!scope) throw createHttpError('Development scope is unavailable', 403);
      this.assertOpen(generation);
      const sourcePath = path.isAbsolute(values.executable)
        ? values.executable : path.resolve(scope.root, values.executable);
      const cwdPath = path.isAbsolute(values.cwd) ? values.cwd : path.resolve(scope.root, values.cwd);
      const [candidate, cwd] = await Promise.all([
        fs.realpath(sourcePath).catch(() => ''), fs.realpath(cwdPath).catch(() => ''),
      ]);
      if (!candidate || !cwd || !withinRoot(candidate, scope.root) || !withinRoot(cwd, scope.root))
        throw createHttpError('Developed app path is outside selected scope', 403);
      const [stat, cwdStat] = await Promise.all([fs.stat(candidate), fs.stat(cwd)]);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || !(stat.mode & 0o111) ||
        (stat.mode & 0o6000) || !cwdStat.isDirectory())
        throw createHttpError('Invalid developed executable or working directory', 400);
      if (['sh', 'bash', 'dash', 'zsh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'env'].includes(path.basename(candidate)))
        throw createHttpError('Interpreter launch is unavailable', 400);
      const content = await fs.readFile(candidate);
      if (content.length > 32 * 1024 * 1024) throw createHttpError('Developed executable is too large', 400);
      const usedBytes = [...this.developed.values()].reduce((sum, entry) => sum + entry.size, 0);
      if (usedBytes + content.length > 64 * 1024 * 1024)
        throw createHttpError('Developed app storage limit reached', 409);
      const hash = createHash('sha256').update(content).digest('hex');
      const id = `developed:${randomUUID()}` as const;
      const command = path.join(runtime.dir, `developed-${id.slice(10)}`);
      this.assertOpen(generation);
      await fs.writeFile(command, content, { mode: 0o700, flag: 'wx' });
      try {
        this.assertOpen(generation);
        const currentScope = (await this.developmentScopes(actor)).find((entry) =>
          entry.id === scope.id && entry.root === scope.root &&
          entry.dev === scope.dev && entry.ino === scope.ino);
        if (!currentScope) throw createHttpError('Development scope changed during registration', 409);
        const expiresAt = Date.now() + DEVELOPED_MS;
        this.developed.set(id, { label: path.basename(candidate).slice(0, 128), command,
          args: [...argv], cwd, root: scope.root, rootDev: scope.dev, rootIno: scope.ino,
          cwdDev: cwdStat.dev, cwdIno: cwdStat.ino, hash, size: content.length,
          ownerActor: actor, scopeId: scope.id, epoch: generation, expiresAt });
        return { id, label: path.basename(candidate).slice(0, 128), sha256: hash, expiresAt };
      } catch (error) {
        await fs.unlink(command).catch(() => undefined);
        throw error;
      }
    });
  }

  private async windowDetails(runtime: Runtime, child: OwnedChild): Promise<Array<{ id: string; title: string }>> {
    const members = this.verifiedMembers(child);
    if (!members.size) return [];
    const xdotool = await executable('xdotool');
    if (!xdotool) return [];
    let ids: string[];
    try {
      ids = (await run(xdotool, ['search', '--onlyvisible', '--name', '.'], runtime.env,
        { timeoutMs: 2_000, maxBytes: 16_384 })).toString().trim().split(/\s+/);
    } catch { return []; }
    const windows: Array<{ id: string; title: string }> = [];
    for (const id of ids.slice(0, 256)) {
      if (!/^\d{1,12}$/.test(id)) continue;
      try {
        const owner = Number((await run(xdotool, ['getwindowpid', id], runtime.env,
          { timeoutMs: 1_000, maxBytes: 64 })).toString().trim());
        if (!members.has(owner) || processInfo(owner)?.start !== members.get(owner)) continue;
        const title = (await run(xdotool, ['getwindowname', id], runtime.env,
          { timeoutMs: 1_000, maxBytes: 1024 })).toString().trim();
        windows.push({ id, title: title.slice(0, 256) || child.label || 'Application' });
      } catch { /* window exited or lacks PID */ }
    }
    return windows;
  }

  async apps(actor: string) {
    this.actorKind(actor);
    if (this.runtime?.borrowed) {
      this.borrowedSnapshot(this.runtime);
      return { apps: [], instances: [], control: this.controlState(actor), developmentScopes: [] };
    }
    const epoch = this.epoch;
    const currentRuntime = this.runtime;
    const builtins = await Promise.all(desktopAppCatalog.map(async (entry) => {
      const binary = await this.appBinary(entry.id);
      const available = Boolean(binary) && !(entry.id === 'browser' && process.getuid?.() === 0);
      return { id: entry.id, label: entry.label, available,
        ...(!available ? { reason: !binary ? 'Application is not installed' : 'Browser requires a non-root server' } : {}) };
    }));
    const system = await systemDesktopApps();
    const instances = [];
    const runtime = this.runtime;
    if (runtime) for (const child of this.owned) {
      if (child.role !== 'app' || child.closed || !child.app || !child.instanceId ||
        !this.verifiedMembers(child).size) continue;
      instances.push({ id: child.instanceId, app: child.app, label: child.label ?? desktopApp(child.app)?.label ?? 'Application',
        windows: await this.windowDetails(runtime, child) });
    }
    if (epoch !== this.epoch || currentRuntime !== this.runtime)
      throw createHttpError('Desktop changed; refresh apps', 409);
    const scopes = await this.developmentScopes(actor);
    const now = Date.now();
    const catalog = [...builtins,
      ...system.map((entry) => ({ id: entry.id, label: entry.label, available: true })),
      ...[...this.developed].filter(([, entry]) => entry.ownerActor === actor &&
        entry.epoch === epoch && entry.expiresAt > now && this.registrationScope(entry, scopes))
        .map(([id, entry]) => ({ id, label: entry.label, available: Boolean(this.runtime) }))];
    if (epoch !== this.epoch || currentRuntime !== this.runtime)
      throw createHttpError('Desktop changed; refresh apps', 409);
    return { apps: catalog, instances, control: this.controlState(actor),
      developmentScopes: scopes.map(({ id, root }) => ({ id, root })) };
  }

  async launch(request: { app: DesktopAppId; url?: string }, actor?: string): Promise<DesktopStatus & { instanceId: string }> {
    return this.withOperation(async () => {
      this.requireControl(actor);
      const runtime = this.requireRuntime();
      const parsed = validateLaunchRequest(request);
      if ([...this.owned].filter((child) => child.role === 'app' &&
        this.verifiedMembers(child).size).length >= 4)
        throw createHttpError('Desktop app limit reached', 409);
      const system = parsed.app.startsWith('system:')
        ? (await systemDesktopApps()).find((entry) => entry.id === parsed.app) : undefined;
      const developed = parsed.app.startsWith('developed:') ? this.developed.get(parsed.app) : undefined;
      if (parsed.app.startsWith('developed:')) {
        if (!developed) throw createHttpError('Developed app is unavailable', 404);
        if (developed.ownerActor !== actor) throw createHttpError('Developed app belongs to another actor', 403);
        if (developed.epoch !== this.epoch) throw createHttpError('Developed app belongs to an earlier desktop', 409);
        if (developed.expiresAt <= Date.now()) throw createHttpError('Developed app registration expired', 410);
        const scopes = await this.developmentScopes(actor!);
        if (!this.registrationScope(developed, scopes))
          throw createHttpError('Development scope is no longer authorized', 403);
      }
      const command = system?.command ?? developed?.command ?? await this.appBinary(parsed.app);
      if (!command) throw createHttpError('Desktop application is unavailable', 503);
      if (developed) {
        const artifact = await fs.lstat(command).catch(() => null);
        if (!artifact?.isFile() || artifact.size > 32 * 1024 * 1024 ||
          !(artifact.mode & 0o111) || (artifact.mode & 0o6000))
          throw createHttpError('Developed app artifact changed after registration', 409);
        const current = createHash('sha256').update(await fs.readFile(command)).digest('hex');
        if (current !== developed.hash) throw createHttpError('Developed app changed after registration', 409);
        const currentCwd = await fs.realpath(developed.cwd).catch(() => '');
        const currentCwdStat = currentCwd ? await fs.stat(currentCwd).catch(() => null) : null;
        if (currentCwd !== developed.cwd ||
          !currentCwdStat?.isDirectory() || currentCwdStat.dev !== developed.cwdDev ||
          currentCwdStat.ino !== developed.cwdIno ||
          !withinRoot(currentCwd, developed.root))
          throw createHttpError('Developed app working directory changed after registration', 409);
        const scopes = await this.developmentScopes(actor!);
        if (!this.registrationScope(developed, scopes) || developed.expiresAt <= Date.now())
          throw createHttpError('Development scope or registration changed before launch', 409);
      }
      const postStatus = await this.status(actor);
      if (developed) {
        const scopes = await this.developmentScopes(actor!);
        if (!this.registrationScope(developed, scopes) || developed.expiresAt <= Date.now())
          throw createHttpError('Development scope or registration changed before launch', 409);
      }
      const instanceId = randomUUID();
      let args: string[];
      if (parsed.app === 'browser') {
        if (process.getuid?.() === 0)
          throw createHttpError('Browser launch requires a non-root DeckIDE process', 503);
        args = ['--ozone-platform=x11', '--no-first-run', '--no-default-browser-check',
          `--user-data-dir=${path.join(runtime.dir, `browser-${instanceId}`)}`,
          '--disable-dev-shm-usage', '--disable-background-networking', parsed.url ?? 'about:blank'];
      } else if (parsed.app === 'terminal') {
        args = ['-title', 'DeckIDE desktop', '-geometry', '100x30+24+24'];
      } else args = system?.args ?? developed?.args ?? [];
      this.observations.clear();
      this.revision++;
      const proc = await this.spawnOwned(command, args, runtime.env, developed?.cwd ?? runtime.dir, 'app');
      const child = [...this.owned].find((entry) => entry.process === proc);
      if (!child) throw createHttpError('Application exited during launch', 503);
      child.app = parsed.app;
      child.ownerActor = actor;
      child.developedScopeId = developed?.scopeId;
      child.label = system?.label ?? developed?.label ?? desktopApp(parsed.app)?.label;
      child.instanceId = instanceId;
      if (developed) {
        const scopes = await this.developmentScopes(actor!);
        if (!this.registrationScope(developed, scopes) || !this.developed.has(parsed.app)) {
          this.terminateOwnedDeveloped(child);
          throw createHttpError('Development scope ended during launch', 409);
        }
      }
      return { ...postStatus, instanceId };
    });
  }

  async focus(actor: string, request: { instanceId: string; windowId: string }): Promise<DesktopStatus> {
    return this.withOperation(async () => {
      this.requireControl(actor);
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some((key) => !['instanceId', 'windowId'].includes(key)) ||
        typeof request.instanceId !== 'string' || typeof request.windowId !== 'string')
        throw createHttpError('Invalid window selection', 400);
      const runtime = this.requireRuntime();
      const child = [...this.owned].find((entry) => entry.instanceId === request.instanceId &&
        entry.role === 'app' && !entry.closed && this.verifiedMembers(entry).size);
      if (!child || !(await this.windowDetails(runtime, child)).some((window) => window.id === request.windowId))
        throw createHttpError('Window is no longer owned by this desktop app', 404);
      const xdotool = await executable('xdotool');
      if (!xdotool) throw createHttpError('xdotool is unavailable', 503);
      // Recheck immediately before sending the private-display focus command.
      if (!(await this.windowDetails(runtime, child)).some((window) => window.id === request.windowId))
        throw createHttpError('Window is no longer owned by this desktop app', 404);
      await run(xdotool, ['windowactivate', '--sync', request.windowId], runtime.env,
        { timeoutMs: 2_000 });
      this.observations.clear();
      this.revision++;
      return this.status(actor);
    });
  }

  async closeApp(actor: string, request: { instanceId: string }): Promise<DesktopStatus> {
    return this.withOperation(async () => {
      this.requireControl(actor);
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some((key) => key !== 'instanceId') || typeof request.instanceId !== 'string')
        throw createHttpError('Invalid app selection', 400);
      this.requireRuntime();
      const child = [...this.owned].find((entry) => entry.instanceId === request.instanceId &&
        entry.role === 'app' && !entry.closed && this.verifiedMembers(entry).size);
      if (!child) throw createHttpError('Desktop app is no longer running', 404);
      if (!this.signalOwned(child, 'SIGTERM'))
        throw createHttpError('Desktop app exited before it could be closed', 409);
      child.closed = true;
      const timer = setTimeout(() => {
        if (this.owned.has(child) && child.closed && child.epoch === this.epoch)
          this.signalOwned(child, 'SIGKILL');
      }, 1_500);
      timer.unref();
      this.observations.clear();
      this.revision++;
      return this.status(actor);
    });
  }

  async screenshot(actor: string, previousHash?: string) {
    return this.withOperation(async () => {
      const runtime = this.requireRuntime();
      this.actorKind(actor);
      if (previousHash !== undefined && (typeof previousHash !== 'string' || !/^[a-f0-9]{64}$/.test(previousHash)))
        throw createHttpError('Invalid previous hash', 400);
      const command = await executable('import');
      if (!command) throw createHttpError('ImageMagick import is unavailable', 503);
      let jpeg: Buffer;
      try {
        jpeg = await run(command, ['-display', runtime.display, '-window', 'root',
          '-resize', `${IMAGE_WIDTH}x${IMAGE_HEIGHT}!`, '-quality', '72', 'jpeg:-'], runtime.env,
        // ImageMagick 7's import alias can resolve to the shared magick binary.
        // Preserve the vetted tool identity after canonical executable lookup.
        { timeoutMs: 8_000, maxBytes: MAX_IMAGE_BYTES, argv0: 'import' });
      } catch {
        this.captureState = { ready: false, error: 'Desktop capture failed' };
        throw createHttpError('Desktop capture failed', 503);
      }
      if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
        jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9)
        { this.captureState = { ready: false, error: 'Invalid desktop frame' };
          throw createHttpError('Desktop capture failed', 503); }
      if (runtime !== this.runtime) throw createHttpError('Desktop changed; capture again', 409);
      const hash = createHash('sha256').update(jpeg).digest('hex');
      const now = Date.now();
      this.captureState = { ready: true, capturedAt: now };
      for (const [id, observation] of this.observations)
        if (now - observation.createdAt > OBSERVATION_MS) this.observations.delete(id);
      while (this.observations.size >= MAX_OBSERVATIONS)
        this.observations.delete(this.observations.keys().next().value!);
      const observationId = randomUUID();
      this.observations.set(observationId, { actor, createdAt: now, epoch: this.epoch, revision: this.revision });
      return { observationId, epoch: this.epoch, width: IMAGE_WIDTH, height: IMAGE_HEIGHT, hash,
        ...(previousHash === hash ? { unchanged: true as const } :
          { image: { type: 'image' as const, mimeType: 'image/jpeg' as const, data: jpeg.toString('base64') } }) };
    });
  }

  async input(actor: string, input: DesktopInput): Promise<{ executed: true; requiresObservation: true }> {
    return this.withOperation(async () => {
      this.requireControl(actor);
      const runtime = this.requireRuntime();
      const observation = typeof input?.observationId === 'string'
        ? this.observations.get(input.observationId) : undefined;
      if (!observation || observation.actor !== actor ||
        Date.now() - observation.createdAt > OBSERVATION_MS ||
        observation.epoch !== this.epoch || observation.revision !== this.revision)
        throw createHttpError('A fresh screenshot is required before desktop input', 409);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw createHttpError('Invalid desktop input', 400);
      let actions: DesktopAction[];
      if (input.actions !== undefined) {
        if (Object.keys(input).some((key) => key !== 'observationId' && key !== 'actions') ||
          !Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 32)
          throw createHttpError('Invalid desktop action batch', 400);
        actions = input.actions;
      } else {
        const { observationId: _observationId, ...action } = input;
        actions = [action as DesktopAction];
      }
      const commands = actions.flatMap((action) => desktopInputCommands(action));
      const xdotool = await executable('xdotool');
      if (!xdotool) throw createHttpError('xdotool is unavailable', 503);
      // Consumption precedes the first side effect, including failure halfway
      // through a drag. Every actor must observe the resulting display again.
      this.observations.clear();
      this.revision++;
      try {
        for (const args of commands) await run(xdotool, args, runtime.env, { timeoutMs: 5_000 });
      } catch {
        // A partially executed drag must release the pointer before returning.
        if (actions.some((action) => action.action === 'drag')) await run(xdotool, ['mouseup', '1'], runtime.env,
          { timeoutMs: 1_000 }).catch(() => undefined);
        throw createHttpError('Desktop input failed; observe before retrying', 503);
      }
      return { executed: true, requiresObservation: true };
    });
  }
}
