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
