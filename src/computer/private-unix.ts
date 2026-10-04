import fs from 'node:fs/promises';
import path from 'node:path';

const PREFIX = '/tmp/deckide-rfb-';
const TMPFS_MAGIC = 0x01021994;
const MAX_PATH_BYTES = 100;

type FileSystem = Pick<typeof fs, 'mkdtemp' | 'lstat' | 'realpath' | 'readdir' |
  'statfs' | 'unlink' | 'rmdir'>;
type Identity = { dev: number; ino: number; uid: number };
export type PrivateUnixLease = {
  dir: string;
  socketPath: string;
  pathBytes: number;
  directory: Identity;
  socket?: Identity;
};
export type PrivateUnixEvent = { action: 'created' | 'allocated' | 'listening' | 'cleaned' | 'retained';
  dir: string; socketPath: string; pathBytes: number; directory: Identity | null;
  socket?: Identity; socketWasPresent?: boolean; reason?: string };
export type PrivateUnixOptions = {
  /** Trusted local injection for static tests and an optional local audit sink. */
  fileSystem?: FileSystem;
  uid?: number;
  onEvent?: (event: PrivateUnixEvent) => void;
};

function owner(options: PrivateUnixOptions): number {
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : NaN);
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Private listener owner is unknown');
  return uid;
}

function validIdentity(stat: { dev: number; ino: number; uid: number }): boolean {
  return Number.isSafeInteger(stat.dev) && stat.dev >= 0 &&
    Number.isSafeInteger(stat.ino) && stat.ino > 0 &&
    Number.isSafeInteger(stat.uid) && stat.uid >= 0;
}

function same(stat: { dev: number; ino: number; uid: number }, identity: Identity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino && stat.uid === identity.uid;
}

async function absent(fileSystem: FileSystem, file: string): Promise<boolean> {
  try { await fileSystem.lstat(file); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function tmpfs(fileSystem: FileSystem, file: string): Promise<void> {
  const stat = await fileSystem.statfs(file);
  if (BigInt(stat.type) !== BigInt(TMPFS_MAGIC))
    throw new Error('Private listener directory is not on tmpfs');
}

async function directory(fileSystem: FileSystem, lease: PrivateUnixLease,
  uid: number): Promise<void> {
  const stat = await fileSystem.lstat(lease.dir);
  if (!stat.isDirectory() || !validIdentity(stat) || !same(stat, lease.directory) ||
    stat.uid !== uid || (stat.mode & 0o7777) !== 0o700 ||
    await fileSystem.realpath(lease.dir) !== lease.dir)
    throw new Error('Private listener directory changed');
  await tmpfs(fileSystem, '/tmp');
  await tmpfs(fileSystem, lease.dir);
}

function exactEntries(entries: string[], expected: string[]): void {
  if (entries.length !== expected.length ||
    entries.some((entry, i) => entry !== expected[i]))
    throw new Error('Private listener directory contains an unexpected entry');
}

function retained(options: PrivateUnixOptions, lease: Omit<PrivateUnixEvent, 'action'>,
  error: unknown): void {
  try {
    options.onEvent?.({ action: 'retained', ...lease,
      reason: error instanceof Error ? error.message : 'unknown error' });
  } catch (auditError) {
    throw new AggregateError([error, auditError], 'Private listener audit failed while retaining resource');
  }
}

/** Allocate a fresh pathname only. This never reuses or repairs a previous directory. */
export async function allocatePrivateUnixSocket(options: PrivateUnixOptions = {}): Promise<PrivateUnixLease> {
  const fileSystem = options.fileSystem ?? fs;
  const uid = owner(options);
  await tmpfs(fileSystem, '/tmp');
  const dir = await fileSystem.mkdtemp(PREFIX);
  const socketPath = path.join(dir, 's');
  const pathBytes = Buffer.byteLength(socketPath, 'utf8');
  let observed: Omit<PrivateUnixEvent, 'action'> = { dir, socketPath, pathBytes, directory: null };
  try {
    // A suspicious mkdtemp return is retained for inspection, never cleaned by guess.
    options.onEvent?.({ action: 'created', ...observed });
    if (path.dirname(dir) !== '/tmp' || !path.basename(dir).startsWith('deckide-rfb-') ||
      path.basename(dir).length <= 'deckide-rfb-'.length ||
      pathBytes >= MAX_PATH_BYTES)
      throw new Error('Private stream path is too long or outside /tmp');
    const stat = await fileSystem.lstat(dir);
    if (!stat.isDirectory() || !validIdentity(stat) || stat.uid !== uid ||
      (stat.mode & 0o7777) !== 0o700 || await fileSystem.realpath(dir) !== dir)
      throw new Error('Private listener directory is unsafe');
    const lease = { dir, socketPath, pathBytes,
      directory: { dev: stat.dev, ino: stat.ino, uid: stat.uid } };
    observed = lease;
    await directory(fileSystem, lease, uid);
    exactEntries(await fileSystem.readdir(dir), []);
    if (!await absent(fileSystem, socketPath))
      throw new Error('Private listener path already exists');
    await directory(fileSystem, lease, uid);
    options.onEvent?.({ action: 'allocated', ...lease });
    return lease;
  } catch (error) {
    retained(options, observed, error);
    throw error;
  }
}

/** Check the exact listener Node created before connecting to it. */
export async function recordPrivateUnixSocket(lease: PrivateUnixLease,
  options: PrivateUnixOptions = {}): Promise<PrivateUnixLease> {
  const fileSystem = options.fileSystem ?? fs;
  await directory(fileSystem, lease, owner(options));
  exactEntries(await fileSystem.readdir(lease.dir), ['s']);
  const stat = await fileSystem.lstat(lease.socketPath);
  if (!stat.isSocket() || !validIdentity(stat) || stat.uid !== lease.directory.uid)
    throw new Error('Private listener identity failed');
  const recorded = { ...lease, socket: { dev: stat.dev, ino: stat.ino, uid: stat.uid } };
  await directory(fileSystem, recorded, owner(options));
  options.onEvent?.({ action: 'listening', ...recorded });
  return recorded;
}

export async function verifyPrivateUnixSocket(lease: PrivateUnixLease,
  options: PrivateUnixOptions = {}): Promise<void> {
  if (!lease.socket) throw new Error('Private listener identity is unknown');
  const fileSystem = options.fileSystem ?? fs;
  await directory(fileSystem, lease, owner(options));
  exactEntries(await fileSystem.readdir(lease.dir), ['s']);
  const stat = await fileSystem.lstat(lease.socketPath);
  if (!stat.isSocket() || !same(stat, lease.socket))
    throw new Error('Private listener changed');
  await directory(fileSystem, lease, owner(options));
}

/** Close the listener first. Its pathname may already be absent.
 * These identity observations are not an atomic same-UID replacement defense. */
export async function cleanupPrivateUnixSocket(lease: PrivateUnixLease,
  options: PrivateUnixOptions = {}): Promise<void> {
  const fileSystem = options.fileSystem ?? fs;
  let present = false;
  try {
    await directory(fileSystem, lease, owner(options));
    const entries = await fileSystem.readdir(lease.dir);
    if (entries.length > 1 || (entries.length === 1 && entries[0] !== 's'))
      throw new Error('Private listener directory contains an unexpected entry');
    present = entries.length === 1;
    if (present) {
      if (!lease.socket) throw new Error('Private listener identity is unknown');
      const stat = await fileSystem.lstat(lease.socketPath);
      if (!stat.isSocket() || !same(stat, lease.socket))
        throw new Error('Private listener changed');
      await directory(fileSystem, lease, owner(options));
      // ENOENT records observed absence after the identity check; its cause is unknown.
      try { await fileSystem.unlink(lease.socketPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } else if (!await absent(fileSystem, lease.socketPath)) {
      throw new Error('Private listener path appeared');
    }
    await directory(fileSystem, lease, owner(options));
    exactEntries(await fileSystem.readdir(lease.dir), []);
    await fileSystem.rmdir(lease.dir);
  } catch (error) {
    retained(options, lease, error);
    throw error;
  }
  options.onEvent?.({ action: 'cleaned', ...lease, socketWasPresent: present });
}
