import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHttpError } from '../utils/error.js';

const NATIVE_WIDTH = 1280;
const NATIVE_HEIGHT = 720;
const IMAGE_WIDTH = 960;
const IMAGE_HEIGHT = 540;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const OBSERVATION_MS = 30_000;
const MAX_OBSERVATIONS = 64;

type Action = 'click' | 'type' | 'key' | 'scroll' | 'drag';
export type DesktopInput = {
  observationId: string;
  action: Action;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  steps?: number;
};
export type DesktopStatus = {
  supported: boolean;
  running: boolean;
  width: number;
  height: number;
  message?: string;
};
type Observation = { actor: string; createdAt: number; epoch: number; revision: number };
type OwnedChild = {
  process: ChildProcess;
  start: string | null;
  witnesses: Map<number, string>;
  epoch: number;
  role: 'desktop' | 'app';
};
type Runtime = {
  dir: string; display: string; authority: string; env: NodeJS.ProcessEnv; xvfb: ChildProcess | null;
  /** Real display size; screenshots are scaled to IMAGE_WIDTH×IMAGE_HEIGHT. */
  native: { width: number; height: number };
};

/**
 * A display owned by someone else (the shared Deck IDE desktop). In shared
 * mode the computer tools observe and drive that display instead of a private
 * Xvfb: preparing attaches, stopping only ends the apps these tools launched.
 */
export interface SharedDisplaySource {
  ensure(): Promise<{ display: string; xauthority: string | null }>;
  on(event: 'exit', listener: () => void): unknown;
}

async function executable(name: string): Promise<string | null> {
  const candidates = path.isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)
      .filter((part) => path.isAbsolute(part)).map((part) => path.join(part, name));
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

function safeEnvironment(dir: string, display?: string, authority?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    LANG: process.env.LANG ?? 'C.UTF-8',
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: os.tmpdir(),
    XDG_SESSION_TYPE: 'x11',
    GDK_BACKEND: 'x11',
    QT_QPA_PLATFORM: 'xcb',
  };
  if (display) env.DISPLAY = display;
  if (authority) env.XAUTHORITY = authority;
  return env;
}

function processInfo(pid: number): { group: number; start: string } | null {
  try {
    // Linux /proc stat fields 5 and 22 are pgrp and process start tick.
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(') ') + 2).split(' ');
    const group = Number(fields[2]);
    const start = fields[19];
    return Number.isInteger(group) && start ? { group, start } : null;
  } catch { return null; }
}

function groupWitnesses(group: number): Map<number, string> {
  const witnesses = new Map<number, string>();
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const info = processInfo(pid);
      if (info?.group === group) witnesses.set(pid, info.start);
    }
  } catch { /* procfs unavailable */ }
  return witnesses;
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv,
  options: { input?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<Buffer> {
  const max = options.maxBytes ?? 64 * 1024;
  const proc = spawn(command, args, {
    env,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  let length = 0;
  let tooLarge = false;
  const collect = (chunk: Buffer) => {
    length += chunk.length;
    if (length > max) { tooLarge = true; proc.kill('SIGKILL'); return; }
    chunks.push(chunk);
  };
  proc.stdout?.on('data', collect);
  // Read and discard stderr; no user content, Xauthority or command line is
  // reflected into HTTP responses or logs.
  proc.stderr?.resume();
  proc.stdin?.on('error', () => { /* child exited before consuming input */ });
  if (options.input !== undefined) proc.stdin?.end(options.input);
  const timer = setTimeout(() => proc.kill('SIGKILL'), options.timeoutMs ?? 5_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', resolve);
    });
    if (tooLarge || length > max || code !== 0) throw new Error('Desktop command failed');
    return Buffer.concat(chunks, length);
  } finally { clearTimeout(timer); }
}

function buttonPoint(value: number | undefined, upper: number, native: number): number {
  if (!Number.isInteger(value) || value! < 0 || value! >= upper)
    throw createHttpError('Coordinates are outside the captured display', 400);
  return Math.min(native - 1, Math.floor((value! + 0.5) * native / upper));
}

const namedKeys: Record<string, string> = {
  enter: 'Return', return: 'Return', escape: 'Escape', esc: 'Escape',
  tab: 'Tab', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert',
  space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
  minus: 'minus', plus: 'plus', equal: 'equal', comma: 'comma',
  period: 'period', slash: 'slash', backslash: 'backslash',
  semicolon: 'semicolon', apostrophe: 'apostrophe', grave: 'grave',
  bracketleft: 'bracketleft', bracketright: 'bracketright',
};
const modifiers: Record<string, string> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift',
  meta: 'Super_L', super: 'Super_L', cmd: 'Super_L',
};
function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < 1 || key.length > 64)
    throw createHttpError('Invalid key', 400);
  const parts = key.split('+').map((part) => part.trim().toLowerCase());
  if (parts.length > 5 || parts.some((part) => !part)) throw createHttpError('Invalid key', 400);
  const base = parts.pop()!;
  const seen = new Set<string>();
  const mapped = parts.map((part) => {
    const modifier = modifiers[part];
    if (!modifier || seen.has(modifier)) throw createHttpError('Invalid key', 400);
    seen.add(modifier);
    return modifier;
  });
  const f = /^f([1-9]|1[0-2])$/.exec(base);
  const mappedBase = namedKeys[base] ?? (f ? `F${f[1]}` : /^[a-z0-9]$/.test(base) ? base : null);
  if (!mappedBase) throw createHttpError('Invalid key', 400);
  return [...mapped, mappedBase].join('+');
}

/** Validate the entire action before executing its first command. */
export function desktopInputCommands(
  input: DesktopInput,
  native: { width: number; height: number } = { width: NATIVE_WIDTH, height: NATIVE_HEIGHT },
): string[][] {
  if (!input || typeof input !== 'object') throw createHttpError('Invalid desktop input', 400);
  const px = (value: number | undefined) => buttonPoint(value, IMAGE_WIDTH, native.width);
  const py = (value: number | undefined) => buttonPoint(value, IMAGE_HEIGHT, native.height);
  switch (input.action) {
    case 'click': {
      const x = px(input.x), y = py(input.y);
      return [['mousemove', '--sync', String(x), String(y), 'click', '1']];
    }
    case 'drag': {
      const x = px(input.x), y = py(input.y);
      const toX = px(input.toX), toY = py(input.toY);
      return [
        ['mousemove', '--sync', String(x), String(y)],
        ['mousedown', '1'],
        ['mousemove', '--sync', String(toX), String(toY)],
        ['mouseup', '1'],
      ];
    }
    case 'type':
      if (typeof input.text !== 'string' || input.text.length < 1 ||
        Buffer.byteLength(input.text, 'utf8') > 10_000 || input.text.includes('\0'))
        throw createHttpError('Text must be 1-10000 bytes', 400);
      return [['type', '--clearmodifiers', '--delay', '1', '--', input.text]];
    case 'key':
      return [['key', '--clearmodifiers', '--', validateKey(input.key)]];
    case 'scroll': {
      if (input.direction !== 'up' && input.direction !== 'down')
        throw createHttpError('Invalid scroll direction', 400);
      if (input.steps !== undefined && (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 10))
        throw createHttpError('Scroll steps must be 1-10', 400);
      if ((input.x === undefined) !== (input.y === undefined))
        throw createHttpError('Scroll coordinates must include x and y', 400);
      const x = px(input.x ?? Math.floor(IMAGE_WIDTH / 2));
      const y = py(input.y ?? Math.floor(IMAGE_HEIGHT / 2));
      return [['mousemove', '--sync', String(x), String(y)],
        ...Array.from({ length: input.steps ?? 1 }, () => ['click', input.direction === 'up' ? '4' : '5'])];
    }
    default: throw createHttpError('Invalid desktop action', 400);
  }
}

export class DesktopComputer {
  private runtime: Runtime | null = null;
  private readonly owned = new Set<OwnedChild>();
  private readonly observations = new Map<string, Observation>();
  private epoch = 0;
  private revision = 0;
  private busy = false;
  private pendingCleanup: Promise<void> | null = null;
  private activeOperation: Promise<unknown> | null = null;
  private preparingDir: string | null = null;
  private closing = false;
  private shutdownPromise: Promise<void> | null = null;
  private message?: string;

  // Runtime state is ephemeral and always outside the checkout. A private
  // per-instance directory prevents sharing Xauthority or Chrome profiles.
  constructor(private readonly tempRoot = os.tmpdir(), private readonly shared?: SharedDisplaySource) {
    shared?.on('exit', () => {
      const runtime = this.runtime;
      if (!runtime) return;
      this.runtime = null;
      this.epoch++;
      this.revision++;
      this.observations.clear();
      this.message = 'Shared desktop exited; prepare it again';
      this.pendingCleanup = this.cleanup(runtime.dir).catch(() => undefined).finally(() => {
        this.pendingCleanup = null;
      });
    });
  }

  /** Attach to the shared desktop; apps launched here get a private HOME. */
  private async attachShared(shared: SharedDisplaySource): Promise<DesktopStatus> {
    const generation = ++this.epoch;
    const { display, xauthority } = await shared.ensure();
    this.assertOpen(generation);
    const dir = await fs.mkdtemp(path.join(this.tempRoot, 'deckide-computer-'));
    try {
      await fs.chmod(dir, 0o700);
      this.assertOpen(generation);
      const env = safeEnvironment(dir, display, xauthority ?? undefined);
      const xdotool = await executable('xdotool');
      if (!xdotool) throw createHttpError('xdotool is unavailable', 503);
      const [width, height] = (await run(xdotool, ['getdisplaygeometry'], env, { timeoutMs: 2_000, maxBytes: 128 }))
        .toString().trim().split(/\s+/).map(Number);
      if (!(width > 0 && height > 0)) throw createHttpError('Could not read the shared display size', 503);
      this.assertOpen(generation);
      this.runtime = { dir, display, authority: xauthority ?? '', xvfb: null, env, native: { width, height } };
      this.revision++;
      this.message = undefined;
      return this.status();
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw createHttpError('Desktop is shutting down', 503);
    if (this.busy || this.pendingCleanup) throw createHttpError('Desktop is busy; retry', 409);
    this.busy = true;
    const work = operation();
    this.activeOperation = work;
    try { return await work; }
    finally {
      if (this.activeOperation === work) this.activeOperation = null;
      this.busy = false;
    }
  }

  private assertOpen(epoch: number): void {
    if (this.closing || this.epoch !== epoch)
      throw createHttpError('Desktop operation was stopped', 409);
  }

  private async dependencies(): Promise<{ missing: string[]; bins: Record<string, string> }> {
    const required = ['Xvfb', 'xauth', 'xdotool', 'import', 'openbox'];
    const bins: Record<string, string> = {};
    for (const name of required) {
      const found = await executable(name);
      if (found) bins[name] = found;
    }
    return { missing: required.filter((name) => !bins[name]), bins };
  }

  async status(): Promise<DesktopStatus> {
    const { missing } = process.platform === 'linux'
      ? await this.dependencies() : { missing: ['Linux'] };
    const supported = missing.length === 0;
    return { supported, running: Boolean(this.runtime), width: IMAGE_WIDTH, height: IMAGE_HEIGHT,
      ...(!supported ? { message: `Desktop requires ${missing.join(', ')}` } : this.message ? { message: this.message } : {}) };
  }

  private async spawnOwned(command: string, args: string[], env: NodeJS.ProcessEnv,
    cwd: string, role: 'desktop' | 'app' = 'desktop'): Promise<ChildProcess> {
    if (this.closing) throw createHttpError('Desktop is shutting down', 503);
    const proc = spawn(command, args, { env, cwd, detached: true, stdio: 'ignore', windowsHide: true });
    const epoch = this.epoch;
    const owned: OwnedChild = {
      process: proc, start: null, witnesses: new Map(), epoch, role,
    };
    this.owned.add(owned);
    proc.once('exit', () => {
      // A launcher can exit while its detached process group still has
      // descendants. Snapshot a living member before signalling the group;
      // the witness prevents a reused PGID from being targeted later.
      if (proc.pid) owned.witnesses = groupWitnesses(proc.pid);
      this.signalOwned(owned, 'SIGTERM');
      if (owned.witnesses.size) {
        const timer = setTimeout(() => {
          this.signalOwned(owned, 'SIGKILL');
          this.owned.delete(owned);
        }, 1_500);
        timer.unref();
      } else this.owned.delete(owned);
      if (this.runtime?.xvfb === proc && this.epoch === epoch) {
        const runtime = this.runtime;
        this.runtime = null;
        this.epoch++;
        this.revision++;
        this.observations.clear();
        this.message = 'Desktop process exited; prepare it again';
        this.pendingCleanup = this.cleanup(runtime.dir).catch(() => undefined).finally(() => {
          this.pendingCleanup = null;
        });
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', resolve);
        proc.once('error', reject);
      });
      owned.start = proc.pid ? processInfo(proc.pid)?.start ?? null : null;
      if (!owned.start) {
        proc.kill('SIGKILL');
        throw new Error('Could not establish owned process identity');
      }
      if (this.closing) {
        this.signalOwned(owned, 'SIGTERM');
        throw new Error('Desktop is shutting down');
      }
      return proc;
    } catch {
      this.owned.delete(owned);
      throw createHttpError('Could not launch desktop process', 503);
    }
  }

  private signalOwned(child: OwnedChild, signal: NodeJS.Signals): void {
    const pid = child.process.pid;
    if (!pid) return;
    const leader = processInfo(pid);
    const leaderMatches = Boolean(child.start && leader?.start === child.start && leader.group === pid);
    const witnessMatches = [...child.witnesses].some(([memberPid, start]) => {
      const current = processInfo(memberPid);
      return current?.group === pid && current.start === start;
    });
    if (!leaderMatches && !witnessMatches) return;
    try { process.kill(-pid, signal); } catch { /* already exited */ }
  }

  private async cleanup(dir: string): Promise<void> {
    const children = [...this.owned];
    children.forEach((child) => this.signalOwned(child, 'SIGTERM'));
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(children.map(({ process: proc }) => new Promise<void>((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
          proc.once('exit', () => resolve());
        }))),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_500); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    children.forEach((child) => this.signalOwned(child, 'SIGKILL'));
    this.owned.clear();
    await fs.rm(dir, { recursive: true, force: true });
  }

  async prepare(): Promise<DesktopStatus> {
    return this.withOperation(async () => {
      if (this.runtime) return this.status();
      if (this.shared) return this.attachShared(this.shared);
      if (process.platform !== 'linux') throw createHttpError('Linux X11 desktop is unavailable', 501);
      const { missing, bins } = await this.dependencies();
      const generation = ++this.epoch;
      this.assertOpen(generation);
      if (missing.length) throw createHttpError(`Desktop requires ${missing.join(', ')}`, 503);
      const dir = await fs.mkdtemp(path.join(this.tempRoot, 'deckide-computer-'));
      this.preparingDir = dir;
      try {
        this.assertOpen(generation);
        await fs.chmod(dir, 0o700);
        const authority = path.join(dir, 'Xauthority');
        await fs.writeFile(authority, '', { mode: 0o600, flag: 'wx' });
        const envBase = safeEnvironment(dir);
        let launchFailures = 0;
        for (let number = 90; number < 210; number++) {
          this.assertOpen(generation);
          // Xvfb owns the actual display lock; a competing process can win
          // between this check and spawn, in which case we try another number.
          try {
            await fs.access(`/tmp/.X${number}-lock`);
            continue;
          } catch { /* candidate */ }
          const display = `:${number}`;
          await run(bins.xauth, ['-f', authority], envBase, {
            input: `add ${display} . ${randomBytes(32).toString('hex')}\n`, timeoutMs: 3_000,
          });
          this.assertOpen(generation);
          const env = safeEnvironment(dir, display, authority);
          const xvfb = await this.spawnOwned(bins.Xvfb,
            [display, '-screen', '0', `${NATIVE_WIDTH}x${NATIVE_HEIGHT}x24`,
              '-nolisten', 'tcp', '-noreset', '-auth', authority], env, dir);
          let ready = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            this.assertOpen(generation);
            if (xvfb.exitCode !== null || xvfb.signalCode !== null) break;
            try {
              const dimensions = (await run(bins.xdotool, ['getdisplaygeometry'], env,
                { timeoutMs: 500, maxBytes: 128 })).toString().trim();
              const lockPid = Number((await fs.readFile(`/tmp/.X${number}-lock`, 'utf8')).trim());
              if (dimensions === `${NATIVE_WIDTH} ${NATIVE_HEIGHT}` && lockPid === xvfb.pid) {
                ready = true;
                break;
              }
            } catch { /* wait for Xvfb */ }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          this.assertOpen(generation);
          if (!ready) {
            const own = [...this.owned].find((entry) => entry.process === xvfb);
            if (own) this.signalOwned(own, 'SIGTERM');
            if (++launchFailures >= 3)
              throw createHttpError('Could not start an isolated X11 display', 503);
            continue;
          }
          this.runtime = { dir, display, authority, env, xvfb, native: { width: NATIVE_WIDTH, height: NATIVE_HEIGHT } };
          // The child may have exited after the last readiness/lock check,
          // before the exit handler could see it in this.runtime.
          if (xvfb.exitCode !== null || xvfb.signalCode !== null)
            throw createHttpError('X11 display exited during preparation', 503);
          this.revision++;
          this.assertOpen(generation);
          await this.spawnOwned(bins.openbox, ['--sm-disable'], env, dir);
          this.assertOpen(generation);
          this.message = undefined;
          return this.status();
        }
        throw createHttpError('No free X11 display could be started', 503);
      } catch (error) {
        this.runtime = null;
        this.epoch++;
        this.observations.clear();
        await this.cleanup(dir);
        throw error;
      } finally {
        if (this.preparingDir === dir) this.preparingDir = null;
      }
    });
  }

  async stop(): Promise<DesktopStatus> {
    return this.withOperation(async () => {
      const runtime = this.runtime;
      this.runtime = null;
      this.epoch++;
      this.revision++;
      this.observations.clear();
      if (runtime) await this.cleanup(runtime.dir);
      this.message = undefined;
      return this.status();
    });
  }

  /** Server shutdown must reclaim owned children even during a busy capture. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    const runtime = this.runtime;
    this.runtime = null;
    this.epoch++;
    this.revision++;
    this.observations.clear();
    const operation = this.activeOperation;
    const existingCleanup = this.pendingCleanup;
    this.shutdownPromise = (async () => {
      // Stop known process groups immediately, then wait for a concurrently
      // preparing operation to notice closing and release any late child.
      const firstDir = runtime?.dir ?? this.preparingDir;
      if (firstDir) await this.cleanup(firstDir);
      if (operation) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            operation.catch(() => undefined),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      }
      if (existingCleanup) await existingCleanup;
      const lateDir = this.preparingDir;
      if (lateDir && lateDir !== firstDir) await this.cleanup(lateDir);
      if (lateDir && lateDir === firstDir) await this.cleanup(lateDir);
    })();
    return this.shutdownPromise;
  }

  private requireRuntime(): Runtime {
    if (!this.runtime) throw createHttpError('Prepare the desktop first', 409);
    return this.runtime;
  }

  async launch(request: { app: 'browser' | 'terminal'; url?: string }): Promise<DesktopStatus> {
    return this.withOperation(async () => {
      const runtime = this.requireRuntime();
      if (!request || (request.app !== 'browser' && request.app !== 'terminal'))
        throw createHttpError('Choose browser or terminal', 400);
      if ([...this.owned].filter((child) => child.role === 'app').length >= 4)
        throw createHttpError('Desktop app limit reached', 409);
      let command: string | null;
      let args: string[];
      if (request.app === 'browser') {
        const browserOverride = process.env.AGENT_BROWSER_CHROME;
        command = browserOverride ? await executable(browserOverride) : null;
        if (!command && !browserOverride) {
          for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
            command = await executable(name);
            if (command) break;
          }
        }
        if (!command) throw createHttpError('Chrome or Chromium is unavailable', 503);
        let url = 'about:blank';
        if (request.url !== undefined) {
          if (typeof request.url !== 'string' || request.url.length > 2048)
            throw createHttpError('Invalid URL', 400);
          if (request.url !== 'about:blank') {
            let parsed: URL;
            try { parsed = new URL(request.url); } catch { throw createHttpError('Invalid URL', 400); }
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
              throw createHttpError('Only HTTP(S) URLs without credentials are allowed', 400);
            url = parsed.href;
          }
        }
        if (process.getuid?.() === 0)
          throw createHttpError('Browser launch requires a non-root DeckIDE process', 503);
        args = ['--ozone-platform=x11', '--no-first-run', '--no-default-browser-check',
          `--user-data-dir=${path.join(runtime.dir, 'browser-profile')}`,
          '--disable-dev-shm-usage', '--disable-background-networking', url];
      } else {
        if (request.url !== undefined) throw createHttpError('Terminal does not accept URL', 400);
        command = await executable('xterm');
        if (!command) throw createHttpError('xterm is unavailable', 503);
        args = ['-title', 'DeckIDE desktop', '-geometry', '100x30+24+24'];
      }
      this.observations.clear();
      this.revision++;
      await this.spawnOwned(command, args, runtime.env, runtime.dir, 'app');
      return this.status();
    });
  }

  async screenshot(actor: string, previousHash?: string) {
    return this.withOperation(async () => {
      const runtime = this.requireRuntime();
      if (typeof actor !== 'string' || !actor || actor.length > 256)
        throw createHttpError('Invalid desktop actor', 400);
      if (previousHash !== undefined && (typeof previousHash !== 'string' || !/^[a-f0-9]{64}$/.test(previousHash)))
        throw createHttpError('Invalid previous hash', 400);
      const command = await executable('import');
      if (!command) throw createHttpError('ImageMagick import is unavailable', 503);
      let jpeg: Buffer;
      try {
        jpeg = await run(command, ['-display', runtime.display, '-window', 'root',
          '-resize', `${IMAGE_WIDTH}x${IMAGE_HEIGHT}!`, '-quality', '72', 'jpeg:-'], runtime.env,
        { timeoutMs: 8_000, maxBytes: MAX_IMAGE_BYTES });
      } catch { throw createHttpError('Desktop capture failed', 503); }
      if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
        jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9)
        throw createHttpError('Desktop capture failed', 503);
      if (runtime !== this.runtime) throw createHttpError('Desktop changed; capture again', 409);
      const hash = createHash('sha256').update(jpeg).digest('hex');
      const now = Date.now();
      for (const [id, observation] of this.observations)
        if (now - observation.createdAt > OBSERVATION_MS) this.observations.delete(id);
      while (this.observations.size >= MAX_OBSERVATIONS)
        this.observations.delete(this.observations.keys().next().value!);
      const observationId = randomUUID();
      this.observations.set(observationId, { actor, createdAt: now, epoch: this.epoch, revision: this.revision });
      return { observationId, width: IMAGE_WIDTH, height: IMAGE_HEIGHT, hash,
        ...(previousHash === hash ? { unchanged: true as const } :
          { image: { type: 'image' as const, mimeType: 'image/jpeg' as const, data: jpeg.toString('base64') } }) };
    });
  }

  async input(actor: string, input: DesktopInput): Promise<{ executed: true; requiresObservation: true }> {
    return this.withOperation(async () => {
      const runtime = this.requireRuntime();
      const observation = typeof input?.observationId === 'string'
        ? this.observations.get(input.observationId) : undefined;
      if (!observation || observation.actor !== actor ||
        Date.now() - observation.createdAt > OBSERVATION_MS ||
        observation.epoch !== this.epoch || observation.revision !== this.revision)
        throw createHttpError('A fresh screenshot is required before desktop input', 409);
      const commands = desktopInputCommands(input, runtime.native);
      const xdotool = await executable('xdotool');
      if (!xdotool) throw createHttpError('xdotool is unavailable', 503);
      // Consumption precedes the first side effect, including failure halfway
      // through a drag. Every actor must observe the resulting display again.
      this.observations.clear();
      this.revision++;
      try {
        for (const args of commands) await run(xdotool, args, runtime.env, { timeoutMs: 5_000 });
      } catch {
        // A partially executed drag must release the pointer before returning.
        if (input.action === 'drag') await run(xdotool, ['mouseup', '1'], runtime.env,
          { timeoutMs: 1_000 }).catch(() => undefined);
        throw createHttpError('Desktop input failed; observe before retrying', 503);
      }
      return { executed: true, requiresObservation: true };
    });
  }
}
