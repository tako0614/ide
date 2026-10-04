export interface ImageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface DisplayedFrame {
  hash: string;
  epoch: number;
  size: ScreenSize;
  rect: ImageRect;
}

export function sameDisplayedFrame(before: DisplayedFrame, after: DisplayedFrame): boolean {
  if (!before.hash || before.hash !== after.hash || before.epoch !== after.epoch ||
    before.size.width !== after.size.width || before.size.height !== after.size.height) return false;
  return (['left', 'top', 'width', 'height'] as const).every((key) =>
    Number.isFinite(before.rect[key]) && Number.isFinite(after.rect[key]) && Math.abs(before.rect[key] - after.rect[key]) <= 0.5);
}

export type ComputerAction = Record<string, unknown>;
export type QueuedComputerAction = {
  action: ComputerAction;
  anchor?: { observationId: string; hash: string };
};
export type ComputerObservation = { observationId: string; hash: string };

export interface GuiControlState { mode: 'shared' | 'human' | 'agent'; mine: boolean; expiresAt?: number }

/** VNC tickets are scoped to this route and one desktop generation. */
export function computerVncSocketUrl(apiBase: string, pageOrigin: string, token: string, epoch: number): string {
  if (!token || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid VNC connection ticket');
  const base = new URL(apiBase || '/', pageOrigin);
  if (base.origin !== pageOrigin) throw new Error('VNC connection must use the current origin');
  const url = new URL(`${base.pathname.replace(/\/$/, '')}/api/computer/vnc/ws`, pageOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('epoch', String(epoch));
  return url.href;
}

export function needsHumanClaim(control: GuiControlState | undefined, now: number): boolean {
  return !control?.mine || control.mode !== 'human' || (control.expiresAt !== undefined && control.expiresAt <= now + 1000);
}

export function shouldReleaseHumanControl(control: GuiControlState | undefined, idleMs: number, activeWork: boolean, paneFocused: boolean, limitMs = 12_000): boolean {
  return !!control?.mine && control.mode === 'human' && !activeWork && (!paneFocused || idleMs >= limitMs);
}

/** A claim invalidates the old observation. Callers may use input only after
 * the claim and its fresh, decoded frame have both completed. */
export async function ensureFreshHumanControl(
  control: GuiControlState | undefined,
  now: number,
  claim: () => Promise<boolean>,
  capture: () => Promise<boolean>,
  ready: () => boolean,
): Promise<boolean> {
  if (needsHumanClaim(control, now)) {
    if (!await claim()) return false;
  } else if (!ready() && !await capture()) return false;
  return ready();
}

/** Preparing a stopped desktop requires a lease, but cannot require a frame
 * until the desktop exists. Other service actions need a fresh frame too. */
export async function ensureServiceControl(
  action: 'prepare' | 'stop' | 'launch' | 'focus' | 'close',
  control: () => GuiControlState | undefined,
  claim: () => Promise<boolean>,
  capture: (() => Promise<boolean>) | null,
  frameReady: () => boolean,
  now: () => number = Date.now,
): Promise<boolean> {
  if (needsHumanClaim(control(), now()) && !await claim()) return false;
  if (needsHumanClaim(control(), now())) return false;
  if (action !== 'prepare' && !frameReady() && (!capture || !await capture())) return false;
  return action === 'prepare' || frameReady();
}

export function queueComputerAction(queue: QueuedComputerAction[], item: QueuedComputerAction, limit = 32): boolean {
  if (queue.length >= limit) return false;
  queue.push(item);
  return true;
}

/** One scheduler for capture, status, inventory and mutations. A rejected job does not poison later jobs. */
export function createComputerScheduler() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** Keep a release in the same transport order as an issued claim, while
 * allowing the release request itself to outlive the pane. */
export function createComputerReleaseScheduler(
  schedule: <T>(job: () => Promise<T>) => Promise<T>,
  send: () => Promise<void>,
) {
  let pending: Promise<void> | null = null;
  return (): Promise<void> => {
    if (pending) return pending;
    const result = schedule(send);
    pending = result;
    void result.then(
      () => { if (pending === result) pending = null; },
      () => { if (pending === result) pending = null; },
    );
    return result;
  };
}

/** Input transport consumes an observation once. Semantic input can follow our own recapture;
 * pointer input is valid only for the exact displayed observation. */
export async function drainComputerActions(
  queue: QueuedComputerAction[],
  getObservation: () => ComputerObservation | null,
  send: (observationId: string, actions: ComputerAction[]) => Promise<boolean>,
  recapture: () => Promise<boolean>,
  onStalePointer: () => void,
  onChange: () => void,
  beforeBatch?: () => Promise<boolean>,
): Promise<'drained' | 'needs-frame' | 'ambiguous' | 'stopped'> {
  while (queue.length) {
    let observation = getObservation();
    if (!observation) {
      if (!await recapture()) return 'needs-frame';
      observation = getObservation();
      if (!observation) return 'needs-frame';
    }
    const first = queue[0];
    if (first.anchor && (first.anchor.observationId !== observation.observationId || first.anchor.hash !== observation.hash)) {
      queue.shift(); onChange(); onStalePointer(); continue;
    }
    if (beforeBatch) {
      let allowed = false;
      try { allowed = await beforeBatch(); } catch { /* A lost lease must stop input. */ }
      if (!allowed) { queue.length = 0; onChange(); return 'stopped'; }
    }
    const batch: ComputerAction[] = [];
    while (queue.length && batch.length < 32) {
      const item = queue[0];
      if (item.anchor && (item.anchor.observationId !== observation.observationId || item.anchor.hash !== observation.hash)) break;
      if (batch.length && item.anchor) break;
      batch.push(queue.shift()!.action);
    }
    onChange();
    let sent = false;
    try { sent = await send(observation.observationId, batch); } catch { /* Unknown outcome: never replay. */ }
    if (!sent) {
      queue.length = 0; onChange();
      return 'ambiguous';
    }
    if (!await recapture() && queue.length) return 'needs-frame';
  }
  return 'drained';
}

export function fittedImageRect(container: ImageRect, image: ScreenSize): ImageRect {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return { left: container.left, top: container.top, width: 0, height: 0 };
  }
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    left: container.left + (container.width - width) / 2,
    top: container.top + (container.height - height) / 2,
    width,
    height
  };
}

export function mapScreenPoint(rect: ImageRect, size: ScreenSize, clientX: number, clientY: number): ScreenPoint | null {
  if (!rect.width || !rect.height || clientX < rect.left || clientY < rect.top || clientX > rect.left + rect.width || clientY > rect.top + rect.height) return null;
  return {
    x: Math.max(0, Math.min(size.width - 1, Math.floor((clientX - rect.left) / rect.width * size.width))),
    y: Math.max(0, Math.min(size.height - 1, Math.floor((clientY - rect.top) / rect.height * size.height)))
  };
}

const NAMED_KEYS = new Set([
  'Enter', 'Escape', 'Backspace', 'Delete', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'Insert', 'PageUp', 'PageDown', 'Space', ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)
]);
const SIMPLE_KEYS = new Set("-,./\\;'`[]=".split(''));

export function computerKey(key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}): string | null {
  if (modifiers.meta) return null;
  const normalized = key === ' ' ? 'Space' : key === 'Esc' ? 'Escape' : key;
  if (!NAMED_KEYS.has(normalized) && !/^[a-zA-Z0-9]$/.test(normalized) && !SIMPLE_KEYS.has(normalized)) return null;
  const prefix = [modifiers.ctrl && 'Ctrl', modifiers.alt && 'Alt', modifiers.shift && 'Shift'].filter(Boolean).join('+');
  return prefix ? `${prefix}+${[...normalized].length === 1 ? normalized.toUpperCase() : normalized}` : normalized;
}

const CODE_KEY: Record<string, string> = {
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', BracketLeft: '[', BracketRight: ']'
};

export function computerKeyboardAction(
  key: string,
  code: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean },
  composing = false,
): ComputerAction | null {
  if (composing || modifiers.meta) return null;
  if (!modifiers.ctrl && !modifiers.alt && /^[\x20-\x7e]$/.test(key)) return { action: 'type', text: key };
  let base = key;
  if (modifiers.ctrl || modifiers.alt) {
    base = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5) : CODE_KEY[code] ?? key;
  }
  const mapped = computerKey(base, modifiers);
  return mapped ? { action: 'key', key: mapped } : null;
}
