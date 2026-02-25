import { useCallback, useState, useRef } from 'react';
import type { GitStatus, GitFileStatus, GitDiff, GitRepoInfo } from '../types';
import { fetchGitStatus, fetchRepoStatus } from './git/gitStatusHelpers';
import {
  stageFile,
  unstageFile,
  stageAllFiles,
  unstageAllFiles,
  commitFiles,
  discardFile,
  showDiff,
  push,
  pull,
  fetch as fetchOp,
  loadBranches,
  checkoutBranchOp,
  createBranchOp,
  loadLogs
} from './git/gitOperationHelpers';

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
  repos: [],
  reposLoading: false,
  selectedRepoPath: null
});

/**
 * Multi-workspace git state management hook.
 * Maintains separate git states for each workspace.
 */
export const useGitState = (
  activeWorkspaceId: string | null,
  setStatusMessage: (message: string) => void
) => {
  const [gitStates, setGitStates] = useState<Record<string, GitState>>({});
  const loadingRefs = useRef<Record<string, boolean>>({});
  const gitStatesRef = useRef(gitStates);
  gitStatesRef.current = gitStates;

  const gitState = activeWorkspaceId
    ? gitStates[activeWorkspaceId] || createEmptyGitState()
    : createEmptyGitState();

  const updateGitState = useCallback(
    (workspaceId: string, updater: (prev: GitState) => GitState) => {
      setGitStates((prev) => ({
        ...prev,
        [workspaceId]: updater(prev[workspaceId] || createEmptyGitState())
      }));
    },
    []
  );

  const refreshGitStatus = useCallback(
    async (targetWorkspaceId?: string) => {
      const workspaceId = targetWorkspaceId || activeWorkspaceId;
      if (!workspaceId) return;
      await fetchGitStatus(workspaceId, updateGitState, gitStatesRef, loadingRefs);
    },
    [activeWorkspaceId, updateGitState]
  );

  const handleSelectRepo = useCallback(
    async (repoPath: string) => {
      if (!activeWorkspaceId) return;
      await fetchRepoStatus(activeWorkspaceId, repoPath, updateGitState, setStatusMessage);
    },
    [activeWorkspaceId, updateGitState, setStatusMessage]
  );

  const refreshAllGitStatuses = useCallback(async () => {
    const workspaceIds = Object.keys(gitStatesRef.current);
    await Promise.all(workspaceIds.map((id) => refreshGitStatus(id)));
  }, [refreshGitStatus]);

  const getCurrentRepoPath = useCallback(() => {
    if (!activeWorkspaceId) return undefined;
    const state = gitStatesRef.current[activeWorkspaceId];
    return state?.selectedRepoPath || undefined;
  }, [activeWorkspaceId]);

  const handleStageFile = useCallback(
    async (path: string) => {
      if (!activeWorkspaceId) return;
      await stageFile(activeWorkspaceId, path, getCurrentRepoPath(), setStatusMessage, refreshGitStatus);
    },
    [activeWorkspaceId, getCurrentRepoPath, setStatusMessage, refreshGitStatus]
  );

  const handleUnstageFile = useCallback(
    async (path: string) => {
      if (!activeWorkspaceId) return;
      await unstageFile(activeWorkspaceId, path, getCurrentRepoPath(), setStatusMessage, refreshGitStatus);
    },
    [activeWorkspaceId, getCurrentRepoPath, setStatusMessage, refreshGitStatus]
  );

  const handleStageAll = useCallback(async () => {
    if (!activeWorkspaceId || !gitState.status) return;
    const unstagedPaths = gitState.status.files
      .filter((f) => !f.staged)
      .map((f) => f.path);
    await stageAllFiles(activeWorkspaceId, unstagedPaths, getCurrentRepoPath(), setStatusMessage, refreshGitStatus);
  }, [activeWorkspaceId, gitState.status, getCurrentRepoPath, setStatusMessage, refreshGitStatus]);

  const handleUnstageAll = useCallback(async () => {
    if (!activeWorkspaceId || !gitState.status) return;
    const stagedPaths = gitState.status.files
      .filter((f) => f.staged)
      .map((f) => f.path);
    await unstageAllFiles(activeWorkspaceId, stagedPaths, getCurrentRepoPath(), setStatusMessage, refreshGitStatus);
  }, [activeWorkspaceId, gitState.status, getCurrentRepoPath, setStatusMessage, refreshGitStatus]);

  const handleCommit = useCallback(
    async (message: string) => {
      if (!activeWorkspaceId || !message.trim()) return;
      await commitFiles(activeWorkspaceId, message, getCurrentRepoPath(), setStatusMessage, refreshGitStatus);
    },
    [activeWorkspaceId, getCurrentRepoPath, setStatusMessage, refreshGitStatus]
  );

  const handleDiscardFile = useCallback(
    async (path: string) => {
      if (!activeWorkspaceId) return;
      await discardFile(activeWorkspaceId, path, getCurrentRepoPath(), setStatusMessage, refreshGitStatus);
    },
    [activeWorkspaceId, getCurrentRepoPath, setStatusMessage, refreshGitStatus]
  );

  const handleShowDiff = useCallback(
    async (file: GitFileStatus) => {
      if (!activeWorkspaceId) return;
      await showDiff(activeWorkspaceId, file, getCurrentRepoPath(), updateGitState, setStatusMessage);
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
    await push(activeWorkspaceId, getCurrentRepoPath(), updateGitState, setStatusMessage, refreshGitStatus);
  }, [activeWorkspaceId, getCurrentRepoPath, updateGitState, setStatusMessage, refreshGitStatus]);

  const handlePull = useCallback(async () => {
    if (!activeWorkspaceId) return;
    await pull(activeWorkspaceId, getCurrentRepoPath(), updateGitState, setStatusMessage, refreshGitStatus);
  }, [activeWorkspaceId, getCurrentRepoPath, updateGitState, setStatusMessage, refreshGitStatus]);

  const handleFetch = useCallback(async () => {
    if (!activeWorkspaceId) return;
    await fetchOp(activeWorkspaceId, getCurrentRepoPath(), setStatusMessage, refreshGitStatus);
  }, [activeWorkspaceId, getCurrentRepoPath, setStatusMessage, refreshGitStatus]);

  const handleLoadBranches = useCallback(async () => {
    if (!activeWorkspaceId) return;
    await loadBranches(activeWorkspaceId, getCurrentRepoPath(), updateGitState, setStatusMessage);
  }, [activeWorkspaceId, getCurrentRepoPath, updateGitState, setStatusMessage]);

  const handleCheckoutBranch = useCallback(
    async (branchName: string) => {
      if (!activeWorkspaceId) return;
      await checkoutBranchOp(
        activeWorkspaceId,
        branchName,
        getCurrentRepoPath(),
        setStatusMessage,
        refreshGitStatus,
        handleLoadBranches
      );
    },
    [activeWorkspaceId, getCurrentRepoPath, setStatusMessage, refreshGitStatus, handleLoadBranches]
  );

  const handleCreateBranch = useCallback(
    async (branchName: string, checkout = true) => {
      if (!activeWorkspaceId) return;
      await createBranchOp(
        activeWorkspaceId,
        branchName,
        checkout,
        getCurrentRepoPath(),
        setStatusMessage,
        refreshGitStatus,
        handleLoadBranches
      );
    },
    [activeWorkspaceId, getCurrentRepoPath, setStatusMessage, refreshGitStatus, handleLoadBranches]
  );

  const handleLoadLogs = useCallback(async (limit = 50) => {
    if (!activeWorkspaceId) return;
    await loadLogs(activeWorkspaceId, limit, getCurrentRepoPath(), updateGitState, setStatusMessage);
  }, [activeWorkspaceId, getCurrentRepoPath, updateGitState, setStatusMessage]);

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
