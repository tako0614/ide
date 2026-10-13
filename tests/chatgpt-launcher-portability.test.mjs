import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.DECKIDE_CANDIDATE_PACKAGE_ROOT || sourceRoot);
const launcherRoot = path.join(root, 'ops/chatgpt-launcher');
const files = ['launch-chatgpt.sh', 'session-supervisor.py', 'desktop-session.py',
  'session-bus.conf', 'test-session-lifecycle.py'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);

async function fixture(t, rootOwnedAncestors = false) {
  // The public-helper validator checks every ancestor. A checkout under /root
  // and a world-writable /tmp cannot serve this UID isolation fixture.
  const temporary = rootOwnedAncestors ? '/opt' : path.join(sourceRoot, 'tmp');
  if (rootOwnedAncestors) {
    const parent = await lstat(temporary);
    assert.ok(parent.isDirectory());
    assert.equal(parent.uid, 0);
    assert.equal(parent.gid, 0);
    assert.equal(parent.mode & 0o022, 0);
    assert.ok(parent.mode & 0o001);
  } else {
    await mkdir(temporary, { recursive: true, mode: 0o700 });
  }
  const directory = await mkdtemp(path.join(temporary, 'chatgpt-portability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function copyProduct(destination, origin) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of files) {
    await copyFile(path.join(launcherRoot, origin, name), path.join(destination, name));
    await chmod(path.join(destination, name), name === 'launch-chatgpt.sh' ? 0o755 : 0o644);
  }
}

test('app source seal and adapted product retain distinct exact identities', async () => {
  const source = path.join(launcherRoot, 'source');
  const manifestRaw = await readFile(path.join(source, 'MANIFEST.json'));
  const manifest = JSON.parse(manifestRaw);
  const id = 'deckide-chatgpt-launcher-source-sha256-727257708d6562495374122099cc707a94d48322658039c0af6fe30abaf87855';
  assert.equal(manifest.package_id, id);
  assert.equal(`deckide-chatgpt-launcher-source-sha256-${sha256(canonical(manifest.payload))}`, id);
  const sums = new Map();
  for (const line of (await readFile(path.join(source, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    assert.ok(match);
    assert.equal(sums.has(match[2]), false);
    sums.set(match[2], match[1]);
  }
  assert.equal(sums.get('MANIFEST.json'), sha256(manifestRaw));
  assert.equal(sums.size, manifest.payload.files.length + 1);
  for (const file of manifest.payload.files) {
    const bytes = await readFile(path.join(source, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(sha256(bytes), file.sha256);
    assert.equal(sums.get(file.path), file.sha256);
  }
  const adaptation = JSON.parse(await readFile(path.join(launcherRoot, 'product/SOURCE-ADAPTATION.json')));
  assert.equal(adaptation.source_package_id, id);
  assert.equal(adaptation.source_seal_applies_to_product, false);
  for (const file of adaptation.product_files) {
    assert.equal(sha256(await readFile(path.join(launcherRoot, 'source', file.path))), file.source_sha256);
    assert.equal(sha256(await readFile(path.join(launcherRoot, 'product', file.path))), file.product_sha256);
  }
});

test('original and relocated app lifecycle regressions run only in disposable copies', async (t) => {
  const directory = await fixture(t);
  for (const origin of ['source', 'product']) {
    const copy = path.join(directory, origin);
    await copyProduct(copy, origin);
    const result = await run('/usr/bin/python3', ['-I', '-B', 'test-session-lifecycle.py', '-v'], {
      cwd: copy, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: directory },
      timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.match(result.stderr, /Ran 17 tests/);
    assert.match(result.stderr, /\nOK\s*$/);
    assert.equal((await readdir(copy)).includes('__pycache__'), false);
  }
});

test('relocated launcher resolves its own helpers without creating app state', async (t) => {
  const directory = await fixture(t);
  const product = path.join(directory, 'moved product');
  const state = path.join(directory, 'private-state');
  await copyProduct(product, 'product');
  await mkdir(state, { mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', CHATGPT_LAUNCHER_STATE_ROOT: state };
  const help = await run(path.join(product, 'launch-chatgpt.sh'), ['--help'], {
    env, timeout: 5000, maxBuffer: 64 * 1024,
  });
  assert.match(help.stdout, /deckide-owned/);
  const probe = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('relocated',Path(sys.argv[1])/'session-supervisor.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.validate_state_root_override()\nstate=Path(sys.argv[2])\nprint(json.dumps({'root':str(m.PRODUCT_ROOT),'command':m.desktop_command(state/'public-session-bus.conf',state/'public-desktop.py'),'descriptor':str(m.DESCRIPTOR)}))`;
  const result = await run('/usr/bin/python3', ['-I', '-B', '-c', probe, product, state], {
    env, timeout: 5000, maxBuffer: 64 * 1024,
  });
  const data = JSON.parse(result.stdout);
  assert.equal(data.root, product);
  assert.deepEqual(data.command, ['/usr/bin/dbus-run-session', `--config-file=${state}/public-session-bus.conf`,
    '--', '/usr/bin/python3', '-I', `${state}/public-desktop.py`]);
  assert.equal(data.descriptor, path.join(state, 'app-session.json'));
  assert.deepEqual(await readdir(state), []);
});

test('UID 993 reads only sealed public helpers and cannot substitute their protected paths', async (t) => {
  const directory = await fixture(t, true);
  // Only this disposable parent grants traversal; no existing directory changes.
  await chmod(directory, 0o711);
  const product = path.join(directory, 'private-release');
  await copyProduct(product, 'product');
  const probe = String.raw`
import hashlib,importlib.util,os,stat,subprocess,sys
from pathlib import Path
from unittest.mock import patch
product=Path(sys.argv[1]); fixture=Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('private_release',product/'session-supervisor.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
public=fixture/'public-parent';public.mkdir(mode=0o711);m.PUBLIC_PARENT=public
saved=m.validate_public_parent()
helper,records,identity=m.stage_public_helpers(982,saved)
bus=helper/'session-bus.conf';desktop=helper/'desktop-session.py'
m.verify_staged_helpers(helper,records,identity,saved)
assert (helper.stat().st_uid,helper.stat().st_gid,stat.S_IMODE(helper.stat().st_mode))==(0,982,0o750)
assert set(os.listdir(helper))=={'session-bus.conf','desktop-session.py'}
for record in records:
    info=record['path'].lstat()
    assert (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(0,982,0o640)
assert m.desktop_command(bus,desktop)==['/usr/bin/dbus-run-session','--config-file='+str(bus),'--','/usr/bin/python3','-I',str(desktop)]
reader="""import hashlib,os,sys,xml.etree.ElementTree as ET
from pathlib import Path
assert os.getuid()==993 and os.getgid()==982 and os.getgroups()==[]
try: Path(sys.argv[1]).read_bytes()
except PermissionError: pass
else: raise AssertionError('private package became accessible')
bus=Path(sys.argv[2]);desktop=Path(sys.argv[3]);helper=bus.parent
assert hashlib.sha256(bus.read_bytes()).hexdigest()==sys.argv[4]
assert hashlib.sha256(desktop.read_bytes()).hexdigest()==sys.argv[5]
assert ET.fromstring(bus.read_bytes()).find('listen').text=='unix:dir=/run/deckide-chatgpt-root'
compile(desktop.read_bytes(),str(desktop),'exec')
for operation in (lambda: bus.write_bytes(b'changed'), lambda: bus.unlink(),
                  lambda: bus.rename(helper/'replacement'),
                  lambda: (helper/'foreign').write_bytes(b'new'),
                  lambda: helper.rename(helper.with_name('replacement-directory')),
                  lambda: (helper.parent/'substitute').mkdir()):
    try: operation()
    except PermissionError: pass
    else: raise AssertionError('app could substitute a public helper path')
"""
subprocess.run(['/usr/bin/python3','-I','-B','-c',reader,str(product/'desktop-session.py'),str(bus),str(desktop),m.PUBLIC_HELPERS['session-bus.conf'][1],m.PUBLIC_HELPERS['desktop-session.py'][1]],check=True,user=993,group=982,extra_groups=[],env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=5)
m.verify_staged_helpers(helper,records,identity,saved)
before=set(os.listdir(public))
with patch.object(m.os,'fsync',side_effect=[None,None,OSError('synthetic second helper write failure')]):
    try: m.stage_public_helpers(982,saved)
    except OSError: pass
    else: raise AssertionError('partial failure accepted')
assert set(os.listdir(public))==before
extra=helper/'foreign';extra.write_text('foreign fixture')
assert m.cleanup_public_helpers(helper,records,identity,saved) and bus.exists() and desktop.exists() and extra.exists()
extra.unlink()
replacement=fixture/'replacement';replacement.write_text('foreign fixture')
original=fixture/'saved-bus';bus.rename(original);os.replace(replacement,bus)
assert m.cleanup_public_helpers(helper,records,identity,saved) and bus.read_text()=='foreign fixture' and desktop.exists()
bus.unlink();os.replace(original,bus)
m.verify_staged_helpers(helper,records,identity,saved)
assert m.cleanup_public_helpers(helper,records,identity,saved)==[] and not helper.exists()
public.chmod(0o700)
try: m.validate_public_parent()
except RuntimeError: pass
else: raise AssertionError('app-inaccessible public parent accepted')
public.chmod(0o733)
try: m.validate_public_parent()
except RuntimeError: pass
else: raise AssertionError('app-writable public parent accepted')
public.chmod(0o711)
fixture.chmod(0o700)
try: m.validate_public_parent()
except RuntimeError: pass
else: raise AssertionError('app-inaccessible ancestor accepted')
fixture.chmod(0o711)
with (product/'desktop-session.py').open('ab') as changed: changed.write(b'\n# modified fixture\n')
try: m.verified_public_bytes('desktop-session.py')
except RuntimeError: pass
else: raise AssertionError('changed public source accepted')
assert stat.S_IMODE(product.stat().st_mode)==0o700
print('private-release helper isolation: PASS')
`;
  const result = await run('/usr/bin/python3', ['-I', '-B', '-c', probe, product, directory], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 10_000, maxBuffer: 64 * 1024,
  });
  assert.match(result.stdout, /^private-release helper isolation: PASS\n$/);
});
