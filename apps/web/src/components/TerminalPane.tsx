import type { TerminalSession } from '../types';
import { TerminalTile } from './TerminalTile';

interface TerminalPaneProps {
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  wsBase: string;
  onSelectTerminal: (terminalId: string) => void;
  onNewTerminal: () => void;
}

const LABEL_TERMINAL = '\u30bf\u30fc\u30df\u30ca\u30eb';
const LABEL_MULTI = '\u30c7\u30c3\u30ad\u3054\u3068\u306b\u8907\u6570\u8d77\u52d5';
const LABEL_ADD = '\u30bf\u30fc\u30df\u30ca\u30eb\u8ffd\u52a0';
const LABEL_EMPTY = '\u30bf\u30fc\u30df\u30ca\u30eb\u3092\u8ffd\u52a0\u3057\u3066\u304f\u3060\u3055\u3044\u3002';

export function TerminalPane({
  terminals,
  activeTerminalId,
  wsBase,
  onSelectTerminal,
  onNewTerminal
}: TerminalPaneProps) {
  return (
    <section className="terminal-view">
      <div className="terminal-header">
        <div>
          <div className="panel-title">{LABEL_TERMINAL}</div>
          <div className="panel-subtitle">{LABEL_MULTI}</div>
        </div>
        <div className="terminal-actions">
          <button type="button" className="chip" onClick={onNewTerminal}>
            {LABEL_ADD}
          </button>
        </div>
      </div>
      {terminals.length === 0 ? (
        <div className="empty-state">{LABEL_EMPTY}</div>
      ) : (
        <div className="terminal-grid">
          {terminals.map((terminal) => (
            <TerminalTile
              key={terminal.id}
              session={terminal}
              wsUrl={`${wsBase}/api/terminals/${terminal.id}`}
              isActive={terminal.id === activeTerminalId}
              onFocus={() => onSelectTerminal(terminal.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
