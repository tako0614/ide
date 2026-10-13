import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { MiddlewareHandler, Context } from 'hono';
import { HOST, TRUST_PROXY, isLoopbackHost } from '../config.js';
import { getCredentials } from '../auth/credentials.js';
import { verifyPassword } from '../auth/password.js';
import { resolveHostHeader } from './origin.js';
import { isCliAuthorization, isCliRequest } from '../auth/cli-token.js';

const COOKIE = 'deckide_session';
const TEST_TTL = process.env.NODE_ENV === 'test' ? Number(process.env.DECKIDE_TEST_SESSION_TTL_MS) : NaN;
const SESSION_TTL = Number.isInteger(TEST_TTL) && TEST_TTL >= 100 && TEST_TTL <= 12 * 60 * 60 * 1000
  ? TEST_TTL : 12 * 60 * 60 * 1000;
const TICKET_TTL = 30_000;
const bridgeSecret = crypto.randomBytes(32).toString('base64url');
type Session = { user: string; expiresAt: number; guest?: true };
type Ticket = { sessionKey: string; expiresAt: number };
const sessions = new Map<string, Session>();
const tickets = new Map<string, Ticket>();
const sockets = new Map<string, Set<() => void>>();
const anonymousSockets = new Set<() => void>();
const attempts = new Map<string, { count: number; resetAt: number }>();
let verifying = 0;

const digest = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function cleanup(): void {
  const now = Date.now();
  for (const [key, session] of sessions) if (session.expiresAt <= now) revokeSession(key);
  for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
  for (const [key, entry] of attempts) if (entry.resetAt <= now) attempts.delete(key);
}

function cookieToken(header: string | undefined): string | null {
  if (!header || header.length > 4096) return null;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(COOKIE + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function sessionByCookie(header: string | undefined): { key: string; session: Session } | null {
  const token = cookieToken(header);
  if (!token) return null;
  const key = digest(token);
  const session = sessions.get(key);
  if (!session) return null;
  if (session.expiresAt <= Date.now() || (session.guest && isAuthEnabled())) { revokeSession(key); return null; }
  return { key, session };
}

export function currentSession(c: Context) { return sessionByCookie(c.req.header('cookie')); }
export function isAuthEnabled(): boolean { return getCredentials().enabled; }
export function oauthCsrfToken(c: Context): string | null {
  const session = currentSession(c);
  return session ? crypto.createHmac('sha256', bridgeSecret).update('oauth:' + session.key).digest('base64url') : null;
}
export function validOauthConsent(c: Context, submitted: string | null): boolean {
  const expected = effectiveOrigin(c);
  if (!expected || c.req.header('origin') !== expected.origin) return false;
  if (!isAuthEnabled()) return true;
  const token = oauthCsrfToken(c);
  return Boolean(token && submitted && token.length === submitted.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(submitted)));
}
export function revokeSession(key: string): void {
  sessions.delete(key);
  for (const [token, ticket] of tickets) if (ticket.sessionKey === key) tickets.delete(token);
  const callbacks = sockets.get(key);
  sockets.delete(key);
  for (const close of callbacks ?? []) { try { close(); } catch { /* already closed */ } }
}
export function revokeAllSessions(): void {
  for (const key of [...sessions.keys()]) revokeSession(key);
  tickets.clear();
  for (const close of [...anonymousSockets]) { try { close(); } catch { /* already closed */ } }
  anonymousSockets.clear();
}
export function onSessionRevoked(key: string, close: () => void): () => void {
  // The local CLI token lives as long as the server process.
  if (key === 'cli') return () => {};
  if (key === 'anonymous') {
    anonymousSockets.add(close);
    return () => { anonymousSockets.delete(close); };
  }
  const session = sessions.get(key);
  if (!session || session.expiresAt <= Date.now()) { close(); return () => {}; }
  let group = sockets.get(key);
  if (!group) { group = new Set(); sockets.set(key, group); }
  group.add(close);
  const timer = setTimeout(() => revokeSession(key), session.expiresAt - Date.now());
  timer.unref();
  return () => { clearTimeout(timer); group?.delete(close); if (!group?.size) sockets.delete(key); };
}

function effectiveOrigin(c: Context): { origin: string; secure: boolean } | null {
  const host = resolveHostHeader(c.req.header('host'), c.req.header('x-forwarded-host'));
  if (!host || /[\s/@]/.test(host)) return null;
  const forwarded = TRUST_PROXY ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() : undefined;
  if (forwarded && forwarded !== 'http' && forwarded !== 'https') return null;
  const scheme = forwarded ?? 'http';
  return { origin: scheme + '://' + host.toLowerCase(), secure: scheme === 'https' };
}
export function validBrowserMutation(c: Context): boolean {
  const expected = effectiveOrigin(c);
  return Boolean(expected && c.req.header('origin') === expected.origin && c.req.header('x-deckide-csrf') === '1');
}
export function secureCookieAllowed(c: Context): boolean {
  const expected = effectiveOrigin(c);
  const peer = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress;
  return Boolean(expected && (expected.secure ||
    (isLoopbackHost(new URL(expected.origin).hostname) &&
      (isLoopbackHost(peer ?? '') || (!peer && isLoopbackHost(HOST))))));
}
function setSessionCookie(c: Context, token: string, clear = false): void {
  const secure = effectiveOrigin(c)?.secure ? '; Secure' : '';
  c.header('Set-Cookie', COOKIE + '=' + (clear ? '' : token) +
    '; Path=/; HttpOnly; SameSite=Strict' + secure + '; Max-Age=' + (clear ? 0 : Math.ceil(SESSION_TTL / 1000)));
}

export function internalBridgeHeader(): string { return bridgeSecret; }
function isInternal(c: Context): boolean {
  const supplied = c.req.header('x-deckide-internal');
  return Boolean(supplied && supplied.length === bridgeSecret.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(bridgeSecret)));
}
/** Only the in-process MCP bridge may supply an OAuth grant identity. */
export function verifiedInternalActor(c: Context): string | null {
  if (!isInternal(c)) return null;
  const actor = c.req.header('x-deckide-actor');
  return actor && /^oauth:[a-f0-9]{64}$/.test(actor) ? actor : null;
}
/** Request authenticated with the local CLI token (see auth/cli-token.ts). */
export function isCliActor(c: Context): boolean {
  return isCliAuthorization(c.req.header('authorization'));
}
export const sessionGuard: MiddlewareHandler = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // The CLI token is never held by a browser, so it needs no CSRF header.
  if (isInternal(c) || isCliActor(c) || !isAuthEnabled()) return next();
  if (!currentSession(c)) return c.json({ error: 'Authentication required' }, 401);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !validBrowserMutation(c)) {
    return c.json({ error: 'Invalid origin or CSRF header' }, 403);
  }
  return next();
};

export function sessionStatus(c: Context) {
  c.header('Cache-Control', 'no-store');
  const authEnabled = isAuthEnabled();
  let session = currentSession(c);
  // Anonymous mode still gives each browser a separate desktop observation
  // identity. Never mint this cookie on an untrusted plaintext network path.
  if (!authEnabled && !session && secureCookieAllowed(c)) {
    cleanup();
    if (sessions.size >= 64) revokeSession(sessions.keys().next().value!);
    const token = randomToken();
    const entry: Session = { user: '', expiresAt: Date.now() + SESSION_TTL, guest: true };
    sessions.set(digest(token), entry);
    setSessionCookie(c, token);
    session = { key: digest(token), session: entry };
  }
  return c.json({ authEnabled, authenticated: !authEnabled || Boolean(session),
    ...(authEnabled && session ? { username: session.session.user } : {}) });
}

export async function login(c: Context) {
  c.header('Cache-Control', 'no-store');
  if (!validBrowserMutation(c) || !secureCookieAllowed(c) ||
    !c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
    return c.json({ error: 'Invalid login origin or transport' }, 403);
  }
  if (!isAuthEnabled()) return c.json({ authEnabled: false, authenticated: true });
  cleanup();
  // Use the transport peer, never client-controlled forwarding headers.
  const peer = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress;
  const key = peer ?? 'local-test-client';
  const attempt = attempts.get(key);
  if (attempt && attempt.count >= 5 && attempt.resetAt > Date.now()) return c.json({ error: 'Too many login attempts' }, 429);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid credentials' }, 401);
  const candidate = body as { username?: unknown; password?: unknown };
  if (typeof candidate.username !== 'string' || typeof candidate.password !== 'string' ||
    candidate.username.length > 128 || Buffer.byteLength(candidate.password) > 1024) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  if (verifying >= 4) return c.json({ error: 'Login busy' }, 429);
  const currentAttempt = attempts.get(key);
  if (currentAttempt && currentAttempt.count >= 5 && currentAttempt.resetAt > Date.now()) {
    return c.json({ error: 'Too many login attempts' }, 429);
  }
  // Reserve before the asynchronous KDF so concurrent guesses count separately.
  if (attempts.size >= 512 && !currentAttempt) attempts.delete(attempts.keys().next().value!);
  attempts.set(key, { count: (currentAttempt?.count ?? 0) + 1, resetAt: currentAttempt?.resetAt ?? Date.now() + 300_000 });
  const credential = getCredentials();
  verifying++;
  let valid = false;
  try {
    const passwordMatch = await verifyPassword(candidate.password, credential.hash);
    const actual = Buffer.from(candidate.username);
    const expected = Buffer.from(credential.user);
    valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected) &&
      passwordMatch && getCredentials() === credential;
  } finally { verifying--; }
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  attempts.delete(key);
  const prior = currentSession(c);
  if (prior) revokeSession(prior.key);
  const token = randomToken();
  if (sessions.size >= 64) revokeSession(sessions.keys().next().value!);
  sessions.set(digest(token), { user: credential.user, expiresAt: Date.now() + SESSION_TTL });
  setSessionCookie(c, token);
  return c.json({ authEnabled: true, authenticated: true, username: credential.user });
}
export function logout(c: Context) {
  c.header('Cache-Control', 'no-store');
  if (!validBrowserMutation(c)) return c.json({ error: 'Invalid origin or CSRF header' }, 403);
  const entry = currentSession(c);
  if (entry) revokeSession(entry.key);
  setSessionCookie(c, '', true);
  return c.body(null, 204);
}
export function generateWsToken(sessionKey: string): string {
  cleanup();
  if (!sessions.has(sessionKey)) throw new Error('Session expired');
  if (tickets.size >= 256) tickets.delete(tickets.keys().next().value!);
  const token = randomToken();
  tickets.set(digest(token), { sessionKey, expiresAt: Date.now() + TICKET_TTL });
  return token;
}
export function verifyWebSocketAuth(req: IncomingMessage): string | null {
  if (isCliRequest(req)) return 'cli';
  if (!isAuthEnabled()) return 'anonymous';
  const cookie = sessionByCookie(req.headers.cookie);
  if (!cookie) return null;
  const token = new URL(req.url || '/', 'http://localhost').searchParams.get('token');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const key = digest(token);
  const ticket = tickets.get(key);
  tickets.delete(key);
  return ticket && ticket.sessionKey === cookie.key && ticket.expiresAt > Date.now() ? cookie.key : null;
}
export function validWebSocketOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = resolveHostHeader(req.headers.host, req.headers['x-forwarded-host'] as string | undefined);
  if (!origin || !host || /[\s/@]/.test(host)) return false;
  const forwarded = TRUST_PROXY ? (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim().toLowerCase() : undefined;
  if (forwarded && forwarded !== 'http' && forwarded !== 'https') return false;
  return origin === (forwarded ?? 'http') + '://' + host.toLowerCase();
}
