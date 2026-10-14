import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { persistTerminalMetadata, commitTerminalMetadata } from '../utils/database.js';
import { Hono } from 'hono';
import path from 'node:path';
import { TerminalSnapshot } from '../terminal/snapshot.js';
import { TmuxTerminalAdapter, type TmuxTerminalMeta } from '../terminal/tmuxAdapter.js';
import type { Deck, TerminalSession, Workspace } from '../types.js';
import type { HostComputerSessions, HostSessionCreator } from '../computer/host-session.js';
import { currentSession, isAuthEnabled, verifiedInternalActor } from '../middleware/auth.js';
import { mcpGrantForActor } from './mcp.js';
import { PORT, TERMINAL_BUFFER_LIMIT, TERMINAL_OUTPUT_COALESCE_MS, dataDir } from '../config.js';
import { cancelOutputFlush, flushOutput, scheduleOutputFlush } from '../websocket.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { getDefaultShell, getAvailableLocales, getShellBasename } from '../utils/shell.js';
import { alignToUtf8Start, skipPartialEscapeSequence } from '../utils/utf8.js';
import { emitDeckIdeEvent } from '../utils/events.js';

const DEFAULT_TERMINAL_TITLE = 'ターミナル';

// 初期端末サイズ（リクエストで指定がない場合のデフォルト）。
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;
const LIST_RESTORE_FRESH_MS = 3000;
// WebSocket の resize と同じ範囲でバリデーションする。
const MIN_TERMINAL_SIZE = 1;
const MAX_TERMINAL_SIZE = 500;

// ログインシェルとして扱う POSIX シェルのベース名。
const POSIX_LOGIN_SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'csh', 'tcsh']);

function isUtf8Locale(value: string | undefined): boolean {
  if (!value) return false;
  return /\.(utf-?8)$/i.test(value);
}

/**
 * リクエストボディの cols/rows を整数化し 1..500 の範囲に収める。
 * 数値でない場合は fallback を返す。
 */
function normalizeTerminalSize(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.floor(value);
  if (intValue < MIN_TERMINAL_SIZE) return MIN_TERMINAL_SIZE;
  if (intValue > MAX_TERMINAL_SIZE) return MAX_TERMINAL_SIZE;
  return intValue;
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

export function createTerminalRouter(
  decks: Map<string, Deck>,
  terminals: Map<string, TerminalSession>,
  options: { db?: DatabaseSync; hostSessions?: HostComputerSessions; workspaces?: Map<string, Workspace> } = {}
) {
  const router = new Hono();
  const backend = new TmuxTerminalAdapter({ runtimeDir: process.env.DECKIDE_TMUX_RUNTIME_DIR || path.resolve(dataDir, 'terminal-tmux') });
  const restoring = new Map<string, Promise<void>>();

  async function restoreSession(meta: TmuxTerminalMeta): Promise<void> {
    const existing = terminals.get(meta.id);
    const sameNativeIdentity = existing && ['generation', 'serverPid', 'sessionId', 'windowId', 'paneId', 'pid']
      .every((key) => existing.tmux[key as keyof TmuxTerminalMeta] === meta[key as keyof TmuxTerminalMeta]);
    if (existing && (existing.deckId !== meta.deckId || !sameNativeIdentity)) {
      options.hostSessions?.revokeTerminal(meta.id);
    }
    try { if (options.db) persistTerminalMetadata(options.db, meta); }
    catch (error) {
      if (existing && (existing.deckId !== meta.deckId || !sameNativeIdentity)) existing.detach();
      throw error;
    }
    if (existing?.available && !sameNativeIdentity) {
      options.hostSessions?.revokeTerminal(meta.id);
      existing.detach();
    }
    if (existing?.available) {
      const previousDeckId = existing.deckId;
      const changed = previousDeckId !== meta.deckId || existing.title !== meta.title;
      existing.deckId = meta.deckId;
      existing.title = meta.title;
      Object.assign(existing.tmux, meta);
      if (changed) emitDeckIdeEvent({ type: 'terminal.updated', previousDeckId, deckId: meta.deckId,
        terminal: { id: meta.id, title: meta.title, createdAt: meta.createdAt } });
      return;
    }
    const pending = restoring.get(meta.id);
    if (pending) return pending;
    const deck = decks.get(meta.deckId);
    if (!deck) return; // Never close an unrecognized session during discovery.
    const task = createTerminalSession(deck, meta.title, undefined, meta.cols, meta.rows, meta).then(() => undefined);
    restoring.set(meta.id, task);
    try { await task; } finally { restoring.delete(meta.id); }
  }

  async function restoreSessions(): Promise<void> {
    const unavailable = new Set<string>();
    const verifiedExited = new Set<string>();
    const records = backend.list((id) => {
      unavailable.add(id);
      const session = terminals.get(id);
      if (session?.available) {
        session.detach();
        for (const socket of session.sockets) {
          try { socket.close(1013, 'Terminal identity unavailable'); } catch { /* closed */ }
        }
      }
      console.warn(`[TERMINAL] ${id} unavailable; registry retained`);
    }, (id) => verifiedExited.add(id));
    const liveIds = new Set(records.map((meta) => meta.id));
    for (const session of terminals.values()) {
      if (!liveIds.has(session.id) && !unavailable.has(session.id)) {
        session.detach();
        if (verifiedExited.has(session.id)) handleTerminalExit(session.id);
        else {
          for (const socket of session.sockets) {
            try { socket.close(1013, 'Terminal registry unavailable'); } catch { /* closed */ }
          }
          console.warn(`[TERMINAL] ${session.id} registry unavailable; shell state unknown`);
        }
      }
    }
    for (const id of verifiedExited) {
      options.db?.prepare('DELETE FROM terminal_metadata WHERE id = ?').run(id);
    }
    for (const meta of records) {
      try { await restoreSession(meta); }
      catch { console.warn(`[TERMINAL] ${meta.id} display unavailable; shell retained`); }
    }
  }

  // Listing is hot (every web UI, CLI and agent polls it) and restoreSessions()
  // verifies every registry entry with synchronous tmux calls, blocking the event
  // loop. Lists share one recent verification instead of each running their own.
  let listRestore: Promise<void> | null = null;
  let listRestoredAt = 0;
  function restoreSessionsForList(): Promise<void> {
    if (listRestore) return listRestore;
    if (Date.now() - listRestoredAt < LIST_RESTORE_FRESH_MS) return Promise.resolve();
    listRestore = restoreSessions().finally(() => {
      listRestoredAt = Date.now();
      listRestore = null;
    });
    return listRestore;
  }

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

  function handleTerminalExit(id: string): void {
    options.hostSessions?.revokeTerminal(id);
    options.db?.prepare('DELETE FROM terminal_metadata WHERE id = ?').run(id);
    const session = terminals.get(id);
    if (!session) return;

    console.log(`[TERMINAL] Terminal ${id} exited`);
    flushOutput(session);
    cancelOutputFlush(session);
    terminals.delete(id);
    emitDeckIdeEvent({ type: 'terminal.removed', deckId: session.deckId, terminalId: id, reason: 'exited' });

    session.sockets.forEach((socket) => {
      try { socket.close(1000, 'Terminal exited'); } catch { /* ignore */ }
    });
    session.sockets.clear();
  }

  async function createTerminalSession(
    deck: Deck,
    title?: string,
    command?: string,
    cols: number = DEFAULT_TERMINAL_COLS,
    rows: number = DEFAULT_TERMINAL_ROWS,
    restored?: TmuxTerminalMeta,
    creator?: HostSessionCreator
  ): Promise<TerminalSession> {
    const id = restored?.id || crypto.randomUUID();

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
    // A process-level environment cannot authorize a new or restored terminal.
    // Only a fresh interactive shell receives its own one-use capability.
    delete env.DECKIDE_COMPUTER_SESSION_CAPABILITY;
    delete env.DECKIDE_COMPUTER_MCP_URL;
    delete env.DECKIDE_MCP_ACCESS_TOKEN;
    delete env.DECKIDE_MCP_ACCESS_TOKEN_FD;
    const capability = !restored && !command && creator && options.hostSessions
      ? options.hostSessions.issueForTerminal(id, deck, creator) : null;
    if (capability) {
      env.DECKIDE_COMPUTER_SESSION_CAPABILITY = capability;
      env.DECKIDE_COMPUTER_MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
    }
    env.TERM = env.TERM || 'xterm-256color';
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

    const resolvedTitle = restored?.title || getUniqueTerminalTitle(deck.id, title);
    const createdAt = restored?.createdAt || new Date().toISOString();
    let term;
    try {
      term = restored ? await backend.attach(restored) : await backend.create({
        id, deckId: deck.id, title: resolvedTitle, command: command || null,
        createdAt, shell, args: shellArgs, cwd: deck.root, cols, rows, env,
      });
    } catch (error) {
      if (capability) options.hostSessions?.revokeTerminal(id);
      throw error;
    }
    try { if (options.db) persistTerminalMetadata(options.db, term.meta); }
    catch (error) { term.detach(); throw error; } // Keep the canonical registry and native shell.
    cols = term.meta.cols;
    rows = term.meta.rows;
    console.log(`[TERMINAL] ${restored ? 'Attached' : 'Created'} terminal ${id}: pid=${term.pid}`);

    const screen = new TerminalSnapshot({ cols, rows, onResponse: (response) => {
      try { term.write(response); } catch { /* Display disconnected; never retry a response. */ }
    }, onFailure: () => disconnectBridge() });
    let queuedScreenBytes = 0;

    const session: TerminalSession = {
      id,
      deckId: deck.id,
      title: resolvedTitle,
      command: command || null,
      createdAt,
      cols, rows, pid: term.pid, tmux: term.meta,
      available: true, bufferEpoch: crypto.randomUUID(),
      snapshot: () => screen.capture(),
      sockets: new Set(),
      bufferChunks: [],
      bufferLength: 0,
      bufferBase: 0,
      lastActive: Date.now(),
      write: (data) => {
        if (!session.available) throw createHttpError('Terminal transport unavailable; input was not retried', 503);
        term.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
      },
      resize: (nextCols, nextRows) => {
        if (!session.available) throw createHttpError('Terminal transport unavailable', 503);
        // Clients re-assert their size whenever they are used; only real
        // changes resize tmux and notify viewers.
        if (nextCols === session.cols && nextRows === session.rows) return;
        term.resize(nextCols, nextRows);
        screen.resize(nextCols, nextRows, () => {
          if (!session.available) return;
          // Every viewer applies the size after the output written before it.
          flushOutput(session, undefined, true);
          for (const socket of session.sockets) {
            if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'size', cols: nextCols, rows: nextRows }));
          }
        });
        session.cols = nextCols;
        session.rows = nextRows;
        session.tmux = term.meta;
        if (options.db) persistTerminalMetadata(options.db, term.meta);
      },
      kill: async () => { await term.close(); await screen.dispose(); },
      detach: () => { session.available = false; cancelOutputFlush(session); term.detach(); screen.dispose(); },
    };

    // Slow viewers are bounded individually by flushOutput. A display
    // projection backlog reconnects our client without interrupting the shell.
    const disconnectBridge = () => {
      if (terminals.get(id) !== session || !session.available) return;
      session.available = false;
      cancelOutputFlush(session);
      term.detach();
      screen.dispose();
      for (const socket of session.sockets) {
        try { socket.close(1013, 'Terminal transport disconnected'); } catch { /* closed */ }
      }
      void restoreSession(term.meta).catch(() => undefined);
    };

    // Project only live tmux display output. Snapshot serialization never writes to tmux.
    term.on('data', (data) => {
      if (!session.available) return;
      const chunk = toBuffer(data);
      queuedScreenBytes += chunk.length;
      if (queuedScreenBytes > 4 * 1024 * 1024) { disconnectBridge(); return; }
      screen.write(chunk, () => {
        queuedScreenBytes -= chunk.length;
        if (!session.available) return;
        appendToTerminalBuffer(session, chunk);
        session.lastActive = Date.now();
        scheduleOutputFlush(session, chunk.length, TERMINAL_OUTPUT_COALESCE_MS);
      });
    });

    term.onExit(() => {
      if (terminals.get(id) === session) handleTerminalExit(id);
      screen.dispose();
    });
    term.on('disconnect', disconnectBridge);

    terminals.set(id, session);
    emitDeckIdeEvent({ type: 'terminal.created', deckId: deck.id, terminal: { id, title: session.title, createdAt: session.createdAt } });
    if (capability && options.hostSessions) {
      let attempts = 0;
      const activate = () => {
        if (options.hostSessions?.activateTerminal(id, term.pid, session)) return;
        if (++attempts >= 25 || terminals.get(id) !== session) {
          options.hostSessions?.revokeTerminal(id);
          return;
        }
        const retry = setTimeout(activate, 20);
        retry.unref();
      };
      activate();
    }

    return session;
  }

  // GET /api/terminals?deckId=ID lists one deck; without deckId, every terminal.
  router.get('/', async (c) => {
    const deckId = c.req.query('deckId');
    try { await restoreSessionsForList(); } catch (error) { return handleError(c, error); }
    const sessions: Array<Record<string, unknown>> = [];
    terminals.forEach((session) => {
      if (!deckId || session.deckId === deckId) {
        sessions.push({ id: session.id, deckId: session.deckId, title: session.title, createdAt: session.createdAt, cols: session.cols, rows: session.rows, pid: session.pid, tmux: session.tmux, available: session.available });
      }
    });
    sessions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return c.json(sessions);
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
      let creator: HostSessionCreator | undefined;
      if (options.hostSessions && options.workspaces && isAuthEnabled()) {
        const browser = currentSession(c);
        const oauthActor = verifiedInternalActor(c);
        if (browser && !browser.session.guest) {
          creator = { kind: 'browser', sessionKey: browser.key };
        } else if (oauthActor) {
          const grant = mcpGrantForActor(oauthActor);
          if (grant) creator = { kind: 'oauth', actor: oauthActor,
            issuerSessionKey: grant.issuerSessionKey };
        }
      }
      const cols = normalizeTerminalSize(body?.cols, DEFAULT_TERMINAL_COLS);
      const rows = normalizeTerminalSize(body?.rows, DEFAULT_TERMINAL_ROWS);
      const session = await createTerminalSession(deck, body?.title, body?.command, cols, rows, undefined, creator);
      return c.json({ id: session.id, title: session.title, cols: session.cols, rows: session.rows, pid: session.pid, tmux: session.tmux }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.patch('/:id', async (c) => {
    try {
      const session = terminals.get(c.req.param('id'));
      if (!session) throw createHttpError('Terminal not found', 404);
      if (!session.available) throw createHttpError('Terminal unavailable', 503);
      const body = await readJson<Record<string, unknown>>(c);
      if (!body || Array.isArray(body) || !Object.keys(body).length ||
          Object.keys(body).some((key) => key !== 'deckId' && key !== 'title')) {
        throw createHttpError('deckId or title is required', 400);
      }
      if ('deckId' in body && (typeof body.deckId !== 'string' || !decks.has(body.deckId))) {
        throw createHttpError(typeof body.deckId === 'string' ? 'Deck not found' : 'Invalid deckId', typeof body.deckId === 'string' ? 404 : 400);
      }
      if ('title' in body && (typeof body.title !== 'string' || !body.title.trim())) {
        throw createHttpError('title must be a non-empty string', 400);
      }
      const previous = { ...session.tmux };
      const next = { ...previous, deckId: body.deckId as string ?? session.deckId,
        title: typeof body.title === 'string' ? body.title.trim() : session.title, command: null };
      if (next.deckId === session.deckId && next.title === session.title) {
        backend.verify(previous);
        return c.json({ id: session.id, deckId: session.deckId, title: session.title, createdAt: session.createdAt });
      }
      if (!options.db) throw createHttpError('Metadata persistence unavailable', 503);
      try {
        commitTerminalMetadata(options.db, next,
          () => { backend.updateMetadata(previous, { deckId: next.deckId, title: next.title }); },
          () => { backend.updateMetadata(next, { deckId: previous.deckId, title: previous.title }); });
      } catch (error) {
        // If compensation also failed, prevent stale metadata from authorizing further operations.
        // Restore/list reconciles verified canonical registry metadata before reattaching.
        if ((error as { metadataUncertain?: boolean }).metadataUncertain) {
          options.hostSessions?.revokeTerminal(session.id);
          session.detach();
        }
        throw error;
      }
      const previousDeckId = session.deckId;
      session.deckId = next.deckId;
      session.title = next.title;
      Object.assign(session.tmux, next);
      if (previousDeckId !== next.deckId) options.hostSessions?.revokeTerminal(session.id);
      emitDeckIdeEvent({ type: 'terminal.updated', previousDeckId, deckId: next.deckId,
        terminal: { id: session.id, title: session.title, createdAt: session.createdAt } });
      return c.json({ id: session.id, deckId: session.deckId, title: session.title, createdAt: session.createdAt });
    } catch (error) { return handleError(c, error); }
  });

  router.delete('/:id', async (c) => {
    try {
      const terminalId = c.req.param('id');
      const session = terminals.get(terminalId);
      if (!session) throw createHttpError('Terminal not found', 404);

      await session.kill();
      options.db?.prepare('DELETE FROM terminal_metadata WHERE id = ?').run(terminalId);
      terminals.delete(terminalId);
      options.hostSessions?.revokeTerminal(terminalId);
      emitDeckIdeEvent({ type: 'terminal.removed', deckId: session.deckId, terminalId, reason: 'deleted' });

      session.sockets.forEach((socket) => {
        try { socket.close(1000, 'Terminal deleted'); } catch { /* ignore */ }
      });
      session.sockets.clear();

      return c.body(null, 204);
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Bring a terminal to the front in every open web UI (CLI `deckide session show`).
  router.post('/:id/focus', (c) => {
    const session = terminals.get(c.req.param('id'));
    if (!session) return c.json({ error: 'Terminal not found' }, 404);
    emitDeckIdeEvent({ type: 'ui.focus', deckId: session.deckId, terminalId: session.id });
    return c.json({ ok: true });
  });

  // Type into a terminal without attaching (CLI `deckide session send`).
  router.post('/:id/input', async (c) => {
    try {
      const session = terminals.get(c.req.param('id'));
      if (!session) throw createHttpError('Terminal not found', 404);
      const body = await readJson<{ data?: unknown }>(c);
      if (typeof body?.data !== 'string' || Buffer.byteLength(body.data) > 1024 * 1024) {
        throw createHttpError('data must be a string of at most 1 MiB', 400);
      }
      session.write(body.data);
      session.lastActive = Date.now();
      return c.json({ id: session.id, bytes: Buffer.byteLength(body.data) });
    } catch (error) { return handleError(c, error); }
  });

  router.put('/:id/size', async (c) => {
    try {
      const session = terminals.get(c.req.param('id'));
      if (!session) throw createHttpError('Terminal not found', 404);
      const body = await readJson<{ cols?: number; rows?: number }>(c);
      if (![body?.cols, body?.rows].every((value) => Number.isInteger(value) && value! >= 1 && value! <= 500)) {
        throw createHttpError('cols and rows must be integers from 1 to 500', 400);
      }
      session.resize(body.cols!, body.rows!);
      return c.json({ id: session.id, cols: session.cols, rows: session.rows });
    } catch (error) { return handleError(c, error); }
  });

  return Object.assign(router, { restoreSessions, hasNativeTerminals: (deckId: string) => backend.hasDeckRecords(deckId),
    inspectNativeTerminals: (deckId: string) => backend.inspectDeckRecords(deckId),
    inspectTerminalRecord: (id: string, socketPath?: string | null) => backend.inspectTerminalRecord(id, socketPath),
    pruneNativeTerminals: (deckId: string, expected?: import('../terminal/tmuxAdapter.js').TerminalRecordStatus[]) => backend.pruneDeadRecords(deckId, expected), nativeAttachment: (id: string, readOnly = false) => {
    const session = terminals.get(id);
    if (!session?.available) throw Error('Terminal unavailable');
    return backend.nativeAttachment(id, readOnly);
  } });
}
