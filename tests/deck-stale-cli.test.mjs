import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDeckArgs } from '../bin/deckide-session.js';
import { createLocalControl } from '../src/agents/localControl.ts';
import { startLocalSessionBridge } from '../src/terminal/localBridge.ts';

const cli = fileURLToPath(new URL('../bin/deckide.js', import.meta.url));

test('deck delete accepts one explicit prune flag in either position only for delete', () => {
  assert.deepEqual(parseDeckArgs(['delete', '--prune-stale', 'deck-1234']), {
    action: 'delete', json: false, pruneStale: true, positionals: ['deck-1234'],
  });
  assert.deepEqual(parseDeckArgs(['delete', 'deck-1234', '--prune-stale']), {
    action: 'delete', json: false, pruneStale: true, positionals: ['deck-1234'],
  });
  assert.deepEqual(parseDeckArgs(['delete', 'deck-1234']), {
    action: 'delete', json: false, positionals: ['deck-1234'],
  });
  for (const argv of [
    ['delete', 'deck-1234', '--prune-stale', '--prune-stale'],
    ['delete', 'deck-1234', '--prune-stale', 'extra'],
    ['list', '--prune-stale'],
    ['rename', 'deck-1234', 'Name', '--prune-stale'],
  ]) assert.throws(() => parseDeckArgs(argv));
});

test('local control adds pruneStale query only when explicitly true', async () => {
  const calls = [];
  const control = createLocalControl({ agents: null, attachment: () => null,
    api: async (...args) => { calls.push(args); return null; } });
  await control({ method: 'decks.delete', args: { id: 'deck/1' } });
  await control({ method: 'decks.delete', args: { id: 'deck/1', pruneStale: true } });
  assert.deepEqual(calls, [
    ['/api/decks/deck%2F1', 'DELETE'],
    ['/api/decks/deck%2F1?pruneStale=true', 'DELETE'],
  ]);
  await assert.rejects(control({ method: 'decks.delete', args: { id: 'deck/1', pruneStale: 'true' } }), /invalid_request/);
});

async function withBridge(t, handle) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-stale-cli-'));
  fs.chmodSync(directory, 0o700);
  const bridge = await startLocalSessionBridge(directory, handle);
  const previous = process.env.DECKIDE_SESSION_SOCKET;
  process.env.DECKIDE_SESSION_SOCKET = bridge.socketPath;
  t.after(async () => {
    if (previous === undefined) delete process.env.DECKIDE_SESSION_SOCKET;
    else process.env.DECKIDE_SESSION_SOCKET = previous;
    await bridge.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return bridge;
}

function runDeleteCli(socketPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'deck', 'delete', 'deck-1234', '--prune-stale'], {
      env: { ...process.env, DECKIDE_SESSION_SOCKET: socketPath },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('owner-only bridge carries validated blocker details to actual CLI output', async (t) => {
  const blockerError = Object.assign(new Error('private API exception'), {
    status: 409, code: 'deck_delete_blocked', hint: 'Retry with deckide deck delete ID --prune-stale',
    blockers: [{ terminalId: 'term-1234', source: 'registry', state: 'dead', reason: 'stale terminal entry at /home/user/private' }],
  });
  const bridge = await withBridge(t, async (request) => {
    if (request.method === 'decks.list') return [{ id: 'deck-1234', name: 'Deck' }];
    throw blockerError;
  });
  const result = await runDeleteCli(bridge.socketPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Deck operation failed \(409\)/);
  assert.match(result.stderr, /registry: term-1234 \(dead\)/);
  assert.match(result.stderr, /stale terminal entry at \[path\]/);
  assert.match(result.stderr, /--prune-stale/);
  assert.doesNotMatch(result.stderr, /private API exception|\/home\/user\/private/);
});

test('malformed structured errors stay on the generic safe fallback', async (t) => {
  const malformed = Object.assign(new Error('secret /home/user/key'), {
    status: 409, code: 'deck_delete_blocked', hint: 'bad\nsecret',
    blockers: [{ terminalId: 'term-1234', source: 'unknown', state: 'dead', reason: 'private /home/user/key' }],
  });
  const bridge = await withBridge(t, async (request) => {
    if (request.method === 'decks.list') return [{ id: 'deck-1234', name: 'Deck' }];
    throw malformed;
  });
  const result = await runDeleteCli(bridge.socketPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Deck operation failed\. Check the backend/);
  assert.doesNotMatch(result.stderr, /secret|private|unknown|term-1234/);
});
