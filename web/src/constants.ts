/**
 * Application-wide constants
 */

// API configuration
export const API_BASE = import.meta.env.VITE_API_BASE || '';
export const DEFAULT_ROOT_FALLBACK = import.meta.env.VITE_DEFAULT_ROOT || '';

// UI messages
export const MESSAGE_SAVED = '保存しました。';
export const MESSAGE_WORKSPACE_FETCH_ERROR = 'ワークスペースを取得できませんでした';
export const MESSAGE_DECK_FETCH_ERROR = 'デッキを取得できませんでした';
export const MESSAGE_TERMINAL_FETCH_ERROR = 'ターミナルを取得できませんでした';
export const MESSAGE_WORKSPACE_ADD_ERROR = 'ワークスペースを追加できませんでした';
export const MESSAGE_DECK_CREATE_ERROR = 'デッキの作成に失敗しました';
export const MESSAGE_TERMINAL_START_ERROR = 'ターミナルを起動できませんでした';
export const MESSAGE_FILE_OPEN_ERROR = 'ファイルを開けませんでした';
export const MESSAGE_SAVE_ERROR = '保存に失敗しました';
export const MESSAGE_PATH_REQUIRED = 'パスを入力してください。';
export const MESSAGE_DUPLICATE_WORKSPACE = '同じパスのワークスペースは追加できません。';
export const MESSAGE_WORKSPACE_REQUIRED = 'デッキを作成する前にワークスペースを追加してください。';
export const MESSAGE_SELECT_WORKSPACE = 'ワークスペースを選択してください。';
export const MESSAGE_SELECT_DECK = 'デッキを選択してください。';

// Timing constants
export const SAVED_MESSAGE_TIMEOUT = 2000;

// Language mapping
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  ps1: 'powershell',
  py: 'python',
  go: 'go',
  rs: 'rust'
};

// Editor configuration
export const EDITOR_FONT_FAMILY = '"JetBrains Mono", monospace';
export const EDITOR_FONT_SIZE = 14;

// Terminal configuration
// CJK monospace fallbacks (Noto Sans Mono CJK JP / Source Han Mono / MS Gothic)
// を末尾の monospace の前に追加し、日本語・中国語・韓国語のグリフ崩れを防ぐ。
export const TERMINAL_FONT_FAMILY =
  '"Cascadia Code", "JetBrains Mono", "Consolas", "Menlo", "Noto Sans Mono CJK JP", "Source Han Mono", "MS Gothic", monospace';
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_BACKGROUND_COLOR = '#000000';
export const TERMINAL_FOREGROUND_COLOR = '#ffffff';

// 16-entry ANSI palette (index 0..15).  モダンでダークな配色で、
// 背景 #000000 / 前景 #ffffff の上でも読みやすいコントラストを確保する。
// 0..7  : black, red, green, yellow, blue, magenta, cyan, white
// 8..15 : brightBlack, brightRed, brightGreen, brightYellow,
//         brightBlue, brightMagenta, brightCyan, brightWhite
export const TERMINAL_ANSI_PALETTE: readonly string[] = [
  '#1e1e1e', // 0  black
  '#f44747', // 1  red
  '#23d18b', // 2  green
  '#e5c07b', // 3  yellow
  '#4aa5f0', // 4  blue
  '#c586c0', // 5  magenta
  '#29b8db', // 6  cyan
  '#d4d4d4', // 7  white
  '#666666', // 8  brightBlack
  '#ff6e6e', // 9  brightRed
  '#5ff967', // 10 brightGreen
  '#f5f543', // 11 brightYellow
  '#6ab7ff', // 12 brightBlue
  '#d670d6', // 13 brightMagenta
  '#62e8f5', // 14 brightCyan
  '#ffffff'  // 15 brightWhite
];

// カーソル色と選択範囲の背景色（テーマ palette と整合させる）。
export const TERMINAL_CURSOR_COLOR = '#ffffff';
export const TERMINAL_SELECTION_BACKGROUND = '#264f78';

// Local storage keys
export const STORAGE_KEY_THEME = 'deck-theme';
