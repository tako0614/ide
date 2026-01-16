import { useState, type FormEvent } from 'react';
import type { Workspace } from '../types';

interface WorkspaceListProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  defaultPath: string;
  onSelect: (workspaceId: string) => void;
  onCreate: (path: string) => void;
}

const LABEL_PROJECT = '\u30d7\u30ed\u30b8\u30a7\u30af\u30c8';
const LABEL_PATH = '\u30d1\u30b9';
const LABEL_ADD = '\u8ffd\u52a0';
const LABEL_EMPTY = '\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u304c\u3042\u308a\u307e\u305b\u3093\u3002';

export function WorkspaceList({
  workspaces,
  activeWorkspaceId,
  defaultPath,
  onSelect,
  onCreate
}: WorkspaceListProps) {
  const [path, setPath] = useState('');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedPath = path.trim() || defaultPath;
    onCreate(trimmedPath);
    setPath('');
  };

  return (
    <section className="panel workspace-panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_PROJECT}</div>
        </div>
      </div>
      <form className="workspace-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>{LABEL_PATH}</span>
          <input
            type="text"
            value={path}
            placeholder={defaultPath}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <button type="submit" className="chip">
          {LABEL_ADD}
        </button>
      </form>
      <div className="panel-body">
        {workspaces.length === 0 ? (
          <div className="empty-state">{LABEL_EMPTY}</div>
        ) : (
          workspaces.map((workspace) => (
            <div
              key={workspace.id}
              className={`workspace-item ${
                workspace.id === activeWorkspaceId ? 'is-active' : ''
              }`}
            >
              <button
                type="button"
                className="workspace-main"
                onClick={() => onSelect(workspace.id)}
              >
                <div className="workspace-path">{workspace.path}</div>
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
