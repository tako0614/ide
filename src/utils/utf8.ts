/**
 * Skip past any UTF-8 continuation bytes (0x80-0xBF) at the given position
 * to find the start of the next complete character.
 *
 * UTF-8 encoding:
 *   0xxxxxxx  (0x00-0x7F) — 1-byte (ASCII)
 *   110xxxxx  (0xC0-0xDF) — 2-byte start
 *   1110xxxx  (0xE0-0xEF) — 3-byte start
 *   11110xxx  (0xF0-0xF7) — 4-byte start
 *   10xxxxxx  (0x80-0xBF) — continuation byte
 */
export function alignToUtf8Start(buf: Buffer, offset: number): number {
  while (offset < buf.length && (buf[offset] & 0xC0) === 0x80) {
    offset++;
  }
  return offset;
}

/**
 * Find the last valid UTF-8 character boundary at or before the given position.
 * This prevents slicing a buffer in the middle of a multi-byte sequence at the end.
 *
 * When offset equals buf.length, the function checks whether the last character
 * in the buffer is complete — an incomplete trailing sequence is excluded.
 */
export function alignToUtf8End(buf: Buffer, offset: number): number {
  if (offset <= 0 || buf.length === 0) {
    return offset;
  }

  // Clamp to buffer length so we can safely inspect the last byte
  const effectiveEnd = Math.min(offset, buf.length);

  // Walk backwards from the last byte within the range, skipping continuation bytes
  let pos = effectiveEnd - 1;
  while (pos > 0 && (buf[pos] & 0xC0) === 0x80) {
    pos--;
  }

  // pos is now at a potential start byte — determine expected character length
  const startByte = buf[pos];
  let charLen: number;
  if ((startByte & 0x80) === 0) charLen = 1;
  else if ((startByte & 0xE0) === 0xC0) charLen = 2;
  else if ((startByte & 0xF0) === 0xE0) charLen = 3;
  else if ((startByte & 0xF8) === 0xF0) charLen = 4;
  else charLen = 1; // Invalid start byte — treat as single byte

  if (pos + charLen <= effectiveEnd) {
    // The character is complete within the range
    return effectiveEnd;
  }
  // The character is incomplete — exclude it
  return pos;
}

/**
 * Skip past a partial ANSI escape sequence at the start of a buffer.
 *
 * When a terminal buffer is trimmed from the front, the cut point may land
 * inside an escape sequence.  The leading ESC byte (and possibly the type
 * indicator) is discarded, leaving orphaned payload bytes that xterm.js
 * would render as literal text, shifting all subsequent cursor positions.
 *
 * Handled sequence types:
 *
 *   CSI  (ESC [)  — e.g. "\x1b[38;2;100;50m"
 *     Detected as: '[' + params/intermediates + final byte
 *     or: bare params with ';' + final byte  (ESC and '[' both trimmed)
 *
 *   OSC  (ESC ])  — e.g. "\x1b]0;title\x07"
 *     Detected as: ']' + text + BEL/ST terminator
 *
 *   DCS  (ESC P)  — e.g. "\x1bP1$r...\x1b\\"
 *     Detected as: 'P' + text + ST terminator
 *
 *   APC  (ESC _)  — e.g. "\x1b_...\x1b\\"
 *     Detected as: '_' + text + ST terminator
 *
 * Returns the number of bytes to skip (0 if no partial sequence detected).
 */
export function skipPartialEscapeSequence(buf: Buffer, offset: number): number {
  if (offset >= buf.length) return 0;

  const b = buf[offset];

  // ── CSI: starts with '[' (ESC was trimmed) ──
  if (b === 0x5B /* '[' */) {
    return skipPartialCSI(buf, offset);
  }

  // ── OSC: starts with ']' (ESC was trimmed) ──
  if (b === 0x5D /* ']' */) {
    return skipStringSequence(buf, offset);
  }

  // ── DCS: starts with 'P' (ESC was trimmed) ──
  // Only treat as DCS if followed by a parameter byte, '$', or printable
  // control sequence byte — avoids false positive on words like "Path".
  if (b === 0x50 /* 'P' */ && offset + 1 < buf.length) {
    const next = buf[offset + 1];
    if ((next >= 0x30 && next <= 0x3F) || next === 0x24 /* '$' */) {
      return skipStringSequence(buf, offset);
    }
  }

  // ── APC: starts with '_' (ESC was trimmed) ──
  if (b === 0x5F /* '_' */) {
    return skipStringSequence(buf, offset);
  }

  // ── Bare CSI params (both ESC and '[' trimmed) ──
  if (b >= 0x30 && b <= 0x3F) {
    return skipBareCSIParams(buf, offset);
  }

  return 0;
}

/**
 * Skip a partial CSI sequence starting with '['.
 * Pattern: '[' params intermediates final
 */
function skipPartialCSI(buf: Buffer, offset: number): number {
  const limit = Math.min(buf.length, offset + 128);
  if (offset + 1 >= limit) return 0;

  const next = buf[offset + 1];
  // Only treat as CSI if the next byte is a parameter (0x30-0x3F) or
  // intermediate (0x20-0x2F) — avoids false positives like "[user@host"
  if (next < 0x20 || (next > 0x3F && next < 0x40)) return 0;
  // If next is already a final byte (letter), it could be "[H" (cursor home)
  // or "[hello" — skip only the 2-byte "[H" style if the byte after final
  // is a control char or ESC (strong signal it was a real sequence).
  if (next >= 0x40 && next <= 0x7E) {
    if (offset + 2 < buf.length) {
      const after = buf[offset + 2];
      if (after === 0x1B || after < 0x20) return 2;
    }
    return 0;
  }

  let pos = offset + 1;
  while (pos < limit) {
    const c = buf[pos];
    if ((c >= 0x30 && c <= 0x3F) || (c >= 0x20 && c <= 0x2F)) {
      pos++;
      continue;
    }
    if (c >= 0x40 && c <= 0x7E) {
      return (pos + 1) - offset;
    }
    break;
  }
  return 0;
}

/**
 * Skip bare CSI parameter bytes (both ESC and '[' were trimmed).
 * Pattern: digits/';' (with at least one ';') + final byte
 */
function skipBareCSIParams(buf: Buffer, offset: number): number {
  const limit = Math.min(buf.length, offset + 128);
  let pos = offset;
  let hasSemicolon = false;

  while (pos < limit) {
    const c = buf[pos];
    if (c >= 0x30 && c <= 0x3F) {
      if (c === 0x3B) hasSemicolon = true;
      pos++;
    } else if (c >= 0x20 && c <= 0x2F) {
      pos++;
    } else if (c >= 0x40 && c <= 0x7E) {
      // Only skip if we saw ';' — avoids false positives like "5m"
      return hasSemicolon ? (pos + 1) - offset : 0;
    } else {
      break;
    }
  }
  return 0;
}

/**
 * Skip a string-type escape sequence (OSC / DCS / APC) that starts with
 * the type indicator byte (']', 'P', or '_') — the leading ESC was trimmed.
 *
 * These sequences are terminated by:
 *   - BEL  (0x07)              — common for OSC
 *   - ST   (ESC \  = 0x1B 0x5C) — standard for all
 *
 * We scan up to 4 KB for the terminator; if not found we skip nothing
 * (the partial sequence might span far beyond what we want to discard).
 */
function skipStringSequence(buf: Buffer, offset: number): number {
  const limit = Math.min(buf.length, offset + 4096);
  let pos = offset + 1; // skip the type indicator byte

  while (pos < limit) {
    const c = buf[pos];
    if (c === 0x07) {
      // BEL terminator
      return (pos + 1) - offset;
    }
    if (c === 0x1B && pos + 1 < buf.length && buf[pos + 1] === 0x5C) {
      // ST terminator (ESC \)
      return (pos + 2) - offset;
    }
    // If we hit another ESC that's NOT followed by '\', it's a new sequence
    if (c === 0x1B) {
      return pos - offset;
    }
    pos++;
  }
  return 0;
}
