import type { Terminal } from '@xterm/xterm';
import {
  TERMINAL_FOREGROUND_COLOR,
  TERMINAL_BACKGROUND_COLOR,
  TERMINAL_ANSI_PALETTE
} from '../constants';

// 8-bit (0-255) を 16-bit (0-65535) の hex 4桁へ。OSC の "rrrr/gggg/bbbb" 用。
function colorTo16BitHex(value: number): string {
  const val16 = value * 257;
  return val16.toString(16).padStart(4, '0');
}

// "#rrggbb" を OSC で使う "rrrr/gggg/bbbb" (16-bit per channel) へ変換。
function hexToRgb16(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${colorTo16BitHex(r)}/${colorTo16BitHex(g)}/${colorTo16BitHex(b)}`;
}

/**
 * TUI アプリがハングしないよう、端末問い合わせ（DSR/DA/DECRQM/OSC/DCS など）に
 * 応答するパーサハンドラを登録する。応答の送出は呼び出し側の sendResponse に委ねる
 * （リプレイ中の抑制や主クライアント判定はそちらで行う）。
 */
export function registerTerminalQueryHandlers(
  term: Terminal,
  sendResponse: (response: string) => void
): void {
  // DSR (Device Status Report) - CSI n
  term.parser.registerCsiHandler({ final: 'n' }, (params) => {
    const param = params.length > 0 ? params[0] as number : 0;

    if (param === 6) {
      // CPR - Cursor Position Report.
      // xterm.js's cursorY is already viewport-relative (0 = top visible
      // row).  Adding baseY (the scrollback offset) reports an absolute
      // buffer row like "3001", which makes TUI apps (shell prompts, fzf,
      // ink-based CLIs) miscompute layout and repaint at the wrong place.
      const buffer = term.buffer.active;
      const row = buffer.cursorY + 1;
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
  term.parser.registerCsiHandler({ final: 'c' }, () => {
    // Keep the device attributes conservative: no sixel/windowing claims.
    sendResponse('\x1b[?62;1;6;22c');
    return true;
  });

  // DA2 (Secondary Device Attributes) - CSI > c
  term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => {
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

  // OSC 10 - Foreground color query
  term.parser.registerOscHandler(10, (data) => {
    if (data === '?') {
      sendResponse(`\x1b]10;rgb:${hexToRgb16(TERMINAL_FOREGROUND_COLOR || '#ffffff')}\x07`);
      return true;
    }
    return false;
  });

  // OSC 11 - Background color query (CRITICAL for dark/light mode detection)
  term.parser.registerOscHandler(11, (data) => {
    if (data === '?') {
      sendResponse(`\x1b]11;rgb:${hexToRgb16(TERMINAL_BACKGROUND_COLOR || '#000000')}\x07`);
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

  // OSC 4 - Color palette query (individual ANSI colors).
  // 実際にレンダリングしている TERMINAL_ANSI_PALETTE から色を返すことで、
  // 色問い合わせの応答と表示が一致するようにする。
  term.parser.registerOscHandler(4, (data) => {
    const match = data.match(/^(\d+);?\?$/);
    if (match) {
      const colorIndex = parseInt(match[1]);
      const hex =
        colorIndex >= 0 && colorIndex < TERMINAL_ANSI_PALETTE.length
          ? TERMINAL_ANSI_PALETTE[colorIndex]
          : TERMINAL_ANSI_PALETTE[0];
      sendResponse(`\x1b]4;${colorIndex};rgb:${hexToRgb16(hex)}\x07`);
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
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => {
    sendResponse('\x1bP>|xterm.js(5.5.0)\x1b\\');
    return true;
  });

  // CSI u - Kitty keyboard protocol query (CRITICAL for Neovim/Helix)
  term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
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
  term.parser.registerCsiHandler({ prefix: '?', final: 'S' }, () => {
    // Don't respond = not supported
    return true; // Consume the sequence
  });

  // DECRQSS - Request Status String (DCS $ q Pt ST)
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, (data) => {
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
  term.parser.registerDcsHandler({ intermediates: '+', final: 'q' }, (data) => {
    // Decode hex-encoded capability names
    try {
      const hexPairs = data.match(/.{2}/g) || [];
      const capName = hexPairs.map((h) => String.fromCharCode(parseInt(h, 16))).join('');

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
        const hexValue = value.split('').map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
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
}
