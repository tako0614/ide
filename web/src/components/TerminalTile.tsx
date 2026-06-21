import { useEffect, useRef, useState } from 'react';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
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

interface TerminalTileProps {
  session: TerminalSession;
  wsUrl: string;
  onDelete: () => void;
  onExit: () => void;
  // OSC 0/2 で受け取った動的タイトルを親へ通知（端末セレクタの表示用）。
  onTitle?: (title: string | null) => void;
}

const TEXT_CLOSED = '接続が終了しました。';
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const TERMINAL_REMOVED_REASONS = new Set([
  'Deck deleted',
  'Terminal deleted',
  'Terminal exited',
  'Terminal not found'
]);

type ServerControlMessage =
  | { type: 'sync'; offsetBase: number; reset: boolean }
  | { type: 'ready' }
  // この接続が「主」クライアントか（端末クエリ応答を送るのは主のみ）。
  | { type: 'primary'; value: boolean };

type ClientControlMessage =
  | { type: 'claim' }
  | { type: 'resize'; cols: number; rows: number };

const textEncoder = new TextEncoder();

// Keep each input frame well under the server's 64KB maxPayload so a large
// paste is split across frames instead of tripping the 1009 "message too
// large" close, which would drop the terminal mid-paste.
const MAX_INPUT_CHUNK = 48 * 1024;

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
  onTitle
}: TerminalTileProps) {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const processedOffsetRef = useRef<number>(0);
  const onExitRef = useRef(onExit);
  const onTitleRef = useRef(onTitle);

  // OSC 0/2 で受け取った動的なウィンドウタイトル。null の間は session.title を表示。
  const [liveTitle, setLiveTitle] = useState<string | null>(null);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    onTitleRef.current = onTitle;
  }, [onTitle]);

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
      fontSize: TERMINAL_FONT_SIZE,
      allowProposedApi: true,
      // ネイティブターミナル相当のスクロールバックと慣性スクロール感度。
      scrollback: 10000,
      scrollSensitivity: 3,
      fastScrollModifier: 'alt',
      // macOS で Option/Alt を Meta として送り、readline の単語移動を有効化。
      macOptionIsMeta: true,
      convertEol: false,
      // Don't use windowsMode with ConPTY - it handles line discipline itself
      windowsMode: false,
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
      // CRITICAL: Enable window operations for rich TUI mode
      windowOptions: {
        getWinSizePixels: true,    // CSI 14t - pixel dimensions
        getCellSizePixels: true,   // CSI 16t - cell size for box drawing
        getWinSizeChars: true,     // CSI 18t - character grid size
      }
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
    term.open(containerRef.current);

    // WebGL レンダラ。モバイルの端末切替では非アクティブタイルが
    // display:none でマウントされるため、0 サイズ/非表示の canvas で WebGL を
    // 初期化すると初回表示時に黒画面になりやすい。そこで「初めて可視になった
    // タイミング」まで初期化を遅延する（IntersectionObserver）。失敗時は
    // デフォルトの DOM レンダラにフォールバックし、onContextLoss でも戻す。
    let webglAddon: WebglAddon | null = null;
    let webglTried = false;

    const tryLoadWebgl = () => {
      if (webglTried || cancelled || webglAddon) return;
      webglTried = true;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          if (webglAddon === addon) {
            webglAddon = null;
          }
        });
        term.loadAddon(addon);
        webglAddon = addon;
      } catch (err) {
        console.warn('[Terminal] WebGL renderer unavailable, falling back to DOM:', err);
        if (webglAddon) {
          try {
            webglAddon.dispose();
          } catch {
            // ignore
          }
          webglAddon = null;
        }
      }
    };

    // タイルが可視になったら WebGL を初期化し、サイズ追従の fit も走らせる。
    const visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0) {
          tryLoadWebgl();
          // 非表示→表示の遷移で正しいサイズに再フィットさせる。
          scheduleFit(true);
        }
      }
    });
    visibilityObserver.observe(containerRef.current);

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
    // この接続が「主」クライアントか。複数クライアントが同じ端末を開いたとき、
    // 端末クエリ（DSR/DA/DECRQM/OSC など）へ応答するのは主のみにして、
    // PTY へ重複した応答が二重入力されるのを防ぐ。サーバが primary 制御
    // メッセージで通知する。単独クライアントは既定で主（true）。
    let isPrimary = true;
    // Lock out resizes during replay so xterm.js processes the entire buffer
    // at a consistent terminal size.  Without this, async write batching can
    // interleave with ResizeObserver / font-load events, causing part of the
    // content to be rendered at one column width and the rest at another.
    let replayResizeLock = false;

    // Whether finishReplay should snap the viewport to the bottom.  Captured
    // at sync time from the user's current scroll position so a background
    // reconnect / delta replay doesn't yank them down while reading scrollback.
    // Defaults to true so the very first connect lands at the bottom.
    let shouldScrollAfterReplay = true;

    const finishReplay = () => {
      replayingBuffer = false;
      if (replayResizeLock) {
        replayResizeLock = false;
        // Catch up on any resize that was suppressed during replay
        scheduleFit(true);
      }
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

    // Track the last measured container size as well as the last PTY size so
    // repeated redraws from TUI apps don't feed a fit/resize loop.
    let lastMeasuredWidth = 0;
    let lastMeasuredHeight = 0;
    let fitFrame: number | null = null;
    let lastCols = term.cols;
    let lastRows = term.rows;
    let estimatedCellWidth = 0;
    let estimatedCellHeight = 0;
    let lastViewportScale = window.visualViewport?.scale ?? 1;

    const updateCellEstimate = (width: number, height: number) => {
      if (term.cols > 0) {
        estimatedCellWidth = width / term.cols;
      }
      if (term.rows > 0) {
        estimatedCellHeight = height / term.rows;
      }
    };

    const helperTextarea = containerRef.current.querySelector('.xterm-helper-textarea');
    if (helperTextarea instanceof HTMLTextAreaElement) {
      helperTextarea.setAttribute('spellcheck', 'false');
      helperTextarea.setAttribute('autocapitalize', 'off');
      helperTextarea.setAttribute('autocomplete', 'off');
      helperTextarea.setAttribute('autocorrect', 'off');
    }

    const sendResizeIfChanged = () => {
      const cols = term.cols;
      const rows = term.rows;
      if (!cols || !rows) return;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      sendControlMessage({ type: 'resize', cols, rows });
    };

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

    const runFit = (force = false) => {
      // During replay, block all resizes except the initial forced fit
      // from the sync handler.  This prevents xterm.js async write batching
      // from interleaving with resize events.
      if (replayResizeLock) return;

      const container = containerRef.current;
      if (!container) return;

      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;

      if (!force && width === lastMeasuredWidth && height === lastMeasuredHeight) {
        return;
      }

      const currentViewportScale = window.visualViewport?.scale ?? 1;
      if (!force && estimatedCellWidth > 0 && estimatedCellHeight > 0) {
        const predictedCols = Math.max(2, Math.floor(width / estimatedCellWidth));
        const predictedRows = Math.max(1, Math.floor(height / estimatedCellHeight));
        const deltaWidth = Math.abs(width - lastMeasuredWidth);
        const deltaHeight = Math.abs(height - lastMeasuredHeight);
        const widthThreshold = Math.max(estimatedCellWidth * 0.75, 2);
        const heightThreshold = Math.max(estimatedCellHeight * 0.75, 2);
        const scaleChanged = Math.abs(currentViewportScale - lastViewportScale) > 0.001;

        if (predictedCols === lastCols && predictedRows === lastRows) {
          lastMeasuredWidth = width;
          lastMeasuredHeight = height;
          lastViewportScale = currentViewportScale;
          return;
        }

        if (scaleChanged && deltaWidth < widthThreshold && deltaHeight < heightThreshold) {
          lastMeasuredWidth = width;
          lastMeasuredHeight = height;
          lastViewportScale = currentViewportScale;
          return;
        }
      }

      lastMeasuredWidth = width;
      lastMeasuredHeight = height;
      fitAddon.fit();
      updateCellEstimate(width, height);
      lastViewportScale = currentViewportScale;
      sendResizeIfChanged();
    };

    const scheduleFit = (force = false) => {
      if (fitFrame !== null) {
        if (!force) return;
        cancelAnimationFrame(fitFrame);
      }

      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        runFit(force);
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    resizeObserver.observe(containerRef.current);
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
    let reconnectAttempts = 0;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
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

    const handlePointerFocus = () => {
      if (!cancelled) {
        focusTerminalWithoutScroll();
      }
    };

    const handleFocusIn = () => {
      if (!cancelled) {
        focusTerminalWithoutScroll();
      }
    };

    containerRef.current.addEventListener('pointerdown', handlePointerFocus, { passive: true, capture: true });
    containerRef.current.addEventListener('mousedown', handlePointerFocus, { passive: true, capture: true });
    containerRef.current.addEventListener('touchstart', handlePointerFocus, { passive: true, capture: true });
    containerRef.current.addEventListener('focusin', handleFocusIn, true);
    pointerFocusCleanup = () => {
      containerRef.current?.removeEventListener('pointerdown', handlePointerFocus, true);
      containerRef.current?.removeEventListener('mousedown', handlePointerFocus, true);
      containerRef.current?.removeEventListener('touchstart', handlePointerFocus, true);
      containerRef.current?.removeEventListener('focusin', handleFocusIn, true);
    };

    // Fetch WebSocket token and connect
    const connect = async (isReconnect = false) => {
      if (cancelled) return;
      replayingBuffer = true;
      replayReady = false;
      pendingWrites = 0;

      try {
        // Get a one-time token for WebSocket authentication
        const { token, authEnabled } = await getWsToken();
        if (cancelled) return;

        // Append token to URL if auth is enabled
        const baseUrl = authEnabled ? `${wsUrl}?token=${token}` : wsUrl;
        // On reconnect, pass received byte offset so server sends only new data
        let finalUrl = baseUrl;
        if (isReconnect && processedOffsetRef.current > 0) {
          const sep = baseUrl.includes('?') ? '&' : '?';
          finalUrl = `${baseUrl}${sep}bufferOffset=${processedOffsetRef.current}`;
        }
        if (isReconnect) {
          const sep = finalUrl.includes('?') ? '&' : '?';
          finalUrl = `${finalUrl}${sep}reconnect=1`;
        }
        socket = new WebSocket(finalUrl);
        socket.binaryType = 'arraybuffer';
        socketRef.current = socket;

        socket.addEventListener('open', () => {
          reconnectAttempts = 0;
          // Force send on connect (server needs initial size)
          lastMeasuredWidth = 0;
          lastMeasuredHeight = 0;
          estimatedCellWidth = 0;
          estimatedCellHeight = 0;
          lastCols = -1;
          lastRows = -1;
          lastViewportScale = window.visualViewport?.scale ?? 1;
          scheduleFit();
          // 接続時にこの端末がフォーカス中なら制御権を主張する。再接続では
          // focus イベントが再発火しないため、ここで明示的に claim しておく。
          if (term.textarea && document.activeElement === term.textarea) {
            claimTerminalControl();
          }
        });
        socket.addEventListener('message', (event) => {
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
              replayResizeLock = false; // temporarily unlock for the initial fit
              processedOffsetRef.current = message.offsetBase;
              if (message.reset) {
                term.reset();
              }
              // Synchronous fit so the terminal has the correct dimensions
              // before replay data arrives in the next message event.
              runFit(true);
              // Lock resizes for the duration of the replay.  xterm.js
              // processes large writes asynchronously across multiple
              // animation frames; without this lock a ResizeObserver or
              // font-load callback can change the column count mid-replay,
              // corrupting cursor-positioned content like ASCII art.
              // This applies to both reset and delta replays — the
              // scheduleFit() queued from the socket open handler could
              // otherwise fire mid-write.
              replayResizeLock = true;
              return;
            }
            if (message?.type === 'ready') {
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
            blob.arrayBuffer().then((ab) => {
              if (cancelled) return;
              const blobBytes = new Uint8Array(ab);
              pendingWrites++;
              term.write(blobBytes, () => {
                processedOffsetRef.current += blobBytes.byteLength;
                pendingWrites = Math.max(0, pendingWrites - 1);
                if (replayReady && pendingWrites === 0) {
                  finishReplay();
                }
              });
            });
            return;
          }

          const bytes = new Uint8Array(event.data as ArrayBuffer);
          pendingWrites++;
          term.write(bytes, () => {
            processedOffsetRef.current += bytes.byteLength;
            pendingWrites = Math.max(0, pendingWrites - 1);
            if (replayReady && pendingWrites === 0) {
              finishReplay();
            }
          });
        });
        socket.addEventListener('close', (event) => {
          if (cancelled || isIntentionalClose) {
            return;
          }
          // 既に新しいソケットへ差し替わっている場合、この古いソケットの
          // close では再接続しない（二重コネクションを防ぐ）。
          if (socketRef.current !== socket) {
            return;
          }

          if (event.code === 1000) {
            if (TERMINAL_REMOVED_REASONS.has(event.reason)) {
              onExitRef.current();
              return;
            }
          }

          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
            reconnectTimeout = setTimeout(() => connect(true), delay);
          } else {
            term.write(`\r\n\x1b[31m${TEXT_CLOSED}\x1b[0m\r\n`);
          }
        });

        socket.addEventListener('error', () => {
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
        // Retry even on the very first attempt — the server may simply not be
        // up yet when the page is opened right after a restart.
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
          reconnectTimeout = setTimeout(() => connect(true), delay);
        } else {
          term.write(`\r\n\x1b[31m接続エラー: ${err instanceof Error ? err.message : 'Unknown error'}\x1b[0m\r\n`);
        }
      }
    };

    connect();

    // When the device wakes from sleep / the tab is refocused / the network
    // comes back, the socket may be closed and the backoff may have already
    // given up.  Force an immediate reconnect instead of leaving a dead
    // terminal showing "接続が終了しました。".
    const forceReconnect = () => {
      if (cancelled || isIntentionalClose) return;
      const current = socketRef.current;
      // 既に接続済み / 接続中なら何もしない。
      if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
        return;
      }
      // 復帰時は必ず再試行できるようバックオフをリセット。
      reconnectAttempts = 0;
      // まだ閉じ切っていない（CLOSING）場合は、このソケット自身の close
      // ハンドラが（リセット済みの回数で）再接続する。ここで新しいソケットを
      // 張ると二重コネクションになるため待つ。
      if (current && current.readyState === WebSocket.CLOSING) {
        return;
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
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
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (fitFrame !== null) {
        cancelAnimationFrame(fitFrame);
      }
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

      if (webglAddon) {
        try {
          webglAddon.dispose();
        } catch {
          // ignore
        }
        webglAddon = null;
      }
      fitAddonRef.current = null;
      term.dispose();
    };
  }, [session.id, wsUrl]);

  return (
    <div className="terminal-tile" ref={tileRef}>
      <div className="terminal-tile-header">
        <span>{liveTitle || session.title}</span>
        <button
          type="button"
          className="terminal-close-btn"
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
