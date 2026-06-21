import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import clsx from 'clsx';
import type { FileSystemEntry } from '../types';
import {
  listFiles,
  createDirectory,
  deleteFile,
  deleteDirectory,
  moveEntry,
  uploadFiles
} from '../api';

interface DriveBrowserProps {
  workspaceId: string;
  workspacePath: string;
  // Open the given file (or the folder root when omitted) in the code-server editor.
  onOpenInEditor: (filePath?: string) => void;
  onStatus?: (message: string) => void;
}

type ViewMode = 'grid' | 'list';

function parentPath(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '' : p.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function fileIcon(entry: FileSystemEntry): string {
  if (entry.type === 'dir') return '📁';
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return '🖼️';
  if (['md', 'txt', 'rst'].includes(ext)) return '📄';
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'go', 'rs', 'c', 'cpp', 'java', 'sh'].includes(ext)) return '📜';
  if (['zip', 'tar', 'gz', 'tgz'].includes(ext)) return '🗜️';
  return '📄';
}

export function DriveBrowser({ workspaceId, workspacePath, onOpenInEditor, onStatus }: DriveBrowserProps) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileSystemEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('grid');
  const [query, setQuery] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await listFiles(workspaceId, dir);
      setEntries(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list files');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const breadcrumbs = useMemo(() => {
    const segments = path ? path.split('/') : [];
    const crumbs: { label: string; path: string }[] = [{ label: '/', path: '' }];
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      crumbs.push({ label: seg, path: acc });
    }
    return crumbs;
  }, [path]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    return list;
  }, [entries, query]);

  const handleOpen = useCallback((entry: FileSystemEntry) => {
    if (entry.type === 'dir') {
      setPath(entry.path);
    } else {
      onOpenInEditor(entry.path);
    }
  }, [onOpenInEditor]);

  const handleNewFolder = useCallback(async () => {
    const name = window.prompt('新しいフォルダ名');
    if (!name) return;
    try {
      await createDirectory(workspaceId, joinPath(path, name));
      onStatus?.(`フォルダを作成しました: ${name}`);
      void load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    }
  }, [workspaceId, path, load, onStatus]);

  const handleRename = useCallback(async (entry: FileSystemEntry) => {
    const next = window.prompt('新しい名前', entry.name);
    if (!next || next === entry.name) return;
    try {
      await moveEntry(workspaceId, entry.path, joinPath(parentPath(entry.path), next));
      onStatus?.(`名前を変更しました: ${entry.name} → ${next}`);
      void load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename');
    }
  }, [workspaceId, path, load, onStatus]);

  const handleDelete = useCallback(async (entry: FileSystemEntry) => {
    if (!window.confirm(`「${entry.name}」を削除しますか？`)) return;
    try {
      if (entry.type === 'dir') {
        await deleteDirectory(workspaceId, entry.path);
      } else {
        await deleteFile(workspaceId, entry.path);
      }
      onStatus?.(`削除しました: ${entry.name}`);
      void load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }, [workspaceId, path, load, onStatus]);

  const doUpload = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    try {
      const result = await uploadFiles(workspaceId, path, files);
      onStatus?.(`${result.uploaded.length} 件アップロードしました`);
      void load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  }, [workspaceId, path, load, onStatus]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files || []);
    void doUpload(files);
  }, [doUpload]);

  return (
    <div className="drive-browser flex flex-col h-full min-h-0">
      <div className="drive-toolbar flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
        <nav className="flex items-center gap-1 text-[13px] min-w-0 overflow-hidden">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex items-center gap-1 min-w-0">
              {i > 0 && <span className="text-muted">/</span>}
              <button
                type="button"
                className="px-1 py-0.5 rounded hover:bg-list-hover text-ink-muted hover:text-ink truncate max-w-[160px]"
                onClick={() => setPath(crumb.path)}
                title={crumb.label}
              >
                {i === 0 ? (workspacePath.split('/').pop() || '/') : crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <input
            className="browser-address-input max-w-[180px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="検索"
            spellCheck={false}
          />
          <button type="button" className="topbar-btn-sm" title="表示切替" onClick={() => setView((v) => (v === 'grid' ? 'list' : 'grid'))}>
            {view === 'grid' ? '≣' : '▦'}
          </button>
          <button type="button" className="topbar-btn-sm" title="再読み込み" onClick={() => void load(path)}>⟳</button>
          <button type="button" className="topbar-btn-sm" title="新しいフォルダ" onClick={handleNewFolder}>＋</button>
          <button type="button" className="topbar-btn-sm" title="アップロード" onClick={() => uploadInputRef.current?.click()}>⤓</button>
          <button type="button" className="topbar-btn-sm topbar-btn-claude" title="VS Codeで開く" onClick={() => onOpenInEditor()}>{'</>'}</button>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void doUpload(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {error && <div className="browser-error">{error}</div>}

      <div
        className={clsx('drive-body flex-1 min-h-0 overflow-auto p-3', dragActive && 'drive-drag-active')}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false); }}
        onDrop={handleDrop}
      >
        {loading ? (
          <div className="text-muted text-[13px] p-4">読み込み中…</div>
        ) : filtered.length === 0 ? (
          <div className="text-muted text-[13px] p-4">{query ? '一致するものがありません' : 'このフォルダは空です（ファイルをドロップでアップロード）'}</div>
        ) : view === 'grid' ? (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
            {filtered.map((entry) => (
              <div
                key={entry.path}
                className="drive-card flex flex-col items-center gap-1 p-3 rounded border border-border hover:bg-list-hover cursor-pointer relative group"
                onDoubleClick={() => handleOpen(entry)}
                title={entry.name}
              >
                <div className="text-[32px] leading-none">{fileIcon(entry)}</div>
                <div className="text-[12px] text-ink text-center truncate w-full">{entry.name}</div>
                <div className="absolute top-1 right-1 hidden group-hover:flex gap-0.5">
                  <button type="button" className="drive-mini-btn" title="名前変更" onClick={(e) => { e.stopPropagation(); void handleRename(entry); }}>✎</button>
                  <button type="button" className="drive-mini-btn" title="削除" onClick={(e) => { e.stopPropagation(); void handleDelete(entry); }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((entry) => (
              <div
                key={entry.path}
                className="drive-row flex items-center gap-2 px-2 py-1.5 rounded hover:bg-list-hover cursor-pointer group"
                onDoubleClick={() => handleOpen(entry)}
              >
                <span className="text-[16px]">{fileIcon(entry)}</span>
                <span className="text-[13px] text-ink flex-1 truncate">{entry.name}</span>
                <span className="text-[11px] text-muted">{entry.type === 'dir' ? 'フォルダ' : 'ファイル'}</span>
                <span className="hidden group-hover:flex gap-1">
                  <button type="button" className="drive-mini-btn" title="名前変更" onClick={(e) => { e.stopPropagation(); void handleRename(entry); }}>✎</button>
                  <button type="button" className="drive-mini-btn" title="削除" onClick={(e) => { e.stopPropagation(); void handleDelete(entry); }}>🗑</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
