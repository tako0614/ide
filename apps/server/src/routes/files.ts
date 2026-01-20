import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import type { Workspace } from '../types.js';
import { MAX_FILE_SIZE, DEFAULT_ROOT } from '../config.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { resolveSafePath, normalizeWorkspacePath } from '../utils/path.js';
import { requireWorkspace } from './workspaces.js';
import { sortFileEntries } from '@deck-ide/shared/utils-node';

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

  router.put('/file', async (c) => {
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
  router.post('/file', async (c) => {
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
