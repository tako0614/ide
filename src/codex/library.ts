import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function defaultCodexSources() {
    const current = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    return [{ id: 'current', label: '現在のCodex', home: current },
        ...(current !== '/var/lib/chatgpt-app/.codex'
            ? [{ id: 'legacy', label: '旧Desktop', home: '/var/lib/chatgpt-app/.codex' }] : [])];
}
function processIdentity(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/);
        if (['Z', 'X'].includes(fields[0]))
            return null;
        return { pid, ppid: Number(fields[1]), uid: fs.statSync(`/proc/${pid}`).uid, start: fields[19] };
    }
    catch {
        return null;
    }
}
/** Only comm, identity and open-file paths are inspected; never argv/environment. */
export function liveCodexRollouts(terminals) {
    const entries = [];
    let complete = true;
    if (process.platform !== 'linux')
        return { entries, complete: false };
    let pids;
    try {
        pids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name));
    }
    catch {
        return { entries, complete: false };
    }
    for (const text of pids) {
        const pid = Number(text);
        try {
            if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'codex')
                continue;
            const saved = processIdentity(pid);
            if (!saved)
                continue;
            const ancestors = new Set();
            let cursor = saved;
            for (let i = 0; cursor && cursor.pid > 1 && i < 32; i++) {
                ancestors.add(cursor.pid);
                cursor = processIdentity(cursor.ppid);
            }
            const attached = [...terminals.values()].find(t => t.available && ancestors.has(t.tmux.pid));
            const terminal = attached ? { id: attached.id, deckId: attached.deckId } : undefined;
            const files = new Set();
            for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
                try {
                    const file = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
                    if (path.isAbsolute(file) && /^rollout-.*\.jsonl$/.test(path.basename(file)))
                        files.add(file);
                }
                catch { /* descriptor closed during discovery */ }
            }
            const now = processIdentity(pid);
            if (now && now.start === saved.start && now.uid === saved.uid)
                for (const file of files)
                    entries.push({ file, terminal });
        }
        catch (error) {
            if (error.code === 'EACCES')
                complete = false;
        }
    }
    return { entries, complete };
}
export function codexKind(source, originator) {
    if (/chatgpt|desktop|electron/i.test(originator))
        return 'desktop';
    if (/^(cli|exec)$/i.test(source) || /codex_cli/i.test(originator))
        return 'cli';
    return 'other';
}
const text = (value, maximum = 400) => typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum) : '';
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
/** Paths from the index must remain inside this source's session directories. */
function safeRollout(home, file, owner) {
    if (!path.isAbsolute(file) || path.extname(file) !== '.jsonl')
        throw Error('unavailable');
    const realHome = fs.realpathSync(home);
    const resolved = fs.realpathSync(file);
    if (resolved !== file || !['sessions', 'archived_sessions'].some(dir => resolved.startsWith(path.join(realHome, dir) + path.sep)))
        throw Error('unavailable');
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.uid !== owner || info.nlink !== 1 || info.size > 256 * 1024 * 1024)
        throw Error('unavailable');
    return resolved;
}
function rolloutTail(file, bytes, owner) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.uid !== owner || info.nlink !== 1 || info.size > 256 * 1024 * 1024)
            throw Error('unavailable');
        const start = Math.max(0, info.size - bytes);
        const buffer = Buffer.alloc(Math.min(bytes, info.size));
        const count = fs.readSync(fd, buffer, 0, buffer.length, start);
        const lines = buffer.subarray(0, count).toString('utf8').split('\n');
        if (start)
            lines.shift();
        const records = [];
        for (const line of lines) {
            try {
                const data = JSON.parse(line);
                if (data && typeof data === 'object')
                    records.push(data);
            }
            catch { /* a partial append is expected; raw text is never logged */ }
        }
        return { records, truncated: start > 0 };
    }
    finally {
        fs.closeSync(fd);
    }
}
export function taskPhase(records) {
    let phase = 'connected';
    for (const record of records) {
        if (record.type !== 'event_msg')
            continue;
        const type = record.payload?.type;
        if (type === 'task_started')
            phase = 'running';
        if (['task_complete', 'task_failed', 'turn_aborted', 'shutdown_complete'].includes(type))
            phase = 'connected';
    }
    return phase;
}
export function conversationMessages(records) {
    const messages = [];
    for (const record of records) {
        const payload = record.payload;
        if (record.type !== 'response_item' || payload?.type !== 'message' ||
            !['user', 'assistant'].includes(payload.role) || !Array.isArray(payload.content))
            continue;
        const content = payload.content.filter((item) => ['input_text', 'output_text', 'text'].includes(item?.type) && typeof item.text === 'string');
        const body = text(content.map((item) => item.text).join('\n'), 12_000);
        if (body)
            messages.push({ role: payload.role, text: body, timestamp: text(record.timestamp, 40) || undefined });
    }
    return messages.slice(-60);
}
export class CodexLibrary {
    sources;
    probe;
    lifecycle = new Map();
    constructor(sources = defaultCodexSources(), probe = () => liveCodexRollouts(new Map())) {
        this.sources = sources;
        this.probe = probe;
    }
    /** Follow only lifecycle metadata. A long turn must not lose its start event
     * merely because it fell outside the transcript's bounded tail. */
    livePhase(file, owner) {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const info = fs.fstatSync(fd);
            if (!info.isFile() || info.uid !== owner || info.nlink !== 1)
                throw Error('unavailable');
            let saved = this.lifecycle.get(file);
            if (!saved || saved.dev !== info.dev || saved.ino !== info.ino || saved.offset > info.size)
                saved = { dev: info.dev, ino: info.ino, offset: 0, pending: '', phase: 'connected' };
            const end = Math.min(info.size, saved.offset + 4 * 1024 * 1024);
            const buffer = Buffer.alloc(256 * 1024);
            while (saved.offset < end) {
                const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - saved.offset), saved.offset);
                if (!count)
                    break;
                saved.offset += count;
                const lines = (saved.pending + buffer.subarray(0, count).toString('utf8')).split('\n');
                saved.pending = lines.pop() || '';
                for (const line of lines) {
                    if (!line.includes('"event_msg"'))
                        continue;
                    try {
                        const record = JSON.parse(line);
                        if (record.type === 'event_msg') {
                            const event = record.payload?.type;
                            if (event === 'task_started')
                                saved.phase = 'running';
                            if (['task_complete', 'task_failed', 'turn_aborted', 'shutdown_complete'].includes(event))
                                saved.phase = 'connected';
                        }
                    }
                    catch { /* partial/unknown metadata is not a status signal */ }
                }
                if (saved.pending.length > 1024 * 1024)
                    saved.pending = '';
            }
            this.lifecycle.set(file, saved);
            return saved.offset >= info.size ? saved.phase : 'connected';
        }
        finally {
            fs.closeSync(fd);
        }
    }
    indexed(source, read) {
        const home = fs.realpathSync(source.home);
        const candidates = fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
            .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
        if (!candidates.length)
            throw Error('unavailable');
        const file = path.join(home, candidates[0]);
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.nlink !== 1 || info.uid !== fs.statSync(home).uid)
            throw Error('unavailable');
        const db = new DatabaseSync(file, { readOnly: true });
        try {
            db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200');
            const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(c => c.name));
            if (!['id', 'rollout_path', 'cwd', 'title', 'source', 'archived'].every(c => columns.has(c)))
                throw Error('unavailable');
            return read(db, columns, info.uid);
        }
        finally {
            db.close();
        }
    }
    projection(columns) {
        const updated = columns.has('updated_at_ms') ? 'COALESCE(updated_at_ms, updated_at * 1000)' : 'updated_at * 1000';
        const title = columns.has('name') ? "COALESCE(NULLIF(name, ''), title)" : 'title';
        return `id, ${title} AS title, cwd, rollout_path, source, ${columns.has('originator') ? 'originator' : "''"} AS originator, ${updated} AS updated, archived`;
    }
    task(row, source, owner, live) {
        let status = live.complete && !live.entries.some(entry => entry.file === row.rollout_path)
            ? 'history' : 'unknown';
        let terminal;
        try {
            const file = safeRollout(source.home, row.rollout_path, owner);
            const attached = live.entries.filter(entry => entry.file === file);
            if (attached.length) {
                status = this.livePhase(file, owner);
                terminal = attached.find(entry => entry.terminal)?.terminal;
            }
        }
        catch { /* an index may precede rollout creation or refer to a retired file */ }
        return { id: row.id, sourceId: source.id, title: text(row.title, 240) || '無題のCodex',
            cwd: text(row.cwd, 2000), updatedAt: Number(row.updated), kind: codexKind(row.source, row.originator || ''),
            archived: Boolean(row.archived), status, terminal,
            ...(!row.archived && !['running', 'connected', 'unknown'].includes(status) && source.id === 'current'
                ? { resumeCommand: `env CODEX_HOME=${quote(source.home)} /usr/lib/chatgpt/resources/codex resume ${quote(row.id)} --no-alt-screen${path.isAbsolute(row.cwd) ? ' --cd ' + quote(row.cwd) : ''}` } : {}) };
    }
    list(search = '', offset = 0, limit = 50) {
        if (!Number.isInteger(offset) || offset < 0 || offset > 5000 || !Number.isInteger(limit) || limit < 1 || limit > 100)
            throw Error('invalid_page');
        const live = this.probe();
        const liveFiles = new Set(live.entries.map(entry => entry.file));
        for (const file of this.lifecycle.keys())
            if (!liveFiles.has(file))
                this.lifecycle.delete(file);
        const tasks = [];
        const sources = this.sources.map(source => {
            try {
                const rows = this.indexed(source, (db, columns, owner) => {
                    const title = columns.has('name') ? "COALESCE(NULLIF(name, ''), title)" : 'title';
                    const query = db.prepare(`SELECT ${this.projection(columns)} FROM threads WHERE ${title} LIKE ? ESCAPE '\\' ORDER BY updated DESC, id ASC LIMIT ?`);
                    const pattern = '%' + search.slice(0, 200).replace(/[\\%_]/g, '\\$&') + '%';
                    const recent = query.all(pattern, offset + limit + 1);
                    const files = [...liveFiles].slice(0, 500);
                    const opened = files.length ? db.prepare(`SELECT ${this.projection(columns)} FROM threads WHERE ${title} LIKE ? ESCAPE '\\' AND rollout_path IN (${files.map(() => '?').join(',')})`).all(pattern, ...files) : [];
                    const rows = new Map([...recent, ...opened].map(row => [row.id, row]));
                    return { owner, rows: [...rows.values()] };
                });
                for (const row of rows.rows)
                    if (UUID.test(row.id))
                        tasks.push({ row, source, owner: rows.owner });
                return { id: source.id, label: source.label, available: true };
            }
            catch {
                return { id: source.id, label: source.label, available: false };
            }
        });
        tasks.sort((a, b) => Number(liveFiles.has(b.row.rollout_path)) - Number(liveFiles.has(a.row.rollout_path)) || Number(b.row.updated) - Number(a.row.updated) ||
            (a.source.id + a.row.id).localeCompare(b.source.id + b.row.id));
        return { tasks: tasks.slice(offset, offset + limit).map(item => this.task(item.row, item.source, item.owner, live)),
            sources, nextOffset: tasks.length > offset + limit && offset + limit <= 5000 ? offset + limit : null, liveStatusComplete: live.complete };
    }
    read(sourceId, id) {
        const source = this.sources.find(item => item.id === sourceId);
        if (!source || !UUID.test(id))
            throw Error('not_found');
        return this.indexed(source, (db, columns, owner) => {
            const row = db.prepare(`SELECT ${this.projection(columns)} FROM threads WHERE id=?`).get(id);
            if (!row)
                throw Error('not_found');
            const file = safeRollout(source.home, row.rollout_path, owner);
            const tail = rolloutTail(file, 2 * 1024 * 1024, owner);
            const messages = conversationMessages(tail.records);
            return { task: this.task(row, source, owner, this.probe()), messages,
                truncated: tail.truncated || messages.length === 60 };
        });
    }
}
