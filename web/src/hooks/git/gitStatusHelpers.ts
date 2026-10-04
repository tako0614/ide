/**
 * Pure async helper functions for git status fetching.
 * These are extracted from useGitState to keep the hook file manageable.
 */

import type { MutableRefObject } from 'react';
import {
  getGitStatus,
  getGitRepos,
  getBranchStatus,
  getGitRemotes
} from '../../api';
import { withTimeout } from '../../utils';
import type { GitState } from '../useGitState';
import { createEmptyGitState } from '../useGitState';

type UpdateGitState = (
  workspaceId: string,
  updater: (prev: GitState) => GitState
) => void;

/**
 * Fetches repos, status, branch-status, and remotes for a workspace,
 * then updates git state. Guards against concurrent calls via loadingRefs.
 */
export async function fetchGitStatus(
  workspaceId: string,
  updateGitState: UpdateGitState,
  gitStatesRef: MutableRefObject<Record<string, GitState>>,
  loadingRefs: MutableRefObject<Record<string, boolean>>
): Promise<void> {
  if (loadingRefs.current[workspaceId]) return;
  loadingRefs.current[workspaceId] = true;

  updateGitState(workspaceId, (prev) => ({
    ...prev,
    loading: true,
    reposLoading: true,
    error: null
  }));

  try {
    const reposResult = await withTimeout(getGitRepos(workspaceId)).catch(() => ({ repos: [] }));
    const repos = reposResult.repos;

    updateGitState(workspaceId, (prev) => ({
      ...prev,
      repos,
      reposLoading: false,
      selectedRepoPath: prev.selectedRepoPath ?? (repos.length > 0 ? repos[0].path : null)
    }));

    const currentState = gitStatesRef.current[workspaceId] || createEmptyGitState();
    const repoPath = currentState.selectedRepoPath ?? (repos.length > 0 ? repos[0].path : undefined);

    const [status, branchStatus, remotes] = await Promise.all([
      withTimeout(getGitStatus(workspaceId, repoPath || undefined)),
      withTimeout(getBranchStatus(workspaceId, repoPath || undefined)).catch(() => ({
        ahead: 0,
        behind: 0,
        hasUpstream: false
      })),
      withTimeout(getGitRemotes(workspaceId, repoPath || undefined)).catch(() => ({
        hasRemote: false,
        remotes: []
      }))
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
}

/**
 * Fetches status for a specific repo path and updates git state.
 */
export async function fetchRepoStatus(
  workspaceId: string,
  repoPath: string,
  updateGitState: UpdateGitState,
  setStatusMessage: (msg: string) => void
): Promise<void> {
  updateGitState(workspaceId, (prev) => ({
    ...prev,
    selectedRepoPath: repoPath,
    loading: true
  }));

  try {
    const [status, branchStatus, remotes] = await Promise.all([
      withTimeout(getGitStatus(workspaceId, repoPath || undefined)),
      withTimeout(getBranchStatus(workspaceId, repoPath || undefined)).catch(() => ({
        ahead: 0,
        behind: 0,
        hasUpstream: false
      })),
      withTimeout(getGitRemotes(workspaceId, repoPath || undefined)).catch(() => ({
        hasRemote: false,
        remotes: []
      }))
    ]);

    updateGitState(workspaceId, (prev) => ({
      ...prev,
      status,
      branchStatus,
      hasRemote: remotes.hasRemote,
      loading: false,
      branches: [],
      logs: []
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get git status';
    setStatusMessage(message);
    updateGitState(workspaceId, (prev) => ({ ...prev, loading: false }));
  }
}
