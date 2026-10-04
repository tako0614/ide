import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  assertInitialBrokerResourcesAbsent, classifyTerminalRuntimeEntries,
  parseShowProperties, assertHttpService, assertInactiveHttpService,
  assertEmptyServiceCgroup, parseDeckideExecStart, parseKnownRollbackLaunch,
  parseProcStat, readProcTree, assertNoLegacyPtys, assertBrokerCgroups,
  safeAbsolutePath, safeServiceUnit,
} from '../ops/terminal-update-guards.mjs';
import { publicTreeDigest, isolatedNpmInstallSettings, stageCandidatePackage } from '../ops/terminal-update.mjs';

test('candidate stage extracts verified tar and runs npm ci at the published shrinkwrap root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-root-ci-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package');
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  const version = '3.5.49-tmux.20261004.1';
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'deckide', version, bin: { deckide: 'bin/deckide.js' }, dependencies: {},
  }));
  const lock = { name: 'deckide', version, lockfileVersion: 3, requires: true,
    packages: { '': { name: 'deckide', version, dependencies: {} } } };
  fs.writeFileSync(path.join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(packageRoot, 'bin/deckide.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const makeTar = (filename, entries) => {
    const tarball = path.join(root, filename);
    const result = spawnSync('tar', ['-czf', tarball, '--no-recursion', '-C', root, ...entries],
      { encoding: 'utf8' });
    assert.equal(result.status, 0);
    return { candidate: tarball, expectedSha256: crypto.createHash('sha256')
      .update(fs.readFileSync(tarball)).digest('hex') };
  };
  const entries = ['package/package.json', 'package/npm-shrinkwrap.json', 'package/bin/deckide.js'];
  const archive = makeTar('candidate.tgz', entries);
  const calls = [];
  const runner = (file, args, options = {}) => {
    calls.push({ file, args, options });
    const result = spawnSync(file, args, { encoding: 'utf8', timeout: options.timeout ?? 15_000,
      maxBuffer: 2 * 1024 * 1024, cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw new Error(`${file} fixture invocation failed`);
    return result.stdout;
  };
  const release = path.join(root, 'release');
  const staged = stageCandidatePackage({ ...archive, release, commandRunner: runner });
  assert.equal(staged.releasePackage, path.join(release, 'node_modules/deckide'));
  assert.equal(fs.readFileSync(path.join(staged.releasePackage, 'npm-shrinkwrap.json'), 'utf8'),
    JSON.stringify(lock), 'the published lock is npm ci root, not a nested dependency hint');
  assert.ok(fs.statSync(path.join(staged.releasePackage, 'bin/deckide.js')).mode & 0o111);
  const npmCalls = calls.filter(({ file }) => file === 'npm');
  assert.equal(npmCalls.length, 1);
  assert.equal(npmCalls[0].args[0], 'ci');
  assert.equal(npmCalls[0].options.cwd, staged.releasePackage);
  assert.ok(npmCalls[0].args.includes('--omit=dev'));
  assert.ok(!npmCalls[0].args.includes('install'));

  fs.rmSync(path.join(packageRoot, 'npm-shrinkwrap.json'));
  const missing = makeTar('missing-lock.tgz', entries.filter((entry) => !entry.endsWith('npm-shrinkwrap.json')));
  assert.throws(() => stageCandidatePackage({ ...missing, release: path.join(root, 'missing-release'),
    commandRunner: runner }), /lacks its package manifest or published shrinkwrap/);
  assert.ok(!fs.existsSync(path.join(root, 'missing-release')));
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
    path.join(root, 'state/terminal-tmux'), path.join(root, 'run/broker.sock')];
  assert.doesNotThrow(() => assertInitialBrokerResourcesAbsent(paths));
  for (let index = 0; index < paths.length; index++) {
    const fixture = path.join(root, `case-${index}`);
    const resources = [path.join(fixture, 'run'), path.join(fixture, 'state'),
      path.join(fixture, 'state/terminal-tmux'), path.join(fixture, 'run/broker.sock')];
    const selected = resources[index];
    fs.mkdirSync(path.dirname(selected), { recursive: true });
    if (index === 3) fs.writeFileSync(selected, 'fixture');
    else fs.mkdirSync(selected, { mode: 0o755 });
    const mode = fs.lstatSync(selected).mode & 0o777;
    assert.throws(() => assertInitialBrokerResourcesAbsent(resources), /already exists/);
    assert.equal(fs.lstatSync(selected).mode & 0o777, mode, 'preflight never changes existing permissions');
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
});

test('rollback accepts either known effective launcher across daemon-reload and state-write crash', () => {
  const previous = '/opt/old/deckide';
  const candidate = '/opt/new/deckide';
  const node = '/usr/local/bin/node';
  const raw = (root) => `{ path=${node} ; argv[]=${node} ${root}/bin/deckide.js start --fg ; }`;
  const resolve = (value) => value;
  assert.equal(parseKnownRollbackLaunch(raw(previous), previous, candidate, resolve).kind, 'previous');
  assert.equal(parseKnownRollbackLaunch(raw(candidate), previous, candidate, resolve).kind, 'candidate');
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
