import fs from 'node:fs';
import path from 'node:path';
function identity(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/);
        if (['Z', 'X'].includes(fields[0]))
            return null;
        return { pid, parent: Number(fields[1]), start: fields[19], uid: fs.statSync(`/proc/${pid}`).uid };
    }
    catch {
        return null;
    }
}
// Inspect only the executable/script slots of Node's command line, never a
// prompt, later arguments or environment. Native installations need comm only.
function knownProgram(pid, comm) {
    if (['codex', 'claude', 'claude-code'].includes(comm))
        return true;
    if (comm !== 'node')
        return false;
    const fd = fs.openSync(`/proc/${pid}/cmdline`, 'r');
    try {
        const chunks = [];
        let nulls = 0, bytes = 0;
        while (nulls < 2 && bytes < 4096) {
            const buffer = Buffer.alloc(128);
            const count = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!count)
                break;
            for (let i = 0; i < count; i++)
                if (buffer[i] === 0 && ++nulls === 2) {
                    chunks.push(buffer.subarray(0, i + 1));
                    bytes += i + 1;
                    break;
                }
            if (nulls < 2) {
                chunks.push(buffer.subarray(0, count));
                bytes += count;
            }
        }
        const script = Buffer.concat(chunks).toString('utf8').split('\0')[1] || '';
        return /(?:^|\/)@anthropic-ai\/claude-code\/cli\.js$/.test(script);
    }
    finally {
        fs.closeSync(fd);
    }
}
export function liveAgentRollouts(terminals) {
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
    for (const value of pids) {
        const pid = Number(value);
        try {
            const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
            if (!knownProgram(pid, comm))
                continue;
            const saved = identity(pid);
            if (!saved)
                continue;
            const ancestors = new Set();
            let cursor = saved;
            for (let i = 0; cursor && cursor.pid > 1 && i < 32; i++) {
                ancestors.add(cursor.pid);
                cursor = identity(cursor.parent);
            }
            const attached = [...terminals.values()].find(t => t.available && ancestors.has(t.tmux.pid));
            const terminal = attached ? { id: attached.id, deckId: attached.deckId } : undefined;
            const files = new Set();
            for (const descriptor of fs.readdirSync(`/proc/${pid}/fd`)) {
                try {
                    const file = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`);
                    if (path.isAbsolute(file) && /^(?:rollout-.*|[0-9a-f-]{36})\.jsonl$/i.test(path.basename(file)))
                        files.add(file);
                }
                catch { /* closed descriptor */ }
            }
            const now = identity(pid);
            // Some CLI builds open their transcript only during writes. An invisible
            // log handle is not evidence that every saved task has stopped.
            if (!files.size && now)
                complete = false;
            if (now && now.uid === saved.uid && now.start === saved.start)
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
