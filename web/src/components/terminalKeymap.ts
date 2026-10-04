import type { Terminal } from '@xterm/xterm';

// ブラウザがデフォルトで奪うが、シェル/TUI に渡したい Ctrl コンビ
// （Ctrl+W 単語削除, Ctrl+R 逆検索 など）。Shift 無し・非 Mac 限定。
const FORCED_CTRL_KEYS = new Set(['w', 't', 'n', 'r', 's', 'p', 'j']);

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

/**
 * キーボードインターセプトとクリップボード（コピー/ペースト）を設定する。
 * keydown ごとに呼ばれ、true を返すと xterm がそのキーを処理して PTY へ送る。
 * false を返すと xterm は無視する（ブラウザ標準動作 or 自前処理）。
 * ブラウザが奪うコンビネーションを PTY に流したい場合は preventDefault() してから true を返す。
 *
 * @param isCancelled effect がクリーンアップ済みかを返す（非同期ペースト後の二重実行防止）。
 */
export function attachTerminalKeymap(term: Terminal, isCancelled: () => boolean): void {
  const copySelectionToClipboard = (): boolean => {
    // 選択がある場合のみコピー。選択が無ければ何もしない（false を返す）。
    if (!term.hasSelection()) return false;
    try {
      const clipboard = navigator?.clipboard;
      if (clipboard && typeof clipboard.writeText === 'function') {
        clipboard.writeText(term.getSelection()).catch(() => undefined);
        return true;
      }
    } catch {
      // feature-detect 失敗時は黙ってフォールバック
    }
    return false;
  };

  const pasteFromClipboard = (): boolean => {
    try {
      const clipboard = navigator?.clipboard;
      if (clipboard && typeof clipboard.readText === 'function') {
        clipboard
          .readText()
          .then((text) => {
            if (!isCancelled() && text) {
              // term.paste() は bracketed-paste モードを尊重する。
              term.paste(text);
            }
          })
          .catch(() => undefined);
        return true;
      }
    } catch {
      // feature-detect 失敗時は黙ってフォールバック
    }
    return false;
  };

  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    // keydown 以外（keyup/keypress）は xterm の通常処理に任せる。
    if (event.type !== 'keydown') return true;

    // IME 変換中はいかなる介入もしない（変換確定キーを壊さない）。
    if (event.isComposing || event.keyCode === 229) {
      return true;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    // --- クリップボード（コピー） ---
    // Ctrl+Shift+C / Ctrl+Insert / Cmd+C（選択がある時のみ）
    const isCopyCombo =
      (event.ctrlKey && event.shiftKey && key === 'c') ||
      (event.ctrlKey && !event.shiftKey && event.key === 'Insert') ||
      (IS_MAC && event.metaKey && !event.ctrlKey && key === 'c');
    if (isCopyCombo && term.hasSelection()) {
      if (copySelectionToClipboard()) {
        event.preventDefault();
        return false;
      }
    }

    // --- クリップボード（ペースト） ---
    // Ctrl+Shift+V / Shift+Insert / Cmd+V
    const isPasteCombo =
      (event.ctrlKey && event.shiftKey && key === 'v') ||
      (event.shiftKey && !event.ctrlKey && event.key === 'Insert') ||
      (IS_MAC && event.metaKey && !event.ctrlKey && key === 'v');
    if (isPasteCombo) {
      if (pasteFromClipboard()) {
        event.preventDefault();
        return false;
      }
    }

    // ブラウザのズーム（Ctrl/Cmd + +/-/0）は奪わない。
    if (
      (event.ctrlKey || event.metaKey) &&
      (event.key === '+' ||
        event.key === '-' ||
        event.key === '=' ||
        event.key === '0')
    ) {
      return true;
    }

    // ブラウザが奪うが PTY に渡したい Ctrl コンビ（非 Mac・Shift 無し）。
    // 注意: 素の Ctrl+C は SIGINT として常に PTY へ送る（コピー扱いしない）。
    if (
      !IS_MAC &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      FORCED_CTRL_KEYS.has(key)
    ) {
      event.preventDefault();
      return true;
    }

    // デフォルト: xterm に処理させる（PTY へ送る）。
    return true;
  });
}
