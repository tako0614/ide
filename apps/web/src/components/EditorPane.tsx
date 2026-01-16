import { useEffect } from 'react';
import Editor from '@monaco-editor/react';
import type { EditorFile } from '../types';

interface EditorPaneProps {
  files: EditorFile[];
  activeFileId: string | null;
  onSelectFile: (fileId: string) => void;
  onChangeFile: (fileId: string, contents: string) => void;
  onSaveFile?: (fileId: string) => void;
  savingFileId: string | null;
}

const LABEL_EDITOR = '\u30a8\u30c7\u30a3\u30bf';
const LABEL_SAVING = '\u4fdd\u5b58\u4e2d...';
const LABEL_SAVE = '\u4fdd\u5b58';
const LABEL_EMPTY = '\u30d5\u30a1\u30a4\u30eb\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002';

export function EditorPane({
  files,
  activeFileId,
  onSelectFile,
  onChangeFile,
  onSaveFile,
  savingFileId
}: EditorPaneProps) {
  const activeFile = files.find((file) => file.id === activeFileId);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeFile) return;
      const isSave =
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 's';
      if (!isSave) return;
      event.preventDefault();
      onSaveFile?.(activeFile.id);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFile, onSaveFile]);

  return (
    <section className="panel editor-pane">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_EDITOR}</div>
          <div className="panel-subtitle">Monaco Editor</div>
        </div>
        <div className="editor-actions">
          <button
            type="button"
            className="chip"
            onClick={() => activeFile && onSaveFile?.(activeFile.id)}
            disabled={!activeFile || savingFileId === activeFile.id}
          >
            {savingFileId === activeFile?.id ? LABEL_SAVING : LABEL_SAVE}
          </button>
          <div className="tab-strip">
            {files.map((file) => (
              <button
                key={file.id}
                type="button"
                className={`tab ${file.id === activeFileId ? 'is-active' : ''}`}
                onClick={() => onSelectFile(file.id)}
              >
                {file.name}
                {file.dirty ? ' *' : ''}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="panel-body editor-body">
        {activeFile ? (
          <Editor
            height="100%"
            theme="vs-dark"
            language={activeFile.language}
            value={activeFile.contents}
            onChange={(value) => onChangeFile(activeFile.id, value ?? '')}
            options={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 14,
              minimap: { enabled: false },
              smoothScrolling: true
            }}
          />
        ) : (
          <div className="empty-state">{LABEL_EMPTY}</div>
        )}
      </div>
    </section>
  );
}
