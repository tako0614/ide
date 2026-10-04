import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBorrowedDesktopDescriptor, type BorrowedDesktopLease,
  type BorrowedDesktopSnapshot } from './borrowed-desktop.js';

const LAUNCHER = fileURLToPath(new URL('../../ops/chatgpt-launcher/product/launch-chatgpt.sh', import.meta.url));
const DEFAULT_STATE_ROOT = '/root/dev/deckide-chatgpt-20261004';
const MAX_READY_BYTES = 1024;
const READY_TIMEOUT_MS = 75_000;
const CLOSE_TIMEOUT_MS = 15_000;

type ProcessIdentity = { pid: number; start: number; uid: number; gid: number; ppid: number; state: string };
type Binding = { sessionId: string; supervisor: ProcessIdentity; ownerPid: number };
type Lease = Pick<BorrowedDesktopLease, 'check'>;
type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type ExitOutcome = { code: number | null; signal: NodeJS.Signals | null };
export type ChatgptOwnerDependencies = {
  spawn?: Spawn;
  loadLease?: (descriptor: string) => Promise<BorrowedDesktopLease>;
  readBinding?: (descriptor: string) => Binding;
  processIdentity?: (pid: number) => ProcessIdentity | null;
  verifyLauncher?: (launcher: string) => void;
  verifyStateRoot?: (stateRoot: string) => void;
  readyTimeoutMs?: number;
  closeTimeoutMs?: number;
};
export type OwnedChatgptDesktop = Readonly<{ lease: BorrowedDesktopLease; snapshot: BorrowedDesktopSnapshot }>;
type Retained = {
  child: ChildProcess; identity: ProcessIdentity; exit: Promise<ExitOutcome>;
  exited: boolean; exitOutcome?: ExitOutcome; protocolValid: boolean;
  lease?: BorrowedDesktopLease; sessionId?: string;
};

function fail(): never { throw new Error('ChatGPT desktop ownership could not be verified'); }
function sameIdentity(a: ProcessIdentity, b: ProcessIdentity | null): boolean {
  return b !== null && a.pid === b.pid && a.start === b.start &&
    a.uid === b.uid && a.gid === b.gid && b.ppid === process.pid &&
    !['Z', 'X', 'z', 'x'].includes(b.state);
}
function trustedParentDirectories(file: string): void {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || realpathSync(file) !== file) fail();
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022)) fail();
    if (dir === '/') break;
  }
}
function verifyLauncher(file: string): void {
  trustedParentDirectories(file);
  const info = lstatSync(file);
  if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== 0o755 ||
    info.nlink !== 1) fail();
}
function verifyStateRoot(root: string): void {
  const product = path.dirname(LAUNCHER);
  if (root === product || root.startsWith(product + path.sep) ||
    root === path.join(path.dirname(product), 'source') ||
    root.startsWith(path.join(path.dirname(product), 'source') + path.sep)) fail();
  trustedParentDirectories(root);
  const info = lstatSync(root);
  if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== 0o700) fail();
}
function processIdentity(pid: number): ProcessIdentity | null {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    const info = statSync(`/proc/${pid}`);
    const start = Number(tail[19]);
    const ppid = Number(tail[1]);
    if (!Number.isSafeInteger(start) || start <= 0 || !Number.isSafeInteger(ppid) || ppid < 1) return null;
    return { pid, start, uid: info.uid, gid: info.gid, ppid, state: tail[0] };
  } catch { return null; }
}
function readBinding(file: string): Binding {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    const entry = lstatSync(file);
    if (!info.isFile() || info.uid !== 0 || info.gid !== 0 ||
      (info.mode & 0o7777) !== 0o600 || info.nlink !== 1 ||
      info.size <= 0 || info.size > 1024 * 1024 ||
      entry.dev !== info.dev || entry.ino !== info.ino) fail();
    const data = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, any>;
    const supervisor = data.supervisor;
    if (data.schema !== 'chatgpt-private-desktop/v2' || data.state !== 'ready' ||
      data.lifecycle_mode !== 'deckide-owned' ||
      typeof data.session_id !== 'string' || !/^[a-f0-9]{32}$/.test(data.session_id) ||
      !supervisor || !data.owner_process) fail();
    return { sessionId: data.session_id, ownerPid: data.owner_process.pid,
      supervisor: { pid: supervisor.pid, start: supervisor.starttime_ticks,
        uid: supervisor.owner_uid, gid: supervisor.owner_gid,
        ppid: supervisor.ppid, state: supervisor.state } };
  } finally { closeSync(fd); }
}
function waitWithTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

/** Owns exactly one direct foreground launcher generation for this backend process. */
export class ChatgptOwner {
  private readonly launcher = LAUNCHER;
  private readonly stateRoot: string;
  private readonly descriptor: string;
  private readonly deps: Required<ChatgptOwnerDependencies>;
  private retained: Retained | null = null;
  private starting: Promise<OwnedChatgptDesktop> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;

  constructor(stateRoot?: string, dependencies: ChatgptOwnerDependencies = {}) {
    this.stateRoot = stateRoot ?? DEFAULT_STATE_ROOT;
    this.descriptor = path.join(this.stateRoot, 'app-session.json');
    this.deps = {
      spawn: dependencies.spawn ?? ((command, args, options) => spawn(command, [...args], options)),
      loadLease: dependencies.loadLease ?? loadBorrowedDesktopDescriptor,
      readBinding: dependencies.readBinding ?? readBinding,
      processIdentity: dependencies.processIdentity ?? processIdentity,
      verifyLauncher: dependencies.verifyLauncher ?? verifyLauncher,
      verifyStateRoot: dependencies.verifyStateRoot ?? verifyStateRoot,
      readyTimeoutMs: dependencies.readyTimeoutMs ?? READY_TIMEOUT_MS,
      closeTimeoutMs: dependencies.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
    };
  }

  async start(): Promise<OwnedChatgptDesktop> {
    if (this.closed) fail();
    if (this.starting) return this.starting;
    if (this.retained) return this.reuse(this.retained);
    const promise = this.startNew();
    this.starting = promise;
    try { return await promise; }
    finally { if (this.starting === promise) this.starting = null; }
  }

  private reuse(retained: Retained): OwnedChatgptDesktop {
    if (retained.exited || !retained.protocolValid || !retained.lease || !retained.sessionId) fail();
    try {
      const snapshot = retained.lease.check();
      if (snapshot.lifecycleMode !== 'deckide-owned' || snapshot.sessionId !== retained.sessionId ||
        !sameIdentity(retained.identity, this.deps.processIdentity(retained.identity.pid))) fail();
      return { lease: retained.lease, snapshot };
    } catch { return fail(); }
  }

  private retain(child: ChildProcess): Retained {
    const pid = child.pid;
    const identity = pid === undefined ? null : this.deps.processIdentity(pid);
    if (!identity || identity.pid !== pid || identity.uid !== 0 || identity.gid !== 0 ||
      identity.ppid !== process.pid || ['Z', 'X', 'z', 'x'].includes(identity.state)) fail();
    const retained: Retained = { child, identity, exited: false, protocolValid: true,
      exit: Promise.resolve({ code: null, signal: null }) };
    retained.exit = new Promise((resolve) => child.once('exit', (code, signal) => {
      retained.exited = true;
      retained.exitOutcome = { code, signal };
      resolve(retained.exitOutcome);
    }));
    child.on('error', () => { retained.protocolValid = false; });
    return retained;
  }

  private readyPath(retained: Retained): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdout = retained.child.stdout;
      if (!stdout) { reject(new Error('missing stdout')); return; }
      const expected = this.descriptor + '\n';
      let received = '';
      let done = false;
      const rejectProtocol = () => {
        retained.protocolValid = false;
        if (!done) { done = true; reject(new Error('invalid readiness')); }
      };
      stdout.on('data', (chunk: Buffer) => {
        if (!retained.protocolValid) return;
        if (chunk.length > MAX_READY_BYTES - Buffer.byteLength(received)) {
          rejectProtocol(); return;
        }
        received += chunk.toString('utf8');
        if (Buffer.byteLength(received) > MAX_READY_BYTES || !expected.startsWith(received)) {
          rejectProtocol(); return;
        }
        if (received === expected && !done) { done = true; resolve(); }
      });
      stdout.on('error', rejectProtocol);
      retained.child.once('error', rejectProtocol);
      retained.exit.then(rejectProtocol);
    });
  }

  private binding(retained: Retained, lease: Lease): string {
    const first = lease.check();
    const binding = this.deps.readBinding(this.descriptor);
    const second = lease.check();
    if (retained.exited || !retained.protocolValid ||
      first.lifecycleMode !== 'deckide-owned' || second.lifecycleMode !== 'deckide-owned' ||
      !first.sessionId || first.sessionId !== second.sessionId ||
      first.sessionId !== binding.sessionId || binding.ownerPid !== process.pid ||
      !sameIdentity(retained.identity, binding.supervisor) ||
      !sameIdentity(retained.identity, this.deps.processIdentity(retained.identity.pid))) fail();
    return binding.sessionId;
  }

  private async startNew(): Promise<OwnedChatgptDesktop> {
    let retained: Retained | null = null;
    try {
      if (process.getuid?.() !== 0 || process.getgid?.() !== 0) fail();
      this.deps.verifyLauncher(this.launcher);
      if (this.stateRoot !== DEFAULT_STATE_ROOT) this.deps.verifyStateRoot(this.stateRoot);
      const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
        ...(this.stateRoot !== DEFAULT_STATE_ROOT ? { CHATGPT_LAUNCHER_STATE_ROOT: this.stateRoot } : {}) };
      const child = this.deps.spawn(this.launcher, ['run', '--lifecycle', 'deckide-owned'],
        { shell: false, detached: false, env, stdio: ['ignore', 'pipe', 'ignore'] });
      // Spawn errors can arrive after an unusable PID; consume them even if identity capture fails.
      child.on('error', () => undefined);
      retained = this.retain(child);
      this.retained = retained;
      await waitWithTimeout(this.readyPath(retained), this.deps.readyTimeoutMs);
      const lease = await this.deps.loadLease(this.descriptor);
      retained.sessionId = this.binding(retained, lease);
      retained.lease = lease;
      if (this.closed) fail();
      return this.reuse(retained);
    } catch {
      if (retained) await this.terminateRetained(retained);
      return fail();
    }
  }

  private async terminateRetained(retained: Retained): Promise<void> {
    if (retained.exited) return;
    if (!sameIdentity(retained.identity, this.deps.processIdentity(retained.identity.pid))) fail();
    if (!retained.child.kill('SIGTERM')) fail();
    try { await waitWithTimeout(retained.exit, this.deps.closeTimeoutMs); }
    catch { fail(); }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const closing = this.closeOwned();
    this.closing = closing;
    return closing;
  }

  private async closeOwned(): Promise<void> {
    try {
      if (this.starting && this.retained && !this.retained.lease) {
        await this.terminateRetained(this.retained);
      }
      if (this.starting) await this.starting.catch(() => undefined);
      const retained = this.retained;
      if (!retained) return;
      // A child that exited before the guarded stop has not completed our close.
      if (retained.exited) fail();
      if (!retained.lease || !retained.sessionId) fail();
      this.binding(retained, retained.lease);
      this.deps.verifyLauncher(this.launcher);
      if (this.stateRoot !== DEFAULT_STATE_ROOT) this.deps.verifyStateRoot(this.stateRoot);
      const deadline = Date.now() + this.deps.closeTimeoutMs;
      const stopped = this.deps.spawn(this.launcher, ['stop', '--session-id', retained.sessionId],
        { shell: false, detached: false, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
          ...(this.stateRoot !== DEFAULT_STATE_ROOT ? { CHATGPT_LAUNCHER_STATE_ROOT: this.stateRoot } : {}) },
          stdio: ['ignore', 'ignore', 'ignore'] });
      const stopExit = new Promise<number | null>((resolve, reject) => {
        stopped.once('exit', (code) => resolve(code));
        stopped.once('error', reject);
      });
      const code = await waitWithTimeout(stopExit, Math.max(1, deadline - Date.now()));
      if (code !== 0) fail();
      const outcome = await waitWithTimeout(retained.exit, Math.max(1, deadline - Date.now()));
      if (outcome.code !== 0 || outcome.signal !== null) fail();
    } catch { fail(); }
  }
}
