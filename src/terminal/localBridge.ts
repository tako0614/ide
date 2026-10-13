import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
export async function startLocalSessionBridge(directory, handle) {
    if (process.platform === 'win32')
        throw Error('Local terminal attachment requires a POSIX host');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o077)
        throw Error('Local session directory must be owner-only');
    const socketPath = path.join(directory, 'control.sock');
    if (Buffer.byteLength(socketPath) > 103)
        throw Error('Local session socket path is too long');
    try {
        const saved = fs.lstatSync(socketPath);
        if (!saved.isSocket() || saved.uid !== process.getuid() || saved.mode & 0o077)
            throw Error('Unexpected local session socket');
        const stale = await new Promise<boolean>((resolve, reject) => {
            const client = net.createConnection(socketPath);
            client.once('connect', () => { client.destroy(); resolve(false); });
            client.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve(true) : reject(Error('Cannot inspect local session socket')));
            client.setTimeout(1000, () => { client.destroy(); reject(Error('Local session socket did not respond')); });
        });
        const now = fs.lstatSync(socketPath);
        if (!stale || now.dev !== saved.dev || now.ino !== saved.ino)
            throw Error('Another backend owns the local session socket');
        fs.unlinkSync(socketPath);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const clients = new Set<net.Socket>();
    const server = net.createServer(client => {
        if (clients.size >= 32) {
            client.destroy();
            return;
        }
        clients.add(client);
        client.once('close', () => clients.delete(client));
        client.setEncoding('utf8');
        client.on('error', () => undefined);
        client.setTimeout(10000, () => client.destroy());
        let bytes = 0, pending = '';
        let used = false;
        client.on('data', async (chunk) => {
            if (used)
                return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > 64 * 1024) {
                used = true;
                client.destroy();
                return;
            }
            pending += chunk.toString('utf8');
            if (!pending.includes('\n'))
                return;
            used = true;
            try {
                const request = JSON.parse(pending.slice(0, pending.indexOf('\n')));
                if (!request || typeof request.method !== 'string' || request.args && (typeof request.args !== 'object' || Array.isArray(request.args)))
                    throw Error('invalid_request');
                const value = await handle(request);
                const data = JSON.stringify({ ok: true, value }) + '\n';
                if (Buffer.byteLength(data) > 4 * 1024 * 1024)
                    throw Error('response_too_large');
                client.end(data);
            }
            catch {
                client.end(JSON.stringify({ ok: false, error: '操作できません。ID、保存先、接続状態を確認してください。' }) + '\n');
            }
        });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    const owned = fs.lstatSync(socketPath);
    return { socketPath, close: async () => {
            for (const client of clients)
                client.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
            try {
                const now = fs.lstatSync(socketPath);
                if (now.ino === owned.ino && now.dev === owned.dev)
                    fs.unlinkSync(socketPath);
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        } };
}
