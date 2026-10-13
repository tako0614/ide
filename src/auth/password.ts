import crypto from 'node:crypto';
const FORMAT = 'scrypt-v1';
const KEY_BYTES = 64;
const COST = { N: 1 << 14, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_BYTES, COST, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Portable on-disk password verifier. This module deliberately imports no runtime config. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) {
    throw new Error('Password must be 1 to 1024 bytes');
  }
  const salt = crypto.randomBytes(32);
  const hash = await derive(password, salt);
  return `${FORMAT}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function isPasswordHash(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== FORMAT) return false;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
    const salt = Buffer.from(parts[1], 'base64url');
    const hash = Buffer.from(parts[2], 'base64url');
    return salt.length === 32 && hash.length === KEY_BYTES &&
      salt.toString('base64url') === parts[1] && hash.toString('base64url') === parts[2];
  } catch {
    return false;
  }
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!isPasswordHash(encoded) || typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  const [, saltText, hashText] = encoded.split(':');
  const expected = Buffer.from(hashText, 'base64url');
  const actual = await derive(password, Buffer.from(saltText, 'base64url'));
  return crypto.timingSafeEqual(expected, actual);
}
