# Frozen ChatGPT launcher source contract

This is a product-only source snapshot. No installer, runtime descriptor, authority, credential, evidence, log, downloaded package or browser profile is shipped. Deploy only through the assigned DeckIDE package owner after its integration gates pass. Preparing this snapshot does not activate a desktop or boot service.

## Exact source and path contract

Origin: `/root/dev/deckide-chatgpt-20261004`.

This source revision is deliberately copied verbatim. It is **not relocatable as-is**: the shell wrapper and supervisor pin paths to the source root. Do not run the wrapper from an extracted snapshot assuming it will run that snapshot; it targets the original absolute source path. For another production installation path, the integrating owner must change the path bindings in its own candidate and retest/re-manifest that candidate; do not edit the frozen source or the running source tree.

Required deployment paths/ownership:

| Path | Required owner/mode and purpose |
| --- | --- |
| Source root and parents | root-controlled, no group/other write permission; app account must be able to traverse the root directory to read its helper/config. |
| `launch-chatgpt.sh` | root:root 0755 at the pinned source root. |
| `session-supervisor.py`, `desktop-session.py`, `session-bus.conf` | root:root 0644; supervisor dry-run checks exact modes. |
| Source-root `.app-session-control/` | root:root 0700, exclusive singleton lock and private 0600 logs. Not shipped. |
| Source-root `app-session.json` | Runtime-generated regular root:root 0600 descriptor. Not shipped. |
| Source-root `app-work/` | Dedicated app UID/GID 0700, initial writable working folder. Not shipped. |
| `/var/lib/chatgpt-app` | Existing locked, no-login/no-sudo `chatgpt-app` HOME, app UID/GID 0700. Keep all login/config state. |
| HOME `.codex`, `.config`, `.cache`, `.cache/tmp`, `.local`, `.local/share` | App UID/GID 0700. Existing state is retained. |
| `/run/chatgpt-app` | App UID/GID 0700 private runtime; fresh private authority for each owned generation. Not shipped. |
| `app-config.example.toml` | Newly authored public defaults only. For a new HOME, installer may seed HOME `.codex/config.toml` app-owned 0600 after authorization; never replace an existing config or copy root credentials. |

App UID/GID are resolved from the account database; do not hardcode numeric IDs in integration. No supplementary groups, sudo/polkit/ACL expansion, logind linger or new boot service. Ordinary installed prerequisites are official ChatGPT (`/usr/bin/chatgpt`), Xvfb, Openbox, Xauth, xdpyinfo, xwininfo, DBus/dbus-run-session, Python 3 with pidfd support and Bash. This snapshot does not install or trust packages.

The current host requires root-owned Xvfb for private lock/socket creation under inaccessible `/tmp`. It uses private authentication and `-nolisten tcp`. DBus/Openbox/ChatGPT/Codex run as the dedicated nonroot account, with cleared supplementary groups and a clean app-only environment. No `--no-sandbox`, `-ac`, `xhost+`, root display reuse or global security changes. Root CLI/config/auth and browser profiles are never inherited/copied. The isolated user must perform its own app login; the launcher neither inspects nor performs it.

## Backend interface

Pinned entrypoint: `/root/dev/deckide-chatgpt-20261004/launch-chatgpt.sh`.

| Operation | Exact arguments |
| --- | --- |
| Opt-in production foreground lifecycle | `run --lifecycle deckide-owned` |
| Read-only plan | `run --lifecycle deckide-owned --dry-run` |
| Read trusted descriptor | `status` |
| Guarded stop | `stop --session-id <ID read from trusted descriptor>` |
| Explicit bounded development lifecycle | `start --lifetime-seconds 3600` |

An already-authorized root:root DeckIDE backend must spawn `run` as a **direct foreground child**, retain the child handle/exit event and consume its single stdout descriptor-path line. No shell, detached process, extra tmux server, nohup or broad daemon supervisor. The actual direct parent cannot be PID 1; its captured PID/starttime/UID/GID remains the lifecycle owner. App output goes to private control logs, not protocol stdout or frontend. Coalesce backend start requests. Exclusive flock is authoritative; a duplicate exits without starting a desktop or overwriting the descriptor. Do not adopt another owner's generation or a bounded development desktop.

Production rejects fixed-lifetime arguments and requires explicit opt-in. `status` verifies O_NOFOLLOW/fstat/regular file/root ownership/0600/bounded size; the consumer must additionally validate identity/liveness. Production stop requires its immutable session-ID guard; stale stop requests cannot stop a replacement. SIGTERM is sent through a pidfd only after matching the recorded supervisor identity. Future deployments preserve the dedicated HOME/config/login across orderly restarts.

## Descriptor schemas and atomic lease

Schema v1 (`chatgpt-private-desktop/v1`) is bounded with immutable `expires_utc` and `session_deadline_utc`; legacy missing lifecycle mode means bounded. Additive session/anchor fields do not convert its fixed deadline.

Schema v2 (`chatgpt-private-desktop/v2`) is opted-in production: `lifecycle_mode=deckide-owned`, immutable random `session_id`, captured `owner_process`, current `supervisor`, stable `anchors`, live descendant `processes`, `lifetime_seconds=null`, `session_deadline_utc=null`. Heartbeat interval is 2 seconds, lease validity 10 seconds. `heartbeat_sequence` increases; `updated_utc` records publication and `expires_utc` rolls to publication plus 10 seconds. That expiry is descriptor validity, not a one-hour desktop deadline. A v1-only borrower must reject v2 until rolling-lease support is explicitly implemented.

Publication rereads actual supervisor metadata, first matching original PID/starttime/UID/GID. A detached bounded child may reparent; the publisher records observed PPID rather than caching bootstrap metadata or fabricating PID 1. Active production requires its direct PPID to remain the captured live DeckIDE owner. It never rebinds ownership. Every heartbeat validates owner and stable desktop identities; zombies, PID reuse, credential changes or anchor exit stop the owned session.

Each descriptor is written to an O_EXCL/O_NOFOLLOW root-owned 0600 temporary file, flushed/fsynced and atomically replaced. Consumer: open with O_NOFOLLOW and verify metadata/schema/state, fresh lease, increasing sequence in the same immutable session ID, non-zombie supervisor/owner/anchor PID+starttime+UID/GID and actual parent relationship. Reopen on replacement, before each attach/reuse and at least every 2 seconds during transport. A transient reparenting mismatch requires a fresh heartbeat and full revalidation, not globally ignoring PPID. Never watch only an old inode, cache an initial rolling expiry forever or write/extend the descriptor. Unknown schema/mode or generation change requires detach and fresh validation.

Use only the descriptor's newly allocated display and private app-owned authority. Accept four-digit display numbers. Verify real private runtime directory and non-symlink regular authority (0700/0600 respectively); never print/send authority bytes, broaden access or copy it to global/root authority. Authenticated same-host private GUI transport is provided by the integrating GUI owner, not this package. No public unauthenticated VNC/WebSocket transport.

## Teardown and limits

Owner exit, stable app/session exit, explicit SIGTERM/SIGINT/SIGHUP or bounded deadline trigger scoped cleanup. The supervisor records only its owned descendants and signals matching identities through pidfds; foreign UID/GID and unrelated root identities are excluded. TERM gets a short grace period, then remaining recorded processes get identity-checked KILL. It removes only its trusted authority, marks the descriptor stopped/failed with immediate expiry and releases the singleton. Private runtime cache directories may persist for reuse. HOME/login/config are retained; no logout, home/cache wipe or root credential access.

The backend should request guarded stop on graceful shutdown and await its retained child exit, allowing up to 15 seconds. The GUI borrower tears down only its own transport on stale lease, owner/session exit or generation change; it does not own app stop. A stale session-ID error is not permission to stop a replacement. SIGKILL cannot run finally cleanup; consumers detach and the backend reports failure instead of blind relaunch or broad process reaping. No general orphan-reaper, automatic boot startup or unbounded restart loop is provided.

## Frozen files and isolated validation

`MANIFEST.json` binds the exact payload names/SHA256/deployment modes and a content-addressed package ID. `SHA256SUMS` covers all seven product payload files plus the manifest; the checksum file cannot hash itself. The archive is deterministic and supplied with a separate SHA256. Snapshot files are read-only root-owned artifacts, not the required deployment modes above; verify content before installing a candidate. Any adaptation produces a new manifest/ID under the integrating owner's control.

For isolated tests, make a writable disposable copy containing only `session-supervisor.py` and `test-session-lifecycle.py`. In that copy run:

```sh
/usr/bin/python3 -I -B test-session-lifecycle.py -v
```

Tests use mocked identities/signals/clocks and disposable descriptor fixtures under their own copied directory; they never start desktop/package/account operations or write the live descriptor. Syntax-check copied Python with `ast.parse`, shell with `/bin/bash -n launch-chatgpt.sh` and DBus XML with ElementTree. Do not run a launcher wrapper/start/stop as a unit test. Do not run tests in the read-only frozen directory.

The 17 focused tests cover lease renewal past one hour, fixed bounded expiry, parent death/reuse/zombies, schema mismatch and stale-stop rejection, pidfd reuse races, cleanup scope, main app anchors, detached reparenting publication and atomic/no-follow descriptors. Actual production activation/restart is not claimed by these tests. The assigned integration owner exercises runtime after its reviewed GUI smoke gate; this source snapshot does not change any running generation.
