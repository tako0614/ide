import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import type { BorrowedDesktopSnapshot } from './borrowed-desktop.js';

// Linux x86_64 seccomp_data offsets and raw sock_filter opcodes. setpriv
// 2.41.3 reads this raw BPF program before exec, with no_new_privs set.
const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JSET_K = 0x45;
const BPF_RET_K = 0x06;
const ALLOW = 0x7fff0000;
const KILL = 0x80000000;
const X86_64 = 0xc000003e;
const AF_UNIX = 1;
export const PRIVATE_VNC_FILTER_SHA256 = 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e';
export const PRIVATE_VNC_LAUNCHER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)),
  'native', 'vnc-launcher');

export async function attestedPrivateVncLauncher(expectedSha256: string): Promise<string | null> {
  if (process.platform !== 'linux' || process.arch !== 'x64' ||
    !/^[a-f0-9]{64}$/.test(expectedSha256)) return null;
  try {
    for (let directory = path.dirname(PRIVATE_VNC_LAUNCHER_PATH); ; directory = path.dirname(directory)) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid()) ||
        (stat.mode & 0o022) || await fs.realpath(directory) !== directory) return null;
      if (directory === '/') break;
    }
    const handle = await fs.open(PRIVATE_VNC_LAUNCHER_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      const entry = await fs.lstat(PRIVATE_VNC_LAUNCHER_PATH);
      if (!stat.isFile() || stat.uid !== 0 && stat.uid !== process.getuid() ||
        (stat.mode & 0o7000) || (stat.mode & 0o022) || !(stat.mode & 0o111) ||
        stat.size <= 0 || stat.size > 1024 * 1024 || stat.dev !== entry.dev || stat.ino !== entry.ino ||
        await fs.realpath(PRIVATE_VNC_LAUNCHER_PATH) !== PRIVATE_VNC_LAUNCHER_PATH) return null;
      const data = await handle.readFile();
      return createHash('sha256').update(data).digest('hex') === expectedSha256
        ? PRIVATE_VNC_LAUNCHER_PATH : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

export type PrivateVncDiagnostic = { path: string; fd: number; dev: number; ino: number; uid: number;
  close(): Promise<void> };

export async function openPrivateVncDiagnostic(runtimeDir: string): Promise<PrivateVncDiagnostic> {
  const directory = await fs.lstat(runtimeDir);
  if (!path.isAbsolute(runtimeDir) || await fs.realpath(runtimeDir) !== runtimeDir ||
    !directory.isDirectory() || (directory.mode & 0o7777) !== 0o700 ||
    directory.uid !== process.getuid()) throw new Error('Private VNC diagnostic directory is unsafe');
  const file = path.join(runtimeDir, `stderr-${randomBytes(16).toString('hex')}.log`);
  const handle = await fs.open(file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    const entry = await fs.lstat(file);
    if (!stat.isFile() || !Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino) ||
      (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 ||
      stat.uid !== process.getuid() || stat.dev !== entry.dev || stat.ino !== entry.ino)
      throw new Error('Private VNC diagnostic is unsafe');
    return { path: file, fd: handle.fd, dev: stat.dev, ino: stat.ino, uid: stat.uid,
      close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}

/** Diagnostic content stays private. Callers receive at most 64 KiB with the
 * parent-generated password removed, and may only use this outside HTTP. */
export async function readPrivateVncDiagnostic(diagnostic: Pick<PrivateVncDiagnostic, 'path' | 'dev' | 'ino'>,
  password: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{8}$/.test(password)) throw new Error('Invalid private VNC password');
  const handle = await fs.open(diagnostic.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== diagnostic.dev || stat.ino !== diagnostic.ino ||
      stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600)
      throw new Error('Private VNC diagnostic changed');
    const bytes = Buffer.alloc(Math.min(stat.size, 65536));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const redacted = bytes.subarray(0, bytesRead).toString('utf8').replaceAll(password, '[redacted]')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?');
    return Buffer.from(redacted).subarray(0, 65536).toString('utf8');
  } finally { await handle.close(); }
}

export function privateVncSeccompFilter(): Buffer {
  const instructions: [number, number, number, number][] = [
    [BPF_LD_W_ABS, 0, 0, 4], // seccomp_data.arch
    [BPF_JEQ_K, 1, 0, X86_64],
    [BPF_RET_K, 0, 0, KILL],
    [BPF_LD_W_ABS, 0, 0, 0], // seccomp_data.nr
    [BPF_JSET_K, 0, 1, 0x40000000], // reject x32 syscall namespace
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 4, 41], // socket
    [BPF_LD_W_ABS, 0, 0, 16], // args[0], socket domain
    [BPF_JEQ_K, 0, 1, AF_UNIX],
    [BPF_RET_K, 0, 0, ALLOW],
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 4, 53], // socketpair
    [BPF_LD_W_ABS, 0, 0, 16],
    [BPF_JEQ_K, 0, 1, AF_UNIX],
    [BPF_RET_K, 0, 0, ALLOW],
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 49], // bind: even an inherited/received socket cannot listen
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 50], // listen
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 43], // accept
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 288], // accept4
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 425], // io_uring_setup: no alternate socket creation
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 426], // io_uring_enter
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 427], // io_uring_register
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 101], // ptrace
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 310], // process_vm_readv
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 311], // process_vm_writev
    [BPF_RET_K, 0, 0, KILL],
    [BPF_JEQ_K, 0, 1, 438], // pidfd_getfd
    [BPF_RET_K, 0, 0, KILL],
    [BPF_RET_K, 0, 0, ALLOW],
  ];
  const data = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    const offset = index * 8;
    data.writeUInt16LE(code, offset);
    data[offset + 2] = jt;
    data[offset + 3] = jf;
    data.writeUInt32LE(k >>> 0, offset + 4);
  });
  return data;
}

export function privateVncPolicySupported(platform: string, arch: string, expectedSha256: string): boolean {
  return platform === 'linux' && arch === 'x64' && expectedSha256 === PRIVATE_VNC_FILTER_SHA256;
}

/** setpriv fails without execing x11vnc when seccomp cannot be installed. */
export function privateVncCredentialSucceeded(code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === 0 && signal === null;
}

/** Caller supplies a reviewed hash at startup; HTTP and env cannot enable it. */
export async function writePrivateVncFilter(runtimeDir: string, expectedSha256: string): Promise<string> {
  if (!privateVncPolicySupported(process.platform, process.arch, expectedSha256))
    throw new Error('Private VNC sandbox is unavailable');
  const data = privateVncSeccompFilter();
  if (createHash('sha256').update(data).digest('hex') !== expectedSha256)
    throw new Error('Private VNC sandbox attestation failed');
  const directory = await fs.lstat(runtimeDir);
  if (!directory.isDirectory() || (directory.mode & 0o7777) !== 0o700 ||
    await fs.realpath(runtimeDir) !== runtimeDir ||
    (typeof process.getuid === 'function' && directory.uid !== process.getuid()))
    throw new Error('Private VNC sandbox directory is unsafe');
  const file = path.join(runtimeDir, 'rfb.seccomp');
  let existing = false;
  try { await fs.lstat(file); existing = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!existing) {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(data); }
    finally { await handle.close(); }
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size !== data.length || (stat.mode & 0o7777) !== 0o600 ||
    stat.nlink !== 1 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    createHash('sha256').update(await fs.readFile(file)).digest('hex') !== expectedSha256)
    throw new Error('Private VNC sandbox file is unsafe');
  return file;
}

export function privateVncLauncherArgs(runtimeDir: string, diagnostic: { dev: number; ino: number },
  mode: 'credential', secret: string): string[];
export function privateVncLauncherArgs(runtimeDir: string, diagnostic: { dev: number; ino: number },
  mode: 'viewer', display: string, acceptedInode: string): string[];
export function privateVncLauncherArgs(runtimeDir: string, diagnostic: { dev: number; ino: number },
  mode: 'credential-borrowed', secret: string, borrowed: BorrowedDesktopSnapshot): string[];
export function privateVncLauncherArgs(runtimeDir: string, diagnostic: { dev: number; ino: number },
  mode: 'viewer-borrowed', display: string, acceptedInode: string,
  borrowed: BorrowedDesktopSnapshot): string[];
export function privateVncLauncherArgs(runtimeDir: string, diagnostic: { dev: number; ino: number },
  mode: 'credential' | 'viewer' | 'credential-borrowed' | 'viewer-borrowed', value: string,
  acceptedInodeOrBorrowed?: string | BorrowedDesktopSnapshot,
  borrowedArgument?: BorrowedDesktopSnapshot): string[] {
  if (!path.isAbsolute(runtimeDir) || !Number.isSafeInteger(diagnostic.dev) ||
    !Number.isSafeInteger(diagnostic.ino) || diagnostic.dev < 0 || diagnostic.ino <= 0)
    throw new Error('Invalid private VNC launch');
  if (mode === 'credential' && /^[A-Za-z0-9_-]{8}$/.test(value) && acceptedInodeOrBorrowed === undefined)
    return [mode, runtimeDir, value, String(diagnostic.dev), String(diagnostic.ino)];
  if (mode === 'viewer' && /^:[0-9]{2,3}$/.test(value) &&
    typeof acceptedInodeOrBorrowed === 'string' && /^\d+$/.test(acceptedInodeOrBorrowed))
    return [mode, runtimeDir, value, acceptedInodeOrBorrowed,
      String(diagnostic.dev), String(diagnostic.ino)];
  const borrowed = mode === 'credential-borrowed' ? acceptedInodeOrBorrowed : borrowedArgument;
  if ((mode === 'credential-borrowed' || mode === 'viewer-borrowed') &&
    borrowed && typeof borrowed === 'object' &&
    borrowed.runtimeDir !== runtimeDir &&
    path.isAbsolute(borrowed.runtimeDir) && path.isAbsolute(borrowed.authority) &&
    path.dirname(borrowed.authority) === borrowed.runtimeDir &&
    Number.isSafeInteger(borrowed.uid) && Number.isSafeInteger(borrowed.gid) &&
    Number.isSafeInteger(borrowed.authDev) && Number.isSafeInteger(borrowed.authIno) &&
    borrowed.authDev >= 0 && borrowed.authIno > 0 &&
    Number.isSafeInteger(borrowed.expiresEpochMs) && borrowed.expiresEpochMs > Date.now()) {
    const suffix = [String(diagnostic.dev), String(diagnostic.ino), borrowed.authority,
      borrowed.runtimeDir, String(borrowed.uid), String(borrowed.gid),
      String(borrowed.authDev), String(borrowed.authIno), String(borrowed.expiresEpochMs)];
    if (mode === 'credential-borrowed' && /^[A-Za-z0-9_-]{8}$/.test(value) && !borrowedArgument)
      return [mode, runtimeDir, value, ...suffix];
    if (mode === 'viewer-borrowed' && /^:[1-9]\d{1,3}$/.test(value) &&
      value === borrowed.display && typeof acceptedInodeOrBorrowed === 'string' &&
      /^\d+$/.test(acceptedInodeOrBorrowed))
      return [mode, runtimeDir, value, acceptedInodeOrBorrowed, ...suffix];
  }
  throw new Error('Invalid private VNC launch');
}

/** libuv receives exactly three stdio entries, with no IPC channel or pipe. */
export function privateVncStdioContract(stdio: readonly unknown[], accepted: Socket | null,
  diagnosticFd: number): boolean {
  if (!Number.isSafeInteger(diagnosticFd) || diagnosticFd < 3 || stdio.length !== 3 ||
    stdio[2] !== diagnosticFd) return false;
  if (accepted === null) return stdio[0] === 'ignore' && stdio[1] === 'ignore';
  return stdio.length === 3 && stdio[0] === accepted && stdio[1] === accepted &&
    stdio[2] === diagnosticFd;
}

export async function privateSocketIdentity(file: string, runtimeDir: string): Promise<{ dev: number; ino: number } | null> {
  if (path.dirname(file) !== runtimeDir || Buffer.byteLength(file) >= 100) return null;
  const directory = await fs.lstat(runtimeDir).catch(() => null);
  const socket = await fs.lstat(file).catch(() => null);
  if (!directory?.isDirectory() || (directory.mode & 0o077) || !socket?.isSocket() ||
    (socket.mode & 0o077) ||
    (typeof process.getuid === 'function' &&
      (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) return null;
  return { dev: socket.dev, ino: socket.ino };
}

/** Node/libuv must expose the accepted socket as a real Unix FD. Refuse any
 * unexpected handle shape instead of passing a pipe or inherited TCP socket. */
export async function privateAcceptedUnixIdentity(socket: Socket): Promise<string | null> {
  const handle = (socket as Socket & { _handle?: { fd?: unknown } })._handle;
  const fd = handle?.fd;
  if (!Number.isSafeInteger(fd) || (fd as number) < 0 || socket.destroyed) return null;
  try {
    const target = await fs.readlink(`/proc/self/fd/${fd}`);
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (!match) return null;
    const unix = (await fs.readFile('/proc/net/unix', 'utf8')).split('\n').slice(1);
    return unix.some((line) => line.trim().split(/\s+/)[6] === match[1]) ? match[1] : null;
  } catch { return null; }
}

export interface PrivateVncFdStat {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  rdev: number;
  isFile(): boolean;
  isCharacterDevice(): boolean;
}

export interface PrivateVncProcFs {
  readdir(file: string): Promise<string[]>;
  readlink(file: string): Promise<string>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  stat(file: string): Promise<PrivateVncFdStat>;
  lstat(file: string): Promise<PrivateVncFdStat>;
  realpath(file: string): Promise<string>;
}

type PrivateVncDiagnosticIdentity = { path: string; dev: number; ino: number; uid: number };

function privateVncNullStatMatches(fd: PrivateVncFdStat, canonical: PrivateVncFdStat): boolean {
  return fd.isCharacterDevice() && canonical.isCharacterDevice() && fd.dev === canonical.dev &&
    fd.ino === canonical.ino && fd.rdev === canonical.rdev &&
    (fd.mode & 0o170000) === (canonical.mode & 0o170000);
}

/** Evaluate one stable procfs snapshot. The accepted inode may move to any FD
 * as x11vnc closes inetd stdin/stdout, but must remain present on a live FD. */
export function privateVncProcessState(
  status: string, exe: string, fdTargets: ReadonlyMap<number, string>,
  unixInodes: ReadonlySet<string>, expectedInode: string,
  diagnostic: string | PrivateVncDiagnosticIdentity,
  fdStats: ReadonlyMap<number, PrivateVncFdStat> = new Map(),
  canonicalNull?: PrivateVncFdStat,
): boolean {
  const diagnosticIdentity = typeof diagnostic === 'string' ? null : diagnostic;
  const diagnosticPath = typeof diagnostic === 'string' ? diagnostic : diagnostic.path;
  if (exe !== '/usr/bin/x11vnc' || !/^NoNewPrivs:\s+1$/m.test(status) ||
    !/^Seccomp:\s+2$/m.test(status) || !/^Seccomp_filters:\s+[1-9]\d*$/m.test(status) ||
    !/^\d+$/.test(expectedInode)) return false;
  let acceptedPresent = false;
  for (const target of fdTargets.values()) {
    const socket = /^socket:\[(\d+)\]$/.exec(target);
    if (socket) {
      if (!unixInodes.has(socket[1])) return false;
      if (socket[1] === expectedInode) acceptedPresent = true;
    }
  }
  if (!acceptedPresent) return false;
  if (fdTargets.has(2)) {
    const target = fdTargets.get(2)!;
    const stat = fdStats.get(2);
    if (!stat) return false;
    if (target === diagnosticPath) {
      if (!diagnosticIdentity || !stat.isFile() || stat.dev !== diagnosticIdentity.dev ||
        stat.ino !== diagnosticIdentity.ino || stat.nlink !== 1 ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.uid !== diagnosticIdentity.uid) return false;
    } else if (target === '/dev/null') {
      if (!canonicalNull || !privateVncNullStatMatches(stat, canonicalNull)) return false;
    } else return false;
  }
  return true;
}

function privateVncProcessIdentity(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const processGroup = fields[2]; // field 5 (pgrp), after the comm field
  const startTime = fields[19]; // field 22, after the comm field
  return /^\d+$/.test(processGroup ?? '') && /^\d+$/.test(startTime ?? '')
    ? `${processGroup}:${startTime}` : null;
}

async function privateVncReadFdSnapshot(procfs: PrivateVncProcFs, fdDir: string):
Promise<{ targets: Map<number, string>; stats: Map<number, PrivateVncFdStat> } | null> {
  const targets = new Map<number, string>();
  const stats = new Map<number, PrivateVncFdStat>();
  for (const fd of await procfs.readdir(fdDir)) {
    if (!/^\d+$/.test(fd)) return null;
    const number = Number(fd);
    const fdPath = `${fdDir}/${fd}`;
    targets.set(number, await procfs.readlink(fdPath));
    stats.set(number, await procfs.stat(fdPath));
  }
  return { targets, stats };
}

function privateVncSameFdSnapshot(a: { targets: Map<number, string>; stats: Map<number, PrivateVncFdStat> },
  b: { targets: Map<number, string>; stats: Map<number, PrivateVncFdStat> }): boolean {
  return a.targets.size === b.targets.size && [...a.targets].every(([fd, target]) => {
    const before = a.stats.get(fd);
    const after = b.stats.get(fd);
    return b.targets.get(fd) === target && before !== undefined && after !== undefined &&
      before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
      before.rdev === after.rdev && before.uid === after.uid && before.nlink === after.nlink;
  });
}

/** Inspect only the witnessed child, using its network namespace's Unix table.
 * Process identity, namespace and descriptor targets must remain stable across readback. */
export async function privateVncNetworkIdentity(pid: number, expectedInode: string,
  diagnostic: PrivateVncDiagnosticIdentity, procfs: PrivateVncProcFs = fs,
  procRoot = '/proc', nullPath = '/dev/null'): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(expectedInode)) return false;
  const processDir = `${procRoot}/${pid}`;
  const fdDir = `${processDir}/fd`;
  const processStatPath = `${processDir}/stat`;
  const netnsPath = `${processDir}/ns/net`;
  try {
    const identityBefore = privateVncProcessIdentity(await procfs.readFile(processStatPath, 'utf8'));
    const netnsBefore = await procfs.readlink(netnsPath);
    const fdBefore = await privateVncReadFdSnapshot(procfs, fdDir);
    if (!identityBefore || !/^net:\[\d+\]$/.test(netnsBefore) || !fdBefore) return false;
    if (await procfs.realpath(nullPath) !== nullPath) return false;
    const nullEntry = await procfs.lstat(nullPath);
    if (!nullEntry.isCharacterDevice()) return false;
    const nullStat = await procfs.stat(nullPath);
    if (!privateVncNullStatMatches(nullEntry, nullStat)) return false;
    const unix = (await procfs.readFile(`${processDir}/net/unix`, 'utf8')).split('\n').slice(1);
    const unixInodes = new Set(unix.map((line) => line.trim().split(/\s+/)[6]).filter(Boolean));
    const status = await procfs.readFile(`${processDir}/status`, 'utf8');
    const exe = await procfs.readlink(`${processDir}/exe`);
    const valid = privateVncProcessState(status, exe, fdBefore.targets, unixInodes,
      expectedInode, diagnostic, fdBefore.stats, nullStat);
    const fdAfter = await privateVncReadFdSnapshot(procfs, fdDir);
    const identityAfter = privateVncProcessIdentity(await procfs.readFile(processStatPath, 'utf8'));
    const netnsAfter = await procfs.readlink(netnsPath);
    return valid && Boolean(fdAfter) && privateVncSameFdSnapshot(fdBefore, fdAfter!) &&
      identityAfter === identityBefore && netnsAfter === netnsBefore;
  } catch { return false; }
}
