import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(project, 'src/computer/native/vnc-launcher.c');
const output = path.join(project, 'dist/computer/native/vnc-launcher');
const manifest = path.join(project, 'dist/computer/native/launcher-manifest.json');
const reviewedBinary = path.join(project, 'src/computer/native/prebuilt/vnc-launcher');
const reviewedManifest = path.join(project, 'src/computer/native/prebuilt/launcher-manifest.json');
const taskTemp = path.join(project, 'tmp/c-native-unit');
const compiler = '/usr/bin/gcc';
const expectedCompilerSha256 = 'b5f1b773a7c733738352000c92a077dc5852a1a2fc6d836b1e411be1e9ec5f88';
const flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
  '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-fPIE', '-pie',
  '-Wl,-z,relro,-z,now'];
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const action = process.argv.length === 2 ? 'build' : process.argv[2];
if (!['build', '--check', '--prepare'].includes(action) ||
    process.argv.length !== (action === 'build' ? 2 : 3))
  throw new Error('Usage: build-vnc-launcher.mjs [--check|--prepare]');

async function pairExists(binary, recordFile) {
  const found = await Promise.all([binary, recordFile].map(async (file) => {
    try { return await lstat(file); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }));
  if (!found[0] && !found[1]) return false;
  if (!found[0] || !found[1])
    throw new Error('Native VNC launcher package integrity gate failed: partial artifact pair');
  return true;
}

async function verifyPair(binary, recordFile) {
  if (!await pairExists(binary, recordFile))
    throw new Error('Native VNC launcher package integrity gate failed: artifact pair absent');
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  const binaryInfo = await lstat(binary);
  const manifestInfo = await lstat(recordFile);
  if (!binaryInfo.isFile() || !(binaryInfo.mode & 0o111) ||
      !manifestInfo.isFile() ||
      record.schemaVersion !== 1 || record.platform !== 'linux' || record.arch !== 'x64' ||
      record.source?.path !== path.relative(project, source) ||
      record.source?.sha256 !== await hash(source) ||
      record.binary?.path !== path.relative(project, output) ||
      record.binary?.sha256 !== await hash(binary) ||
      record.binary?.sha256 !== '927ff0b4d21183e008f665d68978f944c2550ea65202ec1462087f7ef31cfeec' ||
      record.compiler?.path !== compiler ||
      record.compiler?.realpath !== '/usr/bin/x86_64-linux-gnu-gcc-15' ||
      record.compiler?.sha256 !== expectedCompilerSha256 ||
      record.compiler?.version !== '15.2.0' ||
      JSON.stringify(record.flags) !== JSON.stringify(flags) ||
      record.filterSha256 !== 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e')
    throw new Error('Native VNC launcher package integrity gate failed');
  return record;
}

if (action === '--prepare') {
  if (!await pairExists(output, manifest)) {
    await verifyPair(reviewedBinary, reviewedManifest);
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await copyFile(reviewedBinary, output);
    await copyFile(reviewedManifest, manifest);
  }
}

if (action === '--check' || action === '--prepare') {
  const record = await verifyPair(output, manifest);
  console.log(`Verified ${record.binary.path} (${record.binary.sha256})`);
  process.exit(0);
}
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Native VNC launcher unavailable: Linux x86-64 required');
const compilerInfo = await stat(compiler);
if (!compilerInfo.isFile() || compilerInfo.uid !== 0 ||
    await hash(compiler) !== expectedCompilerSha256)
  throw new Error('Native VNC launcher unavailable: reviewed compiler mismatch');
await mkdir(path.join(taskTemp, 'build-home'), { recursive: true, mode: 0o700 });
await mkdir(path.join(taskTemp, 'build-tmp'), { recursive: true, mode: 0o700 });
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
const env = {
  PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
  HOME: path.join(taskTemp, 'build-home'), TMPDIR: path.join(taskTemp, 'build-tmp'),
};
const { stdout: version } = await run(compiler, ['-dumpfullversion'], { env });
if (version.trim() !== '15.2.0')
  throw new Error('Native VNC launcher unavailable: reviewed compiler version mismatch');
const tempOutput = `${output}.building-${process.pid}`;
await run(compiler, [...flags, '-o', tempOutput, source], { env, maxBuffer: 1024 * 1024 });
await rename(tempOutput, output);
const body = {
  schemaVersion: 1,
  platform: 'linux', arch: 'x64',
  source: { path: path.relative(project, source), sha256: await hash(source) },
  binary: { path: path.relative(project, output), sha256: await hash(output) },
  compiler: { path: compiler, realpath: await realpath(compiler),
    sha256: expectedCompilerSha256, version: version.trim() },
  flags,
  filterSha256: 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e',
};
await writeFile(manifest, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
console.log(`Built ${body.binary.path} (${body.binary.sha256})`);
