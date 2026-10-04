import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { createComputerRouter } from '../src/routes/computer.ts';

test('screenshot and input use only verified actor resolver', async () => {
  const seen = [];
  const service = {
    prepare: async () => { seen.push('prepare'); return { running: true }; },
    stop: async () => { seen.push('stop'); return { running: false }; },
    launch: async () => { seen.push('launch'); return { running: true }; },
    screenshot: async (actor) => { seen.push(actor); return { observationId: 'test' }; },
    input: async (actor) => { seen.push(actor); return { executed: true }; },
  };
  const app = new Hono();
  app.route('/api/computer', createComputerRouter(service, (c) =>
    c.req.header('x-test-verified-session') === 'yes' ? 'verified-actor' : null));
  const request = (endpoint, headers = {}, body = { actor: 'forged-client-actor', observationId: 'test' }) =>
    app.request(`http://localhost/api/computer/${endpoint}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body) });
  const deniedScreenshot = await request('screenshot');
  assert.equal(deniedScreenshot.status, 401);
  const deniedInput = await request('input');
  assert.equal(deniedInput.status, 401);
  assert.equal((await request('prepare')).status, 401);
  assert.equal((await request('stop')).status, 401);
  assert.equal((await request('launch')).status, 401);
  assert.deepEqual(seen, []);
  assert.equal((await request('prepare', { 'x-test-verified-session': 'yes' })).status, 200);
  assert.equal((await request('stop', { 'x-test-verified-session': 'yes' })).status, 200);
  assert.equal((await request('launch', { 'x-test-verified-session': 'yes' },
    { app: 'terminal', actor: 'forged-client-actor' })).status, 400);
  assert.equal((await request('launch', { 'x-test-verified-session': 'yes' },
    { app: 'terminal' })).status, 200);
  assert.equal((await request('screenshot', { 'x-test-verified-session': 'yes' })).status, 200);
  assert.equal((await request('input', { 'x-test-verified-session': 'yes' })).status, 200);
  assert.deepEqual(seen, ['prepare', 'stop', 'launch', 'verified-actor', 'verified-actor']);
});
