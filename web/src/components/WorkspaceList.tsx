import clsx from 'clsx';
import type { Workspace } from '../types';

interface WorkspaceListProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
  onDelete: (workspaceId: string) => void;
}

const LABEL_EMPTY = '\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u304c\u3042\u308a\u307e\u305b\u3093\u3002';

export function WorkspaceList({
  workspaces,
  selectedWorkspaceId,
  onSelect,
  onDelete
}: WorkspaceListProps) {
  return (
    <div className="w-full grid gap-2">
      {workspaces.length === 0 ? (
        <div className="flex items-center justify-center text-muted text-[13px] p-8">{LABEL_EMPTY}</div>
      ) : (
        workspaces.map((workspace) => (
          <div
            key={workspace.id}
            className={clsx(
              'flex items-center gap-2 p-4 border border-border rounded bg-panel transition-colors hover:bg-list-hover',
              workspace.id === selectedWorkspaceId && 'bg-list-active border-accent'
            )}
          >
            <button
              type="button"
              className="flex-1 min-w-0 text-left bg-transparent border-0 p-0 cursor-pointer"
              onClick={() => onSelect(workspace.id)}
            >
              <div className="font-semibold text-[15px] mb-1">{workspace.name}</div>
              <div className="text-[12px] text-muted font-mono truncate">{workspace.path}</div>
            </button>
            <button
              type="button"
              className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded bg-transparent border-0 text-muted cursor-pointer hover:bg-[rgba(0,0,0,0.08)] hover:text-ink transition-colors dark:hover:bg-[rgba(255,255,255,0.08)]"
              title="\u524a\u9664"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`\u300c${workspace.name}\u300d\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f`)) {
                  onDelete(workspace.id);
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        ))
      )}
    </div>
  );
}
