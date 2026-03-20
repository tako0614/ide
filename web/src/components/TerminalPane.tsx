import { useState, useEffect } from 'react';
import clsx from 'clsx';
import type { TerminalSession } from '../types';
import { TerminalTile } from './TerminalTile';

interface TerminalPaneProps {
  terminals: TerminalSession[];
  wsBase: string;
  onDeleteTerminal: (terminalId: string) => void;
  onExitTerminal: (terminalId: string) => void;
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
  onExitTerminal,
}: TerminalPaneProps) {
  const { cols, rows } = getOptimalGrid(terminals.length);
  const [expandedTerminalId, setExpandedTerminalId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches
  );

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    setIsMobile(mq.matches);
    const handler = () => setIsMobile(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Reset expanded state when switching to desktop
  useEffect(() => {
    if (!isMobile) setExpandedTerminalId(null);
  }, [isMobile]);

  // Clear expanded if terminal was removed
  useEffect(() => {
    if (expandedTerminalId && !terminals.find(t => t.id === expandedTerminalId)) {
      setExpandedTerminalId(null);
    }
  }, [terminals, expandedTerminalId]);

  const mobileMode = isMobile ? (expandedTerminalId ? 'expanded' : 'preview') : null;

  return (
    <section className={clsx('terminal-pane', mobileMode === 'expanded' && 'terminal-pane-expanded')}>
      {terminals.length === 0 ? (
        <div className="terminal-empty">
          <span className="terminal-empty-text">ターミナルを追加</span>
        </div>
      ) : (
        <>
          {mobileMode === 'expanded' && (
            <button
              type="button"
              className="terminal-back-btn"
              onClick={() => setExpandedTerminalId(null)}
            >
              ← 一覧
            </button>
          )}
          <div
            className={clsx(
              'terminal-grid',
              mobileMode === 'preview' && 'terminal-grid-preview',
              mobileMode === 'expanded' && 'terminal-grid-expanded'
            )}
            style={!isMobile ? {
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            } : undefined}
          >
            {terminals.map((terminal) => (
              <div
                key={terminal.id}
                className={clsx(
                  'terminal-tile-slot',
                  mobileMode === 'preview' && 'terminal-tile-slot-preview',
                  mobileMode === 'expanded' && terminal.id === expandedTerminalId && 'terminal-tile-slot-active',
                  mobileMode === 'expanded' && terminal.id !== expandedTerminalId && 'terminal-tile-slot-hidden'
                )}
                onClick={mobileMode === 'preview' ? () => setExpandedTerminalId(terminal.id) : undefined}
              >
                <TerminalTile
                  session={terminal}
                  wsUrl={`${wsBase}/api/terminals/${terminal.id}`}
                  onDelete={() => onDeleteTerminal(terminal.id)}
                  onExit={() => onExitTerminal(terminal.id)}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
