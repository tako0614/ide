/**
 * X keysyms for the desktop viewer's on-screen keys and soft-keyboard input.
 * (Values from X11 keysymdef.h; noVNC sends them to the VNC server.)
 */
export const XK = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  F5: 0xffc2,
  Shift_L: 0xffe1,
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Super_L: 0xffeb,
} as const;

export type DesktopModifier = 'ctrl' | 'alt' | 'shift' | 'super';

export const MODIFIER_KEYSYM: Record<DesktopModifier, number> = {
  ctrl: XK.Control_L,
  alt: XK.Alt_L,
  shift: XK.Shift_L,
  super: XK.Super_L,
};

/**
 * Keysym for one typed character: Latin-1 maps 1:1, anything else uses the
 * generic Unicode keysym (0x01000000 + code point), which x11vnc adds to the
 * keymap on the fly.
 */
export function keysymForChar(char: string): number | null {
  const codepoint = char.codePointAt(0);
  if (codepoint === undefined) return null;
  if (char === '\n' || char === '\r') return XK.Return;
  if (char === '\t') return XK.Tab;
  if (codepoint < 0x20 || codepoint === 0x7f) return null;
  return codepoint <= 0xff ? codepoint : 0x01000000 + codepoint;
}

/** True when text can be sent reliably as key presses (ASCII); otherwise type it server-side. */
export function isKeyboardText(text: string): boolean {
  return /^[\x20-\x7e\n\t]*$/.test(text);
}

export interface KeyChord {
  modifiers: DesktopModifier[];
  keysym: number;
}

/** Press modifiers, tap the key, release modifiers in reverse order. */
export function chordEvents(chord: KeyChord): Array<{ keysym: number; down: boolean }> {
  const events: Array<{ keysym: number; down: boolean }> = [];
  for (const modifier of chord.modifiers) events.push({ keysym: MODIFIER_KEYSYM[modifier], down: true });
  events.push({ keysym: chord.keysym, down: true }, { keysym: chord.keysym, down: false });
  for (const modifier of [...chord.modifiers].reverse()) events.push({ keysym: MODIFIER_KEYSYM[modifier], down: false });
  return events;
}
