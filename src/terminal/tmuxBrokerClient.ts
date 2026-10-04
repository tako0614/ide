/** Synchronous adapter bridge to the independent tmux creation broker. */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024;
const MAX_UNIX_SOCKET_BYTES = 107;
const GENERIC_ERROR = 'tmux creation broker unavailable or creation failed; inspect pending terminal identity';

function checkedSocketPath(): string {
  const socketPath = process.env.DECKIDE_TMUX_BROKER_SOCKET;
  if (!socketPath || !path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath ||
      Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_BYTES) throw new Error(GENERIC_ERROR);
  const directory = path.dirname(socketPath);
  try {
    const dir = fs.lstatSync(directory);
    const socket = fs.lstatSync(socketPath);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700 ||
        !socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o777) !== 0o600 ||
        (process.getuid && (dir.uid !== process.getuid() || socket.uid !== process.getuid()))) {
      throw new Error(GENERIC_ERROR);
    }
  } catch { throw new Error(GENERIC_ERROR); }
  return socketPath;
}

async function sendRequest(request: Buffer): Promise<void> {
  const socketPath = checkedSocketPath();
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    let done = false;
    const fail = () => { if (!done) { done = true; reject(new Error(GENERIC_ERROR)); } socket.destroy(); };
    socket.setTimeout(5000, fail);
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) fail();
    });
    socket.on('end', () => {
      if (done) return;
      done = true;
      if (response === '{"ok":true}') resolve();
      else reject(new Error(GENERIC_ERROR));
    });
    socket.on('error', fail);
    socket.on('close', () => { if (!done) fail(); });
  });
}

/** Called only for the adapter's new-session invocation when broker mode is enabled. */
export function runTmuxCreationInBroker(args: string[], env: Record<string, string>): string {
  const socketPath = checkedSocketPath();
  const input = Buffer.from(JSON.stringify({ args, env }), 'utf8');
  if (input.length > MAX_REQUEST_BYTES) throw new Error(GENERIC_ERROR);
  try {
    const cli = fileURLToPath(new URL('./tmuxBrokerClient.js', import.meta.url));
    return execFileSync(process.execPath, [cli, '--request'], {
      input, encoding: 'utf8', timeout: 6500, maxBuffer: MAX_RESPONSE_BYTES,
      env: { DECKIDE_TMUX_BROKER_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Neither child stderr nor a spawned error may disclose env or shell text.
    throw new Error(GENERIC_ERROR);
  }
}

async function requestFromStdin(): Promise<void> {
  let chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error(GENERIC_ERROR);
    chunks.push(part);
  }
  await sendRequest(Buffer.concat(chunks));
  chunks = [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--request') process.exitCode = 1;
  else requestFromStdin().catch(() => { process.exitCode = 1; });
}
