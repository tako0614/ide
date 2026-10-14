# Inspect and replace Codex follow-up messages

Use the same private `DECKIDE_DATA_DIR` or `DECKIDE_SESSION_SOCKET` as the
intended backend. Terminal selectors accept an ID, unique prefix, list number,
or exact title, as the other session commands do.

```sh
deckide session queue show TERMINAL
deckide session queue replace TERMINAL 'Replacement follow-up text'
```

`show` returns JSON such as
`{"id":"…","count":2,"messages":["First follow-up","Last follow-up"]}`.
It captures the current screen read-only. `messages` contains the displayed
text in order; continued display rows are separated by newline characters.
Codex does not expose its in-memory TUI queue through DeckIDE's terminal API,
so this command requires a complete recognizable queue preview. Clipped,
truncated, hidden, pasted/attachment placeholders and unknown screens fail
with a JSON error and exit status 1 rather than reporting an incomplete count.
Resize the intended test/client view yourself if necessary; the command does
not resize terminals. This is the ordinary queued follow-up list, not pending
steers awaiting a tool boundary.

`replace` requires an active Codex turn, an empty composer, a visible last
queued message, and the default tmux Shift+Left queue edit binding. It loads
the last message with Shift+Left, confirms the earlier queue is unchanged,
clears the composer with Ctrl+A/Ctrl+K, types the replacement separately,
and presses Enter once as a lone CR (`\r`). It sends no LF or Tab and never
retries Enter. Success additionally returns `"replaced":true` only after the
same number of queued messages, unchanged earlier messages, and the replacement
text appear in the queue with an empty composer.

Quote TEXT as one shell argument. Empty text, control characters (including
CR/LF), more than 8192 bytes, and leading slash/shell commands are refused.
The replacement must fit visibly in the composer and queue preview.
Approval dialogs and questions, including collapsed questions, cause both
commands to refuse with `{"ok":false,"error":"queue_dialog_open"}` and
exit status 1. Replacement checks the screen before each next input step.

The TUI remains interactive and may change between capture and input. Queue
replacement cannot be atomic across other users or model activity. If a dialog,
queue change, unsupported keybinding, or changed CR behavior interrupts the
operation, inspect the terminal yourself before retrying: the old or new text
may remain in the composer, or the replacement may already have been submitted.
In Codex modes where Enter steers rather than requeues, the command reports
failure instead of claiming a successful replacement. It does not silently
fall back to Tab or alter Codex settings. `session send` and `session show`
retain their existing behavior.

The installed Codex 0.162.1 ordinary queue was verified while its built-in
user shell (`!sleep 45`) kept a turn active. In this supported mode, CR queues
the replacement; ordinary model turns can instead steer on CR. The real smoke
uses a fresh HOME/CODEX_HOME, an unauthenticated offline provider pointing to
loopback port 1, and a throwaway DeckIDE server. Run it explicitly with:

```sh
DECKIDE_QUEUE_CODEX_TEST_BINARY="$(command -v codex)" node --test tests/session-queue-live.test.mjs
```

The test first uses `env -u` for every inherited `DECKIDE_*` and `TMUX*`, then
sets its own private data/runtime directories and separate loopback port.
It also exercises deterministic native TUI approval/question fixtures and
records input bytes to prove one CR and no LF/Tab. Teardown removes all test
terminals, stops its HTTP/tmux/Codex processes, asserts cleanup, and deletes
its directories. The native fixture runs in the regular test suite; the real
Codex branch requires the explicit binary variable above.

The preview and edit binding are based on Codex 0.162.1's
[pending input preview](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/bottom_pane/pending_input_preview.rs)
and [input handling](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget/interaction.rs).
