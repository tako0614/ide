import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { terminalTmuxSocket, terminalTmuxStatus } from '../src/utils/terminal-process.js';

test('tmux discovery preserves metadata on unverified lookup errors', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deckide-tmux-status-'));
  const oldPath = process.env.PATH;
  const oldError = process.env.DECKIDE_TEST_TMUX_ERROR;
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldError === undefined) delete process.env.DECKIDE_TEST_TMUX_ERROR;
    else process.env.DECKIDE_TEST_TMUX_ERROR = oldError;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(path.join(dir, 'tmux'), '#!/bin/sh\nif [ -n "$DECKIDE_TEST_TMUX_ERROR" ]; then printf "%s" "$DECKIDE_TEST_TMUX_ERROR" >&2; exit 1; fi\n', { mode: 0o700 });
  process.env.PATH = dir;
  const id = '12345678-1234-1234-1234-123456789012';
  for (const message of ['timed out', 'permission denied', 'error connecting: No such file or directory',
    'no server running on /fixture/tmux.sock', 'unexpected failure']) {
    process.env.DECKIDE_TEST_TMUX_ERROR = message;
    assert.equal(terminalTmuxStatus('/fixture/tmux.sock', id), 'unavailable', message);
  }
  for (const message of ["can't find session: deckide-fixture"]) {
    process.env.DECKIDE_TEST_TMUX_ERROR = message;
    assert.equal(terminalTmuxStatus('/fixture/tmux.sock', id), 'missing', message);
  }
  delete process.env.DECKIDE_TEST_TMUX_ERROR;
  assert.equal(terminalTmuxStatus('/fixture/tmux.sock', id), 'live');
});

test('tmux runtime must be private and its socket cannot redirect to another instance', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deckide-tmux-directory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, 'runtime');
  assert.equal(terminalTmuxSocket(undefined), null);
  assert.equal(terminalTmuxSocket(runtime), path.join(runtime, 'tmux.sock'));
  chmodSync(runtime, 0o755);
  assert.throws(() => terminalTmuxSocket(runtime), /must be private/);
  chmodSync(runtime, 0o700);
  const foreign = path.join(dir, 'foreign');
  mkdirSync(foreign);
  symlinkSync(path.join(foreign, 'tmux.sock'), path.join(runtime, 'tmux.sock'));
  assert.throws(() => terminalTmuxSocket(runtime), /must not be a symlink/);
});
