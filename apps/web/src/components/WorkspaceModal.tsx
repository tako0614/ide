import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { FileTree } from './FileTree';
import type { FileTreeNode } from '../types';
import { previewFiles } from '../api';
import { getErrorMessage, getParentPath, joinPath, toTreeNodes } from '../utils';
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
  const [previewTree, setPreviewTree] = useState<FileTreeNode[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formRef = useModalKeyboard<HTMLFormElement>(isOpen, onClose);

  const previewRoot = workspacePathDraft.trim() || defaultRoot;
  const canPreviewBack = useMemo(() => {
    if (!previewRoot) return false;
    return getParentPath(previewRoot) !== previewRoot;
  }, [previewRoot]);

  useEffect(() => {
    if (!isOpen) {
      setPreviewTree([]);
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    setPreviewError(null);
    previewFiles(previewRoot, '')
      .then((entries) => {
        if (!alive) return;
        setPreviewTree(toTreeNodes(entries));
        setPreviewLoading(false);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setPreviewError(getErrorMessage(error));
        setPreviewLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isOpen, previewRoot]);

  useEffect(() => {
    if (!isOpen) return;
    if (workspacePathDraft.trim()) return;
    if (defaultRoot) {
      setWorkspacePathDraft(defaultRoot);
    }
  }, [defaultRoot, isOpen, workspacePathDraft]);

  const handlePreviewRefresh = () => {
    if (!isOpen) return;
    setPreviewLoading(true);
    setPreviewError(null);
    previewFiles(previewRoot, '')
      .then((entries) => {
        setPreviewTree(toTreeNodes(entries));
        setPreviewLoading(false);
      })
      .catch((error: unknown) => {
        setPreviewError(getErrorMessage(error));
        setPreviewLoading(false);
      });
  };

  const handlePreviewToggleDir = (node: FileTreeNode) => {
    if (node.type !== 'dir') return;
    const nextPath = joinPath(previewRoot, node.name);
    setWorkspacePathDraft(nextPath);
  };

  const handlePreviewBack = () => {
    if (!previewRoot) return;
    const parent = getParentPath(previewRoot);
    if (parent && parent !== previewRoot) {
      setWorkspacePathDraft(parent);
    }
  };

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
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title">
      <form className="modal" ref={formRef} onSubmit={handleSubmit}>
        <div className="modal-title" id="workspace-modal-title">
          {'\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u8ffd\u52a0'}
        </div>
        <label className="field">
          <span>{'\u30d1\u30b9'}</span>
          <input
            type="text"
            value={workspacePathDraft}
            placeholder={defaultRoot || ''}
            required
            maxLength={500}
            onChange={(event) => setWorkspacePathDraft(event.target.value)}
          />
        </label>
        <div className="modal-explorer">
          <FileTree
            root={previewRoot}
            entries={previewTree}
            loading={previewLoading}
            error={previewError}
            mode="navigator"
            canBack={canPreviewBack}
            onBack={handlePreviewBack}
            onToggleDir={handlePreviewToggleDir}
            onOpenFile={() => undefined}
            onRefresh={handlePreviewRefresh}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={isSubmitting}>
            {'\u30ad\u30e3\u30f3\u30bb\u30eb'}
          </button>
          <button type="submit" className="primary-button" disabled={isSubmitting}>
            {isSubmitting ? '\u8ffd\u52a0\u4e2d...' : '\u8ffd\u52a0'}
          </button>
        </div>
      </form>
    </div>
  );
};
