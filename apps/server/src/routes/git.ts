import { Hono } from 'hono';
import { simpleGit, SimpleGit, StatusResult } from 'simple-git';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import type { Workspace } from '../types.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { resolveSafePath } from '../utils/path.js';

export type GitFileStatusCode =
  | 'modified'
  | 'staged'
  | 'untracked'
  | 'deleted'
  | 'renamed'
  | 'conflicted';

export interface GitFileStatus {
  path: string;
  status: GitFileStatusCode;
  staged: boolean;
}

export interface GitStatus {
  isGitRepo: boolean;
  branch: string;
  files: GitFileStatus[];
}

export interface GitDiff {
  original: string;
  modified: string;
  path: string;
}

// Security: Validate file paths to prevent command injection
const DANGEROUS_PATH_PATTERNS = [
  /^-/, // Paths starting with dash (could be interpreted as options)
  /\.\.[/\\]/, // Path traversal
  /^[/\\]/, // Absolute paths
  /[\x00-\x1f]/, // Control characters
  /^~/, // Home directory expansion
];

const MAX_PATH_LENGTH = 500;
const MAX_PATHS_COUNT = 100;

function isValidGitPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }
  if (filePath.length > MAX_PATH_LENGTH) {
    return false;
  }
  for (const pattern of DANGEROUS_PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      return false;
    }
  }
  return true;
}

function validateGitPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) {
    throw createHttpError('paths must be an array', 400);
  }
  if (paths.length === 0) {
    throw createHttpError('paths cannot be empty', 400);
  }
  if (paths.length > MAX_PATHS_COUNT) {
    throw createHttpError(`Too many paths (max: ${MAX_PATHS_COUNT})`, 400);
  }

  const validatedPaths: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string') {
      throw createHttpError('All paths must be strings', 400);
    }
    if (!isValidGitPath(p)) {
      throw createHttpError(`Invalid path: ${p}`, 400);
    }
    validatedPaths.push(p);
  }
  return validatedPaths;
}

function validateCommitMessage(message: unknown): string {
  if (!message || typeof message !== 'string') {
    throw createHttpError('message is required', 400);
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw createHttpError('message cannot be empty', 400);
  }
  if (trimmed.length > 10000) {
    throw createHttpError('message is too long (max: 10000 characters)', 400);
  }
  return trimmed;
}

function requireWorkspace(
  workspaces: Map<string, Workspace>,
  workspaceId: string
): Workspace {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) {
    throw createHttpError('Workspace not found', 404);
  }
  return workspace;
}

function parseFileStatus(status: StatusResult): GitFileStatus[] {
  const files: GitFileStatus[] = [];

  // Staged files (index changes)
  for (const file of status.staged) {
    files.push({
      path: file,
      status: 'staged',
      staged: true
    });
  }

  // Modified files (working tree changes, not staged)
  for (const file of status.modified) {
    // Check if already in staged list
    if (!files.some((f) => f.path === file && f.staged)) {
      files.push({
        path: file,
        status: 'modified',
        staged: false
      });
    }
  }

  // Untracked files
  for (const file of status.not_added) {
    files.push({
      path: file,
      status: 'untracked',
      staged: false
    });
  }

  // Deleted files
  for (const file of status.deleted) {
    files.push({
      path: file,
      status: 'deleted',
      staged: false
    });
  }

  // Renamed files
  for (const file of status.renamed) {
    files.push({
      path: file.to,
      status: 'renamed',
      staged: true
    });
  }

  // Conflicted files
  for (const file of status.conflicted) {
    files.push({
      path: file,
      status: 'conflicted',
      staged: false
    });
  }

  // Created/added files (staged new files)
  for (const file of status.created) {
    if (!files.some((f) => f.path === file)) {
      files.push({
        path: file,
        status: 'staged',
        staged: true
      });
    }
  }

  return files;
}

async function isGitRepository(git: SimpleGit): Promise<boolean> {
  try {
    await git.revparse(['--git-dir']);
    return true;
  } catch {
    return false;
  }
}

async function readFileContent(workspacePath: string, filePath: string): Promise<string> {
  try {
    // Use resolveSafePath for proper symlink validation
    const resolved = await resolveSafePath(workspacePath, filePath);
    return await fs.readFile(resolved, 'utf-8');
  } catch (error) {
    // Only return empty for file-not-found errors
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    // For security errors (path traversal), re-throw
    if ((error as { status?: number })?.status === 400) {
      throw error;
    }
    // Log unexpected errors but return empty to avoid breaking diff
    console.error('Error reading file for git diff:', error);
    return '';
  }
}

async function getOriginalContent(git: SimpleGit, filePath: string): Promise<string> {
  try {
    return await git.show([`HEAD:${filePath}`]);
  } catch (error) {
    // New file or not in HEAD - expected error
    const message = (error as Error)?.message || '';
    if (message.includes('does not exist') || message.includes('fatal:')) {
      return '';
    }
    // Log unexpected git errors
    console.error('Error getting original content from git:', error);
    return '';
  }
}

export function createGitRouter(workspaces: Map<string, Workspace>) {
  const router = new Hono();

  // GET /api/git/status?workspaceId=xxx
  router.get('/status', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);
      const git = simpleGit(workspace.path);

      const isRepo = await isGitRepository(git);
      if (!isRepo) {
        return c.json({
          isGitRepo: false,
          branch: '',
          files: []
        } as GitStatus);
      }

      const status = await git.status();
      const files = parseFileStatus(status);

      return c.json({
        isGitRepo: true,
        branch: status.current ?? 'HEAD',
        files
      } as GitStatus);
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/stage
  router.post('/stage', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string; paths: string[] }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const paths = validateGitPaths(body.paths);
      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const git = simpleGit(workspace.path);

      await git.add(paths);

      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/unstage
  router.post('/unstage', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string; paths: string[] }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const paths = validateGitPaths(body.paths);
      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const git = simpleGit(workspace.path);

      await git.reset(['HEAD', '--', ...paths]);

      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/commit
  router.post('/commit', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string; message: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const message = validateCommitMessage(body.message);
      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const git = simpleGit(workspace.path);

      const result = await git.commit(message);

      return c.json({
        success: true,
        commit: result.commit ?? '',
        summary: {
          changes: result.summary.changes,
          insertions: result.summary.insertions,
          deletions: result.summary.deletions
        }
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/discard
  router.post('/discard', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string; paths: string[] }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const paths = validateGitPaths(body.paths);
      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const git = simpleGit(workspace.path);

      // First, check if any of these are untracked files
      const status = await git.status();
      const untrackedPaths = paths.filter((p) =>
        status.not_added.includes(p)
      );
      const trackedPaths = paths.filter(
        (p) => !status.not_added.includes(p)
      );

      // For tracked files, use checkout to discard changes
      if (trackedPaths.length > 0) {
        await git.checkout(['--', ...trackedPaths]);
      }

      // For untracked files, verify each path exists and is within workspace before deleting
      for (const untrackedPath of untrackedPaths) {
        try {
          // Use resolveSafePath for proper symlink validation
          const resolved = await resolveSafePath(workspace.path, untrackedPath);
          await fs.unlink(resolved);
        } catch (error) {
          // File might already be deleted or path validation failed
          if ((error as { status?: number })?.status === 400) {
            throw error; // Re-throw security errors
          }
          // Ignore ENOENT (file not found) errors
        }
      }

      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // GET /api/git/diff?workspaceId=xxx&path=xxx&staged=bool
  router.get('/diff', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      const filePath = c.req.query('path');
      const staged = c.req.query('staged') === 'true';

      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      if (!filePath) {
        throw createHttpError('path is required', 400);
      }
      if (!isValidGitPath(filePath)) {
        throw createHttpError('Invalid path', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);
      const git = simpleGit(workspace.path);

      let original = '';
      let modified = '';

      const status = await git.status();
      const isUntracked = status.not_added.includes(filePath);

      if (isUntracked) {
        // For untracked files, original is empty
        original = '';
        modified = await readFileContent(workspace.path, filePath);
      } else if (staged) {
        // For staged changes, compare HEAD to working tree
        original = await getOriginalContent(git, filePath);
        modified = await readFileContent(workspace.path, filePath);
      } else {
        // For unstaged changes, compare HEAD to working tree
        original = await getOriginalContent(git, filePath);
        modified = await readFileContent(workspace.path, filePath);
      }

      return c.json({
        original,
        modified,
        path: filePath
      } as GitDiff);
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/push
  router.post('/push', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const git = simpleGit(workspace.path);

      // Check if we have a remote
      const remotes = await git.getRemotes(true);
      if (remotes.length === 0) {
        throw createHttpError('No remote configured', 400);
      }

      // Get current branch
      const status = await git.status();
      const branch = status.current;
      if (!branch) {
        throw createHttpError('No branch checked out', 400);
      }

      // Push to origin
      const result = await git.push('origin', branch);

      return c.json({
        success: true,
        pushed: result.pushed || [],
        branch
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/pull
  router.post('/pull', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const git = simpleGit(workspace.path);

      // Check if we have a remote
      const remotes = await git.getRemotes(true);
      if (remotes.length === 0) {
        throw createHttpError('No remote configured', 400);
      }

      const result = await git.pull();

      return c.json({
        success: true,
        summary: {
          changes: result.summary.changes,
          insertions: result.summary.insertions,
          deletions: result.summary.deletions
        }
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/fetch
  router.post('/fetch', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const git = simpleGit(workspace.path);

      await git.fetch();

      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // GET /api/git/remotes?workspaceId=xxx
  router.get('/remotes', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);
      const git = simpleGit(workspace.path);

      const isRepo = await isGitRepository(git);
      if (!isRepo) {
        return c.json({ remotes: [], hasRemote: false });
      }

      const remotes = await git.getRemotes(true);

      return c.json({
        remotes: remotes.map((r) => ({
          name: r.name,
          fetchUrl: r.refs.fetch,
          pushUrl: r.refs.push
        })),
        hasRemote: remotes.length > 0
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // GET /api/git/branch-status?workspaceId=xxx
  router.get('/branch-status', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);
      const git = simpleGit(workspace.path);

      const isRepo = await isGitRepository(git);
      if (!isRepo) {
        return c.json({
          ahead: 0,
          behind: 0,
          hasUpstream: false
        });
      }

      const status = await git.status();

      return c.json({
        ahead: status.ahead,
        behind: status.behind,
        hasUpstream: status.tracking !== null
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
