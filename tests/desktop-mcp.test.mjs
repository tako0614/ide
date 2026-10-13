import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMessage, screenshotScale, TOOLS } from '../bin/deckide-desktop-mcp.js';

test('desktop MCP: handshake, tool list, input validation and scaling', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'deckide-desktop');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  assert.ok(list.result.tools.some((tool) => tool.name === 'desktop_screenshot'));

  const call = (name, args) => handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  for (const keys of ['rm -rf; x', '', '$(id)']) {
    const result = await call('desktop_key', { keys });
    assert.equal(result.result.isError, true, keys);
  }
  assert.equal((await call('desktop_type', { text: '' })).result.isError, true);
  assert.equal((await call('desktop_type', { text: 'x'.repeat(4001) })).result.isError, true);
  assert.equal((await call('desktop_open', { target: '--help' })).result.isError, true);
  assert.equal((await call('nope', {})).error.code, -32602);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 4, method: 'bogus' })).error.code, -32601);

  assert.equal(screenshotScale(1280, 720), 1);
  assert.equal(screenshotScale(1600, 900), 0.8);
  assert.equal(screenshotScale(1000, 1600), 0.5);
});
