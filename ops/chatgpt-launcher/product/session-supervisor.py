#!/usr/bin/python3
"""Isolated desktop: bounded development or explicit foreground DeckIDE ownership."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import stat
import subprocess
import sys
import time

PRODUCT_ROOT = Path(__file__).resolve().parent
DEFAULT_STATE_ROOT = Path("/root/dev/deckide-chatgpt-20261004")
STATE_ROOT_ENV = "CHATGPT_LAUNCHER_STATE_ROOT"
WORKSPACE = Path(os.environ.get(STATE_ROOT_ENV, str(DEFAULT_STATE_ROOT)))
CONTROL = WORKSPACE / ".app-session-control"
DESCRIPTOR = WORKSPACE / "app-session.json"
RUNTIME = Path("/run/chatgpt-app")
PUBLIC_PARENT = Path("/run")
PUBLIC_PREFIX = "deckide-chatgpt-public-"
HOME = Path("/var/lib/chatgpt-app")
APP_WORK = DEFAULT_STATE_ROOT / "app-work"
ACCOUNT = "chatgpt-app"
STOPPING = False
HEARTBEAT_SECONDS = 2
HEARTBEAT_VALID_SECONDS = 10
SCHEMA = "chatgpt-private-desktop/v1"
DECKIDE_SCHEMA = "chatgpt-private-desktop/v2"
PUBLIC_HELPERS = {
    "desktop-session.py": (969, "388664cd9740251d0b5808e7c7aab139d29b32f16454611ce7ef03eb0709e7af"),
    "session-bus.conf": (455, "4a39a9fd1ada39a52ff6a3e13222a84e5edfb5f8dcee41c8752ed40d3ab6a145"),
}

class PublicHelperCleanupRefused(RuntimeError):
    pass

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def identity(pid):
    try:
        path = Path("/proc") / str(pid)
        raw = (path / "stat").read_text()
        tail = raw[raw.rfind(")") + 2:].split()
        uid, gid = path.stat().st_uid, path.stat().st_gid
        return {"pid": pid, "starttime_ticks": int(tail[19]),
                "owner_uid": uid, "owner_gid": gid,
                "comm": (path / "comm").read_text().strip(),
                "ppid": int(tail[1]), "pgid": int(tail[2]), "state": tail[0]}
    except (OSError, ValueError, IndexError):
        return None

def same_process(saved):
    if not valid_identity(saved):
        return False
    current = identity(saved["pid"])
    return current is not None and current.get("state") not in ("Z", "X") and all(
        current[k] == saved[k] for k in ("pid", "starttime_ticks", "owner_uid", "owner_gid"))

def valid_identity(record):
    return isinstance(record, dict) and all(type(record.get(k)) is int for k in
        ("pid", "starttime_ticks", "owner_uid", "owner_gid")) and record["pid"] > 1 and \
        record["starttime_ticks"] > 0 and record["owner_uid"] >= 0 and record["owner_gid"] >= 0

def signal_identity(record, signum):
    """A pidfd pins the checked process; never signal a recycled numeric PID."""
    if not same_process(record):
        return False
    try:
        fd = os.pidfd_open(record["pid"])
    except ProcessLookupError:
        return False
    try:
        if not same_process(record):
            return False
        signal.pidfd_send_signal(fd, signum)
        return True
    except ProcessLookupError:
        return False
    finally:
        os.close(fd)

def owner_identity():
    owner = identity(os.getppid())
    if not valid_identity(owner) or owner["owner_uid"] != 0 or owner["owner_gid"] != 0 \
            or not same_process(owner):
        raise RuntimeError("DeckIDE-owned mode requires a live direct root parent other than PID 1.")
    return owner

def lifecycle_fields(lifetime, owner, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    owned = owner is not None
    return {"session_id": secrets.token_hex(16),
        "lifecycle_mode": "deckide-owned" if owned else "bounded",
        "owner_process": owner,
        "created_utc": now.isoformat(),
        "expires_utc": (now + datetime.timedelta(
            seconds=HEARTBEAT_VALID_SECONDS if owned else lifetime)).isoformat(),
        "session_deadline_utc": None if owned else (now + datetime.timedelta(seconds=lifetime)).isoformat(),
        "lifetime_seconds": None if owned else lifetime,
        "heartbeat_interval_seconds": HEARTBEAT_SECONDS,
        "heartbeat_valid_seconds": HEARTBEAT_VALID_SECONDS if owned else None,
        "heartbeat_sequence": 0}

def renew_descriptor(descriptor, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    descriptor["updated_utc"] = now.isoformat()
    descriptor["heartbeat_sequence"] += 1
    if descriptor["lifecycle_mode"] == "deckide-owned":
        descriptor["expires_utc"] = (now + datetime.timedelta(seconds=HEARTBEAT_VALID_SECONDS)).isoformat()

def lifecycle_stop_reason(owner, deadline, desktop_alive, xvfb_alive, now=None):
    if STOPPING:
        return "stop requested"
    if owner is not None and not same_process(owner):
        return "DeckIDE owner exited or changed identity"
    if deadline is not None and (time.monotonic() if now is None else now) >= deadline:
        return "lifetime expired"
    if not desktop_alive or not xvfb_alive:
        return "owned desktop process exited"
    return None

def session_anchors(snapshot, saved, app_uid, app_gid):
    root = [r for r in saved.values() if r and (r["owner_uid"], r["owner_gid"]) == (0, 0)]
    runners = [r for r in saved.values() if r and (r["owner_uid"], r["owner_gid"]) == (app_uid, app_gid)]
    if len(root) != 1 or len(runners) != 1:
        return None
    anchors = {"xvfb": root[0], "desktop_runner": runners[0]}
    owned = [r for r in snapshot if (r["owner_uid"], r["owner_gid"]) == (app_uid, app_gid)]
    for name, comm in (("dbus", "dbus-daemon"), ("openbox", "openbox")):
        candidates = [r for r in owned if r["comm"] == comm]
        if not candidates:
            return None
        anchors[name] = candidates[0]
    helpers = {r["pid"] for r in owned if r["comm"] == "python3"}
    apps = [r for r in owned if r["comm"] == "ChatGPT" and r["ppid"] in helpers]
    if not apps:
        return None
    anchors["chatgpt"] = apps[0]
    return anchors

def cleanup_permitted(record, saved, app_uid, app_gid):
    if not valid_identity(record):
        return False
    if (record["owner_uid"], record["owner_gid"]) == (app_uid, app_gid):
        return True
    return any(r and r["owner_uid"] == 0 and r["owner_gid"] == 0 and all(record[k] == r[k]
        for k in ("pid", "starttime_ticks", "owner_uid", "owner_gid")) for r in saved.values())

def stop_target(descriptor, session_id):
    mode = descriptor.get("lifecycle_mode", "bounded")
    compatible = descriptor.get("schema") == SCHEMA and mode == "bounded" or \
        descriptor.get("schema") == DECKIDE_SCHEMA and mode == "deckide-owned"
    if not compatible or descriptor.get("state") not in ("ready", "starting", "stopped", "failed"):
        raise RuntimeError("Unexpected session descriptor schema or state.")
    if descriptor.get("lifecycle_mode") == "deckide-owned" and not session_id:
        raise RuntimeError("DeckIDE-owned stop requires --session-id from the trusted descriptor.")
    if session_id and session_id != descriptor.get("session_id"):
        raise RuntimeError("Session ID changed; refusing to stop a replacement session.")
    supervisor = descriptor.get("supervisor")
    if not valid_identity(supervisor) or supervisor["owner_uid"] != 0 or supervisor["owner_gid"] != 0:
        raise RuntimeError("Unexpected supervisor identity.")
    return supervisor

def trusted_file(path, uid, mode):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != uid or stat.S_IMODE(s.st_mode) != mode:
        raise RuntimeError("Unexpected file ownership, type, or permissions: " + str(path))

def directory(path, uid, mode):
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != uid or stat.S_IMODE(s.st_mode) != mode:
        raise RuntimeError("Unexpected directory ownership or permissions: " + str(path))

def validate_state_root_override():
    raw = os.environ.get(STATE_ROOT_ENV)
    if raw is None:
        return
    if not raw or not WORKSPACE.is_absolute() or str(WORKSPACE) != raw or WORKSPACE.resolve(strict=True) != WORKSPACE:
        raise RuntimeError("State-root override must be an existing canonical absolute directory.")
    for source_root in (PRODUCT_ROOT, PRODUCT_ROOT.parent / "source"):
        if WORKSPACE == source_root or source_root in WORKSPACE.parents:
            raise RuntimeError("State-root override cannot be inside launcher source files.")
    for path in reversed((WORKSPACE, *WORKSPACE.parents)):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise RuntimeError("State-root override has an untrusted parent: " + str(path))
    directory(WORKSPACE, 0, 0o700)

def product_file(name):
    return PRODUCT_ROOT / name

def desktop_command(bus_path, desktop_path):
    return ["/usr/bin/dbus-run-session", "--config-file=" + str(bus_path),
            "--", "/usr/bin/python3", "-I", str(desktop_path)]

def verified_public_bytes(name):
    """Read only the two fixed, public package files through a verified file descriptor."""
    expected_size, expected_hash = PUBLIC_HELPERS[name]
    source = product_file(name)
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        named = source.lstat()
        if not stat.S_ISREG(before.st_mode) or (before.st_uid, before.st_gid) != (0, 0) \
                or stat.S_IMODE(before.st_mode) != 0o644 or before.st_nlink != 1 \
                or before.st_size != expected_size or (before.st_dev, before.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError("Public package helper identity changed.")
        data = os.read(fd, expected_size + 1)
        after = os.fstat(fd)
        named = source.lstat()
        if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected_hash \
                or (before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode, before.st_size) \
                != (after.st_dev, after.st_ino, after.st_uid, after.st_gid, after.st_mode, after.st_size) \
                or (after.st_dev, after.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError("Public package helper content changed.")
        return data
    finally:
        os.close(fd)

def path_identity(path):
    value = path.lstat()
    return (value.st_dev, value.st_ino, value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode))

def validate_public_parent():
    """The app must never be able to replace a helper directory or any ancestor."""
    if not PUBLIC_PARENT.is_absolute() or PUBLIC_PARENT.resolve(strict=True) != PUBLIC_PARENT:
        raise RuntimeError("Public helper parent is not canonical.")
    for path in reversed((PUBLIC_PARENT, *PUBLIC_PARENT.parents)):
        value = path.lstat()
        if not stat.S_ISDIR(value.st_mode) or (value.st_uid, value.st_gid) != (0, 0) \
                or stat.S_IMODE(value.st_mode) & 0o022 or not (stat.S_IMODE(value.st_mode) & 0o001):
            raise RuntimeError("Public helper parent is not safely traversable.")
    return path_identity(PUBLIC_PARENT)

def verify_public_directory(helper_dir, dir_saved, parent_saved):
    if helper_dir.parent != PUBLIC_PARENT or not helper_dir.name.startswith(PUBLIC_PREFIX) \
            or len(helper_dir.name) != len(PUBLIC_PREFIX) + 32 \
            or not re.fullmatch(r"[0-9a-f]{32}", helper_dir.name[len(PUBLIC_PREFIX):]) \
            or validate_public_parent() != parent_saved or path_identity(helper_dir) != dir_saved:
        raise RuntimeError("Public helper directory changed.")
    value = helper_dir.lstat()
    if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or stat.S_IMODE(value.st_mode) != 0o750:
        raise RuntimeError("Public helper directory is untrusted.")

def stage_public_helper(name, destination, records, app_gid):
    if name not in PUBLIC_HELPERS or destination.name != name \
            or destination.parent.parent != PUBLIC_PARENT \
            or not destination.parent.name.startswith(PUBLIC_PREFIX):
        raise RuntimeError("Unexpected public helper staging target.")
    validate_public_parent()
    parent_info = destination.parent.lstat()
    if not stat.S_ISDIR(parent_info.st_mode) or (parent_info.st_uid, parent_info.st_gid) != (0, app_gid) \
            or stat.S_IMODE(parent_info.st_mode) != 0o750:
        raise RuntimeError("Public helper directory is untrusted.")
    data = verified_public_bytes(name)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    created = os.fstat(fd)
    try:
        os.fchown(fd, 0, app_gid)
        os.fchmod(fd, 0o640)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        finished = os.fstat(fd)
        if not stat.S_ISREG(finished.st_mode) or (finished.st_uid, finished.st_gid) != (0, app_gid) \
                or stat.S_IMODE(finished.st_mode) != 0o640 or finished.st_nlink != 1 \
                or finished.st_size != len(data) or (finished.st_dev, finished.st_ino) != (created.st_dev, created.st_ino):
            raise RuntimeError("Public helper staging identity changed.")
        record = {"name": name, "path": destination, "dev": finished.st_dev,
                  "ino": finished.st_ino, "uid": finished.st_uid, "gid": finished.st_gid,
                  "mode": stat.S_IMODE(finished.st_mode), "size": len(data),
                  "sha256": PUBLIC_HELPERS[name][1]}
        records.append(record)
    except Exception:
        try:
            named = destination.lstat()
            if not stat.S_ISREG(named.st_mode) or named.st_uid != 0 or named.st_nlink != 1 \
                    or (named.st_dev, named.st_ino) != (created.st_dev, created.st_ino):
                raise RuntimeError("Partial public helper changed; refusing cleanup.")
            destination.unlink()
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(fd)
    return record

def verify_staged_helper(record, helper_dir, dir_saved, parent_saved):
    verify_public_directory(helper_dir, dir_saved, parent_saved)
    if record["path"] != helper_dir / record["name"] or record["name"] not in PUBLIC_HELPERS:
        raise RuntimeError("Unexpected staged public helper path.")
    if (record["size"], record["sha256"]) != PUBLIC_HELPERS[record["name"]]:
        raise RuntimeError("Unexpected staged public helper identity.")
    path = record["path"]
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        named = path.lstat()
        expected = (record["dev"], record["ino"], record["uid"], record["gid"], record["mode"], record["size"])
        actual = (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid,
                  stat.S_IMODE(opened.st_mode), opened.st_size)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or actual != expected \
                or (opened.st_uid, opened.st_gid, stat.S_IMODE(opened.st_mode)) != (0, dir_saved[3], 0o640) \
                or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError("Public helper identity changed.")
        data = os.read(fd, record["size"] + 1)
        after = os.fstat(fd)
        named = path.lstat()
        if len(data) != record["size"] or hashlib.sha256(data).hexdigest() != record["sha256"] \
                or (after.st_dev, after.st_ino, after.st_uid, after.st_gid, after.st_mode,
                    after.st_nlink, after.st_size) != (opened.st_dev, opened.st_ino, opened.st_uid,
                    opened.st_gid, opened.st_mode, opened.st_nlink, opened.st_size) \
                or (after.st_dev, after.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError("Public helper content changed.")
    finally:
        os.close(fd)

def verify_staged_helpers(helper_dir, records, dir_saved, parent_saved):
    verify_public_directory(helper_dir, dir_saved, parent_saved)
    if {record["name"] for record in records} != set(PUBLIC_HELPERS) or len(records) != len(PUBLIC_HELPERS) \
            or set(os.listdir(helper_dir)) != set(PUBLIC_HELPERS):
        raise RuntimeError("Public helper directory has unexpected contents.")
    for record in records:
        verify_staged_helper(record, helper_dir, dir_saved, parent_saved)

def cleanup_public_helpers(helper_dir, records, dir_saved, parent_saved, complete=True):
    if helper_dir is None:
        return []
    try:
        verify_public_directory(helper_dir, dir_saved, parent_saved)
        names = {record["name"] for record in records}
        if len(names) != len(records) or not names.issubset(PUBLIC_HELPERS) \
                or complete and names != set(PUBLIC_HELPERS) or set(os.listdir(helper_dir)) != names:
            raise RuntimeError("Public helper directory has unexpected contents.")
        for record in records:
            verify_staged_helper(record, helper_dir, dir_saved, parent_saved)
        for record in reversed(records):
            record["path"].unlink()
        verify_public_directory(helper_dir, dir_saved, parent_saved)
        if os.listdir(helper_dir):
            raise RuntimeError("Public helper directory gained unexpected contents.")
        helper_dir.rmdir()
        return []
    except (OSError, RuntimeError):
        return ["public helper directory changed or unavailable"]

def stage_public_helpers(app_gid, parent_saved):
    if not isinstance(app_gid, int) or app_gid <= 0 or validate_public_parent() != parent_saved:
        raise RuntimeError("Public helper parent changed before staging.")
    helper_dir = PUBLIC_PARENT / (PUBLIC_PREFIX + secrets.token_hex(16))
    os.mkdir(helper_dir, 0o700)
    created = path_identity(helper_dir)
    records = []
    dir_saved = None
    try:
        fd = os.open(helper_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchown(fd, 0, app_gid)
            os.fchmod(fd, 0o750)
            os.fsync(fd)
        finally:
            os.close(fd)
        dir_saved = path_identity(helper_dir)
        verify_public_directory(helper_dir, dir_saved, parent_saved)
        if dir_saved[2:] != (0, app_gid, 0o750):
            raise RuntimeError("Public helper directory ownership changed.")
        for name in ("session-bus.conf", "desktop-session.py"):
            stage_public_helper(name, helper_dir / name, records, app_gid)
        verify_staged_helpers(helper_dir, records, dir_saved, parent_saved)
        return helper_dir, records, dir_saved
    except Exception:
        if dir_saved is not None:
            errors = cleanup_public_helpers(helper_dir, records, dir_saved, parent_saved, complete=False)
            if errors:
                raise PublicHelperCleanupRefused("Partial public helper cleanup was refused.")
        else:
            try:
                if validate_public_parent() != parent_saved or path_identity(helper_dir) != created \
                        or os.listdir(helper_dir):
                    raise RuntimeError("Partial public helper directory changed.")
                helper_dir.rmdir()
            except (OSError, RuntimeError):
                raise PublicHelperCleanupRefused("Partial public helper directory cleanup was refused.")
        raise

def refresh_publication_supervisor(value):
    """Refresh observed metadata without rebinding the saved process identity."""
    saved = value.get("supervisor")
    if not valid_identity(saved):
        raise RuntimeError("Invalid publication supervisor identity.")
    current = identity(saved["pid"])
    if current is None or current.get("state") in ("Z", "X") or any(
            current[k] != saved[k] for k in ("pid", "starttime_ticks", "owner_uid", "owner_gid")):
        raise RuntimeError("Publication supervisor exited or changed identity.")
    if value.get("lifecycle_mode") == "deckide-owned" and value.get("state") in ("starting", "ready"):
        owner = value.get("owner_process")
        if not valid_identity(owner) or current["ppid"] != owner["pid"] or not same_process(owner):
            raise RuntimeError("DeckIDE direct parent exited or changed identity; refusing active publication.")
    value["supervisor"] = current

def write_descriptor(value):
    if "supervisor" in value:
        refresh_publication_supervisor(value)
    temp = WORKSPACE / (".app-session-" + secrets.token_hex(8) + ".json")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, DESCRIPTOR)

def read_descriptor():
    fd = os.open(DESCRIPTOR, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        s = os.fstat(stream.fileno())
        if not stat.S_ISREG(s.st_mode) or (s.st_uid, s.st_gid) != (0, 0) \
                or stat.S_IMODE(s.st_mode) != 0o600 or s.st_size > 1048576:
            raise RuntimeError("Unexpected descriptor ownership, type, size, or permissions.")
        return json.loads(stream.read(1048577))

def user_environment(user, display, authority):
    return {"HOME": str(HOME), "USER": ACCOUNT, "LOGNAME": ACCOUNT,
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
            "CODEX_HOME": str(HOME / ".codex"),
            "XDG_CONFIG_HOME": str(HOME / ".config"),
            "XDG_DATA_HOME": str(HOME / ".local/share"),
            "XDG_CACHE_HOME": str(HOME / ".cache"),
            "XDG_RUNTIME_DIR": str(RUNTIME), "XDG_SESSION_TYPE": "x11",
            "TMPDIR": str(HOME / ".cache/tmp"), "BROWSER": "/usr/bin/google-chrome",
            "DISPLAY": display, "XAUTHORITY": str(authority)}

def as_user(user):
    return {"user": user.pw_uid, "group": user.pw_gid, "extra_groups": [], "umask": 0o077}

def descendant_snapshot(roots):
    all_processes = {}
    for path in Path("/proc").iterdir():
        if path.name.isdecimal():
            record = identity(int(path.name))
            if record is not None:
                all_processes[record["pid"]] = record
    selected = {p for p in roots if p in all_processes}
    while True:
        added = {p for p, r in all_processes.items() if r["ppid"] in selected} - selected
        if not added:
            break
        selected.update(added)
    return [all_processes[p] for p in sorted(selected)]

def mark_stop(_signal, _frame):
    global STOPPING
    STOPPING = True

def serve(lifetime, owner=None, ready_callback=None, child_log=None):
    if os.geteuid() != 0:
        raise RuntimeError("The supervisor requires an authorized root caller solely to manage Xvfb in /tmp.")
    user = pwd.getpwnam(ACCOUNT)
    if user.pw_uid == 0 or os.getgrouplist(ACCOUNT, user.pw_gid) != [user.pw_gid]:
        raise RuntimeError("App account must be non-root with no supplementary groups.")
    directory(CONTROL, 0, 0o700)
    for path in (RUNTIME, HOME, APP_WORK, HOME / ".cache/tmp"):
        directory(path, user.pw_uid, 0o700)
    public_parent_saved = validate_public_parent()
    lockfd = os.open(CONTROL / "supervisor.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lockfd)
        raise RuntimeError("A session already owns the app singleton; no desktop was started.")
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, mark_stop)
    stamp = str(time.time_ns()) + "-" + secrets.token_hex(4)
    authority = RUNTIME / ("Xauthority-" + stamp)
    helper_dir = None
    helper_dir_saved = None
    helper_records = []
    children, saved, known = [], {}, {}
    descriptor = {"schema": DECKIDE_SCHEMA if owner is not None else SCHEMA, "state": "starting",
        **lifecycle_fields(lifetime, owner), "app_user": ACCOUNT, "uid": user.pw_uid,
        "gid": user.pw_gid, "runtime_dir": str(RUNTIME), "XAUTHORITY": str(authority),
        "working_directory": str(APP_WORK), "supervisor": identity(os.getpid()),
        "xvfb_owner_differs_from_app": True, "xvfb_owner_uid": 0,
        "x11_tcp_listening": False, "x11_authentication": "MIT-MAGIC-COOKIE-1",
        "desktop_owner_uid": user.pw_uid, "dbus_owner_uid": user.pw_uid,
        "chatgpt_owner_uid": user.pw_uid,
        "root_credentials_inherited": False, "sandbox_disabled": False,
        "cleanup_contract": "Owner exit (DeckIDE mode), bounded expiry, desktop exit, or stop terminates only identity-checked owned processes and removes this authority. HOME/login state is retained. No boot service.",
        "cleanup_command": str(product_file("launch-chatgpt.sh")) + " stop --session-id <session_id>",
        "processes": []}
    deadline = None if owner is not None else time.monotonic() + lifetime
    try:
        if owner is not None and not same_process(owner):
            raise RuntimeError("DeckIDE owner exited before session startup.")
        renew_descriptor(descriptor)
        write_descriptor(descriptor)
        helper_dir, helper_records, helper_dir_saved = stage_public_helpers(user.pw_gid, public_parent_saved)
        bus_path = helper_dir / "session-bus.conf"
        desktop_path = helper_dir / "desktop-session.py"
        abstract = Path("/proc/net/unix").read_text()
        display = next((":" + str(n) for n in range(2000, 3000)
            if not os.path.lexists("/tmp/.X" + str(n) + "-lock")
            and not os.path.lexists("/tmp/.X11-unix/X" + str(n))
            and ("/tmp/.X11-unix/X" + str(n)) not in abstract), None)
        if display is None:
            raise RuntimeError("No unused dedicated display was found.")
        descriptor["DISPLAY"] = display
        env = user_environment(user, display, authority)
        cookie = secrets.token_hex(16)
        seeded = subprocess.run(["/usr/bin/xauth", "-f", str(authority), "source", "-"],
            input=("add " + display + " . " + cookie + "\n").encode(),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
            timeout=10, **as_user(user))
        del cookie
        if seeded.returncode:
            raise RuntimeError("Private Xauthority creation failed.")
        trusted_file(authority, user.pw_uid, 0o600)
        xvfb = subprocess.Popen(["/usr/bin/Xvfb", display, "-screen", "0", "1440x960x24",
            "-nolisten", "tcp", "-auth", str(authority), "-noreset"],
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TMPDIR": "/var/tmp"},
            stdout=child_log, stderr=child_log,
            start_new_session=True, umask=0o077)
        children.append(xvfb)
        saved[xvfb.pid] = identity(xvfb.pid)
        good = False
        for _ in range(40):
            if STOPPING or owner is not None and not same_process(owner):
                raise RuntimeError("Lifecycle owner exited during X11 startup.")
            if xvfb.poll() is not None:
                raise RuntimeError("Dedicated Xvfb exited before authentication checks.")
            probe = subprocess.run(["/usr/bin/xdpyinfo"], env=env, timeout=5,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **as_user(user))
            if probe.returncode == 0:
                good = True
                break
            time.sleep(0.25)
        if not good:
            raise RuntimeError("Authenticated non-root X11 connection failed.")
        badenv = dict(env, XAUTHORITY="/dev/null")
        rejected = subprocess.run(["/usr/bin/xdpyinfo"], env=badenv, timeout=5,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **as_user(user))
        if rejected.returncode == 0:
            raise RuntimeError("X11 accepted a connection without authority; refusing desktop launch.")
        descriptor["authenticated_x11_probe_exit"] = 0
        descriptor["unauthenticated_x11_probe_exit"] = rejected.returncode
        descriptor["nonroot_abstract_x11_verified"] = stat.S_IMODE(Path("/tmp").stat().st_mode) == 0o700
        verify_staged_helpers(helper_dir, helper_records, helper_dir_saved, public_parent_saved)
        desktop = subprocess.Popen(desktop_command(bus_path, desktop_path),
            env=env, cwd=APP_WORK, stdout=child_log, stderr=child_log,
            start_new_session=True, **as_user(user))
        children.append(desktop)
        saved[desktop.pid] = identity(desktop.pid)
        for _ in range(80):
            if lifecycle_stop_reason(owner, deadline, desktop.poll() is None, xvfb.poll() is None):
                raise RuntimeError("Lifecycle owner or desktop exited during startup.")
            if desktop.poll() is not None:
                raise RuntimeError("Dedicated desktop/app exited during startup; inspect private logs.")
            snapshot = descendant_snapshot([p.pid for p in children])
            for item in snapshot:
                known[item["pid"]] = item
            descriptor["processes"] = snapshot
            renew_descriptor(descriptor)
            write_descriptor(descriptor)
            visible = subprocess.run(["/usr/bin/xwininfo", "-root", "-tree"], env=env,
                capture_output=True, timeout=5, **as_user(user))
            anchors = session_anchors(snapshot, saved, user.pw_uid, user.pw_gid)
            if anchors and all(same_process(r) for r in anchors.values()) and b'"ChatGPT"' in visible.stdout:
                descriptor["state"] = "ready"
                descriptor["anchors"] = anchors
                descriptor["chatgpt_window_present"] = True
                descriptor["login_state"] = "Existing app HOME/login state retained; launcher does not sign in or inspect credentials."
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("ChatGPT window readiness was not established.")
        while True:
            reason = lifecycle_stop_reason(owner, deadline, desktop.poll() is None, xvfb.poll() is None)
            if reason:
                descriptor["stop_reason"] = reason
                break
            if not all(same_process(r) for r in descriptor["anchors"].values()):
                descriptor["stop_reason"] = "owned session anchor exited or changed identity"
                break
            snapshot = descendant_snapshot([p.pid for p in children])
            for item in snapshot:
                known[item["pid"]] = item
            descriptor["processes"] = snapshot
            renew_descriptor(descriptor)
            write_descriptor(descriptor)
            if ready_callback is not None:
                ready_callback()
                ready_callback = None
            time.sleep(HEARTBEAT_SECONDS)
    except Exception as error:
        descriptor["state"] = "failed"
        descriptor["failure"] = type(error).__name__
        if isinstance(error, PublicHelperCleanupRefused):
            descriptor.setdefault("cleanup_errors", []).append("public helper directory changed or unavailable")
        print("Session preparation failed: " + type(error).__name__, file=sys.stderr, flush=True)
    finally:
        roots = [p.pid for p in children if saved.get(p.pid) and same_process(saved[p.pid])]
        for record in descendant_snapshot(roots):
            known[record["pid"]] = record
        for record in reversed(list(known.values())):
            if cleanup_permitted(record, saved, user.pw_uid, user.pw_gid):
                signal_identity(record, signal.SIGTERM)
        end = time.monotonic() + 5
        while time.monotonic() < end and any(c.poll() is None for c in children):
            time.sleep(0.1)
        for record in reversed(list(known.values())):
            if cleanup_permitted(record, saved, user.pw_uid, user.pw_gid):
                signal_identity(record, signal.SIGKILL)
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        try:
            trusted_file(authority, user.pw_uid, 0o600)
            authority.unlink()
        except FileNotFoundError:
            pass
        except (OSError, RuntimeError) as error:
            descriptor.setdefault("cleanup_errors", []).append("authority: " + type(error).__name__)
            descriptor["state"] = "failed"
        helper_errors = cleanup_public_helpers(helper_dir, helper_records, helper_dir_saved, public_parent_saved)
        if helper_errors:
            descriptor.setdefault("cleanup_errors", []).extend(helper_errors)
            descriptor["state"] = "failed"
        descriptor["processes_at_stop"] = list(known.values())
        descriptor["processes"] = []
        descriptor["stopped_utc"] = utc()
        descriptor["expires_utc"] = descriptor["stopped_utc"]
        if descriptor["state"] != "failed":
            descriptor["state"] = "stopped"
        write_descriptor(descriptor)
        os.close(lockfd)
    return 1 if descriptor["state"] == "failed" else 0

def dry_run(owner):
    user = pwd.getpwnam(ACCOUNT)
    for path in (RUNTIME, HOME, APP_WORK, HOME / ".cache/tmp"):
        directory(path, user.pw_uid, 0o700)
    directory(CONTROL, 0, 0o700)
    for path in (product_file("launch-chatgpt.sh"), product_file("session-supervisor.py"),
                 product_file("desktop-session.py"), product_file("session-bus.conf")):
        trusted_file(path, 0, 0o755 if path.name == "launch-chatgpt.sh" else 0o644)
    busy = False
    lock = CONTROL / "supervisor.lock"
    if lock.exists():
        fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                busy = True
        finally:
            os.close(fd)
    pidfd_supported = hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
    if pidfd_supported:
        fd = os.pidfd_open(os.getpid())
        try:
            signal.pidfd_send_signal(fd, 0)
        finally:
            os.close(fd)
    return {"dry_run": True, "lifecycle_mode": "deckide-owned", "foreground": True,
        "owner_process": owner, "descriptor_path": str(DESCRIPTOR),
        "singleton_busy": busy, "would_start_now": not busy,
        "heartbeat_interval_seconds": HEARTBEAT_SECONDS,
        "heartbeat_valid_seconds": HEARTBEAT_VALID_SECONDS, "fixed_lifetime_seconds": None,
        "pidfd_supported": pidfd_supported,
        "app_home_preserved": str(HOME), "changes_made": False}

def main():
    validate_state_root_override()
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["start", "status", "stop", "run", "_serve"])
    parser.add_argument("--lifetime-seconds", type=int)
    parser.add_argument("--lifecycle", choices=["bounded", "deckide-owned"], default="bounded")
    parser.add_argument("--session-id")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.lifecycle == "deckide-owned" and args.action != "run":
        parser.error("deckide-owned lifecycle is explicit foreground 'run' only")
    if args.action == "run" and args.lifecycle != "deckide-owned":
        parser.error("run requires --lifecycle deckide-owned")
    if args.action == "run" and args.lifetime_seconds is not None:
        parser.error("DeckIDE-owned mode has no fixed lifetime; do not pass --lifetime-seconds")
    if args.dry_run and args.action != "run":
        parser.error("--dry-run is supported only for explicit DeckIDE-owned run")
    if args.session_id is not None and args.action != "stop":
        parser.error("--session-id is a stop guard only")
    args.lifetime_seconds = 3600 if args.lifetime_seconds is None else args.lifetime_seconds
    if not 60 <= args.lifetime_seconds <= 3600:
        parser.error("lifetime must be 60..3600 seconds")
    if args.action == "status":
        print(json.dumps(read_descriptor(), indent=2))
        return
    if os.geteuid() != 0:
        raise SystemExit("An authorized root caller is required; no sudo permission is granted to the app.")
    os.umask(0o077)
    if args.action == "stop":
        descriptor = read_descriptor()
        supervisor = stop_target(descriptor, args.session_id)
        if signal_identity(supervisor, signal.SIGTERM):
            print("Stop requested for the recorded owned supervisor.")
        else:
            print("Recorded supervisor is no longer running; no process was signalled.")
        return
    if args.action == "run":
        owner = owner_identity()
        if args.dry_run:
            print(json.dumps(dry_run(owner), indent=2))
            return
        preflight = dry_run(owner)
        if not preflight["pidfd_supported"]:
            raise SystemExit("PID-fd signalling is required; no desktop was started.")
        if preflight["singleton_busy"]:
            raise SystemExit("A session already owns the app singleton; no desktop was started.")
        log = CONTROL / ("deckide-session-" + str(time.time_ns()) + ".log")
        directory(CONTROL, 0, 0o700)
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            raise SystemExit(serve(None, owner=owner,
                ready_callback=lambda: print(str(DESCRIPTOR), flush=True), child_log=stream))
    if args.action == "_serve":
        raise SystemExit(serve(args.lifetime_seconds))
    if DESCRIPTOR.exists():
        current = read_descriptor()
        if current["state"] in ["ready", "starting"] and same_process(current["supervisor"]):
            raise SystemExit("This task already owns a live session; refusing duplicate launch.")
    if not CONTROL.exists():
        CONTROL.mkdir(mode=0o700)
    directory(CONTROL, 0, 0o700)
    log = CONTROL / ("session-" + str(time.time_ns()) + ".log")
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        process = subprocess.Popen(["/usr/bin/python3", "-I", str(Path(__file__).resolve()),
            "_serve", "--lifetime-seconds", str(args.lifetime_seconds)],
            stdin=subprocess.DEVNULL, stdout=stream, stderr=stream,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                 **({STATE_ROOT_ENV: str(WORKSPACE)} if STATE_ROOT_ENV in os.environ else {})},
            start_new_session=True)
    for _ in range(120):
        if DESCRIPTOR.exists():
            descriptor = read_descriptor()
            if descriptor["supervisor"]["pid"] == process.pid:
                if descriptor["state"] == "ready":
                    print(str(DESCRIPTOR))
                    return
                if descriptor["state"] == "failed":
                    raise SystemExit(descriptor["failure"] + "; private log: " + str(log))
        if process.poll() is not None:
            raise SystemExit("Supervisor exited; private log: " + str(log))
        time.sleep(0.5)
    record = identity(process.pid)
    if record:
        signal_identity(record, signal.SIGTERM)
    raise SystemExit("Session startup timed out; stop requested. Private log: " + str(log))

if __name__ == "__main__":
    main()
