export const desktopAppCatalog = [
  { id: 'browser', label: 'Browser', binaries: ['google-chrome', 'chromium', 'chromium-browser'] },
  { id: 'terminal', label: 'Terminal', binaries: ['xterm'] },
  { id: 'editor', label: 'Text editor', binaries: ['mousepad', 'leafpad', 'gedit', 'xed'] },
  { id: 'calculator', label: 'Calculator', binaries: ['galculator', 'gnome-calculator', 'mate-calc'] },
] as const;

export type DesktopAppId = (typeof desktopAppCatalog)[number]['id'] | `system:${string}` | `developed:${string}`;

export function desktopApp(id: unknown) {
  return desktopAppCatalog.find((app) => app.id === id);
}

export function validateLaunchRequest(value: unknown): { app: DesktopAppId; url?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'app' && key !== 'url'))
    throw createHttpError('Invalid desktop launch request', 400);
  const request = value as Record<string, unknown>;
  const app = request.app;
  if (typeof app !== 'string' ||
    (!desktopApp(app) && !/^system:[a-f0-9]{64}$/.test(app) && !/^developed:[a-f0-9-]{36}$/.test(app)))
    throw createHttpError('Unknown desktop app', 400);
  if (app !== 'browser' && request.url !== undefined)
    throw createHttpError('Only browser accepts URL', 400);
  if (request.url === undefined) return { app: app as DesktopAppId };
  if (typeof request.url !== 'string' || request.url.length > 2048)
    throw createHttpError('Invalid URL', 400);
  if (request.url === 'about:blank') return { app: app as DesktopAppId, url: request.url };
  let parsed: URL;
  try { parsed = new URL(request.url); } catch { throw createHttpError('Invalid URL', 400); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw createHttpError('Only HTTP(S) URLs without credentials are allowed', 400);
  return { app: app as DesktopAppId, url: parsed.href };
}
import { createHttpError } from '../utils/error.js';
