import clsx from 'clsx';
import type { Workspace } from '../types';

interface WorkspaceListProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
}

const LABEL_EMPTY = '\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u304c\u3042\u308a\u307e\u305b\u3093\u3002';

export function WorkspaceList({
  workspaces,
  selectedWorkspaceId,
  onSelect
}: WorkspaceListProps) {
  return (
    <div className="w-full grid gap-2">
      {workspaces.length === 0 ? (
        <div className="flex items-center justify-center text-muted text-[13px] p-8">{LABEL_EMPTY}</div>
      ) : (
        workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            className={clsx(
              'w-full text-left p-4 border border-border rounded bg-panel cursor-pointer transition-colors hover:bg-list-hover',
              workspace.id === selectedWorkspaceId && 'bg-list-active border-accent'
            )}
            onClick={() => onSelect(workspace.id)}
          >
            <div className="font-semibold text-[15px] mb-1">{workspace.name}</div>
            <div className="text-[12px] text-muted font-mono truncate">{workspace.path}</div>
          </button>
        ))
      )}
    </div>
  );
}
