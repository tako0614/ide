import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBorrowedDesktopDescriptor, type BorrowedDesktopLease,
  type BorrowedDesktopSnapshot } from './borrowed-desktop.js';
import { descriptorValidationBoundary, rejectDescriptorValidation } from './descriptor-validation.js';

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

const OWNERSHIP_ERROR = 'ChatGPT desktop ownership could not be verified';
type Detail = { role?: string; pid?: unknown; field?: string; expected?: unknown; observed?: unknown };
function fail(predicate: string, details?: Detail): never {
  return rejectDescriptorValidation(predicate, details, undefined, OWNERSHIP_ERROR);
}
function boundary(predicate: string, error: unknown, details?: Detail): Error {
  return descriptorValidationBoundary(predicate, error, OWNERSHIP_ERROR, details);
}
function requireIdentity(a: ProcessIdentity, b: ProcessIdentity | null, predicatePart: string): void {
  const role = 'supervisor';
  if (!b) fail(`owner.${predicatePart}.present`, { role, pid: a.pid, field: 'process_identity', expected: true, observed: false });
  for (const field of ['pid', 'start', 'uid', 'gid'] as const) {
    if (a[field] !== b[field]) fail(`owner.${predicatePart}.${field}`, { role, pid: a.pid, field,
      expected: a[field], observed: b[field] });
  }
  if (b.ppid !== process.pid) fail(`owner.${predicatePart}.ppid`, { role, pid: a.pid, field: 'ppid',
    expected: process.pid, observed: b.ppid });
  if (['Z', 'X', 'z', 'x'].includes(b.state)) fail(`owner.${predicatePart}.state`, { role, pid: a.pid,
    field: 'state', expected: true, observed: b.state });
}
function trustedParentDirectories(file: string): void {
  if (!path.isAbsolute(file)) fail('owner.path.absolute', { field: 'path', expected: true, observed: false });
  if (path.normalize(file) !== file) fail('owner.path.normalized', { field: 'path', expected: true, observed: false });
  try { if (realpathSync(file) !== file) fail('owner.path.realpath', { field: 'path', expected: true, observed: false }); }
  catch (error) { throw boundary('owner.path.realpath.read', error); }
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let info;
    try { info = lstatSync(dir); }
    catch (error) { throw boundary('owner.path.parent.read', error); }
    if (!info.isDirectory()) fail('owner.path.parent.type', { field: 'type', expected: true, observed: false });
    if (info.uid !== 0) fail('owner.path.parent.uid', { field: 'uid', expected: 0, observed: info.uid });
    if (info.gid !== 0) fail('owner.path.parent.gid', { field: 'gid', expected: 0, observed: info.gid });
    if (info.mode & 0o022) fail('owner.path.parent.mode', { field: 'mode', expected: 0, observed: info.mode & 0o022 });
    if (dir === '/') break;
  }
}
function verifyLauncher(file: string): void {
  trustedParentDirectories(file);
  let info;
  try { info = lstatSync(file); }
  catch (error) { throw boundary('owner.launcher.read', error); }
  if (!info.isFile()) fail('owner.launcher.type', { role: 'owner', field: 'type', expected: true, observed: false });
  if (info.uid !== 0) fail('owner.launcher.uid', { role: 'owner', field: 'uid', expected: 0, observed: info.uid });
  if (info.gid !== 0) fail('owner.launcher.gid', { role: 'owner', field: 'gid', expected: 0, observed: info.gid });
  if ((info.mode & 0o7777) !== 0o755) fail('owner.launcher.mode', { role: 'owner', field: 'mode', expected: 0o755, observed: info.mode & 0o7777 });
  if (info.nlink !== 1) fail('owner.launcher.nlink', { role: 'owner', field: 'nlink', expected: 1, observed: info.nlink });
}
function verifyStateRoot(root: string): void {
  const product = path.dirname(LAUNCHER);
  if (root === product || root.startsWith(product + path.sep) ||
    root === path.join(path.dirname(product), 'source') ||
    root.startsWith(path.join(path.dirname(product), 'source') + path.sep)) fail('owner.state_root.separation', { role: 'owner', field: 'separation', expected: true, observed: false });
  trustedParentDirectories(root);
  let info;
  try { info = lstatSync(root); }
  catch (error) { throw boundary('owner.state_root.read', error); }
  if (!info.isDirectory()) fail('owner.state_root.type', { role: 'owner', field: 'type', expected: true, observed: false });
  if (info.uid !== 0) fail('owner.state_root.uid', { role: 'owner', field: 'uid', expected: 0, observed: info.uid });
  if (info.gid !== 0) fail('owner.state_root.gid', { role: 'owner', field: 'gid', expected: 0, observed: info.gid });
  if ((info.mode & 0o7777) !== 0o700) fail('owner.state_root.mode', { role: 'owner', field: 'mode', expected: 0o700, observed: info.mode & 0o7777 });
}
function processIdentity(pid: number): ProcessIdentity | null {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      boundary('owner.process_identity.pid', new Error('invalid pid'),
        { role: 'supervisor', pid, field: 'pid', expected: true, observed: false });
      return null;
    }
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    const info = statSync(`/proc/${pid}`);
    const start = Number(tail[19]);
    const ppid = Number(tail[1]);
    if (!Number.isSafeInteger(start) || start <= 0) {
      boundary('owner.process_identity.start', new Error('invalid start'),
        { role: 'supervisor', pid, field: 'start', expected: true, observed: false });
      return null;
    }
    if (!Number.isSafeInteger(ppid) || ppid < 1) {
      boundary('owner.process_identity.ppid', new Error('invalid ppid'),
        { role: 'supervisor', pid, field: 'ppid', expected: true, observed: false });
      return null;
    }
    return { pid, start, uid: info.uid, gid: info.gid, ppid, state: tail[0] };
  } catch (error) { boundary('owner.process_identity.read', error, { role: 'supervisor', pid }); return null; }
}
function readBinding(file: string): Binding {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw boundary('owner.read_binding.open', error); }
  let primary: unknown;
  try {
    const info = fstatSync(fd);
    const entry = lstatSync(file);
    if (!info.isFile()) fail('owner.read_binding.type', { role: 'descriptor', field: 'type', expected: true, observed: false });
    if (info.uid !== 0) fail('owner.read_binding.uid', { role: 'descriptor', field: 'uid', expected: 0, observed: info.uid });
    if (info.gid !== 0) fail('owner.read_binding.gid', { role: 'descriptor', field: 'gid', expected: 0, observed: info.gid });
    if ((info.mode & 0o7777) !== 0o600) fail('owner.read_binding.mode', { role: 'descriptor', field: 'mode', expected: 0o600, observed: info.mode & 0o7777 });
    if (info.nlink !== 1) fail('owner.read_binding.nlink', { role: 'descriptor', field: 'nlink', expected: 1, observed: info.nlink });
    if (info.size <= 0) fail('owner.read_binding.size_min', { role: 'descriptor', field: 'size', expected: 1, observed: info.size });
    if (info.size > 1024 * 1024) fail('owner.read_binding.size_max', { role: 'descriptor', field: 'size', expected: 1024 * 1024, observed: info.size });
    if (entry.dev !== info.dev) fail('owner.read_binding.device', { role: 'descriptor', field: 'dev', expected: info.dev, observed: entry.dev });
    if (entry.ino !== info.ino) fail('owner.read_binding.inode', { role: 'descriptor', field: 'ino', expected: info.ino, observed: entry.ino });
    const data = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, any>;
    if (data.schema !== 'chatgpt-private-desktop/v2') fail('owner.read_binding.schema', { role: 'descriptor', field: 'schema', expected: 'chatgpt-private-desktop/v2', observed: data.schema });
    if (data.state !== 'ready') fail('owner.read_binding.state', { role: 'descriptor', field: 'state', expected: 'ready', observed: data.state });
    if (data.lifecycle_mode !== 'deckide-owned') fail('owner.read_binding.lifecycle_mode', { role: 'descriptor', field: 'lifecycle_mode', expected: 'deckide-owned', observed: data.lifecycle_mode });
    if (typeof data.session_id !== 'string' || !/^[a-f0-9]{32}$/.test(data.session_id)) fail('owner.read_binding.session_id', { role: 'descriptor', field: 'session_id', expected: true, observed: false });
    if (!data.supervisor) fail('owner.read_binding.supervisor', { role: 'descriptor', field: 'supervisor', expected: true, observed: false });
    if (!data.owner_process) fail('owner.read_binding.owner_process', { role: 'descriptor', field: 'owner_process', expected: true, observed: false });
    const supervisor = data.supervisor;
    return { sessionId: data.session_id, ownerPid: data.owner_process.pid,
      supervisor: { pid: supervisor.pid, start: supervisor.starttime_ticks,
        uid: supervisor.owner_uid, gid: supervisor.owner_gid,
        ppid: supervisor.ppid, state: supervisor.state } };
  } catch (error) {
    primary = boundary('owner.read_binding', error);
    throw primary;
  } finally {
    try { closeSync(fd); }
    catch (error) {
      const closeError = boundary('owner.read_binding.close', error);
      if (!primary) throw closeError;
    }
  }
}
function waitWithTimeout<T>(promise: Promise<T>, milliseconds: number, predicate: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(boundary(predicate, new Error('timeout'))), milliseconds);
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
    if (this.closed) fail('owner.start.closed', { field: 'closed', expected: false, observed: true });
    if (this.starting) return this.starting;
    if (this.retained) return this.reuse(this.retained);
    const promise = this.startNew();
    this.starting = promise;
    try { return await promise; }
    finally { if (this.starting === promise) this.starting = null; }
  }

  private observedIdentity(pid: number, predicate: string): ProcessIdentity | null {
    try { return this.deps.processIdentity(pid); }
    catch (error) { throw boundary(predicate, error); }
  }

  private reuse(retained: Retained): OwnedChatgptDesktop {
    if (retained.exited) fail('owner.reuse.exited', { role: 'supervisor', pid: retained.identity.pid, field: 'exited', expected: false, observed: true });
    if (!retained.protocolValid) fail('owner.reuse.protocol', { role: 'supervisor', pid: retained.identity.pid, field: 'protocol_valid', expected: true, observed: false });
    if (!retained.lease) fail('owner.reuse.lease', { field: 'lease', expected: true, observed: false });
    if (!retained.sessionId) fail('owner.reuse.session_id', { field: 'session_id', expected: true, observed: false });
    try {
      let snapshot: BorrowedDesktopSnapshot;
      try { snapshot = retained.lease.check(); }
      catch (error) { throw boundary('owner.reuse.lease_check', error); }
      if (snapshot.lifecycleMode !== 'deckide-owned') fail('owner.reuse.lifecycle_mode', { field: 'lifecycle_mode', expected: 'deckide-owned', observed: snapshot.lifecycleMode });
      if (snapshot.sessionId !== retained.sessionId) fail('owner.reuse.session_id_match', { field: 'session_id', expected: true, observed: false });
      requireIdentity(retained.identity, this.observedIdentity(retained.identity.pid,
        'owner.reuse.process_identity'), 'reuse_identity');
      return { lease: retained.lease, snapshot };
    } catch (error) { throw boundary('owner.reuse', error); }
  }

  private retain(child: ChildProcess): Retained {
    const pid = child.pid;
    const identity = pid === undefined ? null : this.observedIdentity(pid, 'owner.retain.process_identity');
    if (!identity) fail('owner.retain.identity', { role: 'supervisor', pid, field: 'identity', expected: true, observed: false });
    if (identity.pid !== pid) fail('owner.retain.pid', { role: 'supervisor', pid, field: 'pid', expected: pid, observed: identity.pid });
    if (identity.uid !== 0) fail('owner.retain.uid', { role: 'supervisor', pid, field: 'uid', expected: 0, observed: identity.uid });
    if (identity.gid !== 0) fail('owner.retain.gid', { role: 'supervisor', pid, field: 'gid', expected: 0, observed: identity.gid });
    if (identity.ppid !== process.pid) fail('owner.retain.ppid', { role: 'supervisor', pid, field: 'ppid', expected: process.pid, observed: identity.ppid });
    if (['Z', 'X', 'z', 'x'].includes(identity.state)) fail('owner.retain.state', { role: 'supervisor', pid, field: 'state', expected: 'live', observed: 'dead' });
    const retained: Retained = { child, identity, exited: false, protocolValid: true,
      exit: Promise.resolve({ code: null, signal: null }) };
    retained.exit = new Promise((resolve) => child.once('exit', (code, signal) => {
      retained.exited = true;
      retained.exitOutcome = { code, signal };
      resolve(retained.exitOutcome);
    }));
    child.on('error', (error) => { retained.protocolValid = false; boundary('owner.supervisor.error', error); });
    return retained;
  }

  private readyPath(retained: Retained): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdout = retained.child.stdout;
      if (!stdout) { reject(boundary('owner.ready.stdout', new Error('missing stdout'))); return; }
      const expected = this.descriptor + '\n';
      let received = '';
      let done = false;
      const rejectProtocol = (predicate: string, error?: unknown) => {
        retained.protocolValid = false;
        const rejection = error ? boundary(predicate, error) : boundary(predicate, new Error('invalid readiness'));
        if (!done) { done = true; reject(rejection); }
      };
      stdout.on('data', (chunk: Buffer) => {
        if (!retained.protocolValid) return;
        if (chunk.length > MAX_READY_BYTES - Buffer.byteLength(received)) {
          rejectProtocol('owner.ready.byte_limit'); return;
        }
        received += chunk.toString('utf8');
        if (Buffer.byteLength(received) > MAX_READY_BYTES || !expected.startsWith(received)) {
          rejectProtocol('owner.ready.prefix'); return;
        }
        if (received === expected && !done) { done = true; resolve(); }
      });
      stdout.on('error', (error) => rejectProtocol('owner.ready.stdout_error', error));
      retained.child.once('error', (error) => rejectProtocol('owner.ready.child_error', error));
      retained.exit.then(() => {
        if (!done) rejectProtocol('owner.ready.early_exit');
        else retained.protocolValid = false;
      });
    });
  }

  private binding(retained: Retained, lease: Lease): string {
    let first: BorrowedDesktopSnapshot;
    try { first = lease.check(); }
    catch (error) { throw boundary('owner.binding.first_lease_check', error); }
    let binding: Binding;
    try { binding = this.deps.readBinding(this.descriptor); }
    catch (error) { throw boundary('owner.binding.read_binding', error); }
    let second: BorrowedDesktopSnapshot;
    try { second = lease.check(); }
    catch (error) { throw boundary('owner.binding.second_lease_check', error); }
    if (retained.exited) fail('owner.binding.exited', { role: 'supervisor', pid: retained.identity.pid, field: 'exited', expected: false, observed: true });
    if (!retained.protocolValid) fail('owner.binding.protocol', { role: 'supervisor', pid: retained.identity.pid, field: 'protocol_valid', expected: true, observed: false });
    if (first.lifecycleMode !== 'deckide-owned') fail('owner.binding.first_lifecycle_mode', { field: 'lifecycle_mode', expected: 'deckide-owned', observed: first.lifecycleMode });
    if (second.lifecycleMode !== 'deckide-owned') fail('owner.binding.second_lifecycle_mode', { field: 'lifecycle_mode', expected: 'deckide-owned', observed: second.lifecycleMode });
    if (!first.sessionId) fail('owner.binding.session_id', { field: 'session_id', expected: true, observed: false });
    if (first.sessionId !== second.sessionId) fail('owner.binding.lease_session_match', { field: 'session_id', expected: true, observed: false });
    if (first.sessionId !== binding.sessionId) fail('owner.binding.binding_session_match', { field: 'session_id', expected: true, observed: false });
    if (binding.ownerPid !== process.pid) fail('owner.binding.owner_pid', { role: 'owner', pid: binding.ownerPid, field: 'owner_pid', expected: process.pid, observed: binding.ownerPid });
    requireIdentity(retained.identity, binding.supervisor, 'binding_supervisor');
    requireIdentity(retained.identity, this.observedIdentity(retained.identity.pid,
      'owner.binding.process_identity'), 'binding_live');
    return binding.sessionId;
  }

  private async startNew(): Promise<OwnedChatgptDesktop> {
    let retained: Retained | null = null;
    try {
      if (process.getuid?.() !== 0) fail('owner.start.uid', { role: 'owner', field: 'uid', expected: 0, observed: process.getuid?.() });
      if (process.getgid?.() !== 0) fail('owner.start.gid', { role: 'owner', field: 'gid', expected: 0, observed: process.getgid?.() });
      try { this.deps.verifyLauncher(this.launcher); }
      catch (error) { throw boundary('owner.start.verify_launcher', error); }
      if (this.stateRoot !== DEFAULT_STATE_ROOT) {
        try { this.deps.verifyStateRoot(this.stateRoot); }
        catch (error) { throw boundary('owner.start.verify_state_root', error); }
      }
      const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
        ...(this.stateRoot !== DEFAULT_STATE_ROOT ? { CHATGPT_LAUNCHER_STATE_ROOT: this.stateRoot } : {}) };
      let child: ChildProcess;
      try { child = this.deps.spawn(this.launcher, ['run', '--lifecycle', 'deckide-owned'],
        { shell: false, detached: false, env, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch (error) { throw boundary('owner.start.spawn', error); }
      // Spawn errors can arrive after an unusable PID; consume them even if identity capture fails.
      child.on('error', (error) => { boundary('owner.start.spawn_error', error); });
      retained = this.retain(child);
      this.retained = retained;
      await waitWithTimeout(this.readyPath(retained), this.deps.readyTimeoutMs, 'owner.ready.timeout');
      let lease: BorrowedDesktopLease;
      try { lease = await this.deps.loadLease(this.descriptor); }
      catch (error) { throw boundary('owner.start.load_lease', error); }
      retained.sessionId = this.binding(retained, lease);
      retained.lease = lease;
      if (this.closed) fail('owner.start.closed_during_prepare', { field: 'closed', expected: false, observed: true });
      return this.reuse(retained);
    } catch (error) {
      const primary = boundary('owner.start_new', error);
      if (retained) {
        try { await this.terminateRetained(retained); }
        catch (cleanupError) { boundary('owner.start_cleanup', cleanupError); }
      }
      throw primary;
    }
  }

  private async terminateRetained(retained: Retained): Promise<void> {
    if (retained.exited) return;
    requireIdentity(retained.identity, this.observedIdentity(retained.identity.pid,
      'owner.cleanup.process_identity'), 'cleanup_identity');
    let signalled: boolean;
    try { signalled = retained.child.kill('SIGTERM'); }
    catch (error) { throw boundary('owner.cleanup.signal', error); }
    if (!signalled) fail('owner.cleanup.signal_result', { role: 'supervisor', pid: retained.identity.pid, field: 'signal', expected: true, observed: false });
    try { await waitWithTimeout(retained.exit, this.deps.closeTimeoutMs, 'owner.cleanup.exit_timeout'); }
    catch (error) { throw boundary('owner.cleanup.exit', error); }
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
      if (this.starting) await this.starting.catch((error) => {
        boundary('owner.close.wait_start', error);
      });
      const retained = this.retained;
      if (!retained) return;
      // A child that exited before the guarded stop has not completed our close.
      if (retained.exited) fail('owner.close.exited', { role: 'supervisor', pid: retained.identity.pid, field: 'exited', expected: false, observed: true });
      if (!retained.lease) fail('owner.close.lease', { field: 'lease', expected: true, observed: false });
      if (!retained.sessionId) fail('owner.close.session_id', { field: 'session_id', expected: true, observed: false });
      this.binding(retained, retained.lease);
      try { this.deps.verifyLauncher(this.launcher); }
      catch (error) { throw boundary('owner.close.verify_launcher', error); }
      if (this.stateRoot !== DEFAULT_STATE_ROOT) {
        try { this.deps.verifyStateRoot(this.stateRoot); }
        catch (error) { throw boundary('owner.close.verify_state_root', error); }
      }
      const deadline = Date.now() + this.deps.closeTimeoutMs;
      let stopped: ChildProcess;
      try { stopped = this.deps.spawn(this.launcher, ['stop', '--session-id', retained.sessionId],
        { shell: false, detached: false, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
          ...(this.stateRoot !== DEFAULT_STATE_ROOT ? { CHATGPT_LAUNCHER_STATE_ROOT: this.stateRoot } : {}) },
          stdio: ['ignore', 'ignore', 'ignore'] }); }
      catch (error) { throw boundary('owner.close.spawn_stop', error); }
      const stopExit = new Promise<number | null>((resolve, reject) => {
        stopped.once('exit', (code) => resolve(code));
        stopped.once('error', (error) => reject(boundary('owner.close.stop_error', error)));
      });
      const code = await waitWithTimeout(stopExit, Math.max(1, deadline - Date.now()), 'owner.close.stop_timeout');
      if (code !== 0) fail('owner.close.stop_exit_code', { role: 'owner', field: 'exit_code', expected: 0, observed: code });
      const outcome = await waitWithTimeout(retained.exit, Math.max(1, deadline - Date.now()), 'owner.close.supervisor_timeout');
      if (outcome.code !== 0) fail('owner.close.supervisor_exit_code', { role: 'supervisor', pid: retained.identity.pid, field: 'exit_code', expected: 0, observed: outcome.code });
      if (outcome.signal !== null) fail('owner.close.supervisor_signal', { role: 'supervisor', pid: retained.identity.pid, field: 'signal', expected: null, observed: outcome.signal });
    } catch (error) { throw boundary('owner.close_owned', error); }
  }
}
