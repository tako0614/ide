import { useEffect, useRef } from 'react';
import { Terminal, type IDisposable } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import type { TerminalSession } from '../types';
import { getWsToken } from '../api';
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_BACKGROUND_COLOR,
  TERMINAL_FOREGROUND_COLOR
} from '../constants';

interface TerminalTileProps {
  session: TerminalSession;
  wsUrl: string;
  onDelete: () => void;
  onExit: () => void;
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
  | { type: 'ready' };

type ClientControlMessage =
  | { type: 'claim' }
  | { type: 'resize'; cols: number; rows: number };

const textEncoder = new TextEncoder();

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
  onExit
}: TerminalTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const processedOffsetRef = useRef<number>(0);
  const onExitRef = useRef(onExit);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    processedOffsetRef.current = 0;
    containerRef.current.innerHTML = '';
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      allowProposedApi: true,
      scrollback: 3000,
      convertEol: false,
      // Don't use windowsMode with ConPTY - it handles line discipline itself
      windowsMode: false,
      // Move textarea to mouse position on right-click so the browser's
      // context menu shows "Paste" over an editable element.
      rightClickSelectsWord: true,
      theme: {
        background: TERMINAL_BACKGROUND_COLOR,
        foreground: TERMINAL_FOREGROUND_COLOR
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


    // Track whether we're replaying buffer (suppress query responses during replay)
    let replayingBuffer = true;
    let replayReady = false;
    let pendingWrites = 0;
    // Lock out resizes during replay so xterm.js processes the entire buffer
    // at a consistent terminal size.  Without this, async write batching can
    // interleave with ResizeObserver / font-load events, causing part of the
    // content to be rendered at one column width and the rest at another.
    let replayResizeLock = false;

    const finishReplay = () => {
      replayingBuffer = false;
      if (replayResizeLock) {
        replayResizeLock = false;
        // Catch up on any resize that was suppressed during replay
        scheduleFit(true);
      }
      // Ensure the terminal viewport is scrolled to the latest output
      // after replay.  term.reset() resets scroll to 0; the catch-up fit
      // may reflow content.  scrollToBottom puts xterm.js into auto-scroll
      // mode so subsequent resizes also stay at the bottom.
      window.requestAnimationFrame(() => {
        term.scrollToBottom();
      });
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
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(textEncoder.encode(response));
      }
    };

    // DSR (Device Status Report) - CSI n
    term.parser.registerCsiHandler({ final: 'n' }, (params) => {
      const param = params.length > 0 ? params[0] as number : 0;

      if (param === 6) {
        // CPR - Cursor Position Report
        const buffer = term.buffer.active;
        const row = buffer.cursorY + buffer.baseY + 1;
        const col = buffer.cursorX + 1;
        sendResponse(`\x1b[${row};${col}R`);
        return true;
      } else if (param === 5) {
        // Device Status Report - terminal OK
        sendResponse('\x1b[0n');
        return true;
      }
      return false;
    });

    // DA1 (Primary Device Attributes) - CSI c
    term.parser.registerCsiHandler({ final: 'c' }, (params) => {
      // Keep the device attributes conservative: no sixel/windowing claims.
      sendResponse('\x1b[?62;1;6;22c');
      return true;
    });

    // DA2 (Secondary Device Attributes) - CSI > c
    term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, (params) => {
      // Respond as VT220 (1) with version 5.0.0 (firmware version)
      sendResponse('\x1b[>1;500;0c');
      return true;
    });

    // DECRQM (Request Mode) - CSI ? Ps $ p
    term.parser.registerCsiHandler({ prefix: '?', final: 'p', intermediates: '$' }, (params) => {
      const mode = (params[0] as number) || 0;
      const modes = term.modes;

      // 0 = not recognized, 1 = set, 2 = reset, 3 = permanently set, 4 = permanently reset
      let response = 0;
      if (mode === 1) response = modes.applicationCursorKeysMode ? 1 : 2;
      else if (mode === 25) response = 1;
      else if (mode === 1000) response = modes.mouseTrackingMode === 'x10' ? 1 : 2;
      else if (mode === 1002) response = modes.mouseTrackingMode === 'drag' ? 1 : 2;
      else if (mode === 1003) response = modes.mouseTrackingMode === 'any' ? 1 : 2;
      else if (mode === 1004) response = modes.sendFocusMode ? 1 : 2;
      else if (mode === 1006) response = modes.mouseTrackingMode !== 'none' ? 1 : 2;
      else if (mode === 1049) response = term.buffer.active.type === 'alternate' ? 1 : 2;
      else if (mode === 2004) response = modes.bracketedPasteMode ? 1 : 2;
      else if (mode === 2026) response = 2;

      sendResponse(`\x1b[?${mode};${response}$y`);
      return true;
    });

    // OSC handlers for color queries
    // Helper to convert 8-bit color to 16-bit hex format
    const colorTo16BitHex = (value: number): string => {
      // Convert 8-bit (0-255) to 16-bit (0-65535) by multiplying by 257
      const val16 = value * 257;
      return val16.toString(16).padStart(4, '0');
    };

    // OSC 10 - Foreground color query
    term.parser.registerOscHandler(10, (data) => {
      if (data === '?') {
        const fgColor = TERMINAL_FOREGROUND_COLOR || '#ffffff';
        const r = parseInt(fgColor.slice(1, 3), 16);
        const g = parseInt(fgColor.slice(3, 5), 16);
        const b = parseInt(fgColor.slice(5, 7), 16);
        sendResponse(`\x1b]10;rgb:${colorTo16BitHex(r)}/${colorTo16BitHex(g)}/${colorTo16BitHex(b)}\x07`);
        return true;
      }
      return false;
    });

    // OSC 11 - Background color query (CRITICAL for dark/light mode detection)
    term.parser.registerOscHandler(11, (data) => {
      if (data === '?') {
        const bgColor = TERMINAL_BACKGROUND_COLOR || '#000000';
        const r = parseInt(bgColor.slice(1, 3), 16);
        const g = parseInt(bgColor.slice(3, 5), 16);
        const b = parseInt(bgColor.slice(5, 7), 16);
        sendResponse(`\x1b]11;rgb:${colorTo16BitHex(r)}/${colorTo16BitHex(g)}/${colorTo16BitHex(b)}\x07`);
        return true;
      }
      return false;
    });

    // OSC 12 - Cursor color query
    term.parser.registerOscHandler(12, (data) => {
      if (data === '?') {
        sendResponse(`\x1b]12;rgb:ffff/ffff/ffff\x07`);
        return true;
      }
      return false;
    });

    // OSC 4 - Color palette query (individual ANSI colors)
    term.parser.registerOscHandler(4, (data) => {
      const match = data.match(/^(\d+);?\?$/);
      if (match) {
        const colorIndex = parseInt(match[1]);
        // Return basic ANSI colors
        const ansiColors = [
          '0000/0000/0000', // 0: black
          'cdcb/0000/0000', // 1: red
          '0000/cdcb/0000', // 2: green
          'cdcb/cdcb/0000', // 3: yellow
          '1e1e/9090/ffff', // 4: blue
          'cdcb/0000/cdcb', // 5: magenta
          '0000/cdcb/cdcb', // 6: cyan
          'e5e5/e5e5/e5e5', // 7: white
        ];
        const color = colorIndex < 8 ? ansiColors[colorIndex] : '0000/0000/0000';
        sendResponse(`\x1b]4;${colorIndex};rgb:${color}\x07`);
        return true;
      }
      return false;
    });

    // OSC 52 - Clipboard query (SECURITY: blocked for safety)
    term.parser.registerOscHandler(52, (data) => {
      if (data.includes('?')) {
        // Don't respond to clipboard queries for security
        return true; // Consume but don't respond
      }
      return false;
    });

    // XTVERSION - Terminal version query (CSI > q or CSI > 0 q)
    term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, (params) => {
      sendResponse('\x1bP>|xterm.js(5.0.0)\x1b\\');
      return true;
    });

    // CSI u - Kitty keyboard protocol query (CRITICAL for Neovim/Helix)
    term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, (params) => {
      // Don't respond = not supported, apps will fall back to modifyOtherKeys
      return true; // Consume the query
    });

    // XTQMODKEYS - modifyOtherKeys query (CSI ? 4 m)
    term.parser.registerCsiHandler({ prefix: '?', final: 'm' }, (params) => {
      const param = params[0] as number;
      if (param === 4) {
        sendResponse('\x1b[>4;0m');
        return true;
      }
      return false;
    });

    // XTWINOPS - Window operations (CSI Ps t)
    // Note: CSI 14t, 16t, 18t are handled automatically by xterm.js with windowOptions enabled
    term.parser.registerCsiHandler({ final: 't' }, (params) => {
      const operation = params[0] as number;

      // Only handle operations NOT covered by windowOptions
      if (operation === 19) {
        // Report screen size (same as window for web terminal)
        sendResponse(`\x1b[9;${term.rows};${term.cols}t`);
        return true;
      } else if (operation === 20) {
        // Report icon label
        sendResponse('\x1b]LTerminal\x1b\\');
        return true;
      } else if (operation === 21) {
        // Report window title
        sendResponse('\x1b]lTerminal\x1b\\');
        return true;
      } else if (operation === 14 || operation === 16 || operation === 18) {
        // These are handled by xterm.js windowOptions
        return false;
      }
      return false;
    });

    // XTSMGRAPHICS - Sixel capability query (CSI ? Pi ; Pa ; Pv S)
    term.parser.registerCsiHandler({ prefix: '?', final: 'S' }, (params) => {
      // Don't respond = not supported
      return true; // Consume the sequence
    });

    // DECRQSS - Request Status String (DCS $ q Pt ST)
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, (data, params) => {
      if (data === 'm') {
        // SGR query - report current attributes (normal text)
        sendResponse('\x1bP1$rm\x1b\\');
        return true;
      } else if (data === '"p') {
        // DECSCL - Conformance level (VT220, 8-bit controls)
        sendResponse('\x1bP1$r62;1"p\x1b\\');
        return true;
      } else if (data === 'r') {
        // DECSTBM - Scrolling region
        sendResponse(`\x1bP1$r1;${term.rows}r\x1b\\`);
        return true;
      }

      // Report as invalid request for other queries
      sendResponse('\x1bP0$r\x1b\\');
      return true;
    });

    // XTGETTCAP - Termcap/terminfo query (DCS + q <hex> ST)
    term.parser.registerDcsHandler({ intermediates: '+', final: 'q' }, (data, params) => {
      // Decode hex-encoded capability names
      try {
        const hexPairs = data.match(/.{2}/g) || [];
        const capName = hexPairs.map(h => String.fromCharCode(parseInt(h, 16))).join('');

        // Respond to important capabilities
        const capabilities: Record<string, string> = {
          'TN': 'xterm-256color', // Terminal name
          'Co': '256', // Colors
          'RGB': '', // RGB/truecolor support (empty value = supported)
          'Tc': '', // Truecolor (tmux convention)
          'colors': '256',
          'setrgbf': '\x1b[38;2;%p1%d;%p2%d;%p3%dm', // Set RGB foreground
          'setrgbb': '\x1b[48;2;%p1%d;%p2%d;%p3%dm', // Set RGB background
        };

        if (capName in capabilities) {
          const value = capabilities[capName];
          const hexValue = value.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
          sendResponse(`\x1bP1+r${hexValue}\x1b\\`);
          return true;
        }
      } catch (e) {
        console.error('[XTGETTCAP] Failed to decode:', e);
      }

      // Report as not available for unknown capabilities
      sendResponse('\x1bP0+r\x1b\\');
      return true;
    });

    // REP - Repeat character (CSI Ps b) - SECURITY: Clamp to prevent DoS
    term.parser.registerCsiHandler({ final: 'b' }, (params) => {
      const repeatCount = (params[0] as number) || 1;
      if (repeatCount > 65535) {
        console.warn(`[REP] Large repeat count ${repeatCount} clamped to 65535 for security`);
        // Don't execute, just consume
        return true;
      }
      // Let xterm.js handle normal REP
      return false;
    });

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
    let hasConnectedOnce = false;

    const parentPane = containerRef.current.closest('.terminal-pane');

    const setPaneTerminalFocus = (focused: boolean) => {
      if (!(parentPane instanceof HTMLElement)) {
        return;
      }
      if (focused) {
        parentPane.dataset.terminalFocus = 'true';
      } else {
        delete parentPane.dataset.terminalFocus;
      }
    };

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
        setPaneTerminalFocus(true);
        focusTerminalWithoutScroll();
      }
    };

    const handleFocusOut = () => {
      window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        const container = containerRef.current;
        if (!container) {
          return;
        }
        if (!container.contains(document.activeElement)) {
          setPaneTerminalFocus(false);
        }
      }, 0);
    };

    containerRef.current.addEventListener('pointerdown', handlePointerFocus, { passive: true, capture: true });
    containerRef.current.addEventListener('mousedown', handlePointerFocus, { passive: true, capture: true });
    containerRef.current.addEventListener('touchstart', handlePointerFocus, { passive: true, capture: true });
    containerRef.current.addEventListener('focusin', handleFocusIn, true);
    containerRef.current.addEventListener('focusout', handleFocusOut, true);
    pointerFocusCleanup = () => {
      containerRef.current?.removeEventListener('pointerdown', handlePointerFocus, true);
      containerRef.current?.removeEventListener('mousedown', handlePointerFocus, true);
      containerRef.current?.removeEventListener('touchstart', handlePointerFocus, true);
      containerRef.current?.removeEventListener('focusin', handleFocusIn, true);
      containerRef.current?.removeEventListener('focusout', handleFocusOut, true);
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
          hasConnectedOnce = true;
          // Force send on connect (server needs initial size)
          lastMeasuredWidth = 0;
          lastMeasuredHeight = 0;
          estimatedCellWidth = 0;
          estimatedCellHeight = 0;
          lastCols = -1;
          lastRows = -1;
          lastViewportScale = window.visualViewport?.scale ?? 1;
          scheduleFit();
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
              replayingBuffer = true;
              replayReady = false;
              pendingWrites = 0;
              replayResizeLock = false; // temporarily unlock for the initial fit
              processedOffsetRef.current = message.offsetBase;
              if (message.reset) {
                term.reset();
                // Synchronous fit so the terminal has the correct dimensions
                // before replay data arrives in the next message event.
                runFit(true);
                // Lock resizes for the duration of the replay.  xterm.js
                // processes large writes asynchronously across multiple
                // animation frames; without this lock a ResizeObserver or
                // font-load callback can change the column count mid-replay,
                // corrupting cursor-positioned content like ASCII art.
                replayResizeLock = true;
              }
              return;
            }
            if (message?.type === 'ready') {
              replayReady = true;
              if (pendingWrites === 0) {
                finishReplay();
              }
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
            claimTerminalControl();
            socket.send(textEncoder.encode(data));
          }
        });

        if (binaryDisposable) {
          binaryDisposable.dispose();
        }
        binaryDisposable = term.onBinary((data) => {
          if (replayingBuffer) return;
          if (socket && socket.readyState === WebSocket.OPEN) {
            claimTerminalControl();
            socket.send(encodeBinaryInput(data));
          }
        });

        if (!focusCleanup && term.textarea) {
          const onFocus = () => { claimTerminalControl(); };
          term.textarea.addEventListener('focus', onFocus);
          focusCleanup = () => { term.textarea?.removeEventListener('focus', onFocus); };
        }
      } catch (err) {
        console.error('[Terminal] Failed to connect:', err);
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && hasConnectedOnce) {
          reconnectAttempts++;
          const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
          reconnectTimeout = setTimeout(() => connect(true), delay);
        } else {
          term.write(`\r\n\x1b[31m接続エラー: ${err instanceof Error ? err.message : 'Unknown error'}\x1b[0m\r\n`);
        }
      }
    };

    connect();

    return () => {
      cancelled = true;
      isIntentionalClose = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (fitFrame !== null) {
        cancelAnimationFrame(fitFrame);
      }
      resizeObserver.disconnect();
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
      setPaneTerminalFocus(false);
      if (socket) {
        socket.close();
      }
      socketRef.current = null;

      fitAddonRef.current = null;
      term.dispose();
    };
  }, [session.id, wsUrl]);

  return (
    <div className="terminal-tile">
      <div className="terminal-tile-header">
        <span>{session.title}</span>
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
