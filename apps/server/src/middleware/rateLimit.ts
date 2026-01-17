import type { Context, MiddlewareHandler } from 'hono';
import { NODE_ENV, TRUST_PROXY } from '../config.js';
import { logSecurityEvent } from './security.js';

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 100;
const CLEANUP_INTERVAL_MS = 60000; // 1 minute
const MAX_TRACKED_IPS = 10000; // Prevent unbounded memory growth

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const ipRequestCounts = new Map<string, RateLimitEntry>();

// Cleanup old entries periodically with more aggressive cleanup
setInterval(() => {
  const now = Date.now();
  const entriesToDelete: string[] = [];

  for (const [ip, entry] of ipRequestCounts.entries()) {
    // Delete entries that have expired
    if (now > entry.resetTime) {
      entriesToDelete.push(ip);
    }
  }

  for (const ip of entriesToDelete) {
    ipRequestCounts.delete(ip);
  }

  // If still too many entries, remove oldest ones
  if (ipRequestCounts.size > MAX_TRACKED_IPS) {
    const entries = Array.from(ipRequestCounts.entries())
      .sort((a, b) => a[1].resetTime - b[1].resetTime);

    const toRemove = entries.slice(0, ipRequestCounts.size - MAX_TRACKED_IPS);
    for (const [ip] of toRemove) {
      ipRequestCounts.delete(ip);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

// Validate IP address format (basic validation)
function isValidIP(ip: string): boolean {
  if (!ip || ip.length > 45) return false; // Max length for IPv6
  // Basic pattern check - allow IPv4, IPv6, and IPv4-mapped IPv6
  return /^[\da-fA-F.:]+$/.test(ip);
}

function getClientIP(c: Context): string {
  // Only trust proxy headers if explicitly enabled
  if (TRUST_PROXY) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      const firstIp = forwarded.split(',')[0].trim();
      if (isValidIP(firstIp)) {
        return firstIp;
      }
    }

    const realIp = c.req.header('x-real-ip');
    if (realIp && isValidIP(realIp)) {
      return realIp;
    }
  }

  // Get actual remote address from socket
  const raw = c.req.raw as Request & { socket?: { remoteAddress?: string } };
  const remoteAddr = raw.socket?.remoteAddress;
  if (remoteAddr && isValidIP(remoteAddr)) {
    return remoteAddr;
  }

  // Fallback to a hash that's consistent per request but not spoofable
  return 'unknown-' + Date.now().toString(36);
}

export const apiRateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  // Skip rate limiting in development unless explicitly enabled
  if (NODE_ENV === 'development' && !process.env.ENABLE_RATE_LIMIT) {
    return next();
  }

  const ip = getClientIP(c);
  const now = Date.now();

  let entry = ipRequestCounts.get(ip);

  if (!entry || now > entry.resetTime) {
    entry = { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS };
    ipRequestCounts.set(ip, entry);
  } else {
    entry.count += 1;
  }

  // Set rate limit headers
  c.header('RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
  c.header('RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX_REQUESTS - entry.count)));
  c.header('RateLimit-Reset', String(Math.ceil(entry.resetTime / 1000)));

  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    logSecurityEvent('API_RATE_LIMIT_EXCEEDED', { ip, count: entry.count, path: c.req.path });
    c.header('Retry-After', String(Math.ceil((entry.resetTime - now) / 1000)));
    return c.json(
      { error: 'Too many requests, please try again later.' },
      429
    );
  }

  return next();
};
