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
 * Skip past a partial ANSI CSI escape sequence at the start of a buffer.
 *
 * When a terminal buffer is trimmed from the front, the cut point may land
 * inside a CSI sequence (e.g. "\x1b[38;2;100;50m").  The ESC and '[' are
 * discarded, leaving orphaned parameter bytes like "100;50m" that xterm.js
 * would render as literal text, shifting all subsequent cursor positions.
 *
 * This function detects two patterns:
 *   1. Buffer starts with '[' followed by CSI parameter / intermediate /
 *      final bytes  →  partial CSI whose ESC was trimmed.
 *   2. Buffer starts with CSI parameter bytes (digits, ';') containing at
 *      least one ';', ending with a final byte  →  partial CSI whose
 *      "ESC [" was trimmed.
 *
 * Returns the number of bytes to skip (0 if no partial sequence detected).
 */
export function skipPartialEscapeSequence(buf: Buffer, offset: number): number {
  if (offset >= buf.length) return 0;

  const limit = Math.min(buf.length, offset + 128);
  let pos = offset;

  // Pattern 1: starts with '[' (CSI intro without preceding ESC)
  if (buf[pos] === 0x5B /* '[' */ && pos + 1 < limit) {
    const next = buf[pos + 1];
    // Only treat as CSI if next byte is a parameter (0x30-0x3F) or
    // intermediate (0x20-0x2F) byte — avoids false positives like "[user@host"
    if ((next >= 0x30 && next <= 0x3F) || (next >= 0x20 && next <= 0x2F)) {
      pos++; // skip '['
      while (pos < limit) {
        const c = buf[pos];
        if ((c >= 0x30 && c <= 0x3F) || (c >= 0x20 && c <= 0x2F)) {
          pos++;
          continue;
        }
        if (c >= 0x40 && c <= 0x7E) {
          // CSI final byte — skip it and we're done
          return (pos + 1) - offset;
        }
        break;
      }
      return 0;
    }
    return 0;
  }

  // Pattern 2: starts with CSI parameter bytes (digits, ';', etc.)
  const b = buf[pos];
  if (b < 0x30 || b > 0x3F) return 0;

  let hasSemicolon = false;
  while (pos < limit) {
    const c = buf[pos];
    if (c >= 0x30 && c <= 0x3F) {
      if (c === 0x3B) hasSemicolon = true;
      pos++;
    } else if (c >= 0x20 && c <= 0x2F) {
      pos++;
    } else if (c >= 0x40 && c <= 0x7E) {
      // CSI final byte — only skip if we saw at least one semicolon
      // (avoids false positives like "5m" at the start of normal text)
      return hasSemicolon ? (pos + 1) - offset : 0;
    } else {
      break;
    }
  }
  return 0;
}
