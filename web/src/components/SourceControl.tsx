import { useState, useCallback } from 'react';
import clsx from 'clsx';
import type { GitStatus, GitFileStatus, GitRepoInfo } from '../types';
import type { BranchStatus, GitBranch, GitLogEntry } from '../hooks/useGitState';
import { ChangesTab } from './git/ChangesTab';
import { BranchesTab } from './git/BranchesTab';
import { HistoryTab } from './git/HistoryTab';

const LABEL_SOURCE_CONTROL = 'ソースコントロール';
const LABEL_NOT_GIT_REPO = 'Gitリポジトリではありません';
const LABEL_SELECT_WORKSPACE = 'ワークスペースを選択してください';
const LABEL_LOADING = '読み込み中...';
const LABEL_REFRESH = '更新';
const LABEL_CHANGES = '変更';
const LABEL_BRANCHES = 'ブランチ';
const LABEL_HISTORY = '履歴';

type TabType = 'changes' | 'branches' | 'history';

interface SourceControlProps {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  workspaceId: string | null;
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
  selectedRepoPath: string | null;
  onSelectRepo: (repoPath: string) => void;
  // Actions
  onRefresh: () => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommit: (message: string) => void;
  onDiscardFile: (path: string) => void;
  onShowDiff: (file: GitFileStatus) => void;
  onPush: () => void;
  onPull: () => void;
  onLoadBranches: () => void;
  onCheckoutBranch: (branchName: string) => void;
  onCreateBranch: (branchName: string) => void;
  onLoadLogs: () => void;
}

const CHIP_CLASS = 'border border-border bg-transparent text-ink px-2.5 py-1 text-xs rounded-[2px] cursor-pointer hover:bg-list-hover disabled:opacity-50 disabled:cursor-not-allowed';
const EMPTY_STATE_CLASS = 'flex items-center justify-center h-full text-muted text-[13px] p-5';

export function SourceControl({
  status,
  loading,
  error,
  workspaceId,
  branchStatus,
  hasRemote,
  pushing,
  pulling,
  branches,
  branchesLoading,
  logs,
  logsLoading,
  repos,
  selectedRepoPath,
  onSelectRepo,
  onRefresh,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  onCommit,
  onDiscardFile,
  onShowDiff,
  onPush,
  onPull,
  onLoadBranches,
  onCheckoutBranch,
  onCreateBranch,
  onLoadLogs
}: SourceControlProps) {
  const [commitMessage, setCommitMessage] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('changes');

  const handleCommit = useCallback(() => {
    if (commitMessage.trim()) {
      onCommit(commitMessage.trim());
      setCommitMessage('');
    }
  }, [commitMessage, onCommit]);

  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab);
    if (tab === 'branches') {
      onLoadBranches();
    } else if (tab === 'history') {
      onLoadLogs();
    }
  }, [onLoadBranches, onLoadLogs]);

  if (!workspaceId) {
    return (
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
        </div>
        <div className="panel-body">
          <div className={EMPTY_STATE_CLASS}>{LABEL_SELECT_WORKSPACE}</div>
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
        </div>
        <div className="panel-body">
          <div className={EMPTY_STATE_CLASS}>{LABEL_LOADING}</div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
          <button type="button" className={CHIP_CLASS} onClick={onRefresh}>
            {LABEL_REFRESH}
          </button>
        </div>
        <div className="panel-body">
          <div className="flex items-center justify-center h-full text-[#f14c4c] text-[13px] p-5">{error}</div>
        </div>
      </section>
    );
  }

  if (!status?.isGitRepo) {
    return (
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
          <button type="button" className={CHIP_CLASS} onClick={onRefresh}>
            {LABEL_REFRESH}
          </button>
        </div>
        <div className="panel-body">
          <div className={EMPTY_STATE_CLASS}>{LABEL_NOT_GIT_REPO}</div>
        </div>
      </section>
    );
  }

  const hasChanges = status.files.length > 0;
  const hasMultipleRepos = repos.length > 1;

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
          <div className="panel-subtitle flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true">
              <path
                d="M6 3v12M18 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM6 21a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M18 12c0 3-3 4-6 4s-6-1-6-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
            {status.branch}
          </div>
        </div>
        <button type="button" className={CHIP_CLASS} onClick={onRefresh}>
          {LABEL_REFRESH}
        </button>
      </div>

      {/* Repository selector - only show when multiple repos exist */}
      {hasMultipleRepos && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-sidebar text-xs">
          <svg className="w-3.5 h-3.5 text-muted flex-shrink-0" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <select
            className="flex-1 min-w-0 bg-panel border border-border rounded-[2px] px-2 py-1 text-[12px] font-mono text-ink focus:outline-none focus:border-focus"
            value={selectedRepoPath || ''}
            onChange={(e) => onSelectRepo(e.target.value)}
          >
            {repos.map((repo) => (
              <option key={repo.path} value={repo.path}>
                {repo.name} ({repo.branch}) {repo.fileCount > 0 ? `• ${repo.fileCount}` : ''}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-muted font-mono flex-shrink-0">{repos.length} repos</span>
        </div>
      )}

      <div className="git-tabs">
        <button
          type="button"
          className={clsx('git-tab', activeTab === 'changes' && 'active')}
          onClick={() => handleTabChange('changes')}
        >
          {LABEL_CHANGES}
          {hasChanges && (
            <span className="text-[10px] font-semibold bg-accent/20 text-accent rounded-full px-1.5 py-0.5 leading-none">
              {status.files.length}
            </span>
          )}
        </button>
        <button
          type="button"
          className={clsx('git-tab', activeTab === 'branches' && 'active')}
          onClick={() => handleTabChange('branches')}
        >
          {LABEL_BRANCHES}
        </button>
        <button
          type="button"
          className={clsx('git-tab', activeTab === 'history' && 'active')}
          onClick={() => handleTabChange('history')}
        >
          {LABEL_HISTORY}
        </button>
      </div>

      <div className="panel-body">
        {activeTab === 'changes' && (
          <ChangesTab
            status={status}
            branchStatus={branchStatus}
            hasRemote={hasRemote}
            pushing={pushing}
            pulling={pulling}
            commitMessage={commitMessage}
            onCommitMessageChange={setCommitMessage}
            onCommit={handleCommit}
            onStageFile={onStageFile}
            onUnstageFile={onUnstageFile}
            onStageAll={onStageAll}
            onUnstageAll={onUnstageAll}
            onDiscardFile={onDiscardFile}
            onShowDiff={onShowDiff}
            onPush={onPush}
            onPull={onPull}
          />
        )}
        {activeTab === 'branches' && (
          <BranchesTab
            branches={branches}
            branchesLoading={branchesLoading}
            onCheckoutBranch={onCheckoutBranch}
            onCreateBranch={onCreateBranch}
          />
        )}
        {activeTab === 'history' && (
          <HistoryTab
            logs={logs}
            logsLoading={logsLoading}
          />
        )}
      </div>
    </section>
  );
}
