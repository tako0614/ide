import { type MiddlewareHandler } from 'hono';

// Security event logging
export function logSecurityEvent(event: string, details: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  console.warn(`[SECURITY] ${timestamp} ${event}:`, JSON.stringify(details));
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Allow Monaco Editor from CDN, Google Fonts, and blob: for workers
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net blob:; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:;");
  await next();
};
