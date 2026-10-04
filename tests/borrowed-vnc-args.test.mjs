import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateVncLauncherArgs } from '../src/computer/vnc.ts';

const log = { dev: 8, ino: 9 };
const borrowed = {
  runtimeDir: '/run/chatgpt-app', authority: '/run/chatgpt-app/Xauthority-test',
  display: ':2000', uid: 993, gid: 982, authDev: 13, authIno: 42,
  expiresEpochMs: Date.now() + 60_000,
};
const producer = '/private/producer';

test('borrowed launcher arguments use fixed native 13/14 argc metadata contract', () => {
  assert.deepEqual(privateVncLauncherArgs(producer, log, 'credential-borrowed', 'Abcd123_', borrowed),
    ['credential-borrowed', producer, 'Abcd123_', '8', '9', borrowed.authority,
      borrowed.runtimeDir, '993', '982', '13', '42', String(borrowed.expiresEpochMs)]);
  assert.deepEqual(privateVncLauncherArgs(producer, log, 'viewer-borrowed', ':2000', '1234', borrowed),
    ['viewer-borrowed', producer, ':2000', '1234', '8', '9', borrowed.authority,
      borrowed.runtimeDir, '993', '982', '13', '42', String(borrowed.expiresEpochMs)]);
  assert.deepEqual(privateVncLauncherArgs(producer, log, 'credential', 'Abcd123_'),
    ['credential', producer, 'Abcd123_', '8', '9']);
});

test('borrowed launcher argument constructor rejects changed paths and credentials', () => {
  for (const bad of [
    () => privateVncLauncherArgs(producer, log, 'credential-borrowed', '123', borrowed),
    () => privateVncLauncherArgs(producer, log, 'credential-borrowed', '0042', borrowed),
    () => privateVncLauncherArgs(producer, log, 'credential-borrowed', '12345', borrowed),
    () => privateVncLauncherArgs(producer, log, 'viewer-borrowed', ':2001', '1234', borrowed),
    () => privateVncLauncherArgs(producer, log, 'viewer-borrowed', ':12345', '1234',
      { ...borrowed, display: ':12345' }),
    () => privateVncLauncherArgs(producer, log, 'viewer-borrowed', ':2000', 'pipe:[1]', borrowed),
    () => privateVncLauncherArgs(producer, log, 'credential-borrowed', 'Abcd123_',
      { ...borrowed, expiresEpochMs: Date.now() - 1 }),
    () => privateVncLauncherArgs(producer, log, 'credential-borrowed', 'Abcd123_',
      { ...borrowed, authority: '/tmp/other' }),
    () => privateVncLauncherArgs(borrowed.runtimeDir, log, 'credential-borrowed', 'Abcd123_', borrowed),
  ]) assert.throws(bad, /Invalid private VNC launch/);
});
