/**
 * Application-wide constants
 */

// API configuration
export const API_BASE = import.meta.env?.VITE_API_BASE || '';
export const DEFAULT_ROOT_FALLBACK = import.meta.env?.VITE_DEFAULT_ROOT || '';

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
// Match Vibe's local system terminal font stack, followed by CJK monospace
// fallbacks to preserve Japanese glyph quality.
export const TERMINAL_FONT_FAMILY =
  '"SFMono-Regular", Consolas, "Liberation Mono", "Noto Sans Mono CJK JP", "Source Han Mono", "MS Gothic", monospace';
export const TERMINAL_FONT_SIZE = 14;
export const TERMINAL_BACKGROUND_COLOR = '#181818';
export const TERMINAL_FOREGROUND_COLOR = '#e5e5e5';

// xterm 6.0.0's default 16 ANSI colors (index 0..15).
// 0..7  : black, red, green, yellow, blue, magenta, cyan, white
// 8..15 : brightBlack, brightRed, brightGreen, brightYellow,
//         brightBlue, brightMagenta, brightCyan, brightWhite
export const TERMINAL_ANSI_PALETTE: readonly string[] = [
  '#2e3436', // 0  black
  '#cc0000', // 1  red
  '#4e9a06', // 2  green
  '#c4a000', // 3  yellow
  '#3465a4', // 4  blue
  '#75507b', // 5  magenta
  '#06989a', // 6  cyan
  '#d3d7cf', // 7  white
  '#555753', // 8  brightBlack
  '#ef2929', // 9  brightRed
  '#8ae234', // 10 brightGreen
  '#fce94f', // 11 brightYellow
  '#729fcf', // 12 brightBlue
  '#ad7fa8', // 13 brightMagenta
  '#34e2e2', // 14 brightCyan
  '#eeeeec'  // 15 brightWhite
];

// Match Vibe's terminal cursor and selection colors.
export const TERMINAL_CURSOR_COLOR = '#fafafa';
export const TERMINAL_SELECTION_BACKGROUND = '#454545';

// Local storage keys
export const STORAGE_KEY_THEME = 'deck-theme';
