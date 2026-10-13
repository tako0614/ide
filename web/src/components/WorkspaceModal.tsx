import { useEffect, useState, type FormEvent } from 'react';
import { useModalKeyboard } from '../hooks/useModalKeyboard';

interface WorkspaceModalProps {
  isOpen: boolean;
  defaultRoot: string;
  onSubmit: (path: string) => Promise<void>;
  onClose: () => void;
}

export const WorkspaceModal = ({
  isOpen,
  defaultRoot,
  onSubmit,
  onClose
}: WorkspaceModalProps) => {
  const [workspacePathDraft, setWorkspacePathDraft] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formRef = useModalKeyboard<HTMLFormElement>(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    if (workspacePathDraft.trim()) return;
    if (defaultRoot) {
      setWorkspacePathDraft(defaultRoot);
    }
  }, [defaultRoot, isOpen, workspacePathDraft]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(workspacePathDraft);
      setWorkspacePathDraft('');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-[500]" role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title">
      <form className="modal flex flex-col" ref={formRef} onSubmit={handleSubmit}>
        <div className="text-[14px] font-semibold mb-3 shrink-0" id="workspace-modal-title">
          {'\u4f5c\u696d\u30c7\u30a3\u30ec\u30af\u30c8\u30ea\u767b\u9332'}
        </div>
        <label className="grid gap-1 text-xs shrink-0">
          <span>{'\u30d1\u30b9'}</span>
          <input
            type="text"
            className="bg-panel border border-border rounded-[2px] px-2 py-1.5 text-[13px] font-mono text-ink focus:outline-none focus:border-focus"
            value={workspacePathDraft}
            placeholder={defaultRoot || ''}
            required
            maxLength={500}
            onChange={(event) => setWorkspacePathDraft(event.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2 mt-4 shrink-0">
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
            {isSubmitting ? '\u8ffd\u52a0\u4e2d...' : '\u8ffd\u52a0'}
          </button>
        </div>
      </form>
    </div>
  );
};
