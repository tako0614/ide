import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await pause(25); }
  throw Error(`Timed out: ${label}`);
}

// The public component/stream seam permits a normal-buffer transcript without
// requiring a native tmux client to expose browser scrollback. No shells or DBs.
test('live terminal output preserves scrollback and still follows the bottom', {
  skip: chrome ? false : 'requires disposable Chromium', timeout: 30_000,
}, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dk-output-'));
  const sockets = new Set();
  let parsedReplies = 0;
  let browser, cdp, server, wss;
  const pending = new Map();
  t.after(async () => {
    cdp?.terminate();
    if (browser?.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, 'exit'); browser.kill('SIGTERM');
      await Promise.race([exited, pause(2000)]);
      if (browser.exitCode === null && browser.signalCode === null) { browser.kill('SIGKILL'); await exited; }
    }
    for (const ws of sockets) ws.terminate();
    if (wss) await new Promise(resolve => wss.close(resolve));
    if (server) await new Promise(resolve => server.close(resolve));
    for (const handler of pending.values()) clearTimeout(handler.timer);
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(path.join(dir, 'home'));
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
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + path.join(dir, 'chrome'), '--window-size=1440,1000', 'about:blank'], {
    env: { PATH: '/usr/bin:/bin', HOME: path.join(dir, 'home'), TMPDIR: os.tmpdir() }, stdio: 'ignore' });
  let endpoint;
  await until(async () => {
    try {
      const port = Number((await readFile(path.join(dir, 'chrome/DevToolsActivePort'), 'utf8')).split('\n')[0]);
      endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(tab => tab.type === 'page')?.webSocketDebuggerUrl;
      return Boolean(endpoint);
    } catch { return false; }
  }, 'private Chromium');
  cdp = new WebSocket(endpoint); await once(cdp, 'open');
  cdp.on('message', raw => {
    const message = JSON.parse(raw), handler = pending.get(message.id);
    if (!handler) return;
    clearTimeout(handler.timer); pending.delete(message.id);
    if (message.error) handler.reject(Error(JSON.stringify(message.error))); else handler.resolve(message.result);
  });
  let serial = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 5000);
    pending.set(id, { resolve, reject, timer }); cdp.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const write = async data => {
    const before = parsedReplies;
    // An owned DSR reply proves the parser consumed the preceding live bytes.
    [...sockets][0].send(Buffer.from(data + '\x1b[5n'));
    await until(() => parsedReplies > before, 'live bytes parsed before owned DSR reply');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  };
  await call('Page.enable'); await call('Page.navigate', { url: origin });
  await until(() => evaluate(`document.querySelector('.xterm-rows')?.textContent.includes('history-0159') && !document.querySelector('[role="status"]')`), 'initial replay lands at bottom');
  await pause(100);
  const point = await evaluate(`(() => {const r=document.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -600 });
  await until(() => evaluate(`!document.querySelector('.xterm-rows').textContent.includes('history-0159')`), 'wheel scrolls into history');
  const history = await evaluate(`document.querySelector('.xterm-rows').textContent`);
  await write('new-live-marker\r\n');
  assert.equal(await evaluate(`document.querySelector('.xterm-rows').textContent`), history,
    'live output must preserve the user scrollback position');
  // A wheel event can stop one row short. Require the rendered cursor in the
  // last row, rather than mistaking a visible last message for the bottom.
  for (let i = 0; i < 5; i++) {
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 20000 });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (await evaluate(`Boolean(document.querySelector('.xterm-rows').lastElementChild.querySelector('.xterm-cursor'))`)) break;
  }
  assert.equal(await evaluate(`Boolean(document.querySelector('.xterm-rows').lastElementChild.querySelector('.xterm-cursor'))`), true,
    'wheel returns to the actual bottom cursor row');
  await write('following-bottom-marker\r\n');
  await until(() => evaluate(`document.querySelector('.xterm-rows').textContent.includes('following-bottom-marker')`), 'bottom continues following live output');
});
