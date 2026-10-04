import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { assertStartupConfiguration, checkStartupConfiguration } from '../ops/startup-check.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configUrl = pathToFileURL(path.join(root, 'src/config.ts')).href;

async function fixture(t) {
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(root, 'tmp/startup-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Synthetic settings only; the test never selects the real settings path.
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({
    authEnabled: true, authUser: 'fixture', authPasswordHash: 'synthetic-verifier',
  }), { mode: 0o600 });
  return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
    DECKIDE_DATA_DIR: directory, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '18798' };
}

test('production startup refuses missing CORS_ORIGIN before creating data state', async (t) => {
  const env = await fixture(t);
  await assert.rejects(run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `await import(${JSON.stringify(configUrl)})`], {
    cwd: root, env, timeout: 5000, maxBuffer: 64 * 1024,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /CRITICAL: CORS_ORIGIN must be set in production!/);
    assert.doesNotMatch(error.stdout + error.stderr, /synthetic-verifier/);
    return true;
  });
  assert.deepEqual(await readdir(env.DECKIDE_DATA_DIR), ['settings.json']);
});

test('production startup preserves the explicitly configured QA origin', async (t) => {
  const env = { ...await fixture(t), CORS_ORIGIN: 'http://127.0.0.1:18798' };
  const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `const c=await import(${JSON.stringify(configUrl)});` +
    `if(c.NODE_ENV!=='production'||c.CORS_ORIGIN!==process.env.CORS_ORIGIN||c.PORT!==18798)` +
    `throw new Error('Startup configuration changed');console.log('Startup configuration: PASS')`], {
    cwd: root, env, timeout: 5000, maxBuffer: 64 * 1024,
  });
  assert.match(result.stdout, /Startup configuration: PASS/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-verifier|http:\/\/127\.0\.0\.1:18798/);
});

test('required-name checker reads only two settings and preserves their values', () => {
  const values = Object.freeze({ NODE_ENV: 'production', CORS_ORIGIN: 'http://127.0.0.1:18798' });
  const names = [];
  const env = new Proxy(values, {
    get(target, name) { names.push(name); return target[name]; },
    ownKeys() { throw new Error('Environment enumeration forbidden'); },
    set() { throw new Error('Environment mutation forbidden'); },
  });
  assert.deepEqual(assertStartupConfiguration(env), { production: true, corsConfigured: true, missing: [] });
  assert.deepEqual(names, ['NODE_ENV', 'CORS_ORIGIN']);
  assert.equal(values.CORS_ORIGIN, 'http://127.0.0.1:18798');
  for (const origin of [undefined, '', '   ']) {
    const missing = { NODE_ENV: 'production', CORS_ORIGIN: origin, UNUSED_SECRET: 'synthetic-secret' };
    assert.deepEqual(checkStartupConfiguration(missing).missing, ['CORS_ORIGIN']);
    assert.throws(() => assertStartupConfiguration(missing), /^Error: CORS_ORIGIN must be set in production$/);
  }
});

test('startup checker CLI refuses missing production CORS without printing private values', async () => {
  await assert.rejects(run(process.execPath, [path.join(root, 'ops/startup-check.mjs')], {
    env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production', UNUSED_SECRET: 'synthetic-secret' },
    timeout: 5000, maxBuffer: 64 * 1024,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr, 'Startup configuration refused: CORS_ORIGIN must be set in production\n');
    return true;
  });
});

test('startup checker CLI emits only configuration booleans and required names', async () => {
  const result = await run(process.execPath, [path.join(root, 'ops/startup-check.mjs')], {
    env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production', CORS_ORIGIN: 'http://127.0.0.1:18798',
      UNUSED_SECRET: 'synthetic-secret' }, timeout: 5000, maxBuffer: 64 * 1024,
  });
  assert.deepEqual(JSON.parse(result.stdout), { production: true, corsConfigured: true, missing: [] });
  assert.equal(result.stderr, '');
});
