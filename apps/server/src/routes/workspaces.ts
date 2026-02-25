import crypto from 'node:crypto';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { Workspace } from '../types.js';
import { DEFAULT_ROOT } from '../config.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { normalizeWorkspacePath, getWorkspaceKey, getWorkspaceName } from '../utils/path.js';

const MAX_NAME_LENGTH = 100;
const NAME_PATTERN = /^[\p{L}\p{N}\s\-_.]+$/u; // Unicode letters, numbers, spaces, hyphens, underscores, dots

function validateName(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  if (typeof name !== 'string') {
    throw createHttpError('name must be a string', 400);
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw createHttpError(`name is too long (max: ${MAX_NAME_LENGTH} characters)`, 400);
  }
  if (!NAME_PATTERN.test(trimmed)) {
    throw createHttpError('name contains invalid characters', 400);
  }
  return trimmed;
}

export function createWorkspaceRouter(
  db: DatabaseSync,
  workspaces: Map<string, Workspace>,
  workspacePathIndex: Map<string, string>
) {
  const router = new Hono();

  const insertWorkspace = db.prepare(
    'INSERT INTO workspaces (id, name, path, normalized_path, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  function createWorkspace(inputPath: string, name?: string): Workspace {
    const resolvedPath = normalizeWorkspacePath(inputPath);
    const key = getWorkspaceKey(resolvedPath);
    if (workspacePathIndex.has(key)) {
      throw createHttpError('Workspace path already exists', 409);
    }
    const validatedName = validateName(name);
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: validatedName || getWorkspaceName(resolvedPath, workspaces.size + 1),
      path: resolvedPath,
      createdAt: new Date().toISOString()
    };
    workspaces.set(workspace.id, workspace);
    workspacePathIndex.set(key, workspace.id);
    insertWorkspace.run(
      workspace.id,
      workspace.name,
      workspace.path,
      key,
      workspace.createdAt
    );
    return workspace;
  }

  router.get('/', (c) => {
    return c.json(Array.from(workspaces.values()));
  });

  router.post('/', async (c) => {
    try {
      const body = await readJson<{ path?: string; name?: string }>(c);
      if (!body?.path) {
        throw createHttpError('path is required', 400);
      }
      const workspace = createWorkspace(body.path, body.name);
      return c.json(workspace, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}

export function getConfigHandler() {
  return (c: Context) => {
    try {
      return c.json({ defaultRoot: normalizeWorkspacePath(DEFAULT_ROOT) });
    } catch (error) {
      console.error('Failed to get config:', error);
      return c.json({ defaultRoot: '' });
    }
  };
}

export function requireWorkspace(workspaces: Map<string, Workspace>, workspaceId: string): Workspace {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) {
    throw createHttpError('Workspace not found', 404);
  }
  return workspace;
}
