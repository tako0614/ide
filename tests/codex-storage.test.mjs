import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CodexLibrary, defaultCodexSources } from '../src/codex/library.js';
import { createCodexRouter } from '../src/routes/codex.js';

const ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';
const probe = () => ({ entries: [], complete: true });
const hash = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function fixture(t, split = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-codex-'));
  const home = path.join(root, 'home');
  const sqlite = split ? path.join(root, 'sqlite') : home;
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true, mode: 0o700 });
  if (split) fs.mkdirSync(sqlite, { mode: 0o700 });
  const file = path.join(sqlite, 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT,
    title TEXT, source TEXT, originator TEXT, archived INTEGER, updated_at INTEGER)`);
  const source = { id: 'current', label: 'fixture', home };
  const config = (value) => fs.writeFileSync(path.join(home, 'config.toml'), value);
  if (split) config('sqlite_home = ' + JSON.stringify(sqlite) + '\n');
  const row = (id = ID, rollout = path.join(home, 'sessions', `rollout-${id}.jsonl`), updated = 1, title = 'synthetic') => {
    db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)').run(id, rollout, root, title, 'cli', 'codex_cli', 0, updated);
    return rollout;
  };
  const transcript = (file) => fs.writeFileSync(file, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic question' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic answer' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  transcript(row());
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const library = () => new CodexLibrary([source], probe);
  return { root, home, sqlite, file, db, source, config, row, transcript, library };
}

function unavailable(f) {
  const value = f.library().list();
  assert.equal(value.sources[0].available, false);
  assert.deepEqual(value.tasks, []);
  assert.throws(() => f.library().read('current', ID));
}

test('legacy home layout and root-configured split layout list/read without writes', async (t) => {
  for (const split of [false, true]) await t.test(String(split), (t) => {
    const f = fixture(t, split);
    const before = hash(f.file);
    const names = fs.readdirSync(f.sqlite);
    const lib = f.library();
    assert.equal(lib.list().sources[0].available, true);
    assert.equal(lib.list().tasks[0].id, ID);
    assert.deepEqual(lib.read('current', ID).messages.map(m => m.text), ['synthetic question', 'synthetic answer']);
    assert.equal(hash(f.file), before);
    assert.deepEqual(fs.readdirSync(f.sqlite), names);
    lib.indexed(f.source, (db) => assert.throws(() => db.exec('DELETE FROM threads'), /readonly|read.only/i));
  });
});

test('config wins captured current env, while legacy/custom sources never borrow process env', (t) => {
  const f = fixture(t);
  const g = fixture(t, false);
  const saved = { home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME };
  t.after(() => {
    for (const [key, value] of [['CODEX_HOME', saved.home], ['CODEX_SQLITE_HOME', saved.sqlite]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.CODEX_HOME = f.home;
  process.env.CODEX_SQLITE_HOME = path.join(f.root, 'missing-env');
  const selected = defaultCodexSources()[0];
  assert.equal(new CodexLibrary([selected], probe).list().sources[0].available, true);
  fs.unlinkSync(path.join(f.home, 'config.toml'));
  process.env.CODEX_SQLITE_HOME = f.sqlite;
  const captured = defaultCodexSources()[0];
  process.env.CODEX_SQLITE_HOME = path.join(f.root, 'changed-after-selection');
  assert.equal(new CodexLibrary([captured], probe).list().tasks[0].id, ID);
  assert.equal(new CodexLibrary([{ ...g.source, id: 'legacy' }], probe).list().sources[0].available, true);
  assert.equal(new CodexLibrary([{ ...f.source, id: 'custom' }], probe).list().sources[0].available, false);
  for (const empty of ['', ' \t\n']) {
    process.env.CODEX_HOME = g.home;
    process.env.CODEX_SQLITE_HOME = empty;
    assert.equal(new CodexLibrary([defaultCodexSources()[0]], probe).list().tasks[0]?.id, ID);
  }
  process.env.CODEX_HOME = f.home;
  process.env.CODEX_SQLITE_HOME = ' \t' + f.sqlite + '\n';
  assert.equal(new CodexLibrary([defaultCodexSources()[0]], probe).list().tasks[0]?.id, ID);
  process.env.CODEX_SQLITE_HOME = 'relative-native-cwd-not-known';
  assert.equal(new CodexLibrary([defaultCodexSources()[0]], probe).list().sources[0].available, false);
});

test('WAL-only committed data is observed without SQL DB/WAL writes', (t) => {
  const f = fixture(t);
  f.db.exec("PRAGMA journal_mode=WAL; UPDATE threads SET title='committed in WAL'");
  const snapshot = path.join(f.root, 'wal-snapshot');
  fs.mkdirSync(snapshot, { mode: 0o700 });
  for (const name of fs.readdirSync(f.sqlite)) fs.copyFileSync(path.join(f.sqlite, name), path.join(snapshot, name));
  f.config('sqlite_home = ' + JSON.stringify(snapshot));
  const files = ['state_5.sqlite', 'state_5.sqlite-wal'];
  const before = files.map(file => hash(path.join(snapshot, file)));
  assert.equal(f.library().list().tasks[0].title, 'committed in WAL');
  assert.equal(f.library().read('current', ID).messages.length, 2);
  assert.deepEqual(files.map(file => hash(path.join(snapshot, file))), before);
  // SQLite can update the copied SHM wal-index as reader coordination. It is
  // deliberately not called an immutable/bytewise-no-touch connection.
});

test('normal clean-closed WAL indexes remain readable in both layouts', async (t) => {
  for (const split of [false, true]) await t.test(String(split), (t) => {
    const f = fixture(t, split);
    const closed = new DatabaseSync(path.join(f.sqlite, 'state_6.sqlite'));
    try {
      closed.exec('PRAGMA journal_mode=WAL');
      closed.exec(f.db.prepare("SELECT sql FROM sqlite_master WHERE name='threads'").get().sql);
      closed.prepare('INSERT INTO threads SELECT ?,?,?,?,?,?,?,?').run(ID, path.join(f.home, 'sessions', `rollout-${ID}.jsonl`), f.root, 'closed WAL', 'cli', 'codex_cli', 0, 1);
    } finally { closed.close(); }
    assert.equal(f.library().list().tasks[0].title, 'closed WAL');
    assert.equal(f.library().read('current', ID).messages.length, 2);
  });
});

test('a reader keeps one WAL snapshot across its batched queries while a writer advances', (t) => {
  const f = fixture(t);
  f.db.exec('PRAGMA journal_mode=WAL');
  f.library().indexed(f.source, reader => {
    const title = () => reader.prepare('SELECT title FROM threads WHERE id=?').get(ID).title;
    assert.equal(title(), 'synthetic');
    f.db.prepare('UPDATE threads SET title=? WHERE id=?').run('new writer commit', ID);
    assert.equal(title(), 'synthetic');
  });
  assert.equal(f.library().list().tasks[0].title, 'new writer commit');
});

test('TOML strings/comments/sections are parsed, and relative config is anchored to its own home', (t) => {
  const f = fixture(t);
  f.config(`message = """\nsqlite_home = '/wrong-from-string'\n"""\n"sqlite_home" = '../sqlite' # relative to this config\n[profiles.example]\nsqlite_home = '/wrong-from-table'\n`);
  assert.equal(f.library().list().tasks[0].id, ID);
  const legacy = fixture(t, false);
  legacy.config('[profiles.unselected]\nsqlite_home = "/not-the-root-key"\n');
  assert.equal(legacy.library().list().sources[0].available, true);
});

test('explicit missing/invalid layout and malformed configuration never fall back to an old home index', async (t) => {
  for (const config of ['sqlite_home = "/missing-deckide-fixture"', 'sqlite_home = 7', 'sqlite_home = ""',
    'sqlite_home = ["/tmp"]', 'sqlite_home = "unterminated', 'sqlite_home = "/one"\nsqlite_home = "/two"']) {
    await t.test(config.slice(0, 30), (t) => {
      const f = fixture(t, false);
      f.config(config); unavailable(f);
    });
  }
});

test('unsafe source/home/config/SQLite directory/index and sidecar paths fail closed', async (t) => {
  const cases = {
    'relative source home': f => { f.source.home = 'relative'; },
    'non-directory home': f => { f.source.home = f.file; },
    'source home symlink': f => { const link = path.join(f.root, 'home-alias'); fs.symlinkSync(f.home, link); f.source.home = link; },
    'config symlink': f => { const p = path.join(f.home, 'config.toml'); fs.renameSync(p, p + '.real'); fs.symlinkSync(p + '.real', p); },
    'hardlinked config': f => { fs.linkSync(path.join(f.home, 'config.toml'), path.join(f.root, 'config-copy')); },
    'oversized config': f => { fs.writeFileSync(path.join(f.home, 'config.toml'), '#'.repeat(1024 * 1024 + 1)); },
    'SQLite directory alias': f => { const p = path.join(f.root, 'sqlite-alias'); fs.symlinkSync(f.sqlite, p); f.config('sqlite_home = ' + JSON.stringify(p)); },
    'writable SQLite directory': f => { fs.chmodSync(f.sqlite, 0o777); },
    'index symlink': f => { fs.renameSync(f.file, f.file + '.real'); fs.symlinkSync(f.file + '.real', f.file); },
    'index hardlink': f => { fs.linkSync(f.file, f.file + '.link'); },
    'invalid highest-version index': f => { fs.symlinkSync(f.file, path.join(f.sqlite, 'state_99.sqlite')); },
    'WAL symlink': f => { const p = path.join(f.root, 'not-wal'); fs.writeFileSync(p, ''); fs.symlinkSync(p, f.file + '-wal'); },
    'SHM hardlink': f => { const p = path.join(f.root, 'not-shm'); fs.writeFileSync(p, ''); fs.linkSync(p, f.file + '-shm'); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, (t) => {
    const f = fixture(t); mutate(f); unavailable(f);
  });
});

test('config/directory/index owners must match the selected home owner', { skip: process.getuid?.() !== 0 }, async (t) => {
  for (const target of ['config', 'directory', 'index']) await t.test(target, (t) => {
    const f = fixture(t);
    const p = target === 'config' ? path.join(f.home, 'config.toml') : target === 'directory' ? f.sqlite : f.file;
    fs.chownSync(p, 65534, 65534); unavailable(f);
  });
});

test('foreign/aliased/missing rollouts are omitted before pagination and never resume/read', (t) => {
  const f = fixture(t);
  f.db.exec('UPDATE threads SET updated_at=1');
  const foreign = path.join(f.root, 'foreign.jsonl'); f.transcript(foreign);
  f.row(FOREIGN, foreign, 100, 'foreign private title');
  const alias = path.join(f.home, 'sessions', 'alias.jsonl'); fs.symlinkSync(foreign, alias);
  const ALIAS = '44444444-4444-4444-8444-444444444444'; f.row(ALIAS, alias, 99);
  const MISSING = '55555555-5555-4555-8555-555555555555'; f.row(MISSING, path.join(f.home, 'sessions', 'missing.jsonl'), 98);
  f.transcript(f.row(SECOND, undefined, 2));
  const lib = f.library();
  const first = lib.list('', 0, 1); assert.deepEqual(first.tasks.map(t => t.id), [SECOND]); assert.equal(first.nextOffset, 1);
  const second = lib.list('', 1, 1); assert.deepEqual(second.tasks.map(t => t.id), [ID]); assert.equal(second.nextOffset, null);
  assert.ok(!JSON.stringify(first).includes('foreign private title'));
  for (const id of [FOREIGN, ALIAS, MISSING]) assert.throws(() => lib.read('current', id));
  assert.throws(() => lib.read('foreign-source', ID));
  assert.equal(lib.list('no-matching-title').tasks.length, 0);
  assert.equal(first.tasks[0].resumeCommand, undefined, 'split layout is observer-only until native resume parity is qualified');
});

test('index under SQLite home cannot authorize transcript files stored there or under another source', (t) => {
  const f = fixture(t);
  const p = path.join(f.sqlite, 'rollout-foreign.jsonl'); f.transcript(p); f.row(FOREIGN, p, 100);
  const lib = f.library(); assert.deepEqual(lib.list().tasks.map(t => t.id), [ID]);
  assert.throws(() => lib.read('current', FOREIGN));
});

test('pagination scans past a full batch of refused rows', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 130; i++) f.row(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, path.join(f.root, 'outside.jsonl'), i + 10);
  assert.deepEqual(f.library().list('', 0, 1).tasks.map(t => t.id), [ID]);
  assert.equal(f.library().list('', 0, 1).nextOffset, null);
});

test('rollout single-link/owner/no-alias guards apply to both layouts and archived sessions', async (t) => {
  for (const split of [false, true]) await t.test(String(split), (t) => {
    const f = fixture(t, split);
    if (!split) assert.match(f.library().list().tasks[0].resumeCommand, /codex resume/);
    const original = path.join(f.home, 'sessions', `rollout-${ID}.jsonl`);
    fs.linkSync(original, path.join(f.root, 'rollout-link'));
    assert.deepEqual(f.library().list().tasks, []); assert.throws(() => f.library().read('current', ID));
    fs.unlinkSync(path.join(f.root, 'rollout-link'));
    if (process.getuid?.() === 0) {
      fs.chownSync(original, 65534, 65534);
      assert.deepEqual(f.library().list().tasks, []); assert.throws(() => f.library().read('current', ID));
      fs.chownSync(original, 0, 0);
    }
    const archived = path.join(f.home, 'archived_sessions'); fs.mkdirSync(archived);
    const file = path.join(archived, 'archived.jsonl'); fs.renameSync(original, file);
    f.db.prepare('UPDATE threads SET rollout_path=?,archived=1 WHERE id=?').run(file, ID);
    assert.equal(f.library().read('current', ID).task.archived, true);
    assert.equal(f.library().list().tasks[0].resumeCommand, undefined);
  });
});

test('owner-only HTTP route still denies guests and returns generic read failures', async (t) => {
  const f = fixture(t); const lib = f.library();
  const denied = createCodexRouter(lib, () => false);
  assert.equal((await denied.request('/')).status, 403);
  assert.equal((await denied.request('/current/' + ID)).status, 403);
  const allowed = createCodexRouter(lib, () => true);
  assert.equal((await allowed.request('/current/' + ID)).status, 200);
  const failed = await allowed.request('/foreign-source/' + ID);
  assert.equal(failed.status, 404); assert.equal(failed.headers.get('Cache-Control'), 'no-store');
  assert.ok(!(await failed.text()).includes(f.root));
});
