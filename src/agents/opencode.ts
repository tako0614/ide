const ID = /^ses[_a-zA-Z0-9-]{1,128}$/;
const clean = (value, maximum = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum) : '';
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
export function openCodeUrl(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !['http:', 'https:'].includes(url.protocol) || url.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw Error('invalid_server');
    return url;
}
export class OpenCodeLibrary {
    request;
    credentials;
    url;
    constructor(url = process.env.DECKIDE_OPENCODE_URL || 'http://127.0.0.1:4096', request = fetch, credentials = { username: process.env.OPENCODE_SERVER_USERNAME || 'opencode', password: process.env.OPENCODE_SERVER_PASSWORD || '' }) {
        this.request = request;
        this.credentials = credentials;
        try {
            this.url = openCodeUrl(url);
        }
        catch {
            this.url = null;
        }
    }
    async get(route) {
        if (!this.url)
            throw Error('unavailable');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1800);
        try {
            const response = await this.request(new URL(route, this.url), { method: 'GET', redirect: 'error', signal: controller.signal,
                headers: { Accept: 'application/json', ...(this.credentials.password ? {
                        Authorization: 'Basic ' + Buffer.from(this.credentials.username + ':' + this.credentials.password).toString('base64')
                    } : {}) } });
            if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('application/json'))
                throw Error('unavailable');
            const reader = response.body.getReader();
            const chunks = [];
            let total = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done)
                        break;
                    total += value.length;
                    if (total > 2 * 1024 * 1024)
                        throw Error('unavailable');
                    chunks.push(value);
                }
            }
            finally {
                await reader.cancel().catch(() => undefined);
            }
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        finally {
            clearTimeout(timer);
        }
    }
    task(value, states) {
        if (!ID.test(value?.id))
            throw Error('not_found');
        const cwd = clean(value.directory, 2000);
        const state = states?.[value.id]?.type;
        return { tool: 'opencode', id: value.id, sourceId: 'server', title: clean(value.title) || 'OpenCode', cwd,
            updatedAt: Number(value.time?.updated || value.time?.created || 0), kind: 'other', archived: Boolean(value.time?.archived),
            status: ['busy', 'retry'].includes(state) ? 'running' : state === 'idle' ? 'connected' : states ? 'history' : 'unknown',
            ...(!value.time?.archived ? { resumeCommand: `opencode attach ${quote(this.url.origin)} --session ${quote(value.id)}${cwd.startsWith('/') ? ' --dir ' + quote(cwd) : ''}` } : {}) };
    }
    async list(search = '', limit = 101) {
        try {
            const [sessions, states] = await Promise.all([this.get(`/session?global=true&limit=${Math.min(limit, 5101)}${search ? '&search=' + encodeURIComponent(search) : ''}`),
                this.get('/session/status').then(value => value && typeof value === 'object' && !Array.isArray(value) ? value : null).catch(() => null)]);
            if (!Array.isArray(sessions))
                throw Error('unavailable');
            const tasks = sessions.flatMap(value => { try {
                return [this.task(value, states)];
            }
            catch {
                return [];
            } })
                .filter(task => task.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
            return { tasks, sources: [{ id: 'server', label: 'OpenCodeサーバー', tool: 'opencode', available: true }], liveStatusComplete: Boolean(states && typeof states === 'object' && !Array.isArray(states)), more: sessions.length >= limit };
        }
        catch {
            return { tasks: [], sources: [{ id: 'server', label: 'OpenCodeサーバー', tool: 'opencode', available: false }], liveStatusComplete: false };
        }
    }
    async read(sourceId, id) {
        if (sourceId !== 'server' || !ID.test(id))
            throw Error('not_found');
        const [session, states] = await Promise.all([this.get('/session/' + id), this.get('/session/status').then(value => value && typeof value === 'object' && !Array.isArray(value) ? value : null).catch(() => null)]);
        if (session?.id !== id)
            throw Error('not_found');
        const task = this.task(session, states);
        const values = await this.get(`/session/${id}/message?limit=60${task.cwd ? '&directory=' + encodeURIComponent(task.cwd) : ''}`);
        if (!Array.isArray(values))
            throw Error('unavailable');
        const messages = values.flatMap(value => {
            const role = value.info?.role;
            if (!['user', 'assistant'].includes(role) || !Array.isArray(value.parts))
                return [];
            const text = clean(value.parts.filter((part) => part?.type === 'text' && !part.synthetic && !part.ignored)
                .map((part) => clean(part.text, 12000)).join('\n'), 12000);
            return text ? [{ role, text }] : [];
        }).slice(-60);
        return { task, messages, truncated: values.length >= 60 };
    }
}
