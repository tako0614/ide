# Guarded DeckIDE tmux service update

This operator-run tool is prepared for a future production cutover. Merely
building, packaging, running `plan`, or running `stage` does not stop or restart
DeckIDE. Do not run `apply` while an older direct-PTY terminal is in use.

The candidate package must be exactly `deckide@3.5.49-tmux.20261004.1` and
match the separately reviewed SHA-256. The existing installed package is
`/usr/local/lib/node_modules/deckide` on the inspected host. `plan` checks the
loaded `deckide.service` ExecStart metadata in memory against this path and
accepts only known direct CLI or Node launch shapes. It never prints or stores
the full command, service environment, credentials, or settings. Its new
drop-in replaces the package entry with the candidate's matching entry and
keeps recognized public flags exactly as they were. The base unit and previous
installed package are not edited.

Run from the built candidate source directory, after the candidate tarball and
its report are final. Set `HEALTH` to the actual loopback health endpoint used
by the old service; no auth token is sent. The release parent must already be
on the designated SSD, and the release path must not exist:

```sh
CANDIDATE=/root/dev/deckide-tmux-20261004/artifacts/candidate/deckide-3.5.49-tmux.20261004.1.tgz
SHA256=REPLACE_WITH_REVIEWED_64_HEX_SHA256
RELEASE=/root/dev/deckide-releases/3.5.49-tmux.20261004.1
HEALTH=http://127.0.0.1:8787/health
mkdir --parents --mode=0700 /root/dev/deckide-releases
node ops/terminal-update.mjs plan \
  --candidate "$CANDIDATE" --sha256 "$SHA256" \
  --previous-package /usr/local/lib/node_modules/deckide \
  --release "$RELEASE" --http-unit deckide.service --health-url "$HEALTH"
node ops/terminal-update.mjs stage \
  --candidate "$CANDIDATE" --sha256 "$SHA256" \
  --previous-package /usr/local/lib/node_modules/deckide \
  --release "$RELEASE" --http-unit deckide.service --health-url "$HEALTH"
```

`plan` is read-only. `stage` extracts the SHA-verified candidate into the new
release prefix and runs `npm ci --omit=dev` from the package root using its
published shrinkwrap. This avoids npm 11's observed local-tarball dependency
install behavior, which did not honor the nested lock. It creates a root-private
updater state directory, and archives
only the old package's public `package.json`, `bin`, `dist`, `web/dist`, README,
and LICENSE files. A metadata-only inventory rejects hidden/private and unknown file classes before
content hashing; tar receives exact validated files with `--no-recursion`.
The npm installer gets private empty HOME/cache/config paths and a minimal
environment, so inherited HTTP/session secrets do not reach dependency scripts.
It does not archive `.deckide`, credentials, settings,
environment, sessions, or the old package's dependencies. The old installed
package remains the rollback target. If dependency installation fails, the new
release directory is retained for review; no service unit is changed.

`apply` requires a maintenance window in which new terminal requests are
blocked by the operator. The script cannot make the old HTTP server's process
inventory atomic with its restart. Deliberately finish all existing direct-PTY
sessions first. It reads only `/proc/*/stat` PID, PPID, comm, state and TTY fields
to identify descendants; any shell, PTY, uncertain process state, or changed
HTTP MainPID refuses the update. It takes a second inventory immediately before
restart. The acknowledgements are assertions about actions already completed,
not substitutes for those actions:

```sh
node ops/terminal-update.mjs apply \
  --ack-legacy-finished --ack-no-new-terminals
node ops/terminal-update.mjs verify
```

`plan` and initial `apply` refuse existing reserved broker directories and socket
before any unit mutation, avoiding systemd changes to existing permissions.
`apply` creates only the new broker unit and HTTP drop-in. It starts the broker
before loading the HTTP drop-in. The broker has an independent cgroup and no
reverse dependency on the HTTP service. Systemd creates its private
`/run/deckide-tmux-broker` and `/var/lib/deckide-tmux/terminal-tmux` directories
at mode `0700`; the broker creates the Unix socket at mode `0600`. The socket is
local-only and adds no network or authentication setting. The HTTP drop-in
adds a one-way `Wants`/`After` dependency, the two runtime paths, a broker-required flag, and a matching
candidate ExecStart. Both units retain `KillMode=control-group`; the HTTP base
unit's User, Group, working directory, access rules, and other environment are
inherited unchanged. A broker with live sessions is never stopped or restarted
by this updater.

Before restarting HTTP, the tool verifies every owned tmux registry record's
native IDs, generation, server PID, and cgroup. A live tmux server must be in
the broker cgroup and outside the HTTP cgroup. `verify` checks the unit files,
service metadata, private broker socket, owned sessions, and loopback health.
Unknown registry or cgroup state refuses the operation; there is no automatic
shell recreation, input replay, cleanup, or forced kill.

For rollback, keep the candidate release and old package in place. Block new
terminal requests again, then run:

```sh
node ops/terminal-update.mjs rollback \
  --ack-legacy-finished --ack-no-new-terminals
```

Rollback verifies that its exact HTTP drop-in is still present and unchanged,
checks the old package public-file digest and owned tmux cgroups, removes only
that drop-in, reloads systemd, and selects the untouched old base-unit launcher.
It never stops the broker or its tmux sessions. If the candidate HTTP service
is active, rollback restarts HTTP to use the old package. If a failed candidate
restart left HTTP inactive with `MainPID=0`, rollback first verifies that the
staged HTTP cgroup and every subgroup have no processes or threads, then starts
the old service. Any residual task or unknown cgroup state refuses the start.
Existing candidate tmux shells remain native-attachable but will not appear in
the old UI. If any guard fails, the script refuses and retains unknown state
for operator review. Do not manually remove the broker unit or runtime while
it has live sessions.
