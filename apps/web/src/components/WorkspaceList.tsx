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
    <section className="panel workspace-panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_WORKSPACE}</div>
        </div>
      </div>
      <div className="panel-body">
        {workspaces.length === 0 ? (
          <div className="empty-state">{LABEL_EMPTY}</div>
        ) : (
          workspaces.map((workspace) => (
            <div
              key={workspace.id}
              className={clsx('workspace-item', workspace.id === selectedWorkspaceId && 'is-active')}
            >
              <button
                type="button"
                className="workspace-main"
                onClick={() => onSelect(workspace.id)}
              >
                <div className="workspace-name">{workspace.name}</div>
                <div className="workspace-path">{workspace.path}</div>
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
