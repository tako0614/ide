import { useCallback } from 'react';
import type { GitStatus, GitFileStatus } from '../../types';
import { GitFileRow } from '../GitFileRow';
import type { BranchStatus } from '../../hooks/useGitState';

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

interface ChangesTabProps {
  status: GitStatus;
  branchStatus: BranchStatus | null;
  hasRemote: boolean;
  pushing: boolean;
  pulling: boolean;
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  onCommit: () => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardFile: (path: string) => void;
  onShowDiff: (file: GitFileStatus) => void;
  onPush: () => void;
  onPull: () => void;
}

export function ChangesTab({
  status,
  branchStatus,
  hasRemote,
  pushing,
  pulling,
  commitMessage,
  onCommitMessageChange,
  onCommit,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  onDiscardFile,
  onShowDiff,
  onPush,
  onPull
}: ChangesTabProps) {
  const stagedFiles = status.files.filter((f) => f.staged);
  const unstagedFiles = status.files.filter((f) => !f.staged);
  const hasChanges = status.files.length > 0;
  const hasStagedChanges = stagedFiles.length > 0;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onCommit();
      }
    },
    [onCommit]
  );

  return (
    <>
      {/* Commit input */}
      <div className="commit-section">
        <textarea
          className="commit-input"
          placeholder={LABEL_COMMIT_PLACEHOLDER}
          value={commitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
        />
        <button
          type="button"
          className="primary-button commit-button"
          onClick={onCommit}
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
}
