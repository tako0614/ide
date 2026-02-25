import { DiffEditor } from '@monaco-editor/react';
import type { GitDiff } from '../types';
import { EDITOR_FONT_FAMILY, EDITOR_FONT_SIZE } from '../constants';
import { getLanguageFromPath } from '../utils';

const LABEL_DIFF_VIEWER = '差分ビューア';
const LABEL_LOADING = '読み込み中...';
const LABEL_CLOSE = '閉じる';
const MONACO_THEME_DARK = 'vs-dark';
const MONACO_THEME_LIGHT = 'vs';

interface DiffViewerProps {
  diff: GitDiff | null;
  loading: boolean;
  theme: 'light' | 'dark';
  onClose: () => void;
}

export function DiffViewer({ diff, loading, theme, onClose }: DiffViewerProps) {
  const language = diff ? getLanguageFromPath(diff.path) : 'plaintext';

  return (
    <div className="diff-viewer-overlay">
      <div className="diff-viewer-header">
        <div>
          <div className="diff-viewer-title">{LABEL_DIFF_VIEWER}</div>
          {diff && <div className="diff-viewer-path">{diff.path}</div>}
        </div>
        <button type="button" className="ghost-button" onClick={onClose}>
          {LABEL_CLOSE}
        </button>
      </div>
      <div className="diff-viewer-body">
        {loading ? (
          <div className="empty-state">{LABEL_LOADING}</div>
        ) : diff ? (
          <DiffEditor
            height="100%"
            theme={theme === 'dark' ? MONACO_THEME_DARK : MONACO_THEME_LIGHT}
            language={language}
            original={diff.original}
            modified={diff.modified}
            options={{
              fontFamily: EDITOR_FONT_FAMILY,
              fontSize: EDITOR_FONT_SIZE,
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              smoothScrolling: true
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
