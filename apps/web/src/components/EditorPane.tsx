import { useEffect, useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { EditorFile } from '../types';
import { EDITOR_FONT_FAMILY, EDITOR_FONT_SIZE } from '../constants';

interface EditorPaneProps {
  files: EditorFile[];
  activeFileId: string | null;
  onSelectFile: (fileId: string) => void;
  onCloseFile: (fileId: string) => void;
  onChangeFile: (fileId: string, contents: string) => void;
  onSaveFile?: (fileId: string) => void;
  savingFileId: string | null;
  theme: 'light' | 'dark';
}

const LABEL_EMPTY = 'ファイルを選択してください';
const MONACO_THEME_DARK = 'vs-dark';
const MONACO_THEME_LIGHT = 'vs';

// File extension to icon mapping
function getFileIcon(filename: string): { icon: string; color: string } {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const iconMap: Record<string, { icon: string; color: string }> = {
    ts: { icon: 'TS', color: '#3178c6' },
    tsx: { icon: 'TSX', color: '#3178c6' },
    js: { icon: 'JS', color: '#f7df1e' },
    jsx: { icon: 'JSX', color: '#61dafb' },
    json: { icon: '{ }', color: '#cbcb41' },
    html: { icon: '<>', color: '#e34c26' },
    css: { icon: '#', color: '#264de4' },
    scss: { icon: 'S', color: '#cc6699' },
    md: { icon: 'M↓', color: '#083fa1' },
    py: { icon: 'PY', color: '#3776ab' },
    go: { icon: 'GO', color: '#00add8' },
    rs: { icon: 'RS', color: '#dea584' },
    java: { icon: 'J', color: '#b07219' },
    sql: { icon: 'SQL', color: '#e38c00' },
    yml: { icon: 'Y', color: '#cb171e' },
    yaml: { icon: 'Y', color: '#cb171e' },
    sh: { icon: '$', color: '#89e051' },
    bash: { icon: '$', color: '#89e051' },
    txt: { icon: 'TXT', color: '#6a737d' },
  };
  return iconMap[ext] || { icon: '📄', color: 'var(--ink-muted)' };
}

// Get language display name
function getLanguageDisplay(language: string): string {
  const langMap: Record<string, string> = {
    typescript: 'TypeScript',
    typescriptreact: 'TypeScript React',
    javascript: 'JavaScript',
    javascriptreact: 'JavaScript React',
    json: 'JSON',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    markdown: 'Markdown',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    sql: 'SQL',
    yaml: 'YAML',
    shell: 'Shell',
    plaintext: 'Plain Text',
  };
  return langMap[language] || language;
}

export function EditorPane({
  files,
  activeFileId,
  onSelectFile,
  onCloseFile,
  onChangeFile,
  onSaveFile,
  savingFileId,
  theme
}: EditorPaneProps) {
  const activeFile = files.find((file) => file.id === activeFileId);
  const editorRef = useRef<ReturnType<OnMount> | null>(null);
  const cursorPositionRef = useRef({ line: 1, column: 1 });

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.onDidChangeCursorPosition((e) => {
      cursorPositionRef.current = {
        line: e.position.lineNumber,
        column: e.position.column
      };
    });
  }, []);

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

  const handleCloseTab = (e: React.MouseEvent, fileId: string) => {
    e.stopPropagation();
    onCloseFile(fileId);
  };

  const handleTabMiddleClick = (e: React.MouseEvent, fileId: string) => {
    if (e.button === 1) {
      e.preventDefault();
      onCloseFile(fileId);
    }
  };

  if (files.length === 0) {
    return (
      <div className="editor-container editor-empty">
        <div className="editor-welcome">
          <div className="editor-welcome-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points="13 2 13 9 20 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="editor-welcome-text">{LABEL_EMPTY}</div>
          <div className="editor-welcome-hint">
            左のファイルツリーからファイルを選択
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-container">
      {/* Tab Bar */}
      <div className="editor-tabs">
        <div className="editor-tabs-list">
          {files.map((file) => {
            const { icon, color } = getFileIcon(file.name);
            const isActive = file.id === activeFileId;
            const isSaving = savingFileId === file.id;
            return (
              <div
                key={file.id}
                className={`editor-tab ${isActive ? 'active' : ''} ${file.dirty ? 'dirty' : ''}`}
                onClick={() => onSelectFile(file.id)}
                onMouseDown={(e) => handleTabMiddleClick(e, file.id)}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
              >
                <span className="editor-tab-icon" style={{ color }}>
                  {icon}
                </span>
                <span className="editor-tab-name">
                  {file.name}
                </span>
                {file.dirty && !isSaving && (
                  <span className="editor-tab-dirty" aria-label="未保存">●</span>
                )}
                {isSaving && (
                  <span className="editor-tab-saving" aria-label="保存中">
                    <svg viewBox="0 0 24 24" className="spin">
                      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="30 70" />
                    </svg>
                  </span>
                )}
                <button
                  type="button"
                  className="editor-tab-close"
                  onClick={(e) => handleCloseTab(e, file.id)}
                  aria-label="閉じる"
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Breadcrumb */}
      {activeFile && (
        <div className="editor-breadcrumb">
          <span className="editor-breadcrumb-path">{activeFile.path}</span>
        </div>
      )}

      {/* Editor Area */}
      <div className="editor-content">
        {activeFile ? (
          <Editor
            height="100%"
            theme={theme === 'dark' ? MONACO_THEME_DARK : MONACO_THEME_LIGHT}
            language={activeFile.language}
            value={activeFile.contents}
            onChange={(value) => onChangeFile(activeFile.id, value ?? '')}
            onMount={handleEditorMount}
            options={{
              fontFamily: EDITOR_FONT_FAMILY,
              fontSize: EDITOR_FONT_SIZE,
              fontLigatures: true,
              minimap: { enabled: true, scale: 1, showSlider: 'mouseover' },
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              renderLineHighlight: 'all',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 8, bottom: 8 },
              lineNumbers: 'on',
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
              guides: {
                bracketPairs: true,
                indentation: true
              }
            }}
          />
        ) : (
          <div className="editor-no-file">
            <span>{LABEL_EMPTY}</span>
          </div>
        )}
      </div>

      {/* Status Bar */}
      {activeFile && (
        <div className="editor-statusbar">
          <div className="editor-statusbar-left">
            <span className="editor-status-item">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 3v12M18 9a3 3 0 110 6 3 3 0 010-6zM6 21a3 3 0 110-6 3 3 0 010 6z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M18 12c0 3-3 4-6 4s-6-1-6-4" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              main
            </span>
          </div>
          <div className="editor-statusbar-right">
            <span className="editor-status-item">
              Ln {cursorPositionRef.current.line}, Col {cursorPositionRef.current.column}
            </span>
            <span className="editor-status-item">UTF-8</span>
            <span className="editor-status-item">
              {getLanguageDisplay(activeFile.language)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
