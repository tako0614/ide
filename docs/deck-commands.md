# List, rename and delete decks

```sh
deckide deck list
deckide deck list --json
deckide deck rename <deck-id> 'New name'
deckide deck delete <deck-id>
```

Mutation commands accept exact IDs or unambiguous prefixes of at least four
characters. Names are not mutation selectors. These commands use the same local
administrator CLI credential in `<data-dir>/cli.json` as `deckide session`, and
do not change authentication settings. For an independent instance, set both
`DECKIDE_DATA_DIR` and `DECKIDE_URL` to that instance before invoking the CLI.

`GET /api/decks` lists the in-memory decks. `PATCH /api/decks/:id` accepts
`{ "name": "..." }`; the name must be a nonblank string and is trimmed. Other
deck fields remain unchanged. SQLite is updated before the same in-memory deck
object, and `deck.updated` refreshes connected browsers through the event stream.
Invalid input returns 400, an unknown deck returns 404, and missing persisted
metadata returns 409 without changing memory.

`DELETE /api/decks/:id` returns 409 if **any** terminal remains in memory or the
database, including unattached displays, legacy records and records associated
with another tmux socket. It never kills or detaches a terminal or removes its
metadata. An empty deck is removed from both SQLite and memory and emits
`deck.deleted`. CLI errors exit with status 1 and show the API's refusal reason.

`deck-metadata.test.ts` verifies safe deletion, validation, events and write
failure atomicity. `deck-commands.test.mjs` exercises the actual CLI and API with
authentication enabled, verifies deletion refusal for unattached metadata, and
checks that renamed decks survive a server restart.
