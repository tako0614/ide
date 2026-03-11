import { useState, useCallback, useRef, useEffect } from 'react';
import clsx from 'clsx';
import type { FileTreeNode, GitFileStatus } from '../types';
import { FileTreeContextMenu } from './FileTreeContextMenu';
import type { ContextMenu } from './FileTreeContextMenu';

const LABEL_LOADING = '読み込み中...';
const LABEL_FILES = 'ファイル';
const LABEL_REFRESH = '更新';
const LABEL_EMPTY = 'ファイルが見つかりません。';
const LABEL_BACK = '戻る';

function getGitStatusClass(
  path: string,
  gitFiles: GitFileStatus[] | undefined
): string {
  if (!gitFiles) return '';
  const file = gitFiles.find((f) => f.path === path || path.endsWith(f.path));
  if (!file) return '';
  return `git-tree-${file.status}`;
}

const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="tree-chevron-icon">
    <path
      d="M9 6l6 6-6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="tree-svg">
    <path
      d="M3.5 7.5h6l2 2h9a1 1 0 0 1 1 1V18a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7.5z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

const FileIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="tree-svg">
    <path
      d="M6 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path
      d="M14 3.5V8h4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

interface NewItemInput {
  parentPath: string;
  type: 'file' | 'dir';
  depth: number;
}

interface FileTreeProps {
  root: string;
  entries?: FileTreeNode[];
  loading?: boolean;
  error?: string | null;
  mode?: 'tree' | 'navigator';
  canBack?: boolean;
  onBack?: () => void;
  onToggleDir: (node: FileTreeNode) => void;
  onOpenFile: (node: FileTreeNode) => void;
  onRefresh: () => void;
  onCreateFile?: (parentPath: string, fileName: string) => void;
  onCreateDirectory?: (parentPath: string, dirName: string) => void;
  onDeleteFile?: (filePath: string) => void;
  onDeleteDirectory?: (dirPath: string) => void;
  gitFiles?: GitFileStatus[];
}

export function FileTree({
  root,
  entries = [],
  loading,
  error,
  mode = 'tree',
  canBack,
  onBack,
  onToggleDir,
  onOpenFile,
  onRefresh,
  onCreateFile,
  onCreateDirectory,
  onDeleteFile,
  onDeleteDirectory,
  gitFiles
}: FileTreeProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [newItemInput, setNewItemInput] = useState<NewItemInput | null>(null);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const safeEntries = entries ?? [];

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [contextMenu]);

  // Focus input when showing new item input
  useEffect(() => {
    if (newItemInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [newItemInput]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileTreeNode | null, isRoot = false) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 180, MENU_H = 150;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 4);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 4);
    setContextMenu({ x, y, node, isRoot });
  }, []);

  const handleNewFile = useCallback((parentPath: string, depth: number) => {
    setContextMenu(null);
    setNewItemInput({ parentPath, type: 'file', depth });
    setInputValue('');
  }, []);

  const handleNewFolder = useCallback((parentPath: string, depth: number) => {
    setContextMenu(null);
    setNewItemInput({ parentPath, type: 'dir', depth });
    setInputValue('');
  }, []);

  const handleDelete = useCallback((node: FileTreeNode) => {
    setContextMenu(null);
    if (node.type === 'dir') {
      if (window.confirm(`フォルダ "${node.name}" を削除しますか？\n中のファイルも全て削除されます。`)) {
        onDeleteDirectory?.(node.path);
      }
    } else {
      if (window.confirm(`ファイル "${node.name}" を削除しますか？`)) {
        onDeleteFile?.(node.path);
      }
    }
  }, [onDeleteFile, onDeleteDirectory]);

  const handleInputSubmit = useCallback(() => {
    if (!newItemInput || !inputValue.trim()) {
      setNewItemInput(null);
      return;
    }
    const name = inputValue.trim();
    if (newItemInput.type === 'file') {
      onCreateFile?.(newItemInput.parentPath, name);
    } else {
      onCreateDirectory?.(newItemInput.parentPath, name);
    }
    setNewItemInput(null);
    setInputValue('');
  }, [newItemInput, inputValue, onCreateFile, onCreateDirectory]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleInputSubmit();
    } else if (e.key === 'Escape') {
      setNewItemInput(null);
    }
  }, [handleInputSubmit]);

  const renderNewItemInput = (depth: number) => {
    if (!newItemInput || newItemInput.depth !== depth) return null;
    return (
      <div
        className="tree-row tree-input-row"
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <span className="tree-icon" aria-hidden="true">
          {newItemInput.type === 'dir' ? <FolderIcon /> : <FileIcon />}
        </span>
        <input
          ref={inputRef}
          type="text"
          className="tree-input"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputSubmit}
          placeholder={newItemInput.type === 'dir' ? 'フォルダ名' : 'ファイル名'}
        />
      </div>
    );
  };

  const renderEntries = (
    nodeEntries: FileTreeNode[],
    depth: number
  ): JSX.Element[] =>
    nodeEntries.map((entry) => {
      const gitClass = entry.type === 'file' ? getGitStatusClass(entry.path, gitFiles) : '';
      return (
        <div key={entry.path}>
          <button
            type="button"
            className={clsx('tree-row', entry.type === 'dir' && 'is-dir', mode === 'tree' && entry.expanded && 'is-open', gitClass)}
            style={{ paddingLeft: 12 + depth * 16 }}
            onClick={() =>
              entry.type === 'dir' ? onToggleDir(entry) : onOpenFile(entry)
            }
            onContextMenu={(e) => handleContextMenu(e, entry)}
            aria-expanded={
              entry.type === 'dir' && mode === 'tree' ? entry.expanded : undefined
            }
            title={entry.path}
          >
            <span className="tree-chevron" aria-hidden="true">
              {entry.type === 'dir' ? <ChevronIcon /> : null}
            </span>
            <span className={`tree-icon ${entry.type}`} aria-hidden="true">
              {entry.type === 'dir' ? <FolderIcon /> : <FileIcon />}
            </span>
            <span className="tree-label">{entry.name}</span>
            {entry.loading ? <span className="tree-meta">{LABEL_LOADING}</span> : null}
          </button>
          {mode === 'tree' && entry.expanded && entry.type === 'dir' && (
            <>
              {newItemInput?.parentPath === entry.path && renderNewItemInput(depth + 1)}
              {entry.children && entry.children.length > 0 && renderEntries(entry.children, depth + 1)}
            </>
          )}
        </div>
      );
    });

  return (
    <section className="panel file-tree" ref={treeRef}>
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_FILES}</div>
          <div className="panel-subtitle">{root}</div>
        </div>
        <div className="tree-actions">
          {onBack ? (
            <button
              type="button"
              className="border border-border bg-transparent text-ink px-2.5 py-1 text-xs rounded-[2px] cursor-pointer hover:bg-list-hover disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={onBack}
              disabled={canBack === false}
            >
              {LABEL_BACK}
            </button>
          ) : null}
          <button
            type="button"
            className="border border-border bg-transparent text-ink px-2.5 py-1 text-xs rounded-[2px] cursor-pointer hover:bg-list-hover disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onRefresh}
          >
            {LABEL_REFRESH}
          </button>
        </div>
      </div>
      <div
        className="panel-body tree-body"
        onContextMenu={(e) => handleContextMenu(e, null, true)}
      >
        {loading ? <div className="tree-state">{LABEL_LOADING}</div> : null}
        {error ? <div className="tree-state text-[#f14c4c]">{error}</div> : null}
        {safeEntries.length === 0 && !loading ? (
          <div className="tree-state">{LABEL_EMPTY}</div>
        ) : null}
        {newItemInput?.parentPath === '' && renderNewItemInput(0)}
        {renderEntries(safeEntries, 0)}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <FileTreeContextMenu
          contextMenu={contextMenu}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onDelete={handleDelete}
        />
      )}
    </section>
  );
}
