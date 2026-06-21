import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import type { BrowserAudioStatus } from '../shared/types.js';

const execFileAsync = promisify(execFile);
const AUDIO_CLIENT_BUFFER_LIMIT = 2 * 1024 * 1024;

type AudioCaptureProcess = ReturnType<typeof spawn>;

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
    if (await pathExists(configured)) {
      return configured;
    }
    throw new Error(`${envName} does not exist: ${configured}`);
  }
  return findInPath(names);
}

async function runText(command: string, args: string[], timeoutMs = 2000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 128 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function resolvePulseSource(pactlPath: string | null): Promise<string | null> {
  if (process.env.AGENT_BROWSER_AUDIO_SOURCE) {
    return process.env.AGENT_BROWSER_AUDIO_SOURCE;
  }

  if (!pactlPath) {
    return null;
  }

  const defaultSink = await runText(pactlPath, ['get-default-sink']);
  const sourceList = await runText(pactlPath, ['list', 'short', 'sources']);
  if (!sourceList) {
    return defaultSink ? `${defaultSink}.monitor` : null;
  }

  const sources = sourceList
    .split('\n')
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean);

  if (defaultSink) {
    const defaultMonitor = `${defaultSink}.monitor`;
    if (sources.includes(defaultMonitor)) {
      return defaultMonitor;
    }
  }

  return sources.find((source) => source.endsWith('.monitor')) ?? null;
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

export class BrowserAudioRelay {
  private readonly clients = new Set<WebSocket>();
  private captureProcess: AudioCaptureProcess | null = null;
  private starting: Promise<void> | null = null;
  private lastError: string | undefined;
  private ffmpegPath: string | null = null;
  private audioSource: string | null = null;

  async getStatus(): Promise<BrowserAudioStatus> {
    const ffmpegPath = await resolveExecutable('AGENT_BROWSER_FFMPEG', ['ffmpeg']).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    });
    const pactlPath = await resolveExecutable('AGENT_BROWSER_PACTL', ['pactl']).catch(() => null);
    const source = await resolvePulseSource(pactlPath);

    let available = Boolean(ffmpegPath && source);
    let reason: string | undefined;
    if (!ffmpegPath) {
      available = false;
      reason = 'ffmpeg is not installed or AGENT_BROWSER_FFMPEG is not set';
    } else if (!source) {
      available = false;
      reason = 'PulseAudio monitor source was not found. Set AGENT_BROWSER_AUDIO_SOURCE if needed';
    }

    return {
      available,
      running: this.isRunning(),
      clients: this.clients.size,
      source,
      ffmpegPath,
      mimeType: 'audio/webm; codecs="opus"',
      reason,
      error: this.lastError,
    };
  }

  attachWebSocket(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('close', () => {
      this.clients.delete(socket);
      if (this.clients.size === 0) {
        void this.stop();
      }
    });
    socket.on('error', () => {
      this.clients.delete(socket);
      if (this.clients.size === 0) {
        void this.stop();
      }
    });

    void this.openForClient(socket);
  }

  async stop(): Promise<void> {
    const proc = this.captureProcess;
    this.captureProcess = null;
    if (proc && proc.exitCode == null && proc.signalCode == null) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 2000);
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
    await this.broadcastStatus();
  }

  private async openForClient(socket: WebSocket): Promise<void> {
    await this.sendStatus(socket);
    try {
      await this.start();
      await this.sendStatus(socket);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.send(socket, { type: 'audio-error', error: message });
      await this.broadcastStatus();
    }
  }

  private async start(): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startCapture();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startCapture(): Promise<void> {
    this.lastError = undefined;
    this.ffmpegPath = await resolveExecutable('AGENT_BROWSER_FFMPEG', ['ffmpeg']);
    if (!this.ffmpegPath) {
      throw new Error('ffmpeg is required for browser audio streaming');
    }

    const pactlPath = await resolveExecutable('AGENT_BROWSER_PACTL', ['pactl']).catch(() => null);
    this.audioSource = await resolvePulseSource(pactlPath);
    if (!this.audioSource) {
      throw new Error('PulseAudio monitor source was not found. Set AGENT_BROWSER_AUDIO_SOURCE to a monitor source');
    }

    const proc = spawn(this.ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostdin',
      '-f',
      'pulse',
      '-i',
      this.audioSource,
      '-vn',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-application',
      'audio',
      '-f',
      'webm',
      'pipe:1',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    this.captureProcess = proc;

    let stderrTail = '';
    const stderrChunks: string[] = [];
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderrChunks.push(chunk);
      stderrTail = stderrChunks.join('').slice(-2000);
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      this.broadcastAudio(chunk);
    });

    proc.once('exit', (code, signal) => {
      if (this.captureProcess === proc) {
        this.captureProcess = null;
      }
      if (this.clients.size > 0) {
        this.lastError = `Audio capture exited (${signal ?? code ?? 'unknown'}): ${stderrTail.trim()}`;
        this.broadcast({
          type: 'audio-error',
          error: this.lastError,
        });
        void this.broadcastStatus();
      }
    });

    proc.once('error', (error) => {
      this.lastError = error.message;
      if (this.captureProcess === proc) {
        this.captureProcess = null;
      }
      this.broadcast({ type: 'audio-error', error: error.message });
      void this.broadcastStatus();
    });

    try {
      await this.waitForFirstChunk(proc);
    } catch (error) {
      if (this.captureProcess === proc) {
        this.captureProcess = null;
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      throw error;
    }
    await this.broadcastStatus();
  }

  private waitForFirstChunk(proc: AudioCaptureProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('Timed out waiting for browser audio stream'));
      }, 5000);
      timer.unref?.();

      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.off('exit', onExit);
        proc.off('error', onError);
      };

      const onData = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(`Audio capture exited before streaming (${signal ?? code ?? 'unknown'})`));
      };
      const onError = (error: Error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };

      proc.stdout.once('data', onData);
      proc.once('exit', onExit);
      proc.once('error', onError);
    });
  }

  private isRunning(): boolean {
    const proc = this.captureProcess;
    return Boolean(proc && proc.exitCode == null && proc.signalCode == null);
  }

  private broadcastAudio(chunk: Buffer): void {
    for (const socket of this.clients) {
      if (!isOpen(socket)) {
        continue;
      }
      if (socket.bufferedAmount > AUDIO_CLIENT_BUFFER_LIMIT) {
        try {
          socket.close(1009, 'Browser audio overflow');
        } catch {
          // ignore
        }
        continue;
      }
      try {
        socket.send(chunk, { binary: true });
      } catch {
        try {
          socket.close(1011, 'Browser audio send failed');
        } catch {
          // ignore
        }
      }
    }
  }

  private async sendStatus(socket: WebSocket): Promise<void> {
    this.send(socket, { type: 'audio-status', status: await this.getStatus() });
  }

  private async broadcastStatus(): Promise<void> {
    const status = await this.getStatus();
    this.broadcast({ type: 'audio-status', status });
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

  private sendRaw(socket: WebSocket, payload: string): void {
    if (!isOpen(socket)) {
      return;
    }
    try {
      socket.send(payload);
    } catch {
      try {
        socket.close(1011, 'Browser audio control send failed');
      } catch {
        // ignore
      }
    }
  }
}
