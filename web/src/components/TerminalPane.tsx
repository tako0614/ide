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
  // デスクトップでも単一端末を最大表示する（モバイルと同じ単一ビュー）。
  singleView?: boolean;
  // クリック/フォーカスした端末をアクティブにする（activeTerminalId を同期）。
  onSetActiveTerminal?: (terminalId: string) => void;
  // 単一表示（最大化）のオン/オフを切り替える。
  onToggleMaximize?: () => void;
  // 端末が0個のときの空状態ボタンから新規ターミナルを作成する。
  onNewTerminal?: () => void;
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
  singleView,
  onSetActiveTerminal,
  onToggleMaximize,
  onNewTerminal,
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

  // モバイル、または明示的な最大化トグル時は1端末だけをフルサイズ表示する。
  const single = isMobile || Boolean(singleView);

  // モバイルでは常に1端末だけをフルサイズ表示し、他は display:none で
  // マウント維持（プロセスは走り続け、極小サイズへの resize も起きない）。
  // 切り替えは親（デッキヘッダのドロップダウン）が activeTerminalId で制御する。
  const resolvedActiveId = resolveActiveTerminalId(terminals, activeTerminalId);

  // 最大化ボタンはデスクトップで端末が2つ以上ある時だけ各タイルに出す。
  // （モバイルは元から単一表示、1端末なら最大化の意味がない）
  const canMaximize = !isMobile && terminals.length > 1 && Boolean(onToggleMaximize);

  // タイルの最大化ボタン: グリッド表示中はその端末をアクティブにしてから最大化、
  // 最大化表示中は元のグリッドへ戻す。
  const handleTileMaximize = (terminalId: string) => {
    if (!singleView) {
      onSetActiveTerminal?.(terminalId);
    }
    onToggleMaximize?.();
  };

  return (
    <section className="terminal-pane">
      {terminals.length === 0 ? (
        <div className="terminal-empty">
          {onNewTerminal ? (
            <button type="button" className="terminal-empty-btn" onClick={onNewTerminal}>
              ＋ ターミナルを開く
            </button>
          ) : (
            <span className="terminal-empty-text">ターミナルを追加</span>
          )}
        </div>
      ) : (
        <div
          className={clsx('terminal-grid', single && 'terminal-grid-single')}
          style={!single ? {
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          } : undefined}
        >
          {terminals.map((terminal) => (
            <div
              key={terminal.id}
              className={clsx(
                'terminal-tile-slot',
                single && (terminal.id === resolvedActiveId
                  ? 'terminal-tile-slot-single-active'
                  : 'terminal-tile-slot-single-hidden')
              )}
            >
              <TerminalTile
                session={terminal}
                wsUrl={`${wsBase}/api/terminals/${terminal.id}`}
                isActive={terminal.id === resolvedActiveId}
                onSetActive={onSetActiveTerminal ? () => onSetActiveTerminal(terminal.id) : undefined}
                onToggleMaximize={canMaximize ? () => handleTileMaximize(terminal.id) : undefined}
                maximized={Boolean(singleView)}
                autoFocus={(single || terminals.length === 1) && terminal.id === resolvedActiveId}
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
