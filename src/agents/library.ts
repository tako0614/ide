import { CodexLibrary, defaultCodexSources } from '../codex/library.js';
import { ClaudeLibrary, defaultClaudeSources } from './claude.js';
import { OpenCodeLibrary } from './opencode.js';
const tools = ['codex', 'claude', 'opencode'];
export class AgentLibrary {
    adapters;
    constructor(probe, adapters?) {
        if (adapters) {
            this.adapters = adapters;
            return;
        }
        let last = 0;
        let snapshot;
        const sharedProbe = () => { if (!snapshot || Date.now() - last > 1000) {
            snapshot = probe();
            last = Date.now();
        } return snapshot; };
        const codex = new CodexLibrary(defaultCodexSources(), sharedProbe);
        this.adapters = {
            codex: { list: (search, limit) => {
                    const tasks = [];
                    let value;
                    const requested = Math.min(limit, 5100);
                    for (let offset = 0; offset < requested; offset += 100) {
                        value = codex.list(search, offset, Math.min(100, requested - offset));
                        tasks.push(...value.tasks.map(task => ({ ...task, tool: 'codex' })));
                        if (value.nextOffset === null)
                            break;
                    }
                    return { ...value, tasks, sources: value.sources.map(source => ({ ...source, tool: 'codex' })), more: value.nextOffset !== null };
                }, read: (source, id) => { const value = codex.read(source, id); return { ...value, task: { ...value.task, tool: 'codex' } }; } },
            claude: new ClaudeLibrary(defaultClaudeSources(), sharedProbe), opencode: new OpenCodeLibrary(),
        };
    }
    async list(search = '', offset = 0, limit = 50, tool) {
        if (!Number.isInteger(offset) || offset < 0 || offset > 5000 || !Number.isInteger(limit) || limit < 1 || limit > 100 || tool && !tools.includes(tool))
            throw Error('invalid_page');
        const selected = tool ? [tool] : tools;
        const values = await Promise.all(selected.map(name => this.adapters[name].list(search.slice(0, 200), offset + limit + 1)));
        const tasks = values.flatMap(value => value.tasks);
        tasks.sort((a, b) => Number(['running', 'connected'].includes(b.status)) - Number(['running', 'connected'].includes(a.status)) || b.updatedAt - a.updatedAt ||
            `${a.tool}/${a.sourceId}/${a.id}`.localeCompare(`${b.tool}/${b.sourceId}/${b.id}`));
        return { tasks: tasks.slice(offset, offset + limit), sources: values.flatMap(value => value.sources),
            nextOffset: offset + limit <= 5000 && (tasks.length > offset + limit || values.some(value => value.more)) ? offset + limit : null,
            liveStatusComplete: values.every(value => value.liveStatusComplete) };
    }
    async read(tool, sourceId, id) {
        if (!tools.includes(tool))
            throw Error('not_found');
        return this.adapters[tool].read(sourceId, id);
    }
}
