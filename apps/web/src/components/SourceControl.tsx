import { useState, useCallback, useEffect } from 'react';
import type { GitStatus, GitFileStatus } from '../types';
import { GitFileRow } from './GitFileRow';
import type { BranchStatus, GitBranch, GitLogEntry } from '../hooks/useGitState';

const LABEL_SOURCE_CONTROL = 'ソースコントロール';
const LABEL_NOT_GIT_REPO = 'Gitリポジトリではありません';
const LABEL_SELECT_WORKSPACE = 'ワークスペースを選択してください';
const LABEL_LOADING = '読み込み中...';
const LABEL_REFRESH = '更新';
const LABEL_STAGED_CHANGES = 'ステージ済みの変更';
const LABEL_CHANGES = '変更';
const LABEL_COMMIT = 'コミット';
const LABEL_COMMIT_PLACEHOLDER = 'コミットメッセージを入力...';
const LABEL_NO_CHANGES = '変更はありません';
const LABEL_STAGE_ALL = 'すべてステージ';
const LABEL_UNSTAGE_ALL = 'すべてアンステージ';
const LABEL_PUSH = 'Push';
const LABEL_PULL = 'Pull';
const LABEL_PUSHING = 'Pushing...';
const LABEL_PULLING = 'Pulling...';
const LABEL_BRANCHES = 'ブランチ';
const LABEL_HISTORY = '履歴';
const LABEL_NEW_BRANCH = '新規ブランチ';
const LABEL_CREATE = '作成';
const LABEL_CANCEL = 'キャンセル';

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
  const [showNewBranchInput, setShowNewBranchInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');

  const handleCommit = useCallback(() => {
    if (commitMessage.trim()) {
      onCommit(commitMessage.trim());
      setCommitMessage('');
    }
  }, [commitMessage, onCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleCommit();
      }
    },
    [handleCommit]
  );

  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab);
    if (tab === 'branches') {
      onLoadBranches();
    } else if (tab === 'history') {
      onLoadLogs();
    }
  }, [onLoadBranches, onLoadLogs]);

  const handleCreateBranch = useCallback(() => {
    if (newBranchName.trim()) {
      onCreateBranch(newBranchName.trim());
      setNewBranchName('');
      setShowNewBranchInput(false);
    }
  }, [newBranchName, onCreateBranch]);

  const handleNewBranchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCreateBranch();
      } else if (e.key === 'Escape') {
        setShowNewBranchInput(false);
        setNewBranchName('');
      }
    },
    [handleCreateBranch]
  );

  if (!workspaceId) {
    return (
      <section className="panel source-control">
        <div className="panel-header">
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
        </div>
        <div className="panel-body">
          <div className="empty-state">{LABEL_SELECT_WORKSPACE}</div>
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="panel source-control">
        <div className="panel-header">
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
        </div>
        <div className="panel-body">
          <div className="empty-state">{LABEL_LOADING}</div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel source-control">
        <div className="panel-header">
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
          <button type="button" className="chip" onClick={onRefresh}>
            {LABEL_REFRESH}
          </button>
        </div>
        <div className="panel-body">
          <div className="empty-state error">{error}</div>
        </div>
      </section>
    );
  }

  if (!status?.isGitRepo) {
    return (
      <section className="panel source-control">
        <div className="panel-header">
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
          <button type="button" className="chip" onClick={onRefresh}>
            {LABEL_REFRESH}
          </button>
        </div>
        <div className="panel-body">
          <div className="empty-state">{LABEL_NOT_GIT_REPO}</div>
        </div>
      </section>
    );
  }

  const stagedFiles = status.files.filter((f) => f.staged);
  const unstagedFiles = status.files.filter((f) => !f.staged);
  const hasChanges = status.files.length > 0;
  const hasStagedChanges = stagedFiles.length > 0;

  const renderChangesTab = () => (
    <>
      {/* Commit input */}
      <div className="commit-section">
        <textarea
          className="commit-input"
          placeholder={LABEL_COMMIT_PLACEHOLDER}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
        />
        <button
          type="button"
          className="primary-button commit-button"
          onClick={handleCommit}
          disabled={!hasStagedChanges || !commitMessage.trim()}
        >
          {LABEL_COMMIT}
        </button>
      </div>

      {/* Sync buttons */}
      {hasRemote && (
        <div className="sync-section">
          <button
            type="button"
            className="sync-button"
            onClick={onPull}
            disabled={pulling || pushing}
            title={branchStatus?.behind ? `${branchStatus.behind} commits behind` : LABEL_PULL}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {pulling ? LABEL_PULLING : LABEL_PULL}
            {branchStatus?.behind ? ` (${branchStatus.behind})` : ''}
          </button>
          <button
            type="button"
            className="sync-button"
            onClick={onPush}
            disabled={pushing || pulling}
            title={branchStatus?.ahead ? `${branchStatus.ahead} commits ahead` : LABEL_PUSH}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 20V8m0 0l4 4m-4-4l-4 4M4 4h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {pushing ? LABEL_PUSHING : LABEL_PUSH}
            {branchStatus?.ahead ? ` (${branchStatus.ahead})` : ''}
          </button>
        </div>
      )}

      {!hasChanges ? (
        <div className="empty-state">{LABEL_NO_CHANGES}</div>
      ) : (
        <>
          {/* Staged changes */}
          {stagedFiles.length > 0 && (
            <div className="change-group">
              <div className="change-group-header">
                <span className="change-group-title">
                  {LABEL_STAGED_CHANGES} ({stagedFiles.length})
                </span>
                <button
                  type="button"
                  className="change-group-action"
                  onClick={onUnstageAll}
                  title={LABEL_UNSTAGE_ALL}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19 13H5v-2h14v2z" />
                  </svg>
                </button>
              </div>
              <div className="change-group-files">
                {stagedFiles.map((file) => (
                  <GitFileRow
                    key={file.path}
                    file={file}
                    onStage={onStageFile}
                    onUnstage={onUnstageFile}
                    onDiscard={onDiscardFile}
                    onShowDiff={onShowDiff}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Unstaged changes */}
          {unstagedFiles.length > 0 && (
            <div className="change-group">
              <div className="change-group-header">
                <span className="change-group-title">
                  {LABEL_CHANGES} ({unstagedFiles.length})
                </span>
                <button
                  type="button"
                  className="change-group-action"
                  onClick={onStageAll}
                  title={LABEL_STAGE_ALL}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                  </svg>
                </button>
              </div>
              <div className="change-group-files">
                {unstagedFiles.map((file) => (
                  <GitFileRow
                    key={file.path}
                    file={file}
                    onStage={onStageFile}
                    onUnstage={onUnstageFile}
                    onDiscard={onDiscardFile}
                    onShowDiff={onShowDiff}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );

  const renderBranchesTab = () => (
    <div className="branches-section">
      <div className="branch-actions">
        {showNewBranchInput ? (
          <div className="new-branch-form">
            <input
              type="text"
              className="new-branch-input"
              placeholder="ブランチ名..."
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={handleNewBranchKeyDown}
              autoFocus
            />
            <button
              type="button"
              className="chip"
              onClick={handleCreateBranch}
              disabled={!newBranchName.trim()}
            >
              {LABEL_CREATE}
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => {
                setShowNewBranchInput(false);
                setNewBranchName('');
              }}
            >
              {LABEL_CANCEL}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="chip"
            onClick={() => setShowNewBranchInput(true)}
          >
            {LABEL_NEW_BRANCH}
          </button>
        )}
      </div>
      {branchesLoading ? (
        <div className="empty-state">{LABEL_LOADING}</div>
      ) : (
        <div className="branch-list">
          {branches.map((branch) => (
            <button
              key={branch.name}
              type="button"
              className={`branch-item ${branch.current ? 'current' : ''}`}
              onClick={() => !branch.current && onCheckoutBranch(branch.name)}
              disabled={branch.current}
            >
              <svg className="branch-icon" viewBox="0 0 24 24" aria-hidden="true">
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
              <span className="branch-name">{branch.name}</span>
              {branch.current && <span className="branch-current-badge">現在</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const renderHistoryTab = () => (
    <div className="history-section">
      {logsLoading ? (
        <div className="empty-state">{LABEL_LOADING}</div>
      ) : logs.length === 0 ? (
        <div className="empty-state">コミット履歴がありません</div>
      ) : (
        <div className="log-list">
          {logs.map((log) => (
            <div key={log.hash} className="log-item">
              <div className="log-header">
                <span className="log-hash">{log.hashShort}</span>
                <span className="log-author">{log.author}</span>
              </div>
              <div className="log-message">{log.message}</div>
              <div className="log-date">{new Date(log.date).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section className="panel source-control">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_SOURCE_CONTROL}</div>
          <div className="panel-subtitle git-branch">
            <svg viewBox="0 0 24 24" className="git-branch-icon" aria-hidden="true">
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
        <button type="button" className="chip" onClick={onRefresh}>
          {LABEL_REFRESH}
        </button>
      </div>
      <div className="git-tabs">
        <button
          type="button"
          className={`git-tab ${activeTab === 'changes' ? 'active' : ''}`}
          onClick={() => handleTabChange('changes')}
        >
          {LABEL_CHANGES}
          {hasChanges && <span className="git-tab-count">{status.files.length}</span>}
        </button>
        <button
          type="button"
          className={`git-tab ${activeTab === 'branches' ? 'active' : ''}`}
          onClick={() => handleTabChange('branches')}
        >
          {LABEL_BRANCHES}
        </button>
        <button
          type="button"
          className={`git-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => handleTabChange('history')}
        >
          {LABEL_HISTORY}
        </button>
      </div>
      <div className="panel-body source-control-body">
        {activeTab === 'changes' && renderChangesTab()}
        {activeTab === 'branches' && renderBranchesTab()}
        {activeTab === 'history' && renderHistoryTab()}
      </div>
    </section>
  );
}
