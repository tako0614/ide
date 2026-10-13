// Open URLs (or files) as tabs of the shared Chrome over CDP and bring them to the
// front: node open-tab.mjs <cdp-port> [url-or-path...]
import path from 'node:path';

const [port, ...targets] = process.argv.slice(2);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
};
const send = (method, params) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
for (const target of targets.length ? targets : ['chrome://newtab/']) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `file://${path.resolve(target)}`;
  const { result } = await send('Target.createTarget', { url });
  if (result?.targetId) await send('Target.activateTarget', { targetId: result.targetId });
}
ws.close();
