/**
 * PtyClient - IPC client for the main server to communicate with the PTY daemon.
 * Uses newline-delimited JSON over a local TCP connection.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';

export interface DaemonTerminalInfo {
  id: string;
  bufferLength: number;
}

export class PtyClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private lineBuf = '';
  private _connected = false;
  private listCallback: ((terminals: DaemonTerminalInfo[]) => void) | null = null;
  private createCallbacks = new Map<string, (err?: string) => void>();

  get connected(): boolean {
    return this._connected;
  }

  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(port, '127.0.0.1');

      socket.once('connect', () => {
        this.socket = socket;
        this._connected = true;
        resolve();
      });

      socket.once('error', (err) => {
        if (!this._connected) {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      socket.on('data', (chunk) => {
        this.lineBuf += chunk.toString('utf8');
        const lines = this.lineBuf.split('\n');
        this.lineBuf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            this.handleMessage(JSON.parse(line));
          } catch { /* malformed message, ignore */ }
        }
      });

      socket.on('close', () => {
        this._connected = false;
        this.socket = null;
        this.emit('disconnect');
      });
    });
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'data':
        this.emit('data', msg.id as string, msg.data as string);
        break;
      case 'exit':
        this.emit('exit', msg.id as string, msg.code as number);
        break;
      case 'list_result': {
        const cb = this.listCallback;
        this.listCallback = null;
        cb?.(msg.terminals as DaemonTerminalInfo[]);
        break;
      }
      case 'created': {
        const cb = this.createCallbacks.get(msg.id);
        if (cb) {
          this.createCallbacks.delete(msg.id);
          cb();
        }
        break;
      }
      case 'error': {
        if (msg.id) {
          const cb = this.createCallbacks.get(msg.id);
          if (cb) {
            this.createCallbacks.delete(msg.id);
            cb(msg.message as string);
          }
        }
        break;
      }
    }
  }

  private send(msg: object): void {
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(JSON.stringify(msg) + '\n');
      } catch { /* socket may be closing */ }
    }
  }

  /** Spawn a new PTY in the daemon. Resolves when daemon confirms creation. */
  create(params: {
    id: string;
    shell: string;
    shellArgs: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.createCallbacks.delete(params.id);
        reject(new Error(`Timeout creating terminal ${params.id}`));
      }, 10_000);

      this.createCallbacks.set(params.id, (err) => {
        clearTimeout(timer);
        if (err) reject(new Error(err));
        else resolve();
      });
      this.send({ type: 'create', ...params });
    });
  }

  /** Send keyboard input to a terminal. */
  input(id: string, data: string): void {
    this.send({ type: 'input', id, data });
  }

  /** Resize a terminal. */
  resize(id: string, cols: number, rows: number): void {
    this.send({ type: 'resize', id, cols, rows });
  }

  /** Kill a terminal and remove it from the daemon. */
  kill(id: string): void {
    this.send({ type: 'kill', id });
  }

  /**
   * Subscribe to live data from a terminal.
   * The daemon will first send any buffered output since `bufferOffset`,
   * then stream all subsequent output.
   */
  attach(id: string, bufferOffset: number): void {
    this.send({ type: 'attach', id, bufferOffset });
  }

  /** Get a list of all terminals currently alive in the daemon. */
  list(): Promise<DaemonTerminalInfo[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.listCallback = null;
        resolve([]);
      }, 5_000);

      this.listCallback = (terminals) => {
        clearTimeout(timer);
        resolve(terminals);
      };
      this.send({ type: 'list' });
    });
  }

  destroy(): void {
    this.socket?.destroy();
  }
}
