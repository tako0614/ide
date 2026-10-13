import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyStickyModifiers,
  encodeTerminalKey,
  getStickyModifiers,
  setStickyModifier,
} from '../web/src/components/terminalInput.ts';
import {
  buildTerminalSocketUrl,
  computeViewportScale,
  isTerminalReport,
} from '../web/src/components/terminalViewport.ts';

test('latched Ctrl turns the next typed character into a control byte, once', () => {
  setStickyModifier('ctrl', true);
  assert.equal(applyStickyModifiers('c'), '\x03');
  assert.equal(getStickyModifiers().ctrl, false);
  assert.equal(applyStickyModifiers('c'), 'c');

  setStickyModifier('ctrl', true);
  assert.equal(applyStickyModifiers('['), '\x1b');
  setStickyModifier('ctrl', true);
  assert.equal(applyStickyModifiers(' '), '\x00');
});

test('latched modifiers leave pastes and escape sequences alone', () => {
  setStickyModifier('ctrl', true);
  assert.equal(applyStickyModifiers('hello'), 'hello');
  assert.equal(applyStickyModifiers('\x1b[A'), '\x1b[A');
  assert.equal(getStickyModifiers().ctrl, true);
  setStickyModifier('ctrl', false);
});

test('latched Alt prefixes ESC; Ctrl+Alt combine', () => {
  setStickyModifier('alt', true);
  assert.equal(applyStickyModifiers('b'), '\x1bb');
  setStickyModifier('alt', true);
  setStickyModifier('ctrl', true);
  assert.equal(applyStickyModifiers('a'), '\x1b\x01');
  assert.deepEqual(getStickyModifiers(), { ctrl: false, alt: false });
});

test('named keys honour cursor-key mode and modifiers', () => {
  assert.equal(encodeTerminalKey('up', false), '\x1b[A');
  assert.equal(encodeTerminalKey('up', true), '\x1bOA');
  assert.equal(encodeTerminalKey('backtab', false), '\x1b[Z');
  assert.equal(encodeTerminalKey('pagedown', false), '\x1b[6~');
  setStickyModifier('ctrl', true);
  assert.equal(encodeTerminalKey('right', true), '\x1b[1;5C');
  assert.equal(getStickyModifiers().ctrl, false);
  setStickyModifier('alt', true);
  assert.equal(encodeTerminalKey('escape', false), '\x1b\x1b');
});

test('viewport scale only ever shrinks, and ignores sub-pixel differences', () => {
  assert.equal(computeViewportScale({ width: 500, height: 300 }, { width: 800, height: 600 }), 1);
  assert.equal(computeViewportScale({ width: 840, height: 480 }, { width: 420, height: 600 }), 0.5);
  assert.equal(computeViewportScale({ width: 1000, height: 1000 }, { width: 997, height: 1000 }), 1);
  assert.equal(computeViewportScale({ width: 0, height: 0 }, { width: 10, height: 10 }), 1);
});

test('terminal-generated reports are told apart from typing; socket URL carries size, claim and protocol', () => {
  for (const report of ['\x1b[I', '\x1b[O', '\x1b[?12;40R', '\x1b[12;40R', '\x1b[2004;1$y', '\x1b[?62;22c',
    '\x1b]4;1;rgb:cdcd/3131/3131\x07\x1b]4;2;rgb:0d0d/bcbc/7979\x07', '\x1b[<35;10;5M', '\x1b[M !!']) {
    assert.ok(isTerminalReport(report), JSON.stringify(report));
  }
  for (const typed of ['a', '\r', '\x1b[A', '\x03', '\x1b', 'ls -la\r']) {
    assert.ok(!isTerminalReport(typed), JSON.stringify(typed));
  }
  const url = new URL(buildTerminalSocketUrl('ws://h/api/terminals/t', {
    token: 'tok', bufferOffset: 42, cols: 80, rows: 24, claim: true,
  }));
  assert.equal(url.searchParams.get('proto'), '2');
  assert.equal(url.searchParams.get('token'), 'tok');
  assert.equal(url.searchParams.get('bufferOffset'), '42');
  assert.equal(url.searchParams.get('cols'), '80');
  assert.equal(url.searchParams.get('claim'), '1');
  const fresh = new URL(buildTerminalSocketUrl('ws://h/api/terminals/t', {}));
  assert.equal(fresh.searchParams.get('bufferOffset'), null);
  assert.equal(fresh.searchParams.get('cols'), null);
});

test('desktop keys: chars map to keysyms, chords wrap keys in modifier presses', async () => {
  const { keysymForChar, chordEvents, isKeyboardText, XK } = await import('../web/src/components/desktopKeys.ts');
  assert.equal(keysymForChar('a'), 0x61);
  assert.equal(keysymForChar('é'), 0xe9);
  assert.equal(keysymForChar('あ'), 0x01003042);
  assert.equal(keysymForChar('\n'), XK.Return);
  assert.equal(keysymForChar('\x01'), null);
  assert.ok(isKeyboardText('ls -la ~/x\n'));
  assert.ok(!isKeyboardText('こんにちは'));
  assert.deepEqual(chordEvents({ modifiers: ['ctrl', 'shift'], keysym: 0x74 }), [
    { keysym: XK.Control_L, down: true }, { keysym: XK.Shift_L, down: true },
    { keysym: 0x74, down: true }, { keysym: 0x74, down: false },
    { keysym: XK.Shift_L, down: false }, { keysym: XK.Control_L, down: false },
  ]);
});
