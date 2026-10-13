import path from 'node:path';
import fs from 'node:fs';
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
export function agentShellCommand(tool, args) {
    if (!['codex', 'claude', 'opencode'].includes(String(tool)) || !Array.isArray(args) || args.length > 100 ||
        args.some(item => typeof item !== 'string' || item.includes('\0') || Buffer.byteLength(item) > 8192))
        throw Error('invalid_command');
    const result = [String(tool), ...args].map(quote).join(' ');
    if (Buffer.byteLength(result) > 32 * 1024)
        throw Error('invalid_command');
    return result;
}
/** The deck named by args.deckId, or the deck for directory args.cwd (registered on first use). */
async function resolveDeck(options, args) {
    if (typeof args.deckId === 'string' && args.deckId)
        return args.deckId;
    if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd))
        throw Error('invalid_directory');
    const cwd = fs.realpathSync(args.cwd);
    if (!fs.statSync(cwd).isDirectory())
        throw Error('invalid_directory');
    const workspaces = await options.api('/api/workspaces');
    let workspace = workspaces.find((workspace) => workspace.path === cwd);
    if (!workspace)
        workspace = await options.api('/api/workspaces', 'POST', { path: cwd, name: path.basename(cwd) || 'root' });
    const decks = await options.api('/api/decks');
    let deck = decks.find((deck) => deck.workspaceId === workspace.id);
    if (!deck)
        deck = await options.api('/api/decks', 'POST', { workspaceId: workspace.id, name: workspace.name });
    return deck.id;
}
export function createLocalControl(options) {
    return async (request) => {
        const args = request.args || {};
        if (request.method === 'status')
            return { pid: process.pid, uid: process.getuid?.(), sharedTerminals: true };
        if (request.method === 'decks.list')
            return options.api('/api/decks');
        if (request.method === 'agents.list')
            return options.agents.list(String(args.search || ''), Number(args.offset || 0), Number(args.limit || 100), args.tool);
        if (request.method === 'agents.read')
            return options.agents.read(String(args.tool), String(args.sourceId), String(args.id));
        if (request.method === 'terminals.list') {
            // One list call: each one re-verifies the terminal registry.
            const terminals = await options.api(typeof args.deckId === 'string'
                ? '/api/terminals?deckId=' + encodeURIComponent(args.deckId) : '/api/terminals');
            return terminals.map((terminal) => ({ id: terminal.id, deckId: terminal.deckId, title: terminal.title, createdAt: terminal.createdAt, cols: terminal.cols, rows: terminal.rows, available: terminal.available }));
        }
        if (request.method === 'terminals.attach') {
            if (typeof args.id !== 'string' || args.readOnly !== undefined && typeof args.readOnly !== 'boolean')
                throw Error('invalid_request');
            if (args.cols !== undefined || args.rows !== undefined) {
                if (args.readOnly)
                    throw Error('read_only');
                await options.api('/api/terminals/' + encodeURIComponent(args.id) + '/size', 'PUT', { cols: args.cols, rows: args.rows });
            }
            return options.attachment(args.id, args.readOnly === true);
        }
        if (request.method === 'terminals.resize') {
            // The CLI client in use asks for its tty size ("the last client used drives the size").
            if (typeof args.id !== 'string' || !Number.isInteger(args.cols) || !Number.isInteger(args.rows))
                throw Error('invalid_request');
            return options.api('/api/terminals/' + encodeURIComponent(args.id) + '/size', 'PUT', { cols: args.cols, rows: args.rows });
        }
        if (request.method === 'terminals.create') {
            // A plain shell (or command) terminal, in a deck or for a directory.
            const deckId = await resolveDeck(options, args);
            if (args.command !== undefined && (typeof args.command !== 'string' || args.command.length > 32 * 1024))
                throw Error('invalid_command');
            const terminal = await options.api('/api/terminals', 'POST', { deckId, title: typeof args.title === 'string' ? args.title : undefined,
                command: args.command, cols: args.cols, rows: args.rows });
            return { id: terminal.id, deckId, title: terminal.title, cols: terminal.cols, rows: terminal.rows };
        }
        if (request.method === 'terminals.input') {
            if (typeof args.id !== 'string' || typeof args.data !== 'string')
                throw Error('invalid_request');
            return options.api('/api/terminals/' + encodeURIComponent(args.id) + '/input', 'POST', { data: args.data });
        }
        if (request.method === 'terminals.focus') {
            if (typeof args.id !== 'string')
                throw Error('invalid_request');
            return options.api('/api/terminals/' + encodeURIComponent(args.id) + '/focus', 'POST', {});
        }
        if (request.method === 'terminals.delete') {
            if (typeof args.id !== 'string')
                throw Error('invalid_request');
            await options.api('/api/terminals/' + encodeURIComponent(args.id), 'DELETE');
            return { id: args.id, deleted: true };
        }
        if (request.method === 'terminals.run') {
            const command = agentShellCommand(args.tool, args.argv || []);
            const deckId = await resolveDeck(options, args);
            const terminal = await options.api('/api/terminals', 'POST', { deckId, title: String(args.tool), command, cols: args.cols, rows: args.rows });
            return { id: terminal.id, deckId, title: terminal.title, cols: terminal.cols, rows: terminal.rows };
        }
        throw Error('unknown_method');
    };
}
