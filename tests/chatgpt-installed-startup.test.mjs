import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.resolve(process.env.DECKIDE_CANDIDATE_PACKAGE_ROOT || sourceRoot);

// This starts only a disposable HTTP process. Never request authenticated app
// prepare: private app state, helpers and the native app remain untouched.
test('foreground owned-app mode starts HTTP inertly and refuses a guest app launch', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deckide-owned-start-'));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(packageRoot, 'bin/deckide.js'),
    'start', '--fg', '--no-open', '--chatgpt-desktop', '--port', String(port)], {
    cwd: packageRoot, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
      HOME: directory, DECKIDE_DATA_DIR: directory, NODE_ENV: 'test',
      HOST: '127.0.0.1', DECKIDE_TMUX_RUNTIME_DIR: path.join(directory, 'tm'),
      AGENT_BROWSER_AUTOSTART: 'false', AGENT_BROWSER_REAP_MCP: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 8000;
  let healthy = false;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'Fixture HTTP exited before readiness');
    try { healthy = (await fetch(origin + '/health')).ok; } catch { /* binding */ }
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(healthy, 'Fixture HTTP was not ready');
  const session = await fetch(origin + '/api/auth/session');
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const response = await fetch(origin + '/api/computer/prepare', { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-DeckIDE-CSRF': '1',
      'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  const status = await (await fetch(origin + '/api/computer/status', {
    headers: { Cookie: cookie },
  })).json();
  assert.equal(status.running, false);
  assert.doesNotMatch(output, /app-session\.json|ChatGPT desktop ownership could not be verified/);
});
