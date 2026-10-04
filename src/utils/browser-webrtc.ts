import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import type { BrowserWebRtcStatus } from '../shared/types.js';
import {
  AGENT_BROWSER_WEBRTC,
  AGENT_BROWSER_WEBRTC_CODEC,
  AGENT_BROWSER_WEBRTC_BITRATE,
  AGENT_BROWSER_WEBRTC_FPS,
  AGENT_BROWSER_DISPLAY,
  AGENT_BROWSER_WEBRTC_ICE_SERVERS,
  AGENT_BROWSER_CDP_PORT,
} from '../config.js';

const execFileAsync = promisify(execFile);

// werift is an optionalDependency and is only loaded when the WebRTC flag is on,
// so a missing/broken install degrades to "WebRTC unavailable → JPEG" instead of
// crashing the server. Typed loosely on purpose to avoid a hard type dependency
// on an optional module.
type WeriftModule = typeof import('werift');
let weriftPromise: Promise<WeriftModule | null> | null = null;
function loadWerift(): Promise<WeriftModule | null> {
  if (!weriftPromise) {
    weriftPromise = import('werift').then((m) => m).catch((error) => {
      console.error('[browser-webrtc] werift unavailable:', error instanceof Error ? error.message : error);
      return null;
    });
  }
  return weriftPromise;
}

// The relay only needs these two capabilities from AgentBrowserService; declaring
// them as an interface (implemented structurally) avoids a circular type import.
export interface WebRtcHost {
  isBrowserRunning(): boolean;
  // Position+size the active tab's OS window on the X display so the captured
  // framebuffer region maps 1:1 to the page. Best-effort.
  setActiveWindowBounds(left: number, top: number, width: number, height: number): Promise<void>;
  // Pin the active tab's render viewport (device metrics) to the captured
  // framebuffer size so page coordinates equal captured pixels. Best-effort.
  pinViewport(width: number, height: number): Promise<void>;
}

type SignalMessage =
  | { type: 'webrtc-offer'; sdp: string }
  | { type: 'webrtc-ice'; candidate: unknown }
  | { type: string; [key: string]: unknown };

type Viewer = {
  socket: WebSocket;
  // Loosely typed: concrete werift classes are only known at runtime.
  pc: any;
  track: any;
};

const DEFAULT_SIZE = { width: 1280, height: 720 };

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

async function resolveExecutable(envName: string, names: string[]): Promise<string | null> {
  const configured = process.env[envName];
  if (configured) {
    return (await pathExists(configured)) ? configured : null;
  }
  return findInPath(names);
}

// Discover the X display + Xauthority that Chrome is actually using. xvfb-run
// picks the display number for the Chrome child and exports DISPLAY/XAUTHORITY
// only into that child's environment, so the server process can't read them from
// its own env — we recover them from /proc/<pid>/environ instead.
async function resolveXEnv(cdpPort?: number): Promise<{ display: string; xauthority: string | null } | null> {
  if (AGENT_BROWSER_DISPLAY) {
    return { display: AGENT_BROWSER_DISPLAY, xauthority: process.env.XAUTHORITY ?? null };
  }
  let pids: string[];
  try {
    pids = (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name));
  } catch {
    // Not Linux / no procfs.
    return process.env.DISPLAY ? { display: process.env.DISPLAY, xauthority: process.env.XAUTHORITY ?? null } : null;
  }

  const portToken = cdpPort ? `--remote-debugging-port=${cdpPort}` : null;
  let fallback: { display: string; xauthority: string | null } | null = null;
  for (const pid of pids) {
    let comm = '';
    try {
      comm = await fs.readFile(`/proc/${pid}/comm`, 'utf8');
    } catch {
      continue;
    }
    if (!/chrome|chromium/i.test(comm)) {
      continue;
    }
    let environ: string;
    try {
      environ = await fs.readFile(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue;
    }
    const vars = environ.split('\0');
    const display = vars.find((v) => v.startsWith('DISPLAY='))?.slice('DISPLAY='.length);
    if (!display) {
      continue;
    }
    const xauthority = vars.find((v) => v.startsWith('XAUTHORITY='))?.slice('XAUTHORITY='.length) ?? null;
    const candidate = { display, xauthority };
    if (!portToken) {
      return candidate;
    }
    // With multiple Chrome instances, prefer the one bound to OUR CDP port so we
    // capture (and control) the same browser. Fall back to the first found.
    let cmdline = '';
    try {
      cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ');
    } catch {
      // ignore
    }
    if (cmdline.includes(portToken)) {
      return candidate;
    }
    if (!fallback) {
      fallback = candidate;
    }
  }
  return fallback ?? (process.env.DISPLAY ? { display: process.env.DISPLAY, xauthority: process.env.XAUTHORITY ?? null } : null);
}

// Query the real screen geometry of the display so x11grab captures the exact
// region (a mismatch makes ffmpeg error or grab garbage).
async function resolveScreenSize(env: NodeJS.ProcessEnv): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFileAsync('xdpyinfo', [], { env, timeout: 2000, maxBuffer: 256 * 1024 });
    const match = stdout.match(/dimensions:\s+(\d+)x(\d+)/);
    if (match) {
      return { width: Number(match[1]), height: Number(match[2]) };
    }
  } catch {
    // xdpyinfo missing or failed — fall back to the configured Xvfb size.
  }
  return { ...DEFAULT_SIZE };
}

function parseIceServers(): Array<{ urls: string }> {
  if (!AGENT_BROWSER_WEBRTC_ICE_SERVERS.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(AGENT_BROWSER_WEBRTC_ICE_SERVERS);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

export class BrowserWebRtcRelay {
  private readonly viewers = new Map<WebSocket, Viewer>();
  // Every connected viewer's video track; the single encoder's RTP is fanned out
  // to all of them (one encoder, N peers).
  private readonly tracks = new Set<any>();

  private encoder: ChildProcessWithoutNullStreams | null = null;
  private udp: dgram.Socket | null = null;
  private startingEncoder: Promise<void> | null = null;

  private display: string | null = null;
  private size = { ...DEFAULT_SIZE };
  private lastError: string | undefined;

  constructor(private readonly host: WebRtcHost) {}

  async getStatus(): Promise<BrowserWebRtcStatus> {
    let available = AGENT_BROWSER_WEBRTC;
    let reason: string | undefined;

    if (!AGENT_BROWSER_WEBRTC) {
      reason = 'WebRTC streaming is disabled (set AGENT_BROWSER_WEBRTC=true)';
    } else {
      const werift = await loadWerift();
      const ffmpeg = await resolveExecutable('AGENT_BROWSER_FFMPEG', ['ffmpeg']);
      const xenv = await resolveXEnv(AGENT_BROWSER_CDP_PORT);
      if (!werift) {
        available = false;
        reason = 'werift is not installed (npm install werift)';
      } else if (!ffmpeg) {
        available = false;
        reason = 'ffmpeg is not installed or AGENT_BROWSER_FFMPEG is not set';
      } else if (!xenv) {
        available = false;
        reason = 'No X display found to capture (WebRTC needs an Xvfb/headful display)';
      }
    }

    return {
      available,
      running: Boolean(this.encoder),
      clients: this.viewers.size,
      codec: AGENT_BROWSER_WEBRTC_CODEC,
      display: this.display,
      width: this.size.width,
      height: this.size.height,
      reason,
      error: this.lastError,
    };
  }

  attachWebSocket(socket: WebSocket): void {
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      void this.handleSignal(socket, data.toString());
    });
    socket.on('close', () => this.removeViewer(socket));
    socket.on('error', () => this.removeViewer(socket));
    void this.sendStatus(socket);
  }

  async stop(): Promise<void> {
    for (const socket of [...this.viewers.keys()]) {
      this.removeViewer(socket);
    }
    await this.stopEncoder();
  }

  private async handleSignal(socket: WebSocket, raw: string): Promise<void> {
    let message: SignalMessage;
    try {
      message = JSON.parse(raw) as SignalMessage;
    } catch {
      return;
    }

    try {
      if (message.type === 'webrtc-offer' && typeof message.sdp === 'string') {
        await this.handleOffer(socket, message.sdp);
        return;
      }
      if (message.type === 'webrtc-ice' && message.candidate) {
        const viewer = this.viewers.get(socket);
        if (viewer) {
          await viewer.pc.addIceCandidate(message.candidate).catch(() => undefined);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = detail;
      this.send(socket, { type: 'webrtc-error', error: detail });
    }
  }

  private async handleOffer(socket: WebSocket, sdp: string): Promise<void> {
    const werift = await loadWerift();
    if (!werift) {
      throw new Error('werift is not installed');
    }
    if (!this.host.isBrowserRunning()) {
      throw new Error('Browser is not running');
    }

    // Tear down any prior peer on this socket (renegotiation / reconnect).
    this.removeViewer(socket, { keepSocket: true });

    const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } = werift;
    const pc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: 'video/VP8',
            clockRate: 90000,
            payloadType: 96,
          }),
        ],
      },
      iceServers: parseIceServers(),
    });

    const track = new MediaStreamTrack({ kind: 'video' });
    pc.addTransceiver(track, { direction: 'sendonly' });

    const viewer: Viewer = { socket, pc, track };
    this.viewers.set(socket, viewer);
    this.tracks.add(track);

    pc.connectionStateChange.subscribe((state: string) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.removeViewer(socket);
      }
    });

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitIceComplete(pc);

    // Bring up the encoder once we actually have a consumer.
    await this.ensureEncoder();

    if (!isOpen(socket)) {
      this.removeViewer(socket);
      return;
    }
    this.send(socket, { type: 'webrtc-answer', sdp: pc.localDescription.sdp });
    await this.broadcastStatus();
  }

  // Non-trickle ICE: wait for host candidates to gather (instant on same-host /
  // LAN), then send a complete answer. Simpler and robust for the common case;
  // trickle can be layered on later for remote/NAT.
  private waitIceComplete(pc: any): Promise<void> {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
      pc.iceGatheringStateChange.subscribe((state: string) => {
        if (state === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  private async ensureEncoder(): Promise<void> {
    if (this.encoder) {
      return;
    }
    if (this.startingEncoder) {
      return this.startingEncoder;
    }
    this.startingEncoder = this.startEncoder();
    try {
      await this.startingEncoder;
    } finally {
      this.startingEncoder = null;
    }
  }

  private async startEncoder(): Promise<void> {
    this.lastError = undefined;
    const ffmpeg = await resolveExecutable('AGENT_BROWSER_FFMPEG', ['ffmpeg']);
    if (!ffmpeg) {
      throw new Error('ffmpeg is required for WebRTC streaming');
    }
    const xenv = await resolveXEnv(AGENT_BROWSER_CDP_PORT);
    if (!xenv) {
      throw new Error('No X display found to capture');
    }
    this.display = xenv.display;

    const captureEnv: NodeJS.ProcessEnv = { ...process.env, DISPLAY: xenv.display };
    if (xenv.xauthority) {
      captureEnv.XAUTHORITY = xenv.xauthority;
    }
    this.size = await resolveScreenSize(captureEnv);

    // Size the page's OS window to fill the captured screen so the framebuffer
    // region maps 1:1 to page coordinates. Best-effort; ignore failures.
    await this.host.setActiveWindowBounds(0, 0, this.size.width, this.size.height).catch(() => undefined);
    // Pin the page render size to the framebuffer so input coords map 1:1.
    await this.host.pinViewport(this.size.width, this.size.height).catch(() => undefined);

    // Bind an ephemeral UDP port; ffmpeg sends RTP here and we fan each packet
    // out to every viewer's track (no re-encode in werift).
    const udp = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '127.0.0.1', () => {
        udp.off('error', reject);
        resolve();
      });
    });
    this.udp = udp;
    const port = udp.address().port;

    udp.on('message', (packet) => {
      for (const track of this.tracks) {
        try {
          track.writeRtp(packet);
        } catch {
          // A dead track will be cleaned up on its peer's close event.
        }
      }
    });

    const fps = Math.max(1, AGENT_BROWSER_WEBRTC_FPS);
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-nostdin',
      '-f', 'x11grab',
      '-draw_mouse', '0',
      '-framerate', String(fps),
      '-video_size', `${this.size.width}x${this.size.height}`,
      '-i', `${xenv.display}+0,0`,
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-b:v', AGENT_BROWSER_WEBRTC_BITRATE,
      '-maxrate', AGENT_BROWSER_WEBRTC_BITRATE,
      '-bufsize', AGENT_BROWSER_WEBRTC_BITRATE,
      '-g', String(fps * 2),
      '-error-resilient', '1',
      '-auto-alt-ref', '0',
      '-an',
      '-payload_type', '96',
      '-ssrc', '1',
      '-f', 'rtp',
      `rtp://127.0.0.1:${port}`,
    ];

    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], env: captureEnv });
    this.encoder = proc;

    let stderrTail = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    proc.once('exit', (code, signal) => {
      if (this.encoder === proc) {
        this.encoder = null;
        this.closeUdp();
        if (this.viewers.size > 0) {
          this.lastError = `WebRTC encoder exited (${signal ?? code ?? 'unknown'}): ${stderrTail.trim()}`;
          void this.broadcastStatus();
        }
      }
    });
    proc.once('error', (error) => {
      if (this.encoder === proc) {
        this.encoder = null;
        this.closeUdp();
      }
      this.lastError = error.message;
      void this.broadcastStatus();
    });

    await this.broadcastStatus();
  }

  private async stopEncoder(): Promise<void> {
    const proc = this.encoder;
    this.encoder = null;
    if (proc && proc.exitCode == null && proc.signalCode == null) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }, 2000);
        killTimer.unref?.();
        proc.once('exit', () => { clearTimeout(killTimer); resolve(); });
        try { proc.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
      });
    }
    this.closeUdp();
  }

  private closeUdp(): void {
    const udp = this.udp;
    this.udp = null;
    if (udp) {
      try { udp.close(); } catch { /* ignore */ }
    }
  }

  private removeViewer(socket: WebSocket, options: { keepSocket?: boolean } = {}): void {
    const viewer = this.viewers.get(socket);
    if (viewer) {
      this.viewers.delete(socket);
      this.tracks.delete(viewer.track);
      try { viewer.track.stop(); } catch { /* ignore */ }
      try { void viewer.pc.close(); } catch { /* ignore */ }
    }
    if (!options.keepSocket && isOpen(socket)) {
      try { socket.close(); } catch { /* ignore */ }
    }
    // Last viewer gone → stop the shared encoder.
    if (this.viewers.size === 0) {
      void this.stopEncoder();
    }
  }

  private async sendStatus(socket: WebSocket): Promise<void> {
    this.send(socket, { type: 'webrtc-status', status: await this.getStatus() });
  }

  private async broadcastStatus(): Promise<void> {
    const status = await this.getStatus();
    for (const socket of this.viewers.keys()) {
      this.send(socket, { type: 'webrtc-status', status });
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (!isOpen(socket)) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      try { socket.close(); } catch { /* ignore */ }
    }
  }
}
