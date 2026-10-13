import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDeckArgs, parseSessionArgs, runDeckClient, runSessionClient } from '../bin/deckide-session.js';
import { createLocalControl } from '../src/agents/localControl.ts';

test('metadata CLI parsing rejects missing, extra, blank and unknown inputs', () => {
  assert.deepEqual(parseSessionArgs(['move', 'worker', 'deck-123']).positionals, ['worker', 'deck-123']);
  assert.deepEqual(parseSessionArgs(['rename', 'worker', 'Build server']).positionals, ['worker', 'Build server']);
  for (const argv of [
    ['move', 'worker'], ['move', 'worker', 'deck', 'extra'], ['move', 'worker', 'deck', '--json'],
    ['rename', 'worker'], ['rename', 'worker', '  '], ['rename', 'worker', 'title', '--title', 'other'],
    ['move', 'worker', '--oops', 'deck'],
  ]) assert.throws(() => parseSessionArgs(argv));

  assert.deepEqual(parseDeckArgs(['list', '--json']), { action: 'list', json: true, positionals: [] });
  assert.deepEqual(parseDeckArgs(['rename', 'abcd', 'New name']), { action: 'rename', json: false, positionals: ['abcd', 'New name'] });
  for (const argv of [
    ['list', 'extra'], ['list', '--unknown'], ['rename', 'id'], ['rename', 'id', '  '],
    ['rename', 'id', 'name', '--json'], ['delete'], ['delete', 'id', 'extra'], ['delete', 'id', '--json'],
  ]) assert.throws(() => parseDeckArgs(argv));
});

test('local control maps metadata mutations onto the owner API and validates inputs', async () => {
  const calls = [];
  const control = createLocalControl({ agents: null, attachment: () => null,
    api: async (...args) => { calls.push(args); return { ok: true }; } });
  await control({ method: 'terminals.update', args: { id: 'terminal/1', deckId: 'deck-2', title: 'Build' } });
  await control({ method: 'terminals.update', args: { id: 'terminal/1', title: 'Renamed' } });
  await control({ method: 'decks.rename', args: { id: 'deck/1', name: 'New deck' } });
  await control({ method: 'decks.delete', args: { id: 'deck/1' } });
  assert.deepEqual(calls, [
    ['/api/terminals/terminal%2F1', 'PATCH', { deckId: 'deck-2', title: 'Build' }],
    ['/api/terminals/terminal%2F1', 'PATCH', { title: 'Renamed' }],
    ['/api/decks/deck%2F1', 'PATCH', { name: 'New deck' }],
    ['/api/decks/deck%2F1', 'DELETE'],
  ]);
  for (const args of [{ id: 't1' }, { id: '', title: 'x' }, { id: 't1', title: ' ' }, { id: 't1', deckId: 4 }])
    await assert.rejects(control({ method: 'terminals.update', args }), /invalid_request/);
  await assert.rejects(control({ method: 'decks.rename', args: { id: 'd1', name: ' ' } }), /invalid_request/);
});

async function withPrivateControl(t, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deckide-metadata-cli-'));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 'control.sock');
  const calls = [];
  const server = net.createServer((connection) => {
    let pending = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk) => {
      pending += chunk;
      const newline = pending.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(pending.slice(0, newline));
      calls.push(request);
      const value = handler(request);
      connection.end(JSON.stringify({ ok: true, value }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  const previous = process.env.DECKIDE_SESSION_SOCKET;
  process.env.DECKIDE_SESSION_SOCKET = socketPath;
  t.after(async () => {
    if (previous === undefined) delete process.env.DECKIDE_SESSION_SOCKET;
    else process.env.DECKIDE_SESSION_SOCKET = previous;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return calls;
}

test('session move and rename resolve terminal selectors then issue metadata RPCs', async (t) => {
  const calls = await withPrivateControl(t, (request) => request.method === 'terminals.list'
    ? [{ id: 'terminal-1234', deckId: 'deck-a', title: 'Worker' }]
    : { ok: true });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await runSessionClient(['move', 'Worker', 'deck-b']);
    await runSessionClient(['rename', 'term', 'Renamed worker']);
  } finally { console.log = oldLog; }
  assert.deepEqual(calls.map(({ method, args }) => [method, args]), [
    ['terminals.list', {}], ['terminals.update', { id: 'terminal-1234', deckId: 'deck-b' }],
    ['terminals.list', {}], ['terminals.update', { id: 'terminal-1234', title: 'Renamed worker' }],
  ]);
});

test('deck mutation selection uses IDs and rejects ambiguous prefixes before mutation', async (t) => {
  const calls = await withPrivateControl(t, (request) => request.method === 'decks.list'
    ? [{ id: 'deck-abcd-1', name: 'One' }, { id: 'deck-abcd-2', name: 'Two' }]
    : { ok: true });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(runDeckClient(['rename', 'deck-', 'Renamed']), /deck_ambiguous/);
    assert.deepEqual(calls.map((request) => request.method), ['decks.list']);
  } finally { console.log = oldLog; }
});
