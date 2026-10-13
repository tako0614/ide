import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type IPty } from 'node-pty';

/** Opt-in persistence; every instance owns a socket inside its runtime directory. */
export function terminalTmuxSocket(runtimeDir: string | undefined): string | null {
  if (!runtimeDir) return null;
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const resolved = fs.realpathSync(runtimeDir);
  const stat = fs.statSync(resolved);
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Terminal tmux runtime directory must be private and owned by this user');
  }
  const socket = path.join(resolved, 'tmux.sock');
  try {
    if (fs.lstatSync(socket).isSymbolicLink()) throw new Error('Terminal tmux socket must not be a symlink');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return socket;
}

function sessionName(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid persistent terminal id');
  return `deckide-${id}`;
}

function tmux(socket: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  });
}

export function terminalTmuxStatus(socket: string, id: string): 'live' | 'missing' | 'unavailable' {
  try {
    tmux(socket, ['has-session', '-t', `=${sessionName(id)}`]);
    return 'live';
  } catch (error) {
    // A timeout, missing socket or permissions error cannot prove that the
    // pane exited. Only tmux's explicit session lookup failure is definitive.
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    return /can't find session:/.test(stderr) ? 'missing' : 'unavailable';
  }
}

export function hasTerminalTmuxSession(socket: string, id: string): boolean {
  return terminalTmuxStatus(socket, id) === 'live';
}

/** Used only for an explicit user-requested terminal/deck deletion. */
export function deleteTerminalTmuxSession(socket: string, id: string): void {
  if (terminalTmuxStatus(socket, id) === 'missing') return;
  tmux(socket, ['kill-session', '-t', `=${sessionName(id)}`]);
}

export function openTerminalProcess(options: {
  id: string; shell: string; args: string[]; cwd: string;
  cols: number; rows: number; env: Record<string, string>;
  socket: string | null; restore?: boolean;
}): { pty: IPty; kill: () => void; detach: () => void } {
  const { id, shell, args, cwd, cols, rows, socket, restore } = options;
  const env = { ...options.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  if (!socket) {
    const pty = spawn(shell, args, {
      cwd, cols, rows, env, encoding: null,
      ...(process.platform === 'win32' ? { useConpty: true } : {}),
    } as any);
    return { pty, kill: () => pty.kill(), detach: () => pty.kill() };
  }

  const name = sessionName(id);
  if (!restore) {
    // Pass per-terminal environment explicitly: a running tmux server otherwise
    // retains the first terminal's DECKIDE_* values for subsequent sessions.
    const environment = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    tmux(socket, ['new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows),
      '-c', cwd, ...environment, '--', shell, ...args], env);
  } else if (!hasTerminalTmuxSession(socket, id)) {
    throw new Error('Persistent terminal no longer exists');
  }
  const pty = spawn('tmux', ['-S', socket, 'attach-session', '-t', `=${name}`], {
    // The shell keeps its original cwd. A moved deck's root may have vanished;
    // attaching the display must not depend on, or change, that shell cwd.
    cwd: path.dirname(socket), cols, rows, env, encoding: null,
  } as any);
  return {
    pty,
    // Only explicit terminal/deck deletion terminates the named session.
    kill: () => deleteTerminalTmuxSession(socket, id),
    // The PTY hosts a display client, not the shell. Closing it leaves the pane alive.
    detach: () => pty.kill(),
  };
}
