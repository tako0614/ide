import type { FileTreeNode } from '../types';

const LABEL_LOADING = '\u8aad\u307f\u8fbc\u307f\u4e2d...';
const LABEL_FILES = '\u30d5\u30a1\u30a4\u30eb';
const LABEL_REFRESH = '\u66f4\u65b0';
const LABEL_EMPTY = '\u30d5\u30a1\u30a4\u30eb\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002';

const renderEntries = (
  entries: FileTreeNode[],
  depth: number,
  onToggleDir: (node: FileTreeNode) => void,
  onOpenFile: (node: FileTreeNode) => void
): JSX.Element[] =>
  entries.map((entry) => (
    <div key={entry.path}>
      <button
        type="button"
        className={`tree-row ${entry.type === 'dir' ? 'is-dir' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() =>
          entry.type === 'dir' ? onToggleDir(entry) : onOpenFile(entry)
        }
      >
        <span className="tree-icon">
          {entry.type === 'dir' ? (entry.expanded ? 'v' : '>') : '-'}
        </span>
        <span className="tree-label">{entry.name}</span>
        {entry.loading ? <span className="tree-meta">{LABEL_LOADING}</span> : null}
      </button>
      {entry.expanded && entry.children && entry.children.length > 0
        ? renderEntries(entry.children, depth + 1, onToggleDir, onOpenFile)
        : null}
    </div>
  ));

interface FileTreeProps {
  root: string;
  entries?: FileTreeNode[];
  loading?: boolean;
  error?: string | null;
  onToggleDir: (node: FileTreeNode) => void;
  onOpenFile: (node: FileTreeNode) => void;
  onRefresh: () => void;
}

export function FileTree({
  root,
  entries = [],
  loading,
  error,
  onToggleDir,
  onOpenFile,
  onRefresh
}: FileTreeProps) {
  const safeEntries = entries ?? [];
  return (
    <section className="panel file-tree">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_FILES}</div>
          <div className="panel-subtitle">{root}</div>
        </div>
        <button type="button" className="chip" onClick={onRefresh}>
          {LABEL_REFRESH}
        </button>
      </div>
      <div className="panel-body tree-body">
        {loading ? <div className="tree-state">{LABEL_LOADING}</div> : null}
        {error ? <div className="tree-state error">{error}</div> : null}
        {safeEntries.length === 0 && !loading ? (
          <div className="tree-state">{LABEL_EMPTY}</div>
        ) : null}
        {renderEntries(safeEntries, 0, onToggleDir, onOpenFile)}
      </div>
    </section>
  );
}
