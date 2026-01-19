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
const LABEL_MULTI = 'デッキごとに複数起動';
const LABEL_ADD = 'ターミナル追加';
const LABEL_CLAUDE = 'Claude';
const LABEL_CODEX = 'Codex';
const LABEL_EMPTY = 'ターミナルを追加してください。';

export function TerminalPane({
  terminals,
  wsBase,
  onNewTerminal,
  onNewClaudeTerminal,
  onNewCodexTerminal,
  onDeleteTerminal
}: TerminalPaneProps) {
  return (
    <section className="panel terminal-view">
      <div className="terminal-header">
        <div>
          <div className="panel-title">{LABEL_TERMINAL}</div>
          <div className="panel-subtitle">{LABEL_MULTI}</div>
        </div>
        <div className="terminal-actions">
          <button type="button" className="chip" onClick={onNewTerminal}>
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
        <div className="empty-state">{LABEL_EMPTY}</div>
      ) : (
        <div className={`terminal-grid terminal-count-${Math.min(terminals.length, 4)}`}>
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
