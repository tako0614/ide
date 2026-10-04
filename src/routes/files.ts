import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import type { Workspace } from '../types.js';
import { MAX_FILE_SIZE, DEFAULT_ROOT } from '../config.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { resolveSafePath, normalizeWorkspacePath, isWorkspaceRoot } from '../utils/path.js';
import { requireWorkspace } from './workspaces.js';
import { sortFileEntries } from '../shared/utils-node.js';

function mapFileEntry(entry: { name: string; isDirectory(): boolean }, normalizedBase: string) {
  const entryPath = normalizedBase ? `${normalizedBase}/${entry.name}` : entry.name;
  return {
    name: entry.name,
    path: entryPath,
    type: (entry.isDirectory() ? 'dir' : 'file') as 'dir' | 'file'
  };
}

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
      const mapped = entries.map((entry) => mapFileEntry(entry, normalizedBase));
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
      const mapped = entries.map((entry) => mapFileEntry(entry, normalizedBase));
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

  // Move / rename a file or directory within the workspace (Drive UI).
  router.post('/move', async (c) => {
    try {
      const body = await readJson<{
        workspaceId?: string;
        from?: string;
        to?: string;
        overwrite?: boolean;
      }>(c);
      const workspaceId = body?.workspaceId;
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      if (!body?.from || !body?.to) {
        throw createHttpError('from and to are required', 400);
      }
      const workspace = requireWorkspace(workspaces, workspaceId);
      const fromPath = await resolveSafePath(workspace.path, body.from);
      const toPath = await resolveSafePath(workspace.path, body.to);

      // Source must exist (throws ENOENT otherwise).
      await fs.stat(fromPath);

      // No-clobber unless the caller explicitly opts in.
      if (!body.overwrite) {
        try {
          await fs.access(toPath);
          throw createHttpError('Destination already exists', 409);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
          }
        }
      }

      await fs.mkdir(path.dirname(toPath), { recursive: true });
      await fs.rename(fromPath, toPath);
      return c.json({ from: body.from, to: body.to, moved: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Upload one or more files into a workspace directory (multipart form). The
  // form field `file` may repeat. Filenames are reduced to their basename so an
  // upload can never escape the target directory.
  router.post('/upload', async (c) => {
    try {
      const form = await c.req.parseBody({ all: true });
      const workspaceId = typeof form.workspaceId === 'string' ? form.workspaceId : undefined;
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      const dir = typeof form.path === 'string' ? form.path : '';
      const workspace = requireWorkspace(workspaces, workspaceId);

      const field = form.file;
      const files = (Array.isArray(field) ? field : [field]).filter(
        (item): item is File => item instanceof File
      );
      if (files.length === 0) {
        throw createHttpError('no files provided', 400);
      }

      const uploaded: string[] = [];
      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
          throw createHttpError(
            `File too large: ${file.name} (${Math.round(file.size / 1024 / 1024)}MB). Maximum is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB.`,
            413
          );
        }
        const safeName = path.basename(file.name);
        const rel = dir ? `${dir}/${safeName}` : safeName;
        const target = await resolveSafePath(workspace.path, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const buffer = Buffer.from(await file.arrayBuffer());
        await fs.writeFile(target, buffer);
        uploaded.push(rel);
      }
      return c.json({ uploaded });
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

      // '.', 'sub/..' and friends all resolve to the workspace root; a
      // recursive rm there would take the whole workspace with it.
      if (await isWorkspaceRoot(workspace.path, target)) {
        throw createHttpError('Cannot delete the workspace root', 400);
      }

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
