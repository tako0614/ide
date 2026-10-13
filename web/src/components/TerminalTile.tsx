import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSession } from '../types';
import { getWsToken } from '../api';
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_BACKGROUND_COLOR,
  TERMINAL_FOREGROUND_COLOR,
  TERMINAL_ANSI_PALETTE,
  TERMINAL_CURSOR_COLOR,
  TERMINAL_SELECTION_BACKGROUND
} from '../constants';
import { registerTerminalQueryHandlers } from './terminalQueries';
import { attachTerminalKeymap } from './terminalKeymap';
import { createTerminalReconnect } from './terminalReconnect';
import { applyStickyModifiers, registerTerminalInput } from './terminalInput';
import { buildTerminalSocketUrl, computeViewportScale, isTerminalReport } from './terminalViewport';

interface TerminalTileProps {
  session: TerminalSession;
  wsUrl: string;
  onDelete: () => void;
  onExit: () => void;
  // OSC 0/2 で受け取った動的タイトルを親へ通知（端末セレクタの表示用）。
  onTitle?: (title: string | null) => void;
  // この端末がデッキのアクティブ端末か（グリッドでの強調表示用）。
  isActive?: boolean;
  // クリック/フォーカスでこの端末をアクティブにする（activeTerminalId を同期）。
  onSetActive?: () => void;
  // 最大化トグル。渡された場合のみタイルヘッダに最大化ボタンを表示する。
  onToggleMaximize?: () => void;
  // 現在この端末が単一表示（最大化/モバイル）で前面かどうか。ボタンの図柄に使う。
  maximized?: boolean;
  // 単一表示で前面になった瞬間にこの端末へフォーカスを移す。
  autoFocus?: boolean;
}

const TERMINAL_REMOVED_REASONS = new Set([
  'Deck deleted',
  'Terminal deleted',
  'Terminal exited',
  'Terminal not found'
]);

// Protocol (see src/utils/terminal-control.ts). The server owns the PTY size:
// every client renders at exactly cols×rows, and the "primary" client — the
// one most recently used — is the one whose viewport the PTY follows.
type ServerControlMessage =
  | { type: 'sync'; offsetBase: number; reset: boolean; cols?: number; rows?: number; snapshot?: boolean }
  | { type: 'ready' }
  // この接続が「主」クライアントか（PTY サイズを決め、端末クエリに応答する）。
  | { type: 'primary'; value: boolean }
  | { type: 'size'; cols: number; rows: number };

type ClientControlMessage =
  | { type: 'claim'; cols?: number; rows?: number }
  | { type: 'resize'; cols: number; rows: number };

// Width FitAddon reserves for xterm's scrollbar (options.overviewRuler absent).
const SCROLLBAR_WIDTH = 14;
// Movement (px) under which a touch counts as a tap rather than a scroll.
const TAP_SLOP = 10;

interface TerminalViewState {
  primary: boolean;
  cols: number;
  rows: number;
  scale: number;
}

const textEncoder = new TextEncoder();

// Keep each input frame well under the server's 64KB maxPayload so a large
// paste is split across frames instead of tripping the 1009 "message too
// large" close, which would drop the terminal mid-paste.
const MAX_INPUT_CHUNK = 48 * 1024;
const FONT_SIZE_STORAGE_KEY = 'deckide-terminal-font';
const MIN_FONT_SIZE = 11;
const MAX_FONT_SIZE = 22;

function readFontSize(): number {
  try {
    const saved = Number(localStorage.getItem(FONT_SIZE_STORAGE_KEY));
    return saved > 0 && Number.isFinite(saved)
      ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, saved))
      : TERMINAL_FONT_SIZE;
  } catch {
    return TERMINAL_FONT_SIZE;
  }
}

function encodeBinaryInput(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    bytes[i] = data.charCodeAt(i) & 0xff;
  }
  return bytes;
}

export function TerminalTile({
  session,
  wsUrl,
  onDelete,
  onExit,
  onTitle,
  isActive,
  onSetActive,
  onToggleMaximize,
  maximized,
  autoFocus
}: TerminalTileProps) {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitNowRef = useRef<(() => void) | null>(null);
  const claimRef = useRef<(() => void) | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const processedOffsetRef = useRef<number>(0);
  const onExitRef = useRef(onExit);
  const onTitleRef = useRef(onTitle);
  // フォーカス時にアクティブ端末を同期するためのコールバック参照（再接続 effect の
  // 再実行を避けるため ref 経由で最新値を参照する）。
  const onSetActiveRef = useRef(onSetActive);
  const isActiveRef = useRef(isActive);

  // OSC 0/2 で受け取った動的なウィンドウタイトル。null の間は session.title を表示。
  const [liveTitle, setLiveTitle] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [view, setView] = useState<TerminalViewState>({ primary: true, cols: 0, rows: 0, scale: 1 });

  useEffect(() => {
    const term = terminalRef.current;
    if (term) {
      term.options.fontSize = fontSize;
      // Cell metrics are re-measured asynchronously; refit on the next frame.
      window.requestAnimationFrame(() => fitNowRef.current?.());
    }
  }, [fontSize]);

  const changeFontSize = (delta: number) => {
    const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize + delta));
    try { localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(next)); } catch { /* Storage can be unavailable. */ }
    setFontSize(next);
  };

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    onTitleRef.current = onTitle;
  }, [onTitle]);

  useEffect(() => {
    onSetActiveRef.current = onSetActive;
  }, [onSetActive]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // 単一表示で前面に来たらこの端末へフォーカスを移す（スイッチャで切り替えた
  // 直後にクリックなしで入力できるように）。
  useEffect(() => {
    if (!autoFocus) return;
    const helper = containerRef.current?.querySelector('.xterm-helper-textarea');
    if (helper instanceof HTMLTextAreaElement) {
      try {
        helper.focus({ preventScroll: true });
      } catch {
        helper.focus();
      }
    }
  }, [autoFocus]);

  // セッションが切り替わったら動的タイトルをリセット（effect も再実行される）。
  useEffect(() => {
    setLiveTitle(null);
    onTitleRef.current?.(null);
  }, [session.id]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    processedOffsetRef.current = 0;
    containerRef.current.innerHTML = '';
    const term = new Terminal({
      cursorBlink: true,
      // 非アクティブ時はカーソルを枠線表示にして、どのタイルが
      // フォーカスされているかを視認しやすくする。
      cursorInactiveStyle: 'outline',
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize,
      allowProposedApi: true,
      // ネイティブターミナル相当のスクロールバックと慣性スクロール感度。
      scrollback: 10000,
      scrollSensitivity: 3,
      // macOS で Option/Alt を Meta として送り、readline の単語移動を有効化。
      macOptionIsMeta: true,
      convertEol: false,
      // Move textarea to mouse position on right-click so the browser's
      // context menu shows "Paste" over an editable element.
      rightClickSelectsWord: true,
      theme: {
        background: TERMINAL_BACKGROUND_COLOR,
        foreground: TERMINAL_FOREGROUND_COLOR,
        cursor: TERMINAL_CURSOR_COLOR,
        cursorAccent: TERMINAL_BACKGROUND_COLOR,
        selectionBackground: TERMINAL_SELECTION_BACKGROUND,
        black: TERMINAL_ANSI_PALETTE[0],
        red: TERMINAL_ANSI_PALETTE[1],
        green: TERMINAL_ANSI_PALETTE[2],
        yellow: TERMINAL_ANSI_PALETTE[3],
        blue: TERMINAL_ANSI_PALETTE[4],
        magenta: TERMINAL_ANSI_PALETTE[5],
        cyan: TERMINAL_ANSI_PALETTE[6],
        white: TERMINAL_ANSI_PALETTE[7],
        brightBlack: TERMINAL_ANSI_PALETTE[8],
        brightRed: TERMINAL_ANSI_PALETTE[9],
        brightGreen: TERMINAL_ANSI_PALETTE[10],
        brightYellow: TERMINAL_ANSI_PALETTE[11],
        brightBlue: TERMINAL_ANSI_PALETTE[12],
        brightMagenta: TERMINAL_ANSI_PALETTE[13],
        brightCyan: TERMINAL_ANSI_PALETTE[14],
        brightWhite: TERMINAL_ANSI_PALETTE[15]
      },
      // Query replies go through our primary-client/replay gate, rather than
      // xterm's onData path (which also carries keyboard input).
      windowOptions: {}
    });

    // Load addons for better TUI support
    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(webLinksAddon);

    // Enable Unicode 11 for proper emoji and wide character support
    term.unicode.activeVersion = '11';

    fitAddonRef.current = fitAddon;
    terminalRef.current = term;
    term.open(containerRef.current);

    const container = containerRef.current;
    // Stable across reconnects of this tile, so the server can hand a
    // reconnecting socket the role its not-yet-dead predecessor held.
    const clientId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

    // Refitting a newly visible tile keeps hidden/mobile terminals correctly
    // sized without a GPU context lifecycle.
    const visibilityObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) scheduleSync(true);
    });
    visibilityObserver.observe(container);

    // キーボードインターセプト + クリップボード（コピー/ペースト）を設定（#1 / #3）。
    // 非同期ペースト後の二重実行を防ぐため、cancelled を遅延参照で渡す。
    attachTerminalKeymap(term, () => cancelled);

    // ウィンドウタイトル（OSC 0/2）。ヘッダ表示を動的タイトルで上書きする（#9）。
    const titleDisposable = term.onTitleChange((title) => {
      setLiveTitle(title);
      onTitleRef.current?.(title);
    });

    // ビジュアルベル（#10）。ベル受信時にタイル要素へ一瞬クラスを付与して点滅。
    let bellTimeout: ReturnType<typeof setTimeout> | null = null;
    const bellDisposable = term.onBell(() => {
      const tile =
        tileRef.current ??
        (containerRef.current?.closest('.terminal-tile') as HTMLElement | null);
      if (!tile) return;
      tile.classList.add('bell-flash');
      if (bellTimeout) {
        clearTimeout(bellTimeout);
      }
      bellTimeout = setTimeout(() => {
        bellTimeout = null;
        tile.classList.remove('bell-flash');
      }, 150);
    });


    // Track whether we're replaying buffer (suppress query responses during replay)
    let replayingBuffer = true;
    let replayReady = false;
    let pendingWrites = 0;
    // The next binary frame is a server-rendered snapshot of the screen; it is
    // not part of the PTY byte stream, so it must not advance the offset.
    // Its offset is only committed once it has been drawn: a connection lost
    // before that must reconnect for a full snapshot, not a delta onto the
    // screen that sync just cleared.
    let expectSnapshotFrame = false;
    let snapshotOffset = 0;
    // この接続が「主」クライアントか。主クライアントのビューポートに PTY サイズが
    // 追従し、端末クエリ（DSR/DA/DECRQM/OSC など）へ応答するのも主のみ
    // （複数クライアント時の二重応答を防ぐ）。サーバが primary 制御メッセージで通知する。
    let isPrimary = false;
    // Whether this tile was primary when its last connection dropped.
    let wasPrimary = false;

    // Whether finishReplay should snap the viewport to the bottom.  Captured
    // at sync time from the user's current scroll position so a background
    // reconnect / delta replay doesn't yank them down while reading scrollback.
    // Defaults to true so the very first connect lands at the bottom.
    let shouldScrollAfterReplay = true;

    const publishView = (patch: Partial<TerminalViewState>) => {
      setView((prev) => {
        const next = { ...prev, ...patch };
        return next.primary === prev.primary && next.cols === prev.cols &&
          next.rows === prev.rows && next.scale === prev.scale ? prev : next;
      });
    };

    const finishReplay = () => {
      replayingBuffer = false;
      updateScale();
      // Only scroll to the bottom when the user was already at the bottom
      // (or the buffer was fully reset).  Otherwise preserve their scroll
      // position across reconnects.  scrollToBottom puts xterm.js into
      // auto-scroll mode so subsequent resizes also stay at the bottom.
      if (shouldScrollAfterReplay) {
        window.requestAnimationFrame(() => {
          term.scrollToBottom();
        });
      }
    };

    // Register terminal query handlers to prevent TUI apps from hanging
    const sendControlMessage = (message: ClientControlMessage): boolean => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
        return true;
      }
      return false;
    };

    const sendResponse = (response: string) => {
      if (replayingBuffer) return; // Don't respond during buffer replay
      if (!isPrimary) return; // 主クライアントのみが端末クエリへ応答する
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(textEncoder.encode(response));
      }
    };

    // 端末問い合わせ（DSR/DA/DECRQM/OSC/DCS など）への応答ハンドラを登録する。
    // 応答送出は sendResponse 経由（リプレイ中の抑制・主クライアント判定込み）。
    registerTerminalQueryHandlers(term, sendResponse);

    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    let lastReportedDesired: string | null = null;

    const helperTextarea = container.querySelector('.xterm-helper-textarea');
    if (helperTextarea instanceof HTMLTextAreaElement) {
      helperTextarea.setAttribute('spellcheck', 'false');
      helperTextarea.setAttribute('autocapitalize', 'off');
      helperTextarea.setAttribute('autocomplete', 'off');
      helperTextarea.setAttribute('autocorrect', 'off');
    }

    // ── Size ──────────────────────────────────────────────────────────
    // The local xterm is never fitted to the container directly: it always
    // has the PTY's cols×rows (from `sync`/`size`). What this client *could*
    // show is reported to the server as its desired size, and the server
    // resizes the PTY to it while this client is primary.

    /** cols×rows that would fill this tile, or null while it is hidden. */
    const measureDesired = (): { cols: number; rows: number } | null => {
      const dims = fitAddon.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 1 || dims.rows < 1) {
        return null;
      }
      return { cols: dims.cols, rows: dims.rows };
    };

    /** Scale the grid down when it is larger than the tile (viewer of a bigger client). */
    const updateScale = () => {
      const element = term.element;
      const screen = element?.querySelector('.xterm-screen');
      if (!element || !(screen instanceof HTMLElement)) return;
      const style = window.getComputedStyle(element);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const available = { width: container.clientWidth - padX, height: container.clientHeight - padY };
      if (available.width <= 0 || available.height <= 0) return; // hidden
      const natural = { width: screen.offsetWidth + SCROLLBAR_WIDTH, height: screen.offsetHeight };
      const scale = computeViewportScale(natural, available);
      if (scale === 1) {
        element.style.removeProperty('transform');
        element.style.removeProperty('transform-origin');
        element.style.removeProperty('width');
        element.style.removeProperty('height');
      } else {
        // Lay the grid out at its natural size, then shrink the whole thing.
        element.style.width = `${natural.width + padX}px`;
        element.style.height = `${natural.height + padY}px`;
        element.style.transformOrigin = '0 0';
        element.style.transform = `scale(${scale})`;
      }
      publishView({ scale });
    };

    const applyPtySize = (cols: number, rows: number) => {
      if (term.cols !== cols || term.rows !== rows) {
        // Same as FitAddon.fit(): drop the stale frame before reflowing.
        (term as unknown as { _core?: { _renderService?: { clear?: () => void } } })._core?._renderService?.clear?.();
        term.resize(cols, rows);
      }
      publishView({ cols, rows });
      updateScale();
    };

    // Apply a mid-stream resize after the bytes received before it have been
    // parsed: they were produced for the old size.
    const queuePtySize = (cols: number, rows: number) => {
      term.write('', () => {
        if (!cancelled) applyPtySize(cols, rows);
      });
    };

    const reportDesired = (force = false) => {
      const desired = measureDesired();
      if (!desired) return;
      const key = `${desired.cols}x${desired.rows}`;
      if (!force && key === lastReportedDesired) return;
      if (sendControlMessage({ type: 'resize', cols: desired.cols, rows: desired.rows })) {
        lastReportedDesired = key;
      }
    };

    const syncViewport = (force = false) => {
      updateScale();
      reportDesired(force);
    };

    // Take control: the PTY is resized to this tile and other clients follow.
    const claimTerminalControl = () => {
      const desired = measureDesired();
      if (desired) lastReportedDesired = `${desired.cols}x${desired.rows}`;
      sendControlMessage(desired ? { type: 'claim', cols: desired.cols, rows: desired.rows } : { type: 'claim' });
    };
    claimRef.current = claimTerminalControl;

    // Send terminal input, splitting oversized payloads (e.g. a multi-megabyte
    // paste) into chunks the server will accept.  The PTY reassembles the byte
    // stream, so splitting mid-character is harmless.
    const sendInput = (bytes: Uint8Array) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (bytes.byteLength <= MAX_INPUT_CHUNK) {
        socket.send(bytes);
        return;
      }
      for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_CHUNK) {
        const end = Math.min(offset + MAX_INPUT_CHUNK, bytes.byteLength);
        socket.send(bytes.subarray(offset, end));
      }
    };

    /**
     * Typing into a viewer takes control (the user is now using this client).
     * Replies xterm generates itself (cursor position, mode reports, focus,
     * mouse movement) are not typing: the primary answers those, so a viewer
     * drops them instead of duplicating them or grabbing control.
     */
    const forwardInput = (data: string, encode: (value: string) => Uint8Array) => {
      if (!isPrimary) {
        if (isTerminalReport(data)) return;
        claimTerminalControl();
      }
      sendInput(encode(data));
    };

    // Coalesce split dragging: report the final content box rather than
    // reflowing the PTY and redrawing the TUI on every animation frame.
    const scheduleSync = (immediate = false) => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      fitTimer = null;
      if (immediate) {
        syncViewport();
        return;
      }
      fitTimer = setTimeout(() => {
        fitTimer = null;
        syncViewport();
      }, 100);
    };
    fitNowRef.current = () => syncViewport();

    const resizeObserver = new ResizeObserver(() => {
      // Rescale right away (cheap, no PTY traffic); report the size debounced.
      updateScale();
      scheduleSync();
    });
    resizeObserver.observe(container);
    const resizeDisposable = term.onResize(() => {
      window.requestAnimationFrame(() => { if (!cancelled) updateScale(); });
    });
    const fontSet = typeof document !== 'undefined' ? document.fonts : null;
    const handleFontsReady = () => {
      if (!cancelled) {
        window.requestAnimationFrame(() => { if (!cancelled) syncViewport(); });
      }
    };
    fontSet?.ready.then(handleFontsReady).catch(() => undefined);
    fontSet?.addEventListener?.('loadingdone', handleFontsReady);

    let socket: WebSocket | null = null;
    let dataDisposable: IDisposable | null = null;
    let binaryDisposable: IDisposable | null = null;
    let pointerFocusCleanup: (() => void) | null = null;
    let cancelled = false;
    let connecting = false;
    const reconnect = createTerminalReconnect(() => { void connect(true); });
    let isIntentionalClose = false;

    const focusTerminalWithoutScroll = () => {
      const helper = containerRef.current?.querySelector('.xterm-helper-textarea');
      if (!(helper instanceof HTMLTextAreaElement)) {
        return;
      }
      try {
        helper.focus({ preventScroll: true });
      } catch {
        helper.focus();
      }
    };

    const unregisterInput = registerTerminalInput(session.id, {
      input: (data) => term.input(data, true),
      applicationCursorKeys: () => term.modes.applicationCursorKeysMode,
      paste: (text) => term.paste(text),
      focus: focusTerminalWithoutScroll,
      hasFocus: () => Boolean(term.textarea) && document.activeElement === term.textarea,
    });

    // クリック/フォーカスでこの端末を「アクティブ」に昇格させる。これにより
    // グリッドの強調表示・最大化・モバイル単一表示が「実際に使った端末」を指す。
    const promoteActive = () => {
      if (!isActiveRef.current) {
        onSetActiveRef.current?.();
      }
    };

    // Mouse: focus on press. Touch: focus only on a tap, so a scroll gesture
    // neither pops the soft keyboard nor takes control from another client.
    let touchStart: { x: number; y: number; id: number } | null = null;
    const handlePointerDown = (event: PointerEvent) => {
      if (cancelled) return;
      if (event.pointerType === 'mouse') {
        promoteActive();
        if (!isPrimary) claimTerminalControl();
        focusTerminalWithoutScroll();
        return;
      }
      touchStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (cancelled || event.pointerType === 'mouse' || !touchStart || touchStart.id !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y);
      touchStart = null;
      if (moved <= TAP_SLOP) {
        promoteActive();
        if (!isPrimary) claimTerminalControl();
        focusTerminalWithoutScroll();
      }
    };
    const handlePointerCancel = () => { touchStart = null; };

    const handleFocusIn = () => {
      if (!cancelled) {
        promoteActive();
      }
    };

    container.addEventListener('pointerdown', handlePointerDown, { passive: true, capture: true });
    container.addEventListener('pointerup', handlePointerUp, { passive: true, capture: true });
    container.addEventListener('pointercancel', handlePointerCancel, { passive: true, capture: true });
    container.addEventListener('focusin', handleFocusIn, true);
    pointerFocusCleanup = () => {
      container.removeEventListener('pointerdown', handlePointerDown, true);
      container.removeEventListener('pointerup', handlePointerUp, true);
      container.removeEventListener('pointercancel', handlePointerCancel, true);
      container.removeEventListener('focusin', handleFocusIn, true);
    };

    // Fetch WebSocket token and connect
    const connect = async (isReconnect = false) => {
      if (cancelled || connecting) return;
      connecting = true;
      setConnectionStatus(isReconnect ? 'reconnecting' : 'connecting');
      replayingBuffer = true;
      replayReady = false;

      try {
        // Finish queued drawing before selecting the replay offset.
        // Otherwise the reconnect can replay bytes still being painted.
        await new Promise<void>((resolve) => term.write('', resolve));
        if (cancelled) return;
        pendingWrites = 0;
        // Get a one-time token for WebSocket authentication
        const { token, authEnabled } = await getWsToken();
        if (cancelled) return;

        // Tell the server what this tile can show up front, so if it becomes
        // primary the replay is already rendered at that size (instead of
        // drawn at the old size and then redrawn). Cell metrics need the web
        // font, so give it a moment on the first connect.
        if (!isReconnect && !measureDesired()) {
          await Promise.race([
            fontSet?.ready.then(() => new Promise((resolve) => window.requestAnimationFrame(resolve))),
            new Promise((resolve) => setTimeout(resolve, 800)),
          ]);
          if (cancelled) return;
        }
        const desired = measureDesired();
        // Take control back only if this tile had it when the connection
        // dropped and the user is on this page right now. A viewer waking
        // from sleep or reconnecting after being dropped must not shrink the
        // PTY under whoever is actually typing elsewhere.
        const reclaim = isReconnect && wasPrimary && document.hasFocus();
        isPrimary = false;
        lastReportedDesired = desired ? `${desired.cols}x${desired.rows}` : null;
        const connection = new WebSocket(buildTerminalSocketUrl(wsUrl, {
          token: authEnabled ? token : undefined,
          // On reconnect, pass received byte offset so server sends only new data
          bufferOffset: isReconnect ? processedOffsetRef.current : 0,
          cols: desired?.cols,
          rows: desired?.rows,
          claim: reclaim,
          reconnect: isReconnect,
        }) + `&cid=${encodeURIComponent(clientId)}`);
        socket = connection;
        connection.binaryType = 'arraybuffer';
        socketRef.current = connection;

        connection.addEventListener('open', () => {
          if (cancelled || socketRef.current !== connection) return;
          // The tile may have been resized while connecting.
          reportDesired();
        });
        connection.addEventListener('message', (event) => {
          if (cancelled || socketRef.current !== connection) return;
          if (typeof event.data === 'string') {
            let message: ServerControlMessage | null = null;
            try {
              message = JSON.parse(event.data) as ServerControlMessage;
            } catch {
              // Not JSON — ignore malformed control frames rather than
              // leaking raw JSON text into the terminal display.
              return;
            }
            if (message?.type === 'sync') {
              // Record whether the user is pinned to the bottom *before* we
              // reset/replay, so finishReplay can preserve their position.
              // A full reset always re-renders fresh content, so snap to bottom.
              const active = term.buffer.active;
              shouldScrollAfterReplay = message.reset || active.viewportY >= active.baseY;
              replayingBuffer = true;
              replayReady = false;
              pendingWrites = 0;
              expectSnapshotFrame = Boolean(message.snapshot);
              snapshotOffset = message.offsetBase;
              processedOffsetRef.current = expectSnapshotFrame ? 0 : message.offsetBase;
              if (message.reset) {
                term.reset();
              }
              // Render the replay at the size it was produced at.
              if (message.cols && message.rows) {
                applyPtySize(message.cols, message.rows);
              }
              return;
            }
            if (message?.type === 'ready') {
              reconnect.cancel();
              reconnect.reset();
              setConnectionStatus('connected');
              replayReady = true;
              if (pendingWrites === 0) {
                finishReplay();
              }
              return;
            }
            if (message?.type === 'primary') {
              isPrimary = message.value;
              publishView({ primary: message.value });
              return;
            }
            if (message?.type === 'size') {
              queuePtySize(message.cols, message.rows);
              return;
            }
            // Unknown control message type — ignore
            return;
          }

          const writeFrame = (bytes: Uint8Array) => {
            // A snapshot is a rendering of the screen, not PTY output.
            const isSnapshot = expectSnapshotFrame;
            expectSnapshotFrame = false;
            pendingWrites++;
            term.write(bytes, () => {
              if (isSnapshot) processedOffsetRef.current = snapshotOffset;
              else processedOffsetRef.current += bytes.byteLength;
              pendingWrites = Math.max(0, pendingWrites - 1);
              if (replayReady && pendingWrites === 0 && replayingBuffer) {
                finishReplay();
              }
            });
          };

          if (event.data instanceof Blob) {
            // binaryType is 'arraybuffer', so Blob shouldn't occur.
            // Handle defensively by reading it as ArrayBuffer.
            event.data.arrayBuffer().then((ab) => {
              if (cancelled || socketRef.current !== connection) return;
              writeFrame(new Uint8Array(ab));
            });
            return;
          }

          writeFrame(new Uint8Array(event.data as ArrayBuffer));
        });
        connection.addEventListener('close', (event) => {
          if (cancelled || isIntentionalClose) {
            return;
          }
          // 既に新しいソケットへ差し替わっている場合、この古いソケットの
          // close では再接続しない（二重コネクションを防ぐ）。
          if (socketRef.current !== connection) {
            return;
          }
          wasPrimary = isPrimary;

          if (event.code === 1000) {
            if (TERMINAL_REMOVED_REASONS.has(event.reason)) {
              onExitRef.current();
              return;
            }
          }

          setConnectionStatus('reconnecting');
          reconnect.schedule();
        });

        connection.addEventListener('error', () => {
          // Error event is usually followed by close event, so we don't need to handle it separately
        });

        if (dataDisposable) {
          dataDisposable.dispose();
        }
        dataDisposable = term.onData((data) => {
          // Suppress during replay: xterm.js windowOptions (CSI 14t/16t/18t)
          // generate responses via onData that would be misinterpreted as
          // keyboard input by the PTY.
          if (replayingBuffer) return;
          if (socket && socket.readyState === WebSocket.OPEN) {
            // Ctrl/Alt latched on the on-screen key bar modify the next key.
            forwardInput(applyStickyModifiers(data), (value) => textEncoder.encode(value));
          }
        });

        if (binaryDisposable) {
          binaryDisposable.dispose();
        }
        binaryDisposable = term.onBinary((data) => {
          if (replayingBuffer) return;
          if (socket && socket.readyState === WebSocket.OPEN) {
            forwardInput(data, encodeBinaryInput);
          }
        });

        // Focus alone never takes control (it also happens programmatically:
        // switching terminals, window refocus). Clicking, tapping or typing does.
      } catch (err) {
        console.error('[Terminal] Failed to connect:', err);
        setConnectionStatus('reconnecting');
        reconnect.schedule();
      } finally {
        connecting = false;
      }
    };

    connect();

    // When the device wakes from sleep / the tab is refocused / the network
    // comes back, retry immediately rather than waiting for the backoff timer.
    const forceReconnect = () => {
      if (cancelled || isIntentionalClose || connecting) return;
      const current = socketRef.current;
      // 既に接続済み / 接続中なら何もしない。
      if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
        return;
      }
      // 復帰時は必ず再試行できるようバックオフをリセット。
      reconnect.reset();
      // まだ閉じ切っていない（CLOSING）場合は、このソケット自身の close
      // ハンドラが（リセット済みの回数で）再接続する。ここで新しいソケットを
      // 張ると二重コネクションになるため待つ。
      if (current && current.readyState === WebSocket.CLOSING) {
        return;
      }
      reconnect.cancel();
      connect(true);
    };
    const handleOnline = () => forceReconnect();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        forceReconnect();
      }
    };
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      isIntentionalClose = true;
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      reconnect.dispose();
      unregisterInput();
      if (fitTimer !== null) clearTimeout(fitTimer);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      resizeDisposable.dispose();
      fontSet?.removeEventListener?.('loadingdone', handleFontsReady);
      if (dataDisposable) {
        dataDisposable.dispose();
      }
      if (binaryDisposable) {
        binaryDisposable.dispose();
      }
      if (pointerFocusCleanup) {
        pointerFocusCleanup();
      }
      titleDisposable.dispose();
      bellDisposable.dispose();
      if (bellTimeout) {
        clearTimeout(bellTimeout);
        bellTimeout = null;
      }
      if (socket) {
        socket.close();
      }
      socketRef.current = null;

      fitAddonRef.current = null;
      fitNowRef.current = null;
      claimRef.current = null;
      terminalRef.current = null;
      term.dispose();
    };
  }, [session.id, wsUrl]);

  return (
    <div className={clsx('terminal-tile', isActive && 'active')} ref={tileRef}>
      <div className="terminal-tile-header">
        <span>{liveTitle || session.title}</span>
        {connectionStatus !== 'connected' && (
          <small role="status" aria-live="polite">
            {connectionStatus === 'reconnecting' ? '再接続中…' : '接続中…'}
          </small>
        )}
        {connectionStatus === 'connected' && !view.primary && (
          // Another client (another device, or `deckide attach`) drives the
          // size; this one mirrors it at the same cols×rows, scaled to fit.
          <button
            type="button"
            className="terminal-viewer-badge"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => claimRef.current?.()}
            title="別のクライアントが操作中です。押すとこの画面のサイズで操作を引き継ぎます"
          >
            閲覧中 {view.cols}×{view.rows}
            {view.scale < 1 && ` ${Math.round(view.scale * 100)}%`}
            <span className="terminal-viewer-badge-action">ここで操作</span>
          </button>
        )}
        <div className="terminal-font-controls" aria-label="文字サイズ">
          <button
            type="button"
            className="terminal-tile-icon-btn"
            aria-label="文字を小さく"
            title="文字を小さく"
            disabled={fontSize <= MIN_FONT_SIZE}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => changeFontSize(-1)}
          >−</button>
          <output aria-live="polite">{fontSize}</output>
          <button
            type="button"
            className="terminal-tile-icon-btn"
            aria-label="文字を大きく"
            title="文字を大きく"
            disabled={fontSize >= MAX_FONT_SIZE}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => changeFontSize(1)}
          >+</button>
        </div>
        {onToggleMaximize && (
          <button
            type="button"
            className="terminal-tile-icon-btn"
            onClick={onToggleMaximize}
            title={maximized ? 'グリッド表示に戻す' : 'このターミナルを最大表示'}
            aria-label={maximized ? 'グリッド表示に戻す' : 'このターミナルを最大表示'}
            aria-pressed={maximized}
          >
            {maximized ? '⊟' : '⛶'}
          </button>
        )}
        <button
          type="button"
          className="terminal-tile-icon-btn"
          onClick={() => { if (window.confirm('このターミナルを閉じますか？')) onDelete(); }}
          aria-label="ターミナルを閉じる"
        >
          ×
        </button>
      </div>
      <div className="terminal-tile-body" ref={containerRef} />
    </div>
  );
}
