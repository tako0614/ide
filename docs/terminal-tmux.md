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
HTTP shutdown detaches display clients. Explicit terminal/deck deletion closes
only verified sessions. Unknown or changed identities retain their registry
for investigation and are never automatically restarted or killed.

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

## Canonical grid and external clients

Creation explicitly selects cols/rows (UI default 120 by 32). Every window uses
`window-size manual`, `aggressive-resize off`, `status off`, and an explicit
`resize-window -x ... -y ...`. The internal display client additionally has
`ignore-size`. Even an ordinary external client with a smaller screen does not
select the smallest client's grid. A small native screen displays a portion of
the canonical window; it does not use the browser's scaling.

tmux 3.6 was observed to exit unexpectedly when `window-size manual` appeared in
the startup config. The adapter deliberately applies global and window manual
policy immediately after detached creation, before display attach; pending
creation recovery repeats this step. The generated `.conf` omits that directive.

Browser viewport and font-size controls uniformly scale the entire local frame.
They do not send shared resizes. Headers, splits, terminal order and layout
controls retain the isolated source baseline. There is no additional zoom or
size-lock UI. Explicit shared changes use the authenticated existing MCP resize
tool, `PUT /api/terminals/<UUID>/size` with integer `cols`/`rows` (1..500), or a
WebSocket resize with `explicit: true`. Use DeckIDE's explicit resize API rather
than native `resize-window`, which would leave registry/browser metadata stale.
Do not change `window-size` to smallest/largest/latest or turn on automatic
resizing. Native splitting, renaming, respawning, and moving the managed pane
are outside this adapter's single-pane lifecycle contract.

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
and exact test results. The tarball includes npm-shrinkwrap.json to retain the
tested dependency tree. No global installation or production service was
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
installs dependencies using a private empty npm HOME/cache, minimal installer
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
