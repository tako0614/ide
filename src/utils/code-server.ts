import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Workspace } from '../types.js';
import type { CodeServerStatus } from '../shared/types.js';
import { dataDir } from '../config.js';

const IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const START_TIMEOUT_MS = 30_000;
const REAP_INTERVAL_MS = 60_000;

type Instance = {
  wsId: string;
  proc: ChildProcessWithoutNullStreams;
  port: number;
  lastActive: number;
  ready: Promise<void>;
  startedAt: number;
  error?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findInPath(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('Could not get a free port'))));
    });
  });
}

/**
 * Manages per-workspace code-server child processes — the "power editor" surface.
 * Mirrors AgentBrowserService: spawn on demand, supervise, poll readiness, and
 * idle-reap (auto-stop, not auto-restart). One instance per workspace id.
 */
export class CodeServerService {
  private readonly instances = new Map<string, Instance>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  // Directory layout under ~/.deckide/code-server (set by config.dataDir).
  private readonly root = path.join(dataDir, 'code-server');

  constructor(private readonly workspaces: Map<string, Workspace>) {}

  // Resolve the code-server executable: explicit env → standalone install under
  // dataDir → PATH. Returns null when not acquired.
  async resolveBin(): Promise<string | null> {
    const configured = process.env.DECKIDE_CODE_SERVER_BIN;
    if (configured) {
      return (await pathExists(configured)) ? configured : null;
    }
    const standalone = path.join(this.root, 'bin', 'code-server');
    if (await pathExists(standalone)) {
      return standalone;
    }
    return findInPath('code-server');
  }

  async isAcquired(): Promise<boolean> {
    return (await this.resolveBin()) !== null;
  }

  async getStatus(wsId?: string): Promise<CodeServerStatus> {
    const bin = await this.resolveBin();
    const instance = wsId ? this.instances.get(wsId) : undefined;
    return {
      available: bin !== null,
      acquired: bin !== null,
      binPath: bin,
      running: instance ? instance.proc.exitCode == null : false,
      instances: this.instances.size,
      wsId: wsId ?? null,
      reason: bin ? undefined : 'code-server is not installed (run: deckide codeserver install)',
      error: instance?.error,
    };
  }

  // Ensure an instance for this workspace is running and ready; return its port.
  async ensure(wsId: string): Promise<number> {
    const existing = this.instances.get(wsId);
    if (existing && existing.proc.exitCode == null) {
      existing.lastActive = Date.now();
      await existing.ready;
      return existing.port;
    }
    if (existing) {
      this.instances.delete(wsId);
    }

    const workspace = this.workspaces.get(wsId);
    if (!workspace) {
      throw new Error(`Unknown workspace: ${wsId}`);
    }
    const bin = await this.resolveBin();
    if (!bin) {
      throw new Error('code-server is not installed (run: deckide codeserver install)');
    }

    const port = await getFreePort();
    const userDataDir = path.join(this.root, 'user', wsId);
    const extensionsDir = path.join(this.root, 'ext');
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });

    // Per-instance config file so the user's global ~/.config/code-server/config.yaml
    // (which may set auth/bind-addr) can never override our flags.
    const configPath = path.join(userDataDir, 'config.yaml');
    await fs.writeFile(
      configPath,
      `bind-addr: 127.0.0.1:${port}\nauth: none\ncert: false\n`,
      'utf8'
    );

    // code-server honors the PORT env var ahead of --bind-addr, so strip it
    // (Deck IDE's own PORT would otherwise collide).
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.PORT;

    const proc = spawn(
      bin,
      [
        '--config', configPath,
        '--auth', 'none', // Deck IDE owns auth at the same-origin proxy.
        '--disable-telemetry',
        '--disable-update-check',
        '--bind-addr', `127.0.0.1:${port}`,
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        workspace.path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv }
    );

    let stderrTail = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    proc.stdout.resume();

    const instance: Instance = {
      wsId,
      proc,
      port,
      lastActive: Date.now(),
      startedAt: Date.now(),
      ready: this.waitForReady(port, proc, () => stderrTail),
    };
    this.instances.set(wsId, instance);

    proc.once('exit', (code, signal) => {
      const current = this.instances.get(wsId);
      if (current === instance) {
        this.instances.delete(wsId);
      }
      if (code !== 0 && code != null) {
        console.error(`[code-server] ${wsId} exited (${signal ?? code}): ${stderrTail.trim()}`);
      }
    });
    proc.once('error', (error) => {
      instance.error = error.message;
    });

    this.ensureReaper();

    try {
      await instance.ready;
    } catch (error) {
      await this.stop(wsId);
      throw error;
    }
    return port;
  }

  private async waitForReady(port: number, proc: ChildProcessWithoutNullStreams, tail: () => string): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode != null) {
        throw new Error(`code-server exited before becoming ready: ${tail().trim()}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          return;
        }
      } catch {
        // not up yet
      }
      await sleep(250);
    }
    throw new Error('Timed out waiting for code-server to become ready');
  }

  // Returns the running port for a ready instance (for the HTTP proxy), bumping
  // its idle timer. Starts the instance if needed.
  async portFor(wsId: string): Promise<number> {
    return this.ensure(wsId);
  }

  touch(wsId: string): void {
    const instance = this.instances.get(wsId);
    if (instance) {
      instance.lastActive = Date.now();
    }
  }

  // Proxy a WebSocket upgrade for a ready instance to its loopback port. The
  // prefix /codeserver/:wsId has already been stripped from req.url by the caller.
  proxyUpgrade(wsId: string, req: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const instance = this.instances.get(wsId);
    if (!instance || instance.proc.exitCode != null) {
      clientSocket.destroy();
      return;
    }
    instance.lastActive = Date.now();

    const upstream = net.connect(instance.port, '127.0.0.1', () => {
      const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
      const headers = req.headers;
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headerLines.push(`${key}: ${v}`);
        } else {
          headerLines.push(`${key}: ${value}`);
        }
      }
      upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const teardown = () => {
      try { upstream.destroy(); } catch { /* ignore */ }
      try { clientSocket.destroy(); } catch { /* ignore */ }
    };
    upstream.on('error', teardown);
    clientSocket.on('error', teardown);
  }

  async stop(wsId: string): Promise<void> {
    const instance = this.instances.get(wsId);
    if (!instance) return;
    this.instances.delete(wsId);
    const proc = instance.proc;
    if (proc.exitCode == null && proc.signalCode == null) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }, 3000);
        killTimer.unref?.();
        proc.once('exit', () => { clearTimeout(killTimer); resolve(); });
        try { proc.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
      });
    }
  }

  async stopAll(): Promise<void> {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    await Promise.all([...this.instances.keys()].map((wsId) => this.stop(wsId)));
  }

  private ensureReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [wsId, instance] of this.instances) {
        if (now - instance.lastActive > IDLE_TIMEOUT_MS) {
          void this.stop(wsId);
        }
      }
      if (this.instances.size === 0 && this.reaper) {
        clearInterval(this.reaper);
        this.reaper = null;
      }
    }, REAP_INTERVAL_MS);
    this.reaper.unref?.();
  }
}
