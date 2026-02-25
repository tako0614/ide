import type { GitLogEntry } from '../../hooks/useGitState';

const LABEL_LOADING = '読み込み中...';

interface HistoryTabProps {
  logs: GitLogEntry[];
  logsLoading: boolean;
}

export function HistoryTab({ logs, logsLoading }: HistoryTabProps) {
  return (
    <div className="history-section">
      {logsLoading ? (
        <div className="empty-state">{LABEL_LOADING}</div>
      ) : logs.length === 0 ? (
        <div className="empty-state">コミット履歴がありません</div>
      ) : (
        <div className="log-list">
          {logs.map((log) => (
            <div key={log.hash} className="log-item">
              <div className="log-header">
                <span className="log-hash">{log.hashShort}</span>
                <span className="log-author">{log.author}</span>
              </div>
              <div className="log-message">{log.message}</div>
              <div className="log-date">{new Date(log.date).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
