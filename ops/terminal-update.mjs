#!/usr/bin/env node
/** Operator-run, guarded DeckIDE tmux broker rollout. No unit is activated by importing this file. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CANDIDATE_VERSION, BROKER_UNIT, BROKER_SOCKET, TERMINAL_RUNTIME, DROPIN_NAME,
  assertInitialBrokerResourcesAbsent, classifyTerminalRuntimeEntries,
  safeAbsolutePath, safeServiceUnit, safeControlGroup, parseShowProperties, assertHttpService,
  assertInactiveHttpService, assertEmptyServiceCgroup,
  parseDeckideExecStart, parseKnownRollbackLaunch, readProcTree, assertNoLegacyPtys, assertBrokerCgroups,
} from './terminal-update-guards.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNIT_DIR = '/etc/systemd/system';
const DEFAULT_STATE_DIR = '/var/lib/deckide-tmux-updater';
const DEFAULT_RELEASE_ROOT = '/root/dev/deckide-releases';
const HTTP_PROPERTIES = [
  'LoadState', 'ActiveState', 'User', 'Group', 'DynamicUser', 'KillMode',
  'MainPID', 'ControlGroup', 'FragmentPath', 'DropInPaths', 'ExecStart',
];
const BROKER_PROPERTIES = [
  'LoadState', 'ActiveState', 'User', 'Group', 'KillMode', 'MainPID', 'ControlGroup',
];

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Public hash target is not a regular file');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (length === 0) break;
      hash.update(chunk.subarray(0, length));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function run(file, args, { timeout = 15_000, env, cwd } = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env, cwd,
  });
  if (result.error || result.status !== 0) {
    // Command output may include shell text, environment, or private service flags.
    throw new Error(`${path.basename(file)} operation failed; no service change is assumed`);
  }
  return result.stdout;
}

function systemdShow(unit, properties) {
  return parseShowProperties(run('systemctl', [
    'show', '--no-pager', ...properties.flatMap((key) => ['-p', key]), unit,
  ]), properties);
}

function systemctl(...args) { run('systemctl', args, { timeout: 30_000 }); }

function readPublicPackage(packageDir) {
  const rootInfo = fs.lstatSync(packageDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Package directory is not a regular directory');
  }
  const manifestPath = path.join(packageDir, 'package.json');
  const info = fs.lstatSync(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Package manifest is not a regular public file');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== 'deckide' || typeof manifest.version !== 'string') {
    throw new Error('Previous package identity is not DeckIDE');
  }
  return { version: manifest.version };
}

const APP_PUBLIC_FILES = [
  'ops/chatgpt-launcher/source/launch-chatgpt.sh',
  'ops/chatgpt-launcher/source/session-supervisor.py',
  'ops/chatgpt-launcher/source/desktop-session.py',
  'ops/chatgpt-launcher/source/session-bus.conf',
  'ops/chatgpt-launcher/source/test-session-lifecycle.py',
  'ops/chatgpt-launcher/source/app-config.example.toml',
  'ops/chatgpt-launcher/source/LAUNCHER-CONTRACT.md',
  'ops/chatgpt-launcher/source/MANIFEST.json',
  'ops/chatgpt-launcher/source/SHA256SUMS',
  'ops/chatgpt-launcher/product/launch-chatgpt.sh',
  'ops/chatgpt-launcher/product/session-supervisor.py',
  'ops/chatgpt-launcher/product/desktop-session.py',
  'ops/chatgpt-launcher/product/session-bus.conf',
  'ops/chatgpt-launcher/product/test-session-lifecycle.py',
  'ops/chatgpt-launcher/product/SOURCE-ADAPTATION.json',
];
const APP_PUBLIC_FILES_SET = new Set(APP_PUBLIC_FILES);
const APP_PUBLIC_DIRECTORIES = new Set([
  'ops/chatgpt-launcher', 'ops/chatgpt-launcher/source', 'ops/chatgpt-launcher/product',
]);
const NATIVE_VNC_BINARY = 'dist/computer/native/vnc-launcher';
const NATIVE_VNC_MANIFEST = 'dist/computer/native/launcher-manifest.json';
const NATIVE_VNC_FLAGS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
  '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-fPIE', '-pie',
  '-Wl,-z,relro,-z,now'];
const NATIVE_VNC_FILTER_SHA256 = 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e';
const APP_PRODUCT_FILE_MODES = new Map([
  ['ops/chatgpt-launcher/product/launch-chatgpt.sh', 0o755],
  ['ops/chatgpt-launcher/product/session-supervisor.py', 0o644],
  ['ops/chatgpt-launcher/product/desktop-session.py', 0o644],
  ['ops/chatgpt-launcher/product/session-bus.conf', 0o644],
  ['ops/chatgpt-launcher/product/test-session-lifecycle.py', 0o644],
  ['ops/chatgpt-launcher/product/SOURCE-ADAPTATION.json', 0o644],
]);
const CANDIDATE_RUNTIME_FILE_MODES = new Map([
  [NATIVE_VNC_BINARY, 0o755],
  ...APP_PRODUCT_FILE_MODES,
]);

function lstatOrNull(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function publicEntries(packageDir) {
  const entries = ['package.json', 'bin', 'dist', 'web/dist'];
  const web = fs.lstatSync(path.join(packageDir, 'web'));
  if (!web.isDirectory() || web.isSymbolicLink()) throw new Error('Public web directory is unsafe');
  for (const name of fs.readdirSync(packageDir)) {
    if (/^(README|LICEN[SC]E)(?:\.(?:md|txt))?$/i.test(name)) entries.push(name);
  }
  const opsInfo = lstatOrNull(path.join(packageDir, 'ops'));
  if (opsInfo && (!opsInfo.isDirectory() || opsInfo.isSymbolicLink())) {
    throw new Error('Public updater directory is unsafe');
  }
  const appInfo = opsInfo && lstatOrNull(path.join(packageDir, 'ops/chatgpt-launcher'));
  if (appInfo) {
    if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) {
      throw new Error('Public ChatGPT launcher directory is unsafe');
    }
    for (const directory of APP_PUBLIC_DIRECTORIES) {
      const info = lstatOrNull(path.join(packageDir, directory));
      if (!info || !info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Public ChatGPT launcher directory inventory is incomplete or unsafe');
      }
    }
    const present = APP_PUBLIC_FILES.map((relative) => lstatOrNull(path.join(packageDir, relative)));
    const presentCount = present.filter(Boolean).length;
    if (presentCount !== APP_PUBLIC_FILES.length) {
      throw new Error(presentCount ? 'Public ChatGPT launcher file inventory is incomplete'
        : 'Public ChatGPT launcher directory has no recognized inventory');
    }
    entries.push('ops/chatgpt-launcher');
  }
  for (const name of entries) {
    const file = path.join(packageDir, name);
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw new Error('Public package tree contains an unsafe entry');
    }
  }
  return entries;
}

const SERVER_FILE = /\.(?:[cm]?js|d\.[cm]?ts|map)$/i;
const WEB_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.map', '.css', '.html', '.wasm', '.webmanifest',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.apng',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.mp3', '.ogg', '.wav',
]);

function assertPublicName(relative) {
  const exactPrivateRuntimeModule = relative === 'dist/computer/private-unix.js';
  for (const segment of relative.split(path.sep)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]*$/.test(segment) ||
        (!exactPrivateRuntimeModule && /(?:^|[._-])(?:private|secret|local)(?:[._-]|$)/i.test(segment)) ||
        segment === 'node_modules') {
      throw new Error('Public package inventory contains a hidden or sensitive name');
    }
  }
}

function assertPublicFileClass(relative) {
  assertPublicName(relative);
  if (relative === 'package.json' || /^(?:README|LICEN[SC]E)(?:\.(?:md|txt))?$/i.test(relative)) return;
  if ((relative.startsWith('bin/') || relative.startsWith('dist/')) && SERVER_FILE.test(relative)) return;
  if (relative === NATIVE_VNC_BINARY || relative === NATIVE_VNC_MANIFEST) return;
  if (APP_PUBLIC_FILES_SET.has(relative)) return;
  if (relative.startsWith('web/dist/') && /^(?:robots|humans|ads)\.txt$/i.test(path.basename(relative))) return;
  if (relative.startsWith('web/dist/') && WEB_EXTENSIONS.has(path.extname(relative).toLowerCase())) return;
  throw new Error('Public package inventory contains a non-runtime file class');
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function validSha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

function archiveModeFor(mode) {
  return mode === 0o755 ? '-rwxr-xr-x' : '-rw-r--r--';
}

function assertRuntimeFileMode(packageDir, relative, mode) {
  const file = path.join(packageDir, relative);
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o7777) !== mode) {
    throw new Error(`Staged runtime file has an unexpected mode: ${relative}`);
  }
}

function assertAppProductModes(packageDir) {
  for (const [relative, mode] of APP_PRODUCT_FILE_MODES) {
    assertRuntimeFileMode(packageDir, relative, mode);
  }
}

/** Restore only reviewed staged runtime files whose mode tar extraction masks with the caller umask. */
function normalizeCandidateRuntimeModes(packageDir) {
  for (const [relative, mode] of CANDIDATE_RUNTIME_FILE_MODES) {
    const file = path.join(packageDir, relative);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Staged runtime file is not a regular file: ${relative}`);
    }
    fs.chmodSync(file, mode);
  }
  for (const [relative, mode] of CANDIDATE_RUNTIME_FILE_MODES) {
    assertRuntimeFileMode(packageDir, relative, mode);
  }
}

function validateNativeVncManifest(raw, binarySha256) {
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch { throw new Error('Native VNC launcher manifest is malformed'); }
  if (!exactKeys(manifest, ['schemaVersion', 'platform', 'arch', 'source', 'binary',
    'compiler', 'flags', 'filterSha256']) || manifest.schemaVersion !== 1 ||
      manifest.platform !== 'linux' || manifest.arch !== 'x64' ||
      !exactKeys(manifest.source, ['path', 'sha256']) ||
      manifest.source.path !== 'src/computer/native/vnc-launcher.c' ||
      !validSha256(manifest.source.sha256) ||
      !exactKeys(manifest.binary, ['path', 'sha256']) ||
      manifest.binary.path !== NATIVE_VNC_BINARY || manifest.binary.sha256 !== binarySha256 ||
      !exactKeys(manifest.compiler, ['path', 'realpath', 'sha256', 'version']) ||
      manifest.compiler.path !== '/usr/bin/gcc' ||
      manifest.compiler.realpath !== '/usr/bin/x86_64-linux-gnu-gcc-15' ||
      manifest.compiler.sha256 !== 'b5f1b773a7c733738352000c92a077dc5852a1a2fc6d836b1e411be1e9ec5f88' ||
      manifest.compiler.version !== '15.2.0' ||
      !Array.isArray(manifest.flags) || JSON.stringify(manifest.flags) !== JSON.stringify(NATIVE_VNC_FLAGS) ||
      manifest.filterSha256 !== NATIVE_VNC_FILTER_SHA256) {
    throw new Error('Native VNC launcher manifest does not match the reviewed Linux x64 build');
  }
  return manifest;
}

/** A legacy previous package may omit both optional files; partial or invalid pairs fail closed. */
function assertNativeVncPair(packageDir, { allowAbsent = true } = {}) {
  const binaryPath = path.join(packageDir, NATIVE_VNC_BINARY);
  const manifestPath = path.join(packageDir, NATIVE_VNC_MANIFEST);
  const lstatOrNull = (file) => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  };
  const binaryInfo = lstatOrNull(binaryPath);
  const manifestInfo = lstatOrNull(manifestPath);
  if (!binaryInfo && !manifestInfo && allowAbsent) return false;
  if (!binaryInfo || !manifestInfo) throw new Error('Native VNC launcher artifact pair is incomplete');
  if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink() ||
      (binaryInfo.mode & 0o7777) !== 0o755 || binaryInfo.size < 1 || binaryInfo.size > 1024 * 1024 ||
      !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error('Native VNC launcher binary or manifest has an unsafe file mode or type');
  }
  const binarySha256 = sha256(fs.readFileSync(binaryPath));
  validateNativeVncManifest(fs.readFileSync(manifestPath, 'utf8'), binarySha256);
  return true;
}

/** Validate the entire path/name inventory before reading any candidate archive member. */
function publicFileInventory(packageDir) {
  const entries = publicEntries(packageDir);
  const files = [];
  const visit = (relative) => {
    assertPublicName(relative);
    const absolute = path.join(packageDir, relative);
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error('Public package tree contains a symlink');
    if (info.isDirectory()) {
      if (relative.startsWith('ops/chatgpt-launcher') && !APP_PUBLIC_DIRECTORIES.has(relative)) {
        throw new Error('Public ChatGPT launcher inventory contains an unrecognized directory');
      }
      for (const child of fs.readdirSync(absolute).sort()) visit(path.join(relative, child));
    } else if (info.isFile()) {
      assertPublicFileClass(relative);
      files.push(relative);
    } else throw new Error('Public package tree contains an unsafe entry');
  };
  for (const root of entries.sort()) visit(root);
  assertNativeVncPair(packageDir);
  if (entries.includes('ops/chatgpt-launcher')) assertAppProductModes(packageDir);
  return { entries, files };
}

export function publicTreeDigest(packageDir) {
  const digest = crypto.createHash('sha256');
  const inventory = publicFileInventory(packageDir);
  for (const relative of inventory.files) {
    const absolute = path.join(packageDir, relative);
    const info = fs.lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Public package tree changed during hash');
    digest.update(relative); digest.update('\0');
    digest.update(String(info.size)); digest.update('\0');
    digest.update(hashFile(absolute)); digest.update('\n');
  }
  return { digest: digest.digest('hex'), entries: inventory.entries, files: inventory.files };
}

const CANDIDATE_STATIC_FILES = new Set([
  'package.json', 'npm-shrinkwrap.json', 'README.md', 'LICENSE',
  'docs/terminal-tmux.md', 'ops/README-terminal-update.md',
  'ops/terminal-update.mjs', 'ops/terminal-update-guards.mjs',
  'ops/systemd/deckide.service.d/99-deckide-tmux.conf.tmpl',
  'ops/systemd/deckide-tmux-broker.service.tmpl',
  ...APP_PUBLIC_FILES,
]);

function readArchiveMember(tarball, member) {
  const result = spawnSync('tar', ['-xOf', tarball, member], {
    encoding: null, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error('Candidate archive member could not be read safely');
  }
  return result.stdout;
}

function assertNativeVncArchivePair(tarball, seen, modes) {
  const binaryMember = `package/${NATIVE_VNC_BINARY}`;
  const manifestMember = `package/${NATIVE_VNC_MANIFEST}`;
  if (!seen.has(binaryMember) || !seen.has(manifestMember)) {
    throw new Error('Candidate archive lacks the complete native VNC launcher pair');
  }
  const binary = readArchiveMember(tarball, binaryMember);
  if (!binary.length || binary.length > 1024 * 1024) {
    throw new Error('Candidate native VNC launcher binary size is invalid');
  }
  const binarySha256 = sha256(binary);
  const manifest = readArchiveMember(tarball, manifestMember).toString('utf8');
  validateNativeVncManifest(manifest, binarySha256);
}

function assertArchiveRuntimeModes(seen, modes) {
  for (const [relative, mode] of CANDIDATE_RUNTIME_FILE_MODES) {
    const member = `package/${relative}`;
    if (!seen.has(member) || modes.get(member) !== archiveModeFor(mode)) {
      throw new Error(`Candidate runtime file has an unexpected archive mode: ${relative}`);
    }
  }
}

function inspectCandidateArchive(tarball, commandRunner = run) {
  const names = commandRunner('tar', ['-tf', tarball], { timeout: 30_000 }).trimEnd().split('\n');
  const verbose = commandRunner('tar', ['-tvf', tarball], { timeout: 30_000 }).trimEnd().split('\n');
  if (names.length !== verbose.length || names.length < 2) throw new Error('Candidate tar inventory is invalid');
  const seen = new Set();
  const modes = new Map();
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (!/^package\/[A-Za-z0-9][A-Za-z0-9._@+/-]*$/.test(name) ||
        verbose[index][0] !== '-' || seen.has(name)) {
      throw new Error('Candidate tar contains a duplicate, unsafe path, or non-file entry');
    }
    seen.add(name);
    modes.set(name, verbose[index].slice(0, 10));
    const relative = name.slice('package/'.length);
    assertPublicName(relative);
    if (!CANDIDATE_STATIC_FILES.has(relative)) {
      if (relative.startsWith('bin/') || relative.startsWith('dist/') || relative.startsWith('web/dist/')) {
        assertPublicFileClass(relative);
      } else throw new Error('Candidate tar contains an unknown payload path');
    }
  }
  if (!seen.has('package/package.json') || !seen.has('package/npm-shrinkwrap.json')) {
    throw new Error('Candidate tar lacks its package manifest or published shrinkwrap');
  }
  if (APP_PUBLIC_FILES.some((relative) => !seen.has(`package/${relative}`))) {
    throw new Error('Combined candidate archive lacks the exact ChatGPT launcher inventory');
  }
  assertArchiveRuntimeModes(seen, modes);
  assertNativeVncArchivePair(tarball, seen, modes);
  const manifest = JSON.parse(commandRunner('tar', ['-xOf', tarball, 'package/package.json']));
  const shrinkwrapRaw = commandRunner('tar', ['-xOf', tarball, 'package/npm-shrinkwrap.json']);
  const shrinkwrap = JSON.parse(shrinkwrapRaw);
  if (manifest.name !== 'deckide' || manifest.version !== CANDIDATE_VERSION ||
      shrinkwrap.name !== manifest.name || shrinkwrap.version !== manifest.version ||
      shrinkwrap.lockfileVersion !== 3 || shrinkwrap.packages?.['']?.name !== manifest.name ||
      shrinkwrap.packages?.['']?.version !== manifest.version) {
    throw new Error('Candidate package and published shrinkwrap root identity differ');
  }
  return { manifest, shrinkwrapSha256: sha256(shrinkwrapRaw) };
}

function renderTemplate(file, bindings) {
  let source = fs.readFileSync(path.join(HERE, 'systemd', file), 'utf8');
  for (const [key, value] of Object.entries(bindings)) source = source.replaceAll(`@@${key}@@`, value);
  if (source.includes('@@')) throw new Error('Unfilled systemd template marker');
  return source;
}

function renderedUnits(releasePackage, httpUnit, launch, nodePath) {
  safeAbsolutePath(releasePackage, 'Release package');
  safeServiceUnit(httpUnit);
  const broker = renderTemplate('deckide-tmux-broker.service.tmpl', {
    NODE: safeAbsolutePath(nodePath, 'Node binary'), PACKAGE: releasePackage, HTTP_UNIT: httpUnit,
  });
  const candidateEntry = path.join(releasePackage, launch.entry);
  const args = launch.publicArgs.join(' ');
  const execStart = launch.direct
    ? `${candidateEntry}${args ? ` ${args}` : ''}`
    : `${safeAbsolutePath(launch.nodePath, 'Original Node binary')} ${candidateEntry}${args ? ` ${args}` : ''}`;
  const dropin = renderTemplate(path.join('deckide.service.d', `${DROPIN_NAME}.tmpl`), {
    HTTP_EXEC_START: execStart,
  });
  return { broker, dropin, execStart };
}

function unitPaths(httpUnit) {
  return {
    broker: path.join(UNIT_DIR, BROKER_UNIT),
    dropinDir: path.join(UNIT_DIR, `${httpUnit}.d`),
    dropin: path.join(UNIT_DIR, `${httpUnit}.d`, DROPIN_NAME),
  };
}

function assertAbsent(file, label) {
  try { fs.lstatSync(file); throw new Error(`${label} already exists; refusing to overwrite`); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function assertSafeUnitDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o002)) {
    throw new Error('Systemd unit directory is unsafe');
  }
}

function assertSafeDropinDirectory(directory) {
  try {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o002)) {
      throw new Error('HTTP drop-in directory is unsafe');
    }
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function assertExactFile(file, expectedHash, label) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || hashFile(file) !== expectedHash) {
    throw new Error(`${label} differs from the staged updater file`);
  }
}

function assertPrivateDirectory(directory, label) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== 0)) {
    throw new Error(`${label} must be a root-owned 0700 directory`);
  }
}

function assertRoot() {
  if (process.getuid?.() !== 0) throw new Error('Apply and rollback require an operator running as root');
}

function requireAck(options) {
  if (!options.ackLegacyFinished) {
    throw new Error('Operator must pass --ack-legacy-finished after deliberately finishing old direct PTYs');
  }
}

function requireQuiescence(options) {
  if (!options.ackNoNewTerminals) {
    throw new Error('Operator must block new terminal requests during apply and pass --ack-no-new-terminals');
  }
}

function checkHealth(healthUrl) {
  const target = new URL(healthUrl);
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      target.pathname !== '/health' || target.search || target.hash || target.username || target.password) {
    throw new Error('Health URL must be an unauthenticated loopback /health endpoint');
  }
  return new Promise((resolve, reject) => {
    const request = http.get(target, { timeout: 2000 }, (response) => {
      const pieces = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2048) { request.destroy(new Error('Health response too large')); return; }
        pieces.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(pieces).toString('utf8'));
          if (response.statusCode !== 200 || body?.status !== 'ok') throw new Error('Health check failed');
          resolve();
        } catch { reject(new Error('Health check failed')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Health check timed out')));
    request.on('error', () => reject(new Error('Health check failed')));
  });
}

function readState(stateDir) {
  const directory = fs.lstatSync(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) ||
      (process.getuid && directory.uid !== process.getuid())) {
    throw new Error('Updater state directory is not private');
  }
  const file = path.join(stateDir, 'state.json');
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) {
    throw new Error('Updater state is missing or not private');
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.format !== 1 || state.candidateVersion !== CANDIDATE_VERSION ||
      typeof state.phase !== 'string' || typeof state.httpUnit !== 'string') {
    throw new Error('Unrecognized updater state');
  }
  return state;
}

function writeState(stateDir, state) {
  const file = path.join(stateDir, 'state.json');
  const temp = path.join(stateDir, `state.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

async function readOwnedSessions(state) {
  if (!fs.existsSync(TERMINAL_RUNTIME)) return [];
  const info = fs.lstatSync(TERMINAL_RUNTIME);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) {
    throw new Error('Terminal runtime is not a private directory');
  }
  const { records, pending } = classifyTerminalRuntimeEntries(fs.readdirSync(TERMINAL_RUNTIME));
  if (pending.length) {
    throw new Error('Uncertain pending terminal creation requires operator review');
  }
  if (!records.length) return [];
  const adapterFile = path.join(state.releasePackage, 'dist/terminal/tmuxAdapter.js');
  const { TmuxTerminalAdapter } = await import(pathToFileURL(adapterFile).href);
  const adapter = new TmuxTerminalAdapter({ runtimeDir: TERMINAL_RUNTIME });
  return records.map((name) => {
    const file = path.join(TERMINAL_RUNTIME, name);
    const recordInfo = fs.lstatSync(file);
    if (!recordInfo.isFile() || recordInfo.isSymbolicLink() || (recordInfo.mode & 0o077)) {
      throw new Error('Terminal registry entry is not private');
    }
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (meta.id !== name.slice(0, -5)) throw new Error('Terminal registry filename mismatch');
    adapter.verify(meta); // Exact native session/window/pane/PIDs and server generation.
    return meta;
  });
}

function readCgroup(pid) { return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'); }

async function assertOwnedPlacement(state, httpMeta, brokerMeta) {
  const records = await readOwnedSessions(state);
  if (records.length && (brokerMeta.LoadState !== 'loaded' || brokerMeta.ActiveState !== 'active' ||
      brokerMeta.KillMode !== 'control-group' || !['', 'root'].includes(brokerMeta.User) ||
      !['', 'root'].includes(brokerMeta.Group))) {
    throw new Error('Live owned sessions lack an active independent root broker');
  }
  const httpGroup = httpMeta.ControlGroup || state.httpControlGroup;
  if (httpGroup !== state.httpControlGroup) throw new Error('HTTP cgroup changed since stage');
  assertBrokerCgroups(records, brokerMeta.ControlGroup, httpGroup, readCgroup);
  return records;
}

function stageInput(options) {
  for (const key of ['candidate', 'sha256', 'previousPackage', 'release', 'httpUnit', 'healthUrl']) {
    if (!options[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)}`);
  }
  const candidate = safeAbsolutePath(options.candidate, 'Candidate tarball');
  const previousPackage = fs.realpathSync(safeAbsolutePath(options.previousPackage, 'Previous package'));
  const release = safeAbsolutePath(options.release, 'Release prefix');
  const httpUnit = safeServiceUnit(options.httpUnit);
  const nodePath = safeAbsolutePath(options.node ?? process.execPath, 'Node binary');
  const nodeInfo = fs.lstatSync(nodePath);
  if (!nodeInfo.isFile() || nodeInfo.isSymbolicLink() || !(nodeInfo.mode & 0o111)) {
    throw new Error('Node binary must be an executable regular file');
  }
  if (!/^[0-9a-f]{64}$/i.test(options.sha256)) throw new Error('Expected SHA-256 is invalid');
  if (release === previousPackage || release.startsWith(`${previousPackage}/`) ||
      previousPackage.startsWith(`${release}/`)) throw new Error('Release and previous package paths overlap');
  if (!release.startsWith(`${DEFAULT_RELEASE_ROOT}/`)) {
    throw new Error(`Release must be under the separate SSD prefix ${DEFAULT_RELEASE_ROOT}`);
  }
  checkHealthUrlOnly(options.healthUrl);
  return { candidate, sha256: options.sha256.toLowerCase(), previousPackage, release,
    httpUnit, nodePath, healthUrl: options.healthUrl };
}

function checkHealthUrlOnly(value) {
  const target = new URL(value);
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      target.pathname !== '/health' || target.search || target.hash || target.username || target.password) {
    throw new Error('Health URL must be an unauthenticated loopback /health endpoint');
  }
}

function preparePlan(options) {
  const input = stageInput(options);
  assertInitialBrokerResourcesAbsent();
  const candidateInfo = fs.lstatSync(input.candidate);
  if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) throw new Error('Candidate is not a regular tarball');
  if (hashFile(input.candidate).toLowerCase() !== options.sha256.toLowerCase()) {
    throw new Error('Candidate tarball SHA-256 differs from the operator-provided value');
  }
  inspectCandidateArchive(input.candidate);
  const previous = readPublicPackage(input.previousPackage);
  if (previous.version === CANDIDATE_VERSION) throw new Error('Previous package already has candidate version');
  const previousPublic = publicTreeDigest(input.previousPackage);
  const httpMeta = systemdShow(input.httpUnit, HTTP_PROPERTIES);
  const mainPid = assertHttpService(httpMeta);
  if (httpMeta.DropInPaths.split(/\s+/).some((item) => item.endsWith(`/${DROPIN_NAME}`))) {
    throw new Error('HTTP tmux drop-in already exists outside this updater path');
  }
  const launch = parseDeckideExecStart(httpMeta.ExecStart, input.previousPackage);
  const releasePackage = path.join(input.release, 'node_modules/deckide');
  const units = renderedUnits(releasePackage, input.httpUnit, launch, input.nodePath);
  const paths = unitPaths(input.httpUnit);
  assertSafeUnitDirectory(UNIT_DIR);
  assertSafeDropinDirectory(paths.dropinDir);
  assertAbsent(paths.broker, 'Broker unit');
  assertAbsent(paths.dropin, 'HTTP drop-in');
  const brokerMeta = systemdShow(BROKER_UNIT, BROKER_PROPERTIES);
  if (brokerMeta.LoadState !== 'not-found' || brokerMeta.ActiveState === 'active') {
    throw new Error('Broker unit already exists; initial-install updater refuses to replace it');
  }
  return { input, previous, previousPublic, httpMeta, mainPid, launch, releasePackage,
    units, paths, brokerMeta };
}

function planReport(plan) {
  return {
    candidateVersion: CANDIDATE_VERSION, candidate: plan.input.candidate,
    candidateSha256: hashFile(plan.input.candidate), previousPackage: plan.input.previousPackage,
    previousVersion: plan.previous.version, previousPublicSha256: plan.previousPublic.digest,
    releasePackage: plan.releasePackage, httpUnit: plan.input.httpUnit,
    oldEntry: plan.launch.sourceEntry, candidateEntry: path.join(plan.releasePackage, plan.launch.entry),
    brokerUnit: plan.paths.broker, httpDropin: plan.paths.dropin,
    brokerUnitSha256: sha256(plan.units.broker), httpDropinSha256: sha256(plan.units.dropin),
    healthUrl: plan.input.healthUrl, mainPid: plan.mainPid,
    guard: 'Apply requires a no-new-terminal maintenance window, two operator acknowledgements, and a fresh empty PTY inventory immediately before restart. This is procedural quiescence, not an atomic server lock.',
  };
}

/** npm 11 refuses to load one path as both user and global config. */
export function isolatedNpmConfig(release) {
  const userConfig = '/dev/null';
  const globalConfig = path.join(safeAbsolutePath(release, 'Release prefix'), '.npm-global-empty.rc');
  if (globalConfig === userConfig) throw new Error('npm config files must be distinct');
  return { userConfig, globalConfig };
}

/** Only installer plumbing enters npm and its lifecycle scripts, never HTTP/session secrets. */
export function isolatedNpmInstallSettings(release, nodeExecutable = process.execPath) {
  const { userConfig, globalConfig } = isolatedNpmConfig(release);
  const home = path.join(release, '.npm-home');
  const temporary = path.join(release, '.npm-tmp');
  const cache = path.join(release, '.npm-cache');
  const pathEntries = [...new Set([path.dirname(safeAbsolutePath(nodeExecutable, 'Node binary')),
    '/usr/local/bin', '/usr/bin', '/bin'])];
  return {
    userConfig, globalConfig, home, temporary, cache,
    env: {
      PATH: pathEntries.join(':'), HOME: home, TMPDIR: temporary, LANG: 'C.UTF-8',
      npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
      npm_config_cache: cache,
    },
  };
}

/** Qualifiable staging path: verified npm tar -> fresh package root -> published-lock npm ci. */
export function stageCandidatePackage({ candidate, expectedSha256, release, commandRunner = run }) {
  safeAbsolutePath(candidate, 'Candidate tarball');
  safeAbsolutePath(release, 'Release prefix');
  if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) throw new Error('Expected SHA-256 is invalid');
  const candidateInfo = fs.lstatSync(candidate);
  if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink() ||
      hashFile(candidate).toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error('Candidate tarball is unsafe or differs from the reviewed SHA-256');
  }
  const archive = inspectCandidateArchive(candidate, commandRunner);
  const releasePackage = path.join(release, 'node_modules/deckide');
  assertAbsent(release, 'Candidate release prefix');
  fs.mkdirSync(release, { mode: 0o700 });
  fs.mkdirSync(releasePackage, { recursive: true, mode: 0o700 });
  commandRunner('tar', ['-xzf', candidate, '--strip-components=1', '--no-same-owner',
    '--no-same-permissions', '--keep-old-files', '-C', releasePackage],
    { timeout: 180_000 });
  if (hashFile(candidate).toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error('Candidate tarball changed during extraction');
  }
  normalizeCandidateRuntimeModes(releasePackage);
  const extractedShrinkwrap = path.join(releasePackage, 'npm-shrinkwrap.json');
  const executable = path.join(releasePackage, 'bin/deckide.js');
  const shrinkwrapInfo = fs.lstatSync(extractedShrinkwrap);
  const binInfo = fs.lstatSync(executable);
  if (!shrinkwrapInfo.isFile() || shrinkwrapInfo.isSymbolicLink() ||
      hashFile(extractedShrinkwrap) !== archive.shrinkwrapSha256 ||
      !binInfo.isFile() || binInfo.isSymbolicLink() || !(binInfo.mode & 0o111) ||
      readPublicPackage(releasePackage).version !== CANDIDATE_VERSION) {
    throw new Error('Extracted candidate or published shrinkwrap changed');
  }
  const { userConfig, globalConfig, home, temporary, cache, env } =
    isolatedNpmInstallSettings(release);
  for (const directory of [home, temporary, cache]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(globalConfig, '', { mode: 0o600, flag: 'wx' });
  try {
    commandRunner('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund',
      `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`], {
      timeout: 180_000, cwd: releasePackage, env,
    });
  } finally { fs.unlinkSync(globalConfig); }
  for (const [relative, mode] of CANDIDATE_RUNTIME_FILE_MODES) {
    assertRuntimeFileMode(releasePackage, relative, mode);
  }
  return { releasePackage };
}

function stage(plan, stateDir) {
  assertAbsent(stateDir, 'Updater state directory');
  const releaseParent = path.dirname(plan.input.release);
  if (!fs.existsSync(releaseParent)) throw new Error('Separate SSD release parent does not exist');
  stageCandidatePackage({ candidate: plan.input.candidate,
    expectedSha256: plan.input.sha256, release: plan.input.release });
  const installed = readPublicPackage(plan.releasePackage);
  if (installed.version !== CANDIDATE_VERSION ||
      !fs.existsSync(path.join(plan.releasePackage, 'dist/terminal/tmuxBroker.js')) ||
      !fs.existsSync(path.join(plan.releasePackage, plan.launch.entry))) {
    throw new Error('Staged candidate lacks its required built entry points');
  }
  if (plan.launch.direct && !(fs.statSync(path.join(plan.releasePackage, plan.launch.entry)).mode & 0o111)) {
    throw new Error('Staged direct CLI entry is not executable');
  }
  const candidatePublic = publicTreeDigest(plan.releasePackage).digest;
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const archive = path.join(stateDir, 'previous-public.tar');
  const currentPrevious = publicTreeDigest(plan.input.previousPackage);
  if (currentPrevious.digest !== plan.previousPublic.digest) {
    throw new Error('Previous public package changed before archive creation');
  }
  // Archive the validated file inventory, never a directory that could gain
  // a hidden or private member after the inventory pass.
  run('tar', ['-cf', archive, '--no-recursion', '-C', plan.input.previousPackage,
    '--', ...currentPrevious.files], { timeout: 180_000 });
  fs.chmodSync(archive, 0o600);
  const state = {
    format: 1, phase: 'staged', candidateVersion: CANDIDATE_VERSION,
    candidate: plan.input.candidate, candidateSha256: hashFile(plan.input.candidate),
    release: plan.input.release, releasePackage: plan.releasePackage,
    candidatePublicSha256: candidatePublic,
    previousPackage: plan.input.previousPackage, previousVersion: plan.previous.version,
    previousPublicSha256: plan.previousPublic.digest, previousArchive: archive,
    previousArchiveSha256: hashFile(archive),
    httpUnit: plan.input.httpUnit, healthUrl: plan.input.healthUrl,
    previousEntry: plan.launch.sourceEntry, nodePath: plan.launch.nodePath,
    brokerNodePath: plan.input.nodePath,
    brokerUnitSha256: sha256(plan.units.broker), httpDropinSha256: sha256(plan.units.dropin),
    baseFragmentPath: plan.httpMeta.FragmentPath,
    httpControlGroup: safeControlGroup(plan.httpMeta.ControlGroup),
  };
  writeState(stateDir, state);
  return state;
}

export function checkStaged(state) {
  safeServiceUnit(state.httpUnit);
  safeControlGroup(state.httpControlGroup);
  safeAbsolutePath(state.releasePackage, 'Release package');
  safeAbsolutePath(state.previousPackage, 'Previous package');
  safeAbsolutePath(state.candidate, 'Candidate tarball');
  for (const [file, label] of [[state.candidate, 'Candidate tarball'],
    [state.previousArchive, 'Public rollback archive']]) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  }
  if (hashFile(state.candidate) !== state.candidateSha256) throw new Error('Staged candidate tarball changed');
  if (readPublicPackage(state.releasePackage).version !== CANDIDATE_VERSION ||
      publicTreeDigest(state.releasePackage).digest !== state.candidatePublicSha256) {
    throw new Error('Staged release package changed');
  }
  if (readPublicPackage(state.previousPackage).version !== state.previousVersion ||
      publicTreeDigest(state.previousPackage).digest !== state.previousPublicSha256 ||
      hashFile(state.previousArchive) !== state.previousArchiveSha256) {
    throw new Error('Previous installed package or public rollback archive changed');
  }
}

async function preflightRestart(state, { rollback = false } = {}) {
  const httpMeta = systemdShow(state.httpUnit, HTTP_PROPERTIES);
  const mainPid = assertHttpService(httpMeta);
  if (httpMeta.FragmentPath !== state.baseFragmentPath) throw new Error('HTTP base unit changed since stage');
  if (httpMeta.ControlGroup !== state.httpControlGroup) throw new Error('HTTP cgroup changed since stage');
  const launch = rollback
    ? parseKnownRollbackLaunch(httpMeta.ExecStart, state.previousPackage, state.releasePackage).launch
    : parseDeckideExecStart(httpMeta.ExecStart, state.previousPackage);
  if (!rollback && launch.sourceEntry !== state.previousEntry) {
    throw new Error('HTTP source entry changed since stage');
  }
  const descendants = readProcTree('/proc', mainPid);
  assertNoLegacyPtys(descendants, { verifyTmuxDisplay: rollback ? (process) => {
    if (process.ppid !== mainPid) return false;
    try { return fs.readlinkSync(`/proc/${process.pid}/exe`) === '/usr/bin/tmux'; }
    catch { return false; }
  } : undefined });
  const brokerMeta = systemdShow(BROKER_UNIT, BROKER_PROPERTIES);
  const records = await assertOwnedPlacement(state, httpMeta, brokerMeta);
  if (!rollback && records.length) {
    throw new Error('Initial broker install refuses live owned terminals; do not stop an in-use broker');
  }
  return { httpMeta, brokerMeta, launch, mainPid, records };
}

async function preflightInactiveRollback(state) {
  const httpMeta = systemdShow(state.httpUnit, HTTP_PROPERTIES);
  assertInactiveHttpService(httpMeta, state.httpControlGroup, state.baseFragmentPath);
  assertEmptyServiceCgroup(state.httpControlGroup);
  parseKnownRollbackLaunch(httpMeta.ExecStart, state.previousPackage, state.releasePackage);
  const brokerMeta = systemdShow(BROKER_UNIT, BROKER_PROPERTIES);
  const records = await assertOwnedPlacement(state, httpMeta, brokerMeta);
  return { httpMeta, brokerMeta, records, inactive: true };
}

async function apply(stateDir, options) {
  assertRoot(); requireAck(options); requireQuiescence(options);
  const state = readState(stateDir);
  if (state.phase !== 'staged') throw new Error('Apply requires a staged release that has not been applied');
  checkStaged(state);
  assertInitialBrokerResourcesAbsent();
  const paths = unitPaths(state.httpUnit);
  assertSafeUnitDirectory(UNIT_DIR);
  assertSafeDropinDirectory(paths.dropinDir);
  assertAbsent(paths.broker, 'Broker unit');
  assertAbsent(paths.dropin, 'HTTP drop-in');
  const preflight = await preflightRestart(state);
  if (preflight.brokerMeta.LoadState !== 'not-found') throw new Error('Broker unit already exists');
  const units = renderedUnits(state.releasePackage, state.httpUnit, preflight.launch, state.brokerNodePath);
  if (sha256(units.broker) !== state.brokerUnitSha256 ||
      sha256(units.dropin) !== state.httpDropinSha256) {
    throw new Error('Unit template or recognized HTTP launch flags changed since stage');
  }
  // All checks above precede any unit write. Creation is exclusive; existing
  // service/access settings are never edited.
  state.phase = 'broker-unit-writing'; writeState(stateDir, state);
  fs.writeFileSync(paths.broker, units.broker, { mode: 0o644, flag: 'wx' });
  state.phase = 'broker-unit-written'; writeState(stateDir, state);
  systemctl('daemon-reload');
  assertInitialBrokerResourcesAbsent(); // Do not let systemd retake a path created after initial preflight.
  systemctl('enable', '--now', BROKER_UNIT);
  const broker = systemdShow(BROKER_UNIT, BROKER_PROPERTIES);
  if (broker.ActiveState !== 'active' || broker.KillMode !== 'control-group' ||
      !broker.ControlGroup?.startsWith('/') || broker.ControlGroup === preflight.httpMeta.ControlGroup) {
    throw new Error('Independent broker did not become active; HTTP was not restarted');
  }
  state.phase = 'broker-started'; writeState(stateDir, state);
  // Keep the old HTTP launch untouched until the independent broker is running.
  const current = systemdShow(state.httpUnit, HTTP_PROPERTIES);
  if (assertHttpService(current) !== preflight.mainPid ||
      current.ControlGroup !== preflight.httpMeta.ControlGroup) {
    throw new Error('HTTP process changed before restart; refusing to continue');
  }
  assertNoLegacyPtys(readProcTree('/proc', preflight.mainPid));
  await assertOwnedPlacement(state, current, broker);
  assertAbsent(paths.dropin, 'HTTP drop-in');
  assertSafeDropinDirectory(paths.dropinDir);
  fs.mkdirSync(paths.dropinDir, { recursive: true, mode: 0o755 });
  state.phase = 'dropin-writing'; writeState(stateDir, state);
  fs.writeFileSync(paths.dropin, units.dropin, { mode: 0o644, flag: 'wx' });
  state.phase = 'dropin-written'; writeState(stateDir, state);
  systemctl('daemon-reload');
  const loaded = systemdShow(state.httpUnit, HTTP_PROPERTIES);
  if (assertHttpService(loaded) !== preflight.mainPid ||
      loaded.ControlGroup !== preflight.httpMeta.ControlGroup) {
    throw new Error('HTTP process changed while loading candidate drop-in');
  }
  parseDeckideExecStart(loaded.ExecStart, state.releasePackage);
  state.phase = 'dropin-loaded'; writeState(stateDir, state);
  // Recheck process and cgroup boundaries after the drop-in is loaded,
  // immediately before the only HTTP restart.
  assertNoLegacyPtys(readProcTree('/proc', preflight.mainPid));
  await assertOwnedPlacement(state, loaded, broker);
  state.phase = 'http-restart-requested'; writeState(stateDir, state);
  systemctl('restart', state.httpUnit);
  state.phase = 'http-restarted'; writeState(stateDir, state);
  await verifyState(state);
  state.phase = 'verified'; writeState(stateDir, state);
}

async function verifyState(state) {
  checkStaged(state);
  const paths = unitPaths(state.httpUnit);
  assertExactFile(paths.broker, state.brokerUnitSha256, 'Broker unit');
  assertExactFile(paths.dropin, state.httpDropinSha256, 'HTTP drop-in');
  const httpMeta = systemdShow(state.httpUnit, HTTP_PROPERTIES);
  assertHttpService(httpMeta);
  parseDeckideExecStart(httpMeta.ExecStart, state.releasePackage);
  const brokerMeta = systemdShow(BROKER_UNIT, BROKER_PROPERTIES);
  if (brokerMeta.LoadState !== 'loaded' || brokerMeta.ActiveState !== 'active' ||
      brokerMeta.KillMode !== 'control-group' || brokerMeta.ControlGroup === httpMeta.ControlGroup) {
    throw new Error('Broker is not independently active');
  }
  const socket = fs.lstatSync(BROKER_SOCKET);
  for (const [directory, label] of [
    ['/run/deckide-tmux-broker', 'Broker socket directory'],
    ['/var/lib/deckide-tmux', 'Broker state directory'],
    [TERMINAL_RUNTIME, 'Terminal runtime directory'],
  ]) assertPrivateDirectory(directory, label);
  if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o777) !== 0o600 ||
      (process.getuid && socket.uid !== 0)) {
    throw new Error('Broker IPC socket is not private');
  }
  await assertOwnedPlacement(state, httpMeta, brokerMeta);
  await checkHealth(state.healthUrl);
}

async function rollback(stateDir, options) {
  assertRoot(); requireAck(options); requireQuiescence(options);
  const state = readState(stateDir);
  if (!['broker-unit-writing', 'broker-unit-written', 'broker-started', 'dropin-writing',
    'dropin-written', 'dropin-loaded', 'http-restart-requested', 'http-restarted',
    'verified', 'rollback-removing-dropin', 'rollback-base-loaded',
    'rollback-http-transition-requested'].includes(state.phase)) {
    throw new Error('Rollback requires an installed candidate unit or drop-in');
  }
  const startingPhase = state.phase;
  checkStaged(state);
  const paths = unitPaths(state.httpUnit);
  if (fs.existsSync(paths.broker)) assertExactFile(paths.broker, state.brokerUnitSha256, 'Broker unit');
  const hasDropin = fs.existsSync(paths.dropin);
  if (hasDropin) assertExactFile(paths.dropin, state.httpDropinSha256, 'HTTP drop-in');
  else if (!['broker-unit-writing', 'broker-unit-written', 'broker-started',
    'dropin-writing', 'rollback-removing-dropin', 'rollback-base-loaded',
    'rollback-http-transition-requested'].includes(state.phase)) {
    throw new Error('Expected updater HTTP drop-in is missing');
  }
  const before = systemdShow(state.httpUnit, HTTP_PROPERTIES);
  const initiallyInactive = ['inactive', 'failed'].includes(before.ActiveState);
  if (initiallyInactive && !['http-restart-requested', 'http-restarted', 'verified',
    'rollback-removing-dropin', 'rollback-base-loaded',
    'rollback-http-transition-requested'].includes(startingPhase)) {
    throw new Error('HTTP stopped before the candidate restart; operator review required');
  }
  const current = initiallyInactive
    ? await preflightInactiveRollback(state)
    : await preflightRestart(state, { rollback: true });
  if (current.records.length && current.brokerMeta.ActiveState !== 'active') {
    throw new Error('Live terminal broker is unavailable; rollback refused');
  }
  // Removing only our exact file selects the untouched base unit ExecStart.
  // The broker unit, process, sockets, and tmux sessions remain untouched.
  if (hasDropin) {
    state.phase = 'rollback-removing-dropin'; writeState(stateDir, state);
    fs.unlinkSync(paths.dropin);
  }
  systemctl('daemon-reload');
  state.phase = 'rollback-base-loaded'; writeState(stateDir, state);
  const base = systemdShow(state.httpUnit, HTTP_PROPERTIES);
  const baseLaunch = parseDeckideExecStart(base.ExecStart, state.previousPackage);
  if (baseLaunch.sourceEntry !== state.previousEntry) {
    throw new Error('Base HTTP launcher changed; HTTP was not restarted');
  }
  if (base.FragmentPath !== state.baseFragmentPath) throw new Error('HTTP base unit changed during rollback');
  if (initiallyInactive) {
    assertInactiveHttpService(base, state.httpControlGroup, state.baseFragmentPath);
    assertEmptyServiceCgroup(state.httpControlGroup);
  } else {
    if (assertHttpService(base) !== current.mainPid || base.ControlGroup !== state.httpControlGroup) {
      throw new Error('HTTP process or cgroup changed during rollback');
    }
  }
  const brokerBefore = systemdShow(BROKER_UNIT, BROKER_PROPERTIES);
  await assertOwnedPlacement(state, base, brokerBefore);
  const needsHttpTransition = initiallyInactive || ['http-restart-requested', 'http-restarted',
    'verified', 'rollback-removing-dropin', 'rollback-base-loaded',
    'rollback-http-transition-requested'].includes(startingPhase);
  if (needsHttpTransition) {
    if (initiallyInactive) {
      assertEmptyServiceCgroup(state.httpControlGroup);
    } else {
      const finalInventory = readProcTree('/proc', Number(base.MainPID));
      assertNoLegacyPtys(finalInventory, { verifyTmuxDisplay: (process) => {
        if (process.ppid !== Number(base.MainPID)) return false;
        try { return fs.readlinkSync(`/proc/${process.pid}/exe`) === '/usr/bin/tmux'; }
        catch { return false; }
      } });
    }
    await assertOwnedPlacement(state, base, brokerBefore);
    state.phase = 'rollback-http-transition-requested'; writeState(stateDir, state);
    systemctl(initiallyInactive ? 'start' : 'restart', state.httpUnit);
  }
  const after = systemdShow(state.httpUnit, HTTP_PROPERTIES);
  assertHttpService(after);
  if (after.FragmentPath !== state.baseFragmentPath || after.ControlGroup !== state.httpControlGroup) {
    throw new Error('HTTP base unit or cgroup changed after rollback');
  }
  parseDeckideExecStart(after.ExecStart, state.previousPackage);
  await assertOwnedPlacement(state, after, systemdShow(BROKER_UNIT, BROKER_PROPERTIES));
  await checkHealth(state.healthUrl);
  state.phase = 'rolled-back'; writeState(stateDir, state);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['plan', 'stage', 'apply', 'verify', 'rollback'].includes(command)) {
    throw new Error('Usage: terminal-update.mjs plan|stage|apply|verify|rollback [guarded options]');
  }
  const options = {};
  const names = {
    '--candidate': 'candidate', '--sha256': 'sha256', '--previous-package': 'previousPackage',
    '--release': 'release', '--http-unit': 'httpUnit', '--health-url': 'healthUrl',
    '--node': 'node', '--state-dir': 'stateDir',
  };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--ack-legacy-finished') {
      if (options.ackLegacyFinished) throw new Error('Duplicate acknowledgement');
      options.ackLegacyFinished = true;
      continue;
    }
    if (flag === '--ack-no-new-terminals') {
      if (options.ackNoNewTerminals) throw new Error('Duplicate no-new-terminal acknowledgement');
      options.ackNoNewTerminals = true;
      continue;
    }
    const key = names[flag];
    if (!key || Object.hasOwn(options, key) || !rest[index + 1] || rest[index + 1].startsWith('--')) {
      throw new Error('Unknown, duplicate, or missing updater option');
    }
    options[key] = rest[++index];
  }
  const stateDir = safeAbsolutePath(options.stateDir ?? DEFAULT_STATE_DIR, 'Updater state directory');
  return { command, options, stateDir };
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, options, stateDir } = parseArguments(argv);
  if (command === 'plan' || command === 'stage') {
    const plan = preparePlan(options);
    if (command === 'plan') {
      process.stdout.write(JSON.stringify(planReport(plan), null, 2) + '\n');
      return;
    }
    const state = stage(plan, stateDir);
    process.stdout.write(JSON.stringify({ phase: state.phase, stateDir,
      releasePackage: state.releasePackage, previousArchiveSha256: state.previousArchiveSha256 }, null, 2) + '\n');
    return;
  }
  if (command === 'apply') await apply(stateDir, options);
  if (command === 'verify') await verifyState(readState(stateDir));
  if (command === 'rollback') await rollback(stateDir, options);
  process.stdout.write(JSON.stringify({ phase: readState(stateDir).phase, stateDir }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`Terminal update refused: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
