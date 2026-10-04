import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CANDIDATE_VERSION,
  assertInitialBrokerResourcesAbsent, assertChatGPTStateParentsTrusted, createChatGPTStateRoot,
  CHATGPT_STATE_ROOT, classifyTerminalRuntimeEntries,
  parseShowProperties, assertHttpService, assertInactiveHttpService,
  assertEmptyServiceCgroup, parseDeckideExecStart, parseKnownRollbackLaunch,
  parseProcStat, readProcTree, assertNoLegacyPtys, assertBrokerCgroups,
  safeAbsolutePath, safeServiceUnit,
} from '../ops/terminal-update-guards.mjs';
import { checkStaged, planReport, publicTreeDigest, isolatedNpmInstallSettings,
  renderedUnits, stageCandidatePackage } from '../ops/terminal-update.mjs';

const appPackagePaths = [
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
const startupCheckPackagePath = 'ops/startup-check.mjs';

function writeAppPackageFixture(packageRoot) {
  for (const relative of appPackagePaths) {
    const file = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture:${relative}\n`, {
      mode: relative === 'ops/chatgpt-launcher/product/launch-chatgpt.sh' ? 0o755 : 0o644,
    });
  }
}

test('candidate stage extracts verified tar and runs npm ci at the published shrinkwrap root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-root-ci-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package');
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  const version = CANDIDATE_VERSION;
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'deckide', version, bin: { deckide: 'bin/deckide.js' }, dependencies: {},
  }));
  writeAppPackageFixture(packageRoot);
  fs.mkdirSync(path.join(packageRoot, 'ops'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, startupCheckPackagePath), '// synthetic startup checker fixture\n');
  const lock = { name: 'deckide', version, lockfileVersion: 3, requires: true,
    packages: { '': { name: 'deckide', version, dependencies: {} } } };
  fs.writeFileSync(path.join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(packageRoot, 'bin/deckide.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const privateRuntimeModule = path.join(packageRoot, 'dist/computer/private-unix.js');
  fs.mkdirSync(path.dirname(privateRuntimeModule), { recursive: true });
  fs.writeFileSync(privateRuntimeModule, 'private unix runtime module');
  const nativeDirectory = path.join(packageRoot, 'dist/computer/native');
  fs.mkdirSync(nativeDirectory, { recursive: true });
  const nativeBinary = path.join(nativeDirectory, 'vnc-launcher');
  const nativeManifest = path.join(nativeDirectory, 'launcher-manifest.json');
  const nativeBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]);
  const writeNativeManifest = (overrides = {}) => fs.writeFileSync(nativeManifest, JSON.stringify({
    schemaVersion: 1, platform: 'linux', arch: 'x64',
    source: { path: 'src/computer/native/vnc-launcher.c', sha256: '1'.repeat(64) },
    binary: { path: 'dist/computer/native/vnc-launcher',
      sha256: crypto.createHash('sha256').update(nativeBytes).digest('hex') },
    compiler: { path: '/usr/bin/gcc', realpath: '/usr/bin/x86_64-linux-gnu-gcc-15',
      sha256: 'b5f1b773a7c733738352000c92a077dc5852a1a2fc6d836b1e411be1e9ec5f88',
      version: '15.2.0' },
    flags: ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fstack-protector-strong',
      '-D_FORTIFY_SOURCE=2', '-fPIE', '-pie', '-Wl,-z,relro,-z,now'],
    filterSha256: 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e',
    ...overrides,
  }));
  fs.writeFileSync(nativeBinary, nativeBytes, { mode: 0o755 });
  writeNativeManifest();
  const makeTar = (filename, entries) => {
    const tarball = path.join(root, filename);
    const result = spawnSync('tar', ['-czf', tarball, '--no-recursion', '-C', root, ...entries],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { candidate: tarball, expectedSha256: crypto.createHash('sha256')
      .update(fs.readFileSync(tarball)).digest('hex') };
  };
  const entries = ['package/package.json', 'package/npm-shrinkwrap.json', 'package/bin/deckide.js',
    'package/dist/computer/private-unix.js',
    'package/dist/computer/native/vnc-launcher', 'package/dist/computer/native/launcher-manifest.json',
    `package/${startupCheckPackagePath}`,
    ...appPackagePaths.map((relative) => `package/${relative}`)];
  const archive = makeTar('candidate.tgz', entries);
  const calls = [];
  const runner = (file, args, options = {}) => {
    calls.push({ file, args, options });
    if (file === 'npm') return '';
    const result = spawnSync(file, args, { encoding: 'utf8', timeout: options.timeout ?? 15_000,
      maxBuffer: 2 * 1024 * 1024, cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw new Error(`${file} fixture invocation failed`);
    return result.stdout;
  };
  const release = path.join(root, 'release');
  const originalUmask = process.umask(0o077);
  let staged;
  try { staged = stageCandidatePackage({ ...archive, release, commandRunner: runner }); }
  finally { process.umask(originalUmask); }
  assert.equal(staged.releasePackage, path.join(release, 'node_modules/deckide'));
  assert.equal(fs.readFileSync(path.join(staged.releasePackage, 'npm-shrinkwrap.json'), 'utf8'),
    JSON.stringify(lock), 'the published lock is npm ci root, not a nested dependency hint');
  assert.ok(fs.statSync(path.join(staged.releasePackage, 'bin/deckide.js')).mode & 0o111);
  assert.equal(fs.statSync(release).mode & 0o7777, 0o700);
  assert.equal(fs.statSync(staged.releasePackage).mode & 0o7777, 0o700);
  assert.equal(fs.statSync(path.join(staged.releasePackage, 'dist/computer/native/vnc-launcher')).mode & 0o7777,
    0o755, 'the native executable is restored to its exact reviewed runtime mode');
  for (const relative of appPackagePaths.filter((item) => item.startsWith('ops/chatgpt-launcher/product/'))) {
    const expectedMode = relative.endsWith('/launch-chatgpt.sh') ? 0o755 : 0o644;
    assert.equal(fs.statSync(path.join(staged.releasePackage, relative)).mode & 0o7777, expectedMode, relative);
  }
  assert.equal(fs.statSync(path.join(staged.releasePackage,
    'ops/chatgpt-launcher/source/launch-chatgpt.sh')).mode & 0o7777, 0o600,
  'mode repair is limited to reviewed product runtime files, not source provenance');
  assert.equal(fs.statSync(path.join(staged.releasePackage, startupCheckPackagePath)).mode & 0o7777, 0o600,
    'the checker is hashed as code but does not receive unrelated mode repair');
  assert.equal(fs.statSync(path.join(staged.releasePackage, 'dist/computer/private-unix.js')).mode & 0o7777,
    0o600, 'mode repair does not widen unrelated runtime files');
  const npmCalls = calls.filter(({ file }) => file === 'npm');
  assert.equal(npmCalls.length, 1);
  assert.equal(npmCalls[0].args[0], 'ci');
  assert.equal(npmCalls[0].options.cwd, staged.releasePackage);
  assert.ok(npmCalls[0].args.includes('--omit=dev'));
  assert.ok(!npmCalls[0].args.includes('install'));

  fs.chmodSync(nativeBinary, 0o750);
  const wrongMode = makeTar('wrong-native-mode.tgz', entries);
  assert.throws(() => stageCandidatePackage({ ...wrongMode, release: path.join(root, 'wrong-native-mode-release'),
    commandRunner: runner }), /unexpected archive mode/);
  assert.ok(!fs.existsSync(path.join(root, 'wrong-native-mode-release')));
  fs.chmodSync(nativeBinary, 0o755);

  const productSupervisor = path.join(packageRoot, 'ops/chatgpt-launcher/product/session-supervisor.py');
  fs.chmodSync(productSupervisor, 0o600);
  const wrongProductMode = makeTar('wrong-product-mode.tgz', entries);
  assert.throws(() => stageCandidatePackage({ ...wrongProductMode,
    release: path.join(root, 'wrong-product-mode-release'), commandRunner: runner }), /unexpected archive mode/);
  assert.ok(!fs.existsSync(path.join(root, 'wrong-product-mode-release')));
  fs.chmodSync(productSupervisor, 0o644);

  fs.rmSync(path.join(packageRoot, 'npm-shrinkwrap.json'));
  const missing = makeTar('missing-lock.tgz', entries.filter((entry) => !entry.endsWith('npm-shrinkwrap.json')));
  assert.throws(() => stageCandidatePackage({ ...missing, release: path.join(root, 'missing-release'),
    commandRunner: runner }), /lacks its package manifest or published shrinkwrap/);
  assert.ok(!fs.existsSync(path.join(root, 'missing-release')));
  assert.equal(calls.filter(({ file }) => file === 'npm').length, 1);

  fs.writeFileSync(path.join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify(lock));
  fs.writeFileSync(nativeManifest, JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: 'x64' }));
  const tamperedManifest = makeTar('tampered-native-manifest.tgz', entries);
  assert.throws(() => stageCandidatePackage({ ...tamperedManifest, release: path.join(root, 'tampered-native-release'),
    commandRunner: runner }), /manifest/);
  assert.ok(!fs.existsSync(path.join(root, 'tampered-native-release')));

  fs.writeFileSync(nativeManifest, JSON.stringify({
    schemaVersion: 1, platform: 'linux', arch: 'x64',
    source: { path: 'src/computer/native/vnc-launcher.c', sha256: '1'.repeat(64) },
    binary: { path: 'dist/computer/native/vnc-launcher', sha256: '0'.repeat(64) },
    compiler: { path: '/usr/bin/gcc', realpath: '/usr/bin/x86_64-linux-gnu-gcc-15',
      sha256: 'b5f1b773a7c733738352000c92a077dc5852a1a2fc6d836b1e411be1e9ec5f88', version: '15.2.0' },
    flags: ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fstack-protector-strong',
      '-D_FORTIFY_SOURCE=2', '-fPIE', '-pie', '-Wl,-z,relro,-z,now'],
    filterSha256: 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e',
  }));
  const mismatchedBinaryHash = makeTar('mismatched-native-hash.tgz', entries);
  assert.throws(() => stageCandidatePackage({ ...mismatchedBinaryHash,
    release: path.join(root, 'mismatched-native-release'), commandRunner: runner }), /manifest/);
  assert.ok(!fs.existsSync(path.join(root, 'mismatched-native-release')));

  writeNativeManifest();
  const partialPair = makeTar('partial-native-pair.tgz', entries.filter((entry) => !entry.endsWith('/launcher-manifest.json')));
  assert.throws(() => stageCandidatePackage({ ...partialPair, release: path.join(root, 'partial-native-release'),
    commandRunner: runner }), /complete native VNC/);
  assert.ok(!fs.existsSync(path.join(root, 'partial-native-release')));

  const appFile = 'package/ops/chatgpt-launcher/product/session-supervisor.py';
  const incompleteApp = makeTar('incomplete-app.tgz', entries.filter((entry) => entry !== appFile));
  assert.throws(() => stageCandidatePackage({ ...incompleteApp, release: path.join(root, 'incomplete-app-release'),
    commandRunner: runner }), /exact ChatGPT launcher inventory/);
  const extraAppFile = path.join(packageRoot, 'ops/chatgpt-launcher/product/unlisted.py');
  fs.writeFileSync(extraAppFile, 'unlisted fixture');
  const extraApp = makeTar('extra-app.tgz', [...entries, 'package/ops/chatgpt-launcher/product/unlisted.py']);
  assert.throws(() => stageCandidatePackage({ ...extraApp, release: path.join(root, 'extra-app-release'),
    commandRunner: runner }), /unknown payload path/);
  assert.ok(!fs.existsSync(path.join(root, 'incomplete-app-release')));
  assert.ok(!fs.existsSync(path.join(root, 'extra-app-release')));
  fs.unlinkSync(extraAppFile);
  const noStartupChecker = makeTar('missing-startup-checker.tgz',
    entries.filter((entry) => entry !== `package/${startupCheckPackagePath}`));
  assert.throws(() => stageCandidatePackage({ ...noStartupChecker,
    release: path.join(root, 'missing-startup-checker-release'), commandRunner: runner }), /startup configuration checker/);
  assert.ok(!fs.existsSync(path.join(root, 'missing-startup-checker-release')));
  assert.equal(calls.filter(({ file }) => file === 'npm').length, 1);

  lock.packages[''].version = 'wrong-version';
  fs.writeFileSync(path.join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify(lock));
  const mismatch = makeTar('mismatch-lock.tgz', entries);
  assert.throws(() => stageCandidatePackage({ ...mismatch, release: path.join(root, 'mismatch-release'),
    commandRunner: runner }), /shrinkwrap root identity differ/);
  assert.ok(!fs.existsSync(path.join(root, 'mismatch-release')));
  assert.equal(calls.filter(({ file }) => file === 'npm').length, 1);

  fs.symlinkSync('deckide.js', path.join(packageRoot, 'bin/link.js'));
  const link = makeTar('symlink.tgz', [...entries, 'package/bin/link.js']);
  assert.throws(() => stageCandidatePackage({ ...link, release: path.join(root, 'link-release'),
    commandRunner: runner }), /non-file entry/);
  assert.ok(!fs.existsSync(path.join(root, 'link-release')));
  fs.unlinkSync(path.join(packageRoot, 'bin/link.js'));

  fs.writeFileSync(path.join(packageRoot, '.env'), 'fixture-private-value');
  const hidden = makeTar('hidden.tgz', [...entries, 'package/.env']);
  assert.throws(() => stageCandidatePackage({ ...hidden, release: path.join(root, 'hidden-release'),
    commandRunner: runner }), /unsafe path/);
  assert.ok(!fs.existsSync(path.join(root, 'hidden-release')));
  assert.equal(calls.filter(({ file }) => file === 'npm').length, 1);
});

test('initial install leaves existing broker-owned paths untouched', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-broker-resource-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = [path.join(root, 'run'), path.join(root, 'state'),
    path.join(root, 'state/terminal-tmux'), path.join(root, 'run/broker.sock'),
    path.join(root, 'state/deckide-chatgpt')];
  assert.doesNotThrow(() => assertInitialBrokerResourcesAbsent(paths));
  for (let index = 0; index < paths.length; index++) {
    const fixture = path.join(root, `case-${index}`);
    const resources = [path.join(fixture, 'run'), path.join(fixture, 'state'),
      path.join(fixture, 'state/terminal-tmux'), path.join(fixture, 'run/broker.sock'),
      path.join(fixture, 'state/deckide-chatgpt')];
    const selected = resources[index];
    fs.mkdirSync(path.dirname(selected), { recursive: true });
    if (index === 3) fs.writeFileSync(selected, 'fixture');
    else fs.mkdirSync(selected, { mode: 0o755 });
    const mode = fs.lstatSync(selected).mode & 0o777;
    assert.throws(() => assertInitialBrokerResourcesAbsent(resources), /already exists/);
    assert.equal(fs.lstatSync(selected).mode & 0o777, mode, 'preflight never changes existing permissions');
  }
});

test('ChatGPT owner state root is created exclusively below trusted canonical parents', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-chatgpt-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const varRoot = path.join(root, 'var');
  const libRoot = path.join(varRoot, 'lib');
  fs.mkdirSync(libRoot, { recursive: true, mode: 0o755 });
  fs.chmodSync(varRoot, 0o755);
  fs.chmodSync(libRoot, 0o755);
  const parentInfo = fs.statSync(libRoot);
  const expectedUid = parentInfo.uid;
  const expectedGid = parentInfo.gid;
  const stateRoot = path.join(libRoot, 'deckide-chatgpt');
  const controlRoot = path.join(stateRoot, '.app-session-control');
  assert.equal(assertChatGPTStateParentsTrusted({ varRoot, libRoot, expectedUid }), libRoot);
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  assert.throws(() => createChatGPTStateRoot({ stateRoot, varRoot, libRoot,
    expectedUid, expectedGid }), /already exists/);
  assert.deepEqual(fs.readdirSync(stateRoot), [], 'an existing root missing its control directory is not adopted or repaired');
  fs.rmdirSync(stateRoot);
  const originalUmask = process.umask(0o777);
  try {
    assert.equal(createChatGPTStateRoot({ stateRoot, varRoot, libRoot, expectedUid, expectedGid }), stateRoot);
  } finally { process.umask(originalUmask); }
  assert.equal(fs.lstatSync(stateRoot).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(stateRoot).uid, expectedUid);
  assert.equal(fs.lstatSync(stateRoot).gid, expectedGid);
  assert.equal(fs.lstatSync(controlRoot).mode & 0o7777, 0o700);
  assert.equal(fs.lstatSync(controlRoot).uid, expectedUid);
  assert.equal(fs.lstatSync(controlRoot).gid, expectedGid);
  assert.deepEqual(fs.readdirSync(stateRoot), ['.app-session-control'],
    'updater creates only the required control directory, without descriptors, credentials, or runtime files');
  assert.deepEqual(fs.readdirSync(controlRoot), [], 'the new private control directory is empty');
  assert.throws(() => createChatGPTStateRoot({ stateRoot, varRoot, libRoot, expectedUid, expectedGid }), /already exists/);
  assert.equal(CHATGPT_STATE_ROOT, '/var/lib/deckide-chatgpt');
  assert.equal(CANDIDATE_VERSION, CANDIDATE_VERSION);

  const symlinkVar = path.join(root, 'var-link');
  fs.symlinkSync(varRoot, symlinkVar);
  assert.throws(() => assertChatGPTStateParentsTrusted({ varRoot: symlinkVar,
    libRoot: path.join(symlinkVar, 'lib'), expectedUid }), /canonical|trusted/);
  fs.chmodSync(libRoot, 0o777);
  assert.throws(() => assertChatGPTStateParentsTrusted({ varRoot, libRoot, expectedUid }), /trusted/);

  if (process.getuid?.() === 0) {
    const inheritedRoot = path.join(root, 'inherited-var');
    const inheritedLib = path.join(inheritedRoot, 'lib');
    fs.mkdirSync(inheritedLib, { recursive: true, mode: 0o755 });
    const foreignGid = expectedGid === 65534 ? 65533 : 65534;
    fs.chownSync(inheritedLib, expectedUid, foreignGid);
    fs.chmodSync(inheritedLib, 0o2755);
    const before = fs.lstatSync(inheritedLib);
    const inheritedState = path.join(inheritedLib, 'deckide-chatgpt');
    assert.throws(() => createChatGPTStateRoot({ stateRoot: inheritedState,
      varRoot: inheritedRoot, libRoot: inheritedLib, expectedUid, expectedGid }),
    /root-group|special mode bits/);
    const after = fs.lstatSync(inheritedLib);
    const rejected = fs.lstatSync(inheritedState);
    assert.equal(after.gid, before.gid, 'refusal does not chown an existing parent');
    assert.equal(after.mode & 0o7777, before.mode & 0o7777, 'refusal does not chmod an existing parent');
    assert.equal(rejected.gid, foreignGid, 'mismatched inherited group is not repaired');
    assert.ok(rejected.mode & 0o2000, 'inherited setgid is rejected without clearing the bit');
  }
});

test('unknown registry JSON names cannot be omitted from owned-session placement', () => {
  const id = 'b1bd66d5-f62b-479e-a8b0-87da92244ee1';
  assert.deepEqual(classifyTerminalRuntimeEntries([`${id}.json`, `${id}.pending.json`, `${id}.conf`, 's-0123456789abcdef.sock']),
    { records: [`${id}.json`], pending: [`${id}.pending.json`] });
  for (const name of ['renamed.json', `${id}.JSON`, `${id}.json.tmp`,
    `${id}.json.abc.tmp`, `${id}.pending.json.tmp`]) {
    assert.throws(() => classifyTerminalRuntimeEntries([name]), /Unknown terminal registry filename/);
  }
});

test('staged npm uses distinct empty configs and a minimal environment even with ambient secrets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-npm-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSecret = process.env.DECKIDE_SYNTHETIC_INSTALL_SECRET;
  process.env.DECKIDE_SYNTHETIC_INSTALL_SECRET = 'fixture-private-value';
  t.after(() => {
    if (oldSecret === undefined) delete process.env.DECKIDE_SYNTHETIC_INSTALL_SECRET;
    else process.env.DECKIDE_SYNTHETIC_INSTALL_SECRET = oldSecret;
  });
  const settings = isolatedNpmInstallSettings(root);
  assert.notEqual(settings.userConfig, settings.globalConfig);
  assert.equal(settings.userConfig, '/dev/null');
  assert.equal(settings.globalConfig, path.join(root, '.npm-global-empty.rc'));
  for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NODE_OPTIONS', 'LD_PRELOAD',
    'DECKIDE_SYNTHETIC_INSTALL_SECRET']) assert.ok(!Object.hasOwn(settings.env, key));
  assert.doesNotMatch(JSON.stringify(settings.env), /fixture-private-value/);
  for (const directory of [settings.home, settings.temporary, settings.cache]) fs.mkdirSync(directory);
  fs.writeFileSync(settings.globalConfig, '', { mode: 0o600 });
  const result = spawnSync('npm', ['--version', `--userconfig=${settings.userConfig}`,
    `--globalconfig=${settings.globalConfig}`], {
    cwd: root, env: settings.env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, 'npm must accept distinct empty config files');
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);
});

function service(overrides = {}) {
  return {
    LoadState: 'loaded', ActiveState: 'active', User: '', Group: '',
    DynamicUser: 'no', KillMode: 'control-group', MainPID: '100',
    ControlGroup: '/system.slice/deckide.service',
    FragmentPath: '/etc/systemd/system/deckide.service', ...overrides,
  };
}

function stat(pid, comm, ppid, ttyNr = 0, state = 'S') {
  return `${pid} (${comm}) ${state} ${ppid} 0 0 ${ttyNr} 0 0 0 0 0\n`;
}

test('scoped systemd metadata requires fixed root identity and control-group kill policy', () => {
  const properties = ['User', 'Group', 'KillMode'];
  assert.deepEqual(parseShowProperties('User=\nGroup=root\nKillMode=control-group\n', properties),
    { User: '', Group: 'root', KillMode: 'control-group' });
  assert.equal(assertHttpService(service()), 100);
  assert.throws(() => assertHttpService(service({ User: 'deckide' })), /root/);
  assert.throws(() => assertHttpService(service({ DynamicUser: 'yes' })), /root/);
  assert.throws(() => assertHttpService(service({ KillMode: 'process' })), /control-group/);
  assert.throws(() => assertHttpService(service({ MainPID: '0' })), /MainPID/);
  assert.throws(() => parseShowProperties('User=root\nUser=root\n', ['User']), /Unexpected/);
});

test('failed HTTP may roll back only with zero MainPID and its staged service cgroup', () => {
  const group = '/system.slice/deckide.service';
  const fragment = '/etc/systemd/system/deckide.service';
  const stopped = service({ ActiveState: 'failed', MainPID: '0', ControlGroup: '' });
  assert.equal(assertInactiveHttpService(stopped, group, fragment), group);
  assert.throws(() => assertInactiveHttpService({ ...stopped, MainPID: '42' }, group, fragment), /uncertain/);
  assert.throws(() => assertInactiveHttpService({ ...stopped, ControlGroup: '/system.slice/other.service' },
    group, fragment), /uncertain/);
  assert.throws(() => assertInactiveHttpService({ ...stopped, ActiveState: 'active' }, group, fragment), /uncertain/);
  assert.throws(() => assertInactiveHttpService(stopped, '/../other', fragment), /unsafe/);
});

test('inactive HTTP cgroup must be absent or empty through every nested subgroup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-cgroup-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const group = '/system.slice/deckide.service';
  assert.doesNotThrow(() => assertEmptyServiceCgroup(group, root), 'a removed former cgroup is empty');
  const top = path.join(root, 'system.slice/deckide.service');
  const child = path.join(top, 'control');
  fs.mkdirSync(child, { recursive: true });
  for (const directory of [top, child]) {
    fs.writeFileSync(path.join(directory, 'cgroup.procs'), '');
    fs.writeFileSync(path.join(directory, 'cgroup.threads'), '');
  }
  assert.doesNotThrow(() => assertEmptyServiceCgroup(group, root));
  fs.writeFileSync(path.join(child, 'cgroup.procs'), '4242\n');
  assert.throws(() => assertEmptyServiceCgroup(group, root), /retains processes/);
  fs.writeFileSync(path.join(child, 'cgroup.procs'), '');
  fs.writeFileSync(path.join(top, 'cgroup.threads'), '4242\n');
  assert.throws(() => assertEmptyServiceCgroup(group, root), /retains threads/);
  fs.writeFileSync(path.join(top, 'cgroup.threads'), '');
  fs.rmSync(path.join(child, 'cgroup.procs'));
  assert.throws(() => assertEmptyServiceCgroup(group, root), /Cannot verify/);
});

test('previous package launcher is recognized without retaining arbitrary flags or secrets', () => {
  const root = '/opt/old/deckide';
  const node = '/usr/local/bin/node';
  const raw = `{ path=${node} ; argv[]=${node} ${root}/bin/deckide.js start --fg --no-open -p 8787 --host 127.0.0.1 ; ignore_errors=no ; }`;
  const launch = parseDeckideExecStart(raw, root, (value) => value);
  assert.deepEqual(launch, {
    entry: 'bin/deckide.js', nodePath: node, sourceEntry: `${root}/bin/deckide.js`,
    publicArgs: ['start', '--fg', '--no-open', '-p', '8787', '--host', '127.0.0.1'], direct: false,
  });
  const direct = parseDeckideExecStart(`{ path=${root}/bin/deckide.js ; argv[]=${root}/bin/deckide.js start --fg ; }`, root,
    (value) => value);
  assert.equal(direct.direct, true);
  const server = parseDeckideExecStart(`{ path=${node} ; argv[]=${node} ${root}/dist/index.js ; }`, root,
    (value) => value);
  assert.equal(server.entry, 'dist/index.js');
  assert.throws(() => parseDeckideExecStart(raw.replace(' --host 127.0.0.1', ' --password secret'), root,
    (value) => value), /unrecognized flag/);
  assert.throws(() => parseDeckideExecStart(raw.replace(`${root}/bin/deckide.js`, '/opt/other/bin/deckide.js'), root,
    (value) => value), /previous package/);
  assert.throws(() => parseDeckideExecStart(raw.replace(' ; ignore_errors=no ; }',
    ' --chatgpt-desktop ; ignore_errors=no ; }'), root,
    (value) => value), /unrecognized flag/);
});

test('candidate launcher accepts only one trailing ChatGPT flag while preserving its launch form', () => {
  const candidate = '/opt/new/deckide';
  const node = '/usr/local/bin/node';
  const resolve = (value) => value;
  const cli = `{ path=${node} ; argv[]=${node} ${candidate}/bin/deckide.js start --fg --no-open --chatgpt-desktop ; }`;
  const parsedCli = parseDeckideExecStart(cli, candidate, resolve,
    { allowChatgptDesktop: true, requireChatgptDesktop: true });
  assert.equal(parsedCli.entry, 'bin/deckide.js');
  assert.deepEqual(parsedCli.publicArgs, ['start', '--fg', '--no-open', '--chatgpt-desktop']);
  assert.equal(parsedCli.nodePath, node);

  const direct = `{ path=${node} ; argv[]=${node} ${candidate}/dist/index.js --chatgpt-desktop ; }`;
  const parsedDirect = parseDeckideExecStart(direct, candidate, resolve,
    { allowChatgptDesktop: true, requireChatgptDesktop: true });
  assert.equal(parsedDirect.entry, 'dist/index.js');
  assert.deepEqual(parsedDirect.publicArgs, ['--chatgpt-desktop']);
  assert.equal(parsedDirect.nodePath, node);
  assert.throws(() => parseDeckideExecStart(cli, candidate, resolve), /unrecognized flag/);
  assert.throws(() => parseDeckideExecStart(cli.replace('--no-open --chatgpt-desktop',
    '--chatgpt-desktop --no-open'), candidate, resolve,
  { allowChatgptDesktop: true, requireChatgptDesktop: true }), /unrecognized flag/);
  assert.throws(() => parseDeckideExecStart(cli.replace('--chatgpt-desktop',
    '--chatgpt-desktop --chatgpt-desktop'), candidate, resolve,
  { allowChatgptDesktop: true, requireChatgptDesktop: true }), /unrecognized flag/);
  assert.throws(() => parseDeckideExecStart(cli.replace(' --chatgpt-desktop', ''), candidate, resolve,
    { allowChatgptDesktop: true, requireChatgptDesktop: true }), /unrecognized flag/);
});

test('rollback accepts either known effective launcher across daemon-reload and state-write crash', () => {
  const previous = '/opt/old/deckide';
  const candidate = '/opt/new/deckide';
  const node = '/usr/local/bin/node';
  const raw = (root) => `{ path=${node} ; argv[]=${node} ${root}/bin/deckide.js start --fg ; }`;
  const resolve = (value) => value;
  assert.equal(parseKnownRollbackLaunch(raw(previous), previous, candidate, resolve).kind, 'previous');
  assert.equal(parseKnownRollbackLaunch(`${raw(candidate).replace(' ; }', ' --chatgpt-desktop ; }')}`,
    previous, candidate, resolve).kind, 'candidate');
  assert.equal(parseKnownRollbackLaunch(
    `{ path=${node} ; argv[]=${node} ${candidate}/bin/deckide.js start --fg --chatgpt-desktop ; }`,
    previous, candidate, resolve).kind, 'candidate');
  assert.throws(() => parseKnownRollbackLaunch(
    `{ path=${node} ; argv[]=${node} ${candidate}/bin/deckide.js start --fg --chatgpt-desktop --no-open ; }`,
    previous, candidate, resolve), /neither/);
  assert.throws(() => parseKnownRollbackLaunch(raw('/opt/other/deckide'), previous, candidate, resolve),
    /neither/);
});

test('process inventory reads only stat and refuses legacy PTY/shell descendants', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-proc-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [pid, comm, ppid, tty] of [
    [100, 'node', 1, 0], [101, 'chrome', 100, 0],
    [102, 'bash', 100, 0], [103, 'python', 102, 34817], [999, 'unrelated', 1, 0],
  ]) {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), 'stat'), stat(pid, comm, ppid, tty));
  }
  assert.deepEqual(parseProcStat(stat(102, 'bash', 100)).ppid, 100);
  const descendants = readProcTree(root, 100);
  assert.deepEqual(descendants.map((item) => item.pid).sort(), [101, 102, 103]);
  assert.throws(() => assertNoLegacyPtys(descendants), /Legacy terminal descendant/);
  assert.doesNotThrow(() => assertNoLegacyPtys(descendants.filter((item) => item.pid === 101)));
  assert.throws(() => readProcTree(root, 777), /MainPID changed/);
  assert.throws(() => parseProcStat(stat(1, 'unknown', 0, 0, '?')), /Unknown/);
});

test('rollback permits only a verified tmux display client, never an unverified tmux process', () => {
  const display = parseProcStat(stat(200, 'tmux: client', 100, 34817));
  assert.throws(() => assertNoLegacyPtys([display]), /Legacy/);
  assert.throws(() => assertNoLegacyPtys([display], { verifyTmuxDisplay: () => false }), /Legacy/);
  assert.doesNotThrow(() => assertNoLegacyPtys([display], { verifyTmuxDisplay: () => true }));
  const server = parseProcStat(stat(201, 'tmux: server', 100, 0));
  assert.throws(() => assertNoLegacyPtys([server], { verifyTmuxDisplay: () => true }), /Legacy/);
});

test('live tmux server generation must belong to broker cgroup rather than HTTP cgroup', () => {
  const records = [{ serverPid: 300 }];
  const broker = '/system.slice/deckide-tmux-broker.service';
  const http = '/system.slice/deckide.service';
  assert.doesNotThrow(() => assertBrokerCgroups(records, broker, http,
    () => `0::${broker}\n`));
  assert.throws(() => assertBrokerCgroups(records, broker, http,
    () => `0::${http}\n`), /not isolated/);
  assert.throws(() => assertBrokerCgroups(records, broker, http,
    () => '0::/system.slice/other.service\n'), /not isolated/);
  assert.throws(() => assertBrokerCgroups(records, broker, http,
    () => '12:memory:/system.slice/other.service\n'), /unified/);
});

test('unit and path validation rejects traversal or systemd specifier injection', () => {
  assert.equal(safeServiceUnit('deckide.service'), 'deckide.service');
  assert.throws(() => safeServiceUnit('../deckide.service'), /basename/);
  assert.throws(() => safeAbsolutePath('/tmp/release %u', 'Release'), /absolute path/);
  assert.throws(() => safeAbsolutePath('/tmp/../etc/systemd', 'Release'), /absolute path/);
});

test('rollback digest includes only public package files and rejects symlink traversal', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['bin', 'dist', 'web/dist']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"deckide","version":"3.5.49"}');
  for (const file of ['bin/deckide.js', 'dist/index.js', 'web/dist/index.html']) {
    fs.writeFileSync(path.join(root, file), 'public');
  }
  const first = publicTreeDigest(root).digest;
  fs.writeFileSync(path.join(root, '.env'), 'private fixture');
  assert.equal(publicTreeDigest(root).digest, first, 'private files never enter public archive digest');
  fs.writeFileSync(path.join(root, 'dist/index.js'), 'changed public code');
  assert.notEqual(publicTreeDigest(root).digest, first);
  fs.renameSync(path.join(root, 'web'), path.join(root, 'web-original'));
  fs.symlinkSync(path.join(root, 'web-original'), path.join(root, 'web'));
  assert.throws(() => publicTreeDigest(root), /unsafe/);
});

test('public archive inventory rejects hidden, sensitive, and non-runtime files before any file hash', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-public-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['bin', 'dist', 'web/dist']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"deckide","version":"3.5.49"}');
  for (const file of ['bin/deckide.js', 'dist/auth/credentials.js', 'dist/index.js',
    'dist/index.js.map', 'dist/types.d.ts', 'web/dist/index.html', 'web/dist/site.css',
    'web/dist/font.woff2', 'web/dist/logo.svg']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'public fixture');
  }
  const ordinary = publicTreeDigest(root);
  assert.ok(ordinary.files.includes('dist/auth/credentials.js'), 'legitimate compiled auth code remains allowed');
  assert.ok(ordinary.files.includes('web/dist/font.woff2'));
  const archive = path.join(root, 'public.tar');
  fs.writeFileSync(path.join(root, 'dist/.late-private'), 'late private fixture');
  const packed = spawnSync('tar', ['-cf', archive, '--no-recursion', '-C', root,
    '--', ...ordinary.files], { encoding: 'utf8' });
  assert.equal(packed.status, 0, 'exact validated file list can be archived');
  const listed = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  assert.equal(listed.status, 0);
  assert.doesNotMatch(listed.stdout, /late-private/);
  fs.unlinkSync(path.join(root, 'dist/.late-private'));
  const originalOpen = fs.openSync;
  const opened = [];
  fs.openSync = (...args) => { opened.push(args[0]); return originalOpen(...args); };
  try {
    for (const [file, reason] of [
      ['web/dist/.env', /hidden or sensitive/],
      ['dist/config.local.js', /hidden or sensitive/],
      ['dist/credentials.json', /non-runtime/],
    ]) {
      fs.writeFileSync(path.join(root, file), 'fixture-private-value');
      assert.throws(() => publicTreeDigest(root), reason);
      assert.deepEqual(opened, [], 'inventory refuses before reading or hashing any member');
      fs.unlinkSync(path.join(root, file));
    }
  } finally { fs.openSync = originalOpen; }
});

test('native VNC public runtime exceptions stay literal, paired, hashed, and executable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-native-public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['bin', 'dist/computer/native', 'web/dist']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"deckide","version":"3.5.49"}');
  fs.writeFileSync(path.join(root, 'dist/computer/private-unix.js'), 'public runtime module');
  const binary = path.join(root, 'dist/computer/native/vnc-launcher');
  const manifest = path.join(root, 'dist/computer/native/launcher-manifest.json');
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xfe]);
  const body = () => ({
    schemaVersion: 1, platform: 'linux', arch: 'x64',
    source: { path: 'src/computer/native/vnc-launcher.c', sha256: 'a'.repeat(64) },
    binary: { path: 'dist/computer/native/vnc-launcher',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    compiler: { path: '/usr/bin/gcc', realpath: '/usr/bin/x86_64-linux-gnu-gcc-15',
      sha256: 'b5f1b773a7c733738352000c92a077dc5852a1a2fc6d836b1e411be1e9ec5f88', version: '15.2.0' },
    flags: ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fstack-protector-strong',
      '-D_FORTIFY_SOURCE=2', '-fPIE', '-pie', '-Wl,-z,relro,-z,now'],
    filterSha256: 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e',
  });
  assert.doesNotThrow(() => publicTreeDigest(root), 'older packages may omit both optional native artifacts');
  fs.writeFileSync(binary, bytes, { mode: 0o755 });
  assert.throws(() => publicTreeDigest(root), /incomplete/);
  fs.writeFileSync(manifest, JSON.stringify(body()));
  assert.doesNotThrow(() => publicTreeDigest(root), 'the exact private module and native pair are public runtime files');

  fs.writeFileSync(path.join(root, 'dist/computer/private-helper.js'), 'private fixture');
  assert.throws(() => publicTreeDigest(root), /hidden or sensitive/);
  fs.unlinkSync(path.join(root, 'dist/computer/private-helper.js'));
  fs.writeFileSync(path.join(root, 'dist/computer/native/unlisted-helper'), bytes, { mode: 0o755 });
  assert.throws(() => publicTreeDigest(root), /non-runtime/);
  fs.unlinkSync(path.join(root, 'dist/computer/native/unlisted-helper'));

  fs.writeFileSync(binary, Buffer.concat([bytes, Buffer.from([0xff])]));
  assert.throws(() => publicTreeDigest(root), /manifest/);
  fs.writeFileSync(binary, bytes);
  fs.chmodSync(binary, 0o750);
  assert.throws(() => publicTreeDigest(root), /mode or type/);
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(manifest, JSON.stringify({ ...body(), arch: 'arm64' }));
  assert.throws(() => publicTreeDigest(root), /manifest/);
});

test('ChatGPT launcher inventory is exact and part of staged package identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-app-public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const makePackage = (directory, version) => {
    for (const subdir of ['bin', 'dist', 'web/dist']) fs.mkdirSync(path.join(directory, subdir), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'deckide', version }));
    if (version === CANDIDATE_VERSION) {
      fs.mkdirSync(path.join(directory, 'ops'), { recursive: true });
      fs.writeFileSync(path.join(directory, startupCheckPackagePath), 'startup checker fixture\n');
    }
  };
  const release = path.join(root, 'release');
  const previous = path.join(root, 'previous');
  makePackage(release, CANDIDATE_VERSION);
  makePackage(previous, '3.5.48');
  assert.doesNotThrow(() => publicTreeDigest(previous), 'legacy package without the app inventory remains accepted');
  fs.mkdirSync(path.join(release, 'ops/chatgpt-launcher/product'), { recursive: true });
  fs.writeFileSync(path.join(release, 'ops/chatgpt-launcher/product/session-supervisor.py'), 'partial fixture');
  assert.throws(() => publicTreeDigest(release), /legacy|incomplete|unsafe/);
  writeAppPackageFixture(release);
  const originalReleaseDigest = publicTreeDigest(release).digest;
  const previousDigest = publicTreeDigest(previous).digest;
  const candidate = path.join(root, 'candidate.tgz');
  const previousArchive = path.join(root, 'previous.tar');
  fs.writeFileSync(candidate, 'candidate fixture');
  fs.writeFileSync(previousArchive, 'rollback archive fixture');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const state = {
    httpUnit: 'deckide.service', httpControlGroup: '/system.slice/deckide.service',
    releasePackage: release, previousPackage: previous, candidate,
    candidateSha256: hash(candidate), candidatePublicSha256: originalReleaseDigest,
    previousVersion: '3.5.48', previousPublicSha256: previousDigest,
    previousArchive, previousArchiveSha256: hash(previousArchive),
  };
  assert.doesNotThrow(() => checkStaged(state));
  for (const relative of ['ops/chatgpt-launcher/product/session-supervisor.py',
    'ops/chatgpt-launcher/product/launch-chatgpt.sh',
    'ops/chatgpt-launcher/product/SOURCE-ADAPTATION.json', startupCheckPackagePath]) {
    const file = path.join(release, relative);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('tampered') ]));
    assert.notEqual(publicTreeDigest(release).digest, originalReleaseDigest, `${relative} must enter public identity`);
    assert.throws(() => checkStaged(state), /Staged release package changed/);
    fs.writeFileSync(file, original);
    assert.doesNotThrow(() => checkStaged(state));
  }
  const supervisor = path.join(release, 'ops/chatgpt-launcher/product/session-supervisor.py');
  fs.chmodSync(supervisor, 0o600);
  assert.throws(() => checkStaged(state), /unexpected mode/);
  fs.chmodSync(supervisor, 0o644);
  assert.doesNotThrow(() => checkStaged(state));

  const originalOpen = fs.openSync;
  const opened = [];
  fs.openSync = (...args) => { opened.push(args[0]); return originalOpen(...args); };
  try {
    for (const relative of ['ops/chatgpt-launcher/product/.private.js',
      'ops/chatgpt-launcher/product/local-secret.py', 'ops/chatgpt-launcher/product/unlisted.py']) {
      const file = path.join(release, relative);
      fs.writeFileSync(file, 'sensitive or unknown fixture');
      assert.throws(() => publicTreeDigest(release), /hidden or sensitive|non-runtime/);
      assert.deepEqual(opened, [], 'unrecognized app files are refused before content hashing');
      fs.unlinkSync(file);
    }
  } finally { fs.openSync = originalOpen; }
});

test('rendered candidate unit appends redacted startup validation with preserved Node and no environment changes', (t) => {
  const packageRoot = '/opt/deckide/releases/combined/node_modules/deckide';
  const originalNode = '/usr/local/bin/node';
  const launch = { entry: 'bin/deckide.js', nodePath: '/opt/old-runtime/bin/node',
    publicArgs: ['start', '--fg'], direct: false };
  const rendered = renderedUnits(packageRoot, 'deckide.service', launch, originalNode);
  assert.match(rendered.dropin,
    /^ExecStartPre=\/opt\/old-runtime\/bin\/node \/opt\/deckide\/releases\/combined\/node_modules\/deckide\/ops\/startup-check\.mjs$/m);
  assert.match(rendered.execStart, /^\/opt\/old-runtime\/bin\/node \/opt\/deckide\/releases\/combined\/node_modules\/deckide\/bin\/deckide\.js start --fg --chatgpt-desktop$/);
  assert.doesNotMatch(rendered.dropin, /^ExecStartPre=$/m, 'existing base ExecStartPre directives are not reset');
  assert.deepEqual(rendered.dropin.match(/^Environment=.*$/gm), [
    'Environment=DECKIDE_TMUX_RUNTIME_DIR=/var/lib/deckide-tmux/terminal-tmux',
    'Environment=DECKIDE_TMUX_BROKER_SOCKET=/run/deckide-tmux-broker/broker.sock',
    'Environment=DECKIDE_TMUX_BROKER_REQUIRED=1',
  ]);
  assert.doesNotMatch(rendered.dropin, /^UnsetEnvironment=/m);
  assert.doesNotMatch(rendered.dropin, /(?:CORS_ORIGIN|NODE_ENV)=/);

  const direct = renderedUnits(packageRoot, 'deckide.service', {
    entry: 'bin/deckide.js', nodePath: null, publicArgs: ['start', '--fg'], direct: true,
  }, originalNode);
  assert.match(direct.dropin,
    /^ExecStartPre=\/usr\/local\/bin\/node \/opt\/deckide\/releases\/combined\/node_modules\/deckide\/ops\/startup-check\.mjs$/m,
  'direct CLI services use the separately reviewed Node binary for the checker');
  assert.match(direct.execStart,
    /^\/opt\/deckide\/releases\/combined\/node_modules\/deckide\/bin\/deckide\.js start --fg --chatgpt-desktop$/);
  const directServer = renderedUnits(packageRoot, 'deckide.service', {
    entry: 'dist/index.js', nodePath: '/opt/old-runtime/bin/node', publicArgs: [], direct: false,
  }, originalNode);
  assert.match(directServer.execStart,
    /^\/opt\/old-runtime\/bin\/node \/opt\/deckide\/releases\/combined\/node_modules\/deckide\/dist\/index\.js --chatgpt-desktop$/);
  assert.throws(() => renderedUnits(packageRoot, 'deckide.service', {
    entry: 'bin/deckide.js', nodePath: '/opt/old-runtime/bin/node',
    publicArgs: ['start', '--fg', '--chatgpt-desktop'], direct: false,
  }, originalNode), /unexpectedly includes/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-plan-startup-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const candidate = path.join(temp, 'candidate.tgz');
  fs.writeFileSync(candidate, 'fixture');
  const report = planReport({
    input: { candidate, previousPackage: '/opt/old/deckide', release: '/opt/new',
      httpUnit: 'deckide.service', healthUrl: 'http://127.0.0.1/health' },
    previous: { version: '3.5.48' }, previousPublic: { digest: 'a'.repeat(64) },
    mainPid: 123, launch: { sourceEntry: '/opt/old/deckide/bin/deckide.js', entry: 'bin/deckide.js' },
    releasePackage: packageRoot, paths: { broker: '/etc/systemd/system/deckide-tmux-broker.service',
      dropin: '/etc/systemd/system/deckide.service.d/99-deckide-tmux.conf' },
    units: { broker: 'broker fixture', dropin: rendered.dropin },
    startupConfiguration: { production: true, corsConfigured: true, missing: [] },
  });
  const serialized = JSON.stringify(report);
  assert.deepEqual(report.startupConfiguration, {
    production: true, corsConfigured: true, missing: [],
    scope: 'updater-invocation-process', serviceEnvironmentVerified: false,
  });
  assert.doesNotMatch(serialized, /127\.0\.0\.1:18798|secret-cors-origin/);
});

test('updater plan refuses missing production CORS before option or service preflight and hides env values', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const secretSentinel = 'SYNTHETIC-UPDATER-SECRET-SHOULD-NEVER-APPEAR';
  const result = spawnSync(process.execPath, ['ops/terminal-update.mjs', 'plan'], {
    cwd: repoRoot,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
      NODE_ENV: 'production', DECKIDE_SYNTHETIC_SECRET: secretSentinel },
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CORS_ORIGIN must be set in production/);
  assert.doesNotMatch(result.stderr, /Missing --candidate/,
    'configuration validation runs before option and filesystem preflight');
  assert.doesNotMatch(result.stdout + result.stderr, /CORS_ORIGIN=|SYNTHETIC-UPDATER-SECRET-SHOULD-NEVER-APPEAR/);
  assert.equal(result.stdout, '');
});
