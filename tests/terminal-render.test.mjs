import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const haveTmux = spawnSync('tmux', ['-V']).status === 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function stop(child) {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (!child || exited()) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 40 && !exited(); i++) await pause(50);
  if (!exited()) {
    const exitEvent = once(child, 'exit');
    child.kill('SIGKILL');
    await Promise.race([exitEvent, pause(2000)]);
    assert.ok(exited(), 'fixture child exited after SIGKILL');
  }
}

function alive(pid) {
  // PID 1 in containers may retain a terminated tmux daemon as a zombie.
  // Such a PID owns no running shell or listening socket.
  try { return !['Z', 'X'].includes(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Observe React's actual commits, without adding instrumentation to product code.
const renderProbe = `
  window.renderProbe = { renders: 0, max: 0, commits: 0, sockets: [] };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, inject() { return 1; }, checkDCE() {}, onCommitFiberUnmount() {},
    onCommitFiberRoot(id, root) {
      let count = 0;
      function walk(fiber) {
        if (!fiber) return;
        if ((fiber.tag === 0 || fiber.tag === 15) && (fiber.flags & 1) &&
            fiber.child?.tag === 5 &&
            String(fiber.child.memoizedProps?.className).split(' ').includes('terminal-tile')) count++;
        walk(fiber.child); walk(fiber.sibling);
      }
      walk(root.current);
      renderProbe.renders += count; renderProbe.commits++;
      renderProbe.max = Math.max(renderProbe.max, count);
    }
  };
  localStorage.setItem('deckide-terminal-display', 'overview');
  const OriginalWebSocket = WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(...args) { super(...args); renderProbe.sockets.push(this); }
  };
`;

test('terminal selection renders only changed tiles and preserves browser terminal lifecycle', {
  skip: !chromePath || !haveTmux ? 'requires disposable Chromium and tmux' : false,
  timeout: 60_000,
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dk-render-'));
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: path.join(dir, 'home'),
    TMPDIR: os.tmpdir(), SHELL: '/bin/sh', LANG: 'C.UTF-8', TERM: 'xterm-256color',
    HOST: '127.0.0.1', NODE_ENV: 'test', DECKIDE_DATA_DIR: path.join(dir, 'data'),
    DB_PATH: path.join(dir, 'test.db'), DECKIDE_TMUX_RUNTIME_DIR: path.join(dir, 'r'),
    AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false' };
  let server, browser, socket;
  const terminals = [];
  let origin;
  t.after(async () => {
    const failures = [];
    socket?.terminate();
    await stop(browser);
    if (server?.exitCode === null) {
      for (const terminal of terminals) {
        try {
          const response = await fetch(`${origin}/api/terminals/${terminal.id}`, {
            method: 'DELETE', headers: { Origin: origin }, signal: AbortSignal.timeout(3000),
          });
          if (![204, 404].includes(response.status)) failures.push(`fixture DELETE: ${response.status}`);
        } catch (error) { failures.push(`fixture DELETE failed: ${error.message}`); }
      }
    }
    await stop(server);
    // These exact private sockets were created by this fixture, never discovered.
    for (const terminal of terminals) {
      assert.ok(terminal.tmux.socketPath.startsWith(path.join(dir, 'r') + path.sep));
      spawnSync('tmux', ['-S', terminal.tmux.socketPath, '-N', 'kill-server'],
        { env, stdio: 'ignore', timeout: 1000 });
      await until(() => !alive(terminal.pid) && !alive(terminal.tmux.serverPid), 'fixture native processes stopped');
    }
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(failures, [], 'all fixture cleanup API operations succeeded');
  });
  for (const name of ['home', 'data', 'chrome', 'workspace']) await mkdir(path.join(dir, name));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  env.PORT = String(reservation.address().port);
  await new Promise((resolve) => reservation.close(resolve));
  origin = `http://127.0.0.1:${env.PORT}`;
  server = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: 'ignore' });
  await until(async () => {
    try { return (await fetch(origin + '/health')).ok; } catch { return false; }
  }, 'private HTTP server');
  async function request(route, method, body) {
    const response = await fetch(origin + route, { method, headers: {
      Origin: origin, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, `${method} ${route}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  const workspace = await request('/api/workspaces', 'POST', { path: path.join(dir, 'workspace') });
  const deck = await request('/api/decks', 'POST', { workspaceId: workspace.id, name: 'render' });
  // Three is the smallest grid where a selection can render an unrelated tile.
  for (let i = 0; i < 3; i++) terminals.push(await request('/api/terminals', 'POST', {
    deckId: deck.id, title: `tile-${i}`, cols: 120, rows: 32,
    command: `while IFS= read -r line; do printf 'received:%s\\n' "$line"; done`,
  }));
  browser = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + path.join(dir, 'chrome'),
    '--window-size=1440,1000', 'about:blank'], { env, stdio: 'ignore' });
  let endpoint;
  await until(async () => {
    try {
      const port = Number((await readFile(path.join(dir, 'chrome/DevToolsActivePort'), 'utf8')).split('\n')[0]);
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      endpoint = tabs.find((tab) => tab.type === 'page')?.webSocketDebuggerUrl;
      return Boolean(endpoint);
    } catch { return false; }
  }, 'private Chromium');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id); clearTimeout(handler.timer);
    if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
    else handler.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: renderProbe });
  await call('Page.navigate', { url: `${origin}/?workspace=${workspace.id}&deck=${deck.id}` });
  await until(() => evaluate(`document.querySelectorAll('.xterm').length === 3 &&
    document.querySelectorAll('.terminal-tile [role="status"]').length === 0`), 'three ready tiles');
  await pause(100);
  const select = (index) => evaluate(`new Promise(resolve => {
    document.querySelectorAll('.terminal-frame-viewport')[${index}]
      .dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  await evaluate('Object.assign(renderProbe, {renders: 0, max: 0, commits: 0})');
  await select(2);
  await select(0);
  const renders = await evaluate('({renders: renderProbe.renders, max: renderProbe.max, commits: renderProbe.commits})');
  assert.equal(renders.commits, 2, 'the probe sees both actual selection commits');
  assert.equal(renders.renders, 4, 'only the previous and next active tiles render');
  assert.equal(renders.max, 2);
  assert.equal(await evaluate('renderProbe.sockets.length'), 3, 'selection does not reconnect viewers');

  await select(2);
  await call('Input.insertText', { text: 'browser-route' });
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(() => evaluate(`document.querySelectorAll('.xterm-rows')[2].textContent.includes('received:browser-route')`), 'input reaches selected terminal');
  for (const index of [0, 1]) assert.equal(await evaluate(`document.querySelectorAll('.xterm-rows')[${index}].textContent.includes('browser-route')`), false);
  await request(`/api/terminals/${terminals[0].id}`, 'PATCH', { title: 'renamed tile' });
  await until(() => evaluate(`document.querySelectorAll('.terminal-tile-header')[0].textContent.includes('renamed tile')`), 'metadata still refreshes a memoized tile');

  await evaluate(`document.querySelectorAll('button[title="このターミナルを最大表示"]')[2].click()`);
  await until(() => evaluate(`document.querySelectorAll('.terminal-tile-slot-single-hidden').length === 2`), 'single view');
  await request(`/api/terminals/${terminals[0].id}/input`, 'POST', { data: 'hidden-replay\r' });
  await evaluate(`document.querySelector('button[title="グリッド表示に戻す"]').click()`);
  await until(() => evaluate(`document.querySelectorAll('.xterm-rows')[0].textContent.includes('received:hidden-replay')`), 'hidden to grid replay');
  assert.equal(await evaluate('renderProbe.sockets.length'), 3, 'grid switching retains sockets');
  await evaluate(`renderProbe.sockets[2].close()`);
  await until(() => evaluate(`renderProbe.sockets.length === 4 && document.querySelectorAll('.terminal-tile [role="status"]').length === 0`), 'viewer reconnect');
  await until(() => evaluate(`document.querySelectorAll('.xterm-rows')[2].textContent.includes('received:browser-route')`), 'reconnect preserves output');
  for (const terminal of terminals) assert.ok(alive(terminal.pid));

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until(() => evaluate(`document.querySelectorAll('.terminal-tile-slot-single-hidden').length === 2`), 'mobile single view');
  await evaluate(`const picker = document.querySelector('.terminal-switcher');
    picker.value = ${JSON.stringify(terminals[0].id)};
    picker.dispatchEvent(new Event('change', { bubbles: true }));`);
  await until(() => evaluate(`document.activeElement === document.querySelectorAll('.xterm-helper-textarea')[0]`), 'mobile selection autofocus');
  await call('Emulation.clearDeviceMetricsOverride');
  await until(() => evaluate(`document.querySelectorAll('.terminal-tile-slot-single-hidden').length === 0`), 'desktop grid restored');
  assert.equal(await evaluate('renderProbe.sockets.length'), 4, 'mobile/grid switching retains viewers');

  await evaluate(`window.confirm = () => true;
    document.querySelectorAll('button[aria-label="ターミナルを閉じる"]')[1].click()`);
  await until(() => evaluate(`document.querySelectorAll('.xterm').length === 2`), 'ID-specific deletion');
  await until(() => !alive(terminals[1].pid) && !alive(terminals[1].tmux.serverPid) &&
    !existsSync(path.join(env.DECKIDE_TMUX_RUNTIME_DIR, terminals[1].id + '.json')), 'deleted native resources stopped and unlinked');
  const listener = spawnSync('tmux', ['-S', terminals[1].tmux.socketPath, '-N', 'has-session'], { env, timeout: 1000 });
  assert.equal(listener.error, undefined);
  assert.notEqual(listener.status, 0, 'deleted terminal has no listening tmux session');
  assert.equal(await evaluate(`document.querySelector('.terminal-tile-header').textContent.includes('renamed tile')`), true);
  for (const terminal of [terminals[0], terminals[2]]) assert.ok(alive(terminal.pid));

  const splitDeck = await request('/api/decks', 'POST', { workspaceId: workspace.id, name: 'split' });
  terminals.push(await request('/api/terminals', 'POST', { deckId: splitDeck.id, title: 'split-terminal',
    command: `while IFS= read -r line; do printf 'split:%s\\n' "$line"; done` }));
  await call('Page.navigate', { url: `${origin}/?workspace=${workspace.id}&decks=${deck.id},${splitDeck.id}` });
  await until(() => evaluate(`document.querySelectorAll('.deck-split-pane').length === 2 &&
    document.querySelectorAll('.xterm').length === 3 &&
    document.querySelectorAll('.terminal-tile [role="status"]').length === 0`), 'split decks ready');
  await select(2);
  await call('Input.insertText', { text: 'split-route' });
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(() => evaluate(`document.querySelectorAll('.xterm-rows')[2].textContent.includes('split:split-route')`), 'split input reaches correct deck');
  for (const index of [0, 1]) assert.equal(await evaluate(`document.querySelectorAll('.xterm-rows')[${index}].textContent.includes('split-route')`), false);
});
