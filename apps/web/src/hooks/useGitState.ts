import { useCallback, useState, useRef } from 'react';
import type { GitStatus, GitFileStatus, GitDiff, GitRepoInfo } from '../types';
import {
  getGitStatus,
  getGitRepos,
  stageFiles,
  unstageFiles,
  commitChanges,
  discardChanges,
  getGitDiff,
  pushChanges,
  pullChanges,
  fetchChanges,
  getBranchStatus,
  getGitRemotes,
  listBranches,
  checkoutBranch,
  createBranch,
  getGitLog
} from '../api';

export interface BranchStatus {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitLogEntry {
  hash: string;
  hashShort: string;
  message: string;
  author: string;
  date: string;
}

export interface GitState {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  diffPath: string | null;
  diff: GitDiff | null;
  diffLoading: boolean;
  branchStatus: BranchStatus | null;
  hasRemote: boolean;
  pushing: boolean;
  pulling: boolean;
  branches: GitBranch[];
  branchesLoading: boolean;
  logs: GitLogEntry[];
  logsLoading: boolean;
  // Multi-repo support
  repos: GitRepoInfo[];
  reposLoading: boolean;
  selectedRepoPath: string | null; // null = auto-select first repo
}

export const createEmptyGitState = (): GitState => ({
  status: null,
  loading: false,
  error: null,
  diffPath: null,
  diff: null,
  diffLoading: false,
  branchStatus: null,
  hasRemote: false,
  pushing: false,
  pulling: false,
  branches: [],
  branchesLoading: false,
  logs: [],
  logsLoading: false,
  // Multi-repo support
  repos: [],
  reposLoading: false,
  selectedRepoPath: null
});

// API timeout wrapper
const withTimeout = <T>(promise: Promise<T>, timeoutMs = 10000): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
    )
  ]);
};

/**
 * Multi-workspace git state management hook
 * Maintains separate git states for each workspace
 */
export const useGitState = (
  activeWorkspaceId: string | null,
  setStatusMessage: (message: string) => void
) => {
  // Map of workspaceId -> GitState
  const [gitStates, setGitStates] = useState<Record<string, GitState>>({});
  const loadingRefs = useRef<Record<string, boolean>>({});
  // ref で gitStates を参照することで useCallback の deps から外し、
  // git操作のたびにコールバックが再生成されるのを防ぐ
  const gitStatesRef = useRef(gitStates);
  gitStatesRef.current = gitStates;

  // Get git state for active workspace
  const gitState = activeWorkspaceId
    ? gitStates[activeWorkspaceId] || createEmptyGitState()
    : createEmptyGitState();

  // Update git state for a specific workspace
  const updateGitState = useCallback(
    (workspaceId: string, updater: (prev: GitState) => GitState) => {
      setGitStates((prev) => ({
        ...prev,
        [workspaceId]: updater(prev[workspaceId] || createEmptyGitState())
      }));
    },
    []
  );

  // Refresh git status for a specific workspace (or active workspace if not specified)
  const refreshGitStatus = useCallback(
    async (targetWorkspaceId?: string) => {
      const workspaceId = targetWorkspaceId || activeWorkspaceId;
      if (!workspaceId) return;

      // Prevent concurrent calls for the same workspace
      if (loadingRefs.current[workspaceId]) {
        return;
      }
      loadingRefs.current[workspaceId] = true;

      updateGitState(workspaceId, (prev) => ({ ...prev, loading: true, reposLoading: true, error: null }));

      try {
        // First, fetch all repos in the workspace
        const reposResult = await withTimeout(getGitRepos(workspaceId)).catch(() => ({ repos: [] }));
        const repos = reposResult.repos;

        updateGitState(workspaceId, (prev) => ({
          ...prev,
          repos,
          reposLoading: false,
          // Auto-select first repo if none selected
          selectedRepoPath: prev.selectedRepoPath ?? (repos.length > 0 ? repos[0].path : null)
        }));

        // Get the selected repo path (use first repo if none selected)
        const currentState = gitStatesRef.current[workspaceId] || createEmptyGitState();
        const repoPath = currentState.selectedRepoPath ?? (repos.length > 0 ? repos[0].path : undefined);

        // Fetch status for the selected repo
        const [status, branchStatus, remotes] = await Promise.all([
          withTimeout(getGitStatus(workspaceId, repoPath || undefined)),
          withTimeout(getBranchStatus(workspaceId, repoPath || undefined)).catch(() => ({ ahead: 0, behind: 0, hasUpstream: false })),
          withTimeout(getGitRemotes(workspaceId, repoPath || undefined)).catch(() => ({ hasRemote: false, remotes: [] }))
        ]);

        updateGitState(workspaceId, (prev) => ({
          ...prev,
          status,
          branchStatus,
          hasRemote: remotes.hasRemote,
          loading: false,
          error: null
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get git status';
        updateGitState(workspaceId, (prev) => ({
          ...prev,
          status: null,
          loading: false,
          reposLoading: false,
          error: message
        }));
      } finally {
        loadingRefs.current[workspaceId] = false;
      }
    },
    [activeWorkspaceId, updateGitState]
  );

  // Select a specific repository within the workspace
  const handleSelectRepo = useCallback(
    async (repoPath: string) => {
      if (!activeWorkspaceId) return;

      updateGitState(activeWorkspaceId, (prev) => ({
        ...prev,
        selectedRepoPath: repoPath,
        loading: true
      }));

      try {
        const [status, branchStatus, remotes] = await Promise.all([
          withTimeout(getGitStatus(activeWorkspaceId, repoPath || undefined)),
          withTimeout(getBranchStatus(activeWorkspaceId, repoPath || undefined)).catch(() => ({ ahead: 0, behind: 0, hasUpstream: false })),
          withTimeout(getGitRemotes(activeWorkspaceId, repoPath || undefined)).catch(() => ({ hasRemote: false, remotes: [] }))
        ]);

        updateGitState(activeWorkspaceId, (prev) => ({
          ...prev,
          status,
          branchStatus,
          hasRemote: remotes.hasRemote,
          loading: false,
          // Reset branches and logs when switching repos
          branches: [],
          logs: []
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get git status';
        setStatusMessage(message);
        updateGitState(activeWorkspaceId, (prev) => ({
          ...prev,
          loading: false
        }));
      }
    },
    [activeWorkspaceId, updateGitState, setStatusMessage]
  );

  // Refresh all known workspaces
  const refreshAllGitStatuses = useCallback(async () => {
    const workspaceIds = Object.keys(gitStatesRef.current);
    await Promise.all(workspaceIds.map((id) => refreshGitStatus(id)));
  }, [refreshGitStatus]);

  // Helper to get current repo path
  const getCurrentRepoPath = useCallback(() => {
    if (!activeWorkspaceId) return undefined;
    const state = gitStatesRef.current[activeWorkspaceId];
    return state?.selectedRepoPath || undefined;
  }, [activeWorkspaceId]);

  const handleStageFile = useCallback(
    async (path: string) => {
      if (!activeWorkspaceId) return;
      const repoPath = getCurrentRepoPath();

      try {
        await stageFiles(activeWorkspaceId, [path], repoPath);
        await refreshGitStatus();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to stage file';
        setStatusMessage(message);
      }
    },
    [activeWorkspaceId, getCurrentRepoPath, refreshGitStatus, setStatusMessage]
  );

  const handleUnstageFile = useCallback(
    async (path: string) => {
      if (!activeWorkspaceId) return;
      const repoPath = getCurrentRepoPath();

      try {
        await unstageFiles(activeWorkspaceId, [path], repoPath);
        await refreshGitStatus();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to unstage file';
        setStatusMessage(message);
      }
    },
    [activeWorkspaceId, getCurrentRepoPath, refreshGitStatus, setStatusMessage]
  );

  const handleStageAll = useCallback(async () => {
    if (!activeWorkspaceId || !gitState.status) return;
    const repoPath = getCurrentRepoPath();

    const unstagedFiles = gitState.status.files
      .filter((f) => !f.staged)
      .map((f) => f.path);

    if (unstagedFiles.length === 0) return;

    try {
      await stageFiles(activeWorkspaceId, unstagedFiles, repoPath);
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to stage files';
      setStatusMessage(message);
    }
  }, [activeWorkspaceId, gitState.status, getCurrentRepoPath, refreshGitStatus, setStatusMessage]);

  const handleUnstageAll = useCallback(async () => {
    if (!activeWorkspaceId || !gitState.status) return;
    const repoPath = getCurrentRepoPath();

    const stagedFiles = gitState.status.files
      .filter((f) => f.staged)
      .map((f) => f.path);

    if (stagedFiles.length === 0) return;

    try {
      await unstageFiles(activeWorkspaceId, stagedFiles, repoPath);
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to unstage files';
      setStatusMessage(message);
    }
  }, [activeWorkspaceId, gitState.status, getCurrentRepoPath, refreshGitStatus, setStatusMessage]);

  const handleCommit = useCallback(
    async (message: string) => {
      if (!activeWorkspaceId || !message.trim()) return;
      const repoPath = getCurrentRepoPath();

      try {
        const result = await commitChanges(activeWorkspaceId, message.trim(), repoPath);
        setStatusMessage(
          `Committed: ${result.summary.changes} changes, +${result.summary.insertions} -${result.summary.deletions}`
        );
        await refreshGitStatus();
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : 'Failed to commit';
        setStatusMessage(errMessage);
      }
    },
    [activeWorkspaceId, getCurrentRepoPath, refreshGitStatus, setStatusMessage]
  );

  const handleDiscardFile = useCallback(
    async (path: string) => {
      if (!activeWorkspaceId) return;
      const repoPath = getCurrentRepoPath();

      try {
        await discardChanges(activeWorkspaceId, [path], repoPath);
        await refreshGitStatus();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to discard changes';
        setStatusMessage(message);
      }
    },
    [activeWorkspaceId, getCurrentRepoPath, refreshGitStatus, setStatusMessage]
  );

  const handleShowDiff = useCallback(
    async (file: GitFileStatus) => {
      if (!activeWorkspaceId) return;
      const repoPath = getCurrentRepoPath();

      updateGitState(activeWorkspaceId, (prev) => ({
        ...prev,
        diffPath: file.path,
        diffLoading: true,
        diff: null
      }));

      try {
        const diff = await getGitDiff(activeWorkspaceId, file.path, file.staged, repoPath);
        updateGitState(activeWorkspaceId, (prev) => ({
          ...prev,
          diff,
          diffLoading: false
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get diff';
        setStatusMessage(message);
        updateGitState(activeWorkspaceId, (prev) => ({
          ...prev,
          diffPath: null,
          diff: null,
          diffLoading: false
        }));
      }
    },
    [activeWorkspaceId, getCurrentRepoPath, updateGitState, setStatusMessage]
  );

  const handleCloseDiff = useCallback(() => {
    if (!activeWorkspaceId) return;
    updateGitState(activeWorkspaceId, (prev) => ({
      ...prev,
      diffPath: null,
      diff: null,
      diffLoading: false
    }));
  }, [activeWorkspaceId, updateGitState]);

  const handlePush = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const repoPath = getCurrentRepoPath();

    updateGitState(activeWorkspaceId, (prev) => ({ ...prev, pushing: true }));

    try {
      const result = await pushChanges(activeWorkspaceId, repoPath);
      setStatusMessage(`Pushed to ${result.branch}`);
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to push';
      setStatusMessage(message);
    } finally {
      updateGitState(activeWorkspaceId, (prev) => ({ ...prev, pushing: false }));
    }
  }, [activeWorkspaceId, getCurrentRepoPath, updateGitState, refreshGitStatus, setStatusMessage]);

  const handlePull = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const repoPath = getCurrentRepoPath();

    updateGitState(activeWorkspaceId, (prev) => ({ ...prev, pulling: true }));

    try {
      const result = await pullChanges(activeWorkspaceId, repoPath);
      if (result.summary.changes > 0) {
        setStatusMessage(
          `Pulled: ${result.summary.changes} changes, +${result.summary.insertions} -${result.summary.deletions}`
        );
      } else {
        setStatusMessage('Already up to date');
      }
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to pull';
      setStatusMessage(message);
    } finally {
      updateGitState(activeWorkspaceId, (prev) => ({ ...prev, pulling: false }));
    }
  }, [activeWorkspaceId, getCurrentRepoPath, updateGitState, refreshGitStatus, setStatusMessage]);

  const handleFetch = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const repoPath = getCurrentRepoPath();

    try {
      await fetchChanges(activeWorkspaceId, repoPath);
      setStatusMessage('Fetched from remote');
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch';
      setStatusMessage(message);
    }
  }, [activeWorkspaceId, getCurrentRepoPath, refreshGitStatus, setStatusMessage]);

  const handleLoadBranches = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const repoPath = getCurrentRepoPath();

    updateGitState(activeWorkspaceId, (prev) => ({ ...prev, branchesLoading: true }));

    try {
      const result = await withTimeout(listBranches(activeWorkspaceId, repoPath));
      updateGitState(activeWorkspaceId, (prev) => ({
        ...prev,
        branches: result.branches,
        branchesLoading: false
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load branches';
      setStatusMessage(message);
      updateGitState(activeWorkspaceId, (prev) => ({ ...prev, branchesLoading: false }));
    }
  }, [activeWorkspaceId, getCurrentRepoPath, updateGitState, setStatusMessage]);

  const handleCheckoutBranch = useCallback(
    async (branchName: string) => {
      if (!activeWorkspaceId) return;
      const repoPath = getCurrentRepoPath();

      try {
        await checkoutBranch(activeWorkspaceId, branchName, repoPath);
        setStatusMessage(`Switched to branch '${branchName}'`);
        await refreshGitStatus();
        await handleLoadBranches();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to checkout branch';
        setStatusMessage(message);
      }
    },
    [activeWorkspaceId, getCurrentRepoPath, refreshGitStatus, handleLoadBranches, setStatusMessage]
  );

  const handleCreateBranch = useCallback(
    async (branchName: string, checkout = true) => {
      if (!activeWorkspaceId) return;
      const repoPath = getCurrentRepoPath();

      try {
        await createBranch(activeWorkspaceId, branchName, checkout, repoPath);
        setStatusMessage(`Created branch '${branchName}'${checkout ? ' and switched to it' : ''}`);
        await refreshGitStatus();
        await handleLoadBranches();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create branch';
        setStatusMessage(message);
      }
    },
    [activeWorkspaceId, getCurrentRepoPath, refreshGitStatus, handleLoadBranches, setStatusMessage]
  );

  const handleLoadLogs = useCallback(async (limit = 50) => {
    if (!activeWorkspaceId) return;
    const repoPath = getCurrentRepoPath();

    updateGitState(activeWorkspaceId, (prev) => ({ ...prev, logsLoading: true }));

    try {
      const result = await withTimeout(getGitLog(activeWorkspaceId, limit, repoPath));
      updateGitState(activeWorkspaceId, (prev) => ({
        ...prev,
        logs: result.logs,
        logsLoading: false
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load git log';
      setStatusMessage(message);
      updateGitState(activeWorkspaceId, (prev) => ({ ...prev, logsLoading: false }));
    }
  }, [activeWorkspaceId, getCurrentRepoPath, updateGitState, setStatusMessage]);

  // Get git state for any workspace (for displaying badges, etc.)
  const getGitStateForWorkspace = useCallback(
    (workspaceId: string): GitState => {
      return gitStates[workspaceId] || createEmptyGitState();
    },
    [gitStates]
  );

  return {
    gitState,
    gitStates,
    refreshGitStatus,
    refreshAllGitStatuses,
    getGitStateForWorkspace,
    handleSelectRepo,
    handleStageFile,
    handleUnstageFile,
    handleStageAll,
    handleUnstageAll,
    handleCommit,
    handleDiscardFile,
    handleShowDiff,
    handleCloseDiff,
    handlePush,
    handlePull,
    handleFetch,
    handleLoadBranches,
    handleCheckoutBranch,
    handleCreateBranch,
    handleLoadLogs
  };
};
