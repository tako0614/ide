// `deckide ui` (or plain `deckide` while the backend runs): the web UI's deck
// and terminal grid, in the terminal. Every pane is the same shared tmux
// terminal the web UI shows; this program runs a native tmux client for each
// on a local pty, parses its output with a headless xterm and draws it into
// the pane. Ctrl+] then a key drives the UI; everything else goes to the
// focused terminal. The client used last decides a terminal's size.

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { sessionRpc, isTerminalReport } from './deckide-session.js';

const require = createRequire(import.meta.url);
const PREFIX = 0x1d; // Ctrl+]
const POLL_MS = 1500;
const CLAIM_INTERVAL_MS = 1000;
const ESC = '\x1b';

// ── Display width (CJK / emoji take two cells) ─────────────────────

function charWidth(codePoint) {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if ((codePoint >= 0x300 && codePoint <= 0x36f) || (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)) return 2;
  return 1;
}

export function textWidth(text) {
  let width = 0;
  for (const char of String(text)) width += charWidth(char.codePointAt(0));
  return width;
}

/** Cut or pad `text` to exactly `width` cells. */
export function fit(text, width) {
  if (width <= 0) return '';
  let out = '';
  let used = 0;
  for (const char of String(text).replace(/[\x00-\x1f\x7f]/g, ' ')) {
    const w = charWidth(char.codePointAt(0));
    if (used + w > width) {
      if (used < width) { out += '…'.repeat(Math.min(1, width - used)); used += 1; }
      break;
    }
    out += char;
    used += w;
  }
  return out + ' '.repeat(Math.max(0, width - used));
}

// ── Cell → SGR ─────────────────────────────────────────────────────

function colorSgr(isRgb, isPalette, value, base, bright, extended) {
  if (isRgb) return `;${extended};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
  if (isPalette) {
    if (value < 8) return `;${base + value}`;
    if (value < 16) return `;${bright + value - 8}`;
    return `;${extended};5;${value}`;
  }
  return '';
}

function cellSgr(cell) {
  let sgr = '';
  if (cell.isBold()) sgr += ';1';
  if (cell.isDim()) sgr += ';2';
  if (cell.isItalic()) sgr += ';3';
  if (cell.isUnderline()) sgr += ';4';
  if (cell.isBlink()) sgr += ';5';
  if (cell.isInverse()) sgr += ';7';
  if (cell.isInvisible()) sgr += ';8';
  if (cell.isStrikethrough()) sgr += ';9';
  sgr += colorSgr(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 30, 90, 38);
  sgr += colorSgr(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 40, 100, 48);
  return sgr;
}

/** One visible row of a headless terminal as text with SGR, exactly `width` cells. */
export function renderTerminalRow(term, y, width) {
  const buffer = term.buffer.active;
  const line = buffer.getLine(buffer.viewportY + y);
  if (!line) return `${ESC}[0m` + ' '.repeat(width);
  const cell = buffer.getNullCell();
  let out = '';
  let current = null;
  let used = 0;
  for (let x = 0; x < term.cols && used < width; x++) {
    line.getCell(x, cell);
    const cellWidth = cell.getWidth();
    if (cellWidth === 0) continue;
    const sgr = cellSgr(cell);
    if (sgr !== current) {
      out += `${ESC}[0${sgr}m`;
      current = sgr;
    }
    const chars = cell.getChars();
    if (cellWidth === 2 && used + 2 > width) {
      out += ' ';
      used += 1;
      break;
    }
    out += chars || ' ';
    used += chars ? cellWidth : 1;
  }
  if (used < width) out += `${ESC}[0m` + ' '.repeat(width - used);
  return out + `${ESC}[0m`;
}

// ── Pane: one shared terminal shown through a native tmux client ───

class Pane {
  constructor(ui, terminal) {
    this.ui = ui;
    this.id = terminal.id;
    this.terminal = terminal;
    this.rect = { x: 0, y: 0, w: 0, h: 0 };
    this.cache = [];
    this.liveTitle = null;
    this.meta = null;
    this.exited = false;
    this.decoder = new StringDecoder('utf8');
  }

  async start(width, height) {
    // The adapter requires these CommonJS modules too. Load them completely
    // before importing it, instead of racing import/require on the same cache.
    const { Terminal } = require('@xterm/headless');
    const { Unicode11Addon } = require('@xterm/addon-unicode11');
    const pty = require('node-pty');
    const { TmuxTerminalAdapter } = await import('../dist/terminal/tmuxAdapter.js');
    const value = await sessionRpc('terminals.attach', { id: this.id });
    // Recheck the registry/identity right before attaching, like `session attach`.
    const adapter = new TmuxTerminalAdapter({ runtimeDir: path.dirname(value.meta.socketPath) });
    const fresh = adapter.nativeAttachment(value.id, false);
    if (fresh.meta.generation !== value.meta.generation || fresh.meta.pid !== value.meta.pid) {
      throw Error('terminal_generation_changed');
    }
    this.meta = fresh.meta;
    this.term = new Terminal({ cols: width, rows: height, scrollback: 0, allowProposedApi: true });
    try {
      this.term.loadAddon(new Unicode11Addon());
      this.term.unicode.activeVersion = '11';
    } catch { /* widths fall back to Unicode 6 */ }
    const env = { ...process.env, TERM: 'xterm-256color' };
    delete env.TMUX;
    this.pty = pty.spawn(fresh.binary, fresh.args, { name: 'xterm-256color', cols: width, rows: height, cwd: os.homedir(), env });
    this.pty.onData((data) => {
      this.term.write(data, () => this.ui.requestRender());
    });
    this.pty.onExit(() => {
      this.exited = true;
      this.ui.paneExited(this);
    });
    this.rect.w = width;
    this.rect.h = height;
  }

  resize(width, height) {
    if (!this.term || (width === this.rect.w && height === this.rect.h)) return false;
    this.rect.w = width;
    this.rect.h = height;
    this.cache = [];
    try { this.pty.resize(width, height); } catch { /* exited */ }
    this.term.resize(width, height);
    return true;
  }

  write(data) {
    if (this.exited || !this.pty) return;
    this.pty.write(typeof data === 'string' ? data : this.decoder.write(data));
  }

  cursorHidden() {
    return Boolean(this.term?._core?.coreService?.isCursorHidden);
  }

  dispose() {
    try { this.pty?.kill(); } catch { /* exited: the shell keeps running in tmux */ }
    try { this.term?.dispose(); } catch { /* already */ }
  }
}

// ── UI ─────────────────────────────────────────────────────────────

const COLORS = {
  bar: `${ESC}[0;38;5;250;48;5;236m`,
  tab: `${ESC}[0;38;5;250;48;5;236m`,
  tabActive: `${ESC}[0;1;38;5;231;48;5;25m`,
  header: `${ESC}[0;38;5;248;48;5;237m`,
  headerFocus: `${ESC}[0;1;38;5;231;48;5;31m`,
  border: `${ESC}[0;38;5;239;48;5;235m`,
  dim: `${ESC}[0;38;5;244;48;5;236m`,
  accent: `${ESC}[0;1;38;5;16;48;5;214m`,
  list: `${ESC}[0;38;5;252;48;5;234m`,
  listActive: `${ESC}[0;1;38;5;231;48;5;25m`,
  reset: `${ESC}[0m`,
};

const STATUS_LABELS = { running: '実行中', connected: '接続中', history: '過去', unknown: '不明' };
const TOOL_LABELS = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' };

export class DeckUi {
  constructor({ stdin = process.stdin, stdout = process.stdout } = {}) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.decks = [];
    this.terminals = [];
    this.deckId = null;
    this.focusId = null;
    this.zoom = false;
    this.panes = new Map();
    this.mode = 'normal';
    this.message = '';
    this.messageTimer = null;
    this.prompt = null;
    this.confirm = null;
    this.ai = null;
    this.screenCache = [];
    this.renderScheduled = false;
    this.lastClaim = 0;
    this.claimed = '';
    this.outerModes = {};
    this.closed = false;
    this.inputPending = '';
  }

  size() {
    return { cols: Math.max(20, this.stdout.columns || 80), rows: Math.max(6, this.stdout.rows || 24) };
  }

  deckTerminals() {
    return this.terminals.filter((terminal) => terminal.deckId === this.deckId);
  }

  flash(text, ms = 3000) {
    this.message = text;
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => { this.message = ''; this.requestRender(); }, ms);
    this.messageTimer.unref?.();
    this.requestRender();
  }

  // ── lifecycle ───────────────────────────────────────────────────

  async run() {
    if (!this.stdin.isTTY || !this.stdout.isTTY) throw Error('terminal_required');
    await this.refresh();
    this.deckId = this.pickInitialDeck();
    this.write(`${ESC}[?1049h${ESC}[?7l${ESC}[?25l${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${ESC}[2J`);
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.onData = (chunk) => this.handleInput(chunk);
    this.onResize = () => { this.screenCache = []; void this.syncPanes(true); };
    this.stdin.on('data', this.onData);
    this.stdout.on('resize', this.onResize);
    await this.syncPanes();
    this.poller = setInterval(() => { void this.refresh().then(() => this.syncPanes()).catch(() => undefined); }, POLL_MS);
    this.titlePoller = setInterval(() => this.pollTitles(), 2000);
    this.requestRender();
    await new Promise((resolve) => { this.finish = resolve; });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poller);
    clearInterval(this.titlePoller);
    for (const pane of this.panes.values()) pane.dispose();
    this.panes.clear();
    this.stdin.off('data', this.onData);
    this.stdout.off('resize', this.onResize);
    try { this.stdin.setRawMode(false); } catch { /* closed */ }
    this.stdin.pause();
    this.write(`${ESC}[?1000l${ESC}[?1002l${ESC}[?1006l${ESC}[?2004l${ESC}[?1l${ESC}>${ESC}[?7h${ESC}[0m${ESC}[?25h${ESC}[?1049l`);
    this.finish?.();
  }

  write(text) {
    if (!this.closed || text.includes('?1049l')) this.stdout.write(text);
  }

  // ── data ────────────────────────────────────────────────────────

  async refresh() {
    const [decks, terminals] = await Promise.all([sessionRpc('decks.list'), sessionRpc('terminals.list', {})]);
    this.decks = decks;
    this.terminals = terminals;
    if (this.deckId && !decks.some((deck) => deck.id === this.deckId)) this.deckId = decks[0]?.id ?? null;
    if (!this.deckId) this.deckId = decks[0]?.id ?? null;
  }

  pickInitialDeck() {
    const own = process.env.DECKIDE_DECK_ID;
    if (own && this.decks.some((deck) => deck.id === own)) return own;
    const cwd = process.cwd();
    let best = null;
    for (const deck of this.decks) {
      const relative = path.relative(deck.root, cwd);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        if (!best || deck.root.length > best.root.length) best = deck;
      }
    }
    return best?.id ?? this.decks[0]?.id ?? null;
  }

  /** Create/remove panes so they match the current deck, then lay them out. */
  async syncPanes(resized = false) {
    if (this.closed) return;
    const wanted = this.deckTerminals().filter((terminal) => terminal.available !== false);
    if (!wanted.some((terminal) => terminal.id === this.focusId)) {
      const own = wanted.find((terminal) => terminal.id === process.env.DECKIDE_TERMINAL_ID);
      this.focusId = (own ?? wanted[0])?.id ?? null;
    }
    let changed = false;
    for (const [id, pane] of this.panes) {
      if (!wanted.some((terminal) => terminal.id === id)) {
        pane.dispose();
        this.panes.delete(id);
        changed = true;
      }
    }
    const rects = this.layout(wanted);
    for (const terminal of wanted) {
      const rect = rects.get(terminal.id);
      if (!rect) continue;
      let pane = this.panes.get(terminal.id);
      if (!pane) {
        pane = new Pane(this, terminal);
        this.panes.set(terminal.id, pane);
        pane.rect = { ...rect };
        changed = true;
        try {
          await pane.start(rect.w, rect.h);
        } catch {
          pane.failed = true;
        }
      }
      pane.terminal = terminal;
      pane.rect.x = rect.x;
      pane.rect.y = rect.y;
      if (pane.resize(rect.w, rect.h)) changed = true;
    }
    // A terminal can't scale text like the browser does, so a pane narrower
    // than its terminal would only show a slice. Opening this view (or
    // changing its layout) counts as using what it shows: every visible pane
    // takes its own size. Afterwards, typing re-asserts the focused one.
    if (resized || changed) this.claimVisible(rects);
    this.screenCache = [];
    this.requestRender();
  }

  /** Grid like the web UI (near-square), or the focused terminal alone when zoomed. */
  layout(terminals) {
    const { cols, rows } = this.size();
    const rects = new Map();
    const shown = this.zoom ? terminals.filter((terminal) => terminal.id === this.focusId) : terminals;
    if (shown.length === 0) return rects;
    const gridCols = Math.ceil(Math.sqrt(shown.length));
    const gridRows = Math.ceil(shown.length / gridCols);
    const top = 1;
    const height = rows - 2;
    shown.forEach((terminal, index) => {
      const column = index % gridCols;
      const row = Math.floor(index / gridCols);
      const x0 = Math.floor((column * cols) / gridCols);
      const x1 = Math.floor(((column + 1) * cols) / gridCols);
      const y0 = top + Math.floor((row * height) / gridRows);
      const y1 = top + Math.floor(((row + 1) * height) / gridRows);
      const border = column < gridCols - 1 ? 1 : 0;
      rects.set(terminal.id, {
        x: x0, y: y0 + 1, w: Math.max(2, x1 - x0 - border), h: Math.max(1, y1 - y0 - 1),
        headerY: y0, cellX: x0, cellW: x1 - x0, border,
      });
    });
    this.lastRects = rects;
    return rects;
  }

  pollTitles() {
    for (const pane of this.panes.values()) {
      if (!pane.meta) continue;
      execFile('tmux', ['-S', pane.meta.socketPath, '-N', 'display-message', '-p', '-t', `=${pane.meta.sessionName}`, '#{pane_title}'],
        { timeout: 1500 }, (error, stdout) => {
          if (error) return;
          const title = stdout.trim();
          const next = title && title !== os.hostname() ? title : null;
          if (next !== pane.liveTitle) {
            pane.liveTitle = next;
            this.requestRender();
          }
        });
    }
  }

  // ── size: the client used last decides ───────────────────────────

  claimVisible(rects) {
    for (const [id, rect] of rects) {
      const pane = this.panes.get(id);
      if (!pane || pane.failed || pane.exited) continue;
      sessionRpc('terminals.resize', { id, cols: rect.w, rows: rect.h }).catch(() => undefined);
    }
    const focused = rects.get(this.focusId);
    if (focused) {
      this.lastClaim = Date.now();
      this.claimed = `${this.focusId}:${focused.w}x${focused.h}`;
    }
  }

  claimFocused(force = false) {
    const pane = this.panes.get(this.focusId);
    if (!pane || pane.failed || pane.exited) return;
    const key = `${pane.id}:${pane.rect.w}x${pane.rect.h}`;
    const now = Date.now();
    if (!force && now - this.lastClaim < CLAIM_INTERVAL_MS && key === this.claimed) return;
    this.lastClaim = now;
    this.claimed = key;
    sessionRpc('terminals.resize', { id: pane.id, cols: pane.rect.w, rows: pane.rect.h }).catch(() => undefined);
  }

  // ── rendering ───────────────────────────────────────────────────

  requestRender() {
    if (this.renderScheduled || this.closed) return;
    this.renderScheduled = true;
    setTimeout(() => {
      this.renderScheduled = false;
      this.render();
    }, 16);
  }

  render() {
    if (this.closed) return;
    const { cols, rows } = this.size();
    const lines = new Array(rows).fill(null);
    lines[0] = this.renderTabs(cols);
    lines[rows - 1] = this.renderStatus(cols);
    const overlay = this.mode === 'ai' || this.mode === 'help' || this.mode === 'view';
    let frame = `${ESC}[?2026h`;
    if (overlay) {
      const body = this.mode === 'help' ? this.helpLines(cols, rows - 2) : this.mode === 'view' ? this.viewLines(cols, rows - 2) : this.aiLines(cols, rows - 2);
      for (let y = 1; y < rows - 1; y++) lines[y] = body[y - 1] ?? COLORS.list + ' '.repeat(cols) + COLORS.reset;
      for (let y = 0; y < rows; y++) frame += this.paintLine(y, 0, lines[y]);
      frame += `${ESC}[?25l${ESC}[?2026l`;
      this.write(frame);
      return;
    }
    const shown = this.zoom ? [this.panes.get(this.focusId)].filter(Boolean) : [...this.panes.values()];
    if (shown.length === 0) {
      const empty = this.decks.length === 0
        ? 'デッキがありません。Ctrl+] c で、このディレクトリのデッキを作ります。'
        : '端末がありません。Ctrl+] n で端末を追加します。';
      for (let y = 1; y < rows - 1; y++) {
        lines[y] = COLORS.list + (y === Math.floor(rows / 2) ? fit('  ' + empty, cols) : ' '.repeat(cols)) + COLORS.reset;
      }
      for (let y = 0; y < rows; y++) frame += this.paintLine(y, 0, lines[y]);
      frame += `${ESC}[?25l${ESC}[?2026l`;
      this.write(frame);
      return;
    }
    frame += this.paintLine(0, 0, lines[0]);
    frame += this.paintLine(rows - 1, 0, lines[rows - 1]);
    const rects = this.lastRects ?? new Map();
    const deckTerminals = this.deckTerminals();
    for (const pane of shown) {
      const rect = rects.get(pane.id);
      if (!rect) continue;
      const index = deckTerminals.findIndex((terminal) => terminal.id === pane.id) + 1;
      const focused = pane.id === this.focusId;
      const title = pane.liveTitle ? `${pane.terminal.title} — ${pane.liveTitle}` : pane.terminal.title;
      const sizeNote = pane.terminal.cols && (pane.terminal.cols !== rect.w || pane.terminal.rows !== rect.h)
        ? ` ${pane.terminal.cols}×${pane.terminal.rows}` : '';
      const header = (focused ? COLORS.headerFocus : COLORS.header) +
        fit(` ${index}:${title}${sizeNote}${pane.exited ? ' (終了)' : pane.failed ? ' (接続できません)' : ''}`, rect.cellW) + COLORS.reset;
      frame += this.paintLine(rect.headerY, rect.cellX, header, `h:${pane.id}`);
      for (let y = 0; y < rect.h; y++) {
        const text = pane.term ? renderTerminalRow(pane.term, y, rect.w) : COLORS.list + ' '.repeat(rect.w) + COLORS.reset;
        frame += this.paintLine(rect.y + y, rect.x, text, `p:${pane.id}:${y}`);
        if (rect.border) frame += this.paintLine(rect.y + y, rect.x + rect.w, `${COLORS.border}│${COLORS.reset}`, `b:${pane.id}:${y}`);
      }
      if (rect.border) frame += this.paintLine(rect.headerY, rect.x + rect.w, `${COLORS.border}│${COLORS.reset}`, `bh:${pane.id}`);
    }
    // Cursor of the focused terminal, unless a prompt owns it.
    const focusedPane = this.panes.get(this.focusId);
    const focusRect = rects.get(this.focusId);
    if (this.mode === 'prompt' || this.mode === 'confirm') {
      frame += `${ESC}[?25h`;
      frame += `${ESC}[${rows};${Math.min(cols, textWidth(this.promptText()) + 1)}H`;
    } else if (focusedPane?.term && focusRect && !focusedPane.cursorHidden()) {
      const buffer = focusedPane.term.buffer.active;
      if (buffer.viewportY === buffer.baseY && buffer.cursorX < focusRect.w && buffer.cursorY < focusRect.h) {
        frame += `${ESC}[${focusRect.y + buffer.cursorY + 1};${focusRect.x + buffer.cursorX + 1}H${ESC}[?25h`;
      } else frame += `${ESC}[?25l`;
    } else frame += `${ESC}[?25l`;
    frame += this.syncOuterModes(focusedPane);
    frame += `${ESC}[?2026l`;
    this.write(frame);
  }

  /** Write a line only when it changed since the last frame. */
  paintLine(y, x, text, key = `l:${y}:${x}`) {
    if (this.screenCache[key] === text) return '';
    this.screenCache[key] = text;
    return `${ESC}[${y + 1};${x + 1}H${text}`;
  }

  /** Mirror the focused program's input modes on the real terminal so its keys arrive encoded as it expects. */
  syncOuterModes(pane) {
    const modes = pane?.term?.modes;
    if (!modes) return '';
    let out = '';
    const want = { ckm: modes.applicationCursorKeysMode, keypad: modes.applicationKeypadMode, paste: modes.bracketedPasteMode };
    if (want.ckm !== this.outerModes.ckm) out += want.ckm ? `${ESC}[?1h` : `${ESC}[?1l`;
    if (want.keypad !== this.outerModes.keypad) out += want.keypad ? `${ESC}=` : `${ESC}>`;
    if (want.paste !== this.outerModes.paste) out += want.paste ? `${ESC}[?2004h` : `${ESC}[?2004l`;
    this.outerModes = want;
    return out;
  }

  renderTabs(cols) {
    let out = COLORS.bar + ' deckide ';
    let used = 9;
    for (const deck of this.decks) {
      const label = ` ${deck.name} `;
      const width = textWidth(label);
      if (used + width + 1 > cols) break;
      out += (deck.id === this.deckId ? COLORS.tabActive : COLORS.tab) + label + COLORS.bar + '│';
      used += width + 1;
    }
    return out + COLORS.bar + ' '.repeat(Math.max(0, cols - used)) + COLORS.reset;
  }

  promptText() {
    if (this.mode === 'prompt') return ` ${this.prompt.label}: ${this.prompt.value}`;
    if (this.mode === 'confirm') return ` ${this.confirm.label} (y/n) `;
    return '';
  }

  renderStatus(cols) {
    if (this.mode === 'prompt' || this.mode === 'confirm') return COLORS.accent + fit(this.promptText(), cols) + COLORS.reset;
    if (this.mode === 'prefix') {
      return COLORS.accent + fit(' ^] n:端末追加 c:デッキ追加 x:閉じる z:最大化 ←↑↓→/Tab:移動 1-9:端末 [ ]:デッキ a:AIセッション s:Webで表示 q:終了 ?:ヘルプ', cols) + COLORS.reset;
    }
    if (this.mode === 'ai') return COLORS.bar + fit(' ↑↓:選択 Enter:開く/CLIで再開 v:会話 r:再読込 Esc:戻る', cols) + COLORS.reset;
    if (this.mode === 'view') return COLORS.bar + fit(' ↑↓/PgUp/PgDn:スクロール Esc:戻る', cols) + COLORS.reset;
    if (this.mode === 'help') return COLORS.bar + fit(' 何かキーを押すと戻ります', cols) + COLORS.reset;
    const right = this.message || 'Ctrl+] でメニュー';
    const focused = this.panes.get(this.focusId);
    const left = focused ? ` ${focused.terminal.title}` : ' ';
    return COLORS.bar + fit(left, Math.max(0, cols - textWidth(right) - 1)) + COLORS.dim + right + ' ' + COLORS.reset;
  }

  helpLines(cols, height) {
    const lines = [
      'deckide — Web 版と同じデッキ・端末をこの端末で操作します',
      '',
      'Ctrl+] のあとに:',
      '  n        このデッキに端末を追加',
      '  c        デッキを追加（ディレクトリを入力）',
      '  x        フォーカス中の端末を閉じる',
      '  z        フォーカス中の端末を最大化 / グリッドに戻す',
      '  ←↑↓→ Tab 端末を移動     1-9  番号の端末へ',
      '  [ ]      前 / 次のデッキ',
      '  a        AI セッション（Codex / Claude Code / OpenCode）',
      '  s        この端末を開いている Web 画面で前面に出す',
      '  q        終了（端末はそのまま動き続けます）',
      '  Ctrl+]   Ctrl+] そのものを送る',
      '',
      'マウス: タブでデッキ切替、端末をクリックでフォーカス。',
      '端末のサイズは最後に操作したクライアント（この画面・Web・別の CLI）に合わせます。',
      'tmux のキー（Ctrl+b …）もそのまま使えます。',
    ];
    return Array.from({ length: height }, (_, index) => COLORS.list + fit('  ' + (lines[index] ?? ''), cols) + COLORS.reset);
  }

  aiLines(cols, height) {
    const ai = this.ai;
    const out = [];
    out.push(COLORS.headerFocus + fit(' AIセッション', cols) + COLORS.reset);
    if (!ai || ai.loading) out.push(COLORS.list + fit('  読み込み中…', cols) + COLORS.reset);
    else if (ai.error) out.push(COLORS.list + fit('  ' + ai.error, cols) + COLORS.reset);
    else if (!ai.tasks.length) out.push(COLORS.list + fit('  セッションはありません。', cols) + COLORS.reset);
    else {
      const visible = height - 1;
      const start = Math.max(0, Math.min(ai.index - Math.floor(visible / 2), ai.tasks.length - visible));
      for (let i = start; i < Math.min(ai.tasks.length, start + visible); i++) {
        const task = ai.tasks[i];
        const label = ` ${(STATUS_LABELS[task.status] ?? task.status).padEnd(4)} ${(TOOL_LABELS[task.tool] ?? task.tool).padEnd(8)} ${task.title}  ${task.cwd}`;
        out.push((i === ai.index ? COLORS.listActive : COLORS.list) + fit(label, cols) + COLORS.reset);
      }
    }
    while (out.length < height) out.push(COLORS.list + ' '.repeat(cols) + COLORS.reset);
    return out;
  }

  viewLines(cols, height) {
    const view = this.view;
    const out = [COLORS.headerFocus + fit(' ' + view.title, cols) + COLORS.reset];
    const body = view.lines.slice(view.top, view.top + height - 1);
    for (const line of body) out.push(COLORS.list + fit(line, cols) + COLORS.reset);
    while (out.length < height) out.push(COLORS.list + ' '.repeat(cols) + COLORS.reset);
    return out;
  }

  // ── input ───────────────────────────────────────────────────────

  handleInput(chunk) {
    let text = this.inputPending + chunk.toString('latin1');
    this.inputPending = '';
    let index = 0;
    let passthrough = '';
    const flush = () => {
      if (!passthrough) return;
      this.forward(Buffer.from(passthrough, 'latin1'));
      passthrough = '';
    };
    while (index < text.length) {
      const rest = text.slice(index);
      // SGR mouse report from the real terminal.
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
      if (mouse) {
        flush();
        this.handleMouse(Number(mouse[1]), Number(mouse[2]) - 1, Number(mouse[3]) - 1, mouse[4] === 'M');
        index += mouse[0].length;
        continue;
      }
      if (rest.startsWith('\x1b[<') && !/[Mm]/.test(rest)) {
        this.inputPending = rest; // incomplete mouse report
        break;
      }
      if (this.mode !== 'normal') {
        flush();
        const consumed = this.handleModeKey(rest);
        index += Math.max(1, consumed);
        continue;
      }
      if (text.charCodeAt(index) === PREFIX) {
        flush();
        this.mode = 'prefix';
        this.requestRender();
        index += 1;
        continue;
      }
      passthrough += text[index];
      index += 1;
    }
    flush();
  }

  forward(bytes) {
    const pane = this.panes.get(this.focusId);
    if (!pane) return;
    pane.write(bytes);
    if (!isTerminalReport(bytes.toString('latin1'))) this.claimFocused();
  }

  /** Keys while the prefix, a prompt or an overlay is active. Returns bytes consumed. */
  handleModeKey(rest) {
    const key = readKey(rest);
    if (this.mode === 'prefix') {
      this.mode = 'normal';
      this.runCommand(key.name);
      this.requestRender();
      return key.length;
    }
    if (this.mode === 'prompt') {
      if (key.name === 'enter') {
        const { value, onSubmit } = this.prompt;
        this.mode = 'normal';
        this.prompt = null;
        void onSubmit(value);
      } else if (key.name === 'escape' || key.name === 'ctrl-c') {
        this.mode = 'normal';
        this.prompt = null;
      } else if (key.name === 'backspace') {
        this.prompt.value = Array.from(this.prompt.value).slice(0, -1).join('');
      } else if (key.text) {
        this.prompt.value += Buffer.from(key.text, 'latin1').toString('utf8');
      }
      this.requestRender();
      return key.length;
    }
    if (this.mode === 'confirm') {
      const { onYes } = this.confirm;
      this.mode = 'normal';
      this.confirm = null;
      if (key.name === 'y') void onYes();
      this.requestRender();
      return key.length;
    }
    if (this.mode === 'help') {
      this.mode = 'normal';
      this.screenCache = [];
      this.requestRender();
      return key.length;
    }
    if (this.mode === 'view') {
      const page = this.size().rows - 4;
      if (key.name === 'escape' || key.name === 'q') this.mode = 'ai';
      else if (key.name === 'up' || key.name === 'k') this.view.top = Math.max(0, this.view.top - 1);
      else if (key.name === 'down' || key.name === 'j') this.view.top = Math.min(Math.max(0, this.view.lines.length - page), this.view.top + 1);
      else if (key.name === 'pageup') this.view.top = Math.max(0, this.view.top - page);
      else if (key.name === 'pagedown') this.view.top = Math.min(Math.max(0, this.view.lines.length - page), this.view.top + page);
      this.screenCache = [];
      this.requestRender();
      return key.length;
    }
    if (this.mode === 'ai') {
      const ai = this.ai;
      if (key.name === 'escape' || key.name === 'q') { this.mode = 'normal'; this.screenCache = []; }
      else if (key.name === 'up' || key.name === 'k') ai.index = Math.max(0, ai.index - 1);
      else if (key.name === 'down' || key.name === 'j') ai.index = Math.min(Math.max(0, (ai.tasks?.length ?? 1) - 1), ai.index + 1);
      else if (key.name === 'r') void this.openAi();
      else if (key.name === 'v') void this.viewConversation();
      else if (key.name === 'enter') void this.openTask();
      this.requestRender();
      return key.length;
    }
    return key.length;
  }

  runCommand(name) {
    const visible = this.deckTerminals();
    const focusIndex = visible.findIndex((terminal) => terminal.id === this.focusId);
    if (name === 'n') void this.createTerminal();
    else if (name === 'c') this.askPath();
    else if (name === 'x') this.askClose();
    else if (name === 'z') { this.zoom = !this.zoom; void this.syncPanes(true); }
    else if (name === 'tab' || name === 'right' || name === 'l') this.focusTerminal(visible[(focusIndex + 1) % visible.length]?.id);
    else if (name === 'left' || name === 'h') this.focusTerminal(visible[(focusIndex - 1 + visible.length) % visible.length]?.id);
    else if (name === 'down' || name === 'j' || name === 'up' || name === 'k') this.moveVertical(name === 'down' || name === 'j' ? 1 : -1);
    else if (/^[1-9]$/.test(name)) this.focusTerminal(visible[Number(name) - 1]?.id);
    else if (name === '[' || name === ']') this.switchDeck(name === ']' ? 1 : -1);
    else if (name === 'a') void this.openAi();
    else if (name === 's') void this.showInWeb();
    else if (name === 'q' || name === 'd') this.close();
    else if (name === '?') { this.mode = 'help'; this.screenCache = []; }
    else if (name === 'ctrl-]') this.forward(Buffer.from([PREFIX]));
  }

  moveVertical(direction) {
    const rects = this.lastRects;
    const current = rects?.get(this.focusId);
    if (!current) return;
    let best = null;
    for (const [id, rect] of rects) {
      if (id === this.focusId) continue;
      const dy = (rect.headerY - current.headerY) * direction;
      if (dy <= 0) continue;
      const score = dy * 1000 + Math.abs(rect.cellX - current.cellX);
      if (!best || score < best.score) best = { id, score };
    }
    if (best) this.focusTerminal(best.id);
  }

  focusTerminal(id) {
    if (!id || id === this.focusId) return;
    this.focusId = id;
    if (this.zoom) void this.syncPanes();
    this.claimFocused(true);
    this.screenCache = [];
    this.requestRender();
  }

  switchDeck(direction) {
    if (!this.decks.length) return;
    const index = this.decks.findIndex((deck) => deck.id === this.deckId);
    this.deckId = this.decks[(index + direction + this.decks.length) % this.decks.length].id;
    this.focusId = null;
    this.zoom = false;
    for (const pane of this.panes.values()) pane.dispose();
    this.panes.clear();
    void this.syncPanes();
  }

  handleMouse(button, x, y, press) {
    if (!press || (button & 64)) return; // releases and wheel are ignored for now
    const { rows } = this.size();
    if (this.mode !== 'normal' || y === rows - 1) return;
    if (y === 0) {
      let used = 9;
      for (const deck of this.decks) {
        const width = textWidth(` ${deck.name} `) + 1;
        if (x >= used && x < used + width) {
          if (deck.id !== this.deckId) {
            this.deckId = deck.id;
            this.switchDeck(0);
          }
          return;
        }
        used += width;
      }
      return;
    }
    for (const [id, rect] of this.lastRects ?? new Map()) {
      if (x >= rect.cellX && x < rect.cellX + rect.cellW && y >= rect.headerY && y < rect.y + rect.h) {
        if (id !== this.focusId) this.focusTerminal(id);
        else this.claimFocused(true);
        return;
      }
    }
  }

  // ── actions ─────────────────────────────────────────────────────

  async createTerminal() {
    try {
      const { cols, rows } = this.size();
      const created = await sessionRpc('terminals.create', this.deckId ? { deckId: this.deckId, cols, rows: rows - 3 } : { cwd: process.cwd(), cols, rows: rows - 3 });
      await this.refresh();
      this.deckId = created.deckId;
      this.focusId = created.id;
      await this.syncPanes(true);
    } catch {
      this.flash('端末を作成できませんでした。');
    }
  }

  askPath() {
    this.mode = 'prompt';
    this.prompt = {
      label: '新しいデッキのディレクトリ',
      value: process.cwd(),
      onSubmit: async (value) => {
        try {
          const cwd = path.resolve(value.trim() || process.cwd());
          const created = await sessionRpc('terminals.create', { cwd });
          await this.refresh();
          for (const pane of this.panes.values()) pane.dispose();
          this.panes.clear();
          this.deckId = created.deckId;
          this.focusId = created.id;
          await this.syncPanes(true);
        } catch {
          this.flash('デッキを作成できませんでした（ディレクトリを確認してください）。');
        }
      },
    };
  }

  askClose() {
    const pane = this.panes.get(this.focusId);
    if (!pane) return;
    this.mode = 'confirm';
    this.confirm = {
      label: `「${pane.terminal.title}」を閉じますか？（シェルが終了します）`,
      onYes: async () => {
        try {
          await sessionRpc('terminals.delete', { id: pane.id });
          await this.refresh();
          await this.syncPanes();
        } catch {
          this.flash('閉じられませんでした。');
        }
      },
    };
  }

  async showInWeb() {
    if (!this.focusId) return;
    try {
      await sessionRpc('terminals.focus', { id: this.focusId });
      this.flash('Web 画面でこの端末を前面に出しました。');
    } catch {
      this.flash('Web 画面に知らせられませんでした。');
    }
  }

  async openAi() {
    this.mode = 'ai';
    this.screenCache = [];
    this.ai = { loading: true, tasks: [], index: this.ai?.index ?? 0 };
    this.requestRender();
    try {
      const page = await sessionRpc('agents.list', { limit: 100 });
      this.ai = { loading: false, tasks: page.tasks ?? [], index: Math.min(this.ai.index, Math.max(0, (page.tasks?.length ?? 1) - 1)) };
    } catch {
      this.ai = { loading: false, tasks: [], index: 0, error: 'AI セッションを読み込めませんでした。' };
    }
    this.requestRender();
  }

  async viewConversation() {
    const task = this.ai?.tasks?.[this.ai.index];
    if (!task) return;
    try {
      const value = await sessionRpc('agents.read', { tool: task.tool, sourceId: task.sourceId, id: task.id });
      const { cols } = this.size();
      const lines = [];
      for (const message of value.messages ?? []) {
        lines.push(message.role === 'user' ? '▶ あなた' : `◀ ${TOOL_LABELS[task.tool] ?? task.tool}`);
        for (const raw of String(message.text).split('\n')) {
          let line = raw;
          while (textWidth(line) > cols - 4) {
            let cut = '';
            for (const char of line) {
              if (textWidth(cut + char) > cols - 4) break;
              cut += char;
            }
            lines.push('  ' + cut);
            line = line.slice(cut.length);
          }
          lines.push('  ' + line);
        }
        lines.push('');
      }
      this.view = { title: task.title, lines, top: Math.max(0, lines.length - (this.size().rows - 4)) };
      this.mode = 'view';
    } catch {
      this.flash('会話を読み込めませんでした。');
    }
    this.screenCache = [];
    this.requestRender();
  }

  async openTask() {
    const task = this.ai?.tasks?.[this.ai.index];
    if (!task) return;
    try {
      if (task.terminal) {
        await this.refresh();
        for (const pane of this.panes.values()) pane.dispose();
        this.panes.clear();
        this.deckId = task.terminal.deckId;
        this.focusId = task.terminal.id;
      } else if (task.resumeCommand && this.deckId) {
        const created = await sessionRpc('terminals.create', { deckId: this.deckId, command: task.resumeCommand, title: `${task.tool} · ${task.title}` });
        await this.refresh();
        this.focusId = created.id;
      } else {
        this.flash('このセッションは開けません。');
        return;
      }
      this.mode = 'normal';
      this.screenCache = [];
      await this.syncPanes(true);
    } catch {
      this.flash('開けませんでした。');
    }
  }

  paneExited(pane) {
    if (this.closed) return;
    // The tmux client ended: the terminal was closed (or the server restarted).
    setTimeout(() => {
      void this.refresh().then(() => {
        this.panes.get(pane.id)?.dispose();
        this.panes.delete(pane.id);
        return this.syncPanes();
      }).catch(() => undefined);
    }, 300);
  }
}

/** Decode one key from raw input (latin1 text). */
export function readKey(text) {
  const named = [
    ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'],
    ['\x1bOA', 'up'], ['\x1bOB', 'down'], ['\x1bOC', 'right'], ['\x1bOD', 'left'],
    ['\x1b[5~', 'pageup'], ['\x1b[6~', 'pagedown'], ['\x1b[Z', 'backtab'],
  ];
  for (const [sequence, name] of named) if (text.startsWith(sequence)) return { name, length: sequence.length };
  const code = text.charCodeAt(0);
  if (code === 0x1b) {
    const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text);
    if (csi) return { name: 'unknown', length: csi[0].length };
    return { name: 'escape', length: 1 };
  }
  if (code === 0x0d || code === 0x0a) return { name: 'enter', length: 1 };
  if (code === 0x09) return { name: 'tab', length: 1 };
  if (code === 0x7f || code === 0x08) return { name: 'backspace', length: 1 };
  if (code === 0x03) return { name: 'ctrl-c', length: 1 };
  if (code === PREFIX) return { name: 'ctrl-]', length: 1 };
  if (code < 0x20) return { name: 'ctrl', length: 1 };
  // A UTF-8 sequence (as latin1 chars) is one typed character.
  let length = 1;
  if (code >= 0xc0) {
    const extra = code >= 0xf0 ? 3 : code >= 0xe0 ? 2 : 1;
    length = Math.min(text.length, 1 + extra);
  }
  const chunk = text.slice(0, length);
  return { name: chunk.length === 1 ? chunk : 'text', text: chunk, length };
}

export async function runUi() {
  const ui = new DeckUi();
  const onSignal = () => ui.close();
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  try {
    await ui.run();
  } finally {
    ui.close();
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
  }
}
