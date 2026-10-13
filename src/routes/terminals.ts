import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { WebSocket } from 'ws';
import type { Deck, TerminalSession } from '../types.js';
import { DATA_DIR, PORT, TERMINAL_BUFFER_LIMIT, TERMINAL_MIRROR_SCROLLBACK } from '../config.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { getDefaultShell, getAvailableLocales, getShellBasename } from '../utils/shell.js';
import { alignToUtf8Start, skipPartialEscapeSequence } from '../utils/utf8.js';
import { createTerminalMirror } from '../utils/terminal-mirror.js';
import { clampTerminalSize, closeTerminalClients, resizeTerminal } from '../utils/terminal-control.js';
import { emitDeckIdeEvent } from '../utils/events.js';
import { deleteTerminalTmuxSession, hasTerminalTmuxSession, openTerminalProcess, terminalTmuxSocket, terminalTmuxStatus } from '../utils/terminal-process.js';

const DEFAULT_TERMINAL_TITLE = 'ターミナル';
const MAX_SOCKET_BUFFERED_AMOUNT = 1024 * 1024;

// 初期端末サイズ（リクエストで指定がない場合のデフォルト）。
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;

// ログインシェルとして扱う POSIX シェルのベース名。
const POSIX_LOGIN_SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'csh', 'tcsh']);

function isUtf8Locale(value: string | undefined): boolean {
  if (!value) return false;
  return /\.(utf-?8)$/i.test(value);
}

// Input accepted per POST /api/terminals/:id/input request (CLI `deckide send`).
const MAX_HTTP_INPUT_BYTES = 1024 * 1024;

/** Public view of a terminal for list/info responses (CLI `deckide ls`). */
function describeTerminal(session: TerminalSession) {
  let web = 0;
  let cli = 0;
  for (const client of session.clients.values()) {
    if (client.kind === 'cli') cli++;
    else web++;
  }
  const owner = session.resizeOwner ? session.clients.get(session.resizeOwner) : undefined;
  return {
    id: session.id,
    deckId: session.deckId,
    title: session.title,
    liveTitle: session.mirror?.title() ?? null,
    command: session.command,
    createdAt: session.createdAt,
    cols: session.cols,
    rows: session.rows,
    clients: { web, cli, primary: owner?.kind ?? null },
    lastActive: new Date(session.lastActive).toISOString(),
  };
}

/**
 * 継承した環境に有効な UTF-8 ロケールが無い場合のフォールバックを選ぶ。
 * システムに存在しないロケールは決して設定しない。
 * 優先順位: 継承 LANG と同じ言語の UTF-8 → "C.UTF-8" → "C.utf8" → 最初の "*.UTF-8"/"*.utf8"。
 * 該当が無ければ null を返す（何も設定しない）。
 */
function pickFallbackUtf8Locale(inheritedLang: string | undefined): string | null {
  const available = getAvailableLocales();
  if (available.length === 0) {
    return null;
  }

  const utf8Locales = available.filter((loc) => isUtf8Locale(loc));
  if (utf8Locales.length === 0) {
    return null;
  }

  // 継承 LANG の言語部分（例: "ja_JP.eucJP" -> "ja_JP" / "ja"）に一致する UTF-8 ロケール。
  if (inheritedLang) {
    const langBase = inheritedLang.split('.')[0];
    if (langBase) {
      const exact = utf8Locales.find((loc) => loc.split('.')[0] === langBase);
      if (exact) return exact;
      const lang = langBase.split('_')[0];
      if (lang) {
        const byLang = utf8Locales.find((loc) => loc.split(/[._]/)[0] === lang);
        if (byLang) return byLang;
      }
    }
  }

  const cUtf8 = utf8Locales.find((loc) => loc === 'C.UTF-8');
  if (cUtf8) return cUtf8;
  const cUtf8Lower = utf8Locales.find((loc) => loc === 'C.utf8');
  if (cUtf8Lower) return cUtf8Lower;

  return utf8Locales[0];
}

// PTY flow-control thresholds (per terminal session).
const FLOW_HIGH_WATER = 512 * 1024;   // pause the PTY above this backlog
const FLOW_LOW_WATER = 64 * 1024;     // resume once drained below this
const FLOW_CHECK_INTERVAL_MS = 100;   // how often to poll for drain while paused
const FLOW_MAX_PAUSE_MS = 10_000;     // evict a stuck consumer after this long

export function createTerminalRouter(
  decks: Map<string, Deck>,
  terminals: Map<string, TerminalSession>,
  db: DatabaseSync
) {
  const router = new Hono();
  const tmuxSocket = terminalTmuxSocket(process.env.DECKIDE_TMUX_RUNTIME_DIR);
  const unavailableDisplays = new Set<string>();
  const insertTerminal = db.prepare(`INSERT INTO terminals
    (id, deck_id, title, command, created_at, cols, rows, tmux_socket)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateTerminal = db.prepare('UPDATE terminals SET deck_id = ?, title = ? WHERE id = ?');
  const deleteTerminal = db.prepare('DELETE FROM terminals WHERE id = ?');

  function toBuffer(data: Buffer | string): Buffer {
    return Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  }

  function appendToTerminalBuffer(session: TerminalSession, data: Buffer | string): void {
    const chunk = toBuffer(data);
    if (chunk.length === 0) {
      return;
    }

    if (chunk.length >= TERMINAL_BUFFER_LIMIT) {
      let cutPos = chunk.length - TERMINAL_BUFFER_LIMIT;
      cutPos = alignToUtf8Start(chunk, cutPos);
      let retained = Buffer.from(chunk.subarray(cutPos));
      // Skip partial escape sequence at the new start
      const escSkip = skipPartialEscapeSequence(retained, 0);
      if (escSkip > 0) {
        retained = Buffer.from(retained.subarray(escSkip));
      }
      session.bufferBase += session.bufferLength + cutPos + escSkip;
      session.bufferChunks = [retained];
      session.bufferLength = retained.length;
      return;
    }

    session.bufferChunks.push(Buffer.from(chunk));
    session.bufferLength += chunk.length;

    let trimmed = false;
    while (session.bufferLength > TERMINAL_BUFFER_LIMIT && session.bufferChunks.length > 0) {
      trimmed = true;
      const overflow = session.bufferLength - TERMINAL_BUFFER_LIMIT;
      const firstChunk = session.bufferChunks[0];

      if (firstChunk.length <= overflow) {
        session.bufferChunks.shift();
        session.bufferBase += firstChunk.length;
        session.bufferLength -= firstChunk.length;
        continue;
      }

      const cutPos = alignToUtf8Start(firstChunk, overflow);
      session.bufferChunks[0] = Buffer.from(firstChunk.subarray(cutPos));
      session.bufferBase += cutPos;
      session.bufferLength -= cutPos;
    }

    if (trimmed && session.bufferChunks.length > 0) {
      // After removing whole chunks, the new first chunk may start with
      // orphaned UTF-8 continuation bytes from a character that spanned chunks.
      const first = session.bufferChunks[0];
      const skip = alignToUtf8Start(first, 0);
      if (skip > 0) {
        session.bufferChunks[0] = Buffer.from(first.subarray(skip));
        session.bufferBase += skip;
        session.bufferLength -= skip;
      }

      // Also skip past any partial ANSI CSI escape sequence at the start.
      // Without this, orphaned parameter bytes like "100;50m" are rendered
      // as literal text and shift all cursor positions.
      const cur = session.bufferChunks[0];
      const escSkip = skipPartialEscapeSequence(cur, 0);
      if (escSkip > 0) {
        session.bufferChunks[0] = Buffer.from(cur.subarray(escSkip));
        session.bufferBase += escSkip;
        session.bufferLength -= escSkip;
      }
    }
  }

  function getUniqueTerminalTitle(deckId: string, requestedTitle?: string): string {
    const trimmedTitle = requestedTitle?.trim();
    const baseTitle = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : null;
    const existingTitles = new Set(
      Array.from(terminals.values())
        .filter((session) => session.deckId === deckId)
        .map((session) => session.title)
    );

    if (!baseTitle) {
      let index = 1;
      while (existingTitles.has(`${DEFAULT_TERMINAL_TITLE} ${index}`)) {
        index++;
      }
      return `${DEFAULT_TERMINAL_TITLE} ${index}`;
    }

    if (!existingTitles.has(baseTitle)) {
      return baseTitle;
    }

    let suffix = 2;
    while (existingTitles.has(`${baseTitle} ${suffix}`)) {
      suffix++;
    }
    return `${baseTitle} ${suffix}`;
  }

  function broadcastToSockets(session: TerminalSession, data: Buffer | string): void {
    const payload = toBuffer(data);
    const deadSockets = new Set<WebSocket>();
    session.sockets.forEach((socket) => {
      try {
        if (socket.readyState !== 1) {
          deadSockets.add(socket);
          return;
        }
        if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_AMOUNT) {
          try { socket.close(1009, 'Terminal output overflow'); } catch { /* ignore */ }
          deadSockets.add(socket);
          return;
        }
        socket.send(payload, { binary: true }, (error) => {
          if (error) {
            try { socket.close(1011, 'Terminal stream error'); } catch { /* ignore */ }
          }
        });
      } catch {
        deadSockets.add(socket);
      }
    });
    // resizeOwner（主クライアント）の付け替え・昇格は WebSocket の close
    // ハンドラに一元化する。ここで resizeOwner を null にすると、主ソケットが
    // 切断されたときの「残りクライアントへの昇格」が動かなくなるため触らない。
    deadSockets.forEach((s) => {
      session.sockets.delete(s);
    });
  }

  function handleTerminalExit(id: string): void {
    const session = terminals.get(id);
    if (!session) return;

    console.log(`[TERMINAL] Terminal ${id} exited`);
    deleteTerminal.run(id);
    terminals.delete(id);
    closeTerminalClients(session, 'Terminal exited');
    emitDeckIdeEvent({ type: 'terminal.removed', deckId: session.deckId, terminalId: id, reason: 'exited' });
  }

  function createTerminalSession(
    deck: Deck,
    title?: string,
    command?: string,
    cols: number = DEFAULT_TERMINAL_COLS,
    rows: number = DEFAULT_TERMINAL_ROWS,
    restored?: { id: string; title: string; command: string | null; createdAt: string }
  ): TerminalSession {
    const id = restored?.id ?? crypto.randomUUID();

    // Resolve shell and arguments
    let shell: string;
    let shellArgs: string[] = [];

    if (command) {
      const defaultShell = getDefaultShell();
      shell = defaultShell;
      if (process.platform === 'win32') {
        if (defaultShell.toLowerCase().includes('powershell')) {
          shellArgs = ['-NoExit', '-Command', command];
        } else {
          shellArgs = ['/K', command];
        }
      } else {
        shellArgs = ['-c', command];
      }
    } else {
      shell = getDefaultShell();
      // macOS のターミナルアプリはログインシェル（-l）で起動し
      // ~/.zprofile / ~/.bash_profile から PATH を読み込む。これに合わせる。
      // 一方 Linux の端末は通常「非ログインの対話シェル」で ~/.bashrc を読むため、
      // -l を付けると ~/.bash_profile を持たないユーザーが alias/関数を失う回帰になる。
      // そのため -l は darwin のみに限定する。
      if (process.platform === 'darwin' && POSIX_LOGIN_SHELLS.has(getShellBasename(shell))) {
        shellArgs = ['-l'];
      }
    }

    // Build environment
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.TERM = env.TERM || 'xterm-256color';
    // Lets `deckide` run inside this terminal find its server and act on
    // "this" deck/terminal by default (e.g. `deckide new` opens a sibling).
    env.DECKIDE_TERMINAL_ID = id;
    env.DECKIDE_DECK_ID = deck.id;
    env.DECKIDE_DATA_DIR = DATA_DIR;
    env.DECKIDE_PORT = String(PORT);
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'xterm.js';
    env.TERM_PROGRAM_VERSION = '5.5.0';

    if (process.platform === 'win32') {
      // Windows は従来どおり（locale -a 検出は行わない）。
      env.LANG = 'en_US.UTF-8';
    } else {
      // LC_ALL は設定しない（ユーザーの実ロケールを上書きしない）。
      // 継承した環境に有効な UTF-8 ロケールが無いときだけフォールバックを設定する。
      const hasInheritedUtf8 =
        isUtf8Locale(env.LC_ALL) ||
        isUtf8Locale(env.LANG) ||
        isUtf8Locale(env.LC_CTYPE);
      if (!hasInheritedUtf8) {
        const fallback = pickFallbackUtf8Locale(env.LANG);
        if (fallback) {
          // 実在するロケールのみを設定する（存在しないロケールは設定しない）。
          env.LANG = env.LANG || fallback;
          env.LC_CTYPE = env.LC_CTYPE || fallback;
        }
      }
    }

    const resolvedTitle = restored?.title ?? getUniqueTerminalTitle(deck.id, title);
    const createdAt = restored?.createdAt ?? new Date().toISOString();
    const savedCommand = restored?.command ?? command ?? null;
    if (!restored) {
      insertTerminal.run(id, deck.id, resolvedTitle, savedCommand, createdAt, cols, rows, tmuxSocket);
    }
    let processHandle: ReturnType<typeof openTerminalProcess>;
    try {
      processHandle = openTerminalProcess({
        id, shell, args: shellArgs, cwd: deck.root, cols, rows, env,
        socket: tmuxSocket, restore: Boolean(restored),
      });
    } catch (error) {
      // If tmux created the shell but its display failed, retain the record for
      // a future attachment. Creation failures never destroy that live shell.
      if (!restored && (!tmuxSocket || terminalTmuxStatus(tmuxSocket, id) === 'missing')) deleteTerminal.run(id);
      throw error;
    }
    const term = processHandle.pty;
    console.log(`[TERMINAL] ${restored ? 'Attached' : 'Created'} terminal ${id}: shell=${shell}, cwd=${deck.root}, pid=${term.pid}`);
    let detached = false;

    const session: TerminalSession = {
      id,
      deckId: deck.id,
      title: resolvedTitle,
      command: savedCommand,
      createdAt,
      sockets: new Set(),
      clients: new Map(),
      resizeOwner: null,
      cols,
      rows,
      lastResizeOffset: 0,
      resizeEpoch: 0,
      mirror: null,
      bufferChunks: [],
      bufferLength: 0,
      bufferBase: 0,
      lastActive: Date.now(),
      write: (data) => {
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
        try { term.write(payload); } catch { /* terminal may be dying */ }
      },
      resize: (cols, rows) => { try { term.resize(cols, rows); } catch { /* terminal may be dying */ } },
      kill: () => {
        processHandle.kill();
        deleteTerminal.run(id);
      },
      detach: () => {
        detached = true;
        if (!tmuxSocket) deleteTerminal.run(id);
        else db.prepare('UPDATE terminals SET cols = ?, rows = ? WHERE id = ?').run(session.cols, session.rows, id);
        resumePty();
        try { processHandle.detach(); } catch { /* already detached */ }
      },
    };
    session.mirror = createTerminalMirror({
      cols,
      rows,
      scrollback: TERMINAL_MIRROR_SCROLLBACK,
      currentOffset: () => session.bufferBase + session.bufferLength,
    });

    // ── Flow control ────────────────────────────────────────────────────
    // Instead of closing a slow client when its send buffer fills (which then
    // reconnects and re-replays, looking like the terminal "freezes" or jumps
    // during heavy output), pause the PTY when the slowest consumer falls
    // behind and resume once it drains.  A stuck consumer is evicted after a
    // grace period so it can't deadlock the terminal for everyone else.
    let ptyPaused = false;
    let resumeTimer: ReturnType<typeof setInterval> | null = null;
    let pausedAt = 0;

    const maxBufferedAmount = (): number => {
      let max = 0;
      session.sockets.forEach((socket) => {
        if (socket.readyState === 1 && socket.bufferedAmount > max) {
          max = socket.bufferedAmount;
        }
      });
      return max;
    };

    const evictLaggards = (threshold: number): void => {
      session.sockets.forEach((socket) => {
        if (socket.readyState === 1 && socket.bufferedAmount > threshold) {
          // close() で readyState は即 CLOSING になり、maxBufferedAmount の
          // 集計（OPEN のみ）から外れる。socket の削除と resizeOwner の昇格は
          // WebSocket の close ハンドラに任せる（主クライアント昇格のため）。
          try { socket.close(1009, 'Terminal output overflow'); } catch { /* ignore */ }
        }
      });
    };

    const resumePty = (): void => {
      if (resumeTimer) {
        clearInterval(resumeTimer);
        resumeTimer = null;
      }
      if (!ptyPaused) return;
      ptyPaused = false;
      try { term.resume(); } catch { /* terminal may be dying */ }
    };

    const pausePty = (): void => {
      if (ptyPaused) return;
      ptyPaused = true;
      pausedAt = Date.now();
      try { term.pause(); } catch { /* terminal may be dying */ }
      resumeTimer = setInterval(() => {
        if (maxBufferedAmount() < FLOW_LOW_WATER) {
          resumePty();
          return;
        }
        if (Date.now() - pausedAt > FLOW_MAX_PAUSE_MS) {
          // A consumer is stuck — drop it rather than freeze everyone.
          evictLaggards(FLOW_LOW_WATER);
          if (maxBufferedAmount() < FLOW_LOW_WATER) {
            resumePty();
          } else {
            pausedAt = Date.now();
          }
        }
      }, FLOW_CHECK_INTERVAL_MS);
      resumeTimer.unref?.();
    };

    // Wire up PTY output → buffer + WebSocket broadcast
    (term as unknown as { on(eventName: 'data', listener: (data: Buffer | string) => void): void }).on('data', (data) => {
      const chunk = toBuffer(data);
      session.mirror?.write(chunk);
      appendToTerminalBuffer(session, chunk);
      session.lastActive = Date.now();
      broadcastToSockets(session, chunk);
      if (!ptyPaused && maxBufferedAmount() > FLOW_HIGH_WATER) {
        pausePty();
      }
    });

    term.onExit(() => {
      resumePty();
      if (detached || terminals.get(id) !== session) return;
      // A display client may disconnect while the tmux-owned shell is alive.
      // Keep its metadata for restoration instead of deleting or killing it.
      if (tmuxSocket && terminalTmuxStatus(tmuxSocket, id) !== 'missing') {
        unavailableDisplays.add(id);
        closeTerminalClients(session, 'Terminal display disconnected');
        restoreSessions();
        return;
      }
      handleTerminalExit(id);
    });

    terminals.set(id, session);
    unavailableDisplays.delete(id);
    emitDeckIdeEvent({
      type: 'terminal.created',
      deckId: deck.id,
      terminal: { id, title: resolvedTitle, createdAt },
    });

    return session;
  }

  function requireTerminal(id: string): TerminalSession {
    if (unavailableDisplays.has(id)) restoreSessions();
    if (unavailableDisplays.has(id)) throw createHttpError('Terminal display unavailable', 503);
    const session = terminals.get(id);
    if (!session) throw createHttpError('Terminal not found', 404);
    return session;
  }

  // ?deckId= limits to one deck; without it every terminal is listed (CLI).
  router.get('/', (c) => {
    restoreSessions();
    const deckId = c.req.query('deckId');
    const sessions = Array.from(terminals.values())
      .filter((session) => !deckId || session.deckId === deckId)
      .map(describeTerminal);
    sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return c.json(sessions);
  });

  router.get('/:id', (c) => {
    try {
      return c.json(describeTerminal(requireTerminal(c.req.param('id'))));
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Metadata only: never send input, detach clients, resize, or recreate the PTY.
  router.patch('/:id', async (c) => {
    try {
      const session = requireTerminal(c.req.param('id'));
      const body = await readJson<{ deckId?: unknown; title?: unknown }>(c);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          (body.deckId === undefined && body.title === undefined)) {
        throw createHttpError('deckId or title is required', 400);
      }
      if (body.deckId !== undefined && (typeof body.deckId !== 'string' || !body.deckId.trim())) {
        throw createHttpError('deckId must be a nonblank string', 400);
      }
      if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
        throw createHttpError('title must be a nonblank string', 400);
      }
      const deckId = body.deckId === undefined ? session.deckId : body.deckId as string;
      const title = body.title === undefined ? session.title : (body.title as string).trim();
      if (!decks.has(deckId)) throw createHttpError('Deck not found', 404);
      const previousDeckId = session.deckId;
      // Persist first. A missing row or SQLite failure must leave memory intact.
      const result = updateTerminal.run(deckId, title, session.id);
      if (result.changes !== 1) throw createHttpError('Terminal metadata not found', 409);
      session.deckId = deckId;
      session.title = title;
      emitDeckIdeEvent({ type: 'terminal.updated', deckId, previousDeckId,
        terminal: { id: session.id, title, createdAt: session.createdAt } });
      return c.json(describeTerminal(session));
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Send keyboard input without attaching (CLI `deckide send`).
  router.post('/:id/input', async (c) => {
    try {
      const session = requireTerminal(c.req.param('id'));
      const body = await readJson<{ data?: unknown }>(c);
      if (typeof body?.data !== 'string') throw createHttpError('data must be a string', 400);
      const bytes = Buffer.byteLength(body.data, 'utf8');
      if (bytes > MAX_HTTP_INPUT_BYTES) throw createHttpError('data is too large', 413);
      session.write(body.data);
      session.lastActive = Date.now();
      return c.json({ bytesWritten: bytes });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Set the PTY size for every client (resizes are otherwise driven by the
  // primary client's viewport, which takes over again when it next resizes).
  router.post('/:id/resize', async (c) => {
    try {
      const session = requireTerminal(c.req.param('id'));
      const body = await readJson<{ cols?: unknown; rows?: unknown }>(c);
      const cols = clampTerminalSize(body?.cols, session.cols);
      const rows = clampTerminalSize(body?.rows, session.rows);
      resizeTerminal(session, cols, rows);
      return c.json({ cols: session.cols, rows: session.rows });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Ask open web UIs to bring this terminal to the front.
  router.post('/:id/focus', (c) => {
    try {
      const session = requireTerminal(c.req.param('id'));
      emitDeckIdeEvent({ type: 'ui.focus', deckId: session.deckId, terminalId: session.id });
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.post('/', async (c) => {
    try {
      const body = await readJson<{
        deckId?: string;
        title?: string;
        command?: string;
        cols?: number;
        rows?: number;
      }>(c);
      const deckId = body?.deckId;
      if (!deckId) throw createHttpError('deckId is required', 400);
      const deck = decks.get(deckId);
      if (!deck) throw createHttpError('Deck not found', 404);
      const cols = clampTerminalSize(body?.cols, DEFAULT_TERMINAL_COLS);
      const rows = clampTerminalSize(body?.rows, DEFAULT_TERMINAL_ROWS);
      const session = createTerminalSession(deck, body?.title, body?.command, cols, rows);
      return c.json({ id: session.id, title: session.title, deckId: deck.id, cols, rows }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.delete('/:id', async (c) => {
    try {
      const terminalId = c.req.param('id');
      const session = terminals.get(terminalId);
      if (!session) throw createHttpError('Terminal not found', 404);

      session.kill();
      terminals.delete(terminalId);
      closeTerminalClients(session, 'Terminal deleted');
      emitDeckIdeEvent({ type: 'terminal.removed', deckId: session.deckId, terminalId, reason: 'deleted' });

      return c.body(null, 204);
    } catch (error) {
      return handleError(c, error);
    }
  });

  function restoreSessions() {
    if (!tmuxSocket) return;
    const rows = db.prepare('SELECT * FROM terminals WHERE tmux_socket = ? ORDER BY created_at').all(tmuxSocket);
    for (const row of rows) {
      const id = String(row.id);
      if (terminals.has(id) && !unavailableDisplays.has(id)) continue;
      const deck = decks.get(String(row.deck_id));
      if (!deck) continue; // Discovery never destroys unrecognized sessions.
      if (!hasTerminalTmuxSession(tmuxSocket, id)) continue;
      try {
        createTerminalSession(deck, undefined, undefined, Number(row.cols), Number(row.rows), {
          id, title: String(row.title), command: row.command === null ? null : String(row.command),
          createdAt: String(row.created_at),
        });
      } catch (error) {
        // Keep a failed display in the Map so explicit deletion still owns the
        // live tmux session; a later read retries attachment without recreating it.
        console.error(`[TERMINAL] Unable to attach ${id}:`, error);
      }
    }
  }

  return Object.assign(router, { restoreSessions });
}
