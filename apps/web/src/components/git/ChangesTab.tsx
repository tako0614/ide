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
      <div className="flex flex-col gap-2 px-3">
        <textarea
          className="border border-border rounded-[2px] p-2 text-[13px] font-[inherit] bg-panel text-ink resize-y min-h-[50px] focus:outline-none focus:border-focus"
          placeholder={LABEL_COMMIT_PLACEHOLDER}
          value={commitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
        />
        <button
          type="button"
          className="bg-accent text-white border-0 px-3.5 py-1.5 text-[13px] font-medium rounded-[2px] cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onCommit}
          disabled={!hasStagedChanges || !commitMessage.trim()}
        >
          {LABEL_COMMIT}
        </button>
      </div>

      {/* Sync buttons */}
      {hasRemote && (
        <div className="flex gap-2 px-3 py-2 border-b border-border">
          <button
            type="button"
            className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-transparent border border-border rounded-[2px] text-ink text-xs cursor-pointer hover:bg-list-hover disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onPull}
            disabled={pulling || pushing}
            title={branchStatus?.behind ? `${branchStatus.behind} commits behind` : LABEL_PULL}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {pulling ? LABEL_PULLING : LABEL_PULL}
            {branchStatus?.behind ? ` (${branchStatus.behind})` : ''}
          </button>
          <button
            type="button"
            className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-transparent border border-border rounded-[2px] text-ink text-xs cursor-pointer hover:bg-list-hover disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onPush}
            disabled={pushing || pulling}
            title={branchStatus?.ahead ? `${branchStatus.ahead} commits ahead` : LABEL_PUSH}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 20V8m0 0l4 4m-4-4l-4 4M4 4h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {pushing ? LABEL_PUSHING : LABEL_PUSH}
            {branchStatus?.ahead ? ` (${branchStatus.ahead})` : ''}
          </button>
        </div>
      )}

      {!hasChanges ? (
        <div className="flex items-center justify-center h-full text-muted text-[13px] p-5">{LABEL_NO_CHANGES}</div>
      ) : (
        <>
          {/* Staged changes */}
          {stagedFiles.length > 0 && (
            <div className="flex flex-col">
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.5px] text-ink-muted">
                  {LABEL_STAGED_CHANGES} ({stagedFiles.length})
                </span>
                <button
                  type="button"
                  className="w-[22px] h-[22px] p-0 border-0 rounded-[3px] bg-transparent text-ink-muted cursor-pointer flex items-center justify-center hover:bg-list-hover hover:text-ink"
                  onClick={onUnstageAll}
                  title={LABEL_UNSTAGE_ALL}
                >
                  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19 13H5v-2h14v2z" />
                  </svg>
                </button>
              </div>
              <div className="flex flex-col">
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
            <div className="flex flex-col">
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.5px] text-ink-muted">
                  {LABEL_CHANGES} ({unstagedFiles.length})
                </span>
                <button
                  type="button"
                  className="w-[22px] h-[22px] p-0 border-0 rounded-[3px] bg-transparent text-ink-muted cursor-pointer flex items-center justify-center hover:bg-list-hover hover:text-ink"
                  onClick={onStageAll}
                  title={LABEL_STAGE_ALL}
                >
                  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                  </svg>
                </button>
              </div>
              <div className="flex flex-col">
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
