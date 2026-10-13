import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { matchDeck } from '../bin/cli-client.js';
import { hashPassword } from '../dist/auth/password.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('deck ids require an exact match or an unambiguous prefix', () => {
  const decks = [{ id: 'aaaa1111', name: 'duplicate' }, { id: 'aaaa2222', name: 'duplicate' }];
  assert.equal(matchDeck(decks, 'aaaa1111'), decks[0]);
  assert.equal(matchDeck(decks, 'aaaa2'), decks[1]);
  assert.throws(() => matchDeck(decks, 'aaaa'), /several decks/);
  assert.equal(matchDeck(decks, 'aaa'), null);
  assert.equal(matchDeck(decks, 'duplicate'), null);
  assert.equal(matchDeck(decks, 'missing'), null);
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-deck-commands-'));
  const dataDir = path.join(dir, 'data');
  const workdir = path.join(dir, 'work');
  await mkdir(dataDir);
  await mkdir(workdir);
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ port,
    authEnabled: true, authUser: 'tester', authPasswordHash: await hashPassword('test deck commands'),
  }));
  // No inherited production DB, credentials, desktop, or terminal identity.
  const env = { PATH: process.env.PATH, HOME: os.homedir(), SHELL: '/bin/sh', LANG: 'C.UTF-8',
    NODE_ENV: 'test', DECKIDE_DATA_DIR: dataDir, DB_PATH: path.join(dataDir, 'deck-ide.db'),
    PORT: String(port), HOST: '127.0.0.1', DECKIDE_URL: `http://127.0.0.1:${port}`,
    DECKIDE_DESKTOP: 'false', AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false',
  };
  let child;
  let logs = '';
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw new Error('Server exited: ' + logs);
      try { if ((await fetch(env.DECKIDE_URL + '/health')).ok) return; } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Health timeout: ' + logs);
  };
  const run = (...args) => spawnSync(process.execPath, ['bin/deckide.js', ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
  const cli = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const api = async (route, method = 'GET', body, authorized = true) => {
    const { token } = JSON.parse(await readFile(path.join(dataDir, 'cli.json'), 'utf8'));
    return fetch(env.DECKIDE_URL + '/api' + route, { method,
      headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  const dbRead = (sql, ...values) => {
    const db = new DatabaseSync(env.DB_PATH, { readOnly: true });
    try { return db.prepare(sql).get(...values); } finally { db.close(); }
  };
  await start();
  return { cli, run, api, dbRead, start, stop, env, workdir };
}

test('deck CLI lists, renames persistently, deletes empty decks, and refuses occupied decks with auth enabled',
  { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    assert.deepEqual(JSON.parse(f.cli('deck', 'list', '--json')), []);
    assert.match(f.cli('deck', 'list'), /No decks/);
    const workspaceResponse = await f.api('/workspaces', 'POST', { path: f.workdir });
    assert.equal(workspaceResponse.status, 201);
    const workspace = await workspaceResponse.json();
    const create = async (name) => {
      const response = await f.api('/decks', 'POST', { workspaceId: workspace.id, name });
      assert.equal(response.status, 201);
      return response.json();
    };
    const deck = await create('original');
    const occupied = await create('occupied');
    const db = new DatabaseSync(f.env.DB_PATH);
    try {
      // An unattached row must block deletion even when no terminal is listed in memory.
      db.prepare(`INSERT INTO terminals (id, deck_id, title, created_at, cols, rows, tmux_socket)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run('unattached', occupied.id, 'shell', '2026-10-13', 80, 24, null);
    } finally { db.close(); }
    const listed = JSON.parse(f.cli('deck', 'list', '--json'));
    assert.equal(listed.length, 2);
    assert.match(f.cli('deck', 'list'), new RegExp(deck.id));
    assert.match(f.cli('deck', 'list'), /original/);
    assert.match(f.cli('deck', 'rename', deck.id.slice(0, 8), 'renamed 日本語 with spaces'), /renamed 日本語 with spaces/);
    const verifyName = () => {
      assert.equal(JSON.parse(f.cli('deck', 'list', '--json')).find((value) => value.id === deck.id).name, 'renamed 日本語 with spaces');
      assert.equal(f.dbRead('SELECT name FROM decks WHERE id = ?', deck.id).name, 'renamed 日本語 with spaces');
    };
    verifyName();
    for (const [route, method, body] of [['/decks', 'GET'], [`/decks/${deck.id}`, 'PATCH', { name: 'unauthorized' }],
      [`/decks/${deck.id}`, 'DELETE']]) {
      assert.equal((await f.api(route, method, body, false)).status, 401);
    }
    verifyName();
    for (const args of [['deck'], ['deck', 'list', 'extra'], ['deck', 'delete'], ['deck', 'delete', deck.id, 'extra'],
      ['deck', 'rename', deck.id], ['deck', 'rename', deck.id, ' '], ['deck', 'rename', deck.id, 'a', 'b'],
      ['deck', 'rename', 'missing', 'new'], ['deck', 'delete', 'missing']]) {
      assert.equal(f.run(...args).status, 1, JSON.stringify(args));
    }
    const refusal = f.run('deck', 'delete', occupied.id);
    assert.equal(refusal.status, 1);
    assert.match(refusal.stderr, /still has terminals/);
    assert.equal((await f.api(`/decks/${occupied.id}`, 'DELETE')).status, 409);
    assert.equal(f.dbRead('SELECT deck_id FROM terminals WHERE id = ?', 'unattached').deck_id, occupied.id);
    await f.stop();
    await f.start();
    verifyName();
    assert.equal(f.run('deck', 'delete', occupied.id).status, 1);
    assert.match(f.cli('deck', 'delete', deck.id.slice(0, 8)), /Deleted/);
    assert.equal(f.dbRead('SELECT id FROM decks WHERE id = ?', deck.id), undefined);
    assert.deepEqual(JSON.parse(f.cli('deck', 'list', '--json')).map((value) => value.id), [occupied.id]);
  });
