import type { GitFileStatus, GitFileStatusCode } from '../types';

const LABEL_STAGE = 'ステージ';
const LABEL_UNSTAGE = 'アンステージ';
const LABEL_DISCARD = '変更を破棄';
const LABEL_VIEW_DIFF = '差分を表示';

const STATUS_LABELS: Record<GitFileStatusCode, string> = {
  modified: 'M',
  staged: 'A',
  untracked: 'U',
  deleted: 'D',
  renamed: 'R',
  conflicted: 'C'
};

interface GitFileRowProps {
  file: GitFileStatus;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
  onShowDiff: (file: GitFileStatus) => void;
}

export function GitFileRow({
  file,
  onStage,
  onUnstage,
  onDiscard,
  onShowDiff
}: GitFileRowProps) {
  const statusClass = `git-${file.status}`;
  const statusLabel = STATUS_LABELS[file.status];

  return (
    <div className="git-file-row">
      <button
        type="button"
        className="git-file-main"
        onClick={() => onShowDiff(file)}
        title={LABEL_VIEW_DIFF}
      >
        <span className={`git-status-badge ${statusClass}`}>{statusLabel}</span>
        <span className="git-file-path">{file.path}</span>
      </button>
      <div className="git-file-actions">
        {file.staged ? (
          <button
            type="button"
            className="git-action-btn"
            onClick={() => onUnstage(file.path)}
            title={LABEL_UNSTAGE}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19 13H5v-2h14v2z" />
            </svg>
          </button>
        ) : (
          <>
            <button
              type="button"
              className="git-action-btn"
              onClick={() => onDiscard(file.path)}
              title={LABEL_DISCARD}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
            <button
              type="button"
              className="git-action-btn"
              onClick={() => onStage(file.path)}
              title={LABEL_STAGE}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
