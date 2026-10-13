import { useRef, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import {
  encodeTerminalKey,
  getStickyModifiers,
  getTerminalInput,
  setStickyModifier,
  subscribeStickyModifiers,
  type StickyModifiers,
  type TerminalKey,
} from './terminalInput';

type KeyBarItem =
  | { label: string; title: string; key: TerminalKey }
  | { label: string; title: string; text: string }
  | { label: string; title: string; modifier: keyof StickyModifiers }
  | { label: string; title: string; action: 'paste' | 'keyboard' };

// Keys a phone's soft keyboard lacks but TUIs (Claude Code, vim, less, fzf…) need.
const ITEMS: KeyBarItem[] = [
  { label: 'Esc', title: 'Escape', key: 'escape' },
  { label: 'Tab', title: 'Tab', key: 'tab' },
  { label: 'Ctrl', title: 'Ctrl（次に押すキーに適用）', modifier: 'ctrl' },
  { label: 'Alt', title: 'Alt（次に押すキーに適用）', modifier: 'alt' },
  { label: '←', title: '左', key: 'left' },
  { label: '↑', title: '上', key: 'up' },
  { label: '↓', title: '下', key: 'down' },
  { label: '→', title: '右', key: 'right' },
  { label: '^C', title: 'Ctrl+C（中断）', text: '\x03' },
  { label: '⇧Tab', title: 'Shift+Tab', key: 'backtab' },
  { label: '⏎', title: 'Enter', key: 'enter' },
  { label: 'Home', title: 'Home', key: 'home' },
  { label: 'End', title: 'End', key: 'end' },
  { label: 'PgUp', title: 'Page Up', key: 'pageup' },
  { label: 'PgDn', title: 'Page Down', key: 'pagedown' },
  { label: '|', title: '|', text: '|' },
  { label: '~', title: '~', text: '~' },
  { label: '/', title: '/', text: '/' },
  { label: '-', title: '-', text: '-' },
  { label: '貼付', title: 'クリップボードから貼り付け', action: 'paste' },
  { label: '⌨', title: 'キーボードの表示/非表示', action: 'keyboard' },
];

async function readClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch {
    // Permission denied or not a secure context (plain http on a LAN IP).
  }
  return window.prompt('貼り付けるテキスト') ?? null;
}

interface TerminalKeyBarProps {
  /** Terminal the keys go to (the deck's active terminal). */
  terminalId: string | null;
}

/**
 * On-screen key row for touch devices (shown via CSS on coarse pointers).
 * Buttons never take focus, so the soft keyboard stays up while using them.
 */
export function TerminalKeyBar({ terminalId }: TerminalKeyBarProps) {
  const modifiers = useSyncExternalStore(subscribeStickyModifiers, getStickyModifiers);
  const hadFocusRef = useRef(false);

  const run = async (item: KeyBarItem) => {
    const target = getTerminalInput(terminalId);
    if (!target) return;
    if ('modifier' in item) {
      setStickyModifier(item.modifier, !modifiers[item.modifier]);
      return;
    }
    if ('key' in item) {
      target.input(encodeTerminalKey(item.key, target.applicationCursorKeys()));
    } else if ('text' in item) {
      target.input(item.text);
    } else if (item.action === 'paste') {
      const text = await readClipboard();
      if (text) target.paste(text);
    } else if (item.action === 'keyboard') {
      if (target.hasFocus()) {
        (document.activeElement as HTMLElement | null)?.blur();
      } else {
        target.focus();
      }
      return;
    }
    // Keep the soft keyboard up if it was up before the tap.
    if (hadFocusRef.current && !target.hasFocus()) target.focus();
  };

  return (
    <div className="terminal-keybar" role="toolbar" aria-label="特殊キー">
      {ITEMS.map((item) => {
        const active = 'modifier' in item && modifiers[item.modifier];
        return (
          <button
            key={item.label}
            type="button"
            tabIndex={-1}
            className={clsx('terminal-keybar-key', active && 'is-latched')}
            title={item.title}
            aria-label={item.title}
            aria-pressed={'modifier' in item ? active : undefined}
            disabled={!terminalId}
            // Do not steal focus from the terminal (that would close the keyboard).
            onPointerDown={(event) => {
              hadFocusRef.current = Boolean(getTerminalInput(terminalId)?.hasFocus());
              event.preventDefault();
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { void run(item); }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
