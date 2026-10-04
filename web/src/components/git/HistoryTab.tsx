import type { GitLogEntry } from '../../hooks/useGitState';

const LABEL_LOADING = '読み込み中...';

interface HistoryTabProps {
  logs: GitLogEntry[];
  logsLoading: boolean;
}

export function HistoryTab({ logs, logsLoading }: HistoryTabProps) {
  return (
    <div className="flex flex-col">
      {logsLoading ? (
        <div className="flex items-center justify-center h-full text-muted text-[13px] p-5">{LABEL_LOADING}</div>
      ) : logs.length === 0 ? (
        <div className="flex items-center justify-center h-full text-muted text-[13px] p-5">コミット履歴がありません</div>
      ) : (
        <div className="flex flex-col">
          {logs.map((log) => (
            <div key={log.hash} className="flex flex-col gap-0.5 px-3 py-2 border-b border-border hover:bg-list-hover transition-colors">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-accent font-semibold">{log.hashShort}</span>
                <span className="text-xs text-ink-muted">{log.author}</span>
              </div>
              <div className="text-[13px] text-ink overflow-hidden text-ellipsis whitespace-nowrap">{log.message}</div>
              <div className="text-[11px] text-muted">{new Date(log.date).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
