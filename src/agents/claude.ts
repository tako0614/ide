import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (value, maximum = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum) : '';
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
export function defaultClaudeSources() {
    const current = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
    return [{ id: 'current', label: 'Claude Code', home: current }, ...(current !== '/var/lib/chatgpt-app/.claude'
            ? [{ id: 'legacy', label: '旧Claude Code', home: '/var/lib/chatgpt-app/.claude' }] : [])];
}
function directory(file, owner?) {
    const info = fs.lstatSync(file);
    if (!info.isDirectory() || info.isSymbolicLink() || owner !== undefined && info.uid !== owner)
        throw Error('unavailable');
    return info.uid;
}
function records(entry, bytes, head = false) {
    const fd = fs.openSync(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.uid !== entry.owner || info.size > 256 * 1024 * 1024)
            throw Error('unavailable');
        const start = head ? 0 : Math.max(0, info.size - bytes);
        const buffer = Buffer.alloc(Math.min(bytes, info.size));
        const count = fs.readSync(fd, buffer, 0, buffer.length, start);
        const lines = buffer.subarray(0, count).toString('utf8').split('\n');
        if (start)
            lines.shift();
        const values = lines.flatMap(line => { try {
            const value = JSON.parse(line);
            return value && typeof value === 'object' ? [value] : [];
        }
        catch {
            return [];
        } });
        return { values, truncated: info.size > bytes };
    }
    finally {
        fs.closeSync(fd);
    }
}
export function claudeMessages(values) {
    return values.flatMap(value => {
        if (!['user', 'assistant'].includes(value?.type) || value.isMeta || value.isSidechain)
            return [];
        const content = value.message?.content;
        const text = clean(typeof content === 'string' ? content : Array.isArray(content)
            ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '', 12000);
        return text ? [{ role: value.type, text, timestamp: clean(value.timestamp, 40) || undefined }] : [];
    }).slice(-60);
}
export class ClaudeLibrary {
    sources;
    probe;
    cache = new Map();
    constructor(sources = defaultClaudeSources(), probe?) {
        this.sources = sources;
        this.probe = probe;
    }
    entries(source) {
        const owner = directory(source.home);
        const home = fs.realpathSync(source.home);
        directory(home, owner);
        const projects = path.join(home, 'projects');
        directory(projects, owner);
        const entries = [];
        for (const project of fs.readdirSync(projects).slice(0, 5000)) {
            const folder = path.join(projects, project);
            try {
                directory(folder, owner);
            }
            catch {
                continue;
            }
            const sourceId = source.id + '~' + crypto.createHash('sha256').update(project).digest('hex').slice(0, 16);
            for (const name of fs.readdirSync(folder)) {
                const id = name.slice(0, -6);
                if (!name.endsWith('.jsonl') || !UUID.test(id))
                    continue;
                const file = path.join(folder, name);
                const info = fs.lstatSync(file);
                if (info.isFile() && info.uid === owner && info.nlink === 1)
                    entries.push({ file, id, sourceId, owner, home: source.home, updated: info.mtimeMs });
            }
        }
        return entries;
    }
    task(entry, live) {
        const info = fs.lstatSync(entry.file);
        if (!info.isFile() || info.nlink !== 1 || info.uid !== entry.owner)
            throw Error('unavailable');
        const stamp = `${info.dev}/${info.ino}/${info.size}/${info.mtimeMs}`;
        let saved = this.cache.get(entry.file);
        if (!saved || saved.stamp !== stamp) {
            saved = { stamp, head: records(entry, 64 * 1024, true).values, tail: records(entry, 64 * 1024).values };
            if (this.cache.size >= 1000)
                this.cache.delete(this.cache.keys().next().value);
            this.cache.set(entry.file, saved);
        }
        const { head, tail } = saved;
        const values = [...head, ...tail];
        const lastTitle = [...values].reverse().find(value => typeof value.customTitle === 'string' || value.type === 'summary' && typeof value.summary === 'string');
        const first = claudeMessages(head).find(message => message.role === 'user');
        const cwd = clean(values.find(value => path.isAbsolute(value.cwd || ''))?.cwd, 2000);
        const attached = live.entries.filter(value => value.file === entry.file);
        let status = attached.length ? 'connected' : live.complete ? 'history' : 'unknown';
        // A live process plus an unfinished user turn/tool request is positive
        // evidence. Unknown log forms remain connected rather than inventing work.
        if (attached.length)
            for (const value of tail) {
                if (value.isMeta || value.isSidechain)
                    continue;
                if (value.type === 'user' && !value.isMeta && claudeMessages([value]).length)
                    status = 'running';
                if (value.type === 'assistant' && value.message?.stop_reason === 'tool_use')
                    status = 'running';
                if (value.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(value.message?.stop_reason) ||
                    value.type === 'system' && value.subtype === 'turn_duration')
                    status = 'connected';
            }
        return { tool: 'claude', id: entry.id, sourceId: entry.sourceId,
            title: clean(lastTitle?.customTitle || lastTitle?.summary || first?.text) || 'Claude Code', cwd, updatedAt: entry.updated,
            kind: 'cli', archived: false, status, terminal: attached.find(item => item.terminal)?.terminal,
            ...(status === 'history' && entry.sourceId.startsWith('current~') ? { resumeCommand: `${cwd ? 'cd -- ' + quote(cwd) + ' && ' : ''}env CLAUDE_CONFIG_DIR=${quote(entry.home)} claude --resume ${quote(entry.id)}` } : {}) };
    }
    list(search = '', limit = 101) {
        const live = this.probe();
        const tasks = [];
        const sources = this.sources.map(source => {
            try {
                const entries = this.entries(source).sort((a, b) => Number(live.entries.some(item => item.file === b.file)) - Number(live.entries.some(item => item.file === a.file)) || b.updated - a.updated);
                // Only titles/cwd plus bounded transcript fragments; never settings,
                // credentials or tool-result files. Broken logs do not hide other tasks.
                for (const entry of entries) {
                    try {
                        const task = this.task(entry, live);
                        if (task.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
                            tasks.push(task);
                    }
                    catch { /* unreadable/transient file */ }
                    if (tasks.filter(task => task.sourceId.startsWith(source.id + '~')).length >= limit)
                        break;
                }
                return { id: source.id, label: source.label, tool: 'claude', available: true };
            }
            catch {
                return { id: source.id, label: source.label, tool: 'claude', available: false };
            }
        });
        return { tasks, sources, liveStatusComplete: live.complete };
    }
    read(sourceId, id) {
        if (!UUID.test(id))
            throw Error('not_found');
        const source = this.sources.find(source => sourceId.startsWith(source.id + '~'));
        if (!source)
            throw Error('not_found');
        const entry = this.entries(source).find(entry => entry.sourceId === sourceId && entry.id === id);
        if (!entry)
            throw Error('not_found');
        const tail = records(entry, 2 * 1024 * 1024);
        const messages = claudeMessages(tail.values);
        return { task: this.task(entry, this.probe()), messages, truncated: tail.truncated || messages.length === 60 };
    }
}
