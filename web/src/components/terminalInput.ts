/**
 * Input plumbing shared by terminal tiles and the on-screen key bar.
 *
 * Soft keyboards have no Esc/Tab/Ctrl/arrow keys, which TUIs depend on. The
 * key bar sends those through the tile that owns the terminal (so cursor-key
 * mode and the primary-client claim are honoured), and latches Ctrl/Alt so
 * the next character typed on the soft keyboard is modified.
 */

export type TerminalKey =
  | 'escape' | 'tab' | 'backtab' | 'enter'
  | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'pageup' | 'pagedown';

export interface TerminalInputTarget {
  /** Send bytes as if typed (goes through the tile's normal input path). */
  input: (data: string) => void;
  /** Whether the program enabled application cursor keys (DECCKM). */
  applicationCursorKeys: () => boolean;
  /** Paste text honouring bracketed-paste mode. */
  paste: (text: string) => void;
  /** Focus the terminal (opens the soft keyboard on touch devices). */
  focus: () => void;
  /** True while the terminal's textarea has focus (soft keyboard is up). */
  hasFocus: () => boolean;
}

const targets = new Map<string, TerminalInputTarget>();

export function registerTerminalInput(id: string, target: TerminalInputTarget): () => void {
  targets.set(id, target);
  return () => {
    if (targets.get(id) === target) targets.delete(id);
  };
}

export function getTerminalInput(id: string | null | undefined): TerminalInputTarget | undefined {
  return id ? targets.get(id) : undefined;
}

// ── Sticky modifiers ────────────────────────────────────────────────

export interface StickyModifiers {
  ctrl: boolean;
  alt: boolean;
}

let modifiers: StickyModifiers = { ctrl: false, alt: false };
const listeners = new Set<() => void>();

export function getStickyModifiers(): StickyModifiers {
  return modifiers;
}

export function setStickyModifier(name: keyof StickyModifiers, value: boolean): void {
  if (modifiers[name] === value) return;
  modifiers = { ...modifiers, [name]: value };
  listeners.forEach((listener) => listener());
}

export function subscribeStickyModifiers(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function clearStickyModifiers(): void {
  if (!modifiers.ctrl && !modifiers.alt) return;
  modifiers = { ctrl: false, alt: false };
  listeners.forEach((listener) => listener());
}

/** Control byte for Ctrl+<char>, or null when the combination has none. */
function controlCharacter(char: string): string | null {
  if (char === ' ' || char === '@' || char === '2') return '\x00';
  if (char === '?' || char === '8') return '\x7f';
  const code = char.toUpperCase().charCodeAt(0);
  // Ctrl+A..Z and Ctrl+[ \ ] ^ _ map to 0x01..0x1f.
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  if (char === '3') return '\x1b';
  if (char === '4') return '\x1c';
  if (char === '5') return '\x1d';
  if (char === '6') return '\x1e';
  if (char === '7') return '\x1f';
  return null;
}

/**
 * Apply latched Ctrl/Alt to typed input. Only a single typed character is
 * modified (a paste or an escape sequence passes through untouched); the
 * latch is released after it is used.
 */
export function applyStickyModifiers(data: string): string {
  if (!modifiers.ctrl && !modifiers.alt) return data;
  const chars = Array.from(data);
  if (chars.length !== 1 || data.startsWith('\x1b')) return data;
  let out = data;
  if (modifiers.ctrl) {
    out = controlCharacter(data) ?? data;
  }
  if (modifiers.alt) {
    out = '\x1b' + out;
  }
  clearStickyModifiers();
  return out;
}

const CURSOR_FINALS: Partial<Record<TerminalKey, string>> = {
  up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F',
};

/** Encode a named key, applying (and releasing) latched modifiers. */
export function encodeTerminalKey(key: TerminalKey, applicationCursorKeys: boolean): string {
  const { ctrl, alt } = modifiers;
  // xterm modifier parameter: 1 + (shift 1) + (alt 2) + (ctrl 4).
  const modifierParam = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  let sequence: string;
  const final = CURSOR_FINALS[key];
  if (final) {
    if (modifierParam > 1) sequence = `\x1b[1;${modifierParam}${final}`;
    else sequence = applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
  } else if (key === 'pageup' || key === 'pagedown') {
    const code = key === 'pageup' ? 5 : 6;
    sequence = modifierParam > 1 ? `\x1b[${code};${modifierParam}~` : `\x1b[${code}~`;
  } else if (key === 'escape') {
    sequence = alt ? '\x1b\x1b' : '\x1b';
  } else if (key === 'tab') {
    sequence = alt ? '\x1b\t' : '\t';
  } else if (key === 'backtab') {
    sequence = '\x1b[Z';
  } else {
    sequence = alt ? '\x1b\r' : '\r';
  }
  clearStickyModifiers();
  return sequence;
}
