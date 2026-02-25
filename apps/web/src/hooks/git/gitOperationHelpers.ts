/**
 * Pure async helper functions for git operations.
 * These are extracted from useGitState to keep the hook file manageable.
 */

import {
  stageFiles,
  unstageFiles,
  commitChanges,
  discardChanges,
  getGitDiff,
  pushChanges,
  pullChanges,
  fetchChanges,
  listBranches,
  checkoutBranch,
  createBranch,
  getGitLog
} from '../../api';
import { withTimeout } from '../../utils';
import type { GitFileStatus } from '../../types';
import type { GitState } from '../useGitState';

type UpdateGitState = (
  workspaceId: string,
  updater: (prev: GitState) => GitState
) => void;

export async function stageFile(
  workspaceId: string,
  path: string,
  repoPath: string | undefined,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>
): Promise<void> {
  try {
    await stageFiles(workspaceId, [path], repoPath);
    await refreshGitStatus();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to stage file');
  }
}

export async function unstageFile(
  workspaceId: string,
  path: string,
  repoPath: string | undefined,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>
): Promise<void> {
  try {
    await unstageFiles(workspaceId, [path], repoPath);
    await refreshGitStatus();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to unstage file');
  }
}

export async function stageAllFiles(
  workspaceId: string,
  unstagedPaths: string[],
  repoPath: string | undefined,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>
): Promise<void> {
  if (unstagedPaths.length === 0) return;
  try {
    await stageFiles(workspaceId, unstagedPaths, repoPath);
    await refreshGitStatus();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to stage files');
  }
}

export async function unstageAllFiles(
  workspaceId: string,
  stagedPaths: string[],
  repoPath: string | undefined,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>
): Promise<void> {
  if (stagedPaths.length === 0) return;
  try {
    await unstageFiles(workspaceId, stagedPaths, repoPath);
    await refreshGitStatus();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to unstage files');
  }
}

export async function commitFiles(
  workspaceId: string,
  message: string,
  repoPath: string | undefined,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>
): Promise<void> {
  try {
    const result = await commitChanges(workspaceId, message.trim(), repoPath);
    setStatusMessage(
      `Committed: ${result.summary.changes} changes, +${result.summary.insertions} -${result.summary.deletions}`
    );
    await refreshGitStatus();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to commit');
  }
}

export async function discardFile(
  workspaceId: string,
  path: string,
  repoPath: string | undefined,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>
): Promise<void> {
  try {
    await discardChanges(workspaceId, [path], repoPath);
    await refreshGitStatus();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to discard changes');
  }
}

export async function showDiff(
  workspaceId: string,
  file: GitFileStatus,
  repoPath: string | undefined,
  updateGitState: UpdateGitState,
  setStatusMessage: (msg: string) => void
): Promise<void> {
  updateGitState(workspaceId, (prev) => ({
    ...prev,
    diffPath: file.path,
    diffLoading: true,
    diff: null
  }));

  try {
    const diff = await getGitDiff(workspaceId, file.path, file.staged, repoPath);
    updateGitState(workspaceId, (prev) => ({ ...prev, diff, diffLoading: false }));
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to get diff');
    updateGitState(workspaceId, (prev) => ({
      ...prev,
      diffPath: null,
      diff: null,
      diffLoading: false
    }));
  }
}

export async function push(
  workspaceId: string,
  repoPath: string | undefined,
  updateGitState: UpdateGitState,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>
): Promise<void> {
  updateGitState(workspaceId, (prev) => ({ ...prev, pushing: true }));
  try {
    const result = await pushChanges(workspaceId, repoPath);
    setStatusMessage(`Pushed to ${result.branch}`);
    await refreshGitStatus();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to push');
  } finally {
    updateGitState(workspaceId, (prev) => ({ ...prev, pushing: false }));
  }
}

export async function pull(
  workspaceId: string,
  repoPath: string | undefined,
  updateGitState: UpdateGitState,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>
): Promise<void> {
  updateGitState(workspaceId, (prev) => ({ ...prev, pulling: true }));
  try {
    const result = await pullChanges(workspaceId, repoPath);
    if (result.summary.changes > 0) {
      setStatusMessage(
        `Pulled: ${result.summary.changes} changes, +${result.summary.insertions} -${result.summary.deletions}`
      );
    } else {
      setStatusMessage('Already up to date');
    }
    await refreshGitStatus();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to pull');
  } finally {
    updateGitState(workspaceId, (prev) => ({ ...prev, pulling: false }));
  }
}

export async function fetch(
  workspaceId: string,
  repoPath: string | undefined,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>
): Promise<void> {
  try {
    await fetchChanges(workspaceId, repoPath);
    setStatusMessage('Fetched from remote');
    await refreshGitStatus();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to fetch');
  }
}

export async function loadBranches(
  workspaceId: string,
  repoPath: string | undefined,
  updateGitState: UpdateGitState,
  setStatusMessage: (msg: string) => void
): Promise<void> {
  updateGitState(workspaceId, (prev) => ({ ...prev, branchesLoading: true }));
  try {
    const result = await withTimeout(listBranches(workspaceId, repoPath));
    updateGitState(workspaceId, (prev) => ({
      ...prev,
      branches: result.branches,
      branchesLoading: false
    }));
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to load branches');
    updateGitState(workspaceId, (prev) => ({ ...prev, branchesLoading: false }));
  }
}

export async function checkoutBranchOp(
  workspaceId: string,
  branchName: string,
  repoPath: string | undefined,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>,
  handleLoadBranches: () => Promise<void>
): Promise<void> {
  try {
    await checkoutBranch(workspaceId, branchName, repoPath);
    setStatusMessage(`Switched to branch '${branchName}'`);
    await refreshGitStatus();
    await handleLoadBranches();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to checkout branch');
  }
}

export async function createBranchOp(
  workspaceId: string,
  branchName: string,
  checkout: boolean,
  repoPath: string | undefined,
  setStatusMessage: (msg: string) => void,
  refreshGitStatus: () => Promise<void>,
  handleLoadBranches: () => Promise<void>
): Promise<void> {
  try {
    await createBranch(workspaceId, branchName, checkout, repoPath);
    setStatusMessage(`Created branch '${branchName}'${checkout ? ' and switched to it' : ''}`);
    await refreshGitStatus();
    await handleLoadBranches();
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to create branch');
  }
}

export async function loadLogs(
  workspaceId: string,
  limit: number,
  repoPath: string | undefined,
  updateGitState: UpdateGitState,
  setStatusMessage: (msg: string) => void
): Promise<void> {
  updateGitState(workspaceId, (prev) => ({ ...prev, logsLoading: true }));
  try {
    const result = await withTimeout(getGitLog(workspaceId, limit, repoPath));
    updateGitState(workspaceId, (prev) => ({
      ...prev,
      logs: result.logs,
      logsLoading: false
    }));
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : 'Failed to load git log');
    updateGitState(workspaceId, (prev) => ({ ...prev, logsLoading: false }));
  }
}
