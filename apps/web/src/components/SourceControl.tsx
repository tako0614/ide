import { useState, useCallback } from 'react';
import type { GitStatus, GitFileStatus } from '../types';
import { GitFileRow } from './GitFileRow';
import type { BranchStatus } from '../hooks/useGitState';

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

interface SourceControlProps {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  workspaceId: string | null;
  branchStatus: BranchStatus | null;
  hasRemote: boolean;
  pushing: boolean;
  pulling: boolean;
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
  onRefresh,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  onCommit,
  onDiscardFile,
  onShowDiff,
  onPush,
  onPull
}: SourceControlProps) {
  const [commitMessage, setCommitMessage] = useState('');

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
      <div className="panel-body source-control-body">
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
      </div>
    </section>
  );
}
