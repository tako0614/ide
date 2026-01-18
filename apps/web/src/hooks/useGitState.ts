import { useCallback, useState, useEffect } from 'react';
import type { GitStatus, GitFileStatus, GitDiff } from '../types';
import {
  getGitStatus,
  stageFiles,
  unstageFiles,
  commitChanges,
  discardChanges,
  getGitDiff,
  pushChanges,
  pullChanges,
  fetchChanges,
  getBranchStatus,
  getGitRemotes
} from '../api';

export interface BranchStatus {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
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
}

const createEmptyGitState = (): GitState => ({
  status: null,
  loading: false,
  error: null,
  diffPath: null,
  diff: null,
  diffLoading: false,
  branchStatus: null,
  hasRemote: false,
  pushing: false,
  pulling: false
});

export const useGitState = (
  workspaceId: string | null,
  setStatusMessage: (message: string) => void
) => {
  const [gitState, setGitState] = useState<GitState>(createEmptyGitState());

  const refreshGitStatus = useCallback(async () => {
    if (!workspaceId) {
      setGitState(createEmptyGitState());
      return;
    }

    setGitState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const [status, branchStatus, remotes] = await Promise.all([
        getGitStatus(workspaceId),
        getBranchStatus(workspaceId).catch(() => ({ ahead: 0, behind: 0, hasUpstream: false })),
        getGitRemotes(workspaceId).catch(() => ({ hasRemote: false, remotes: [] }))
      ]);

      setGitState((prev) => ({
        ...prev,
        status,
        branchStatus,
        hasRemote: remotes.hasRemote,
        loading: false,
        error: null
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get git status';
      setGitState((prev) => ({
        ...prev,
        status: null,
        loading: false,
        error: message
      }));
    }
  }, [workspaceId]);

  const handleStageFile = useCallback(
    async (path: string) => {
      if (!workspaceId) return;

      try {
        await stageFiles(workspaceId, [path]);
        await refreshGitStatus();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to stage file';
        setStatusMessage(message);
      }
    },
    [workspaceId, refreshGitStatus, setStatusMessage]
  );

  const handleUnstageFile = useCallback(
    async (path: string) => {
      if (!workspaceId) return;

      try {
        await unstageFiles(workspaceId, [path]);
        await refreshGitStatus();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to unstage file';
        setStatusMessage(message);
      }
    },
    [workspaceId, refreshGitStatus, setStatusMessage]
  );

  const handleStageAll = useCallback(async () => {
    if (!workspaceId || !gitState.status) return;

    const unstagedFiles = gitState.status.files
      .filter((f) => !f.staged)
      .map((f) => f.path);

    if (unstagedFiles.length === 0) return;

    try {
      await stageFiles(workspaceId, unstagedFiles);
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to stage files';
      setStatusMessage(message);
    }
  }, [workspaceId, gitState.status, refreshGitStatus, setStatusMessage]);

  const handleUnstageAll = useCallback(async () => {
    if (!workspaceId || !gitState.status) return;

    const stagedFiles = gitState.status.files
      .filter((f) => f.staged)
      .map((f) => f.path);

    if (stagedFiles.length === 0) return;

    try {
      await unstageFiles(workspaceId, stagedFiles);
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to unstage files';
      setStatusMessage(message);
    }
  }, [workspaceId, gitState.status, refreshGitStatus, setStatusMessage]);

  const handleCommit = useCallback(
    async (message: string) => {
      if (!workspaceId || !message.trim()) return;

      try {
        const result = await commitChanges(workspaceId, message.trim());
        setStatusMessage(
          `Committed: ${result.summary.changes} changes, +${result.summary.insertions} -${result.summary.deletions}`
        );
        await refreshGitStatus();
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : 'Failed to commit';
        setStatusMessage(errMessage);
      }
    },
    [workspaceId, refreshGitStatus, setStatusMessage]
  );

  const handleDiscardFile = useCallback(
    async (path: string) => {
      if (!workspaceId) return;

      try {
        await discardChanges(workspaceId, [path]);
        await refreshGitStatus();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to discard changes';
        setStatusMessage(message);
      }
    },
    [workspaceId, refreshGitStatus, setStatusMessage]
  );

  const handleShowDiff = useCallback(
    async (file: GitFileStatus) => {
      if (!workspaceId) return;

      setGitState((prev) => ({
        ...prev,
        diffPath: file.path,
        diffLoading: true,
        diff: null
      }));

      try {
        const diff = await getGitDiff(workspaceId, file.path, file.staged);
        setGitState((prev) => ({
          ...prev,
          diff,
          diffLoading: false
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get diff';
        setStatusMessage(message);
        setGitState((prev) => ({
          ...prev,
          diffPath: null,
          diff: null,
          diffLoading: false
        }));
      }
    },
    [workspaceId, setStatusMessage]
  );

  const handleCloseDiff = useCallback(() => {
    setGitState((prev) => ({
      ...prev,
      diffPath: null,
      diff: null,
      diffLoading: false
    }));
  }, []);

  const handlePush = useCallback(async () => {
    if (!workspaceId) return;

    setGitState((prev) => ({ ...prev, pushing: true }));

    try {
      const result = await pushChanges(workspaceId);
      setStatusMessage(`Pushed to ${result.branch}`);
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to push';
      setStatusMessage(message);
    } finally {
      setGitState((prev) => ({ ...prev, pushing: false }));
    }
  }, [workspaceId, refreshGitStatus, setStatusMessage]);

  const handlePull = useCallback(async () => {
    if (!workspaceId) return;

    setGitState((prev) => ({ ...prev, pulling: true }));

    try {
      const result = await pullChanges(workspaceId);
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
      setGitState((prev) => ({ ...prev, pulling: false }));
    }
  }, [workspaceId, refreshGitStatus, setStatusMessage]);

  const handleFetch = useCallback(async () => {
    if (!workspaceId) return;

    try {
      await fetchChanges(workspaceId);
      setStatusMessage('Fetched from remote');
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch';
      setStatusMessage(message);
    }
  }, [workspaceId, refreshGitStatus, setStatusMessage]);

  return {
    gitState,
    refreshGitStatus,
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
    handleFetch
  };
};
