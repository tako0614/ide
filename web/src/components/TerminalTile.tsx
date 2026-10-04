import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Terminal, type IDisposable } from '@xterm/xterm';
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
import {
  createCanonicalTerminalFrame,
  createTerminalReplayAccounting,
  normalizeTerminalPointerPoint
} from './terminalFrame';

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

type ServerControlMessage =
  | { type: 'sync'; offsetBase: number; reset: boolean; cols: number; rows: number; epoch: string; snapshotBytes: number }
  | { type: 'size'; cols: number; rows: number }
  | { type: 'ready' }
  // この接続が「主」クライアントか（端末クエリ応答を送るのは主のみ）。
  | { type: 'primary'; value: boolean };

type ClientControlMessage = { type: 'claim' };

const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;
const TERMINAL_FRAME_PADDING = 10;

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
  const frameViewportRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameWrapperRef = useRef<HTMLDivElement | null>(null);
  const frameScaleRef = useRef(0);
  const terminalRef = useRef<Terminal | null>(null);
  const fitNowRef = useRef<(() => void) | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const bufferEpochRef = useRef<string | null>(null);
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

  useEffect(() => {
    const term = terminalRef.current;
    if (term) {
      term.options.fontSize = fontSize;
      fitNowRef.current?.();
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
    if (!frameViewportRef.current || !containerRef.current || !frameWrapperRef.current) {
      return;
    }
    bufferEpochRef.current = null;
    containerRef.current.innerHTML = '';
    const term = new Terminal({
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
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
    const unicode11Addon = new Unicode11Addon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(unicode11Addon);
    term.loadAddon(webLinksAddon);

    // Enable Unicode 11 for proper emoji and wide character support
    term.unicode.activeVersion = '11';

    terminalRef.current = term;
    term.open(containerRef.current);
    const terminalElement = containerRef.current;
    if (terminalElement) {
      terminalElement.classList.add('terminal-frame-content');
      terminalElement.style.transformOrigin = 'top left';
    }

    // Recompute local scale when a hidden/mobile tile becomes visible.
    const visibilityObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) scheduleFit(true);
    });
    visibilityObserver.observe(frameViewportRef.current);

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
    // Query reply ownership is server controlled. The headless server parser
    // owns replies by default; user input still flows independently via onData.
    let isPrimary = false;
    // Whether finishReplay should snap the viewport to the bottom.  Captured
    // at sync time from the user's current scroll position so a background
    // reconnect / delta replay doesn't yank them down while reading scrollback.
    // Defaults to true so the very first connect lands at the bottom.
    let shouldScrollAfterReplay = true;

    const finishReplay = () => {
      replayingBuffer = false;
      scheduleFit(true);
      // Only scroll to the bottom when the user was already at the bottom
      // (or the buffer was fully reset).  Otherwise preserve their scroll
      // position across reconnects.  term.reset() resets scroll to 0; the
      // catch-up fit may reflow content.  scrollToBottom puts xterm.js into
      // auto-scroll mode so subsequent resizes also stay at the bottom.
      if (shouldScrollAfterReplay) {
        window.requestAnimationFrame(() => {
          term.scrollToBottom();
        });
      }
    };

    // Register terminal query handlers to prevent TUI apps from hanging
    const sendControlMessage = (message: ClientControlMessage) => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
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
    const canonicalFrame = createCanonicalTerminalFrame(term.cols, term.rows);
    const replayAccounting = createTerminalReplayAccounting();

    const helperTextarea = containerRef.current.querySelector('.xterm-helper-textarea');
    if (helperTextarea instanceof HTMLTextAreaElement) {
      helperTextarea.setAttribute('spellcheck', 'false');
      helperTextarea.setAttribute('autocapitalize', 'off');
      helperTextarea.setAttribute('autocomplete', 'off');
      helperTextarea.setAttribute('autocorrect', 'off');
    }

    const claimTerminalControl = () => {
      sendControlMessage({ type: 'claim' });
    };

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

    const runFit = (_force = false) => {
      const viewport = frameViewportRef.current;
      const wrapper = frameWrapperRef.current;
      const content = terminalElement;
      if (!viewport || !wrapper || !content) return;

      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
      const cellWidth = screen && term.cols > 0
        ? screen.offsetWidth / term.cols
        : fontSize * 0.6;
      const cellHeight = screen && term.rows > 0
        ? screen.offsetHeight / term.rows
        : fontSize * 1.2;
      const layout = canonicalFrame.layout(
        cellWidth,
        cellHeight,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        TERMINAL_FRAME_PADDING
      );
      wrapper.style.width = `${layout.width}px`;
      wrapper.style.height = `${layout.height}px`;
      content.style.width = `${layout.width / (layout.scale || 1)}px`;
      content.style.height = `${layout.height / (layout.scale || 1)}px`;
      content.style.transform = `scale(${layout.scale})`;
      frameScaleRef.current = layout.scale;
    };

    // Viewport and font changes scale this local frame without changing PTY size.
    const scheduleFit = (force = false) => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      fitTimer = null;
      if (force) {
        runFit(true);
        return;
      }
      fitTimer = setTimeout(() => {
        fitTimer = null;
        runFit();
      }, 100);
    };
    fitNowRef.current = () => scheduleFit(true);

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    if (frameViewportRef.current) resizeObserver.observe(frameViewportRef.current);
    scheduleFit();
    const fontSet = typeof document !== 'undefined' ? document.fonts : null;
    const handleFontsReady = () => {
      if (!cancelled) {
        scheduleFit(true);
      }
    };
    fontSet?.ready.then(handleFontsReady).catch(() => undefined);
    fontSet?.addEventListener?.('loadingdone', handleFontsReady);

    let socket: WebSocket | null = null;
    let dataDisposable: IDisposable | null = null;
    let binaryDisposable: IDisposable | null = null;
    let focusCleanup: (() => void) | null = null;
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

    // クリック/フォーカスでこの端末を「アクティブ」に昇格させる。これにより
    // グリッドの強調表示・最大化・モバイル単一表示が「実際に使った端末」を指す。
    const promoteActive = () => {
      if (!isActiveRef.current) {
        onSetActiveRef.current?.();
      }
    };

    const handlePointerFocus = () => {
      if (!cancelled) {
        promoteActive();
        focusTerminalWithoutScroll();
      }
    };

    const handleFocusIn = () => {
      if (!cancelled) {
        promoteActive();
        focusTerminalWithoutScroll();
      }
    };

    const normalizedMouseEvents = new WeakSet<Event>();
    let terminalMouseDrag = false;
    const terminalRoot = term.element;
    const isTerminalMouseEvent = (event: Event) =>
      !!terminalRoot && event.target instanceof Node && terminalRoot.contains(event.target);
    const normalizeMouseCoordinates = (event: MouseEvent | WheelEvent) => {
      if (normalizedMouseEvents.has(event)) return;
      const screen = terminalRoot?.querySelector<HTMLElement>('.xterm-screen');
      const scale = frameScaleRef.current;
      if (!screen || scale <= 0) return;
      const rect = screen.getBoundingClientRect();
      const normalized = normalizeTerminalPointerPoint(
        event.clientX,
        event.clientY,
        { left: rect.left, top: rect.top },
        scale
      );
      try {
        Object.defineProperties(event, {
          clientX: { configurable: true, value: normalized.clientX },
          clientY: { configurable: true, value: normalized.clientY }
        });
        normalizedMouseEvents.add(event);
        queueMicrotask(() => {
          Reflect.deleteProperty(event, 'clientX');
          Reflect.deleteProperty(event, 'clientY');
        });
      } catch {
        // Some synthetic or browser-owned events may not allow own coordinates.
      }
    };
    const stopTerminalMouseDrag = () => {
      terminalMouseDrag = false;
      document.removeEventListener('mousemove', handleDocumentDragMouse, true);
      document.removeEventListener('mouseup', handleDocumentDragMouse, true);
    };
    const handleDocumentDragMouse = (event: MouseEvent) => {
      if (!terminalMouseDrag) return;
      normalizeMouseCoordinates(event);
      if (event.type === 'mouseup') stopTerminalMouseDrag();
    };
    const handleTerminalMouseDown = (event: MouseEvent) => {
      if (!isTerminalMouseEvent(event)) return;
      normalizeMouseCoordinates(event);
      terminalMouseDrag = true;
      document.addEventListener('mousemove', handleDocumentDragMouse, true);
      document.addEventListener('mouseup', handleDocumentDragMouse, true);
    };
    const handleTerminalMouseMove = (event: MouseEvent) => {
      if (terminalMouseDrag || isTerminalMouseEvent(event)) normalizeMouseCoordinates(event);
    };
    const handleTerminalMouseUp = (event: MouseEvent) => {
      if (terminalMouseDrag || isTerminalMouseEvent(event)) normalizeMouseCoordinates(event);
      if (terminalMouseDrag) stopTerminalMouseDrag();
    };
    const handleTerminalWheel = (event: WheelEvent) => {
      if (isTerminalMouseEvent(event)) normalizeMouseCoordinates(event);
    };
    const handleTerminalContextMenu = (event: MouseEvent) => {
      if (isTerminalMouseEvent(event)) normalizeMouseCoordinates(event);
    };
    const resetTerminalMouseDrag = () => stopTerminalMouseDrag();

    frameViewportRef.current?.addEventListener('pointerdown', handlePointerFocus, { passive: true, capture: true });
    frameViewportRef.current?.addEventListener('mousedown', handlePointerFocus, { passive: true, capture: true });
    frameViewportRef.current?.addEventListener('touchstart', handlePointerFocus, { passive: true, capture: true });
    frameViewportRef.current?.addEventListener('focusin', handleFocusIn, true);
    frameViewportRef.current?.addEventListener('mousedown', handleTerminalMouseDown, true);
    frameViewportRef.current?.addEventListener('mousemove', handleTerminalMouseMove, true);
    frameViewportRef.current?.addEventListener('mouseup', handleTerminalMouseUp, true);
    frameViewportRef.current?.addEventListener('wheel', handleTerminalWheel, true);
    frameViewportRef.current?.addEventListener('contextmenu', handleTerminalContextMenu, true);
    window.addEventListener('blur', resetTerminalMouseDrag);
    pointerFocusCleanup = () => {
      frameViewportRef.current?.removeEventListener('pointerdown', handlePointerFocus, true);
      frameViewportRef.current?.removeEventListener('mousedown', handlePointerFocus, true);
      frameViewportRef.current?.removeEventListener('touchstart', handlePointerFocus, true);
      frameViewportRef.current?.removeEventListener('focusin', handleFocusIn, true);
      frameViewportRef.current?.removeEventListener('mousedown', handleTerminalMouseDown, true);
      frameViewportRef.current?.removeEventListener('mousemove', handleTerminalMouseMove, true);
      frameViewportRef.current?.removeEventListener('mouseup', handleTerminalMouseUp, true);
      frameViewportRef.current?.removeEventListener('wheel', handleTerminalWheel, true);
      frameViewportRef.current?.removeEventListener('contextmenu', handleTerminalContextMenu, true);
      window.removeEventListener('blur', resetTerminalMouseDrag);
      stopTerminalMouseDrag();
    };

    // Fetch WebSocket token and connect
    const connect = async (isReconnect = false) => {
      if (cancelled || connecting) return;
      connecting = true;
      setConnectionStatus(isReconnect ? 'reconnecting' : 'connecting');
      replayingBuffer = true;
      replayReady = false;

      try {
        // Finish queued drawing before selecting the replay offset, as Vibe
        // does. Otherwise the reconnect can replay bytes still being painted.
        await new Promise<void>((resolve) => term.write('', resolve));
        if (cancelled) return;
        pendingWrites = 0;
        // Get a one-time token for WebSocket authentication
        const { token, authEnabled } = await getWsToken();
        if (cancelled) return;

        // Append token to URL if auth is enabled
        const baseUrl = authEnabled ? `${wsUrl}?token=${token}` : wsUrl;
        // On reconnect, pass received byte offset so server sends only new data
        let finalUrl = baseUrl;
        if (isReconnect && bufferEpochRef.current) {
          const sep = baseUrl.includes('?') ? '&' : '?';
          finalUrl = `${baseUrl}${sep}bufferOffset=${replayAccounting.getProcessedOffset()}`;
          finalUrl += `&epoch=${encodeURIComponent(bufferEpochRef.current)}`;
        }
        if (isReconnect) {
          const sep = finalUrl.includes('?') ? '&' : '?';
          finalUrl = `${finalUrl}${sep}reconnect=1`;
        }
        const connection = new WebSocket(finalUrl);
        socket = connection;
        connection.binaryType = 'arraybuffer';
        socketRef.current = connection;

        connection.addEventListener('open', () => {
          if (cancelled || socketRef.current !== connection) return;
          scheduleFit();
          // 接続時にこの端末がフォーカス中なら制御権を主張する。再接続では
          // focus イベントが再発火しないため、ここで明示的に claim しておく。
          if (term.textarea && document.activeElement === term.textarea) {
            claimTerminalControl();
          }
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
              replayAccounting.begin(message.offsetBase, message.snapshotBytes);
              bufferEpochRef.current = message.epoch;
              const syncedSize = canonicalFrame.applyServerSize(message.cols, message.rows);
              if (syncedSize) term.resize(syncedSize.cols, syncedSize.rows);
              if (message.reset) {
                term.reset();
              }
              runFit();
              return;
            }
            if (message?.type === 'size') {
              const serverSize = canonicalFrame.applyServerSize(message.cols, message.rows);
              if (serverSize) {
                term.resize(serverSize.cols, serverSize.rows);
                scheduleFit(true);
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
              return;
            }
            // Unknown control message type — ignore
            return;
          }

          if (event.data instanceof Blob) {
            // binaryType is 'arraybuffer', so Blob shouldn't occur.
            // Handle defensively by reading it as ArrayBuffer.
            const blob = event.data;
            const accounted = replayAccounting.consumeFrame(blob.size);
            blob.arrayBuffer().then((ab) => {
              if (cancelled || socketRef.current !== connection) return;
              const blobBytes = new Uint8Array(ab);
              pendingWrites++;
              term.write(blobBytes, () => {
                replayAccounting.advanceProcessedOffset(accounted.liveBytes);
                pendingWrites = Math.max(0, pendingWrites - 1);
                if (replayReady && pendingWrites === 0) {
                  finishReplay();
                }
              });
            });
            return;
          }

          const bytes = new Uint8Array(event.data as ArrayBuffer);
          const accounted = replayAccounting.consumeFrame(bytes.byteLength);
          pendingWrites++;
          term.write(bytes, () => {
            replayAccounting.advanceProcessedOffset(accounted.liveBytes);
            pendingWrites = Math.max(0, pendingWrites - 1);
            if (replayReady && pendingWrites === 0) {
              finishReplay();
            }
          });
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
            sendInput(textEncoder.encode(data));
          }
        });

        if (binaryDisposable) {
          binaryDisposable.dispose();
        }
        binaryDisposable = term.onBinary((data) => {
          if (replayingBuffer) return;
          if (socket && socket.readyState === WebSocket.OPEN) {
            sendInput(encodeBinaryInput(data));
          }
        });

        if (!focusCleanup && term.textarea) {
          const onFocus = () => { claimTerminalControl(); };
          term.textarea.addEventListener('focus', onFocus);
          focusCleanup = () => { term.textarea?.removeEventListener('focus', onFocus); };
        }
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
      if (fitTimer !== null) clearTimeout(fitTimer);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      fontSet?.removeEventListener?.('loadingdone', handleFontsReady);
      if (dataDisposable) {
        dataDisposable.dispose();
      }
      if (binaryDisposable) {
        binaryDisposable.dispose();
      }
      if (focusCleanup) {
        focusCleanup();
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

      fitNowRef.current = null;
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
      <div className="terminal-tile-body terminal-frame-viewport" ref={frameViewportRef}>
        <div className="terminal-frame-wrapper" ref={frameWrapperRef}>
          <div ref={containerRef} />
        </div>
      </div>
    </div>
  );
}
