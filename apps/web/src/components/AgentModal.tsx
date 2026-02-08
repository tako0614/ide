import { useEffect, useState, type FormEvent } from 'react';
import type { AgentProvider, Workspace } from '../types';

interface AgentModalProps {
  isOpen: boolean;
  provider: AgentProvider;
  workspaces: Workspace[];
  onSubmit: (prompt: string, cwd: string, maxCostUsd: number) => void;
  onClose: () => void;
}

export function AgentModal({
  isOpen,
  provider,
  workspaces,
  onSubmit,
  onClose
}: AgentModalProps) {
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState(workspaces[0]?.path || '');
  const [maxCostUsd, setMaxCostUsd] = useState(5);

  useEffect(() => {
    if (isOpen && workspaces.length > 0 && !cwd) {
      setCwd(workspaces[0].path);
    }
  }, [isOpen, workspaces, cwd]);

  useEffect(() => {
    if (isOpen) {
      setPrompt('');
    }
  }, [isOpen]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim()) return;
    onSubmit(prompt.trim(), cwd, maxCostUsd);
    setPrompt('');
  };

  if (!isOpen) return null;

  const providerLabel = provider === 'claude' ? 'Claude' : 'Codex';

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={handleSubmit}>
        <div className="modal-title">
          {`${providerLabel} \u30a8\u30fc\u30b8\u30a7\u30f3\u30c8`}
        </div>
        <label className="field">
          <span>{'\u30d7\u30ed\u30f3\u30d7\u30c8'}</span>
          <textarea
            className="agent-prompt-input"
            value={prompt}
            placeholder={'\u30bf\u30b9\u30af\u3092\u5165\u529b...'}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
          />
        </label>
        <label className="field">
          <span>{'\u4f5c\u696d\u30c7\u30a3\u30ec\u30af\u30c8\u30ea'}</span>
          <select
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.path}>
                {workspace.path}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{'\u30b3\u30b9\u30c8\u4e0a\u9650 (USD)'}</span>
          <input
            type="number"
            min="0.1"
            max="100"
            step="0.1"
            value={maxCostUsd}
            onChange={(event) => setMaxCostUsd(Number(event.target.value))}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            {'\u30ad\u30e3\u30f3\u30bb\u30eb'}
          </button>
          <button
            type="submit"
            className={`primary-button ${provider === 'claude' ? 'agent-btn-claude' : 'agent-btn-codex'}`}
            disabled={!prompt.trim()}
          >
            {'\u958b\u59cb'}
          </button>
        </div>
      </form>
    </div>
  );
}
