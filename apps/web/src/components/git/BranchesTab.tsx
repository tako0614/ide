import { useState, useCallback } from 'react';
import clsx from 'clsx';
import type { GitBranch } from '../../hooks/useGitState';

const LABEL_LOADING = '読み込み中...';
const LABEL_NEW_BRANCH = '新規ブランチ';
const LABEL_CREATE = '作成';
const LABEL_CANCEL = 'キャンセル';

interface BranchesTabProps {
  branches: GitBranch[];
  branchesLoading: boolean;
  onCheckoutBranch: (branchName: string) => void;
  onCreateBranch: (branchName: string) => void;
}

export function BranchesTab({
  branches,
  branchesLoading,
  onCheckoutBranch,
  onCreateBranch
}: BranchesTabProps) {
  const [showNewBranchInput, setShowNewBranchInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');

  const handleCreateBranch = useCallback(() => {
    if (newBranchName.trim()) {
      onCreateBranch(newBranchName.trim());
      setNewBranchName('');
      setShowNewBranchInput(false);
    }
  }, [newBranchName, onCreateBranch]);

  const handleKeyDown = useCallback(
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

  return (
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
              onKeyDown={handleKeyDown}
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
              className={clsx('branch-item', branch.current && 'current')}
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
}
