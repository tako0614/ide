import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = path.join(root, 'tmp/c-native-unit');
const flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
  '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-fPIE', '-pie',
  '-Wl,-z,relro,-z,now'];
const hash = (data) => createHash('sha256').update(data).digest('hex');

test('launcher C negative units use syscall mocks and never run product executable', async () => {
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const binary = path.join(temp, 'native-vnc-launcher-unit');
  const source = path.join(root, 'tests/native-vnc-launcher-unit.c');
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    HOME: temp, TMPDIR: temp };
  await run('/usr/bin/gcc', [...flags, '-o', binary, source], { env });
  const result = await run(binary, [], { env });
  assert.match(result.stdout, /^native launcher pure-mock negative units: PASS\n$/);
});

test('embedded filter and compiled release pair have the reviewed hashes', async () => {
  const source = await readFile(path.join(root, 'src/computer/native/vnc-launcher.c'));
  const manifest = JSON.parse(await readFile(path.join(root, 'dist/computer/native/launcher-manifest.json'), 'utf8'));
  const productBinary = await readFile(path.join(root, 'dist/computer/native/vnc-launcher'));
  assert.equal(manifest.source.sha256, hash(source));
  assert.equal(manifest.binary.sha256, hash(productBinary));
  assert.equal(manifest.filterSha256, 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e');
  const text = source.toString();
  const initializer = /static const struct sock_filter reviewed_filter\[\] = \{([\s\S]*?)\n\};/.exec(text)?.[1];
  assert.ok(initializer);
  const instructions = [...initializer.matchAll(/\{(0x[\da-f]+|\d+),(\d+),(\d+),(0x[\da-f]+|\d+)\}/g)];
  assert.equal(instructions.length, 39);
  const policy = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([, code, jt, jf, k], index) => {
    policy.writeUInt16LE(Number(code), index * 8);
    policy[index * 8 + 2] = Number(jt);
    policy[index * 8 + 3] = Number(jf);
    policy.writeUInt32LE(Number(k), index * 8 + 4);
  });
  assert.equal(hash(policy), manifest.filterSha256);
  assert.match(text, /_Static_assert\(sizeof\(reviewed_filter\) == 312/);
  assert.match(text, /execve\(self_exe, next, env\)/);
  assert.match(text, /"before", NULL\};\s*run_setpriv/);
});

test('unsupported platform has a compile-time failure', async () => {
  const source = path.join(root, 'src/computer/native/vnc-launcher.c');
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: temp, TMPDIR: temp };
  await assert.rejects(run('/usr/bin/gcc', ['-std=c11', '-U__linux__', '-fsyntax-only', source], { env }),
    /requires Linux x86-64 and close_range/);
  await assert.rejects(run('/usr/bin/gcc', ['-std=c11', '-U__x86_64__', '-D__aarch64__',
    '-fsyntax-only', source], { env }), /requires Linux x86-64 and close_range/);
});
