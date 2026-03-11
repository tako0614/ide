import type { TerminalSession } from '../types';
import { TerminalTile } from './TerminalTile';

interface TerminalPaneProps {
  terminals: TerminalSession[];
  wsBase: string;
  onDeleteTerminal: (terminalId: string) => void;
}

// ターミナル数に基づいて最適なグリッドを自動計算
function getOptimalGrid(count: number) {
  if (count <= 1) return { cols: 1, rows: 1 };

  // 正方形に近い形を目指す
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  return { cols, rows };
}

export function TerminalPane({
  terminals,
  wsBase,
  onDeleteTerminal,
}: TerminalPaneProps) {
  const { cols, rows } = getOptimalGrid(terminals.length);

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
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {terminals.map((terminal) => (
            <TerminalTile
              key={terminal.id}
              session={terminal}
              wsUrl={`${wsBase}/api/terminals/${terminal.id}`}
              onDelete={() => onDeleteTerminal(terminal.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
