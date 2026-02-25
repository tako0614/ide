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
    <div className="fixed inset-0 bg-bg z-50 grid grid-rows-[35px_minmax(0,1fr)]">
      <div className="flex items-center justify-between gap-3 px-3 bg-title-bar border-b border-border">
        <div>
          <div className="text-[13px] font-medium">{LABEL_DIFF_VIEWER}</div>
          {diff && <div className="text-xs text-muted font-mono">{diff.path}</div>}
        </div>
        <button
          type="button"
          className="bg-transparent text-ink border-0 px-2 py-1 text-xs rounded-[2px] cursor-pointer hover:bg-list-hover"
          onClick={onClose}
        >
          {LABEL_CLOSE}
        </button>
      </div>
      <div className="min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted text-[13px] p-5">{LABEL_LOADING}</div>
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
