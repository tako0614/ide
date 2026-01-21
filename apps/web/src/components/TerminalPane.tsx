import type { TerminalSession } from '../types';
import { TerminalTile } from './TerminalTile';

interface TerminalPaneProps {
  terminals: TerminalSession[];
  wsBase: string;
  onDeleteTerminal: (terminalId: string) => void;
  gridCols: number;
  gridRows: number;
}

export function TerminalPane({
  terminals,
  wsBase,
  onDeleteTerminal,
  gridCols,
  gridRows
}: TerminalPaneProps) {
  const maxTerminals = gridCols * gridRows;
  const visibleTerminals = terminals.slice(0, maxTerminals);

  return (
    <section className="terminal-pane">
      {terminals.length === 0 ? (
        <div className="terminal-empty">
          <span className="terminal-empty-text">ターミナルを追加</span>
        </div>
      ) : (
        <div
          className="terminal-grid"
          style={{
            gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
            gridTemplateRows: `repeat(${gridRows}, 1fr)`,
          }}
        >
          {visibleTerminals.map((terminal) => (
            <TerminalTile
              key={terminal.id}
              session={terminal}
              wsUrl={`${wsBase}/api/terminals/${terminal.id}`}
              onDelete={() => onDeleteTerminal(terminal.id)}
            />
          ))}
        </div>
      )}
      {terminals.length > maxTerminals && (
        <div className="terminal-overflow-badge">
          +{terminals.length - maxTerminals}
        </div>
      )}
    </section>
  );
}
