import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Workspace } from '../types.js';
import { MAX_FILE_SIZE, NODE_ENV, DEFAULT_ROOT, TRUST_PROXY } from '../config.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { resolveSafePath, normalizeWorkspacePath } from '../utils/path.js';
import { requireWorkspace } from './workspaces.js';
import { sortFileEntries } from '@deck-ide/shared/utils-node';
import { logSecurityEvent } from '../middleware/security.js';

// File upload rate limiting configuration
const FILE_UPLOAD_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const FILE_UPLOAD_MAX_REQUESTS = 30;
const MAX_TRACKED_IPS = 10000;

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const uploadRateLimits = new Map<string, RateLimitEntry>();

// Cleanup old entries periodically with memory limit
setInterval(() => {
  const now = Date.now();
  const entriesToDelete: string[] = [];
  for (const [ip, entry] of uploadRateLimits.entries()) {
    if (now > entry.resetTime) {
      entriesToDelete.push(ip);
    }
  }
  for (const ip of entriesToDelete) {
    uploadRateLimits.delete(ip);
  }
  // Enforce max tracked IPs
  if (uploadRateLimits.size > MAX_TRACKED_IPS) {
    const entries = Array.from(uploadRateLimits.entries())
      .sort((a, b) => a[1].resetTime - b[1].resetTime);
    const toRemove = entries.slice(0, uploadRateLimits.size - MAX_TRACKED_IPS);
    for (const [ip] of toRemove) {
      uploadRateLimits.delete(ip);
    }
  }
}, 60000).unref();

// Validate IP address format
function isValidIP(ip: string): boolean {
  if (!ip || ip.length > 45) return false;
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
  return 'unknown-' + Date.now().toString(36);
}

const fileUploadRateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  // Skip rate limiting in development unless explicitly enabled
  if (NODE_ENV === 'development' && !process.env.ENABLE_RATE_LIMIT) {
    return next();
  }

  const ip = getClientIP(c);
  const now = Date.now();

  let entry = uploadRateLimits.get(ip);

  if (!entry || now > entry.resetTime) {
    entry = { count: 1, resetTime: now + FILE_UPLOAD_WINDOW_MS };
    uploadRateLimits.set(ip, entry);
  } else {
    entry.count += 1;
  }

  c.header('RateLimit-Limit', String(FILE_UPLOAD_MAX_REQUESTS));
  c.header('RateLimit-Remaining', String(Math.max(0, FILE_UPLOAD_MAX_REQUESTS - entry.count)));
  c.header('RateLimit-Reset', String(Math.ceil(entry.resetTime / 1000)));

  if (entry.count > FILE_UPLOAD_MAX_REQUESTS) {
    logSecurityEvent('FILE_UPLOAD_RATE_LIMIT_EXCEEDED', { ip, count: entry.count });
    c.header('Retry-After', String(Math.ceil((entry.resetTime - now) / 1000)));
    return c.json(
      { error: 'Too many file upload requests, please try again later.' },
      429
    );
  }

  return next();
};

export function createFileRouter(workspaces: Map<string, Workspace>) {
  const router = new Hono();

  router.get('/files', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      const workspace = requireWorkspace(workspaces, workspaceId);
      const requestedPath = c.req.query('path') || '';
      const target = await resolveSafePath(workspace.path, requestedPath);
      const stats = await fs.stat(target);
      if (!stats.isDirectory()) {
        throw createHttpError('Path is not a directory', 400);
      }
      const entries = await fs.readdir(target, { withFileTypes: true });
      const normalizedBase = requestedPath.replace(/\\/g, '/');
      const mapped = entries.map((entry) => {
        const entryPath = normalizedBase
          ? `${normalizedBase}/${entry.name}`
          : entry.name;
        return {
          name: entry.name,
          path: entryPath,
          type: (entry.isDirectory() ? 'dir' : 'file') as 'dir' | 'file'
        };
      });
      const sorted = sortFileEntries(mapped);
      return c.json(sorted);
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.get('/preview', async (c) => {
    try {
      const rootInput = c.req.query('path') || DEFAULT_ROOT;
      const requestedPath = c.req.query('subpath') || '';
      const rootPath = normalizeWorkspacePath(rootInput);
      const target = await resolveSafePath(rootPath, requestedPath);
      const stats = await fs.stat(target);
      if (!stats.isDirectory()) {
        throw createHttpError('Path is not a directory', 400);
      }
      const entries = await fs.readdir(target, { withFileTypes: true });
      const normalizedBase = String(requestedPath || '').replace(/\\/g, '/');
      const mapped = entries.map((entry) => {
        const entryPath = normalizedBase
          ? `${normalizedBase}/${entry.name}`
          : entry.name;
        return {
          name: entry.name,
          path: entryPath,
          type: (entry.isDirectory() ? 'dir' : 'file') as 'dir' | 'file'
        };
      });
      const sorted = sortFileEntries(mapped);
      return c.json(sorted);
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.get('/file', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      const workspace = requireWorkspace(workspaces, workspaceId);
      const target = await resolveSafePath(workspace.path, c.req.query('path') || '');
      const stats = await fs.stat(target);
      if (stats.size > MAX_FILE_SIZE) {
        throw createHttpError(`File too large (${Math.round(stats.size / 1024 / 1024)}MB). Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB.`, 413);
      }
      const contents = await fs.readFile(target, 'utf8');
      return c.json({ path: c.req.query('path'), contents });
    } catch (error) {
      return handleError(c, error);
    }
  });

  router.put('/file', fileUploadRateLimitMiddleware, async (c) => {
    try {
      const body = await readJson<{
        workspaceId?: string;
        path?: string;
        contents?: string;
      }>(c);
      const workspaceId = body?.workspaceId;
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      const workspace = requireWorkspace(workspaces, workspaceId);
      const target = await resolveSafePath(workspace.path, body?.path || '');
      const contents = body?.contents ?? '';
      const contentSize = Buffer.byteLength(contents, 'utf8');
      if (contentSize > MAX_FILE_SIZE) {
        throw createHttpError(`Content size exceeds maximum allowed size of ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`, 413);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, 'utf8');
      return c.json({ path: body?.path, saved: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Create new file
  router.post('/file', fileUploadRateLimitMiddleware, async (c) => {
    try {
      const body = await readJson<{
        workspaceId?: string;
        path?: string;
        contents?: string;
      }>(c);
      const workspaceId = body?.workspaceId;
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      if (!body?.path) {
        throw createHttpError('path is required', 400);
      }
      const workspace = requireWorkspace(workspaces, workspaceId);
      const target = await resolveSafePath(workspace.path, body.path);

      // Check if file already exists
      try {
        await fs.access(target);
        throw createHttpError('File already exists', 409);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }

      const contents = body?.contents ?? '';
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, 'utf8');
      return c.json({ path: body.path, created: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Delete file
  router.delete('/file', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      const filePath = c.req.query('path');
      if (!filePath) {
        throw createHttpError('path is required', 400);
      }
      const workspace = requireWorkspace(workspaces, workspaceId);
      const target = await resolveSafePath(workspace.path, filePath);

      const stats = await fs.stat(target);
      if (stats.isDirectory()) {
        throw createHttpError('Path is a directory, use DELETE /dir instead', 400);
      }

      await fs.unlink(target);
      return c.json({ path: filePath, deleted: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Create directory
  router.post('/dir', async (c) => {
    try {
      const body = await readJson<{
        workspaceId?: string;
        path?: string;
      }>(c);
      const workspaceId = body?.workspaceId;
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      if (!body?.path) {
        throw createHttpError('path is required', 400);
      }
      const workspace = requireWorkspace(workspaces, workspaceId);
      const target = await resolveSafePath(workspace.path, body.path);

      // Check if already exists
      try {
        await fs.access(target);
        throw createHttpError('Directory already exists', 409);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }

      await fs.mkdir(target, { recursive: true });
      return c.json({ path: body.path, created: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Delete directory
  router.delete('/dir', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      const dirPath = c.req.query('path');
      if (!dirPath) {
        throw createHttpError('path is required', 400);
      }
      const workspace = requireWorkspace(workspaces, workspaceId);
      const target = await resolveSafePath(workspace.path, dirPath);

      const stats = await fs.stat(target);
      if (!stats.isDirectory()) {
        throw createHttpError('Path is not a directory', 400);
      }

      await fs.rm(target, { recursive: true });
      return c.json({ path: dirPath, deleted: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
