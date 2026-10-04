import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherRoot = path.join(root, 'ops/chatgpt-launcher');
const files = ['launch-chatgpt.sh', 'session-supervisor.py', 'desktop-session.py',
  'session-bus.conf', 'test-session-lifecycle.py'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);

async function fixture(t) {
  const temporary = path.join(root, 'tmp');
  await mkdir(temporary, { recursive: true, mode: 0o700 });
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

test('private release stays inaccessible while only verified session helpers cross to a disposable unprivileged reader', async (t) => {
  const directory = await mkdtemp('/var/tmp/deckide-public-helper-');
  t.after(() => rm(directory, { recursive: true, force: true }));
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
runtime=fixture/'private-runtime';runtime.mkdir(mode=0o700)
os.chown(runtime,65534,65534);m.RUNTIME=runtime
saved=m.runtime_identity();records=[]
bus=runtime/'.deckide-public-0123456789abcdef0123456789abcdef-session-bus.conf'
desktop=runtime/'.deckide-public-0123456789abcdef0123456789abcdef-desktop-session.py'
m.stage_public_helper('session-bus.conf',bus,records)
m.stage_public_helper('desktop-session.py',desktop,records)
for record in records:
    m.verify_staged_helper(record,saved)
    info=record['path'].lstat()
    assert (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(0,0,0o644)
assert m.desktop_command(bus,desktop)==['/usr/bin/dbus-run-session','--config-file='+str(bus),'--','/usr/bin/python3','-I',str(desktop)]
reader="""import hashlib,sys\nfrom pathlib import Path\ntry: Path(sys.argv[1]).read_bytes()\nexcept PermissionError: pass\nelse: raise AssertionError('private package became accessible')\nassert hashlib.sha256(Path(sys.argv[2]).read_bytes()).hexdigest()==sys.argv[4]\nassert hashlib.sha256(Path(sys.argv[3]).read_bytes()).hexdigest()==sys.argv[5]"""
subprocess.run(['/usr/bin/python3','-I','-B','-c',reader,str(product/'desktop-session.py'),str(bus),str(desktop),m.PUBLIC_HELPERS['session-bus.conf'][1],m.PUBLIC_HELPERS['desktop-session.py'][1]],check=True,user=65534,group=65534,extra_groups=[],env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=5)
partial=runtime/'.deckide-public-fedcba9876543210fedcba9876543210-session-bus.conf'
with patch.object(m.os,'fsync',side_effect=OSError('synthetic write failure')):
    try: m.stage_public_helper('session-bus.conf',partial,records)
    except OSError: pass
    else: raise AssertionError('partial failure accepted')
assert not partial.exists() and len(records)==2
replacement=runtime/'replacement';replacement.write_text('foreign fixture')
os.replace(replacement,bus)
errors=m.cleanup_public_helpers(records,saved)
assert len(errors)==1 and bus.read_text()=='foreign fixture' and not desktop.exists()
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
