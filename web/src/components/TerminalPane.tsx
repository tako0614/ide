import { useState, useEffect } from 'react';
import clsx from 'clsx';
import type { TerminalSession } from '../types';
import { resolveActiveTerminalId } from '../utils';
import { TerminalTile } from './TerminalTile';

interface TerminalPaneProps {
  terminals: TerminalSession[];
  wsBase: string;
  // モバイルの単一表示で前面に出す端末。null/不明な場合は先頭にフォールバック。
  activeTerminalId: string | null;
  onDeleteTerminal: (terminalId: string) => void;
  onExitTerminal: (terminalId: string) => void;
  // 端末が OSC 0/2 で設定した動的タイトルを親へ伝える（セレクタ表示用）。
  onTerminalTitle?: (terminalId: string, title: string | null) => void;
}

// ターミナル数に基づいて最適なグリッドを自動計算（デスクトップのみ）。
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
  activeTerminalId,
  onDeleteTerminal,
  onExitTerminal,
  onTerminalTitle,
}: TerminalPaneProps) {
  const { cols, rows } = getOptimalGrid(terminals.length);
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

  // モバイルでは常に1端末だけをフルサイズ表示し、他は display:none で
  // マウント維持（プロセスは走り続け、極小サイズへの resize も起きない）。
  // 切り替えは親（デッキヘッダのドロップダウン）が activeTerminalId で制御する。
  const resolvedActiveId = resolveActiveTerminalId(terminals, activeTerminalId);

  return (
    <section className="terminal-pane">
      {terminals.length === 0 ? (
        <div className="terminal-empty">
          <span className="terminal-empty-text">ターミナルを追加</span>
        </div>
      ) : (
        <div
          className={clsx('terminal-grid', isMobile && 'terminal-grid-mobile')}
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
                isMobile && (terminal.id === resolvedActiveId
                  ? 'terminal-tile-slot-mobile-active'
                  : 'terminal-tile-slot-mobile-hidden')
              )}
            >
              <TerminalTile
                session={terminal}
                wsUrl={`${wsBase}/api/terminals/${terminal.id}`}
                onDelete={() => onDeleteTerminal(terminal.id)}
                onExit={() => onExitTerminal(terminal.id)}
                onTitle={(title) => onTerminalTitle?.(terminal.id, title)}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
