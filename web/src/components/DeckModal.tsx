import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Workspace } from '../types';
import { useModalKeyboard } from '../hooks/useModalKeyboard';

interface DeckModalProps {
  isOpen: boolean;
  workspaces: Workspace[];
  onSubmit: (name: string, workspaceId: string) => Promise<void>;
  onClose: () => void;
}

export const DeckModal = ({
  isOpen,
  workspaces,
  onSubmit,
  onClose
}: DeckModalProps) => {
  const [deckWorkspaceId, setDeckWorkspaceId] = useState(workspaces[0]?.id || '');
  const [deckNameDraft, setDeckNameDraft] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formRef = useModalKeyboard<HTMLFormElement>(isOpen, onClose);

  useEffect(() => {
    if (isOpen && workspaces.length > 0 && !deckWorkspaceId) {
      setDeckWorkspaceId(workspaces[0].id);
    }
  }, [isOpen, workspaces, deckWorkspaceId]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(deckNameDraft.trim(), deckWorkspaceId);
      setDeckNameDraft('');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-[500]" role="dialog" aria-modal="true" aria-labelledby="deck-modal-title">
      <form className="modal" ref={formRef} onSubmit={handleSubmit}>
        <div className="text-[14px] font-semibold mb-3" id="deck-modal-title">{'\u30c7\u30c3\u30ad\u4f5c\u6210'}</div>
        <label className="grid gap-1 text-xs">
          <span>{'\u30c7\u30c3\u30ad\u540d (\u4efb\u610f)'}</span>
          <input
            type="text"
            className="bg-panel border border-border rounded-[2px] px-2 py-1.5 text-[13px] font-mono text-ink focus:outline-none focus:border-focus"
            value={deckNameDraft}
            placeholder={'\u7a7a\u767d\u306e\u307e\u307e\u3067\u3082OK'}
            maxLength={100}
            onChange={(event) => setDeckNameDraft(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs mt-3">
          <span>{'\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9'}</span>
          <select
            className="bg-panel border border-border rounded-[2px] px-2 py-1.5 text-[13px] font-mono text-ink focus:outline-none focus:border-focus"
            value={deckWorkspaceId}
            onChange={(event) => setDeckWorkspaceId(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.path}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            className="bg-transparent text-ink border-0 px-2 py-1 text-xs rounded-[2px] cursor-pointer hover:bg-list-hover"
            onClick={onClose}
            disabled={isSubmitting}
          >
            {'\u30ad\u30e3\u30f3\u30bb\u30eb'}
          </button>
          <button
            type="submit"
            className="bg-accent text-white border-0 px-3.5 py-1.5 text-[13px] font-medium rounded-[2px] cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isSubmitting}
          >
            {isSubmitting ? '\u4f5c\u6210\u4e2d...' : '\u4f5c\u6210'}
          </button>
        </div>
      </form>
    </div>
  );
};
