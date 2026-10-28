# DeckIDE tmux terminal candidate

This candidate changes new terminals to tmux. It does not migrate, restart, or
close terminals belonging to an older DeckIDE process. Keep that process running
until its users have deliberately finished those terminals.

## Ownership and stable identity

Each terminal has its own tmux server and Unix socket. Its DeckIDE UUID, tmux
session name `deckide-<UUID>`, socket path, native session/window/pane IDs, shell
PID, server PID, and generation are recorded in an owner-only registry. The
default runtime is `$DECKIDE_DATA_DIR/terminal-tmux` (normally
`$HOME/.deckide/terminal-tmux`); `DECKIDE_TMUX_RUNTIME_DIR` may select an absolute,
short, private directory. Linux Unix socket paths must fit in 107 bytes.
The prepared systemd units explicitly use `/var/lib/deckide-tmux/terminal-tmux`.

The HTTP process owns a normal tmux display client and a headless xterm screen.
Viewer reconnects receive an ordered complete screen snapshot, including the
alternate screen and incomplete UTF-8/ANSI parser tail. Snapshot bytes are
distinct from live output offsets. Input is sent once through the live client;
failed writes, shell creation, and input are never replayed. Shell exit is
recognized only after checking the recorded tmux identity and dead-pane state.
HTTP shutdown detaches display clients. Explicit terminal deletion closes
only verified live sessions. If the recorded server and shell are gone and no
Unix listener remains, `DELETE /api/terminals/:id` removes the dead registry,
config, stale socket and both database projections, returning 204. It also
removes DB-only rows whose canonical native resources are already absent.
Deck deletion refuses any remaining terminal. Unknown or changed identities
retain their registry for investigation and are never automatically restarted
or killed.

Creation retains the service user, inherited environment, original shell and
arguments, and deck cwd. Each fresh server receives that creation environment,
so later clients cannot replace PATH, HOME, CODEX_HOME, or launcher settings.
No Codex configuration, profile, provider, model, or login is rewritten. tmux
necessarily supplies its own TERM/TMUX/TMUX_PANE terminal context. Registry and
generated tmux configuration contain no environment values or command text.
Registry and pending records reject unknown keys, including injected environment
objects; broker creation validates the same strict pending schema before exec.
The existing DeckIDE UTF-8 fallback and terminal metadata variables remain.
tmux's own copy mode provides terminal history to native clients.

## Shared size: the client used last decides

Creation explicitly selects cols/rows (UI default 120 by 32). Every window uses
`window-size manual`, `aggressive-resize off`, `status off`, and an explicit
`resize-window -x ... -y ...`. The internal display client additionally has
`ignore-size`. tmux itself never picks a client's size; DeckIDE resizes the
window explicitly (registry, browsers and the server-side screen follow), and
a request for the size the window already has is ignored.

Who asks for a resize:

- **Web, "フィット" (native) mode**: a tile that the user clicked or typed into
  asks for the grid that fits it, and keeps doing so on viewport/font changes
  while it stays in use. Focus alone (page load, switching terminals) does not
  take the size, and a size this tile did not ask for (another client in use)
  stops it from re-asserting until it is used again.
- **CLI, `deckide session attach`**: relays a native tmux client through a local
  pty and asks for the local tty size on attach, when the user types (at most
  once a second; terminal-generated replies do not count) and when the local
  window is resized. `--read-only` attaches without ever changing the size.
- Explicit API: `PUT /api/terminals/<UUID>/size`, the MCP resize tool, or a
  WebSocket resize with `explicit: true`.

Every other view shows the same grid: browser tiles not in use scale the whole
grid down to fit (never up); a native tmux client smaller than the window shows
a part of it. Nothing is ever drawn at another width, so full-screen programs
do not tear. "全体" (overview) mode always scales the grid and never resizes.

tmux 3.6 was observed to exit unexpectedly when `window-size manual` appeared in
the startup config. The adapter deliberately applies global and window manual
policy immediately after detached creation, before display attach; pending
creation recovery repeats this step. The generated `.conf` omits that directive.
Use DeckIDE's resize API rather than native `resize-window`, which would leave
registry/browser metadata stale. Do not change `window-size` to
smallest/largest/latest or turn on automatic resizing. Native splitting,
renaming, respawning, and moving the managed pane are outside this adapter's
single-pane lifecycle contract.

## Terminal UI: `deckide`

`deckide ui` — or plain `deckide` in a terminal while the backend runs — shows
the web UI's decks and terminal grid inside the terminal: deck tabs on top, one
pane per terminal (the same shared tmux terminals the web UI shows), a hint
line at the bottom. Each pane is a native tmux client on a local pty whose
output a headless xterm parses; only changed rows are redrawn. Keys go to the
focused terminal; Ctrl+] then a key drives the UI: `n` new terminal, `c` new
deck (directory), `x` close, `z` zoom, arrows/Tab/1-9 move focus, `[` `]`
switch deck, `a` AI sessions (Codex / Claude Code / OpenCode; Enter opens the
running terminal or resumes in a new one, `v` reads the conversation), `s` bring
the terminal to the front in open web UIs, `q` leave (everything keeps
running), `?` help. Mouse: deck tabs switch, clicking a pane focuses it.
A terminal cannot scale text like the browser, so opening the grid or changing
its layout fits every visible terminal to its pane; afterwards the usual rule
applies (typing re-asserts the focused pane). The deck/terminal list is
refreshed every 1.5 s, so terminals created elsewhere appear.

## Session CLI and live state

`deckide session` talks to the running backend over its owner-only Unix socket
(`$DECKIDE_DATA_DIR/cli/control.sock`): `list`, `new`, `run`, `attach`, `send`,
`show`, `focus`, `kill`, `history`, `read`. TERMINAL arguments accept an ID, a
unique ID prefix, the number from `list`, or a title. Ctrl-b d detaches and
leaves the shell running. `show [--lines N]` prints the screen as text and
changes nothing (agents use it to read other terminals); `focus` brings the
terminal to the front of every open web UI, so only use it when a person asks.
Creation, deletion and `focus` are broadcast on `GET /api/events`
(Server-Sent Events, tied to the browser login session), so every open web UI
updates without a reload.

## Exact native list, attach, and detach commands

Use the same operating-system user as DeckIDE. Set `ID` to the UUID returned by
terminal creation/list; those authenticated responses also include `tmux` with
the exact socket path and native IDs. These commands read only the nonsecret
terminal registry, not CLI configuration or credentials:

```sh
RUNTIME="${DECKIDE_TMUX_RUNTIME_DIR:-${DECKIDE_DATA_DIR:-$HOME/.deckide}/terminal-tmux}"
ID='REPLACE_WITH_DECKIDE_TERMINAL_UUID'
SOCKET="$(node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const [dir,id]=process.argv.slice(1); if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid UUID"); const m=JSON.parse(fs.readFileSync(path.join(dir,id+".json"),"utf8")); if(m.id!==id) throw new Error("Identity mismatch"); process.stdout.write(m.socketPath)' "$RUNTIME" "$ID")"
SESSION="deckide-$ID"
tmux -S "$SOCKET" -N list-sessions -F '#{session_name} #{session_id}'
tmux -S "$SOCKET" -N list-panes -t "=$SESSION" -F '#{window_id} #{pane_id} pid=#{pane_pid} #{pane_width}x#{pane_height}'
tmux -S "$SOCKET" -N show-options -w -v -t "=$SESSION:0" window-size
env -u TMUX tmux -S "$SOCKET" -N attach-session -E -f ignore-size -t "=$SESSION"
```

For the prepared production units, set
`RUNTIME='/var/lib/deckide-tmux/terminal-tmux'` instead of the default first line.
The authenticated API's exact socket path is authoritative for another runtime.

`ignore-size` in the recommended command is additional protection. The manual
window-size policy also applies to a plain native attach without that flag.
Detach the client you attached by pressing **Ctrl-b, then d**. This does not
close the shell. To detach one specific native client from another terminal:

```sh
tmux -S "$SOCKET" -N list-clients -F '#{client_name} #{client_tty}'
CLIENT='/dev/pts/REPLACE_WITH_THE_CLIENT_YOU_ATTACHED'
tmux -S "$SOCKET" -N detach-client -t "$CLIENT"
```

Do not use `attach-session -d`, untargeted `detach-client`, `kill-server`, or
`kill-session` for viewing/detaching: these can disconnect other viewers or end
the managed shell. `-N` prevents these commands from bootstrapping a new server
when the recorded socket is absent. To list all DeckIDE IDs without reading
private settings:

```sh
node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const dir=process.argv[1]; for(const f of fs.readdirSync(dir).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f))) { const m=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8")); console.log(m.id,m.sessionName,m.socketPath,m.cols+"x"+m.rows); }' "$RUNTIME"
```

## Production supervision boundary

Development-process restart survival does not establish systemd-unit restart
survival. A daemonized tmux server created by the HTTP service still belongs to
that service's cgroup. With `KillMode=control-group`, stopping the unit kills
that cgroup, including tmux and its shells.

This package includes the independent creation broker, client bridge, broker
unit, HTTP drop-in templates, and `ops/terminal-update.mjs`. The HTTP drop-in sets `DECKIDE_TMUX_BROKER_REQUIRED=1`. Creation fails closed
if its broker socket is absent; the production runtime also requires broker
creation. Direct tmux creation is retained for isolated development runtimes. When
`DECKIDE_TMUX_BROKER_SOCKET` is set, the HTTP adapter sends a bounded creation
request through private stdin/Unix IPC. The broker validates the exact tmux
operation, paths, private pending/config files and generation, then creates the
dedicated server in its own cgroup with the original environment/cwd. Neither
IPC request nor environment is written to disk or logged. Discovery, display
attach and verified close remain with the HTTP adapter.

The root identity matches the inspected existing service; the updater refuses
another user/group or DynamicUser configuration. The broker socket is 0600 in
`/run/deckide-tmux-broker` (0700), and its state directories are 0700. These are
new private local resources, with no network listener or access expansion. Both
units retain `KillMode=control-group`. The broker has no PartOf/BindsTo relation
to HTTP; HTTP Wants/After broker establish startup ordering. Broker Restart=no
is deliberate: stopping that unit kills its tmux cgroup. The updater never
stops/replaces an in-use broker.

Direct development HTTP restart and broker-backed development HTTP restart are
tested separately. No production units were installed or activated here, and
no production HTTP-unit restart test was run. Unit syntax checks and simulated
cgroup guards do not establish production systemd survival. After the operator
applies the reviewed update, qualify one disposable session through an HTTP
unit restart and verify its identity/PID and broker cgroup before claiming that
production gate. Broker-unit restart is not a persistence claim.

## Candidate installation and rollback (operator actions only)

The artifact report records candidate version, source commit, tarball SHA-256
and exact test results. The tarball includes npm-shrinkwrap.json. The updater extracts the reviewed
package into its fresh prefix and runs `npm ci --omit=dev` with that package as
the install root, retaining the tested dependency tree. npm 11 local-tarball
installation as a dependency was observed to ignore the nested shrinkwrap, so
ordinary `npm install <tarball>` is not this candidate's qualified update path. No global installation or production service was
updated. The guarded updater stages a new SSD prefix and retains the previous
installed package; the dirty original and GUI worker's tree remain untouched.

```sh
CANDIDATE='/root/dev/deckide-tmux-20261004/artifacts/candidate/deckide-3.5.49-tmux.20261004.1.tgz'
RELEASE='/root/dev/deckide-releases/3.5.49-tmux.20261004.1'
PREVIOUS='/usr/local/lib/node_modules/deckide'
UPDATER='/root/dev/deckide-tmux-20261004/source/ops/terminal-update.mjs'
SHA256='COPY_THE_EXACT_SHA256_FROM_THE_ARTIFACT_REPORT'
# Create only the separate release parent; existing directory permissions are unchanged.
mkdir --parents --mode=0700 /root/dev/deckide-releases
# Use a fresh release/state prefix.
node "$UPDATER" plan --candidate "$CANDIDATE" --sha256 "$SHA256" --previous-package "$PREVIOUS" --release "$RELEASE" --http-unit deckide.service --health-url http://127.0.0.1:8787/health
node "$UPDATER" stage --candidate "$CANDIDATE" --sha256 "$SHA256" --previous-package "$PREVIOUS" --release "$RELEASE" --http-unit deckide.service --health-url http://127.0.0.1:8787/health
```

`plan` reads public package/lifecycle metadata and writes nothing. `stage`
extracts the SHA-verified candidate and installs its exact lock with root
`npm ci`, using a private empty npm HOME/cache, minimal installer
environment and distinct empty user/global configs, creates private updater state and a public-file rollback
archive, and starts no service. The updater checks exact tarball/version, public
tree hashes, actual prior entry path, recognized launch flags and prior package
identity. It keeps CLI bootstrap semantics if the old service used them. Unknown
launch shapes fail closed. Smoke installation used a separate disposable prefix.
Use the same user, shell, cwd, environment, CODEX_HOME, CLI launchers, DeckIDE
data directory, and existing access settings when the parent/operator later
selects the new release. Keep the prior installed release directory and launch
command intact. A different test data directory is required for a side-by-side
trial; do not let two HTTP services manage the same terminal runtime.

Before `apply`, users must deliberately finish legacy direct-PTY sessions and
coordinate a maintenance interval with no new terminal creation. The updater
requires both acknowledgements and a fresh read-only PID/TTY inventory, refuses
remaining or uncertain legacy terminals, and leaves the old HTTP process alive
on that refusal. It neither migrates nor automatically closes legacy sessions.
The inventory is not an atomic lock on the old server: the no-new-terminal
maintenance condition is required throughout apply/rollback.

```sh
node "$UPDATER" apply --ack-legacy-finished --ack-no-new-terminals
node "$UPDATER" verify
```

Plan and apply refuse pre-existing reserved broker directories/socket as well as
unit/drop-in files, preserving their permissions. Apply writes a new broker unit
and HTTP drop-in, starts
the independent broker first, rechecks process/identity/cgroup boundaries and
then replaces the HTTP process. It changes neither the base unit's access
settings nor terminal shell/CLI settings. Verify checks loaded package entry,
unit/file hashes, private socket, loopback health and known live tmux server
placement in the broker cgroup. This guarded user-run operation was not executed
here. The parent retains development registration and remote-control ownership.

Rollback selects the unchanged prior installed release and its prior launch
command/settings. An older release will not display the tmux registry. Keep
candidate tmux sessions accessible through the exact native attach commands,
and never delete their runtime or kill their server as a rollback shortcut.
The supplied `artifacts/baseline/deckide-3.5.49.tgz`
is a build of the inspected dirty-source snapshot, **not** proof of the currently
installed production release and not a substitute for preserving that release.

```sh
node "$UPDATER" rollback --ack-legacy-finished --ack-no-new-terminals
```

Rollback verifies the previous package/archive and exact updater-created
drop-in, removes only that drop-in and restores the unchanged base launcher.
It checks placement before HTTP restart and leaves broker/tmux sessions running.
If a failed candidate restart left HTTP inactive with MainPID=0, rollback requires
the staged HTTP cgroup and all subgroups to contain no processes or threads, then
starts the unchanged previous launcher. Residual or unknown tasks cause refusal.
Uncertain identity, placement or partial-update state causes refusal rather than
cleanup. The public archive first validates all member names/classes without reading
member contents, rejects hidden/private or unknown files, then archives exact
public files without recursive directory expansion. It excludes settings,
credentials, environment and terminal runtime/history. The old package remains installed at its original path.

## Verification

The baseline build/tests run before edits are recorded separately from final
candidate results. The terminal acceptance suite and full repository regression
suite are separate commands. The full suite creates only disposable private
fixtures, including its own Xvfb desktop, and does not use existing terminals:

```sh
npm run build
npm run test:terminal:all
DECKIDE_TMUX_TEST_WITH_BROKER=1 npm run test:terminal:live
npm test
```

Run these commands from the isolated source tree; tests are not published in the
runtime npm tarball. Set TMPDIR to a disposable SSD test directory beforehand.
Native tests use only
new sessions, check shell PID across viewer reconnect and HTTP restart, two
viewer geometries and a small native attach, alternate screen, Japanese/Unicode
input, and explicit close. An unavailable tmux binary is an explicit integration
skip, not a pass; it must be resolved before accepting those gates. The packaged
tarball is separately installed into a clean disposable prefix and exercised, so a source-tree build alone is
not package qualification.

Primary references: [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1),
[tmux resize policy](https://github.com/tmux/tmux/blob/master/resize.c), and
[systemd kill policy](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).

## Metadata administration on the recovered .10 base

The production `.10` source is reconstructed from commit
`5593907009721ed3e15b9af66f6b8762ee271ca7` and its recovered source overlay.
Before feature changes, rebuilding matches all 65 installed dist files and all
four web files byte for byte. `docs/source-provenance.json` records the source
and release recovery; the snapshot branch is not this release's source.

`deckide session move <terminal> <deck-id>` and `session rename <terminal> <title>`
use the existing owner-only Unix RPC, as do `deckide deck list [--json]`,
`deck rename <deck-id> <name>` and `deck delete <deck-id>`. Deck mutations accept
an exact ID or an unambiguous ID prefix of at least four characters. Terminal
selectors retain the session CLI rules. Metadata changes neither restart nor
resize the shell, attach another client, nor send terminal input.

`PATCH /api/decks/:id` accepts a nonempty name, trims it, and updates SQLite and
memory before broadcasting `deck.updated`. `PATCH /api/terminals/:id` accepts
`deckId` and/or `title`. It verifies the native identity and current registry,
updates a SQLite projection within a transaction, and atomically replaces the
owner-only registry before committing. Failed writes retain the prior state;
failed compensation revokes host capabilities and makes the display unavailable
until verified restoration. Startup repairs stale SQLite projections from the
canonical native registry, including a crash between registry replacement and
SQLite commit. Moving a terminal revokes its previous host computer capability.
The terminal's working directory and environment remain those of its creation.

The legacy `terminals` table is migrated idempotently with `cols`, `rows` and
`tmux_socket`. Old rows and history are preserved; they are not native adoption
authority. `terminal_metadata` contains only a rebuildable native projection,
without command, output or environment. Deck deletion returns 409 for terminals
in memory, either database table, unavailable registry entries, or pending
creation. An unreadable registry fails closed. A refused deletion never closes
terminal sockets, detaches clients or kills shells.

`npm pack` includes the ops directory, broker, session CLI and reviewed native
launcher pair. `scripts/verify-runtime-package.mjs` validates the actual archive
against the `.10` runtime inventory; changed web asset fingerprints are expected.

## Explicit stale cleanup on deck deletion

Ordinary `deckide deck delete <id>` reports every blocker with its terminal ID,
record source (`registry`, `pending`, `legacy-db`, `native-db`, or `memory`),
state (`live`, `dead`, or `unavailable`), and a fixed classification reason.
`DELETE /api/decks/:id` returns the same structured 409 diagnostics. Large lists
are capped with an explicit remainder; titles, command text and raw exceptions
are not part of these errors.

`deckide deck delete <id> --prune-stale` (or the owner API's
`DELETE /api/decks/:id?pruneStale=true`) explicitly removes obsolete records
before deleting the deck. Any live or unavailable blocker refuses the entire
operation before cleanup starts. A registry-backed terminal is dead only after
both recorded PIDs are absent, its exact canonical socket has no kernel listener,
and any remaining owner-only Unix socket returns ECONNREFUSED. A responsive
tmux session is verified using `has-session -N`, native IDs and generation.
Timeouts, PID reuse, pending creation, unsafe files, changed identities and
unclassifiable entries fail closed. Linux's socket table is checked even when
the socket pathname has already been unlinked.

A registryless DB row can be pruned with reason `no-managed-native-session` only
when its canonical registry, pending record, config, socket pathname and kernel
listener are all absent. A remembered noncanonical socket remains unavailable.
This establishes absence of a managed native session, rather than the death of
an arbitrary process that may have been launched outside DeckIDE. Canonical
orphan resources without an associated registry or DB row are left untouched.

Cleanup rechecks registry bytes/inodes, runtime ownership and native state
immediately before each unlink. It never sends input, detaches clients or issues
a tmux kill command. SQLite row deletion and deck deletion share a writer
transaction. Filesystem cleanup cannot roll back: a later failure can leave
some proven-dead artifacts removed while retaining DB rows and the deck for a
safe retry. Normal creation uses fresh UUIDs and rejects existing artifacts;
external manipulation of runtime files during administration is unsupported.
The CLI allows 60 seconds for explicit pruning; a client disconnect does not
cancel a server operation, so check `deck list` before retrying an uncertain
result. Neither mode changes running terminal processes.

## Codex history storage

DeckIDE exposes Codex history through its existing authorized routes. The index may
live outside the Codex home; transcripts remain confined to that home's
`sessions/` and `archived_sessions/`. This reader does not relocate Codex state.

### Selecting an index

For each source, DeckIDE selects the SQLite directory in this order:

1. The root `sqlite_home` string in that source's `config.toml`.
2. The absolute `CODEX_SQLITE_HOME` captured when the default **current** source
   is constructed. Leading/trailing whitespace is removed; blank means unset.
3. That source's Codex home (the existing layout).

The default current home is `CODEX_HOME`, or `~/.codex`. The legacy Desktop source
uses its own config/home and never borrows the current source's environment.
Root-config relative paths resolve against the config's directory. A nonempty
relative environment path is refused: its native Codex launch directory is not
known to this reader. Explicit missing or invalid locations never fall back to
an old home index. The highest `state_N.sqlite` is selected; an unsafe highest
version is refused rather than skipped.

This is a bounded root-config/environment observer. It does not reconstruct
Codex project, profile, managed, system, or command-line configuration layers.
Do not assume DeckIDE and a separately launched Codex share an environment.
See Codex's [official location settings](https://learn.chatgpt.com/docs/config-file/environment-variables#core-locations)
and [configuration layers](https://learn.chatgpt.com/docs/config-file/config-basic).

### Read and path boundaries

Both directories must exist at their canonical absolute paths with matching UID
and without group/other write permission. Ancestors must belong to root or that
UID and be nonwritable by others (root-owned sticky temporary ancestors are
allowed). Config, index and existing WAL/SHM sidecars must be regular,
single-link files with the home owner's UID. Config reads use `O_NOFOLLOW`, a
1 MiB bound and a TOML parser; malformed or unsafe config makes the source
unavailable. Symlink aliases of the home, SQLite directory, config, index or
rollout are not a supported storage offload mechanism.

Every listed/read rollout must remain an existing canonical `.jsonl` under its
source home's session directories, with matching UID, one link and the existing
256 MiB size bound. Refused rows are removed before list publication/pagination;
an index in the SQLite directory does not authorize transcripts there or under
another source. One read transaction covers batched list queries. A request
scans at most 10,000 matching index rows per source; exhausting that budget before
filling the page makes the source unavailable. Separate page requests can still
overlap or skip entries if native Codex changes the index between requests.

SQLite is opened with `readOnly: true` and `query_only=ON`; this connection cannot
write SQL data, repair, checkpoint or migrate the index. Normal SQLite WAL
readers may create/update coordination sidecars, including SHM metadata. This is
not a bytewise no-touch or immutable snapshot interface. WAL contents are read,
not discarded with `immutable`/locking overrides. Node opens SQLite by pathname;
ownership checks and pre/post inode checks narrow but do not eliminate a rename
race by a trusted directory owner. They do not attest an fd-pinned SQLite inode.

`/api/codex` retains owner-only authorization and generic failures. The broader
`/api/agents` adapter retains access for the owner or verified internal actors
with approved MCP grants; this change does not widen either route. Split
sources have no resume command until native resume parity is separately
qualified; ordinary same-home resume behavior is preserved.

### Verification and application boundary

Run `node --import tsx --test tests/codex-storage.test.mjs` with `TMPDIR` pointing
to disposable SSD storage. Tests create synthetic homes, indexes and transcripts;
they do not use an actual user's Codex home or credentials. Verify a copied
native DB/WAL set separately, keeping it with its matching sidecars. Native
discovery on an empty index alone does not prove conversation read or resume.

Build/package this source through the normal source review and CI path. This
change needs no schema migration. Any later installation uses the existing
[guarded updater and rollback procedure](#candidate-installation-and-rollback-operator-actions-only), with the exact
reviewed source and artifact hashes. First qualify list/read against isolated
copy-state. Preserve the prior package for code rollback; do not move, delete,
symlink or rewrite home/DB/WAL/auth as part of applying or reverting this reader.
Actual storage relocation, live activation and native resume/archive testing are
separate operator actions.
