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
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('deck CLI lists full IDs, persists rename, deletes empty decks and refuses occupied decks', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deckide-deck-cli-'));
  const dataDir = path.join(dir, 'data');
  const workdir = path.join(dir, 'work');
  await mkdir(dataDir);
  await mkdir(workdir);
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ port }));
  const env = { PATH: process.env.PATH, HOME: dir, SHELL: '/bin/sh', LANG: 'C.UTF-8', NODE_ENV: 'test',
    DECKIDE_DATA_DIR: dataDir, DB_PATH: path.join(dataDir, 'deck-ide.db'), HOST: '127.0.0.1', PORT: String(port),
    DECKIDE_AUTH_USER: 'test-admin', DECKIDE_AUTH_PASSWORD: 'synthetic-deck-admin-password',
    DECKIDE_DESKTOP: 'false', AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false' };
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
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Server did not start: ' + logs);
  };
  const run = (...args) => spawnSync(process.execPath, ['bin/deckide.js', ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  const cli = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const api = async (route, method = 'GET', body) => {
    const { token } = JSON.parse(await readFile(path.join(dataDir, 'cli.json'), 'utf8'));
    return fetch(`http://127.0.0.1:${port}/api${route}`, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  };
  await start();
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/decks`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/decks`, {
    headers: { Authorization: `Bearer ${'x'.repeat(43)}` },
  })).status, 401);
  assert.deepEqual(JSON.parse(cli('deck', 'list', '--json')), []);
  assert.match(cli('deck', 'list'), /No decks/);
  cli('open', workdir, '-t', 'live shell');
  const state = JSON.parse(cli('ls', '--json'));
  const occupied = state.decks[0];
  const terminal = state.terminals[0];
  const empty = await (await api('/decks', 'POST', { workspaceId: occupied.workspaceId, name: 'empty' })).json();
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/decks/${empty.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'unauthorized' }),
  })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/decks/${empty.id}`, { method: 'DELETE' })).status, 401);
  const { token } = JSON.parse(await readFile(path.join(dataDir, 'cli.json'), 'utf8'));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/decks/${empty.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Origin: 'https://foreign.example' },
  })).status, 403);
  assert.match(cli('deck', 'list'), new RegExp(empty.id));
  assert.equal(JSON.parse(cli('deck', 'list', '--json')).length, 2);
  const refused = run('deck', 'delete', occupied.id);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /409.*terminal/i);
  assert.equal((await api('/terminals/' + terminal.id)).status, 200);
  cli('send', terminal.id, `printf alive > '${workdir}/alive'`);
  for (let n = 0; n < 100; n++) {
    try { if ((await readFile(path.join(workdir, 'alive'), 'utf8')) === 'alive') break; } catch { /* writing */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await readFile(path.join(workdir, 'alive'), 'utf8'), 'alive');
  cli('deck', 'rename', empty.id, '  renamed 日本語 with spaces  ');
  assert.equal(JSON.parse(cli('deck', 'list', '--json')).find((deck) => deck.id === empty.id).name, 'renamed 日本語 with spaces');
  for (const args of [['deck'], ['deck', 'oops'], ['deck', 'list', 'extra'], ['deck', 'list', '--oops'],
    ['deck', 'delete'], ['deck', 'delete', empty.id, 'extra'], ['deck', 'rename', empty.id],
    ['deck', 'rename', empty.id, ' '], ['deck', 'rename', empty.id, 'a', 'b'],
    ['deck', 'delete', 'missing'], ['deck', 'rename', 'missing', 'name'],
    ['deck', 'delete', empty.id.slice(0, 3)], ['deck', 'rename', 'renamed 日本語 with spaces', 'name']]) {
    assert.equal(run(...args).status, 1, JSON.stringify(args));
  }
  const db = new DatabaseSync(env.DB_PATH);
  try {
    assert.equal(db.prepare('SELECT name FROM decks WHERE id = ?').get(empty.id).name, 'renamed 日本語 with spaces');
    db.prepare(`INSERT INTO terminals (id, deck_id, title, created_at, cols, rows) VALUES ('legacy', ?, 'legacy', '2026-10-13', 80, 24)`).run(empty.id);
    assert.equal(run('deck', 'delete', empty.id).status, 1);
    db.prepare('DELETE FROM terminals WHERE id = ?').run('legacy');
  } finally { db.close(); }
  await stop();
  delete env.DECKIDE_AUTH_USER;
  delete env.DECKIDE_AUTH_PASSWORD;
  await start();
  assert.equal(JSON.parse(cli('deck', 'list', '--json')).find((deck) => deck.id === empty.id).name, 'renamed 日本語 with spaces');
  // With auth off, a missing CLI token must still enforce the server precondition.
  await rm(path.join(dataDir, 'cli.json'));
  const db2 = new DatabaseSync(env.DB_PATH);
  try {
    db2.prepare(`INSERT INTO terminals (id, deck_id, title, created_at, cols, rows) VALUES ('unattached', ?, 'saved', '2026-10-13', 80, 24)`).run(empty.id);
    assert.equal(run('deck', 'delete', empty.id).status, 1);
    db2.prepare('DELETE FROM terminals WHERE id = ?').run('unattached');
    cli('deck', 'delete', empty.id);
    assert.equal(db2.prepare('SELECT id FROM decks WHERE id = ?').get(empty.id), undefined);
  } finally { db2.close(); }
  assert.equal(JSON.parse(cli('deck', 'list', '--json')).some((deck) => deck.id === empty.id), false);
  assert.equal(run('deck', 'delete', empty.id).status, 1);
});
