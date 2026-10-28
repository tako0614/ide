import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await pause(25); }
  throw Error(`Timed out: ${label}`);
}

// Reuse the caller's owned browser, preserving its startup/cleanup boundary.
// The actual component sees a normal-buffer stream, without any new shell/DB.
export async function verifyTerminalOutput({ call, evaluate }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dk-output-'));
  const sockets = new Set();
  let server, wss, parsedReplies = 0;
  try {
    await writeFile(path.join(dir, 'index.html'), `<!doctype html><link rel="stylesheet" href="/product.css">
      <style>html,body{margin:0;height:100%;overflow:hidden}#root{height:100vh;display:flex;flex-direction:column}</style>
      <div id="root"></div><script type="module" src="/entry.tsx"></script>`);
    await writeFile(path.join(dir, 'entry.tsx'), `
      import {createRoot} from 'react-dom/client';
      import {TerminalPane} from ${JSON.stringify(path.join(root, 'web/src/components/TerminalPane'))};
      localStorage.setItem('deckide-terminal-display','overview');
      createRoot(document.getElementById('root')).render(<TerminalPane
        terminals={[{id:'output',title:'Synthetic stream'}]} activeTerminalId="output"
        wsBase={location.origin.replace('http','ws')} onDeleteTerminal={()=>{}} onExitTerminal={()=>{}} />);
    `);
    await build({ configFile: false, root: dir, logLevel: 'silent', esbuild: { jsx: 'automatic' },
      resolve: { alias: { react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom'),
        '@shared': path.join(root, 'src/shared') } }, build: { target: 'es2022', outDir: 'web' } });
    const assets = path.join(root, 'web/dist/assets');
    const css = await readFile(path.join(assets, (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))));
    const files = new Map([['/', await readFile(path.join(dir, 'web/index.html'))], ['/product.css', css]]);
    for (const name of await readdir(path.join(dir, 'web/assets'))) files.set('/assets/' + name, await readFile(path.join(dir, 'web/assets', name)));
    server = http.createServer((req, res) => {
      if (req.url === '/api/ws-token') { res.setHeader('Content-Type', 'application/json'); res.end('{"token":"","authEnabled":false}'); return; }
      const file = files.get(req.url);
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'application/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html'); res.end(file);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    wss = new WebSocketServer({ server });
    wss.on('connection', ws => {
      sockets.add(ws); ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data, binary) => { if (binary && data.toString().includes('\x1b[0n')) parsedReplies++; });
      const snapshot = Buffer.from(Array.from({ length: 160 }, (_, i) => `history-${String(i).padStart(4, '0')}\r\n`).join(''));
      ws.send(JSON.stringify({ type: 'sync', offsetBase: 0, reset: true, cols: 120, rows: 32, epoch: 'fixture', snapshotBytes: snapshot.length }));
      ws.send(snapshot); ws.send(JSON.stringify({ type: 'ready' }));
      ws.send(JSON.stringify({ type: 'primary', value: true }));
    });
    const write = async data => {
      const before = parsedReplies;
      // An owned DSR reply proves the parser consumed the preceding live bytes.
      [...sockets][0].send(Buffer.from(data + '\x1b[5n'));
      await until(() => parsedReplies > before, 'live bytes parsed before owned DSR reply');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    };
    await call('Page.navigate', { url: origin });
    await until(() => evaluate(`document.querySelector('.xterm-rows')?.textContent.includes('history-0159') && !document.querySelector('[role="status"]')`), 'initial replay lands at bottom');
    await pause(100);
    const point = await evaluate(`(() => {const r=document.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -600 });
    await until(() => evaluate(`!document.querySelector('.xterm-rows').textContent.includes('history-0159')`), 'wheel scrolls into history');
    const history = await evaluate(`document.querySelector('.xterm-rows').textContent`);
    await write('new-live-marker\r\n');
    assert.equal(await evaluate(`document.querySelector('.xterm-rows').textContent`), history,
      'live output must preserve the user scrollback position');
    // Last text visibility can be one row short; require the bottom cursor row.
    for (let i = 0; i < 5; i++) {
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 20000 });
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      if (await evaluate(`Boolean(document.querySelector('.xterm-rows').lastElementChild.querySelector('.xterm-cursor'))`)) break;
    }
    assert.equal(await evaluate(`Boolean(document.querySelector('.xterm-rows').lastElementChild.querySelector('.xterm-cursor'))`), true,
      'wheel returns to the actual bottom cursor row');
    await write('following-bottom-marker\r\n');
    await until(() => evaluate(`document.querySelector('.xterm-rows').textContent.includes('following-bottom-marker')`), 'bottom continues following live output');
  } finally {
    await call('Page.navigate', { url: 'about:blank' }).catch(() => {});
    for (const ws of sockets) ws.terminate();
    if (wss) await new Promise(resolve => wss.close(resolve));
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}
