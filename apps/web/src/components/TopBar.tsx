import type { Workspace } from '../types';

type AppView = 'workspace' | 'terminal';

interface TopBarProps {
  view: AppView;
  workspace?: Workspace | null;
  apiBase?: string;
  status?: string;
}

const LABEL_PROJECT = '\u30d7\u30ed\u30b8\u30a7\u30af\u30c8';
const LABEL_TERMINAL = '\u30bf\u30fc\u30df\u30ca\u30eb';

export function TopBar({ view, workspace, apiBase, status }: TopBarProps) {
  return (
    <header className="topbar">
      <div>
        <div className="brand">Deck IDE</div>
        <div className="deck-meta">
          <span>{view === 'workspace' ? LABEL_PROJECT : LABEL_TERMINAL}</span>
          {workspace ? (
            <>
              <span className="deck-root">{workspace.name}</span>
              <span className="deck-root">{workspace.path}</span>
            </>
          ) : null}
          {apiBase ? <span className="api-base">{apiBase}</span> : null}
        </div>
      </div>
      <div className="topbar-actions">
        {status ? <div className="status-pill">{status}</div> : null}
      </div>
    </header>
  );
}
