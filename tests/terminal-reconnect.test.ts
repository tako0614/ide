import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalReconnect } from '../web/src/components/terminalReconnect.ts';

test('recovers after an outage longer than the former five attempts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const reconnect = createTerminalReconnect(() => attempts++);
  for (let cycle = 0; cycle < 10; cycle++) {
    reconnect.schedule();
    t.mock.timers.tick(30_000);
    assert.equal(attempts, cycle + 1);
  }
  reconnect.dispose();
});

test('coalesces failures, resets backoff on recovery and cancels on disposal', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const reconnect = createTerminalReconnect(() => attempts++);
  reconnect.schedule();
  reconnect.schedule();
  t.mock.timers.tick(999);
  assert.equal(attempts, 0);
  t.mock.timers.tick(1);
  assert.equal(attempts, 1);
  reconnect.schedule();
  t.mock.timers.tick(1999);
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  assert.equal(attempts, 2);
  reconnect.reset();
  reconnect.schedule();
  t.mock.timers.tick(1000);
  assert.equal(attempts, 3);
  reconnect.schedule();
  reconnect.dispose();
  reconnect.schedule();
  t.mock.timers.tick(60_000);
  assert.equal(attempts, 3);
});
