import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

/**
 * The shared desktop (TigerVNC Xvnc + XFCE, see ops/desktop) runs as its own
 * systemd unit. DeckIDE only relays its private VNC Unix socket to signed-in
 * browsers, so restarting or updating DeckIDE never closes the GUI apps.
 */
export type SharedDesktopOptions = {
  socketPath: string;
  display: string;
  authority: string;
  unit: string;
};

export type SharedDesktopStatus = {
  installed: boolean;
  running: boolean;
  display: string;
  width: number | null;
  height: number | null;
  message?: string;
};

export const MAX_DESKTOP_TEXT = 4000;
const START_TIMEOUT_MS = 20_000;

export function sharedDesktopOptions(env: NodeJS.ProcessEnv = process.env): SharedDesktopOptions {
  const runtime = env.DECKIDE_DESKTOP_RUNTIME || '/run/deckide-desktop';
  return {
    socketPath: env.DECKIDE_DESKTOP_SOCKET || `${runtime}/vnc.sock`,
    display: env.DECKIDE_DESKTOP_DISPLAY || ':99',
    authority: env.DECKIDE_DESKTOP_XAUTHORITY || `${runtime}/Xauthority`,
    unit: env.DECKIDE_DESKTOP_UNIT || 'deckide-desktop.service',
  };
}

function runFile(file: string, args: string[], env: NodeJS.ProcessEnv = process.env,
  timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export class SharedDesktop {
  constructor(readonly options: SharedDesktopOptions = sharedDesktopOptions()) {}

  private xEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      DISPLAY: this.options.display,
      XAUTHORITY: this.options.authority,
    };
  }

  private async unitInstalled(): Promise<boolean> {
    try {
      return (await runFile('systemctl', ['show', '-p', 'LoadState', '--value', this.options.unit])).trim() === 'loaded';
    } catch {
      return false;
    }
  }

  private socketPresent(): boolean {
    try {
      return fs.statSync(this.options.socketPath).isSocket();
    } catch {
      return false;
    }
  }

  async status(): Promise<SharedDesktopStatus> {
    const base = { display: this.options.display, width: null, height: null };
    if (!this.socketPresent()) {
      const installed = await this.unitInstalled();
      return installed
        ? { ...base, installed, running: false }
        : { ...base, installed, running: false,
          message: `${this.options.unit} is not installed (run ops/desktop/install.sh).` };
    }
    try {
      const [width, height] = (await runFile('xdotool', ['getdisplaygeometry'], this.xEnv(), 3_000))
        .trim().split(/\s+/).map(Number);
      return { ...base, installed: true, running: true, width: width || null, height: height || null };
    } catch {
      return { ...base, installed: true, running: false, message: 'The desktop is starting or not responding.' };
    }
  }

  private async systemctl(action: 'start' | 'restart'): Promise<SharedDesktopStatus> {
    if (!(await this.unitInstalled()))
      throw httpError(`${this.options.unit} is not installed (run ops/desktop/install.sh).`, 503);
    await runFile('systemctl', [action, this.options.unit], process.env, START_TIMEOUT_MS);
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      const status = await this.status();
      if (status.running || Date.now() > deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  start(): Promise<SharedDesktopStatus> { return this.systemctl('start'); }

  /** Closes every GUI app on the desktop. */
  restart(): Promise<SharedDesktopStatus> { return this.systemctl('restart'); }

  /** Types text the browser keyboard cannot send as keys (Japanese, emoji). */
  async type(text: string): Promise<void> {
    if (!text || text.length > MAX_DESKTOP_TEXT) throw httpError('Invalid text', 400);
    if (!this.socketPresent()) throw httpError('The desktop is not running', 409);
    await runFile('xdotool', ['type', '--delay', '8', '--', text], this.xEnv(), 30_000);
  }

  /** A raw RFB byte stream to the desktop's VNC server. */
  connect(): net.Socket {
    return net.createConnection(this.options.socketPath);
  }
}
