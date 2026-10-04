import { type MiddlewareHandler } from 'hono';
import { ALLOWED_HOSTS, ALLOW_INSECURE_HOST, CORS_ORIGIN, NODE_ENV, PORT, TRUST_PROXY } from '../config.js';
import { logSecurityEvent } from './security.js';

/**
 * Cross-site request protection for the HTTP API.
 *
 * The API can create workspaces at arbitrary paths and spawn terminals running
 * arbitrary commands, so a request that merely *originates* in the victim's
 * browser is as dangerous as an authenticated one. Two headers gate that:
 *
 * - `Origin` rejects classic CSRF. Note that a cross-site POST executes its
 *   side effect even when CORS stops the attacker reading the response, so the
 *   response-header-only CORS policy is not sufficient on its own. For the same
 *   reason `CORS_ORIGIN='*'` does not disable this check — it widens who may
 *   read a response, which says nothing about who may trigger one. This matches
 *   isAllowedWsOrigin() in websocket.ts.
 * - `Host` rejects DNS rebinding, which otherwise defeats both the loopback
 *   bind and the Origin check by making the attacker's page same-origin.
 *
 * WebSocket upgrades are checked separately in websocket.ts.
 */

const DEV_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:3000',
  `http://localhost:${PORT}`,
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function corsOriginHost(): string | null {
  if (!CORS_ORIGIN || CORS_ORIGIN === '*') {
    return null;
  }
  try {
    return new URL(CORS_ORIGIN).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Splits a Host header into its hostname, handling `[::1]:8787` and `host:port`. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(1, end);
  }
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * An address the attacker cannot repoint mid-session. Rebinding works by
 * changing what a *name* resolves to, so a literal IP is inherently safe and
 * LAN/mobile access over http://192.168.x.x:8787 keeps working unconfigured.
 */
function isAddressLiteral(hostname: string): boolean {
  if (IPV4.test(hostname)) {
    return hostname.split('.').every((octet) => Number(octet) <= 255);
  }
  return hostname.includes(':'); // IPv6 literal, brackets already stripped
}

function isAllowedHost(hostHeader: string): boolean {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true;
  }
  if (isAddressLiteral(hostname)) {
    return true;
  }
  if (ALLOWED_HOSTS.includes(hostname)) {
    return true;
  }
  // CORS_ORIGIN carries a port; accept it against either form of the Host.
  const cors = corsOriginHost();
  return cors !== null && (cors === hostname || cors === hostHeader.trim().toLowerCase());
}

function isAllowedOrigin(origin: string, hostHeader: string): boolean {
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase(); // includes port
  } catch {
    return false; // opaque origins such as "null"
  }

  // Same-origin is never cross-site, whatever hostname the user reached us by.
  if (hostHeader && originHost === hostHeader.trim().toLowerCase()) {
    return true;
  }
  if (corsOriginHost() === originHost) {
    return true;
  }
  return NODE_ENV !== 'production' && DEV_ORIGINS.has(origin);
}

/**
 * Resolve the Host this request claims to have reached, honouring a forwarded
 * host only when the operator has opted into trusting the proxy.
 */
export function resolveHostHeader(
  host: string | undefined,
  forwardedHost: string | undefined
): string {
  const forwarded = TRUST_PROXY ? forwardedHost?.split(',')[0].trim() : undefined;
  return forwarded || host || '';
}

/**
 * The cross-site decision, shared by the HTTP guard and the WebSocket upgrade
 * path so the two can never drift apart. Returns the reason a request must be
 * refused, or null when it may proceed.
 */
export function checkRequestOrigin(
  origin: string | undefined,
  hostHeader: string
): 'host' | 'origin' | null {
  // Behind a trusted proxy the Host is whatever the proxy forwards, and the
  // operator has already accepted that trust boundary.
  if (!ALLOW_INSECURE_HOST && !isAllowedHost(hostHeader)) {
    return 'host';
  }
  if (origin && !isAllowedOrigin(origin, hostHeader)) {
    return 'origin';
  }
  return null;
}

export const originGuard: MiddlewareHandler = async (c, next) => {
  const hostHeader = resolveHostHeader(c.req.header('host'), c.req.header('x-forwarded-host'));
  const origin = c.req.header('origin');

  switch (checkRequestOrigin(origin, hostHeader)) {
    case 'host':
      logSecurityEvent('HTTP_INVALID_HOST', { host: hostHeader, path: c.req.path });
      return c.json(
        { error: 'Invalid Host header. Set DECKIDE_ALLOWED_HOSTS to reach this server by name.' },
        403
      );
    case 'origin':
      logSecurityEvent('HTTP_INVALID_ORIGIN', { origin, host: hostHeader, path: c.req.path });
      return c.json({ error: 'Invalid origin' }, 403);
  }

  return next();
};
