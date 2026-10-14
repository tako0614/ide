import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inspectQueue, parseQueueArgs, queueError, replaceQueuedMessage, runQueueClient } from '../bin/deckide-session.js';

function screen(messages = [], composer = 'Ask Codex to do anything', extra = '') {
  return ['• Working (2s • esc to interrupt)', '', ...(messages.length ? [
    '• Queued follow-up inputs', ...messages.flatMap((text) => text.split('\n').map((line, index) => (index ? '    ' : '  ↳ ') + line)),
    '    ⇧← edit last queued message', '',
  ] : []), extra, '› ' + composer, '', '  ? for shortcuts            100% context left', ''].join('\n');
}
function fixture(screens) {
  const writes = [];
  return { writes, capture: async () => { assert.ok(screens.length, 'unexpected capture'); return screens.shift(); },
    write: async (data) => { writes.push(data); }, wait: async () => {} };
}

test('queue arguments are strict and replacement cannot inject controls or slash/shell commands', () => {
  assert.deepEqual(parseQueueArgs(['queue', 'show', 'abcd']), { action: 'show', terminal: 'abcd', text: undefined });
  assert.equal(parseQueueArgs(['queue', 'replace', 'abcd', 'two words']).text, 'two words');
  for (const argv of [['queue'], ['queue', 'show'], ['queue', 'show', 'abcd', '--json'], ['queue', 'replace', 'abcd'],
    ['queue', 'replace', 'abcd', 'a', 'b']]) assert.throws(() => parseQueueArgs(argv), /queue_invalid_arguments/);
  for (const text of ['', ' ', 'a\nb', 'a\rb', '\x1b[2J', '\t', '/clear', '!rm', 'x'.repeat(8193)])
    assert.throws(() => parseQueueArgs(['queue', 'replace', 'abcd', text]), /queue_invalid_text/);
});

test('show reads only a complete current queue and preserves displayed Unicode/multiline text', () => {
  const actual = readFileSync(new URL('./fixtures/queue/codex-v0.162.1.txt', import.meta.url), 'utf8');
  assert.deepEqual(inspectQueue(actual).messages, ['Keep real Codex first', 'Replace real Codex last']);
  assert.deepEqual(inspectQueue(screen(['first', '日本語\nsecond line'])).messages, ['first', '日本語\nsecond line']);
  assert.equal(inspectQueue(screen()).count, 0);
  assert.equal(inspectQueue('› Ask Codex to do anything\n  ? for shortcuts\n').count, 0);
  assert.equal(inspectQueue(screen(['last']).replace('⇧←', 'shift+left')).count, 1);
  assert.equal(inspectQueue(screen(['last']).replace('⇧←', 'shift+←')).count, 1);
  assert.equal(inspectQueue(screen(['We have 1 question to answer before finalizing'])).count, 1);
  const history = screen(['old']) + '\n• Working (3s • esc to interrupt)\n\n› Ask Codex to do anything\n  ? for shortcuts\n';
  assert.equal(inspectQueue(history).count, 0);
});

test('unknown/clipped/hidden/steering queues and modal/question surfaces fail closed', () => {
  for (const text of ['$ ', '• Queued follow-up inputs\n  ↳ first\n› Ask Codex to do anything\n  ? for shortcuts',
    screen(['one\n…']), screen(['[Pasted text #1 +20 lines]']), screen(['first']).replace('• Queued follow-up inputs\n', ''),
    screen(['first']).replace('⇧←', 'alt+up'), screen(['first'], 'draft\n[Pasted text #1]'),
    screen(['first'], 'Ask Codex to do anything', '• Messages to be submitted after next tool call')])
    assert.throws(() => inspectQueue(text), /queue_(?:unknown|incomplete)_screen/);
  for (const extra of ['Would you like to run the following command?', 'Would you like to make the following edits?',
    '  1 question · shift+left to answer', '  enter to submit · esc to go back', 'Approval required'])
    assert.throws(() => inspectQueue(screen(['old'], 'Ask Codex to do anything', extra)), /queue_dialog_open/);
});

test('replace edits only the last queued message, verifies all transitions, and submits one CR', async () => {
  const before = screen(['keep', 'old']);
  const f = fixture([before, before, screen(['keep'], 'old'), screen(['keep']), screen(['keep'], '新しい message'), screen(['keep', '新しい message'])]);
  const result = await replaceQueuedMessage({ text: '新しい message', ...f });
  assert.deepEqual(result, { count: 2, messages: ['keep', '新しい message'], replaced: true });
  assert.deepEqual(f.writes, ['\x1b[1;2D', '\x01'.repeat(4) + '\x0b'.repeat(7), '新しい message', '\r']);
  assert.equal(f.writes.filter((data) => data.includes('\r')).length, 1);
  assert.ok(f.writes.every((data) => !data.includes('\n') && !data.includes('\t')));
});

test('empty queue, existing draft and idle queue cause no terminal input', async () => {
  for (const [value, error] of [[screen(), 'queue_empty'], [screen(['old'], 'my draft'), 'queue_draft_present'],
    [screen(['old']).replace('• Working (2s • esc to interrupt)', ''), 'queue_not_busy']]) {
    const f = fixture([value]);
    await assert.rejects(replaceQueuedMessage({ text: 'new', ...f }), new RegExp(error));
    assert.deepEqual(f.writes, []);
  }
});

test('changed queues and failed edit/clear/type/submit each stop without another Enter', async () => {
  const before = screen(['keep', 'old']);
  const normal = [before, before, screen(['keep'], 'old'), screen(['keep']), screen(['keep'], 'new'), screen(['keep', 'new'])];
  for (const [index, value, code, writes] of [[1, screen(['keep', 'other']), 'queue_changed', 0],
    [2, before, 'queue_edit_not_loaded', 1], [3, screen(['keep'], 'old'), 'queue_clear_failed', 2],
    [4, screen(['keep'], 'wrong'), 'queue_text_not_loaded', 3], [5, screen(['changed', 'new']), 'queue_replace_unverified', 4],
    [5, screen(['keep'], 'new'), 'queue_replace_unverified', 4]]) {
    const screens = normal.slice(0, index + 1); screens[index] = value;
    const f = fixture(screens);
    await assert.rejects(replaceQueuedMessage({ text: 'new', ...f }), new RegExp(code));
    assert.equal(f.writes.length, writes);
  }
});

test('approval/question arriving at any checkpoint stops before further input', async () => {
  const before = screen(['old']);
  const normal = [before, before, screen([], 'old'), screen(), screen([], 'new'), screen(['new'])];
  for (let index = 0; index < normal.length; index++) {
    const screens = normal.slice(0, index + 1); screens[index] = screen(['old'], 'Ask Codex to do anything', 'Would you like to run this command?');
    const f = fixture(screens);
    await assert.rejects(replaceQueuedMessage({ text: 'new', ...f }), /queue_dialog_open/);
    assert.equal(f.writes.length, Math.max(0, index - 1));
  }
});

test('queue CLI emits JSON and nonzero for malformed arguments, unavailable backend and blocked dialogs', async () => {
  const originalExit = process.exitCode;
  try {
    for (const mode of ['arguments', 'backend', 'dialog']) {
      process.exitCode = 0;
      const output = []; const calls = [];
      await runQueueClient(mode === 'arguments' ? ['queue', 'show'] : ['queue', 'show', 'abcd'], {
        resolve: async () => { if (mode === 'backend') throw Error('unsafe_socket'); return 'abcd-full'; },
        rpc: async (...args) => { calls.push(args); return {}; },
        capture: async () => screen(['old'], 'Ask Codex to do anything', 'Would you like to run the following command?'),
        output: (value) => output.push(JSON.parse(value)),
      });
      assert.equal(process.exitCode, 1);
      assert.deepEqual(output, [{ ok: false, error: { arguments: 'queue_invalid_arguments', backend: 'queue_unavailable', dialog: 'queue_dialog_open' }[mode] }]);
      assert.ok(calls.every(([method, args]) => method === 'terminals.attach' && args.readOnly));
    }
    assert.deepEqual(queueError({ code: '/private/path' }), { ok: false, error: 'queue_unavailable' });
  } finally { process.exitCode = originalExit; }
});
