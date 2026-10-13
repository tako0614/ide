import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync,
  readlinkSync, realpathSync, watch, type FSWatcher, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { rejectDescriptorValidation, descriptorValidationBoundary } from './descriptor-validation.js';

type Identity = { pid: number; starttime_ticks: number; owner_uid: number; owner_gid: number;
  comm: string; ppid: number; pgid: number; state?: string };
type Descriptor = {
  schema: string; state: string; created_utc: string; expires_utc: string;
  lifetime_seconds: number | null; uid: number; gid: number; runtime_dir: string;
  XAUTHORITY: string; DISPLAY: string; supervisor: Identity; processes: Identity[];
  xvfb_owner_differs_from_app: boolean; xvfb_owner_uid: number;
  desktop_owner_uid: number; dbus_owner_uid: number; chatgpt_owner_uid: number;
  x11_tcp_listening: boolean; x11_authentication: string; sandbox_disabled: boolean;
  root_desktop_mode?: boolean; app_user?: string;
  root_credentials_inherited: boolean;
  lifecycle_mode?: string; session_id?: string; session_deadline_utc?: string | null;
  owner_process?: Identity | null; anchors?: Record<string, Identity>;
  heartbeat_interval_seconds?: number; heartbeat_valid_seconds?: number | null;
  heartbeat_sequence?: number; updated_utc?: string;
};
export type BorrowedDesktopSnapshot = Readonly<{
  runtimeDir: string; authority: string; display: string; uid: number; gid: number;
  authDev: number; authIno: number; expiresEpochMs: number;
  lifecycleMode: 'bounded' | 'deckide-owned'; sessionId?: string;
}>;
type Probe = { readFile(file: string): string; readlink(file: string): string;
  lstat(file: string): Stats; realpath(file: string): string; now(): number };
const systemProbe: Probe = {
  readFile: (file) => readFileSync(file, 'utf8'),
  readlink: (file) => readlinkSync(file),
  lstat: (file) => lstatSync(file),
  realpath: (file) => realpathSync(file),
  now: () => Date.now(),
};

const fail = rejectDescriptorValidation;
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function canonicalDirectory(file: string, uid: number, gid?: number, exactMode?: number,
  probe: Pick<Probe, 'lstat' | 'realpath'> = systemProbe): void {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) fail('path.directory.canonical');
  const stat = probe.lstat(file);
  if (!stat.isDirectory() || stat.uid !== uid || (gid !== undefined && stat.gid !== gid) ||
    (exactMode !== undefined ? (stat.mode & 0o7777) !== exactMode : Boolean(stat.mode & 0o022)) ||
    probe.realpath(file) !== file) fail('path.directory.identity');
}
function trustedDescriptorPath(file: string): void {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) fail('path.descriptor.canonical');
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    canonicalDirectory(dir, 0, 0);
    if (dir === '/') break;
  }
}
function readDescriptor(file: string): { data: Descriptor; hash: string } {
  trustedDescriptorPath(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const entry = lstatSync(file);
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 ||
      (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 ||
      stat.size <= 0 || stat.size > 1024 * 1024 || entry.dev !== stat.dev || entry.ino !== stat.ino)
      fail('descriptor.file.identity');
    const raw = readFileSync(fd, 'utf8');
    return { data: JSON.parse(raw) as Descriptor,
      hash: createHash('sha256').update(raw).digest('hex') };
  } finally { closeSync(fd); }
}
function processIdentity(value: Identity): boolean {
  return value && integer(value.pid, 2) && integer(value.starttime_ticks, 1) &&
    integer(value.owner_uid) && integer(value.owner_gid) && integer(value.ppid) &&
    integer(value.pgid) && typeof value.comm === 'string' &&
    /^[A-Za-z0-9_.+-]{1,15}$/.test(value.comm);
}
function sameIdentity(a: Identity, b: Identity): boolean {
  return a.pid === b.pid && a.starttime_ticks === b.starttime_ticks &&
    a.owner_uid === b.owner_uid && a.owner_gid === b.owner_gid &&
    a.comm === b.comm && a.ppid === b.ppid && a.pgid === b.pgid;
}
function anchorProcesses(data: Descriptor): Identity[] {
  if (!processIdentity(data.supervisor) || data.supervisor.owner_uid !== 0 ||
    data.supervisor.owner_gid !== 0 || data.supervisor.comm !== 'python3' ||
    !Array.isArray(data.processes) || data.processes.length < 5 || data.processes.length > 512 ||
    !data.processes.every(processIdentity) ||
    new Set([data.supervisor.pid, ...data.processes.map((p) => p.pid)]).size !== data.processes.length + 1)
    fail('bounded.anchors.inventory');
  const find = (comm: string, ppid: number, uid: number) => {
    const hits = data.processes.filter((p) => p.comm === comm && p.ppid === ppid && p.owner_uid === uid);
    if (hits.length !== 1) fail('bounded.anchors.lookup');
    return hits[0];
  };
  const xvfb = find('Xvfb', data.supervisor.pid, 0);
  const dbusSession = find('dbus-run-sessio', data.supervisor.pid, data.uid);
  const session = find('python3', dbusSession.pid, data.uid);
  const dbus = find('dbus-daemon', dbusSession.pid, data.uid);
  const openbox = find('openbox', session.pid, data.uid);
  const app = find('ChatGPT', session.pid, data.uid);
  if (xvfb.pgid !== xvfb.pid || dbusSession.pgid !== dbusSession.pid ||
    session.pgid !== dbusSession.pid || dbus.pgid !== dbusSession.pid ||
    openbox.pgid !== dbusSession.pid || app.pgid !== dbusSession.pid) fail('bounded.anchors.process_group');
  const anchors = [data.supervisor, xvfb, dbusSession, session, dbus, openbox, app];
  if (xvfb.owner_gid !== 0 || anchors.slice(2).some((item) =>
    item.owner_uid !== data.uid || item.owner_gid !== data.gid)) fail('bounded.anchors.ownership');
  const anchored = new Set(anchors.map((item) => item.pid));
  for (const item of data.processes) {
    if (!anchored.has(item.pid) && (item.owner_uid !== data.uid || item.owner_gid !== data.gid)) fail('bounded.auxiliary.ownership');
  }
  return anchors;
}
function rollingAnchors(data: Descriptor): Identity[] {
  const named = data.anchors;
  const names = ['xvfb', 'desktop_runner', 'dbus', 'openbox', 'chatgpt'];
  if (!named || typeof named !== 'object' || Array.isArray(named) ||
    Object.keys(named).sort().join(',') !== [...names].sort().join(',') ||
    !processIdentity(data.supervisor) || data.supervisor.owner_uid !== 0 ||
    data.supervisor.owner_gid !== 0 || data.supervisor.comm !== 'python3' ||
    !Array.isArray(data.processes) || data.processes.length > 4096 ||
    !data.processes.every(processIdentity) ||
    new Set(data.processes.map((p) => p.pid)).size !== data.processes.length)
    fail('rolling.anchors.inventory');
  const anchors = [data.supervisor, ...names.map((name) => named[name])];
  if (!anchors.every(processIdentity) || new Set(anchors.map((p) => p.pid)).size !== anchors.length ||
    named.xvfb.comm !== 'Xvfb' || named.xvfb.owner_uid !== 0 || named.xvfb.owner_gid !== 0 ||
    named.xvfb.ppid !== data.supervisor.pid ||
    named.desktop_runner.comm !== 'dbus-run-sessio' ||
    named.desktop_runner.ppid !== data.supervisor.pid ||
    named.dbus.comm !== 'dbus-daemon' || named.openbox.comm !== 'openbox' ||
    named.chatgpt.comm !== 'ChatGPT' ||
    anchors.slice(2).some((p) => p.owner_uid !== data.uid || p.owner_gid !== data.gid)) fail('rolling.anchors.identity');
  const anchored = new Set(anchors.map((p) => p.pid));
  for (const item of data.processes) {
    if (anchored.has(item.pid)) {
      const stable = anchors.find((anchor) => anchor.pid === item.pid)!;
      if (item.starttime_ticks !== stable.starttime_ticks ||
        item.owner_uid !== stable.owner_uid || item.owner_gid !== stable.owner_gid) fail('rolling.anchors.snapshot_identity');
    } else if (item.owner_uid !== data.uid || item.owner_gid !== data.gid) fail('rolling.auxiliary.ownership');
  }
  return anchors;
}
type Namespace = 'pid' | 'user' | 'mnt' | 'net';
function verifyProcess(identity: Identity, probe: Probe, procRoot: string,
  baseline: Record<Namespace, string>, hostAnchor: boolean,
  auxiliary = false, requireAlive = false, role = 'auxiliary', retryAuxiliaryExit = true): void {
  const detail = (field: string, expected: unknown, observed: unknown) =>
    ({ role, pid: identity.pid, field, expected, observed });
  try {
    const dir = `${procRoot}/${identity.pid}`;
    const names: Namespace[] = ['pid', 'user', 'mnt', 'net'];
    const statMatches = (stat: string, read: string) => {
      const close = stat.lastIndexOf(') ');
      const open = stat.indexOf(' (');
      if (open < 1 || close < open) fail('process.stat.format', detail('stat', true, false));
      const pid = Number(stat.slice(0, open));
      if (pid !== identity.pid) fail('process.stat.pid', detail('pid', identity.pid, pid));
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      if (Number(fields[19]) !== identity.starttime_ticks)
        fail(`process.${read}.starttime`, detail('starttime', identity.starttime_ticks, Number(fields[19])));
      if (!auxiliary) {
        if (Number(fields[1]) !== identity.ppid)
          fail(`process.${read}.ppid`, detail('ppid', identity.ppid, Number(fields[1])));
        if (Number(fields[2]) !== identity.pgid)
          fail(`process.${read}.pgid`, detail('pgid', identity.pgid, Number(fields[2])));
        if (stat.slice(open + 2, close) !== identity.comm)
          fail(`process.${read}.comm`, detail('comm', identity.comm, stat.slice(open + 2, close)));
      }
      if (requireAlive && ['Z', 'X', 'x'].includes(fields[0]))
        fail(`process.${read}.alive`, detail('state', true, fields[0]));
      return fields[0];
    };
    const ownerMatches = (status: string, read: string) => {
      for (const [name, expected] of [['Uid', identity.owner_uid], ['Gid', identity.owner_gid]] as const) {
        const match = new RegExp(`^${name}:\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*$`, 'm').exec(status);
        if (!match) fail('process.status.format', detail(name.toLowerCase(), true, false));
        const slots = ['real', 'effective', 'saved', 'fs'];
        for (let index = 1; index <= 4; index++) {
          const observed = Number(match[index]);
          if (observed !== expected) {
            const field = `${name.toLowerCase()}.${slots[index - 1]}`;
            fail(`process.${read}.${field}`, detail(field, expected, observed));
          }
        }
      }
    };
    // Exited-but-not-reaped auxiliaries have no execution authority. Linux
    // may already remove mnt/net namespace links while stat/status remain.
    // Prove terminal state twice with the same PID/start and every UID/GID slot.
    if (auxiliary && !hostAnchor && !requireAlive) {
      const state = statMatches(probe.readFile(`${dir}/stat`), 'read1');
      ownerMatches(probe.readFile(`${dir}/status`), 'read1');
      if (['Z', 'X', 'x'].includes(state)) {
        const second = statMatches(probe.readFile(`${dir}/stat`), 'read2');
        ownerMatches(probe.readFile(`${dir}/status`), 'read2');
        if (!['Z', 'X', 'x'].includes(second))
          fail('auxiliary.terminal_state.changed', detail('state', state, second));
        return;
      }
    }
    const namespace = Object.fromEntries(names.map((name) =>
      [name, probe.readlink(`${dir}/ns/${name}`)])) as Record<Namespace, string>;
    for (const name of names) {
      if (!new RegExp(`^${name}:\\[\\d+\\]$`).test(namespace[name]))
        fail('process.namespace.format', detail(name, true, false));
      if (hostAnchor && name !== 'user' && namespace[name] !== baseline[name])
        fail('process.namespace.host', detail(name, baseline[name], namespace[name]));
    }
    statMatches(probe.readFile(`${dir}/stat`), 'read1');
    ownerMatches(probe.readFile(`${dir}/status`), 'read1');
    // Keep both observations and original stable identity/namespace checks.
    statMatches(probe.readFile(`${dir}/stat`), 'read2');
    ownerMatches(probe.readFile(`${dir}/status`), 'read2');
    for (const name of names) {
      const observed = probe.readlink(`${dir}/ns/${name}`);
      if (observed !== namespace[name])
        fail('process.namespace.changed', detail(name, namespace[name], observed));
    }
  } catch (error) {
    const errno = error && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    // A live auxiliary can exit between the stat and namespace reads. Retry its
    // full identity proof once before the lease's permanent invalidation path.
    if (auxiliary && !hostAnchor && !requireAlive && retryAuxiliaryExit &&
        (errno === 'ENOENT' || errno === 'ESRCH'))
      return verifyProcess(identity, probe, procRoot, baseline, hostAnchor,
        auxiliary, requireAlive, role, false);
    throw descriptorValidationBoundary('process.readback.catch', error, undefined,
      { role, pid: identity.pid, field: 'procfs' });
  }
}

type Publication = { mode: 'bounded' | 'deckide-owned'; sessionId?: string;
  createdEpochMs: number; updatedEpochMs?: number; sequence?: number };
function descriptorSnapshot(data: Descriptor, probe: Probe, procRoot: string):
  { snapshot: BorrowedDesktopSnapshot; anchors: Identity[]; publication: Publication;
    owner?: Identity } {
  const created = Date.parse(data.created_utc);
  const expires = Date.parse(data.expires_utc);
  const rolling = data.schema === 'chatgpt-private-desktop/v2';
  const bounded = data.schema === 'chatgpt-private-desktop/v1';
  const rootMode = data.root_desktop_mode === true;
  const expectedUid = rootMode ? 0 : 993;
  const expectedGid = rootMode ? 0 : 982;
  const now = probe.now();
  if (!rolling && !bounded || data.state !== 'ready' ||
    !Number.isFinite(created) || !Number.isFinite(expires) || expires <= now ||
    rolling && data.lifecycle_mode !== 'deckide-owned' ||
    bounded && data.lifecycle_mode !== undefined && data.lifecycle_mode !== 'bounded' ||
    rootMode && data.app_user !== 'root' ||
    data.uid !== expectedUid || data.gid !== expectedGid ||
    data.xvfb_owner_differs_from_app !== !rootMode || data.xvfb_owner_uid !== 0 ||
    data.desktop_owner_uid !== expectedUid || data.dbus_owner_uid !== expectedUid ||
    data.chatgpt_owner_uid !== expectedUid || data.x11_tcp_listening !== false ||
    data.x11_authentication !== 'MIT-MAGIC-COOKIE-1' ||
    data.sandbox_disabled !== rootMode || data.root_credentials_inherited !== rootMode ||
    !/^:[1-9]\d{1,3}$/.test(data.DISPLAY)) fail('descriptor.metadata');
  let publication: Publication;
  if (rolling) {
    const updated = Date.parse(data.updated_utc ?? '');
    if (!/^[a-f0-9]{32}$/.test(data.session_id ?? '') ||
      data.session_deadline_utc !== null || data.lifetime_seconds !== null ||
      data.heartbeat_interval_seconds !== 2 || data.heartbeat_valid_seconds !== 10 ||
      !integer(data.heartbeat_sequence, 1) || !Number.isFinite(updated) ||
      updated < created || updated > now + 2_000 || now - updated > 10_000 ||
      expires - updated !== 10_000) fail('rolling.publication');
    publication = { mode: 'deckide-owned', sessionId: data.session_id,
      createdEpochMs: created, updatedEpochMs: updated,
      sequence: data.heartbeat_sequence };
  } else {
    if (!integer(data.lifetime_seconds, 60) || data.lifetime_seconds > 3600 ||
      expires - created > (data.lifetime_seconds + 1) * 1000 ||
      data.session_id !== undefined && !/^[a-f0-9]{32}$/.test(data.session_id)) fail('bounded.publication');
    publication = { mode: 'bounded', sessionId: data.session_id, createdEpochMs: created };
  }
  canonicalDirectory(data.runtime_dir, data.uid, data.gid, 0o700, probe);
  if (!path.isAbsolute(data.XAUTHORITY) || path.normalize(data.XAUTHORITY) !== data.XAUTHORITY ||
    path.dirname(data.XAUTHORITY) !== data.runtime_dir ||
    probe.realpath(data.XAUTHORITY) !== data.XAUTHORITY)
    fail('authority.path.identity');
  const auth = probe.lstat(data.XAUTHORITY);
  if (!auth.isFile() || auth.uid !== data.uid || auth.gid !== data.gid ||
    (auth.mode & 0o7777) !== 0o600 || auth.nlink !== 1 || auth.size <= 0 ||
    auth.size > 4096 || !integer(auth.dev) || !integer(auth.ino, 1)) fail('authority.file.identity');
  const anchors = rolling ? rollingAnchors(data) : anchorProcesses(data);
  const baseline = Object.fromEntries((['pid', 'user', 'mnt', 'net'] as Namespace[]).map((name) =>
    [name, probe.readlink(`${procRoot}/self/ns/${name}`)])) as Record<Namespace, string>;
  for (const name of ['pid', 'user', 'mnt', 'net'] as Namespace[])
    if (!new RegExp(`^${name}:\\[\\d+\\]$`).test(baseline[name])) fail('process.namespace.baseline');
  let owner: Identity | undefined;
  if (rolling) {
    owner = data.owner_process ?? undefined;
    if (!owner || !processIdentity(owner) ||
      typeof process.getuid !== 'function' || typeof process.getgid !== 'function' ||
      owner.pid !== process.pid || owner.pid <= 1 || owner.owner_uid !== 0 ||
      owner.owner_gid !== 0 || owner.owner_uid !== process.getuid() ||
      owner.owner_gid !== process.getgid() || data.supervisor.ppid !== owner.pid)
      fail('rolling.owner.binding');
    verifyProcess(owner, probe, procRoot, baseline, true, false, true, 'owner');
  }
  // procfs views that map another namespace's owners to overflow IDs fail here.
  const roles = rolling
    ? ['supervisor', 'xvfb', 'desktop_runner', 'dbus', 'openbox', 'chatgpt']
    : ['supervisor', 'xvfb', 'desktop_runner', 'bounded_session', 'dbus', 'openbox', 'chatgpt'];
  for (let index = 0; index < anchors.length; index++)
    verifyProcess(anchors[index], probe, procRoot, baseline, true, false, rolling, roles[index]);
  const anchored = new Set(anchors.map((entry) => entry.pid));
  for (const identity of data.processes) {
    if (anchored.has(identity.pid)) continue;
    // Auxiliary snapshot metadata can precede a natural reparent or exec.
    // Only PID/start/all UID/GID and consistent procfs views identify it; its
    // stale parent/group/name neither authorizes nor revokes security anchors.
    try { verifyProcess(identity, probe, procRoot, baseline, false, true); }
    catch (error) {
      // Auxiliary processes are transient. Absence is expected; a present but
      // changed PID or owner must never be accepted as the listed process.
      try { probe.readFile(`${procRoot}/${identity.pid}/stat`); }
      catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT' ||
          (readError as NodeJS.ErrnoException).code === 'ESRCH') {
          descriptorValidationBoundary('auxiliary.absence.accepted', readError, undefined,
            { role: 'auxiliary', pid: identity.pid, field: 'procfs' });
          continue;
        }
        throw descriptorValidationBoundary('auxiliary.absence_probe.catch', readError, undefined,
          { role: 'auxiliary', pid: identity.pid, field: 'procfs' });
      }
      throw descriptorValidationBoundary('auxiliary.present_rejection.catch', error, undefined,
        { role: 'auxiliary', pid: identity.pid, field: 'procfs' });
    }
  }
  return { snapshot: Object.freeze({ runtimeDir: data.runtime_dir, authority: data.XAUTHORITY,
    display: data.DISPLAY, uid: data.uid, gid: data.gid, authDev: auth.dev,
    authIno: auth.ino, expiresEpochMs: expires,
    lifecycleMode: publication.mode, sessionId: publication.sessionId }),
  anchors, publication, owner };
}

/** A trusted local startup value, never constructed from an HTTP parameter. */
export class BorrowedDesktopLease {
  private constructor(private readonly file: string, private readonly probe: Probe,
    private readonly procRoot: string, private readonly anchors: readonly Identity[],
    private readonly initial: BorrowedDesktopSnapshot,
    private readonly firstPublication: Publication, private readonly owner?: Identity,
    private lastHash = '', private lastSequence = 0, private lastUpdated = 0,
    private lastExpiry = 0, private invalid = false) {}

  static load(file: string, probe: Probe = systemProbe, procRoot = '/proc'): BorrowedDesktopLease {
    try {
      const opened = readDescriptor(file);
      const { snapshot, anchors, publication, owner } = descriptorSnapshot(opened.data, probe, procRoot);
      return new BorrowedDesktopLease(file, probe, procRoot, anchors, snapshot,
        publication, owner, opened.hash, publication.sequence ?? 0,
        publication.updatedEpochMs ?? 0, snapshot.expiresEpochMs);
    } catch (error) { throw descriptorValidationBoundary('lease.load.catch', error); }
  }

  check(): BorrowedDesktopSnapshot {
    if (this.invalid) return fail('lease.revoked');
    try {
      const opened = readDescriptor(this.file);
      const { snapshot, anchors, publication, owner } =
        descriptorSnapshot(opened.data, this.probe, this.procRoot);
      if (anchors.length !== this.anchors.length || anchors.some((item, index) =>
        !sameIdentity(item, this.anchors[index])) ||
        publication.mode !== this.firstPublication.mode ||
        publication.createdEpochMs !== this.firstPublication.createdEpochMs ||
        publication.sessionId !== this.firstPublication.sessionId ||
        Boolean(owner) !== Boolean(this.owner) ||
        owner && this.owner && !sameIdentity(owner, this.owner) ||
        snapshot.runtimeDir !== this.initial.runtimeDir ||
        snapshot.authority !== this.initial.authority || snapshot.display !== this.initial.display ||
        snapshot.uid !== this.initial.uid || snapshot.gid !== this.initial.gid ||
        snapshot.authDev !== this.initial.authDev || snapshot.authIno !== this.initial.authIno ||
        this.firstPublication.mode === 'bounded' &&
          snapshot.expiresEpochMs !== this.initial.expiresEpochMs) fail('lease.generation.identity');
      if (publication.mode === 'deckide-owned') {
        const sequence = publication.sequence!;
        const updated = publication.updatedEpochMs!;
        if (sequence < this.lastSequence ||
          sequence === this.lastSequence &&
            (opened.hash !== this.lastHash || updated !== this.lastUpdated ||
              snapshot.expiresEpochMs !== this.lastExpiry) ||
          sequence > this.lastSequence &&
            (updated <= this.lastUpdated || snapshot.expiresEpochMs <= this.lastExpiry)) fail('rolling.publication.replay');
        this.lastSequence = sequence;
        this.lastUpdated = updated;
        this.lastExpiry = snapshot.expiresEpochMs;
        this.lastHash = opened.hash;
      }
      return snapshot;
    } catch (error) {
      // A rolling generation stays revoked after a failed observation. Bounded
      // v1 checks revalidate the same immutable lease; the transport has already
      // detached on failure and cannot be revived by this check.
      if (this.firstPublication.mode === 'deckide-owned') this.invalid = true;
      throw descriptorValidationBoundary('lease.check.catch', error);
    }
  }

  /** Observe atomic pathname replacement, not the old descriptor inode. */
  watch(onInvalid: () => void): FSWatcher {
    const watcher = watch(path.dirname(this.file), (_event, filename) => {
      if (filename && filename.toString() !== path.basename(this.file)) return;
      try { this.check(); } catch (error) {
        descriptorValidationBoundary('lease.watch.check.catch', error); onInvalid();
      }
    });
    watcher.on('error', (error) => {
      descriptorValidationBoundary('lease.watch.io.catch', error); onInvalid();
    });
    return watcher;
  }
}

export async function loadBorrowedDesktopDescriptor(file: string): Promise<BorrowedDesktopLease> {
  return BorrowedDesktopLease.load(file);
}
