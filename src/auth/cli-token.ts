import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DATA_DIR, HOST, PORT } from '../config.js';

/**
 * Credential for the local `deckide` CLI.
 *
 * Each server start writes a fresh random token to <data dir>/cli.json with
 * mode 0600 inside the 0700 data dir, i.e. readable only by the OS user that
 * already owns this server (and could read settings.json or ptrace it). The
 * CLI presents it as `Authorization: Bearer <token>`. Browsers never hold it:
 * a page cannot read the file, cannot attach custom headers to a WebSocket,
 * and a cross-site fetch carrying the header is stopped by originGuard.
 */
export const CLI_INFO_FILE = path.join(DATA_DIR, 'cli.json');

let token: string | null = null;

export function initializeCliToken(): void {
  token = crypto.randomBytes(32).toString('base64url');
  const info = { token, port: PORT, host: HOST, pid: process.pid };
  const temporary = `${CLI_INFO_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(info) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, CLI_INFO_FILE);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* not created */ }
    console.warn('[auth] Could not write CLI credentials; `deckide` CLI commands will need auth disabled:',
      error instanceof Error ? error.message : error);
  }
}

/** Remove the file on shutdown, unless a newer server instance replaced it. */
export function removeCliToken(): void {
  if (!token) return;
  try {
    const current = JSON.parse(fs.readFileSync(CLI_INFO_FILE, 'utf8')) as { token?: unknown };
    if (current.token === token) fs.unlinkSync(CLI_INFO_FILE);
  } catch {
    // Already gone or unreadable.
  }
}

function matches(supplied: string | undefined): boolean {
  if (!token || !supplied) return false;
  const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/.exec(supplied.trim());
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isCliAuthorization(header: string | undefined): boolean {
  return matches(header);
}

export function isCliRequest(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return matches(typeof header === 'string' ? header : undefined);
}
