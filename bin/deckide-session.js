import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export function sessionSocket(env = process.env) {
  return path.resolve(env.DECKIDE_SESSION_SOCKET || path.join(env.DECKIDE_DATA_DIR || path.join(os.homedir(), '.deckide'), 'cli', 'control.sock'));
}
export function sessionRpc(method, args = {}, socketPath = sessionSocket()) {
  const parent = fs.lstatSync(path.dirname(socketPath));
  const socket = fs.lstatSync(socketPath);
  const uid = process.getuid();
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || parent.mode & 0o077 ||
      !socket.isSocket() || socket.uid !== uid || socket.mode & 0o077) throw Error('unsafe_socket');
  const data = JSON.stringify({ method, args }) + '\n';
  if (Buffer.byteLength(data) > 64 * 1024) throw Error('request_too_large');
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath); let pending = '', bytes = 0, done = false;
    const fail = () => { if (!done) { done = true; client.destroy(); reject(Error('session_unavailable')); } };
    client.setEncoding('utf8'); client.setTimeout(12000, fail); client.once('error', fail);
    client.once('connect', () => client.write(data));
    client.on('data', chunk => {
      bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) return fail();
      pending += chunk; if (!pending.includes('\n')) return;
      try { const result = JSON.parse(pending.slice(0, pending.indexOf('\n')));
        if (!result.ok) return fail();
        done = true; client.destroy(); resolve(result.value);
      } catch { fail(); }
    });
    client.once('end', () => { if (!done) fail(); });
  });
}
export function parseSessionArgs(argv) {
  const action = argv[0] || 'help'; const args = {}; const positionals = [];
  for (let index = 1; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (item === '--read-only' || item === '--fit' || item === '--json' || item === '--no-enter') { args[item.slice(2)] = true; continue; }
    if (['--deck', '--cwd', '--tool', '--search', '--offset', '--limit', '--title', '--lines'].includes(item)) {
      if (!argv[index + 1]) throw Error('missing_option'); args[item.slice(2)] = argv[++index]; continue;
    }
    if (item.startsWith('-')) throw Error('unknown_option');
    positionals.push(item);
  }
  if (action === 'run' && (!['codex', 'claude', 'opencode'].includes(positionals[0]) || args['read-only'])) throw Error('invalid_tool');
  if (action === 'attach' && (positionals.length !== 1 || args['read-only'] && args.fit)) throw Error('invalid_attach');
  if (action === 'read' && positionals.length !== 3) throw Error('invalid_read');
  if ((action === 'send' && positionals.length < 2) || (['kill', 'show', 'focus'].includes(action) && positionals.length !== 1)) throw Error('invalid_terminal');
  if (['move', 'rename'].includes(action) && (positionals.length !== 2 || Object.keys(args).length)) throw Error('invalid_terminal');
  if (action === 'rename' && !positionals[1].trim()) throw Error('invalid_title');
  if (action === 'move' && !positionals[1]) throw Error('invalid_deck');
  if (args.lines !== undefined && !(/^\d{1,5}$/.test(args.lines))) throw Error('invalid_lines');
  return { action, args, positionals };
}

export function parseDeckArgs(argv) {
  const action = argv[0] || 'help';
  const rest = argv.slice(1);
  let json = false;
  const positionals = [];
  for (const item of rest) {
    if (item === '--json') {
      if (json) throw Error('invalid_deck_arguments');
      json = true;
    } else if (item.startsWith('-')) throw Error('unknown_option');
    else positionals.push(item);
  }
  if (action === 'list' && positionals.length !== 0) throw Error('invalid_deck_arguments');
  if (action === 'rename' && (positionals.length !== 2 || !positionals[1].trim() || json)) throw Error('invalid_deck_arguments');
  if (action === 'delete' && (positionals.length !== 1 || json)) throw Error('invalid_deck_arguments');
  if (!['help', '--help', '-h', 'list', 'rename', 'delete'].includes(action)) throw Error('unknown_action');
  if (['help', '--help', '-h'].includes(action) && (positionals.length || json)) throw Error('invalid_deck_arguments');
  return { action, json, positionals };
}
export async function attachNative(value, readOnly = false) {
  const { TmuxTerminalAdapter } = await import('../dist/terminal/tmuxAdapter.js');
  const adapter = new TmuxTerminalAdapter({ runtimeDir: path.dirname(value.meta.socketPath) });
  // Recheck the registry, actual server/session/pane and random generation
  // immediately before attaching. -N never creates a replacement tmux server.
  const fresh = adapter.nativeAttachment(value.id, readOnly);
  if (fresh.meta.generation !== value.meta.generation || fresh.meta.serverPid !== value.meta.serverPid ||
      fresh.meta.pid !== value.meta.pid) throw Error('terminal_generation_changed');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('terminal_required');
  const env = { ...process.env }; delete env.TMUX;
  if (!env.TERM || env.TERM === 'dumb') env.TERM = 'xterm-256color';
  const child = spawn(fresh.binary, fresh.args, { stdio: 'inherit', env });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  process.exitCode = exitCode;
}
// Replies a terminal emulator writes to stdin on its own (cursor position,
// device attributes, colour queries, focus/mouse reports). They are not the
// user typing, so they must not take the shared size.
const TERMINAL_REPORT = new RegExp('^(?:' + [
  '\\x1b\\[\\??\\d+;\\d+R', '\\x1b\\[[?>=][\\d;]*c', '\\x1b\\[\\??[\\d;]*\\$y',
  '\\x1b\\][\\d;]*[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', '\\x1bP[\\s\\S]*?\\x1b\\\\', '\\x1b\\[[IO]',
  '\\x1b\\[\\?[\\d;]*u', '\\x1b\\[\\d+;\\d+;\\d+t', '\\x1b\\[<\\d+;\\d+;\\d+[Mm]', '\\x1b\\[M[\\s\\S]{3}',
].join('|') + ')+$');
export function isTerminalReport(text) { return TERMINAL_REPORT.test(text); }

/**
 * Attach to a shared terminal and follow it: the last client used (Web or
 * CLI) decides its size. A native tmux client runs on a local pty that this
 * process relays, so typing here or resizing this window asks DeckIDE to fit
 * the shared terminal to this tty. tmux renders every client itself, so a
 * view smaller than the shared size shows a part of it instead of tearing.
 */
export async function attachFollowing(value, claimSize) {
  const { TmuxTerminalAdapter } = await import('../dist/terminal/tmuxAdapter.js');
  const adapter = new TmuxTerminalAdapter({ runtimeDir: path.dirname(value.meta.socketPath) });
  const fresh = adapter.nativeAttachment(value.id, false);
  if (fresh.meta.generation !== value.meta.generation || fresh.meta.serverPid !== value.meta.serverPid ||
      fresh.meta.pid !== value.meta.pid) throw Error('terminal_generation_changed');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('terminal_required');
  const { default: pty } = await import('node-pty');
  const env = { ...process.env }; delete env.TMUX;
  if (!env.TERM || env.TERM === 'dumb') env.TERM = 'xterm-256color';
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const child = pty.spawn(fresh.binary, fresh.args, { name: env.TERM, ...size(), cwd: process.cwd(), env });
  let lastClaim = 0;
  let inFlight = false;
  const claim = () => {
    if (inFlight) return;
    inFlight = true;
    lastClaim = Date.now();
    const { cols, rows } = size();
    Promise.resolve(claimSize(cols, rows)).catch(() => undefined).finally(() => { inFlight = false; });
  };
  const decoder = new StringDecoder('utf8');
  const onInput = (chunk) => {
    child.write(decoder.write(chunk));
    // Re-assert at most once a second while typing; the backend ignores a
    // request for the size the terminal already has.
    if (Date.now() - lastClaim > 1000 && !isTerminalReport(chunk.toString('latin1'))) claim();
  };
  const onResize = () => {
    child.resize(size().cols, size().rows);
    claim();
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onInput);
  process.stdout.on('resize', onResize);
  child.onData((data) => process.stdout.write(data));
  claim();
  const exitCode = await new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode ?? 1)));
  process.stdin.off('data', onInput);
  process.stdout.off('resize', onResize);
  try { process.stdin.setRawMode(false); } catch { /* stdin closed */ }
  process.stdin.pause();
  process.exitCode = exitCode;
}

/** Terminal by id, unique id prefix (4+), number from `list`, or exact title. */
export async function resolveTerminalId(selector) {
  const terminals = await sessionRpc('terminals.list', {});
  const value = String(selector);
  if (/^\d+$/.test(value) && terminals[Number(value) - 1]) return terminals[Number(value) - 1].id;
  const exact = terminals.find((terminal) => terminal.id === value);
  if (exact) return exact.id;
  const prefixed = value.length >= 4 ? terminals.filter((terminal) => terminal.id.startsWith(value)) : [];
  if (prefixed.length === 1) return prefixed[0].id;
  const titled = terminals.filter((terminal) => terminal.title === value);
  if (titled.length === 1) return titled[0].id;
  throw Error('terminal_not_found');
}

const follow = (id) => (cols, rows) => sessionRpc('terminals.resize', { id, cols, rows });

/** The terminal's screen as plain text, plus `lines` of scrollback; never changes it or any view. */
export async function captureScreen(value, lines = 0) {
  const { execFile } = await import('node:child_process');
  const args = ['-S', value.meta.socketPath, '-N', 'capture-pane', '-p', '-J', '-t', `=${value.meta.sessionName}:`];
  if (lines > 0) args.push('-S', `-${lines}`);
  const text = await new Promise((resolve, reject) => execFile('tmux', args, { maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => (error ? reject(Error('capture_failed')) : resolve(stdout))));
  return text.replace(/\s+$/, '') + '\n';
}

export async function runSessionClient(argv) {
  const { action, args, positionals } = parseSessionArgs(argv);
  if (['help', '--help', '-h'].includes(action)) {
    console.log(`Usage:
  deckide session status
  deckide session list [--deck ID]
  deckide session history [--tool codex|claude|opencode] [--search TEXT] [--offset N] [--limit N]
  deckide session read TOOL SOURCE_ID SESSION_ID
  deckide session run [--deck ID | --cwd PATH] [--json] -- codex|claude|opencode [ARGS...]
  deckide session attach [--read-only] TERMINAL
  deckide session new [--deck ID | --cwd PATH] [--title T] [--json] [-- COMMAND...]
  deckide session send [--no-enter] TERMINAL TEXT...
  deckide session show [--lines N] TERMINAL
  deckide session focus TERMINAL
  deckide session kill TERMINAL
  deckide session move TERMINAL DECK_ID
  deckide session rename TERMINAL TITLE

CLI and Web/MCP use the same persistent terminal. Ctrl-b d detaches this
client and leaves the agent running. The client used last (typing, or
resizing its window) decides the shared size; other views show the same
grid. --read-only views without ever changing it. TERMINAL is an ID, a
unique ID prefix, the number from list, or a title.
run starts a new terminal; attach uses an existing one. show prints the
terminal's screen as text (with N lines of scrollback) and changes nothing;
focus brings the terminal to the front of every open web UI (only when a person
asked for it). read displays selected conversation text. Other output is JSON;
run attaches unless --json is supplied.
Use the backend's DECKIDE_DATA_DIR or DECKIDE_SESSION_SOCKET when customized.`); return;
  }
  let value;
  if (action === 'status') value = await sessionRpc('status');
  else if (action === 'list') value = await sessionRpc('terminals.list', { deckId: args.deck });
  else if (action === 'history') value = await sessionRpc('agents.list', { tool: args.tool, search: args.search,
    offset: args.offset === undefined ? 0 : Number(args.offset), limit: args.limit === undefined ? 50 : Number(args.limit) });
  else if (action === 'read') value = await sessionRpc('agents.read', { tool: positionals[0], sourceId: positionals[1], id: positionals[2] });
  else if (action === 'run' || action === 'new') {
    if (!args.json && (!process.stdin.isTTY || !process.stdout.isTTY)) throw Error('terminal_required');
    const shared = { deckId: args.deck, cwd: path.resolve(args.cwd || process.cwd()),
      cols: process.stdout.columns || 120, rows: process.stdout.rows || 32 };
    value = action === 'run'
      ? await sessionRpc('terminals.run', { ...shared, tool: positionals[0], argv: positionals.slice(1) })
      : await sessionRpc('terminals.create', { ...shared, title: args.title,
        command: positionals.length ? positionals.join(' ') : undefined });
    if (!args.json) { await attachFollowing(await sessionRpc('terminals.attach', { id: value.id }), follow(value.id)); return; }
  } else if (action === 'attach') {
    const readOnly = args['read-only'] === true;
    const id = await resolveTerminalId(positionals[0]);
    if (readOnly) { await attachNative(await sessionRpc('terminals.attach', { id, readOnly }), true); return; }
    await attachFollowing(await sessionRpc('terminals.attach', { id }), follow(id)); return;
  } else if (action === 'send') {
    const text = positionals.slice(1).join(' ');
    // Enter is CR, as a keyboard sends it (TUIs ignore a bare LF).
    value = await sessionRpc('terminals.input', { id: await resolveTerminalId(positionals[0]), data: args['no-enter'] ? text : text + '\r' });
  } else if (action === 'show') {
    const attachment = await sessionRpc('terminals.attach', { id: await resolveTerminalId(positionals[0]), readOnly: true });
    process.stdout.write(await captureScreen(attachment, Number(args.lines || 0)));
    return;
  } else if (action === 'focus') {
    value = await sessionRpc('terminals.focus', { id: await resolveTerminalId(positionals[0]) });
  } else if (action === 'kill') {
    value = await sessionRpc('terminals.delete', { id: await resolveTerminalId(positionals[0]) });
  } else if (action === 'move') {
    value = await sessionRpc('terminals.update', { id: await resolveTerminalId(positionals[0]), deckId: positionals[1] });
  } else if (action === 'rename') {
    value = await sessionRpc('terminals.update', { id: await resolveTerminalId(positionals[0]), title: positionals[1] });
  } else throw Error('unknown_action');
  console.log(JSON.stringify(value, null, 2));
}

/** Deck mutations select by ID or by a unique ID prefix of at least four characters. */
async function resolveDeckId(selector) {
  const decks = await sessionRpc('decks.list');
  const exact = decks.find((deck) => deck.id === selector);
  if (exact) return exact.id;
  const matches = selector.length >= 4 ? decks.filter((deck) => deck.id.startsWith(selector)) : [];
  if (matches.length === 1) return matches[0].id;
  throw Error(matches.length > 1 ? 'deck_ambiguous' : 'deck_not_found');
}

export async function runDeckClient(argv) {
  const { action, json, positionals } = parseDeckArgs(argv);
  if (['help', '--help', '-h'].includes(action)) {
    console.log(`Usage:
  deckide deck list [--json]
  deckide deck rename ID NAME
  deckide deck delete ID

Deck mutations accept a deck ID or a unique ID prefix of at least four characters.`);
    return;
  }
  if (action === 'list') {
    const decks = await sessionRpc('decks.list');
    if (json) console.log(JSON.stringify(decks, null, 2));
    else for (const deck of decks) console.log(`${deck.name}\t${deck.id}`);
    return;
  }
  const id = await resolveDeckId(positionals[0]);
  const value = action === 'rename'
    ? await sessionRpc('decks.rename', { id, name: positionals[1] })
    : await sessionRpc('decks.delete', { id });
  console.log(JSON.stringify(value, null, 2));
}
