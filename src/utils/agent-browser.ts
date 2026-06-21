import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, type RawData } from 'ws';
import type { BrowserStatus, BrowserTab } from '../shared/types.js';
import { BrowserAudioRelay } from './browser-audio.js';
import { BrowserWebRtcRelay } from './browser-webrtc.js';

const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.local', 'share', 'agent-browser', 'profile');
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), '.local', 'share', 'agent-browser', 'output');
const START_TIMEOUT_MS = 30_000;
const MAX_CLIENT_BUFFERED_AMOUNT = 4 * 1024 * 1024;
// Above this many bytes already queued on a client socket we hold the newest
// frame instead of piling on, then flush it once the socket drains.
const FRAME_COALESCE_THRESHOLD = 256 * 1024;
const FRAME_FLUSH_INTERVAL_MS = 16;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MIN_VIEWPORT = { width: 320, height: 240 };
const MAX_VIEWPORT = { width: 3840, height: 2160 };

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: Record<string, unknown>;
};

type CdpPending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BrowserClientMessage =
  | { type: 'resize'; width: number; height: number }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'new-tab'; url?: string }
  | { type: 'close-tab'; targetId: string }
  | { type: 'activate-tab'; targetId: string }
  | {
      type: 'mouse';
      eventType: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
      x: number;
      y: number;
      button?: 'none' | 'left' | 'middle' | 'right';
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      type: 'key';
      eventType: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
      key: string;
      code: string;
      text?: string;
      modifiers?: number;
    };

type ChromeTarget = {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

// Shape of `targetInfo` carried by Target.targetCreated / targetInfoChanged.
type ChromeTargetInfo = {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
  attached?: boolean;
};

type PageScreencastFrameParams = {
  data?: unknown;
  sessionId?: unknown;
  metadata?: unknown;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

function waitForSocketOpen(socket: WebSocket, timeoutMs = 10_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out connecting to Chrome DevTools WebSocket'));
    }, timeoutMs);
    timer.unref?.();
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function coercePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }

  const hasExplicitProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    || /^(about|data|file):/i.test(trimmed);
  const isLocalHost = /^(localhost|127(?:\.\d{1,3}){0,3}|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(trimmed);
  const withScheme = hasExplicitProtocol
    ? trimmed
    : `${isLocalHost ? 'http' : 'https'}://${trimmed}`;
  const parsed = new URL(withScheme);
  const allowedProtocols = new Set(['http:', 'https:', 'file:', 'about:', 'data:']);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.href;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findInPath(names: string[]): Promise<string | null> {
  const pathValue = process.env.PATH || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function findPlaywrightChromium(): Promise<string | null> {
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const chromiumDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const dir of chromiumDirs) {
    const candidates = [
      path.join(cacheRoot, dir, 'chrome-linux64', 'chrome'),
      path.join(cacheRoot, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(cacheRoot, dir, 'chrome-win', 'chrome.exe'),
    ];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function findChromeExecutable(): Promise<string | null> {
  if (process.env.AGENT_BROWSER_CHROME) {
    if (await pathExists(process.env.AGENT_BROWSER_CHROME)) {
      return process.env.AGENT_BROWSER_CHROME;
    }
    throw new Error(`AGENT_BROWSER_CHROME does not exist: ${process.env.AGENT_BROWSER_CHROME}`);
  }

  // 本物の Google Chrome を最優先（指紋が自然でボット判定を通りやすい）。
  // Playwright の Chromium はフォールバックに回す。
  const systemChrome = await findInPath([
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome',
  ]);
  if (systemChrome) {
    return systemChrome;
  }

  return findPlaywrightChromium();
}

// MCP（chrome-devtools-mcp 等）が --browserUrl で確実に相乗りできるよう、
// CDP ポートは固定にする。AGENT_BROWSER_CDP_PORT で上書き可、既定 9222。
const DEFAULT_CDP_PORT = 9222;

function resolveCdpPort(): number {
  const raw = process.env.AGENT_BROWSER_CDP_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return DEFAULT_CDP_PORT;
}

/**
 * Chrome の起動コマンドを解決する。
 * ボット判定対策として「実 Chrome を headful」で動かしたい。Linux サーバ等で
 * ディスプレイが無い場合は xvfb-run で仮想ディスプレイ上の headful を使う。
 * xvfb-run も無ければやむを得ず headless にフォールバックする。
 */
function resolveLaunchCommand(
  executable: string,
  chromeArgs: string[]
): { command: string; args: string[] } {
  const hasDisplay = Boolean(process.env.DISPLAY);
  if (process.platform === 'linux' && !hasDisplay) {
    const xvfbRun = ['/usr/bin/xvfb-run', '/usr/local/bin/xvfb-run'].find((p) =>
      fsSync.existsSync(p)
    );
    if (xvfbRun) {
      return {
        command: xvfbRun,
        args: [
          '-a',
          '--server-args=-screen 0 1280x720x24 -nolisten tcp',
          executable,
          ...chromeArgs,
        ],
      };
    }
    // ディスプレイも xvfb-run も無い → headless で動かす（Cloudflare は通りにくい）。
    return { command: executable, args: ['--headless=new', ...chromeArgs] };
  }
  // ディスプレイがある（mac/win/Linux+X）→ そのまま headful 起動。
  return { command: executable, args: chromeArgs };
}

async function fetchJson<T>(url: string, options: RequestInit = {}, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  let response: Response;
  try {
    response = await fetch(url, { ...options, signal: options.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Chrome CDP request failed (${response.status}): ${body || response.statusText}`);
  }
  return response.json() as Promise<T>;
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, CdpPending>();
  onEvent?: (message: CdpResponse) => void;

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('close', () => this.rejectAll(new Error('Chrome DevTools connection closed')));
    socket.on('error', (error) => this.rejectAll(error));
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    if (!isOpen(this.socket)) {
      return Promise.reject(new Error('Chrome DevTools connection is not open'));
    }

    const id = this.nextId++;
    const payload = params ? { id, method, params } : { id, method };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
    this.rejectAll(new Error('Chrome DevTools connection closed'));
  }

  private handleMessage(data: RawData): void {
    let parsed: CdpResponse;
    try {
      const text = typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
      parsed = JSON.parse(text) as CdpResponse;
    } catch {
      return;
    }

    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message || 'Chrome DevTools command failed'));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    this.onEvent?.(parsed);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export class AgentBrowserService {
  private chromeProcess: ChildProcessWithoutNullStreams | null = null;
  private logStream: fsSync.WriteStream | null = null;
  private launching: Promise<void> | null = null;
  private port: number | null = null;
  private executablePath: string | null = null;

  // 共有ブラウザを常駐させるための状態。keepAlive が true の間はクラッシュ時に
  // 自動再起動し、9222 を常時稼働させる（BrowserPane を開いていなくても
  // chrome MCP が使えるようにするため）。明示的な stop() で false にする。
  private keepAlive = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private lastStartTime = 0;

  // Browser-level CDP connection used only to discover tabs (page targets) and
  // drive their lifecycle (create/close/activate). One per running Chrome.
  private browserCdp: CdpConnection | null = null;
  private browserCdpSocket: WebSocket | null = null;
  private browserCdpConnecting: Promise<void> | null = null;

  // CDP connection to the *active* tab's page target — the only tab that streams
  // frames and receives input. Switching tabs tears this down and reconnects to
  // the new target.
  private activeCdp: CdpConnection | null = null;
  private activeCdpSocket: WebSocket | null = null;
  private activeConnecting: Promise<void> | null = null;
  // Bumped on every tab switch. A slower in-flight connect compares against it
  // and bails if it lost the race, so it can't clobber the newer active tab.
  private activeGeneration = 0;
  private screencastStarted = false;

  // Known page targets (tabs) keyed by targetId, in discovery/creation order.
  private readonly tabs = new Map<string, BrowserTab>();
  private activeTargetId: string | null = null;
  // True once the first active tab is established. Gates popup auto-follow so
  // targets discovered during launch don't hijack focus before we've picked one.
  private ready = false;

  // Raw JPEG bytes of the most recent screencast frame, kept so reconnecting or
  // late-joining clients can be shown the current page immediately. Frames are
  // pushed to clients as binary WebSocket messages (no base64) to cut ~33% size
  // and avoid per-frame string allocation.
  private lastFrameBuffer: Buffer | null = null;
  // Newest frame held back per slow client, flushed when its socket drains.
  private readonly pendingFrames = new Map<WebSocket, Buffer>();
  private frameFlushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly clients = new Set<WebSocket>();
  private viewport = { ...DEFAULT_VIEWPORT };
  private lastError: string | undefined;
  private readonly audioRelay = new BrowserAudioRelay();
  // A1 WebRTC video path (direct Xvfb capture → ffmpeg → werift). Constructed
  // always, but inert until AGENT_BROWSER_WEBRTC is enabled and a client connects.
  private readonly webrtcRelay = new BrowserWebRtcRelay(this);

  readonly profileDir = process.env.AGENT_BROWSER_PROFILE_DIR || DEFAULT_PROFILE_DIR;
  readonly outputDir = process.env.AGENT_BROWSER_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;

  async getStatus(): Promise<BrowserStatus> {
    const active = this.activeTargetId ? this.tabs.get(this.activeTargetId) : null;
    return {
      running: this.isRunning(),
      launching: Boolean(this.launching),
      profileDir: this.profileDir,
      outputDir: this.outputDir,
      executablePath: this.executablePath ?? await findChromeExecutable().catch(() => null),
      cdpUrl: this.port ? `http://127.0.0.1:${this.port}` : null,
      pageUrl: active?.url ?? null,
      pageTitle: active?.title ?? null,
      tabs: [...this.tabs.values()].map((tab) => ({ ...tab })),
      activeTabId: this.activeTargetId,
      audio: await this.audioRelay.getStatus(),
      webrtc: await this.webrtcRelay.getStatus(),
      error: this.lastError,
    };
  }

  async start(): Promise<void> {
    // 一度起動を要求されたら常駐させる（クラッシュ時は自動再起動）。
    this.keepAlive = true;
    if (this.isRunning()) {
      await this.ensureSession();
      if (this.clients.size > 0) {
        await this.startScreencast();
      }
      return;
    }
    if (this.launching) {
      await this.launching;
      if (this.clients.size > 0) {
        await this.startScreencast();
      }
      return;
    }

    this.launching = this.launch();
    try {
      await this.launching;
      this.lastStartTime = Date.now();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.stop().catch(() => undefined);
      throw error;
    } finally {
      this.launching = null;
    }

    if (this.clients.size > 0) {
      await this.startScreencast();
    }
  }

  async stop(): Promise<void> {
    // 明示的な停止 → 自動再起動を無効化。
    this.keepAlive = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.disconnectActiveCdp();
    this.closeBrowserCdp();
    const proc = this.chromeProcess;
    this.chromeProcess = null;
    this.port = null;
    this.tabs.clear();
    this.activeTargetId = null;
    this.ready = false;
    this.screencastStarted = false;
    this.lastFrameBuffer = null;
    this.pendingFrames.clear();
    if (this.frameFlushTimer) {
      clearInterval(this.frameFlushTimer);
      this.frameFlushTimer = null;
    }

    if (proc && proc.exitCode == null && proc.signalCode == null) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 3000);
        killTimer.unref?.();

        proc.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });

        try {
          proc.kill('SIGTERM');
        } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
    }

    this.closeLogStream();
    await this.audioRelay.stop();
    await this.webrtcRelay.stop();
    await this.broadcastStatus();
  }

  attachWebSocket(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      void this.handleClientMessage(socket, data);
    });
    socket.on('close', () => {
      this.clients.delete(socket);
      this.pendingFrames.delete(socket);
      if (this.clients.size === 0) {
        void this.stopScreencast();
      }
    });

    void this.openForClient(socket);
  }

  attachAudioWebSocket(socket: WebSocket): void {
    this.audioRelay.attachWebSocket(socket);
  }

  attachWebRtcWebSocket(socket: WebSocket): void {
    this.webrtcRelay.attachWebSocket(socket);
  }

  // --- WebRtcHost: capabilities the WebRTC relay needs from the browser ---

  isBrowserRunning(): boolean {
    return this.isRunning();
  }

  // Position+size the active tab's OS window on the X display. No window manager
  // runs under Xvfb, so 'maximized'/'fullscreen' window states are unreliable —
  // explicit normal bounds are not.
  async setActiveWindowBounds(left: number, top: number, width: number, height: number): Promise<void> {
    if (!this.activeTargetId) {
      return;
    }
    await this.connectBrowserCdp();
    const cdp = this.browserCdp;
    if (!cdp) {
      return;
    }
    const win = await cdp
      .send<{ windowId?: number }>('Browser.getWindowForTarget', { targetId: this.activeTargetId })
      .catch(() => null);
    if (!win || typeof win.windowId !== 'number') {
      return;
    }
    await cdp
      .send('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { left, top, width, height, windowState: 'normal' },
      })
      .catch(() => undefined);
  }

  async navigate(input: string): Promise<void> {
    const url = normalizeBrowserUrl(input);
    await this.start();
    await this.ensureActiveCdp();
    await this.activeCdp?.send('Page.navigate', { url });
    const tab = this.activeTargetId ? this.tabs.get(this.activeTargetId) : null;
    if (tab) {
      tab.url = url;
    }
    await this.refreshActivePageInfo();
    await this.broadcastStatus();
  }

  // クラッシュ後に共有ブラウザを自動再起動する（9222 常時稼働の維持）。
  // 直近の起動が短命なら連続再起動を抑制し、5 回連続で短命なら諦める。
  private scheduleAutoRestart(): void {
    if (this.restartTimer || !this.keepAlive) {
      return;
    }
    // 30 秒以上動いていたら安定とみなしてカウンタをリセット。
    if (Date.now() - this.lastStartTime > 30_000) {
      this.restartAttempts = 0;
    }
    if (this.restartAttempts >= 5) {
      console.error('[agent-browser] 自動再起動を中止（短時間に連続クラッシュ）');
      this.keepAlive = false;
      return;
    }
    this.restartAttempts++;
    const delay = Math.min(1000 * this.restartAttempts, 10_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.keepAlive) return;
      this.start().catch((e) => {
        console.error('[agent-browser] 自動再起動に失敗:', e instanceof Error ? e.message : e);
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  // 履歴を delta だけ移動（-1=戻る, +1=進む）。端なら何もしない。
  private async goHistory(delta: number): Promise<void> {
    await this.start();
    await this.ensureActiveCdp();
    const cdp = this.activeCdp;
    if (!cdp) return;
    const history = await cdp.send<{
      currentIndex: number;
      entries: Array<{ id: number }>;
    }>('Page.getNavigationHistory');
    const targetIndex = history.currentIndex + delta;
    if (targetIndex < 0 || targetIndex >= history.entries.length) {
      return; // これ以上戻る/進む先がない
    }
    await cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[targetIndex].id });
    await this.refreshActivePageInfo();
    await this.broadcastStatus();
  }

  async newTab(input?: string): Promise<void> {
    await this.start();
    await this.connectBrowserCdp();
    const url = input ? normalizeBrowserUrl(input) : 'about:blank';
    const result = await this.browserCdp?.send<{ targetId?: string }>('Target.createTarget', { url });
    const targetId = result?.targetId;
    if (!targetId) {
      throw new Error('Failed to open a new tab');
    }
    if (!this.tabs.has(targetId)) {
      this.tabs.set(targetId, { id: targetId, url: url === 'about:blank' ? '' : url, title: '' });
    }
    await this.setActiveTab(targetId);
  }

  async closeTab(targetId: string): Promise<void> {
    await this.connectBrowserCdp();
    await this.browserCdp?.send('Target.closeTarget', { targetId }).catch(() => undefined);
    this.removeTab(targetId);
    // Never leave the pane with zero tabs — reopen a blank one like a real
    // browser keeping a minimum of one tab.
    if (this.tabs.size === 0 && this.isRunning()) {
      await this.newTab().catch(() => undefined);
    }
  }

  async activateTab(targetId: string): Promise<void> {
    if (!this.tabs.has(targetId)) {
      return;
    }
    await this.setActiveTab(targetId);
    await this.browserCdp?.send('Target.activateTarget', { targetId }).catch(() => undefined);
  }

  private async launch(): Promise<void> {
    this.lastError = undefined;
    await fs.mkdir(this.profileDir, { recursive: true });
    await fs.mkdir(this.outputDir, { recursive: true });

    const executable = await findChromeExecutable();
    if (!executable) {
      throw new Error('Chromium or Chrome was not found. Set AGENT_BROWSER_CHROME to a browser executable.');
    }

    this.executablePath = executable;
    this.port = resolveCdpPort();
    this.openLogStream();

    // headless フラグは付けない（headful を既定にする）。ディスプレイ無し環境では
    // resolveLaunchCommand が xvfb-run で仮想ディスプレイを用意する。
    const chromeArgs = [
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      // GPU の無いサーバ + Xvfb 上で headful 起動すると、別プロセスの GPU が
      // 起動失敗して "GPU process isn't usable. Goodbye." で即クラッシュする。
      // GPU を browser プロセス内で動かし、GPU サンドボックスを外して回避する。
      '--in-process-gpu',
      '--disable-gpu-sandbox',
      // GPU レスのサーバでも WebGL を「本物のソフトウェアレンダラ(SwiftShader/ANGLE)」として
      // 実際に動かす。Chrome >=130 は自動 SwiftShader フォールバックを廃止したため
      // --enable-unsafe-swiftshader が必須。WebGL が全く無いと実Chromeとして不自然で
      // ボット判定（Cloudflare Turnstile 等）の信号になる。実機検証で WebGL 復活＋無クラッシュを確認済み。
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      // ボット判定（Cloudflare の Managed Challenge 等）で誤検知されにくくする。
      // navigator.webdriver を立てる自動化フラグを無効化する。残りの偽装は CDP 側。
      '--disable-blink-features=AutomationControlled',
      '--lang=ja-JP',
      '--window-size=1280,720',
    ];

    if (process.getuid?.() === 0) {
      chromeArgs.push('--no-sandbox');
    }
    chromeArgs.push('about:blank');

    const { command, args } = resolveLaunchCommand(executable, chromeArgs);
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    this.chromeProcess = child;

    child.stdout.pipe(this.logStream ?? process.stdout, { end: false });
    child.stderr.pipe(this.logStream ?? process.stderr, { end: false });
    child.once('exit', (code, signal) => {
      if (this.chromeProcess === child) {
        this.chromeProcess = null;
        this.port = null;
        this.disconnectActiveCdp();
        this.closeBrowserCdp();
        this.tabs.clear();
        this.activeTargetId = null;
        this.ready = false;
        this.closeLogStream();
        this.lastError = code === 0 ? undefined : `Browser exited (${signal ?? code ?? 'unknown'})`;
        void this.broadcastStatus();
        // 明示停止でなく落ちた（クラッシュ）なら、常駐維持のため自動再起動。
        if (this.keepAlive) {
          this.scheduleAutoRestart();
        }
      }
    });
    child.once('error', (error) => {
      this.lastError = error.message;
      void this.broadcastStatus();
    });

    await this.waitForChrome();
    await this.connectBrowserCdp();
    await this.ensureActiveTab();
    await this.broadcastStatus();
  }

  private async waitForChrome(): Promise<void> {
    if (!this.port) {
      throw new Error('Chrome debugging port is not assigned');
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      if (!this.isRunning()) {
        throw new Error(this.lastError || 'Browser exited before DevTools became available');
      }

      try {
        await fetchJson<unknown>(`http://127.0.0.1:${this.port}/json/version`);
        return;
      } catch (error) {
        lastError = error;
        await sleep(200);
      }
    }

    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`Timed out waiting for Chrome DevTools${detail}`);
  }

  private async openForClient(socket: WebSocket): Promise<void> {
    try {
      await this.start();
      await this.ensureActiveCdp();
      await this.sendStatus(socket);
      // Replay the most recent frame so a reconnecting or late-joining client
      // sees the current page immediately. Screencast only emits frames on
      // change, so without this a client attaching to a static page would stay
      // blank until the page next repaints.
      if (this.lastFrameBuffer) {
        this.writeFrame(socket, this.lastFrameBuffer);
      }
      if (this.clients.size > 0) {
        await this.startScreencast();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.send(socket, { type: 'error', error: message });
      await this.broadcastStatus();
    }
  }

  private isRunning(): boolean {
    const proc = this.chromeProcess;
    return Boolean(proc && proc.exitCode == null && proc.signalCode == null);
  }

  // Make sure the browser-level connection and an active tab (+ its CDP) exist.
  private async ensureSession(): Promise<void> {
    await this.connectBrowserCdp();
    await this.ensureActiveTab();
  }

  private async connectBrowserCdp(): Promise<void> {
    if (this.browserCdp && this.browserCdpSocket && isOpen(this.browserCdpSocket)) {
      return;
    }
    if (this.browserCdpConnecting) {
      return this.browserCdpConnecting;
    }
    this.browserCdpConnecting = this.doConnectBrowserCdp();
    try {
      await this.browserCdpConnecting;
    } finally {
      this.browserCdpConnecting = null;
    }
  }

  private async doConnectBrowserCdp(): Promise<void> {
    if (!this.port) {
      throw new Error('Browser is not running');
    }
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
      `http://127.0.0.1:${this.port}/json/version`
    );
    if (!version.webSocketDebuggerUrl) {
      throw new Error('Chrome has no browser-level DevTools endpoint');
    }

    this.closeBrowserCdp();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await waitForSocketOpen(socket);

    const cdp = new CdpConnection(socket);
    cdp.onEvent = (message) => this.handleBrowserEvent(message);
    this.browserCdp = cdp;
    this.browserCdpSocket = socket;

    socket.on('close', () => {
      if (this.browserCdpSocket === socket) {
        this.browserCdp = null;
        this.browserCdpSocket = null;
      }
    });

    // Emits Target.targetCreated for every existing target, then keeps us posted
    // on creation/url/title changes and destruction.
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  }

  private async ensureActiveTab(): Promise<void> {
    await this.connectBrowserCdp();

    // Discovery events normally populate `tabs`; if they haven't landed yet (or
    // none exist), fall back to the HTTP target list, then create one.
    if (this.tabs.size === 0) {
      const targets = await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${this.port}/json/list`)
        .catch(() => [] as ChromeTarget[]);
      for (const target of targets) {
        if (target.type === 'page' && !target.url.startsWith('devtools://')) {
          this.tabs.set(target.id, { id: target.id, url: target.url, title: target.title ?? '' });
        }
      }
    }

    if (this.tabs.size === 0) {
      const created = await this.browserCdp?.send<{ targetId?: string }>('Target.createTarget', {
        url: 'about:blank',
      });
      const targetId = created?.targetId;
      if (!targetId) {
        throw new Error('Failed to open a browser tab');
      }
      this.tabs.set(targetId, { id: targetId, url: '', title: '' });
      await this.setActiveTab(targetId);
      this.ready = true;
      return;
    }

    if (!this.activeTargetId || !this.tabs.has(this.activeTargetId)) {
      const first = this.tabs.keys().next().value as string;
      await this.setActiveTab(first);
    } else if (!this.activeCdp || !this.activeCdpSocket || !isOpen(this.activeCdpSocket)) {
      await this.connectActiveCdp(this.activeTargetId);
    }
    this.ready = true;
  }

  private async ensureActiveCdp(): Promise<void> {
    if (this.activeCdp && this.activeCdpSocket && isOpen(this.activeCdpSocket)) {
      return;
    }
    if (this.activeConnecting) {
      return this.activeConnecting;
    }
    this.activeConnecting = (async () => {
      if (!this.activeTargetId || !this.tabs.has(this.activeTargetId)) {
        await this.ensureActiveTab();
      } else {
        await this.connectActiveCdp(this.activeTargetId);
      }
    })();
    try {
      await this.activeConnecting;
    } finally {
      this.activeConnecting = null;
    }
  }

  private async setActiveTab(targetId: string): Promise<void> {
    this.activeGeneration += 1;
    const generation = this.activeGeneration;
    this.activeTargetId = targetId;
    this.clearActiveFrame();
    // Drop the stale page from every client while the new tab's first frame is
    // still in flight.
    this.broadcast({ type: 'clear' });
    try {
      await this.connectActiveCdp(targetId, generation);
    } catch (error) {
      if (generation === this.activeGeneration) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await this.broadcastStatus();
  }

  private async connectActiveCdp(targetId: string, generation = this.activeGeneration): Promise<void> {
    if (!this.port) {
      throw new Error('Browser is not running');
    }

    this.disconnectActiveCdp();
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/devtools/page/${targetId}`);
    try {
      await waitForSocketOpen(socket);
    } catch (error) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      throw error;
    }

    // A newer switch started while we were connecting — discard this one.
    if (generation !== this.activeGeneration) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      return;
    }

    const cdp = new CdpConnection(socket);
    cdp.onEvent = (message) => this.handleActiveEvent(message);
    this.activeCdp = cdp;
    this.activeCdpSocket = socket;
    this.screencastStarted = false;

    socket.on('close', () => {
      if (this.activeCdpSocket === socket) {
        this.activeCdp = null;
        this.activeCdpSocket = null;
        this.screencastStarted = false;
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await this.applyAntiDetection(cdp);

    if (generation !== this.activeGeneration) {
      this.disconnectActiveCdp();
      return;
    }

    await this.applyViewport();
    if (this.clients.size > 0) {
      await this.startScreencast();
    }
  }

  /**
   * ヘッドレス Chrome がボット判定（Cloudflare の Managed Challenge / Turnstile 等）で
   * 誤検知されるのを減らす。完全な突破は保証できないが、代表的な自動化シグナルを消す:
   *  - UA から "HeadlessChrome" を除去（実バージョンに一致させる）
   *  - navigator.webdriver / languages / chrome / plugins / WebGL ベンダを通常ブラウザ相当に
   * 偽装スクリプトは addScriptToEvaluateOnNewDocument で「以後の」ページ生成時に毎回適用される。
   */
  private async applyAntiDetection(cdp: CdpConnection): Promise<void> {
    try {
      // 実際のブラウザ版に一致した UA を使う（バージョン不一致自体が検知シグナルになるため）。
      // ページセッションでは Browser.* が使えないことがあるので /json/version を優先。
      let userAgent = '';
      try {
        const info = await fetchJson<{ 'User-Agent'?: string }>(
          `http://127.0.0.1:${this.port}/json/version`
        );
        userAgent = (info['User-Agent'] || '').replace(/HeadlessChrome/gi, 'Chrome');
      } catch {
        // フォールバック: ページの navigator.userAgent を取得して整形。
        const r = await cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
          expression: 'navigator.userAgent',
          returnByValue: true,
        });
        userAgent = String(r.result?.value ?? '').replace(/HeadlessChrome/gi, 'Chrome');
      }
      const major = (userAgent.match(/Chrome\/(\d+)/) || [])[1] || '120';

      if (userAgent) {
        // acceptLanguage は q 値を付けない素のカンマ区切りにする。q 値を含めると
        // Chrome がさらに q を付与して "ja;q=0.9;q=0.9" のような実ブラウザが出さない
        // 不正なヘッダになり、それ自体がボット信号になる。
        const fullVersion = (userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || `${major}.0.0.0`;
        await cdp.send('Emulation.setUserAgentOverride', {
          userAgent,
          acceptLanguage: 'ja-JP,ja,en-US,en',
          platform: 'Linux x86_64',
          userAgentMetadata: {
            brands: [
              { brand: 'Not_A Brand', version: '24' },
              { brand: 'Chromium', version: major },
              { brand: 'Google Chrome', version: major },
            ],
            fullVersionList: [
              { brand: 'Not_A Brand', version: '24.0.0.0' },
              { brand: 'Chromium', version: fullVersion },
              { brand: 'Google Chrome', version: fullVersion },
            ],
            platform: 'Linux',
            platformVersion: '',
            architecture: 'x86',
            bitness: '64',
            wow64: false,
            model: '',
            mobile: false,
          },
        });
      }

      // 反検知は「正直で整合の取れた実Chrome」に寄せるのが正攻法。
      // navigator.languages を Accept-Language と一致させる程度に留め、
      // plugins や WebGL ベンダの「偽装」はしない（偽装は逆に不整合の検知信号になる）。
      // navigator.webdriver は起動フラグ --disable-blink-features=AutomationControlled で
      // 既に false 化されているが、保険として undefined を維持する。WebGL は実フラグ
      // (--use-angle=swiftshader 等) で実際に動作するので、レンダラは正直に SwiftShader を返す。
      const stealthSource = `
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        if (!window.chrome) { window.chrome = { runtime: {} }; }
        Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] });
        try {
          const _q = window.navigator.permissions && window.navigator.permissions.query;
          if (_q) {
            window.navigator.permissions.query = (p) =>
              p && p.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : _q(p);
          }
        } catch (e) { /* ignore */ }
      `;
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stealthSource });
    } catch {
      // 反検知設定は best-effort。失敗してもブラウジング自体は続行する。
    }
  }

  private async startScreencast(): Promise<void> {
    if (this.screencastStarted || !this.activeCdp) {
      return;
    }
    await this.applyViewport();
    await this.activeCdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 72,
      maxWidth: this.viewport.width,
      maxHeight: this.viewport.height,
      everyNthFrame: 1,
    });
    this.screencastStarted = true;
  }

  private async stopScreencast(): Promise<void> {
    if (!this.screencastStarted || !this.activeCdp) {
      return;
    }
    try {
      await this.activeCdp.send('Page.stopScreencast');
    } catch {
      // ignore
    } finally {
      this.screencastStarted = false;
    }
  }

  private async applyViewport(): Promise<void> {
    if (!this.activeCdp) {
      return;
    }
    await this.activeCdp.send('Emulation.setDeviceMetricsOverride', {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: this.viewport.width,
      screenHeight: this.viewport.height,
    });
  }

  private async resize(width: number, height: number): Promise<void> {
    const next = {
      width: coercePositiveInt(width, this.viewport.width, MIN_VIEWPORT.width, MAX_VIEWPORT.width),
      height: coercePositiveInt(height, this.viewport.height, MIN_VIEWPORT.height, MAX_VIEWPORT.height),
    };

    if (next.width === this.viewport.width && next.height === this.viewport.height) {
      return;
    }

    this.viewport = next;
    if (!this.activeCdp) {
      return;
    }

    await this.applyViewport();
    if (this.screencastStarted) {
      await this.activeCdp.send('Page.stopScreencast').catch(() => undefined);
      this.screencastStarted = false;
      await this.startScreencast();
    }
  }

  private async handleClientMessage(socket: WebSocket, data: RawData): Promise<void> {
    let message: BrowserClientMessage;
    try {
      const text = typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
      message = JSON.parse(text) as BrowserClientMessage;
    } catch {
      return;
    }

    try {
      if (message.type === 'resize') {
        await this.resize(message.width, message.height);
        return;
      }

      await this.start();

      if (message.type === 'new-tab') {
        await this.newTab(message.url);
        return;
      }

      if (message.type === 'close-tab') {
        await this.closeTab(message.targetId);
        return;
      }

      if (message.type === 'activate-tab') {
        await this.activateTab(message.targetId);
        return;
      }

      await this.ensureActiveCdp();

      if (message.type === 'navigate') {
        await this.navigate(message.url);
        return;
      }

      if (message.type === 'back') {
        await this.goHistory(-1);
        return;
      }

      if (message.type === 'forward') {
        await this.goHistory(1);
        return;
      }

      if (message.type === 'reload') {
        await this.activeCdp?.send('Page.reload', {});
        await this.refreshActivePageInfo();
        await this.broadcastStatus();
        return;
      }

      if (message.type === 'mouse') {
        await this.dispatchMouse(message);
        return;
      }

      if (message.type === 'key') {
        await this.dispatchKey(message);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = detail;
      this.send(socket, { type: 'error', error: detail });
      await this.broadcastStatus();
    }
  }

  private async dispatchMouse(message: Extract<BrowserClientMessage, { type: 'mouse' }>): Promise<void> {
    if (!this.activeCdp) return;
    await this.activeCdp.send('Input.dispatchMouseEvent', {
      type: message.eventType,
      x: coercePositiveInt(message.x, 0, 0, MAX_VIEWPORT.width),
      y: coercePositiveInt(message.y, 0, 0, MAX_VIEWPORT.height),
      button: message.button || 'none',
      clickCount: message.clickCount ?? 0,
      deltaX: message.deltaX ?? 0,
      deltaY: message.deltaY ?? 0,
      modifiers: message.modifiers ?? 0,
    });
  }

  private async dispatchKey(message: Extract<BrowserClientMessage, { type: 'key' }>): Promise<void> {
    if (!this.activeCdp) return;
    const windowsVirtualKeyCode = getWindowsVirtualKeyCode(message.key);
    await this.activeCdp.send('Input.dispatchKeyEvent', {
      type: message.eventType,
      key: message.key,
      code: message.code,
      text: message.eventType === 'keyDown' ? message.text || undefined : undefined,
      unmodifiedText: message.eventType === 'keyDown' ? message.text || undefined : undefined,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      modifiers: message.modifiers ?? 0,
    });
  }

  // Events from the active tab's page CDP connection.
  private handleActiveEvent(message: CdpResponse): void {
    if (message.method === 'Page.screencastFrame') {
      const params = message.params as PageScreencastFrameParams;
      const data = typeof params.data === 'string' ? params.data : null;
      const sessionId = typeof params.sessionId === 'number' ? params.sessionId : null;
      if (sessionId != null) {
        void this.activeCdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
      }
      if (data) {
        const buffer = Buffer.from(data, 'base64');
        this.lastFrameBuffer = buffer;
        this.broadcastBinary(buffer);
      }
      return;
    }

    if (message.method === 'Page.frameNavigated') {
      const frame = (message.params?.frame ?? null) as { parentId?: string; url?: string } | null;
      if (frame && !frame.parentId && frame.url) {
        const tab = this.activeTargetId ? this.tabs.get(this.activeTargetId) : null;
        if (tab) {
          tab.url = frame.url;
        }
        void this.refreshActivePageInfo().finally(() => {
          void this.broadcastStatus();
        });
      }
      return;
    }

    if (message.method === 'Page.loadEventFired') {
      void this.refreshActivePageInfo().finally(() => {
        void this.broadcastStatus();
      });
    }
  }

  // Events from the browser-level CDP connection: tab lifecycle.
  private handleBrowserEvent(message: CdpResponse): void {
    const method = message.method;
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = message.params?.targetInfo as ChromeTargetInfo | undefined;
      if (info) {
        this.upsertTab(info);
      }
      return;
    }
    if (method === 'Target.targetDestroyed') {
      const targetId = typeof message.params?.targetId === 'string' ? message.params.targetId : null;
      if (targetId) {
        this.removeTab(targetId);
      }
    }
  }

  private upsertTab(info: ChromeTargetInfo): void {
    if (info.type !== 'page') {
      return;
    }
    const url = info.url ?? '';
    if (url.startsWith('devtools://')) {
      return;
    }
    const prev = this.tabs.get(info.targetId);
    const isNew = !prev;
    const title = info.title ?? '';
    const changed = !prev || prev.url !== url || prev.title !== title;
    this.tabs.set(info.targetId, { id: info.targetId, url, title });

    if (isNew && this.ready && this.activeTargetId !== info.targetId) {
      // A page spawned a new tab/popup (target=_blank, window.open) — follow it
      // the way a normal browser does.
      void this.setActiveTab(info.targetId);
      return;
    }
    if (changed) {
      void this.broadcastStatus();
    }
  }

  private removeTab(targetId: string): void {
    if (!this.tabs.has(targetId)) {
      return;
    }
    const ids = [...this.tabs.keys()];
    const idx = ids.indexOf(targetId);
    this.tabs.delete(targetId);

    if (this.activeTargetId === targetId) {
      this.activeTargetId = null;
      this.disconnectActiveCdp();
      this.clearActiveFrame();
      this.broadcast({ type: 'clear' });
      const nextId = ids[idx + 1] ?? ids[idx - 1] ?? null;
      if (nextId && this.tabs.has(nextId)) {
        void this.setActiveTab(nextId);
        return; // setActiveTab broadcasts status
      }
    }
    void this.broadcastStatus();
  }

  private clearActiveFrame(): void {
    this.lastFrameBuffer = null;
    this.pendingFrames.clear();
  }

  private async refreshActivePageInfo(): Promise<void> {
    if (!this.activeCdp || !this.activeTargetId) {
      return;
    }
    try {
      const result = await this.activeCdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: '({ title: document.title, url: location.href })',
        returnByValue: true,
      });
      const value = result.result?.value as { title?: unknown; url?: unknown } | undefined;
      const tab = this.tabs.get(this.activeTargetId);
      if (value && tab) {
        if (typeof value.title === 'string') {
          tab.title = value.title;
        }
        if (typeof value.url === 'string') {
          tab.url = value.url;
        }
      }
    } catch {
      // Some internal pages do not allow Runtime.evaluate.
    }
  }

  private async sendStatus(socket: WebSocket): Promise<void> {
    this.send(socket, { type: 'status', status: await this.getStatus() });
  }

  private async broadcastStatus(): Promise<void> {
    const status = await this.getStatus();
    this.broadcast({ type: 'status', status });
  }

  private broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const socket of this.clients) {
      this.sendRaw(socket, text);
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    this.sendRaw(socket, JSON.stringify(payload));
  }

  private broadcastBinary(buffer: Buffer): void {
    for (const socket of this.clients) {
      this.queueFrameForClient(socket, buffer);
    }
  }

  // Per-client, backpressure-aware frame delivery. A fast client (e.g. on
  // localhost) drains instantly and receives every frame; a slow client (remote
  // or mobile) has only the *newest* frame held and gets it once its send buffer
  // clears. This trades frame rate for latency so motion stays smooth instead of
  // accumulating a backlog that stutters and then bursts.
  private queueFrameForClient(socket: WebSocket, buffer: Buffer): void {
    if (!isOpen(socket)) {
      this.pendingFrames.delete(socket);
      return;
    }
    if (socket.bufferedAmount > FRAME_COALESCE_THRESHOLD) {
      this.pendingFrames.set(socket, buffer);
      this.ensureFrameFlushTimer();
      return;
    }
    this.pendingFrames.delete(socket);
    this.writeFrame(socket, buffer);
  }

  private ensureFrameFlushTimer(): void {
    if (this.frameFlushTimer) {
      return;
    }
    this.frameFlushTimer = setInterval(() => this.flushPendingFrames(), FRAME_FLUSH_INTERVAL_MS);
    this.frameFlushTimer.unref?.();
  }

  private flushPendingFrames(): void {
    for (const [socket, buffer] of this.pendingFrames) {
      if (!isOpen(socket)) {
        this.pendingFrames.delete(socket);
        continue;
      }
      if (socket.bufferedAmount > FRAME_COALESCE_THRESHOLD) {
        continue; // still draining; keep holding the newest frame
      }
      this.pendingFrames.delete(socket);
      this.writeFrame(socket, buffer);
    }
    if (this.pendingFrames.size === 0 && this.frameFlushTimer) {
      clearInterval(this.frameFlushTimer);
      this.frameFlushTimer = null;
    }
  }

  private writeFrame(socket: WebSocket, buffer: Buffer): void {
    if (!isOpen(socket)) {
      return;
    }
    // Hard ceiling: a client this far behind is unrecoverable, so drop it.
    if (socket.bufferedAmount > MAX_CLIENT_BUFFERED_AMOUNT) {
      try {
        socket.close(1009, 'Browser stream overflow');
      } catch {
        // ignore
      }
      return;
    }
    try {
      socket.send(buffer, { binary: true });
    } catch {
      try {
        socket.close(1011, 'Browser stream send failed');
      } catch {
        // ignore
      }
    }
  }

  private sendRaw(socket: WebSocket, payload: string): void {
    if (!isOpen(socket)) {
      return;
    }
    if (socket.bufferedAmount > MAX_CLIENT_BUFFERED_AMOUNT) {
      try {
        socket.close(1009, 'Browser stream overflow');
      } catch {
        // ignore
      }
      return;
    }
    try {
      socket.send(payload);
    } catch {
      try {
        socket.close(1011, 'Browser stream send failed');
      } catch {
        // ignore
      }
    }
  }

  private disconnectActiveCdp(): void {
    const cdp = this.activeCdp;
    const socket = this.activeCdpSocket;
    this.activeCdp = null;
    this.activeCdpSocket = null;
    this.screencastStarted = false;
    if (cdp) {
      cdp.close();
    } else if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  private closeBrowserCdp(): void {
    const cdp = this.browserCdp;
    const socket = this.browserCdpSocket;
    this.browserCdp = null;
    this.browserCdpSocket = null;
    if (cdp) {
      cdp.close();
    } else if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  private openLogStream(): void {
    this.closeLogStream();
    const logPath = path.join(this.outputDir, 'deckide-browser.log');
    this.logStream = fsSync.createWriteStream(logPath, { flags: 'a' });
  }

  private closeLogStream(): void {
    const stream = this.logStream;
    this.logStream = null;
    if (stream) {
      stream.end();
    }
  }
}

function getWindowsVirtualKeyCode(key: string): number {
  const table: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Pause: 19,
    CapsLock: 20,
    Escape: 27,
    Space: 32,
    ' ': 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Insert: 45,
    Delete: 46,
    Meta: 91,
    ContextMenu: 93,
  };

  if (key in table) {
    return table[key];
  }

  const functionKey = /^F([1-9]|1[0-2])$/.exec(key);
  if (functionKey) {
    return 111 + Number(functionKey[1]);
  }

  if (key.length === 1) {
    // 英字・数字は ASCII コードがそのまま VK コードと一致する。
    if (/[a-zA-Z0-9]/.test(key)) {
      return key.toUpperCase().charCodeAt(0);
    }
    // 記号は charCodeAt だと VK コードと衝突する（例: '.' は ASCII 46 ＝ VK_DELETE
    // で、Delete キー扱いになり文字が消える）。US 配列の OEM コードに明示マップする。
    // shift 併用の記号（! @ # ... > など）も対応する物理キーの VK にマップ。
    const symbolToVk: Record<string, number> = {
      ')': 48, '!': 49, '@': 50, '#': 51, '$': 52,
      '%': 53, '^': 54, '&': 55, '*': 56, '(': 57,
      ';': 186, ':': 186,
      '=': 187, '+': 187,
      ',': 188, '<': 188,
      '-': 189, '_': 189,
      '.': 190, '>': 190,
      '/': 191, '?': 191,
      '`': 192, '~': 192,
      '[': 219, '{': 219,
      '\\': 220, '|': 220,
      ']': 221, '}': 221,
      "'": 222, '"': 222,
    };
    if (key in symbolToVk) {
      return symbolToVk[key];
    }
    // 不明な1文字は 0 を返す。text は別途渡しているので文字入力自体は成立し、
    // 特殊キーとして誤解釈されることもない。
    return 0;
  }

  return 0;
}
