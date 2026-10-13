# Deck administration

```sh
deckide deck list
deckide deck list --json
deckide deck rename <deck-id> 'New name'
deckide deck delete <deck-id>
```

List prints full deck IDs, names and roots. `--json` returns the deck array from
`GET /api/decks`, including workspace IDs and creation timestamps. Rename and
delete require an exact ID from that list; names and ID prefixes are not accepted.

These commands use the same local-admin connection and private `cli.json` bearer
token as the terminal `session` commands. They add no MCP tools or OAuth scopes.

`PATCH /api/decks/:id` accepts `{ "name": "New name" }`. A name must be a string
and nonblank after trimming. The response is the updated deck. SQLite is updated
before the in-memory object; a failed write changes neither memory nor events.
Missing decks return 404 and missing persisted metadata returns 409. A successful
rename emits `deck.updated`, which updates connected web clients without reloading
or changing the selected deck or its terminals. The saved name survives restart.

CLI deletion sends `DELETE /api/decks/:id?ifEmpty=1`. The server checks both live
in-memory terminals and all persisted terminal rows for that deck, including
unattached, legacy and foreign-socket records. Any remaining terminal returns
409 without cleanup, shell input, termination, connection closure or state events.
The check and deletion run synchronously in one request handler; a separate CLI
list preflight is not used to determine emptiness. An empty deck is removed from
SQLite and memory and emits `deck.deleted`. A missing deck returns 404.

The empty-only precondition also works when authentication is disabled and no
CLI token is available. Existing browser and MCP deletes without `ifEmpty=1`
retain their explicit cascading behavior, including terminal termination.

`tests/deck-admin.test.ts` covers persistence, validation, DB failure atomicity,
events, live and saved terminal deletion refusal, and cascading compatibility.
`tests/deck-cli.test.mjs` exercises the real CLI and server in isolated directories,
including local-admin authentication, restart readback and the token-free
authentication-disabled case. Run `npm run build` and `npm test` for local CI.
