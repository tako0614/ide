import { useEffect, useRef } from 'react';
import { Terminal, type IDisposable } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { WebglAddon } from 'xterm-addon-webgl';
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
}

const TEXT_BOOT = 'ターミナルを起動しました: ';
const TEXT_CONNECTED = '接続しました。';
const TEXT_RECONNECTING = '再接続中...';
const TEXT_CLOSED = '接続が終了しました。';
const RESIZE_MESSAGE_PREFIX = '\u0000resize:';
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;

export function TerminalTile({
  session,
  wsUrl,
  onDelete
}: TerminalTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    containerRef.current.innerHTML = '';
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      allowProposedApi: true,
      scrollback: 10000,
      convertEol: false,
      // Don't use windowsMode with ConPTY - it handles line discipline itself
      windowsMode: false,
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

    // Load WebGL addon for better rendering performance (may fail on some systems)
    // IMPORTANT: Must be loaded AFTER term.open() to ensure terminal is initialized
    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
      webglAddonRef.current = webglAddon;
      // Set up context loss handler only after successful load
      webglAddon.onContextLoss(() => {
        console.warn('[WebGL] Context lost, disposing addon');
        try {
          webglAddon.dispose();
          webglAddonRef.current = null;
        } catch (err) {
          console.error('[WebGL] Error disposing after context loss:', err);
        }
      });
    } catch (error) {
      console.warn('[WebGL] Failed to load WebGL addon, using canvas renderer:', error);
      webglAddonRef.current = null;
    }

    // Register terminal query handlers to prevent TUI apps from hanging
    const sendResponse = (response: string) => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(response);
      }
    };

    // DSR (Device Status Report) - CSI n
    term.parser.registerCsiHandler({ final: 'n' }, (params) => {
      const param = params.length > 0 ? params.params[0] : 0;

      if (param === 6) {
        // CPR - Cursor Position Report
        const buffer = term.buffer.active;
        const row = buffer.cursorY + buffer.baseY + 1;
        const col = buffer.cursorX + 1;
        console.log(`[CPR] Responding with row=${row}, col=${col}`);
        sendResponse(`\x1b[${row};${col}R`);
        return true;
      } else if (param === 5) {
        // Device Status Report - terminal OK
        console.log('[DSR] Terminal OK');
        sendResponse('\x1b[0n');
        return true;
      }
      return false;
    });

    // DA1 (Primary Device Attributes) - CSI c
    term.parser.registerCsiHandler({ final: 'c' }, (params) => {
      // Respond as VT220 with rich extensions:
      // 1 = 132 columns, 2 = printer, 4 = sixel, 6 = selective erase
      // 7 = soft character set, 8 = user-defined keys, 9 = national replacement character sets
      // 15 = technical character set, 18 = windowing capability, 22 = ANSI color, 29 = ANSI text locator
      console.log('[DA1] Responding to Primary Device Attributes query');
      // Report as VT220 with 132 cols, printer, sixel, selective erase, UDK, DRCS, NRCS, technical chars, color
      sendResponse('\x1b[?62;1;2;4;6;7;8;9;15;22c');
      return true;
    });

    // DA2 (Secondary Device Attributes) - CSI > c
    term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, (params) => {
      // Respond as VT220 (1) with version 5.0.0 (firmware version)
      console.log('[DA2] Responding to Secondary Device Attributes query');
      sendResponse('\x1b[>1;500;0c');
      return true;
    });

    // DECRQM (Request Mode) - CSI ? Ps $ p
    term.parser.registerCsiHandler({ prefix: '?', final: 'p', intermediates: '$' }, (params) => {
      const mode = params.params[0] || 0;
      console.log(`[DECRQM] Mode query for ${mode}`);

      // Respond appropriately for common modes
      // 0 = not recognized, 1 = set, 2 = reset, 3 = permanently set, 4 = permanently reset
      let response = 0; // Default: not recognized

      // Modes we support (report as "set" = 1)
      const supportedModes = [
        1,    // DECCKM - Cursor keys mode
        25,   // DECTCEM - Text cursor enable
        1049, // Alternate screen + save cursor
        2004, // Bracketed paste mode - REPORT AS SET for rich TUI
        1004, // Focus in/out events - REPORT AS SET
        1006, // SGR mouse mode - REPORT AS SET
        1002, // Button event mouse tracking - REPORT AS SET
      ];

      // Modes we recognize but report as "reset" (2)
      const recognizedModes = [
        2026, // Synchronized output (not fully supported)
        1000, // X10 mouse mode
        1003, // Any-event mouse tracking
      ];

      if (supportedModes.includes(mode)) {
        response = 1; // Set
      } else if (recognizedModes.includes(mode)) {
        response = 2; // Reset (recognized but not enabled)
      }

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
        console.log('[OSC 10] Foreground color query');
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
        console.log('[OSC 11] Background color query');
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
        console.log('[OSC 12] Cursor color query');
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
        console.log(`[OSC 4] Color palette query for index ${colorIndex}`);
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
        console.log('[OSC 52] Clipboard query blocked for security');
        // Don't respond to clipboard queries for security
        return true; // Consume but don't respond
      }
      return false;
    });

    // XTVERSION - Terminal version query (CSI > q or CSI > 0 q)
    term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, (params) => {
      console.log('[XTVERSION] Responding to terminal version query');
      // DCS > | xterm.js(version) ST
      sendResponse('\x1bP>|xterm.js(5.0.0)\x1b\\');
      return true;
    });

    // CSI u - Kitty keyboard protocol query (CRITICAL for Neovim/Helix)
    term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, (params) => {
      console.log('[CSI u] Keyboard protocol query - not supported');
      // Don't respond = not supported, apps will fall back to modifyOtherKeys
      return true; // Consume the query
    });

    // XTQMODKEYS - modifyOtherKeys query (CSI ? 4 m)
    term.parser.registerCsiHandler({ prefix: '?', final: 'm' }, (params) => {
      const param = params.params[0];
      if (param === 4) {
        console.log('[XTQMODKEYS] Responding to modifyOtherKeys query');
        // Report as level 1 enabled (enhanced keyboard mode)
        sendResponse('\x1b[?4;1m');
        return true;
      }
      return false;
    });

    // XTWINOPS - Window operations (CSI Ps t)
    // Note: CSI 14t, 16t, 18t are handled automatically by xterm.js with windowOptions enabled
    term.parser.registerCsiHandler({ final: 't' }, (params) => {
      const operation = params.params[0];

      // Only handle operations NOT covered by windowOptions
      if (operation === 19) {
        // Report screen size (same as window for web terminal)
        console.log('[XTWINOPS] Screen size query (19t)');
        sendResponse(`\x1b[9;${term.rows};${term.cols}t`);
        return true;
      } else if (operation === 20) {
        // Report icon label
        console.log('[XTWINOPS] Icon label query (20t)');
        sendResponse('\x1b]LTerminal\x1b\\');
        return true;
      } else if (operation === 21) {
        // Report window title
        console.log('[XTWINOPS] Window title query (21t)');
        sendResponse('\x1b]lTerminal\x1b\\');
        return true;
      } else if (operation === 14 || operation === 16 || operation === 18) {
        // These are handled by xterm.js windowOptions, just log
        console.log(`[XTWINOPS] Operation ${operation}t handled by xterm.js`);
        return false; // Let xterm.js handle it
      }
      return false;
    });

    // XTSMGRAPHICS - Sixel capability query (CSI ? Pi ; Pa ; Pv S)
    term.parser.registerCsiHandler({ prefix: '?', final: 'S' }, (params) => {
      console.log('[XTSMGRAPHICS] Sixel graphics query - not supported');
      // Don't respond = not supported
      return true; // Consume the sequence
    });

    // DECRQSS - Request Status String (DCS $ q Pt ST)
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, (data, params) => {
      console.log(`[DECRQSS] Status string query: ${data}`);

      // Handle specific queries
      if (data === 'm') {
        // SGR query - report current attributes (normal text)
        // This indicates true color support via SGR 38;2;r;g;b
        console.log('[DECRQSS] SGR query - reporting true color support');
        sendResponse('\x1bP1$rm\x1b\\');
        return true;
      } else if (data === '"p') {
        // DECSCL - Conformance level (VT220, 8-bit controls)
        console.log('[DECRQSS] DECSCL query');
        sendResponse('\x1bP1$r62;1"p\x1b\\');
        return true;
      } else if (data === 'r') {
        // DECSTBM - Scrolling region
        console.log('[DECRQSS] DECSTBM query');
        sendResponse(`\x1bP1$r1;${term.rows}r\x1b\\`);
        return true;
      }

      // Report as invalid request for other queries
      sendResponse('\x1bP0$r\x1b\\');
      return true;
    });

    // XTGETTCAP - Termcap/terminfo query (DCS + q <hex> ST)
    term.parser.registerDcsHandler({ intermediates: '+', final: 'q' }, (data, params) => {
      console.log(`[XTGETTCAP] Termcap query: ${data}`);

      // Decode hex-encoded capability names
      try {
        const hexPairs = data.match(/.{2}/g) || [];
        const capName = hexPairs.map(h => String.fromCharCode(parseInt(h, 16))).join('');
        console.log(`[XTGETTCAP] Decoded capability: ${capName}`);

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
          console.log(`[XTGETTCAP] Responding with value: ${value}`);
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
      const repeatCount = params.params[0] || 1;
      if (repeatCount > 65535) {
        console.warn(`[REP] Large repeat count ${repeatCount} clamped to 65535 for security`);
        // Don't execute, just consume
        return true;
      }
      // Let xterm.js handle normal REP
      return false;
    });

    fitAddon.fit();
    term.write(`${TEXT_BOOT}${session.title}\r\n\r\n`);

    const sendResize = () => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const cols = term.cols;
      const rows = term.rows;
      if (!cols || !rows) return;
      socket.send(`${RESIZE_MESSAGE_PREFIX}${cols},${rows}`);
    };

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      sendResize();
    });
    resizeObserver.observe(containerRef.current);

    let socket: WebSocket | null = null;
    let dataDisposable: IDisposable | null = null;
    let cancelled = false;
    let reconnectAttempts = 0;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isIntentionalClose = false;
    let hasConnectedOnce = false;

    // Fetch WebSocket token and connect
    const connect = async (isReconnect = false) => {
      if (cancelled) return;

      try {
        // Get a one-time token for WebSocket authentication
        const { token, authEnabled } = await getWsToken();
        if (cancelled) return;

        // Append token to URL if auth is enabled
        const finalUrl = authEnabled ? `${wsUrl}?token=${token}` : wsUrl;
        socket = new WebSocket(finalUrl);
        socketRef.current = socket;

        socket.addEventListener('open', () => {
          reconnectAttempts = 0;
          hasConnectedOnce = true;
          sendResize();
          if (isReconnect) {
            term.write(`\r\n\x1b[32m${TEXT_CONNECTED}\x1b[0m\r\n`);
          } else {
            term.write(`\r\n${TEXT_CONNECTED}\r\n\r\n`);
          }
        });
        socket.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            term.write(event.data);
          }
        });
        socket.addEventListener('close', (event) => {
          if (cancelled || isIntentionalClose) {
            return;
          }

          // Normal closure (1000) = server intentionally closed (terminal exited, deleted, etc.)
          // Don't reconnect for normal closures
          if (event.code === 1000) {
            term.write(`\r\n${TEXT_CLOSED}\r\n`);
            return;
          }

          // Abnormal closure (1006, etc.) = network issue, server crash, etc.
          // Try to reconnect if we haven't exceeded attempts
          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
            term.write(`\r\n\x1b[33m${TEXT_RECONNECTING} (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})\x1b[0m\r\n`);
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
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(data);
          }
        });
      } catch (err) {
        console.error('[Terminal] Failed to connect:', err);
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && hasConnectedOnce) {
          reconnectAttempts++;
          const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
          term.write(`\r\n\x1b[33m${TEXT_RECONNECTING} (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})\x1b[0m\r\n`);
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
      resizeObserver.disconnect();
      if (dataDisposable) {
        dataDisposable.dispose();
      }
      if (socket) {
        socket.close();
      }
      socketRef.current = null;

      // Dispose WebGL addon first to avoid disposal errors
      if (webglAddonRef.current) {
        try {
          webglAddonRef.current.dispose();
        } catch (err) {
          console.error('[WebGL] Error disposing addon during cleanup:', err);
        }
        webglAddonRef.current = null;
      }

      fitAddonRef.current = null;
      term.dispose();
    };
  }, [session.id, session.title, wsUrl]);

  return (
    <div className="terminal-tile">
      <div className="terminal-tile-header">
        <span>{session.title}</span>
        <button
          type="button"
          className="terminal-close-btn"
          onClick={onDelete}
          aria-label="ターミナルを閉じる"
        >
          ×
        </button>
      </div>
      <div className="terminal-tile-body" ref={containerRef} />
    </div>
  );
}
