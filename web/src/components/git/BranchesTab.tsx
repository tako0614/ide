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
    <div className="flex flex-col gap-2">
      <div className="px-3 py-2 border-b border-border">
        {showNewBranchInput ? (
          <div className="flex gap-1.5 items-center">
            <input
              type="text"
              className="flex-1 px-2 py-1 text-xs border border-border rounded-[2px] bg-panel text-ink font-mono focus:outline-none focus:border-focus"
              placeholder="ブランチ名..."
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            <button
              type="button"
              className="border border-border bg-transparent text-ink px-2.5 py-1 text-xs rounded-[2px] cursor-pointer hover:bg-list-hover disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleCreateBranch}
              disabled={!newBranchName.trim()}
            >
              {LABEL_CREATE}
            </button>
            <button
              type="button"
              className="border border-border bg-transparent text-ink px-2.5 py-1 text-xs rounded-[2px] cursor-pointer hover:bg-list-hover disabled:opacity-50 disabled:cursor-not-allowed"
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
            className="border border-border bg-transparent text-ink px-2.5 py-1 text-xs rounded-[2px] cursor-pointer hover:bg-list-hover disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => setShowNewBranchInput(true)}
          >
            {LABEL_NEW_BRANCH}
          </button>
        )}
      </div>
      {branchesLoading ? (
        <div className="flex items-center justify-center h-full text-muted text-[13px] p-5">{LABEL_LOADING}</div>
      ) : (
        <div className="flex flex-col">
          {branches.map((branch) => (
            <button
              key={branch.name}
              type="button"
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 bg-transparent border-0 text-ink text-[13px] cursor-pointer text-left transition-colors hover:bg-list-hover disabled:cursor-default',
                branch.current && 'bg-list-active cursor-default'
              )}
              onClick={() => !branch.current && onCheckoutBranch(branch.name)}
              disabled={branch.current}
            >
              <svg className="w-4 h-4 flex-shrink-0 text-ink-muted" viewBox="0 0 24 24" aria-hidden="true">
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
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono">{branch.name}</span>
              {branch.current && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 bg-accent text-white rounded-[3px]">現在</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
