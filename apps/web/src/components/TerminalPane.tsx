import type { TerminalSession } from '../types';
import { TerminalTile } from './TerminalTile';

interface TerminalPaneProps {
  terminals: TerminalSession[];
  wsBase: string;
  onDeleteTerminal: (terminalId: string) => void;
  gridCols: number;
  gridRows: number;
}

// 実際のターミナル数に基づいて最適なグリッドを計算
function getOptimalGrid(count: number, maxCols: number, maxRows: number) {
  if (count <= 1) return { cols: 1, rows: 1 };

  // 横優先で最小グリッドを計算
  const cols = Math.min(count, maxCols);
  const rows = Math.min(Math.ceil(count / cols), maxRows);

  return { cols, rows };
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

  // 設定の範囲内で、実際のターミナル数に最適化されたグリッド
  const { cols: optCols, rows: optRows } = getOptimalGrid(
    visibleTerminals.length,
    gridCols,
    gridRows
  );

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
            gridTemplateColumns: `repeat(${optCols}, 1fr)`,
            gridTemplateRows: `repeat(${optRows}, 1fr)`,
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
