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
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="deck-modal-title">
      <form className="modal" ref={formRef} onSubmit={handleSubmit}>
        <div className="modal-title" id="deck-modal-title">{'\u30c7\u30c3\u30ad\u4f5c\u6210'}</div>
        <label className="field">
          <span>{'\u30c7\u30c3\u30ad\u540d (\u4efb\u610f)'}</span>
          <input
            type="text"
            value={deckNameDraft}
            placeholder={'\u7a7a\u767d\u306e\u307e\u307e\u3067\u3082OK'}
            maxLength={100}
            onChange={(event) => setDeckNameDraft(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{'\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9'}</span>
          <select
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
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={isSubmitting}>
            {'\u30ad\u30e3\u30f3\u30bb\u30eb'}
          </button>
          <button type="submit" className="primary-button" disabled={isSubmitting}>
            {isSubmitting ? '\u4f5c\u6210\u4e2d...' : '\u4f5c\u6210'}
          </button>
        </div>
      </form>
    </div>
  );
};
