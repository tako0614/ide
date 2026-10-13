import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHttpError } from '../utils/error.js';
import { listDesktopApps, type DesktopApp } from './apps.js';

const execFileAsync = promisify(execFile);

export type DesktopEnv = { display: string; xauthority: string | null };

export type SharedDesktopStatus = {
  supported: boolean;
  running: boolean;
  /** Started (and may be stopped) by Deck IDE, vs. attached to an existing X server. */
  owned: boolean;
  display: string;
  width: number | null;
  height: number | null;
  message?: string;
};

type Current = { env: DesktopEnv; pid: number; owned: boolean; width: number | null; height: number | null };

const REQUIRED = ['Xvfb', 'xauth', 'xdpyinfo', 'xprop', 'openbox', 'x11vnc', 'xdotool'];
const WATCH_INTERVAL_MS = 3_000;
const MAX_TYPE_BYTES = 10_000;

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

function displayNumber(display: string): number {
  const match = /^:(\d{1,4})$/.exec(display);
  if (!match) throw new Error(`Invalid X display: ${display}`);
  return Number(match[1]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kernel start time of a process (field 22 of /proc/<pid>/stat), for PID-reuse checks. */
function startTime(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(') ') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function lockOwner(number: number): number | null {
  try {
    const pid = Number(fs.readFileSync(`/tmp/.X${number}-lock`, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** The `-auth` file an existing X server was started with, if readable. */
function authorityOf(pid: number): string | null {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const index = argv.indexOf('-auth');
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  } catch {
    return null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function waitForRfb(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('data', (chunk) => {
        socket.destroy();
        resolve(chunk.toString('latin1').startsWith('RFB '));
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/**
 * One persistent X desktop that every GUI thing in Deck IDE shares: the agent
 * browser's Chrome, apps the user launches (Grok Bot, ChatGPT, editors…),
 * the MCP computer tools, and the human viewing it over VNC.
 *
 * Deck IDE starts Xvfb + openbox on the configured display, detached, so the
 * desktop and its apps survive a Deck IDE restart; the next start re-attaches.
 * If another X server already owns the display (e.g. an older build's
 * xvfb-run), Deck IDE attaches to it instead and never stops it.
 */
export class SharedDesktop extends EventEmitter {
  private current: Current | null = null;
  private pending: Promise<DesktopEnv> | null = null;
  private watcher: NodeJS.Timeout | null = null;
  private vncProcess: ChildProcess | null = null;
  private vncInfo: { port: number; password: string } | null = null;
  private vncPending: Promise<{ port: number; password: string }> | null = null;
  private lastError: string | undefined;

  constructor(private readonly options: {
    display: string;
    width: number;
    height: number;
    /** Private (0700) directory for Xauthority, pid files and the VNC password. */
    stateDir: string;
    /** Extra .desktop directories (tests). */
    appDirs?: string[];
  }) {
    super();
    displayNumber(options.display);
  }

  get display(): string {
    return this.options.display;
  }

  private missing(): string[] {
    if (process.platform !== 'linux') return ['Linux'];
    return REQUIRED.filter((name) => !which(name));
  }

  /** Display env if the desktop is up right now (no side effects). */
  env(): DesktopEnv | null {
    return this.current && isAlive(this.current.pid) ? this.current.env : null;
  }

  async status(): Promise<SharedDesktopStatus> {
    const missing = this.missing();
    const running = Boolean(this.env());
    return {
      supported: missing.length === 0,
      running,
      owned: Boolean(running && this.current?.owned),
      display: this.options.display,
      width: running ? this.current!.width : null,
      height: running ? this.current!.height : null,
      ...(missing.length ? { message: `Desktop requires ${missing.join(', ')}` }
        : this.lastError ? { message: this.lastError } : {}),
    };
  }

  /** Start (or attach to) the desktop. Concurrent callers share one attempt. */
  ensure(): Promise<DesktopEnv> {
    const env = this.env();
    if (env) return Promise.resolve(env);
    if (!this.pending) {
      this.pending = this.start()
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        })
        .finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  private async geometry(env: DesktopEnv): Promise<{ width: number; height: number } | null> {
    try {
      const { stdout } = await execFileAsync('xdpyinfo', [], {
        env: this.xEnv(env), timeout: 2_000, maxBuffer: 512 * 1024,
      });
      const match = /dimensions:\s+(\d+)x(\d+)/.exec(stdout);
      return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
    } catch {
      return null;
    }
  }

  private xEnv(env: DesktopEnv, base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
  }): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = { ...base, DISPLAY: env.display };
    if (env.xauthority) result.XAUTHORITY = env.xauthority;
    else delete result.XAUTHORITY;
    delete result.WAYLAND_DISPLAY;
    return result;
  }

  private async start(): Promise<DesktopEnv> {
    const missing = this.missing();
    if (missing.length) throw createHttpError(`Desktop requires ${missing.join(', ')}`, 503);
    const number = displayNumber(this.options.display);
    await fsp.mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.options.stateDir, 0o700);

    let pid = lockOwner(number);
    let owned = false;
    let env: DesktopEnv;
    if (pid) {
      // Someone already serves this display: our own detached Xvfb from a
      // previous run, or another program's X server. Attach either way.
      env = { display: this.options.display, xauthority: authorityOf(pid) };
      owned = this.readPidFile('xvfb')?.pid === pid && this.readPidFile('xvfb')?.start === startTime(pid);
    } else {
      env = await this.spawnXvfb(number);
      pid = lockOwner(number);
      owned = true;
    }
    const size = await this.geometry(env);
    if (!pid || !size) throw createHttpError(`Cannot open X display ${this.options.display}`, 503);
    await this.ensureWindowManager(env);
    this.current = { env, pid, owned, ...size };
    this.lastError = undefined;
    this.startWatching();
    this.emit('ready', env);
    return env;
  }

  private pidFile(name: string): string {
    return path.join(this.options.stateDir, `${name}.json`);
  }

  private readPidFile(name: string): { pid: number; start: string } | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.pidFile(name), 'utf8')) as { pid?: unknown; start?: unknown };
      return typeof data.pid === 'number' && typeof data.start === 'string' ? { pid: data.pid, start: data.start } : null;
    } catch {
      return null;
    }
  }

  private writePidFile(name: string, pid: number): void {
    const start = startTime(pid);
    if (start) fs.writeFileSync(this.pidFile(name), JSON.stringify({ pid, start }) + '\n', { mode: 0o600 });
  }

  /** Signal a detached process recorded in a pid file, only if it is still that process. */
  private killRecorded(name: string): void {
    const record = this.readPidFile(name);
    if (record && startTime(record.pid) === record.start) {
      try { process.kill(record.pid, 'SIGTERM'); } catch { /* gone */ }
    }
    try { fs.unlinkSync(this.pidFile(name)); } catch { /* none */ }
  }

  private async spawnXvfb(number: number): Promise<DesktopEnv> {
    const authority = path.join(this.options.stateDir, 'Xauthority');
    const staging = `${authority}.${process.pid}.tmp`;
    await fsp.writeFile(staging, '', { mode: 0o600 });
    await execFileAsync('xauth', ['-f', staging, 'add', this.options.display, '.', crypto.randomBytes(16).toString('hex')], {
      timeout: 3_000,
    });
    await fsp.rename(staging, authority);
    const env: DesktopEnv = { display: this.options.display, xauthority: authority };
    const child = spawn(which('Xvfb')!, [
      this.options.display,
      '-screen', '0', `${this.options.width}x${this.options.height}x24`,
      '-nolisten', 'tcp', '-noreset', '-auth', authority,
    ], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
    child.unref();
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) break;
      if (lockOwner(number) === child.pid && await this.geometry(env)) {
        this.writePidFile('xvfb', child.pid!);
        return env;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try { child.kill('SIGTERM'); } catch { /* exited */ }
    throw createHttpError(`Could not start X display ${this.options.display}`, 503);
  }

  private async ensureWindowManager(env: DesktopEnv): Promise<void> {
    try {
      const { stdout } = await execFileAsync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], {
        env: this.xEnv(env), timeout: 2_000,
      });
      if (/window id/.test(stdout)) return;
    } catch { /* no property: no WM */ }
    // Without a window manager every app opens undecorated at 0,0 and cannot
    // be moved, focused or switched. openbox also gives a right-click menu.
    const child = spawn(which('openbox')!, ['--sm-disable'], {
      detached: true, stdio: 'ignore', env: this.xEnv(env), cwd: os.homedir(),
    });
    child.unref();
    await new Promise<void>((resolve) => {
      child.once('spawn', () => resolve());
      child.once('error', () => resolve());
    });
    if (child.pid) this.writePidFile('openbox', child.pid);
  }

  private startWatching(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      if (this.current && !isAlive(this.current.pid)) {
        this.current = null;
        this.lastError = 'The desktop X server exited';
        this.stopVnc();
        this.emit('exit');
      }
    }, WATCH_INTERVAL_MS);
    this.watcher.unref();
  }

  // ── VNC (human viewer) ─────────────────────────────────────────────

  /**
   * Make sure x11vnc serves the desktop and return how to reach it. It listens
   * on loopback only with a random per-run password that is handed out only
   * to authenticated Deck IDE clients (the WebSocket bridge is the way in).
   */
  vnc(): Promise<{ port: number; password: string }> {
    if (this.vncInfo && this.vncProcess && this.vncProcess.exitCode === null) return Promise.resolve(this.vncInfo);
    if (!this.vncPending) {
      this.vncPending = this.startVnc().finally(() => { this.vncPending = null; });
    }
    return this.vncPending;
  }

  private async startVnc(): Promise<{ port: number; password: string }> {
    const env = await this.ensure();
    this.stopVnc();
    const port = await freePort();
    // Classic VNC auth only uses the first 8 characters.
    const password = crypto.randomBytes(12).toString('base64url').slice(0, 8);
    const passwordFile = path.join(this.options.stateDir, 'vnc-password');
    await fsp.writeFile(passwordFile, password + '\n', { mode: 0o600 });
    await fsp.chmod(passwordFile, 0o600);
    const child = spawn(which('x11vnc')!, [
      '-display', env.display,
      ...(env.xauthority ? ['-auth', env.xauthority] : []),
      '-localhost', '-rfbport', String(port), '-passwdfile', passwordFile,
      // Many viewers (PC + phone), kept running between them.
      '-shared', '-forever',
      // Typed characters missing from the keymap (e.g. from a phone keyboard)
      // are added on the fly; XKB keeps symbols like @ [ ] correct.
      '-xkb', '-add_keysyms',
      // Draw real window contents while moving windows, not a wireframe.
      '-nowf',
      '-quiet', '-noipv6',
    ], { stdio: 'ignore', env: this.xEnv(env) });
    this.vncProcess = child;
    child.once('exit', () => {
      if (this.vncProcess === child) {
        this.vncProcess = null;
        this.vncInfo = null;
      }
    });
    if (!(await waitForRfb(port, 8_000))) {
      this.stopVnc();
      throw createHttpError('Could not start the VNC server for the desktop', 503);
    }
    this.vncInfo = { port, password };
    return this.vncInfo;
  }

  private stopVnc(): void {
    const child = this.vncProcess;
    this.vncProcess = null;
    this.vncInfo = null;
    if (child && child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch { /* exited */ }
    }
  }

  // ── Apps ───────────────────────────────────────────────────────────

  apps(): Promise<DesktopApp[]> {
    return listDesktopApps(this.options.appDirs);
  }

  /** Environment for apps on the desktop: the user's own, pointed at this display. */
  private appEnv(env: DesktopEnv): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(base)) {
      if (key.startsWith('DECKIDE_') || key === 'PORT' || key === 'HOST') delete base[key];
    }
    return this.xEnv(env, base);
  }

  /**
   * Launch a registered app (by id) or an arbitrary shell command on the
   * desktop. Apps are detached so they outlive this request and a Deck IDE
   * restart, like apps started from a desktop's own menu.
   */
  async launch(request: { appId?: string; command?: string; cwd?: string }): Promise<{ pid: number; name: string }> {
    const env = await this.ensure();
    let argv: string[];
    let name: string;
    if (typeof request.appId === 'string' && request.appId) {
      const app = (await this.apps()).find((entry) => entry.id === request.appId);
      if (!app) throw createHttpError('App not found', 404);
      argv = [...app.exec];
      // Chromium and Electron refuse to start as root unless their sandbox is
      // disabled (the user opted into this for the shared desktop).
      if (process.getuid?.() === 0 && app.chromium && !argv.includes('--no-sandbox')) argv.push('--no-sandbox');
      name = app.name;
    } else if (typeof request.command === 'string' && request.command.trim()) {
      if (request.command.length > 4096 || request.command.includes('\0')) throw createHttpError('Invalid command', 400);
      argv = ['/bin/sh', '-c', request.command];
      name = request.command.trim().split(/\s+/)[0];
    } else {
      throw createHttpError('appId or command is required', 400);
    }
    let cwd = os.homedir();
    if (typeof request.cwd === 'string' && path.isAbsolute(request.cwd)) {
      try {
        if ((await fsp.stat(request.cwd)).isDirectory()) cwd = request.cwd;
      } catch { /* fall back to home */ }
    }
    const child = spawn(argv[0], argv.slice(1), { cwd, env: this.appEnv(env), detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(createHttpError(`Could not start ${name}`, 422)));
    });
    child.unref();
    return { pid: child.pid!, name };
  }

  /** Type text into the focused window (works for Japanese and other non-keymap text). */
  async typeText(text: string): Promise<void> {
    if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > MAX_TYPE_BYTES || text.includes('\0')) {
      throw createHttpError(`Text must be 1-${MAX_TYPE_BYTES} bytes`, 400);
    }
    const env = await this.ensure();
    try {
      await execFileAsync('xdotool', ['type', '--clearmodifiers', '--delay', '4', '--', text], {
        env: this.xEnv(env), timeout: 30_000,
      });
    } catch {
      throw createHttpError('Typing into the desktop failed', 503);
    }
  }

  /** Server shutdown: stop serving VNC but leave the desktop and its apps running. */
  shutdown(): void {
    this.stopVnc();
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  /** Stop the desktop if Deck IDE started it (its apps go with it). */
  async stop(): Promise<SharedDesktopStatus> {
    this.stopVnc();
    if (this.current?.owned || !this.current) {
      this.killRecorded('openbox');
      this.killRecorded('xvfb');
    }
    const wasRunning = Boolean(this.current);
    this.current = null;
    if (wasRunning) this.emit('exit');
    return this.status();
  }
}
