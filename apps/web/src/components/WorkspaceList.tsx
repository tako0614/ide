import clsx from 'clsx';
import type { Workspace } from '../types';

interface WorkspaceListProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
}

const LABEL_WORKSPACE = '\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9';
const LABEL_EMPTY = '\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u304c\u3042\u308a\u307e\u305b\u3093\u3002';

export function WorkspaceList({
  workspaces,
  selectedWorkspaceId,
  onSelect
}: WorkspaceListProps) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_WORKSPACE}</div>
        </div>
      </div>
      <div className="panel-body grid gap-2 p-3">
        {workspaces.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted text-[13px] p-5">{LABEL_EMPTY}</div>
        ) : (
          workspaces.map((workspace) => (
            <div
              key={workspace.id}
              className={clsx(
                'grid gap-2 p-3 border border-border bg-panel transition-colors hover:bg-list-hover focus-within:bg-list-hover',
                workspace.id === selectedWorkspaceId && 'bg-list-active border-accent'
              )}
            >
              <button
                type="button"
                className="border-0 bg-transparent text-left p-0 cursor-pointer w-full grid gap-1"
                onClick={() => onSelect(workspace.id)}
              >
                <div className="font-semibold text-[14px]">{workspace.name}</div>
                <div className="text-xs text-muted font-mono">{workspace.path}</div>
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
