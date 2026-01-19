import { Hono } from 'hono';
import { simpleGit, SimpleGit, StatusResult } from 'simple-git';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import type { Workspace } from '../types.js';
import { createHttpError, handleError, readJson } from '../utils/error.js';
import { resolveSafePath } from '../utils/path.js';

// Maximum depth to search for git repos
const MAX_SEARCH_DEPTH = 5;
// Directories to skip when searching
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', 'vendor', '__pycache__']);

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

export interface GitRepoInfo {
  path: string;        // Relative path from workspace root (empty string for root repo)
  name: string;        // Display name (folder name or 'root')
  branch: string;
  fileCount: number;   // Number of changed files
}

export interface MultiRepoGitStatus {
  repos: GitRepoInfo[];
  files: (GitFileStatus & { repoPath: string })[];
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

/**
 * Recursively find all git repositories within a directory
 * Returns relative paths from the workspace root (using forward slashes for cross-platform compatibility)
 */
async function findGitRepos(
  basePath: string,
  currentPath: string = '',
  depth: number = 0
): Promise<string[]> {
  if (depth > MAX_SEARCH_DEPTH) {
    return [];
  }

  const repos: string[] = [];
  const fullPath = currentPath ? nodePath.join(basePath, currentPath) : basePath;

  try {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });

    // Check if this directory is a git repo
    const hasGitDir = entries.some(e => e.isDirectory() && e.name === '.git');
    if (hasGitDir) {
      // Use forward slashes for consistency
      repos.push(currentPath.replace(/\\/g, '/'));
      // Don't recurse into nested git repos (submodules are handled separately by git)
      return repos;
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        const subPath = currentPath ? nodePath.join(currentPath, entry.name) : entry.name;
        const subRepos = await findGitRepos(basePath, subPath, depth + 1);
        repos.push(...subRepos);
      }
    }
  } catch (error) {
    // Ignore permission errors or other issues
    console.error('Error scanning directory:', fullPath, error);
  }

  return repos;
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

  // GET /api/git/status?workspaceId=xxx&repoPath=xxx (optional repoPath for specific repo)
  router.get('/status', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      const repoPath = c.req.query('repoPath'); // Optional: specific repo path

      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);

      // If repoPath is specified, get status for that specific repo
      if (repoPath !== undefined) {
        const fullRepoPath = repoPath ? nodePath.join(workspace.path, repoPath) : workspace.path;
        const git = simpleGit(fullRepoPath);

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
      }

      // Default behavior: check root repo only (backwards compatible)
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

  // GET /api/git/repos?workspaceId=xxx - Find all git repos in workspace
  router.get('/repos', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);
      const repoPaths = await findGitRepos(workspace.path);

      // Get info for each repo
      const repos: GitRepoInfo[] = [];
      for (const repoPath of repoPaths) {
        const fullPath = repoPath ? nodePath.join(workspace.path, repoPath) : workspace.path;
        const git = simpleGit(fullPath);

        try {
          const status = await git.status();
          const files = parseFileStatus(status);

          repos.push({
            path: repoPath,
            name: repoPath ? nodePath.basename(repoPath) : 'root',
            branch: status.current ?? 'HEAD',
            fileCount: files.length
          });
        } catch {
          // Skip repos that fail to get status
        }
      }

      return c.json({ repos });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // GET /api/git/multi-status?workspaceId=xxx - Get aggregated status from all repos
  router.get('/multi-status', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);
      const repoPaths = await findGitRepos(workspace.path);

      const repos: GitRepoInfo[] = [];
      const allFiles: (GitFileStatus & { repoPath: string })[] = [];

      for (const repoPath of repoPaths) {
        const fullPath = repoPath ? nodePath.join(workspace.path, repoPath) : workspace.path;
        const git = simpleGit(fullPath);

        try {
          const status = await git.status();
          const files = parseFileStatus(status);

          repos.push({
            path: repoPath,
            name: repoPath ? nodePath.basename(repoPath) : 'root',
            branch: status.current ?? 'HEAD',
            fileCount: files.length
          });

          // Add repo path to each file
          for (const file of files) {
            allFiles.push({
              ...file,
              // Prefix file path with repo path for non-root repos
              path: repoPath ? nodePath.join(repoPath, file.path) : file.path,
              repoPath
            });
          }
        } catch {
          // Skip repos that fail to get status
        }
      }

      return c.json({
        repos,
        files: allFiles
      } as MultiRepoGitStatus);
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/stage
  router.post('/stage', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string; paths: string[]; repoPath?: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const paths = validateGitPaths(body.paths);
      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const repoFullPath = body.repoPath
        ? nodePath.join(workspace.path, body.repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

      await git.add(paths);

      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/unstage
  router.post('/unstage', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string; paths: string[]; repoPath?: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const paths = validateGitPaths(body.paths);
      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const repoFullPath = body.repoPath
        ? nodePath.join(workspace.path, body.repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

      await git.reset(['HEAD', '--', ...paths]);

      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/commit
  router.post('/commit', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string; message: string; repoPath?: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const message = validateCommitMessage(body.message);
      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const repoFullPath = body.repoPath
        ? nodePath.join(workspace.path, body.repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

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
      const body = await readJson<{ workspaceId: string; paths: string[]; repoPath?: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const paths = validateGitPaths(body.paths);
      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const repoFullPath = body.repoPath
        ? nodePath.join(workspace.path, body.repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

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
          // Use resolveSafePath for proper symlink validation (relative to repo path)
          const resolved = await resolveSafePath(repoFullPath, untrackedPath);
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

  // GET /api/git/diff?workspaceId=xxx&path=xxx&staged=bool&repoPath=xxx
  router.get('/diff', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      const filePath = c.req.query('path');
      const staged = c.req.query('staged') === 'true';
      const repoPath = c.req.query('repoPath');

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
      const repoFullPath = repoPath
        ? nodePath.join(workspace.path, repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

      let original = '';
      let modified = '';

      const status = await git.status();
      const isUntracked = status.not_added.includes(filePath);

      if (isUntracked) {
        // For untracked files, original is empty
        original = '';
        modified = await readFileContent(repoFullPath, filePath);
      } else if (staged) {
        // For staged changes, compare HEAD to working tree
        original = await getOriginalContent(git, filePath);
        modified = await readFileContent(repoFullPath, filePath);
      } else {
        // For unstaged changes, compare HEAD to working tree
        original = await getOriginalContent(git, filePath);
        modified = await readFileContent(repoFullPath, filePath);
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
      const body = await readJson<{ workspaceId: string; repoPath?: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const repoFullPath = body.repoPath
        ? nodePath.join(workspace.path, body.repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

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
      const body = await readJson<{ workspaceId: string; repoPath?: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const repoFullPath = body.repoPath
        ? nodePath.join(workspace.path, body.repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

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
      const body = await readJson<{ workspaceId: string; repoPath?: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const repoFullPath = body.repoPath
        ? nodePath.join(workspace.path, body.repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

      await git.fetch();

      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // GET /api/git/remotes?workspaceId=xxx&repoPath=xxx
  router.get('/remotes', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      const repoPath = c.req.query('repoPath');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);
      const repoFullPath = repoPath
        ? nodePath.join(workspace.path, repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

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

  // GET /api/git/branch-status?workspaceId=xxx&repoPath=xxx
  router.get('/branch-status', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      const repoPath = c.req.query('repoPath');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);
      const repoFullPath = repoPath
        ? nodePath.join(workspace.path, repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

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

  // GET /api/git/branches?workspaceId=xxx&repoPath=xxx
  router.get('/branches', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      const repoPath = c.req.query('repoPath');
      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const workspace = requireWorkspace(workspaces, workspaceId);
      const repoFullPath = repoPath
        ? nodePath.join(workspace.path, repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

      const isRepo = await isGitRepository(git);
      if (!isRepo) {
        return c.json({ branches: [], currentBranch: '' });
      }

      const branchSummary = await git.branchLocal();
      const branches = branchSummary.all.map((name) => ({
        name,
        current: name === branchSummary.current
      }));

      return c.json({
        branches,
        currentBranch: branchSummary.current
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/checkout
  router.post('/checkout', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string; branchName: string; repoPath?: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      if (!body?.branchName) {
        throw createHttpError('branchName is required', 400);
      }

      // Validate branch name
      const branchName = body.branchName.trim();
      if (!branchName || branchName.length > 250) {
        throw createHttpError('Invalid branch name', 400);
      }
      // Prevent injection via branch names
      if (/[;&|`$<>\\]/.test(branchName)) {
        throw createHttpError('Invalid characters in branch name', 400);
      }

      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const repoFullPath = body.repoPath
        ? nodePath.join(workspace.path, body.repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

      await git.checkout(branchName);

      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/git/create-branch
  router.post('/create-branch', async (c) => {
    try {
      const body = await readJson<{ workspaceId: string; branchName: string; checkout?: boolean; repoPath?: string }>(c);
      if (!body?.workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }
      if (!body?.branchName) {
        throw createHttpError('branchName is required', 400);
      }

      // Validate branch name
      const branchName = body.branchName.trim();
      if (!branchName || branchName.length > 250) {
        throw createHttpError('Invalid branch name', 400);
      }
      // Prevent injection via branch names and validate format
      if (/[;&|`$<>\\~^:?*\[\]@{}\s]/.test(branchName)) {
        throw createHttpError('Invalid characters in branch name', 400);
      }
      if (branchName.startsWith('-') || branchName.startsWith('.') || branchName.endsWith('.') || branchName.endsWith('/')) {
        throw createHttpError('Invalid branch name format', 400);
      }

      const workspace = requireWorkspace(workspaces, body.workspaceId);
      const repoFullPath = body.repoPath
        ? nodePath.join(workspace.path, body.repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

      const checkout = body.checkout !== false;

      if (checkout) {
        await git.checkoutLocalBranch(branchName);
      } else {
        await git.branch([branchName]);
      }

      return c.json({ success: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // GET /api/git/log?workspaceId=xxx&limit=50&repoPath=xxx
  router.get('/log', async (c) => {
    try {
      const workspaceId = c.req.query('workspaceId');
      const limitStr = c.req.query('limit') || '50';
      const repoPath = c.req.query('repoPath');

      if (!workspaceId) {
        throw createHttpError('workspaceId is required', 400);
      }

      const limit = Math.min(Math.max(1, parseInt(limitStr, 10) || 50), 500);

      const workspace = requireWorkspace(workspaces, workspaceId);
      const repoFullPath = repoPath
        ? nodePath.join(workspace.path, repoPath)
        : workspace.path;
      const git = simpleGit(repoFullPath);

      const isRepo = await isGitRepository(git);
      if (!isRepo) {
        return c.json({ logs: [] });
      }

      const logResult = await git.log({ maxCount: limit });

      const logs = logResult.all.map((entry) => ({
        hash: entry.hash,
        hashShort: entry.hash.slice(0, 7),
        message: entry.message,
        author: entry.author_name,
        date: entry.date
      }));

      return c.json({ logs });
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
