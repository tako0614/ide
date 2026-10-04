import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { BorrowedDesktopLease } from '../src/computer/borrowed-desktop.ts';
import { DesktopComputer } from '../src/computer/desktop.ts';

const TRUSTED_FRAMEBUFFER = Object.freeze({ width: 1440, height: 960 });

function processEntry(pid, comm, ppid, pgid, uid = 993, gid = 982) {
  return { pid, starttime_ticks: pid * 100, owner_uid: uid, owner_gid: gid, comm, ppid, pgid };
}
function fixtureDescriptor(runtime) {
  const now = Date.now();
  const supervisor = processEntry(30001, 'python3', 2, 30001, 0, 0);
  const processes = [
    processEntry(30002, 'Xvfb', 30001, 30002, 0, 0),
    processEntry(30003, 'dbus-run-sessio', 30001, 30003),
    processEntry(30004, 'dbus-daemon', 30003, 30003),
    processEntry(30005, 'python3', 30003, 30003),
    processEntry(30006, 'openbox', 30005, 30003),
    processEntry(30007, 'ChatGPT', 30005, 30003),
    processEntry(30008, 'ChatGPT', 30007, 30003),
  ];
  return {
    schema: 'chatgpt-private-desktop/v1', state: 'ready',
    created_utc: new Date(now).toISOString(), expires_utc: new Date(now + 60_000).toISOString(),
    lifetime_seconds: 60, uid: 993, gid: 982, runtime_dir: runtime,
    XAUTHORITY: `${runtime}/Xauthority-fixture`, DISPLAY: ':2000', supervisor, processes,
    xvfb_owner_differs_from_app: true, xvfb_owner_uid: 0, desktop_owner_uid: 993,
    dbus_owner_uid: 993, chatgpt_owner_uid: 993, x11_tcp_listening: false,
    x11_authentication: 'MIT-MAGIC-COOKIE-1', sandbox_disabled: false,
    root_credentials_inherited: false,
  };
}
function fakeProbe(data) {
  const entries = new Map([data.supervisor, ...data.processes].map((p) => [p.pid, p]));
  const missing = new Set();
  const replacements = new Map();
  let cpuCounter = 0;
  const probe = {
    missing, replacements, changingCpu: false, sandboxAuxiliary: false,
    now: () => Date.now(),
    lstat(file) {
      if (file === data.runtime_dir) return {
        uid: 993, gid: 982, mode: 0o040700, isDirectory: () => true,
      };
      if (file === data.XAUTHORITY) return {
        uid: 993, gid: 982, mode: 0o100600, nlink: 1, size: 48,
        dev: 12, ino: 34, isFile: () => true,
      };
      throw new Error('unexpected metadata');
    },
    realpath: (file) => file,
    readlink(file) {
      const name = file.split('/').at(-1);
      if (['pid', 'user', 'mnt', 'net'].includes(name)) {
        const auxiliary = this.sandboxAuxiliary && file.includes('/30008/');
        return `${name}:[${auxiliary ? 84 : 42}]`;
      }
      throw new Error('unexpected readlink');
    },
    readFile(file) {
      const match = /^\/fake-proc\/(\d+)\/(stat|status)$/.exec(file);
      if (!match) throw new Error('unexpected proc path');
      const pid = Number(match[1]);
      if (missing.has(pid)) throw Object.assign(new Error('process exited'), { code: 'ENOENT' });
      const p = replacements.get(pid) ?? entries.get(pid);
      if (!p) throw new Error('unknown process');
      if (match[2] === 'status') return `Uid:\t${p.owner_uid}\t${p.owner_uid}\t${p.owner_uid}\t${p.owner_uid}\n` +
        `Gid:\t${p.owner_gid}\t${p.owner_gid}\t${p.owner_gid}\t${p.owner_gid}\n`;
      const fields = Array(20).fill('0');
      fields[0] = p.state ?? 'S'; fields[1] = String(p.ppid); fields[2] = String(p.pgid);
      if (this.changingCpu) fields[13] = String(++cpuCounter);
      fields[19] = String(p.starttime_ticks);
      return `${pid} (${p.comm}) ${fields.join(' ')}\n`;
    },
  };
  return probe;
}
async function withFixture(t) {
  const base = await fs.mkdtemp(path.join(process.cwd(), 'borrowed-desktop-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const runtime = path.join(base, 'external');
  await fs.mkdir(runtime, { mode: 0o700 });
  await fs.writeFile(path.join(runtime, 'sentinel'), 'external state');
  const file = path.join(base, 'app-session.json');
  const data = fixtureDescriptor(runtime);
  await fs.writeFile(file, JSON.stringify(data), { mode: 0o600 });
  const probe = fakeProbe(data);
  return { base, runtime, file, data, probe,
    load: () => BorrowedDesktopLease.load(file, probe, '/fake-proc'),
    write: (value) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 }),
  };
}

async function rollingFixture(t) {
  const f = await withFixture(t);
  let now = Date.now();
  f.probe.now = () => now;
  const owner = processEntry(process.pid, 'node', 1, process.pid,
    process.getuid(), process.getgid());
  f.probe.replacements.set(owner.pid, owner);
  const supervisor = { ...f.data.supervisor, ppid: owner.pid };
  f.probe.replacements.set(supervisor.pid, supervisor);
  const byPid = new Map(f.data.processes.map((p) => [p.pid, p]));
  const data = { ...f.data, schema: 'chatgpt-private-desktop/v2',
    lifecycle_mode: 'deckide-owned', session_id: 'a'.repeat(32), owner_process: owner,
    supervisor, created_utc: new Date(now).toISOString(), updated_utc: new Date(now).toISOString(),
    expires_utc: new Date(now + 10_000).toISOString(), lifetime_seconds: null,
    session_deadline_utc: null, heartbeat_interval_seconds: 2,
    heartbeat_valid_seconds: 10, heartbeat_sequence: 1,
    anchors: { xvfb: byPid.get(30002), desktop_runner: byPid.get(30003),
      dbus: byPid.get(30004), openbox: byPid.get(30006), chatgpt: byPid.get(30007) },
  };
  await f.write(data);
  return { ...f, data, owner, advance(ms) { now += ms; return now; },
    publish: async (sequence, changes = {}) => {
      const next = { ...data, heartbeat_sequence: sequence,
        updated_utc: new Date(now).toISOString(), expires_utc: new Date(now + 10_000).toISOString(),
        ...changes };
      const temporary = path.join(f.base, 'app-session.next.json');
      await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(temporary, f.file);
      return next;
    },
  };
}

test('v2 rolling lease renews across six virtual hours without retaining first expiry', async (t) => {
  const f = await rollingFixture(t);
  const lease = f.load();
  const initialExpiry = lease.check().expiresEpochMs;
  assert.equal(lease.check().sessionId, f.data.session_id);
  f.advance(2_000);
  await f.publish(2);
  assert.equal(lease.check().expiresEpochMs, initialExpiry + 2_000);
  f.advance(6 * 60 * 60 * 1000);
  await f.publish(10802);
  assert.equal(lease.check().expiresEpochMs, initialExpiry + 6 * 60 * 60 * 1000 + 2_000);
  assert.equal(lease.check().lifecycleMode, 'deckide-owned');
});

test('v2 rejects rollback, changed same-sequence publication and reused generation ID', async (t) => {
  for (const variant of ['rollback', 'changed-same-sequence', 'reused-id']) {
    const f = await rollingFixture(t);
    const lease = f.load();
    f.advance(2_000);
    await f.publish(2);
    lease.check();
    if (variant === 'rollback') await f.publish(1);
    if (variant === 'changed-same-sequence') await f.publish(2, { signed_out_ui: 'changed' });
    if (variant === 'reused-id') await f.publish(3, {
      created_utc: new Date(f.probe.now() - 1_000).toISOString(),
    });
    assert.throws(() => lease.check(), /unverified/, variant);
    f.advance(2_000);
    await f.publish(4);
    assert.throws(() => lease.check(), /unverified/, 'a failed lease cannot recover itself');
  }
});

test('v2 rejects owner mismatch, zombies and dropped stable anchors', async (t) => {
  for (const variant of ['owner-mismatch', 'owner-zombie', 'owner-missing',
    'anchor-zombie', 'anchor-missing', 'anchor-changed']) {
    const f = await rollingFixture(t);
    const lease = f.load();
    f.advance(2_000);
    if (variant === 'owner-mismatch') await f.publish(2, {
      owner_process: { ...f.owner, pid: f.owner.pid + 1 },
    });
    if (variant === 'owner-zombie') f.probe.replacements.set(f.owner.pid, { ...f.owner, state: 'Z' });
    if (variant === 'owner-missing') f.probe.missing.add(f.owner.pid);
    if (variant === 'anchor-zombie') f.probe.replacements.set(30002,
      { ...f.data.anchors.xvfb, state: 'Z' });
    if (variant === 'anchor-missing') f.probe.missing.add(30002);
    if (variant === 'anchor-changed') await f.publish(2, { anchors: {
      ...f.data.anchors, xvfb: { ...f.data.anchors.xvfb, starttime_ticks: 99 },
    } });
    assert.throws(() => lease.check(), /unverified/, variant);
  }
});

test('v2 rejects stale, future, expired and contradictory heartbeat publications', async (t) => {
  for (const variant of ['stale', 'future', 'expired', 'deadline', 'mode', 'schema', 'id']) {
    const f = await rollingFixture(t);
    const lease = f.load();
    f.advance(2_000);
    const changes = {
      stale: { updated_utc: new Date(f.probe.now() - 11_000).toISOString(),
        expires_utc: new Date(f.probe.now() - 1_000).toISOString() },
      future: { updated_utc: new Date(f.probe.now() + 2_001).toISOString(),
        expires_utc: new Date(f.probe.now() + 12_001).toISOString() },
      expired: { expires_utc: new Date(f.probe.now() - 1).toISOString() },
      deadline: { session_deadline_utc: new Date(f.probe.now() + 60_000).toISOString() },
      mode: { lifecycle_mode: 'bounded' },
      schema: { schema: 'chatgpt-private-desktop/v3' },
      id: { session_id: 'b'.repeat(32) },
    }[variant];
    await f.publish(2, changes);
    assert.throws(() => lease.check(), /unverified/, variant);
  }
});

test('v2 auxiliary reparenting and exec retain stable identity without revoking anchors', async (t) => {
  const f = await rollingFixture(t);
  const lease = f.load();
  const saved = f.data.processes.at(-1);
  const current = { ...saved, ppid: 1, pgid: saved.pid, comm: 'helper', state: 'R' };
  f.probe.replacements.set(saved.pid, current);
  for (const anchor of [f.owner, f.data.supervisor, ...Object.values(f.data.anchors)])
    f.probe.replacements.set(anchor.pid, { ...anchor, state: 'R' });
  assert.equal(lease.check().sessionId, f.data.session_id,
    'an unchanged publication may contain old auxiliary parent/name metadata');
  f.advance(2_000);
  await f.publish(2, { processes: f.data.processes.map(p => p.pid === saved.pid ? current : p) });
  assert.equal(lease.check().sessionId, f.data.session_id);
  f.probe.missing.add(saved.pid);
  assert.equal(lease.check().sessionId, f.data.session_id, 'exited auxiliary is not an anchor');
});

test('v2 reparented auxiliaries still reject PID reuse, foreign credentials and namespace races', async (t) => {
  for (const variant of ['pid-reuse', 'foreign-uid', 'foreign-gid', 'namespace-race',
    'real-uid', 'effective-uid', 'saved-uid', 'fs-uid',
    'real-gid', 'effective-gid', 'saved-gid', 'fs-gid', 'access-denied', 'malformed-stat']) {
    const f = await rollingFixture(t);
    const lease = f.load();
    const saved = f.data.processes.at(-1);
    const current = { ...saved, ppid: 1, comm: 'helper' };
    if (variant === 'pid-reuse') current.starttime_ticks++;
    if (variant === 'foreign-uid') current.owner_uid = 65534;
    if (variant === 'foreign-gid') current.owner_gid = 65534;
    f.probe.replacements.set(saved.pid, current);
    const readFile = f.probe.readFile.bind(f.probe);
    const credential = /^(real|effective|saved|fs)-(uid|gid)$/.exec(variant);
    if (credential) f.probe.readFile = file => {
      const value = readFile(file);
      if (file !== `/fake-proc/${saved.pid}/status`) return value;
      const label = credential[2] === 'uid' ? 'Uid' : 'Gid';
      const values = Array(4).fill(credential[2] === 'uid' ? 993 : 982);
      values[['real', 'effective', 'saved', 'fs'].indexOf(credential[1])] = 65534;
      return value.replace(new RegExp(`^${label}:.*$`, 'm'), `${label}:\t${values.join('\t')}`);
    };
    if (variant === 'access-denied') f.probe.readFile = file => {
      if (file === `/fake-proc/${saved.pid}/stat`)
        throw Object.assign(new Error('unproven proc view'), { code: 'EACCES' });
      return readFile(file);
    };
    if (variant === 'malformed-stat') f.probe.readFile = file =>
      file === `/fake-proc/${saved.pid}/stat` ? 'malformed' : readFile(file);
    if (variant === 'namespace-race') {
      const readlink = f.probe.readlink.bind(f.probe); let reads = 0;
      f.probe.readlink = file => file === `/fake-proc/${saved.pid}/ns/net`
        ? `net:[${++reads === 1 ? 42 : 84}]` : readlink(file);
    }
    assert.throws(() => lease.check(), /unverified/, variant);
    f.probe.replacements.delete(saved.pid);
    assert.throws(() => lease.check(), /unverified/, 'failed v2 lease stays revoked');
  }
});

test('v2 live owner and security anchors retain exact parent, group, name and namespace checks', async (t) => {
  for (const role of ['owner', 'supervisor', 'xvfb', 'desktop_runner', 'dbus', 'openbox', 'chatgpt']) {
    for (const field of ['ppid', 'pgid', 'comm', 'namespace', 'zombie', 'dead']) {
      const f = await rollingFixture(t);
      const lease = f.load();
      const saved = role === 'owner' ? f.owner : role === 'supervisor'
        ? f.data.supervisor : f.data.anchors[role];
      const current = { ...saved };
      if (field === 'zombie') current.state = 'Z';
      else if (field === 'dead') current.state = 'X';
      else if (field === 'comm') current.comm = 'foreign';
      else if (field !== 'namespace') current[field]++;
      f.probe.replacements.set(saved.pid, current);
      if (field === 'namespace') {
        const readlink = f.probe.readlink.bind(f.probe);
        f.probe.readlink = file => file === `/fake-proc/${saved.pid}/ns/net` ? 'net:[84]' : readlink(file);
      }
      assert.throws(() => lease.check(), /unverified/, `${role} ${field}`);
    }
  }
});

test('trusted descriptor accepts mixed owner anchors and transient auxiliary exit', async (t) => {
  const f = await withFixture(t);
  const lease = f.load();
  assert.equal(lease.check().display, ':2000');
  assert.equal(lease.check().uid, 993);
  f.probe.changingCpu = true;
  f.probe.sandboxAuxiliary = true;
  assert.equal(lease.check().display, ':2000', 'changing CPU counters and sandboxed auxiliary are valid');
  f.probe.missing.add(30008);
  assert.equal(lease.check().authIno, 34);
  await f.write({ ...f.data, processes: f.data.processes.slice(0, -1) });
  assert.equal(lease.check().display, ':2000', 'atomic descriptor refresh may remove exited auxiliary');
});

test('auxiliary snapshot may have a separate group and unlisted parent while live identity remains exact', async (t) => {
  const f = await withFixture(t);
  const lease = f.load();
  const auxiliary = { ...f.data.processes.at(-1), ppid: 39999, pgid: 30008 };
  f.probe.replacements.set(auxiliary.pid, auxiliary);
  await f.write({ ...f.data, processes: [...f.data.processes.slice(0, -1), auxiliary] });
  assert.equal(lease.check().display, ':2000');
  f.probe.replacements.set(auxiliary.pid, { ...auxiliary, owner_uid: 0 });
  assert.throws(() => lease.check(), /unverified/, 'live auxiliary owner mismatch is rejected');
  f.probe.replacements.set(auxiliary.pid, { ...auxiliary, starttime_ticks: 1 });
  assert.throws(() => lease.check(), /unverified/, 'live auxiliary start mismatch is rejected');
  f.probe.missing.add(auxiliary.pid);
  assert.equal(lease.check().display, ':2000', 'an exited auxiliary snapshot is transient');
});

test('borrowed descriptor rejects expiry, revocation, schema and changed anchor identity', async (t) => {
  const f = await withFixture(t);
  const lease = f.load();
  for (const variant of [
    { ...f.data, state: 'stopped' },
    { ...f.data, schema: 'unknown' },
    { ...f.data, expires_utc: new Date(Date.now() - 1000).toISOString() },
    { ...f.data, DISPLAY: ':2001' },
    { ...f.data, DISPLAY: ':12345' },
    { ...f.data, supervisor: { ...f.data.supervisor, starttime_ticks: 99 } },
  ]) {
    await f.write(variant);
    assert.throws(() => lease.check(), /unverified/);
  }
  await f.write(f.data);
  f.probe.replacements.set(30001, { ...f.data.supervisor, owner_uid: 65534 });
  assert.throws(() => lease.check(), /unverified/, 'mapped or changed host UID is unverified');
  f.probe.replacements.clear();
  f.probe.missing.add(30002);
  assert.throws(() => lease.check(), /unverified/, 'Xvfb anchor may not disappear');
});

test('borrowed descriptor rejects symlink metadata, unexpected ownership and unknown proc view', async (t) => {
  const f = await withFixture(t);
  const originalRealpath = f.probe.realpath;
  f.probe.realpath = (file) => file === f.data.XAUTHORITY ? '/elsewhere' : file;
  assert.throws(f.load, /unverified/);
  f.probe.realpath = originalRealpath;
  const originalLstat = f.probe.lstat;
  f.probe.lstat = (file) => file === f.data.runtime_dir
    ? { ...originalLstat(file), mode: 0o040777 } : originalLstat(file);
  assert.throws(f.load, /unverified/);
  f.probe.lstat = originalLstat;
  const originalLink = f.probe.readlink;
  f.probe.readlink = (file) => file.includes('/30007/') ? 'pid:[other]' : originalLink(file);
  assert.throws(f.load, /unverified/);
  f.probe.readlink = originalLink;
  f.probe.replacements.set(30008, { ...f.data.processes.at(-1), starttime_ticks: 7 });
  assert.throws(f.load, /unverified/, 'present auxiliary PID may not be reused');
  f.probe.replacements.clear();
  f.probe.lstat = (file) => file === f.data.XAUTHORITY
    ? { ...originalLstat(file), gid: 0 } : originalLstat(file);
  assert.throws(f.load, /unverified/, 'authority owner GID is independent of its path');
  f.probe.lstat = originalLstat;
  const link = path.join(f.base, 'link.json');
  await fs.symlink(f.file, link);
  assert.throws(() => BorrowedDesktopLease.load(link, f.probe, '/fake-proc'), /unverified/);
  await fs.chmod(f.file, 0o644);
  assert.throws(f.load, /unverified/, 'descriptor mode must remain 0600');
});

test('borrowed stop and shutdown retain own diagnostics and leave external desktop untouched', async (t) => {
  const f = await withFixture(t);
  const computer = new DesktopComputer();
  await computer.attachBorrowedDesktop(f.load(), f.base, TRUSTED_FRAMEBUFFER);
  const producerDir = computer.runtime.dir;
  const diagnostic = path.join(producerDir, `stderr-${'a'.repeat(32)}.log`);
  await fs.writeFile(diagnostic, 'private diagnostic', { mode: 0o600 });
  assert.notEqual(producerDir, f.runtime);
  assert.equal(computer.runtime.xvfb, undefined);
  assert.equal(computer.owned.size, 0);
  assert.equal((await computer.prepare()).running, true);
  assert.equal((await computer.status()).transport, 'private-rfb');
  assert.deepEqual((await computer.apps('browser:fixture')).apps, []);
  await assert.rejects(computer.screenshot('browser:fixture'), /streaming only/);
  await assert.rejects(computer.input('browser:fixture', { observationId: 'none' }), /streaming only/);
  await assert.rejects(computer.launch({ app: 'terminal' }), /streaming only/);
  await assert.rejects(computer.registerDeveloped('browser:fixture', {}), /streaming only/);
  computer.signalOwned = () => assert.fail('external process must never be signalled');
  await computer.stop();
  await assert.rejects(computer.prepare(), /Borrowed desktop is unavailable/);
  assert.equal((await fs.stat(producerDir)).mode & 0o7777, 0o700);
  assert.equal(await fs.readFile(diagnostic, 'utf8'), 'private diagnostic');
  assert.equal(await fs.readFile(path.join(f.runtime, 'sentinel'), 'utf8'), 'external state');
  await computer.attachBorrowedDesktop(f.load(), f.base, TRUSTED_FRAMEBUFFER);
  const secondDiagnostic = path.join(computer.runtime.dir, `stderr-${'b'.repeat(32)}.log`);
  await fs.writeFile(secondDiagnostic, 'shutdown diagnostic', { mode: 0o600 });
  await computer.shutdown();
  assert.equal(await fs.readFile(secondDiagnostic, 'utf8'), 'shutdown diagnostic');
  assert.equal(await fs.readFile(path.join(f.runtime, 'sentinel'), 'utf8'), 'external state');
});

test('borrowed attachment requires exact startup-owned framebuffer geometry', async (t) => {
  const computer = new DesktopComputer();
  t.after(() => computer.shutdown());
  const f = await withFixture(t);
  for (const geometry of [undefined, {}, { width: 1440, height: 960, display: ':2000' },
    { width: 1440, height: 960, inferred: true }, { width: 0, height: 960 },
    { width: 8192, height: 8192 }]) {
    await assert.rejects(computer.attachBorrowedDesktop(f.load(), f.base, geometry),
      /Trusted framebuffer geometry is invalid/);
    assert.equal(computer.runtime, null, 'invalid geometry cannot create a borrowed runtime');
  }
  const status = await computer.attachBorrowedDesktop(f.load(), f.base, TRUSTED_FRAMEBUFFER);
  assert.deepEqual([status.width, status.height], [1440, 960]);
  assert.deepEqual(computer.runtime.framebuffer, TRUSTED_FRAMEBUFFER);
  assert.equal(Object.isFrozen(computer.runtime.framebuffer), true);
});

test('revocation detaches the borrowed transport and never prepares a replacement display', async (t) => {
  const f = await withFixture(t);
  const computer = new DesktopComputer();
  await computer.attachBorrowedDesktop(f.load(), f.base, TRUSTED_FRAMEBUFFER);
  const producerDir = computer.runtime.dir;
  const diagnostic = path.join(producerDir, `stderr-${'c'.repeat(32)}.log`);
  await fs.writeFile(diagnostic, 'revoked diagnostic', { mode: 0o600 });
  await f.write({ ...f.data, state: 'stopped' });
  assert.equal((await computer.status()).running, false);
  if (computer.pendingCleanup) await computer.pendingCleanup;
  assert.equal(await fs.readFile(diagnostic, 'utf8'), 'revoked diagnostic');
  await assert.rejects(computer.prepare(), /Borrowed desktop is unavailable/);
  assert.equal(computer.owned.size, 0);
  assert.equal(await fs.readFile(path.join(f.runtime, 'sentinel'), 'utf8'), 'external state');
  await computer.shutdown();
});
