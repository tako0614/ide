import { useEffect, useRef } from 'react';
import type { AgentSession } from '../types';

interface AgentTileProps {
  session: AgentSession;
  onDelete: () => void;
}

export function AgentTile({ session, onDelete }: AgentTileProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages.length]);

  return (
    <div className="agent-tile">
      <div className="agent-tile-header">
        <span className={`agent-provider-badge ${session.provider}`}>
          {session.provider === 'claude' ? 'C' : 'X'}
        </span>
        <span className="agent-tile-prompt">{session.prompt}</span>
        <span className={`agent-status-dot ${session.status}`} />
        {session.totalCostUsd != null && (
          <span className="agent-cost">${session.totalCostUsd.toFixed(4)}</span>
        )}
        <button
          type="button"
          className="terminal-close-btn"
          onClick={onDelete}
          aria-label={session.status === 'running' ? '\u4e2d\u65ad' : '\u524a\u9664'}
        >
          {session.status === 'running' ? '\u25a0' : '\u00d7'}
        </button>
      </div>
      <div className="agent-tile-body">
        {session.messages.map((msg) => (
          <div key={msg.id} className={`agent-msg agent-msg-${msg.role}`}>
            {msg.role === 'tool' && msg.toolName && (
              <span className="agent-tool-name">{msg.toolName}</span>
            )}
            <pre className="agent-msg-text">{msg.content}</pre>
          </div>
        ))}
        {session.error && (
          <div className="agent-msg agent-msg-error">
            <pre className="agent-msg-text">{session.error}</pre>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
