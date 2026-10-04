import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import { registerTerminalQueryHandlers } from '../web/src/components/terminalQueries';

const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm');

function createTerminal(sendResponse: (response: string) => void): XtermTerminal {
  const term = new Terminal({
    cols: 80,
    rows: 24,
    windowOptions: {
      getWinSizePixels: true,
      getCellSizePixels: true,
      getWinSizeChars: true
    }
  });
  Object.defineProperty(term, 'element', {
    configurable: true,
    value: {
      querySelector: (selector: string) =>
        selector === '.xterm-screen'
          ? { getBoundingClientRect: () => ({ width: 800, height: 480 }) }
          : null
    }
  });
  registerTerminalQueryHandlers(term, sendResponse);
  return term;
}

function write(term: XtermTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

test('window size queries use the response callback and honor caller suppression', async () => {
  const primaryReplies: string[] = [];
  const primaryOnData: string[] = [];
  const primary = createTerminal((response) => primaryReplies.push(response));
  primary.onData((data) => primaryOnData.push(data));

  const secondaryReplies: string[] = [];
  const secondaryOnData: string[] = [];
  const secondaryIsPrimary = false;
  const secondary = createTerminal((response) => {
    if (secondaryIsPrimary) secondaryReplies.push(response);
  });
  secondary.onData((data) => secondaryOnData.push(data));

  await write(primary, '\x1b[18t');
  await write(secondary, '\x1b[18t');

  assert.deepEqual(primaryReplies, ['\x1b[8;24;80t']);
  assert.deepEqual(primaryOnData, []);
  assert.deepEqual(secondaryReplies, []);
  assert.deepEqual(secondaryOnData, []);

  const replayReplies: string[] = [];
  const replaying = createTerminal(() => {
    // The caller suppresses replies while replaying terminal history.
  });
  replaying.onData((data) => replayReplies.push(data));
  await write(replaying, '\x1b[18t');
  assert.deepEqual(replayReplies, []);

  primary.dispose();
  secondary.dispose();
  replaying.dispose();
});

test('pixel and cell size queries report the screen dimensions', async () => {
  const replies: string[] = [];
  const term = createTerminal((response) => replies.push(response));

  await write(term, '\x1b[14t\x1b[16t');

  assert.deepEqual(replies, ['\x1b[4;480;800t', '\x1b[6;20;10t']);
  term.dispose();
});

test('pixel and cell size queries are consumed when the screen is unavailable', async () => {
  const replies: string[] = [];
  const onData: string[] = [];
  const term = createTerminal((response) => replies.push(response));
  Object.defineProperty(term, 'element', {
    configurable: true,
    value: { querySelector: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }) }
  });
  term.onData((data) => onData.push(data));

  await write(term, '\x1b[14t\x1b[16t');

  assert.deepEqual(replies, []);
  assert.deepEqual(onData, []);
  term.dispose();
});

test('CSI 14;2 is consumed without a size reply, and DSR still responds', async () => {
  const replies: string[] = [];
  const onData: string[] = [];
  const term = createTerminal((response) => replies.push(response));
  term.onData((data) => onData.push(data));

  await write(term, '\x1b[14;2t\x1b[5n');

  assert.deepEqual(replies, ['\x1b[0n']);
  assert.deepEqual(onData, []);
  term.dispose();
});

test('private cursor DSR is consumed and respects primary and replay gates', async () => {
  const replies: string[] = [];
  const onData: string[] = [];
  let isPrimary = false;
  let replaying = false;
  const term = createTerminal((response) => {
    if (!isPrimary || replaying) return;
    replies.push(response);
  });
  term.onData((data) => onData.push(data));

  await write(term, '\x1b[?6n');
  assert.deepEqual(replies, []);
  assert.deepEqual(onData, [], 'xterm built-in private CPR must be consumed');

  isPrimary = true;
  await write(term, '\x1b[?6n');
  assert.deepEqual(replies, ['\x1b[?1;1R']);
  assert.deepEqual(onData, [], 'primary response uses the callback, not xterm onData');

  replaying = true;
  await write(term, '\x1b[?6n');
  assert.deepEqual(replies, ['\x1b[?1;1R']);
  assert.deepEqual(onData, []);
  term.dispose();
});

test('synchronized redraw mode reports whether a TUI update is in progress', async () => {
  const replies: string[] = [];
  const term = createTerminal((response) => replies.push(response));
  await write(term, '\x1b[?2026$p');
  await write(term, '\x1b[?2026h\x1b[?2026$p');
  await write(term, '\x1b[?2026l\x1b[?2026$p');
  assert.deepEqual(replies, ['\x1b[?2026;2$y', '\x1b[?2026;1$y', '\x1b[?2026;2$y']);
  term.dispose();
});
