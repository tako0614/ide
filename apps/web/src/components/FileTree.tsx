import type { FileTreeNode, GitFileStatus } from '../types';

const LABEL_LOADING = '\u8aad\u307f\u8fbc\u307f\u4e2d...';
const LABEL_FILES = '\u30d5\u30a1\u30a4\u30eb';
const LABEL_REFRESH = '\u66f4\u65b0';
const LABEL_EMPTY = '\u30d5\u30a1\u30a4\u30eb\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002';
const LABEL_BACK = '\u623b\u308b';

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

const renderEntries = (
  entries: FileTreeNode[],
  depth: number,
  mode: 'tree' | 'navigator',
  onToggleDir: (node: FileTreeNode) => void,
  onOpenFile: (node: FileTreeNode) => void,
  gitFiles?: GitFileStatus[]
): JSX.Element[] =>
  entries.map((entry) => {
    const gitClass = entry.type === 'file' ? getGitStatusClass(entry.path, gitFiles) : '';
    return (
      <div key={entry.path}>
        <button
          type="button"
          className={`tree-row ${
            entry.type === 'dir' ? 'is-dir' : ''
          } ${mode === 'tree' && entry.expanded ? 'is-open' : ''} ${gitClass}`}
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={() =>
            entry.type === 'dir' ? onToggleDir(entry) : onOpenFile(entry)
          }
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
        {mode === 'tree' &&
        entry.expanded &&
        entry.children &&
        entry.children.length > 0
          ? renderEntries(entry.children, depth + 1, mode, onToggleDir, onOpenFile, gitFiles)
          : null}
      </div>
    );
  });

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
  gitFiles
}: FileTreeProps) {
  console.log('[FileTree] Render:', { root, entriesCount: entries?.length, loading, error });
  const safeEntries = entries ?? [];
  return (
    <section className="panel file-tree">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_FILES}</div>
          <div className="panel-subtitle">{root}</div>
        </div>
        <div className="tree-actions">
          {onBack ? (
            <button
              type="button"
              className="chip"
              onClick={onBack}
              disabled={canBack === false}
            >
              {LABEL_BACK}
            </button>
          ) : null}
          <button type="button" className="chip" onClick={onRefresh}>
            {LABEL_REFRESH}
          </button>
        </div>
      </div>
      <div className="panel-body tree-body">
        {loading ? <div className="tree-state">{LABEL_LOADING}</div> : null}
        {error ? <div className="tree-state error">{error}</div> : null}
        {safeEntries.length === 0 && !loading ? (
          <div className="tree-state">{LABEL_EMPTY}</div>
        ) : null}
        {renderEntries(safeEntries, 0, mode, onToggleDir, onOpenFile, gitFiles)}
      </div>
    </section>
  );
}
