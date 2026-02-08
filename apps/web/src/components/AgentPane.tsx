import type { AgentSession } from '../types';
import { AgentTile } from './AgentTile';

interface AgentPaneProps {
  sessions: AgentSession[];
  onDeleteAgent: (id: string) => void;
}

function getOptimalGrid(count: number) {
  if (count <= 1) return { cols: 1, rows: 1 };
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

export function AgentPane({ sessions, onDeleteAgent }: AgentPaneProps) {
  const { cols, rows } = getOptimalGrid(sessions.length);

  return (
    <section className="agent-pane">
      {sessions.length === 0 ? (
        <div className="agent-empty">
          <span className="terminal-empty-text">{'\u30a8\u30fc\u30b8\u30a7\u30f3\u30c8\u3092\u8ffd\u52a0'}</span>
        </div>
      ) : (
        <div
          className="agent-grid"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
          }}
        >
          {sessions.map((session) => (
            <AgentTile
              key={session.id}
              session={session}
              onDelete={() => onDeleteAgent(session.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
