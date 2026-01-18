import { basicAuth } from 'hono/basic-auth';
import crypto from 'node:crypto';
import { BASIC_AUTH_USER, BASIC_AUTH_PASSWORD } from '../config.js';

export const basicAuthMiddleware = BASIC_AUTH_USER && BASIC_AUTH_PASSWORD
  ? basicAuth({ username: BASIC_AUTH_USER, password: BASIC_AUTH_PASSWORD })
  : undefined;

// WebSocket token management
const WS_TOKEN_TTL_MS = 30 * 1000; // 30 seconds
const wsTokens = new Map<string, number>(); // token -> expiry timestamp

// Cleanup expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of wsTokens.entries()) {
    if (now > expiry) {
      wsTokens.delete(token);
    }
  }
}, 10000).unref();

/**
 * Generate a one-time WebSocket token
 */
export function generateWsToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  wsTokens.set(token, Date.now() + WS_TOKEN_TTL_MS);
  return token;
}

/**
 * Validate and consume a WebSocket token
 */
export function validateWsToken(token: string): boolean {
  const expiry = wsTokens.get(token);
  if (!expiry) {
    return false;
  }
  wsTokens.delete(token); // One-time use
  return Date.now() <= expiry;
}

/**
 * Check if Basic Auth is enabled
 */
export function isBasicAuthEnabled(): boolean {
  return Boolean(BASIC_AUTH_USER && BASIC_AUTH_PASSWORD);
}

export function verifyWebSocketAuth(req: import('http').IncomingMessage): boolean {
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASSWORD) {
    return true;
  }

  // Check for token in query string first
  const url = new URL(req.url || '', 'http://localhost');
  const token = url.searchParams.get('token');
  if (token && validateWsToken(token)) {
    return true;
  }

  // Fall back to Basic Auth header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }
  const base64Credentials = authHeader.slice('Basic '.length);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    return false;
  }
  const username = credentials.substring(0, colonIndex);
  const password = credentials.substring(colonIndex + 1);
  return username === BASIC_AUTH_USER && password === BASIC_AUTH_PASSWORD;
}
