// `deckide` subcommands that talk to a running server: list, create, attach to
// and drive terminals from a shell. Everything goes through the same HTTP/WS
// API the browser uses, so the web UI updates live (see /api/events).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const CLIENT_COMMANDS = new Set(['ls', 'list', 'open', 'new', 'attach', 'a', 'send', 'kill', 'show', 'events', 'resize', 'gui', 'session', 'deck']);

export const CLIENT_HELP = `
Terminals (talk to the running server; the web UI updates live):
  deckide ls [--json]            List workspaces, decks and terminals
  deckide open [dir] [opts]      Open dir (default: cwd) as a deck with a terminal
  deckide new [opts]             New terminal in the current deck
      -d, --deck <deck>          Deck id/name (default: this deck or the cwd's deck)
      -t, --title <title>        Terminal title
      -c, --command <cmd>        Run a command instead of a shell
      -a, --attach               Attach to it right away
      -s, --show                 Bring it to the front in open browsers
  deckide attach [terminal]      Use a terminal from this shell (detach: Ctrl+])
  deckide send <terminal> <text> Type text + Enter into a terminal (-n: no Enter,
                                 text "-" reads stdin)
  deckide show <terminal>        Bring a terminal to the front in open browsers
  deckide kill <terminal>        Close a terminal
  deckide resize <t> <cols> <rows>  Set the size for every client
  deckide session move <id> <deckId>  Move a terminal without interrupting its process
  deckide session rename <id> <title>  Change a terminal's saved title
  deckide deck list [--json]     List decks with their full IDs
  deckide deck delete <id>       Delete an empty deck (refuses remaining terminals)
  deckide deck rename <id> <name>  Change a deck's saved name
  deckide events                 Stream state changes as JSON lines

Desktop (one shared GUI desktop for the agent browser and your GUI apps;
open it from the ▣ button in the web UI):
  deckide gui                    Show the desktop and the apps you can launch
  deckide gui <app>              Launch an app by id or name (e.g. grok-bot)
  deckide gui -- <command...>    Run a command on the desktop (cwd: here)
  deckide gui --type <text>      Type text into the focused window
  eval "$(deckide gui --env)"    Point this shell's GUI programs at the desktop

  <terminal> is an id (or unique prefix), a title, or the number from "deckide ls".
  Inside a Deck IDE terminal, "deckide new" opens a sibling in the same deck.
  The size follows whichever client you used last (browser or CLI); the others
  mirror it at the same size, so full-screen programs never tear.
`;

// Ctrl+] — as a plain byte, or as the kitty keyboard protocol (CSI 93;5u)
// or xterm modifyOtherKeys (CSI 27;5;93~) encode it once a program running in
// the terminal has switched the local terminal into those modes.
const DETACH_KEY = /\x1d|\x1b\[93;5(?::[12])?u|\x1b\[27;5;93~/;

/** Index of the detach key in raw stdin text (latin1), or -1. */
export function findDetachKey(text) {
  const match = DETACH_KEY.exec(text);
  return match ? match.index : -1;
}

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

// ─── Connection ─────────────────────────────────────────────────

function readCliInfo(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'cli.json'), 'utf8'));
  } catch {
    return null;
  }
}

function hostForClient(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!h || h === '0.0.0.0' || h === '::' || h === 'localhost' || /^127\./.test(h) || h === '::1') return '127.0.0.1';
  return h.includes(':') ? `[${h}]` : h;
}

export function resolveConnection({ dataDir, settings }) {
  const info = readCliInfo(dataDir);
  const port = Number(info?.port) || Number(process.env.DECKIDE_PORT) || Number(settings.port) || 8787;
  const localBase = `http://${hostForClient(info?.host ?? settings.host)}:${port}`;
  if (process.env.DECKIDE_URL) {
    const base = process.env.DECKIDE_URL.replace(/\/+$/, '');
    // The local token only ever goes to the local server it was issued by;
    // any other server needs DECKIDE_TOKEN set explicitly.
    let sameServer = false;
    try {
      const url = new URL(base);
      sameServer = hostForClient(url.hostname) === '127.0.0.1' && Number(url.port || 80) === port;
    } catch { /* invalid URL: fetch reports it */ }
    return { base, token: process.env.DECKIDE_TOKEN || (sameServer ? info?.token : null) || null };
  }
  return { base: localBase, token: process.env.DECKIDE_TOKEN || info?.token || null };
}

async function api(conn, method, urlPath, body) {
  const headers = {};
  if (conn.token) headers.Authorization = `Bearer ${conn.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(conn.base + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`Deck IDE is not reachable at ${conn.base}. Start it with "deckide start".`);
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (response.status === 401) {
    fail('Not authorized. The CLI token in the data directory is missing or stale — ' +
      'restart the server ("deckide restart") or set DECKIDE_TOKEN.');
  }
  if (!response.ok) {
    fail(`${method} ${urlPath} failed (${response.status}): ${payload?.error || text || response.statusText}`);
  }
  return payload;
}

// ─── Lookup ─────────────────────────────────────────────────────

async function loadState(conn) {
  const [workspaces, decks, terminals] = await Promise.all([
    api(conn, 'GET', '/api/workspaces'),
    api(conn, 'GET', '/api/decks'),
    api(conn, 'GET', '/api/terminals'),
  ]);
  // Number terminals in display order (deck order, then creation).
  const ordered = [];
  for (const deck of decks) {
    for (const terminal of terminals.filter((t) => t.deckId === deck.id)) ordered.push(terminal);
  }
  ordered.forEach((terminal, index) => { terminal.index = index + 1; });
  return { workspaces, decks, terminals: ordered };
}

function displayTitle(terminal) {
  return terminal.liveTitle && terminal.liveTitle !== terminal.title
    ? `${terminal.title} — ${terminal.liveTitle}`
    : terminal.title;
}

export function matchTerminal(terminals, selector) {
  const sel = String(selector).trim();
  if (!sel) return null;
  if (/^\d+$/.test(sel)) {
    const byIndex = terminals.find((t) => t.index === Number(sel));
    if (byIndex) return byIndex;
  }
  const exact = terminals.find((t) => t.id === sel);
  if (exact) return exact;
  if (sel.length >= 4) {
    const prefixed = terminals.filter((t) => t.id.startsWith(sel));
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) fail(`"${sel}" matches several terminals; use a longer id.`);
  }
  const lower = sel.toLowerCase();
  const titled = terminals.filter((t) => t.title.toLowerCase() === lower || (t.liveTitle || '').toLowerCase() === lower);
  if (titled.length === 1) return titled[0];
  if (titled.length > 1) fail(`"${sel}" matches several terminals; use the number or id from "deckide ls".`);
  return null;
}

async function resolveTerminal(conn, selector, { allowDefault = false } = {}) {
  const state = await loadState(conn);
  if (selector) {
    const found = matchTerminal(state.terminals, selector);
    if (!found) fail(`No terminal matches "${selector}". See "deckide ls".`);
    return { terminal: found, state };
  }
  if (allowDefault) {
    const others = state.terminals.filter((t) => t.id !== process.env.DECKIDE_TERMINAL_ID);
    if (others.length === 1) return { terminal: others[0], state };
  }
  fail('Which terminal? Pass a number, id or title from "deckide ls".');
}

function samePath(a, b) {
  return path.resolve(a).replace(/\/+$/, '') === path.resolve(b).replace(/\/+$/, '');
}

function deckForCwd(decks, cwd) {
  // Deepest deck root that contains cwd.
  let best = null;
  for (const deck of decks) {
    const root = path.resolve(deck.root);
    const rel = path.relative(root, cwd);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!best || root.length > path.resolve(best.root).length) best = deck;
    }
  }
  return best;
}

function resolveDeck(state, selector) {
  if (selector) {
    const sel = String(selector);
    const lower = sel.toLowerCase();
    const prefixed = sel.length >= 4 ? state.decks.filter((d) => d.id.startsWith(sel)) : [];
    const found = state.decks.find((d) => d.id === sel) ||
      (prefixed.length === 1 ? prefixed[0] : null) ||
      state.decks.find((d) => d.name.toLowerCase() === lower);
    if (!found) fail(`No deck matches "${selector}".`);
    return found;
  }
  // A move changes server metadata, not the already-running shell's environment.
  const self = state.terminals.find((t) => t.id === process.env.DECKIDE_TERMINAL_ID);
  const current = state.decks.find((d) => d.id === (self?.deckId ?? process.env.DECKIDE_DECK_ID));
  if (current) return current;
  const byCwd = deckForCwd(state.decks, process.cwd());
  if (byCwd) return byCwd;
  fail('No deck for this directory. Run "deckide open" here, or pass --deck.');
}

// ─── Argument parsing ───────────────────────────────────────────

function parseOptions(args, spec) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const entry = spec[arg];
    if (!entry) {
      if (arg.startsWith('-') && arg !== '-') fail(`Unknown option: ${arg}`);
      positional.push(arg);
      continue;
    }
    if (entry.flag) {
      options[entry.name] = true;
    } else {
      if (i + 1 >= args.length) fail(`${arg} needs a value`);
      options[entry.name] = args[++i];
    }
  }
  return { options, positional };
}

// ─── Commands ───────────────────────────────────────────────────

function shortId(id) {
  return id.slice(0, 8);
}

function tildify(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

const tty = process.stdout.isTTY;
const bold = (text) => (tty ? `\x1b[1m${text}\x1b[0m` : text);
const dim = (text) => (tty ? `\x1b[2m${text}\x1b[0m` : text);
const yellow = (text) => (tty ? `\x1b[33m${text}\x1b[0m` : text);

async function commandList(conn, args) {
  const { options } = parseOptions(args, { '--json': { name: 'json', flag: true } });
  const state = await loadState(conn);
  if (options.json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (state.decks.length === 0) {
    console.log('No decks. Create one with "deckide open [dir]".');
    return;
  }
  const self = process.env.DECKIDE_TERMINAL_ID;
  for (const deck of state.decks) {
    const terminals = state.terminals.filter((t) => t.deckId === deck.id);
    console.log(`${bold(deck.name)}  ${dim(`${shortId(deck.id)}  ${tildify(deck.root)}`)}`);
    if (terminals.length === 0) console.log('    (no terminals)');
    for (const t of terminals) {
      const viewers = [];
      if (t.clients.web) viewers.push(`web×${t.clients.web}`);
      if (t.clients.cli) viewers.push(`cli×${t.clients.cli}`);
      const driver = t.clients.primary ? ` ▶${t.clients.primary}` : '';
      const marker = t.id === self ? `  ${yellow('← this terminal')}` : '';
      console.log(`  ${String(t.index).padStart(3)}  ${shortId(t.id)}  ${`${t.cols}x${t.rows}`.padEnd(7)}  ` +
        `${(viewers.join(' ') + driver || '-').padEnd(14)}  ${displayTitle(t)}${marker}`);
    }
  }
}

async function createTerminal(conn, deck, options) {
  const cols = process.stdout.isTTY ? process.stdout.columns : undefined;
  const rows = process.stdout.isTTY ? process.stdout.rows : undefined;
  const created = await api(conn, 'POST', '/api/terminals', {
    deckId: deck.id,
    title: options.title,
    command: options.command,
    // Start at this tty's size when we are about to attach.
    ...(options.attach && cols && rows ? { cols, rows } : {}),
  });
  if (options.show) await api(conn, 'POST', `/api/terminals/${created.id}/focus`);
  if (options.attach) {
    return attach(conn, { id: created.id, title: created.title });
  }
  console.log(`${created.id}  ${created.title}  (deck: ${deck.name})`);
  return 0;
}

const NEW_OPTIONS = {
  '-d': { name: 'deck' }, '--deck': { name: 'deck' },
  '-t': { name: 'title' }, '--title': { name: 'title' },
  '-c': { name: 'command' }, '--command': { name: 'command' },
  '-a': { name: 'attach', flag: true }, '--attach': { name: 'attach', flag: true },
  '-s': { name: 'show', flag: true }, '--show': { name: 'show', flag: true },
};

async function commandNew(conn, args) {
  const { options, positional } = parseOptions(args, NEW_OPTIONS);
  if (positional.length > 0) fail(`Unexpected argument: ${positional[0]}`);
  const state = await loadState(conn);
  return createTerminal(conn, resolveDeck(state, options.deck), options);
}

async function commandOpen(conn, args) {
  const { options, positional } = parseOptions(args, {
    ...NEW_OPTIONS,
    '-n': { name: 'name' }, '--name': { name: 'name' },
    '--new-deck': { name: 'newDeck', flag: true },
  });
  if (positional.length > 1) fail(`Unexpected argument: ${positional[1]}`);
  const dir = path.resolve(positional[0] || process.cwd());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`Not a directory: ${dir}`);
  const state = await loadState(conn);
  let workspace = state.workspaces.find((w) => samePath(w.path, dir));
  if (!workspace) {
    workspace = await api(conn, 'POST', '/api/workspaces', { path: dir });
    console.error(`Registered workspace ${tildify(workspace.path)}`);
  }
  let deck = options.newDeck ? null : state.decks.find((d) => d.workspaceId === workspace.id);
  if (!deck) {
    deck = await api(conn, 'POST', '/api/decks', { workspaceId: workspace.id, name: options.name });
    console.error(`Created deck ${deck.name}`);
  }
  return createTerminal(conn, deck, options);
}

async function commandSend(conn, args) {
  const { options, positional } = parseOptions(args, { '-n': { name: 'noEnter', flag: true } });
  if (positional.length < 2) fail('Usage: deckide send <terminal> <text...>');
  const { terminal } = await resolveTerminal(conn, positional[0]);
  let text = positional.slice(1).join(' ');
  if (text === '-') {
    text = fs.readFileSync(0, 'utf8');
  }
  // Enter is CR, as a keyboard sends it (TUIs ignore a bare LF).
  const data = options.noEnter ? text : text.replace(/\n$/, '') + '\r';
  await api(conn, 'POST', `/api/terminals/${terminal.id}/input`, { data });
  return 0;
}

async function commandKill(conn, args) {
  if (!args[0]) fail('Usage: deckide kill <terminal>');
  const { terminal } = await resolveTerminal(conn, args[0]);
  await api(conn, 'DELETE', `/api/terminals/${terminal.id}`);
  console.log(`Closed ${displayTitle(terminal)}`);
  return 0;
}

async function commandShow(conn, args) {
  const { terminal } = await resolveTerminal(conn, args[0], { allowDefault: true });
  await api(conn, 'POST', `/api/terminals/${terminal.id}/focus`);
  return 0;
}

async function commandResize(conn, args) {
  if (args.length < 3) fail('Usage: deckide resize <terminal> <cols> <rows>');
  const { terminal } = await resolveTerminal(conn, args[0]);
  const result = await api(conn, 'POST', `/api/terminals/${terminal.id}/resize`, { cols: Number(args[1]), rows: Number(args[2]) });
  console.log(`${result.cols}x${result.rows}`);
  return 0;
}

async function commandSession(conn, args) {
  const [action, selector, value] = args;
  if (!['move', 'rename'].includes(action) || args.length !== 3 || !selector || !value?.trim()) {
    fail('Usage: deckide session move <id> <deckId> | deckide session rename <id> <title>');
  }
  const { terminal, state } = await resolveTerminal(conn, selector);
  const body = action === 'move' ? { deckId: resolveDeck(state, value).id } : { title: value };
  const result = await api(conn, 'PATCH', `/api/terminals/${terminal.id}`, body);
  console.log(`${result.id}  ${result.title}  (deck: ${result.deckId})`);
  return 0;
}

async function commandDeck(conn, args) {
  const [action, id, name] = args;
  if (action === 'list') {
    const { options, positional } = parseOptions(args.slice(1), { '--json': { name: 'json', flag: true } });
    if (positional.length) fail(`Unexpected argument: ${positional[0]}`);
    const decks = await api(conn, 'GET', '/api/decks');
    if (options.json) console.log(JSON.stringify(decks, null, 2));
    else if (!decks.length) console.log('No decks. Create one with "deckide open [dir]".');
    else for (const deck of decks) console.log(`${deck.id}  ${bold(deck.name)}  ${dim(tildify(deck.root))}`);
    return 0;
  }
  if (!id?.trim() || (action === 'delete' ? args.length !== 2 :
    action === 'rename' ? args.length !== 3 || !name?.trim() : true)) {
    fail('Usage: deckide deck list [--json] | deckide deck delete <id> | deckide deck rename <id> <name>');
  }
  // Require an exact ID for mutations: deck names need not be unique.
  const decks = await api(conn, 'GET', '/api/decks');
  if (!decks.some((deck) => deck.id === id)) fail(`No deck with id "${id}". See "deckide deck list".`);
  const route = `/api/decks/${encodeURIComponent(id)}`;
  if (action === 'delete') {
    // Enforce emptiness in the server, including unattached persisted terminals.
    await api(conn, 'DELETE', route + '?ifEmpty=1');
    console.log(`Deleted deck ${id}`);
  } else {
    const result = await api(conn, 'PATCH', route, { name });
    console.log(`${result.id}  ${result.name}`);
  }
  return 0;
}

async function commandEvents(conn) {
  const headers = conn.token ? { Authorization: `Bearer ${conn.token}` } : {};
  let response;
  try {
    response = await fetch(conn.base + '/api/events', { headers });
  } catch {
    fail(`Deck IDE is not reachable at ${conn.base}.`);
  }
  if (!response.ok) fail(`Event stream failed (${response.status})`);
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = pending.indexOf('\n\n')) !== -1) {
      const block = pending.slice(0, index);
      pending = pending.slice(index + 2);
      if (!block.split('\n').includes('event: deckide')) continue;
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) console.log(data);
    }
  }
  return 0;
}

// ─── attach ─────────────────────────────────────────────────────

// Replies a terminal emulator writes to stdin on its own (cursor position,
// device attributes, colour queries, focus/mode reports). While another client
// is primary it answers those queries; forwarding ours too would double them.
const TERMINAL_REPORT = new RegExp('^(?:' + [
  '\\x1b\\[\\??\\d+;\\d+R',         // CPR / DECXCPR
  '\\x1b\\[[?>=][\\d;]*c',         // DA1/DA2/DA3
  '\\x1b\\[\\??[\\d;]*\\$y',       // DECRPM
  '\\x1b\\][\\d;]*[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC reply
  '\\x1bP[\\s\\S]*?\\x1b\\\\',     // DCS reply (XTVERSION, DECRQSS)
  '\\x1b\\[[IO]',                  // focus in/out
  '\\x1b\\[\\?[\\d;]*u',           // kitty keyboard flags
  '\\x1b\\[\\d+;\\d+;\\d+t',       // window size report
  '\\x1b\\[<\\d+;\\d+;\\d+[Mm]',   // SGR mouse report
  '\\x1b\\[M[\\s\\S]{3}',          // X10 mouse report
].join('|') + ')+$');

export function isTerminalReport(text) {
  return TERMINAL_REPORT.test(text);
}

const RESTORE_LOCAL_TERMINAL = [
  '\x1b[?1049l',                     // leave the alternate screen
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l', // mouse tracking off
  '\x1b[?2004l',                     // bracketed paste off
  '\x1b[?1004l',                     // focus reporting off
  '\x1b[?1l\x1b>',                   // normal cursor keys / keypad
  '\x1b[<u',                         // pop kitty keyboard mode
  '\x1b[0m\x1b[?25h',                // reset attributes, show cursor
].join('');

async function attach(conn, terminal) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) fail('attach needs an interactive terminal.');
  if (terminal.id === process.env.DECKIDE_TERMINAL_ID) fail('Cannot attach a terminal to itself.');

  const { default: WebSocket } = await import('ws');
  const localSize = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const wsBase = conn.base.replace(/^http/, 'ws');
  const { cols, rows } = localSize();
  const params = new URLSearchParams({
    proto: '2', client: 'cli', claim: '1', cols: String(cols), rows: String(rows),
    cid: `cli-${crypto.randomBytes(8).toString('hex')}`,
  });
  const socket = new WebSocket(`${wsBase}/api/terminals/${encodeURIComponent(terminal.id)}?${params}`, {
    headers: conn.token ? { Authorization: `Bearer ${conn.token}` } : {},
  });

  let primary = true;
  let ptySize = { cols, rows };
  let detached = false;
  let rawMode = false;

  const setTitle = (text) => stdout.write(`\x1b]2;${text}\x07`);
  const name = terminal.title || shortId(terminal.id);
  const showRole = () => setTitle(primary
    ? `deckide: ${name}`
    : `deckide: ${name} — viewing ${ptySize.cols}x${ptySize.rows} (another client is in control), type to take over`);
  const send = (message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const claim = () => send({ type: 'claim', ...localSize() });

  const cleanup = () => {
    if (rawMode) {
      try { stdin.setRawMode(false); } catch { /* stdin closed */ }
      rawMode = false;
    }
    stdin.pause();
    stdout.write(RESTORE_LOCAL_TERMINAL);
    stdout.write('\x1b[23;0t'); // restore the title saved on attach
  };

  return new Promise((resolve) => {
    const finish = (message, code) => {
      if (detached) return;
      detached = true;
      stdout.off('resize', onResize);
      stdin.off('data', onInput);
      cleanup();
      if (message) stdout.write(`\r\n\x1b[2m[deckide] ${message}\x1b[0m\r\n`);
      try { socket.close(); } catch { /* already closed */ }
      resolve(code);
    };

    const onResize = () => send({ type: 'resize', ...localSize() });

    const onInput = (chunk) => {
      const detachAt = findDetachKey(chunk.toString('latin1'));
      const payload = detachAt === -1 ? chunk : chunk.subarray(0, detachAt);
      if (payload.length > 0) {
        if (primary) {
          socket.send(payload);
        } else if (!isTerminalReport(payload.toString('latin1'))) {
          // Typing here takes control back: the PTY resizes to this tty and
          // the program redraws for it. (Query replies and mouse movement
          // from this window are dropped while another client drives.)
          claim();
          socket.send(payload);
        }
      }
      if (detachAt !== -1) finish(`detached from ${name}`, 0);
    };

    socket.on('open', () => {
      stdout.write('\x1b[22;0t'); // save the window title
      showRole();
      stdin.setRawMode(true);
      rawMode = true;
      stdin.resume();
      stdin.on('data', onInput);
      stdout.on('resize', onResize);
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        stdout.write(data);
        return;
      }
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return; }
      if (message.type === 'sync') {
        ptySize = { cols: message.cols, rows: message.rows };
        // A snapshot/full replay redraws everything: start from a clean screen.
        if (message.reset) stdout.write('\x1b[0m\x1b[H\x1b[2J');
      } else if (message.type === 'size') {
        ptySize = { cols: message.cols, rows: message.rows };
        if (!primary) showRole();
      } else if (message.type === 'primary') {
        const regained = message.value && !primary;
        primary = message.value;
        showRole();
        // What was drawn here while another client drove the size is stale;
        // redraw from the server's screen at our size.
        if (regained) send({ type: 'resync' });
      }
    });

    socket.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer.toString();
      if (code === 1000 && /Terminal (exited|deleted|not found)|Deck deleted/.test(reason)) {
        finish(reason === 'Terminal not found' ? 'terminal not found' : reason.toLowerCase(), reason === 'Terminal not found' ? 1 : 0);
      } else {
        finish(`connection closed (${code}${reason ? `: ${reason}` : ''})`, 1);
      }
    });
    socket.on('error', (error) => finish(`connection error: ${error.message}`, 1));

    const onSignal = () => finish('detached', 0);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);
  });
}

async function commandAttach(conn, args) {
  const { terminal } = await resolveTerminal(conn, args[0], { allowDefault: true });
  return attach(conn, terminal);
}

// ─── gui ────────────────────────────────────────────────────────

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function commandGui(conn, args) {
  const separator = args.indexOf('--');
  if (separator !== -1) {
    const commandLine = args.slice(separator + 1).map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ');
    if (!commandLine) fail('Usage: deckide gui -- <command...>');
    const result = await api(conn, 'POST', '/api/desktop/launch', { command: commandLine, cwd: process.cwd() });
    console.log(`Started ${result.name} (pid ${result.pid}) on the desktop`);
    return 0;
  }
  if (args[0] === '--env') {
    const env = await api(conn, 'GET', '/api/desktop/env');
    console.log(`export DISPLAY=${shellQuote(env.display)}`);
    if (env.xauthority) console.log(`export XAUTHORITY=${shellQuote(env.xauthority)}`);
    return 0;
  }
  if (args[0] === '--type') {
    const text = args.slice(1).join(' ');
    if (!text) fail('Usage: deckide gui --type <text>');
    await api(conn, 'POST', '/api/desktop/type', { text });
    return 0;
  }
  if (args[0] === '--stop') {
    const status = await api(conn, 'POST', '/api/desktop/stop');
    console.log(status.running ? 'Detached (the desktop belongs to another program)' : 'Desktop stopped');
    return 0;
  }
  const apps = await api(conn, 'GET', '/api/desktop/apps');
  if (args.length === 0) {
    const status = await api(conn, 'GET', '/api/desktop');
    console.log(status.running
      ? `Desktop ${status.display} ${status.width}x${status.height}${status.owned ? '' : ' (attached)'}`
      : 'Desktop is stopped (it starts when an app is launched or the web UI opens it)');
    for (const app of apps) console.log(`  ${app.id.padEnd(28)} ${app.name}`);
    return 0;
  }
  const wanted = args.join(' ').toLowerCase();
  const matches = apps.filter((app) => app.id.toLowerCase() === wanted || app.name.toLowerCase() === wanted);
  const candidates = matches.length ? matches
    : apps.filter((app) => app.id.toLowerCase().includes(wanted) || app.name.toLowerCase().includes(wanted));
  if (candidates.length === 0) fail(`No app matches "${args.join(' ')}". Run "deckide gui" for the list, or "deckide gui -- <command>".`);
  if (candidates.length > 1) fail(`"${args.join(' ')}" matches ${candidates.map((app) => app.id).join(', ')}.`);
  const result = await api(conn, 'POST', '/api/desktop/launch', { appId: candidates[0].id });
  console.log(`Started ${result.name} on the desktop`);
  return 0;
}

// ─── Entry ──────────────────────────────────────────────────────

export async function runClientCommand(command, args, { dataDir, settings }) {
  const conn = resolveConnection({ dataDir, settings });
  try {
    switch (command) {
      case 'ls':
      case 'list': await commandList(conn, args); return 0;
      case 'open': return await commandOpen(conn, args);
      case 'new': return await commandNew(conn, args);
      case 'a':
      case 'attach': return await commandAttach(conn, args);
      case 'send': return await commandSend(conn, args);
      case 'kill': return await commandKill(conn, args);
      case 'show': return await commandShow(conn, args);
      case 'resize': return await commandResize(conn, args);
      case 'session': return await commandSession(conn, args);
      case 'deck': return await commandDeck(conn, args);
      case 'events': return await commandEvents(conn);
      case 'gui': return await commandGui(conn, args);
      default: return 1;
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`deckide: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
