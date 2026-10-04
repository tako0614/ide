import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(repoRoot, 'bin', 'deckide.js');
const passwordHelpersPath = path.join(repoRoot, 'dist', 'auth', 'password.js');

function makeDataDir() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'deckide-cli-auth-'));
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port: 1 }));
  return dataDir;
}

function runCli(dataDir, ...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, DECKIDE_DATA_DIR: dataDir },
  });
}

test('Unix CLI entrypoint launches directly through its shebang', { skip: process.platform === 'win32' }, (t) => {
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(cliPath, ['help'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DECKIDE_DATA_DIR: dataDir },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Deck IDE/);
});

test('auth on persists only a private session password hash and masks it', async (t) => {
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const password = '000000000012';

  const enabled = runCli(dataDir, 'auth', 'on', 'test-user', password);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /Session auth enabled/);
  assert.ok(!enabled.stdout.includes(password));

  const file = path.join(dataDir, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(settings).sort(), ['authEnabled', 'authPasswordHash', 'authUser', 'port']);
  assert.equal(settings.authEnabled, true);
  assert.equal(settings.authUser, 'test-user');
  assert.ok(!JSON.stringify(settings).includes(password));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);

  const { verifyPassword } = await import(passwordHelpersPath);
  assert.equal(await verifyPassword(password, settings.authPasswordHash), true);
  assert.equal(runCli(dataDir, 'config', 'get', 'authPasswordHash').stdout.trim(), 'authPasswordHash: ********');
  assert.match(runCli(dataDir, 'config', 'list').stdout, /authPasswordHash: \*{8}/);
  assert.match(runCli(dataDir, 'auth', 'status').stdout, /password: \*{8}/);
});

test('config set authPassword keeps numeric-looking password text and rejects raw hashes', async (t) => {
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const password = '000000000012';
  const set = runCli(dataDir, 'config', 'set', 'authPassword', password);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.stdout.trim(), 'authPassword = ********');

  const settings = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  const { verifyPassword } = await import(passwordHelpersPath);
  assert.equal(await verifyPassword(password, settings.authPasswordHash), true);
  assert.ok(!JSON.stringify(settings).includes(password));

  const rawHash = runCli(dataDir, 'config', 'set', 'authPasswordHash', 'arbitrary');
  assert.notEqual(rawHash.status, 0);
  assert.match(rawHash.stderr, /legacy or secret field/);
});

test('legacy Basic password settings migrate once to a hash', async (t) => {
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const password = 'legacy-password-value';
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    basicAuthEnabled: true,
    basicAuthUser: 'legacy-user',
    basicAuthPassword: password,
    host: '127.0.0.1',
    port: 1,
  }));

  const output = runCli(dataDir, 'config', 'list');
  assert.equal(output.status, 0, output.stderr);
  const migrated = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(migrated.authEnabled, true);
  assert.equal(migrated.authUser, 'legacy-user');
  assert.ok(migrated.authPasswordHash);
  assert.ok(!JSON.stringify(migrated).includes(password));
  assert.ok(!('basicAuthPassword' in migrated));
  assert.ok(!output.stdout.includes(password));

  const { verifyPassword } = await import(passwordHelpersPath);
  assert.equal(await verifyPassword(password, migrated.authPasswordHash), true);
});

test('legacy encoded passwordHash migrates without being hashed again', async (t) => {
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { hashPassword, verifyPassword } = await import(passwordHelpersPath);
  const encoded = await hashPassword('old-session-password');
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    basicAuthEnabled: true,
    basicAuthUser: 'legacy-user',
    passwordHash: encoded,
    port: 1,
  }));

  const output = runCli(dataDir, 'config', 'get', 'authPasswordHash');
  assert.equal(output.status, 0, output.stderr);
  const migrated = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(migrated.authPasswordHash, encoded);
  assert.equal(await verifyPassword('old-session-password', migrated.authPasswordHash), true);
});

test('partial session settings merge legacy credentials without losing enabled auth', async (t) => {
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const password = 'legacy-password-value';
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    authUser: 'preferred-user',
    basicAuthEnabled: true,
    basicAuthPassword: password,
    port: 1,
  }));

  const output = runCli(dataDir, 'config', 'list');
  assert.equal(output.status, 0, output.stderr);
  const migrated = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(migrated.authEnabled, true);
  assert.equal(migrated.authUser, 'preferred-user');
  const { verifyPassword } = await import(passwordHelpersPath);
  assert.equal(await verifyPassword(password, migrated.authPasswordHash), true);
});

test('enabled malformed legacy credentials fail closed without rewriting settings', async (t) => {
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'settings.json');
  const original = JSON.stringify({
    basicAuthEnabled: true,
    basicAuthUser: 'legacy-user',
    passwordHash: 'malformed-hash',
    port: 1,
  });
  writeFileSync(file, original);

  const result = runCli(dataDir, 'config', 'list');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid legacy password hash/);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('malformed settings JSON cannot be overwritten by a config write', (t) => {
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'settings.json');
  const original = '{invalid json';
  writeFileSync(file, original);

  const result = runCli(dataDir, 'config', 'set', 'authEnabled', 'false');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot read Deck IDE settings/);
  assert.equal(readFileSync(file, 'utf8'), original);
});
