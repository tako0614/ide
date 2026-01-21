import { useState, useEffect } from 'react';
import type { TerminalSession } from '../types';
import { TerminalTile } from './TerminalTile';

interface TerminalPaneProps {
  terminals: TerminalSession[];
  wsBase: string;
  onNewTerminal: () => void;
  onNewClaudeTerminal: () => void;
  onNewCodexTerminal: () => void;
  onDeleteTerminal: (terminalId: string) => void;
}

const LABEL_TERMINAL = 'ターミナル';
const LABEL_ADD = '+';
const LABEL_CLAUDE = 'Claude';
const LABEL_CODEX = 'Codex';
const LABEL_EMPTY = 'ターミナルを追加';

const GRID_PRESETS = [
  { cols: 1, rows: 1, label: '1x1' },
  { cols: 2, rows: 1, label: '2x1' },
  { cols: 2, rows: 2, label: '2x2' },
  { cols: 3, rows: 2, label: '3x2' },
  { cols: 3, rows: 3, label: '3x3' },
];

const STORAGE_KEY = 'deck-terminal-grid';

export function TerminalPane({
  terminals,
  wsBase,
  onNewTerminal,
  onNewClaudeTerminal,
  onNewCodexTerminal,
  onDeleteTerminal
}: TerminalPaneProps) {
  const [gridConfig, setGridConfig] = useState({ cols: 2, rows: 2 });

  // Load saved grid config
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.cols && parsed.rows) {
          setGridConfig(parsed);
        }
      } catch {
        // ignore
      }
    }
  }, []);

  const handleGridChange = (cols: number, rows: number) => {
    const newConfig = { cols, rows };
    setGridConfig(newConfig);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));
  };

  const maxTerminals = gridConfig.cols * gridConfig.rows;
  const visibleTerminals = terminals.slice(0, maxTerminals);

  return (
    <section className="panel terminal-view">
      <div className="terminal-header">
        <div className="terminal-header-left">
          <span className="panel-title">{LABEL_TERMINAL}</span>
          <div className="grid-selector">
            {GRID_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={`grid-preset-btn ${
                  gridConfig.cols === preset.cols && gridConfig.rows === preset.rows ? 'active' : ''
                }`}
                onClick={() => handleGridChange(preset.cols, preset.rows)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <div className="terminal-actions">
          <button type="button" className="chip chip-primary" onClick={onNewTerminal}>
            {LABEL_ADD}
          </button>
          <button type="button" className="chip" onClick={onNewClaudeTerminal}>
            {LABEL_CLAUDE}
          </button>
          <button type="button" className="chip" onClick={onNewCodexTerminal}>
            {LABEL_CODEX}
          </button>
        </div>
      </div>
      {terminals.length === 0 ? (
        <div className="terminal-empty" onClick={onNewTerminal}>
          <span className="terminal-empty-icon">+</span>
          <span>{LABEL_EMPTY}</span>
        </div>
      ) : (
        <div
          className="terminal-grid"
          style={{
            gridTemplateColumns: `repeat(${gridConfig.cols}, 1fr)`,
            gridTemplateRows: `repeat(${gridConfig.rows}, 1fr)`,
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
        <div className="terminal-overflow-notice">
          +{terminals.length - maxTerminals} 非表示
        </div>
      )}
    </section>
  );
}
