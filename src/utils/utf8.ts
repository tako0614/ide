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
 */
export function alignToUtf8End(buf: Buffer, offset: number): number {
  if (offset <= 0 || offset >= buf.length) {
    return offset;
  }
  // If the byte at `offset` is a continuation byte, we're mid-character.
  // Walk backwards to find the start byte, then check if the full character fits.
  let pos = offset;
  while (pos > 0 && (buf[pos] & 0xC0) === 0x80) {
    pos--;
  }
  if (pos === offset) {
    // Not in the middle of a multi-byte sequence
    return offset;
  }
  // pos is now at the start byte — determine expected character length
  const startByte = buf[pos];
  let charLen: number;
  if ((startByte & 0x80) === 0) charLen = 1;
  else if ((startByte & 0xE0) === 0xC0) charLen = 2;
  else if ((startByte & 0xF0) === 0xE0) charLen = 3;
  else if ((startByte & 0xF8) === 0xF0) charLen = 4;
  else charLen = 1; // Invalid start byte — treat as single byte

  if (pos + charLen <= offset) {
    // The character fits before `offset` — no truncation needed
    return offset;
  }
  // The character is incomplete at `offset` — exclude it
  return pos;
}
