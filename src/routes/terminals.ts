import crypto from 'node:crypto';
import { Hono } from 'hono';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import type { Deck, TerminalSession } from '../types.js';
import { TERMINAL_BUFFER_LIMIT } from '../config.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { getDefaultShell, getAvailableLocales, getShellBasename } from '../utils/shell.js';
import { alignToUtf8Start, skipPartialEscapeSequence } from '../utils/utf8.js';

const DEFAULT_TERMINAL_TITLE = 'ターミナル';
const MAX_SOCKET_BUFFERED_AMOUNT = 1024 * 1024;

// 初期端末サイズ（リクエストで指定がない場合のデフォルト）。
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;
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

// PTY flow-control thresholds (per terminal session).
const FLOW_HIGH_WATER = 512 * 1024;   // pause the PTY above this backlog
const FLOW_LOW_WATER = 64 * 1024;     // resume once drained below this
const FLOW_CHECK_INTERVAL_MS = 100;   // how often to poll for drain while paused
const FLOW_MAX_PAUSE_MS = 10_000;     // evict a stuck consumer after this long

export function createTerminalRouter(
  decks: Map<string, Deck>,
  terminals: Map<string, TerminalSession>
) {
  const router = new Hono();

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
    terminals.delete(id);

    session.sockets.forEach((socket) => {
      try { socket.close(1000, 'Terminal exited'); } catch { /* ignore */ }
    });
    session.sockets.clear();
    session.resizeOwner = null;
  }

  function createTerminalSession(
    deck: Deck,
    title?: string,
    command?: string,
    cols: number = DEFAULT_TERMINAL_COLS,
    rows: number = DEFAULT_TERMINAL_ROWS
  ): TerminalSession {
    const id = crypto.randomUUID();

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

    // Spawn PTY directly in this process
    const isWindows = process.platform === 'win32';
    const term: IPty = spawn(shell, shellArgs, {
      cwd: deck.root,
      cols,
      rows,
      env,
      encoding: null,
      ...(isWindows ? { useConpty: true } : {}),
    } as any);

    console.log(`[TERMINAL] Created terminal ${id}: shell=${shell}, cwd=${deck.root}, pid=${term.pid}`);

    const resolvedTitle = getUniqueTerminalTitle(deck.id, title);
    const createdAt = new Date().toISOString();

    const session: TerminalSession = {
      id,
      deckId: deck.id,
      title: resolvedTitle,
      command: command || null,
      createdAt,
      sockets: new Set(),
      resizeOwner: null,
      bufferChunks: [],
      bufferLength: 0,
      bufferBase: 0,
      lastActive: Date.now(),
      write: (data) => {
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
        try { term.write(payload); } catch { /* terminal may be dying */ }
      },
      resize: (cols, rows) => { try { term.resize(cols, rows); } catch { /* terminal may be dying */ } },
      kill: () => { try { term.kill(); } catch { /* already dead */ } },
    };

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
      appendToTerminalBuffer(session, data);
      session.lastActive = Date.now();
      broadcastToSockets(session, data);
      if (!ptyPaused && maxBufferedAmount() > FLOW_HIGH_WATER) {
        pausePty();
      }
    });

    term.onExit(() => {
      resumePty();
      handleTerminalExit(id);
    });

    terminals.set(id, session);

    return session;
  }

  router.get('/', (c) => {
    const deckId = c.req.query('deckId');
    if (!deckId) {
      return c.json({ error: 'deckId is required' }, 400);
    }
    const sessions: Array<{ id: string; title: string; createdAt: string }> = [];
    terminals.forEach((session) => {
      if (session.deckId === deckId) {
        sessions.push({ id: session.id, title: session.title, createdAt: session.createdAt });
      }
    });
    sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
      const cols = normalizeTerminalSize(body?.cols, DEFAULT_TERMINAL_COLS);
      const rows = normalizeTerminalSize(body?.rows, DEFAULT_TERMINAL_ROWS);
      const session = createTerminalSession(deck, body?.title, body?.command, cols, rows);
      return c.json({ id: session.id, title: session.title }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.delete('/:id', async (c) => {
    try {
      const terminalId = c.req.param('id');
      const session = terminals.get(terminalId);
      if (!session) throw createHttpError('Terminal not found', 404);

      terminals.delete(terminalId);

      session.sockets.forEach((socket) => {
        try { socket.close(1000, 'Terminal deleted'); } catch { /* ignore */ }
      });
      session.sockets.clear();
      session.resizeOwner = null;

      session.kill();

      return c.body(null, 204);
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
