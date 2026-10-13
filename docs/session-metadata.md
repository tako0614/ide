# Move and rename running terminals

`PATCH /api/terminals/:id` accepts `{ "deckId": "...", "title": "..." }`.
Either field can be omitted. Titles are trimmed and must be nonblank; the
destination deck must exist. The response is the same public terminal view as
`GET /api/terminals/:id`. SQLite is updated before the in-memory session. A failed
write leaves the session and its connections unchanged. A successful update
broadcasts `terminal.updated`, including the previous and current deck IDs.

```sh
deckide session move <terminal-id> <deck-id>
deckide session rename <terminal-id> 'New title'
```

Terminal selectors also accept an unambiguous ID prefix, title, or list number.
Move accepts a deck ID, unambiguous prefix, or name. These commands only change
saved metadata: they do not write to the shell, close its connections, resize,
restart, or kill it. The shell's working directory and environment stay as they
were. `deckide new` inside a moved terminal consults the current server metadata
to choose its destination deck, even though the shell's original
`DECKIDE_DECK_ID` is unchanged. Rename changes the saved title; a program's OSC
live title remains independent.

## Optional persistence on this snapshot

The `release/v3.5.49-snapshot` sources use direct PTYs and did not previously
persist terminals. Terminal metadata is now saved in the `terminals` table of
the instance's database. Existing terminal tables are migrated by adding size
and socket columns; saved commands, titles and buffer history are retained.
Existing rows have a null socket and are not attached by a new test instance.
Direct PTYs retain their original lifetime behavior.

To preserve terminal processes across server restarts, install tmux and set
`DECKIDE_TMUX_RUNTIME_DIR` to a dedicated, private directory owned by the server
user (mode `0700`). The instance uses `<runtime-dir>/tmux.sock`; sessions are named
`deckide-<terminal-id>`. Shutdown closes only its display clients, preserving
tmux-owned shells. Startup attaches existing sessions whose database records
match that exact socket. It never re-executes the saved command. Display-client
disconnects are also reattached without replacing the shell. Explicit terminal
deletion terminates that terminal. Deck deletion refuses any remaining terminal,
including persisted records whose displays are not attached.

Each independent instance needs its own port, copied data directory and tmux
runtime directory. Point `DB_PATH` at the copied database and disable browser,
desktop and MCP maintenance in a terminal-only test instance. Do not share the
production data directory or `/var/lib/deckide-tmux` with a test instance.

This optional backend belongs to the snapshot sources. It does not replace or
migrate the separately installed combined release or its existing tmux registry.

## Validation

`npm run build` and `npm test` run the local checks. GitHub Actions runs the same
checks on pull requests, with tmux installed so restart coverage runs.

`terminal-metadata.test.ts` checks both fields, partial/idempotent updates,
validation, SQLite failure atomicity, missing persisted rows, events and live
session identity. `session-metadata.test.mjs` drives the actual CLI and API in
isolated servers. It verifies live output, unchanged shell/child processes,
display-client recovery and persistence across a graceful server restart. Test
workloads exit normally during cleanup; no tmux kill-session/kill-server is used
by these fixtures.
