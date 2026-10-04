import fs from 'node:fs';
import path from 'node:path';

export const CANDIDATE_VERSION = '3.5.49-tmux.20261004.1';
export const BROKER_UNIT = 'deckide-tmux-broker.service';
export const BROKER_SOCKET = '/run/deckide-tmux-broker/broker.sock';
export const TERMINAL_RUNTIME = '/var/lib/deckide-tmux/terminal-tmux';
export const DROPIN_NAME = '99-deckide-tmux.conf';
export const INITIAL_BROKER_RESOURCES = [
  '/run/deckide-tmux-broker',
  '/var/lib/deckide-tmux',
  '/var/lib/deckide-tmux/terminal-tmux',
  BROKER_SOCKET,
];

const SAFE_UNIT = /^[A-Za-z0-9_.@-]+\.service$/;
const SAFE_PATH = /^\/[A-Za-z0-9_./+@-]+$/;
const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh', 'login']);
const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** No service-owned directory or socket may be adopted by an initial install. */
export function assertInitialBrokerResourcesAbsent(resources = INITIAL_BROKER_RESOURCES) {
  for (const resource of resources) {
    try { fs.lstatSync(resource); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error('Cannot verify reserved broker resources are absent');
    }
    throw new Error('Reserved broker resource already exists; refusing initial install');
  }
}

/** Unknown JSON-like files are uncertain registry state, not permission to ignore a session. */
export function classifyTerminalRuntimeEntries(names) {
  const records = [];
  const pending = [];
  for (const name of names) {
    if (!/\.json(?:$|\.)/i.test(name)) continue;
    if (name.endsWith('.pending.json') && TERMINAL_ID.test(name.slice(0, -'.pending.json'.length))) {
      pending.push(name);
    } else if (name.endsWith('.json') && TERMINAL_ID.test(name.slice(0, -'.json'.length))) {
      records.push(name);
    } else {
      throw new Error('Unknown terminal registry filename; placement cannot be verified');
    }
  }
  return { records, pending };
}

export function safeAbsolutePath(value, label) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || path.normalize(value) !== value ||
      value.includes('/../') || value.endsWith('/..')) {
    throw new Error(`${label} must be an absolute path without whitespace, specifiers, or traversal`);
  }
  return value;
}

export function safeServiceUnit(value) {
  if (typeof value !== 'string' || !SAFE_UNIT.test(value) || value.includes('..')) {
    throw new Error('HTTP unit must be a service basename');
  }
  return value;
}

export function parseShowProperties(raw, requested) {
  const values = {};
  for (const line of raw.trimEnd().split('\n')) {
    const equals = line.indexOf('=');
    if (equals < 1) throw new Error('Malformed systemd metadata');
    const key = line.slice(0, equals);
    if (!requested.includes(key) || Object.hasOwn(values, key)) throw new Error('Unexpected systemd metadata');
    values[key] = line.slice(equals + 1);
  }
  for (const key of requested) if (!Object.hasOwn(values, key)) throw new Error(`Missing systemd ${key}`);
  return values;
}

export function assertHttpService(meta) {
  if (meta.LoadState !== 'loaded' || meta.ActiveState !== 'active') throw new Error('HTTP unit is not loaded and active');
  if (!['', 'root'].includes(meta.User) || !['', 'root'].includes(meta.Group) ||
      meta.DynamicUser !== 'no') throw new Error('HTTP unit user/group must be fixed root');
  if (meta.KillMode !== 'control-group') throw new Error('HTTP unit KillMode must be control-group');
  const pid = Number(meta.MainPID);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('HTTP MainPID is unavailable');
  if (!meta.ControlGroup?.startsWith('/') || !meta.FragmentPath?.startsWith('/')) {
    throw new Error('HTTP lifecycle metadata is incomplete');
  }
  return pid;
}

export function safeControlGroup(value) {
  if (typeof value !== 'string' || value === '/' || !/^\/[A-Za-z0-9_.@:-]+(?:\/[A-Za-z0-9_.@:-]+)*$/.test(value) ||
      value.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('HTTP cgroup path is unavailable or unsafe');
  }
  return value;
}

/** An inactive unit must have no leader; its last known cgroup is checked separately. */
export function assertInactiveHttpService(meta, expectedGroup, expectedFragment) {
  safeControlGroup(expectedGroup);
  if (meta.LoadState !== 'loaded' || !['inactive', 'failed'].includes(meta.ActiveState) ||
      !['', 'root'].includes(meta.User) || !['', 'root'].includes(meta.Group) ||
      meta.DynamicUser !== 'no' || meta.KillMode !== 'control-group' ||
      meta.MainPID !== '0' || meta.FragmentPath !== expectedFragment ||
      (meta.ControlGroup && meta.ControlGroup !== expectedGroup)) {
    throw new Error('Inactive HTTP unit identity or lifecycle state is uncertain');
  }
  return expectedGroup;
}

/** A missing former cgroup is empty; a present one must have no process in any subgroup. */
export function assertEmptyServiceCgroup(group, cgroupRoot = '/sys/fs/cgroup') {
  const relative = safeControlGroup(group).slice(1);
  const root = path.join(cgroupRoot, relative);
  let info;
  try { info = fs.lstatSync(root); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('Cannot inspect former HTTP cgroup');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Former HTTP cgroup is unsafe');
  const inspect = (directory) => {
    const procs = path.join(directory, 'cgroup.procs');
    const procsInfo = fs.lstatSync(procs);
    if (!procsInfo.isFile() || procsInfo.isSymbolicLink() || fs.readFileSync(procs, 'utf8').trim()) {
      throw new Error('Former HTTP cgroup retains processes or is unreadable');
    }
    const threads = path.join(directory, 'cgroup.threads');
    if (fs.existsSync(threads)) {
      const threadsInfo = fs.lstatSync(threads);
      if (!threadsInfo.isFile() || threadsInfo.isSymbolicLink() || fs.readFileSync(threads, 'utf8').trim()) {
        throw new Error('Former HTTP cgroup retains threads or is unreadable');
      }
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'cgroup.procs' || entry.name === 'cgroup.threads') continue;
      if (entry.isSymbolicLink()) throw new Error('Former HTTP cgroup has an unsafe symlink');
      if (entry.isDirectory()) inspect(path.join(directory, entry.name));
    }
  };
  try { inspect(root); }
  catch (error) {
    if (/Former HTTP cgroup/.test(error?.message)) throw error;
    throw new Error('Cannot verify former HTTP cgroup is empty');
  }
}

function strictArgv(raw) {
  if (!raw || /["'\\\r\n;]/.test(raw) || /\s{2,}/.test(raw)) {
    throw new Error('Unrecognized ExecStart argument encoding');
  }
  const args = raw.trim().split(' ');
  if (args.some((arg) => !arg || /[^\x21-\x7e]/.test(arg))) throw new Error('Unrecognized ExecStart arguments');
  return args;
}

/** Parse only public launch shapes. Never log or persist the raw ExecStart property. */
export function parseDeckideExecStart(raw, previousPackage, realpath = fs.realpathSync) {
  const match = /^\{\s*path=([^;]+?)\s*;\s*argv\[\]=([^;]+?)\s*;[^{}]*\}$/.exec(raw.trim());
  if (!match) throw new Error('Unrecognized HTTP ExecStart shape; operator review required');
  const binary = match[1].trim();
  const args = strictArgv(match[2]);
  if (args[0] !== binary) throw new Error('ExecStart path and argv disagree');
  const previous = realpath(previousPackage);
  const cli = path.join(previous, 'bin/deckide.js');
  const server = path.join(previous, 'dist/index.js');
  let entry;
  let nodePath = null;
  let entryIndex;
  if (realpath(binary) === cli) {
    entry = 'bin/deckide.js'; entryIndex = 0;
  } else {
    const resolved = realpath(binary);
    if (path.basename(resolved) !== 'node') throw new Error('HTTP launcher is not a recognized Node binary');
    nodePath = binary;
    entryIndex = 1;
    if (!args[entryIndex]) throw new Error('HTTP package entry is missing');
    const sourceEntry = realpath(args[entryIndex]);
    if (sourceEntry === cli) entry = 'bin/deckide.js';
    else if (sourceEntry === server) entry = 'dist/index.js';
    else throw new Error('HTTP entry does not belong to previous package');
  }
  const publicArgs = args.slice(entryIndex + 1);
  if (entry === 'dist/index.js') {
    if (publicArgs.length) throw new Error('Direct server entry has unknown arguments');
  } else {
    if (publicArgs[0] !== 'start' || !publicArgs.includes('--fg')) {
      throw new Error('CLI service must run start --fg');
    }
    for (let i = 1; i < publicArgs.length; i++) {
      const arg = publicArgs[i];
      if (arg === '--fg' || arg === '--no-open') continue;
      if (arg === '-p' || arg === '--port') {
        const port = Number(publicArgs[++i]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid public port flag');
        continue;
      }
      if (arg === '--host') {
        const host = publicArgs[++i];
        if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) throw new Error('Invalid public host flag');
        continue;
      }
      throw new Error('HTTP launcher has an unrecognized flag; operator review required');
    }
  }
  return { entry, nodePath, sourceEntry: path.join(previous, entry), publicArgs,
    direct: entryIndex === 0 };
}

/** Rollback observes the effective unit, since daemon-reload and state writes are not atomic. */
export function parseKnownRollbackLaunch(raw, previousPackage, candidatePackage, realpath = fs.realpathSync) {
  for (const [kind, packageRoot] of [['previous', previousPackage], ['candidate', candidatePackage]]) {
    try { return { kind, launch: parseDeckideExecStart(raw, packageRoot, realpath) }; }
    catch { /* The other known package may own this effective ExecStart. */ }
  }
  throw new Error('HTTP ExecStart belongs to neither the previous nor staged candidate package');
}

export function parseProcStat(text) {
  const match = /^(\d+) \((.*)\) (.+)$/.exec(text.trim());
  if (!match) throw new Error('Malformed /proc stat');
  const fields = match[3].split(' ');
  const pid = Number(match[1]);
  const ppid = Number(fields[1]);
  const ttyNr = Number(fields[4]);
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(ppid) || ppid < 0 ||
      !Number.isSafeInteger(ttyNr) || !/^[RSDTIZXKWP]$/.test(fields[0])) {
    throw new Error('Unknown /proc process state');
  }
  return { pid, comm: match[2], state: fields[0], ppid, ttyNr };
}

export function readProcTree(procRoot, mainPid) {
  const processes = new Map();
  for (const name of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = parseProcStat(fs.readFileSync(path.join(procRoot, name, 'stat'), 'utf8'));
      processes.set(stat.pid, stat);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') continue;
      throw new Error('Cannot verify process inventory from /proc');
    }
  }
  if (!processes.has(mainPid)) throw new Error('HTTP MainPID changed or vanished during inventory');
  const descendants = [];
  const queue = [mainPid];
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    for (const process of processes.values()) {
      if (process.ppid !== parent || process.pid === mainPid) continue;
      descendants.push(process);
      queue.push(process.pid);
    }
  }
  return descendants;
}

export function assertNoLegacyPtys(descendants, { verifyTmuxDisplay } = {}) {
  for (const process of descendants) {
    if (process.state === 'Z') continue;
    if (verifyTmuxDisplay && process.ttyNr !== 0 &&
        ['tmux', 'tmux: client'].includes(process.comm) && verifyTmuxDisplay(process)) continue;
    if (process.ttyNr !== 0 || SHELL_NAMES.has(process.comm) || process.comm.startsWith('tmux')) {
      throw new Error(`Legacy terminal descendant remains (PID ${process.pid}); HTTP restart refused`);
    }
  }
}

function inside(group, parent) {
  return group === parent || group.startsWith(`${parent}/`);
}

export function parseUnifiedCgroup(raw) {
  const entries = raw.trim().split('\n').filter(Boolean);
  const unified = entries.filter((line) => line.startsWith('0::'));
  if (unified.length !== 1 || !unified[0].slice(3).startsWith('/')) {
    throw new Error('Cannot verify unified process cgroup');
  }
  return unified[0].slice(3);
}

/** Records must already have passed the adapter's native ID/generation verification. */
export function assertBrokerCgroups(records, brokerGroup, httpGroup, readCgroup) {
  if (records.length && (!brokerGroup?.startsWith('/') || !httpGroup?.startsWith('/'))) {
    throw new Error('Broker/HTTP cgroup metadata unavailable');
  }
  for (const meta of records) {
    const group = parseUnifiedCgroup(readCgroup(meta.serverPid));
    if (inside(group, httpGroup) || !inside(group, brokerGroup)) {
      throw new Error(`Owned tmux server PID ${meta.serverPid} is not isolated in broker cgroup`);
    }
  }
}
