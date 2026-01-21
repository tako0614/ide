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

const STORAGE_KEY = 'deck-terminal-grid';
const MIN_COLS = 1;
const MAX_COLS = 6;
const MIN_ROWS = 1;
const MAX_ROWS = 6;

export function TerminalPane({
  terminals,
  wsBase,
  onNewTerminal,
  onNewClaudeTerminal,
  onNewCodexTerminal,
  onDeleteTerminal
}: TerminalPaneProps) {
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(2);

  // Load saved grid config
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.cols >= MIN_COLS && parsed.cols <= MAX_COLS) {
          setCols(parsed.cols);
        }
        if (parsed.rows >= MIN_ROWS && parsed.rows <= MAX_ROWS) {
          setRows(parsed.rows);
        }
      } catch {
        // ignore
      }
    }
  }, []);

  const saveConfig = (newCols: number, newRows: number) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cols: newCols, rows: newRows }));
  };

  const adjustCols = (delta: number) => {
    const newCols = Math.max(MIN_COLS, Math.min(MAX_COLS, cols + delta));
    setCols(newCols);
    saveConfig(newCols, rows);
  };

  const adjustRows = (delta: number) => {
    const newRows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows + delta));
    setRows(newRows);
    saveConfig(cols, newRows);
  };

  const maxTerminals = cols * rows;
  const visibleTerminals = terminals.slice(0, maxTerminals);

  return (
    <section className="panel terminal-view">
      <div className="terminal-header">
        <div className="terminal-header-left">
          <span className="panel-title">{LABEL_TERMINAL}</span>
          <div className="grid-control">
            <div className="grid-adjuster">
              <button
                type="button"
                className="grid-btn"
                onClick={() => adjustCols(-1)}
                disabled={cols <= MIN_COLS}
              >
                −
              </button>
              <span className="grid-value">{cols}</span>
              <button
                type="button"
                className="grid-btn"
                onClick={() => adjustCols(1)}
                disabled={cols >= MAX_COLS}
              >
                +
              </button>
            </div>
            <span className="grid-separator">×</span>
            <div className="grid-adjuster">
              <button
                type="button"
                className="grid-btn"
                onClick={() => adjustRows(-1)}
                disabled={rows <= MIN_ROWS}
              >
                −
              </button>
              <span className="grid-value">{rows}</span>
              <button
                type="button"
                className="grid-btn"
                onClick={() => adjustRows(1)}
                disabled={rows >= MAX_ROWS}
              >
                +
              </button>
            </div>
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
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`,
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
