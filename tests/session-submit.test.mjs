import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_SUBMIT_DELAY_MS, inputStillPending, parseSessionArgs, sendAndSubmit, submitDelayMs } from '../bin/deckide-session.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'submit');
const screen = (name) => readFileSync(path.join(dir, name + '.txt'), 'utf8');
const ping = (word) => `Reply with exactly the word ${word} and nothing else`;
const retire = '引き継ぎ先: /root/hdd/takos-dev/operator-runs/codex-consolidation-20261015/HANDOFF-*.md';

test('inputStillPending recognises unsent prompts in real codex / Claude Code / opencode screens', () => {
  assert.equal(inputStillPending(screen('codex-pending'), ping('PING0TOGETHER')), true);
  assert.equal(inputStillPending(screen('codex-busy-pending'), retire), true);
  assert.equal(inputStillPending(screen('claude-pending'), ping('PING3LF')), true);
  assert.equal(inputStillPending(screen('opencode-lf'), ping('PING3LF')), true);
});

test('inputStillPending treats submitted / working screens as cleared', () => {
  assert.equal(inputStillPending(screen('codex-submitted'), ping('PING1DELAY200')), false);
  assert.equal(inputStillPending(screen('codex-working'), ping('PING2DELAY600')), false);
  assert.equal(inputStillPending(screen('claude-submitted'), ping('PING1DELAY200')), false);
  assert.equal(inputStillPending(screen('opencode-submitted'), ping('PING0TOGETHER')), false);
  assert.equal(inputStillPending(screen('opencode-done'), ping('PING1DELAY200')), false);
  assert.equal(inputStillPending('$ ', 'anything'), false);
  assert.equal(inputStillPending('$ echo sent-$((40+2))\nsent-42\n$ ', 'echo sent-$((40+2))'), false);
  assert.equal(inputStillPending('anything', ''), false);
});

test('send options: --submit-delay and --no-verify parse; delay defaults to 200ms', () => {
  const parsed = parseSessionArgs(['send', 'abcd', 'hi', '--submit-delay', '350', '--no-verify']);
  assert.equal(parsed.args['submit-delay'], '350');
  assert.equal(parsed.args['no-verify'], true);
  assert.throws(() => parseSessionArgs(['send', 'abcd', 'hi', '--submit-delay', 'x']), /invalid_submit_delay/);
  assert.equal(DEFAULT_SUBMIT_DELAY_MS, 200);
  assert.equal(submitDelayMs({}, {}), 200);
  assert.equal(submitDelayMs({ 'submit-delay': '0' }, {}), 0);
  assert.equal(submitDelayMs({}, { DECKIDE_SUBMIT_DELAY_MS: '450' }), 450);
});

function fakeTerminal(screens) {
  const events = [];
  return { events,
    write: async (data) => { events.push(['write', data]); return { bytes: Buffer.byteLength(data) }; },
    wait: async (ms) => { events.push(['wait', ms]); },
    capture: async () => { events.push(['capture']); return screens.shift() ?? ''; } };
}

test('sendAndSubmit writes text, waits, then sends a lone CR and verifies', async () => {
  const t = fakeTerminal(['› Ask Codex to do anything\n']);
  const result = await sendAndSubmit({ text: 'do it', ...t, delayMs: 200 });
  assert.deepEqual(t.events.slice(0, 3), [['write', 'do it'], ['wait', 200], ['write', '\r']]);
  assert.ok(!t.events.some(([kind, data]) => kind === 'write' && data.length > 1 && data.endsWith('\r')));
  assert.deepEqual(result, { bytes: 6, enterAttempts: 1, submitted: true, verification: 'input_cleared' });
});

test('sendAndSubmit retries Enter up to 2 times, then reports pending', async () => {
  const stuck = '› do it\n  GPT-6.1 xhigh · cwd\n';
  const fixed = await sendAndSubmit({ text: 'do it', ...fakeTerminal([stuck, '› Ask\n']) });
  assert.equal(fixed.enterAttempts, 2); assert.equal(fixed.submitted, true);
  const t = fakeTerminal([stuck, stuck, stuck]);
  const failed = await sendAndSubmit({ text: 'do it', ...t });
  assert.equal(t.events.filter(([kind, data]) => kind === 'write' && data === '\r').length, 3);
  assert.deepEqual([failed.submitted, failed.verification, failed.enterAttempts], [false, 'input_still_pending', 3]);
});

test('sendAndSubmit without verification or with a failing capture', async () => {
  const skipped = await sendAndSubmit({ text: 'x', ...fakeTerminal([]), verify: false });
  assert.deepEqual([skipped.submitted, skipped.verification], [null, 'skipped']);
  const t = fakeTerminal([]); t.capture = async () => { throw Error('nope'); };
  const failed = await sendAndSubmit({ text: 'x', ...t });
  assert.equal(failed.verification, 'capture_failed');
});
