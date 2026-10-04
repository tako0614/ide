#!/usr/bin/python3
"""No desktop, package, account, root configuration, or live descriptor changes."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("app_supervisor", BASE / "session-supervisor.py")
supervisor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(supervisor)

def process(pid=200, start=100, uid=0, gid=0, comm="python3", ppid=100):
    return {"pid": pid, "starttime_ticks": start, "owner_uid": uid,
            "owner_gid": gid, "comm": comm, "ppid": ppid, "pgid": pid, "state": "S"}

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.datetime(2026, 10, 4, 10, tzinfo=datetime.timezone.utc)
        supervisor.STOPPING = False

    def test_deckide_lease_continues_after_an_hour_without_fixed_deadline(self):
        owner = process()
        descriptor = supervisor.lifecycle_fields(None, owner, self.now)
        original_id = descriptor["session_id"]
        later = self.now + datetime.timedelta(hours=6)
        supervisor.renew_descriptor(descriptor, later)
        self.assertIsNone(descriptor["session_deadline_utc"])
        self.assertIsNone(descriptor["lifetime_seconds"])
        self.assertEqual(descriptor["session_id"], original_id)
        self.assertEqual(datetime.datetime.fromisoformat(descriptor["expires_utc"]),
                         later + datetime.timedelta(seconds=10))
        with patch.object(supervisor, "identity", return_value=owner):
            self.assertIsNone(supervisor.lifecycle_stop_reason(owner, None, True, True, 999999))

    def test_bounded_refresh_cannot_extend_original_deadline(self):
        descriptor = supervisor.lifecycle_fields(3600, None, self.now)
        deadline = descriptor["expires_utc"]
        supervisor.renew_descriptor(descriptor, self.now + datetime.timedelta(hours=2))
        self.assertEqual(descriptor["expires_utc"], deadline)
        self.assertEqual(descriptor["session_deadline_utc"], deadline)
        self.assertEqual(supervisor.lifecycle_stop_reason(None, 100, True, True, 100), "lifetime expired")

    def test_owner_pid_reuse_or_exit_and_zombie_end_lifecycle(self):
        owner = process()
        for replacement in (None, process(start=101), process(uid=993), {**owner, "state": "Z"}):
            with self.subTest(replacement=replacement), patch.object(supervisor, "identity", return_value=replacement):
                self.assertEqual(supervisor.lifecycle_stop_reason(owner, None, True, True),
                                 "DeckIDE owner exited or changed identity")

    def test_app_exit_and_explicit_stop_end_lifecycle(self):
        self.assertEqual(supervisor.lifecycle_stop_reason(None, None, False, True), "owned desktop process exited")
        supervisor.STOPPING = True
        self.assertEqual(supervisor.lifecycle_stop_reason(None, None, True, True), "stop requested")

    def test_owner_requires_direct_live_root_parent_other_than_init(self):
        for owner in (None, process(pid=1), process(uid=993, gid=982), process(gid=10)):
            with self.subTest(owner=owner), patch.object(supervisor, "identity", return_value=owner):
                with self.assertRaises(RuntimeError):
                    supervisor.owner_identity()
        owner = process()
        with patch.object(supervisor.os, "getppid", return_value=owner["pid"]), patch.object(supervisor, "identity", return_value=owner):
            self.assertEqual(supervisor.owner_identity(), owner)

    def test_stale_stop_id_and_unguarded_owned_stop_are_refused(self):
        descriptor = {"schema": supervisor.DECKIDE_SCHEMA, "state": "ready",
                      "lifecycle_mode": "deckide-owned", "session_id": "new", "supervisor": process()}
        for token in (None, "old"):
            with self.assertRaises(RuntimeError):
                supervisor.stop_target(descriptor, token)
        self.assertEqual(supervisor.stop_target(descriptor, "new"), descriptor["supervisor"])
        with self.assertRaises(RuntimeError):
            supervisor.stop_target({**descriptor, "supervisor": process(uid=993)}, "new")

    def test_rolling_lifecycle_never_uses_fixed_expiry_schema(self):
        descriptor = {"schema": supervisor.SCHEMA, "state": "ready",
                      "lifecycle_mode": "deckide-owned", "session_id": "new", "supervisor": process()}
        with self.assertRaises(RuntimeError):
            supervisor.stop_target(descriptor, "new")
        with self.assertRaises(RuntimeError):
            supervisor.stop_target({**descriptor, "schema": supervisor.DECKIDE_SCHEMA,
                                    "lifecycle_mode": "bounded"}, "new")

    def test_original_legacy_bounded_stop_is_compatible(self):
        descriptor = {"schema": supervisor.SCHEMA, "state": "ready", "supervisor": process()}
        self.assertEqual(supervisor.stop_target(descriptor, None), descriptor["supervisor"])

    def test_detached_reparenting_is_revalidated_before_atomic_publication(self):
        saved = process(ppid=100)
        reparented = {**saved, "ppid": 1, "state": "S"}
        descriptor = {"schema": supervisor.SCHEMA, "state": "ready", "supervisor": saved,
                      **supervisor.lifecycle_fields(3600, None, self.now)}
        original_expiry = descriptor["expires_utc"]
        original_id = descriptor["session_id"]
        with tempfile.TemporaryDirectory(prefix=".lifecycle-tests-", dir=BASE) as tmp:
            target = Path(tmp) / "descriptor.json"
            with patch.object(supervisor, "WORKSPACE", Path(tmp)), patch.object(supervisor, "DESCRIPTOR", target), \
                 patch.object(supervisor, "identity", return_value=reparented):
                supervisor.renew_descriptor(descriptor, self.now + datetime.timedelta(seconds=2))
                supervisor.write_descriptor(descriptor)
                published = supervisor.read_descriptor()
        self.assertEqual(published["supervisor"], reparented)
        self.assertEqual(published["expires_utc"], original_expiry)
        self.assertEqual(published["session_id"], original_id)
        self.assertEqual(saved["ppid"], 100)

    def test_publication_never_rebinds_supervisor_pid_starttime_or_owner(self):
        saved = process()
        for changed in (None, process(start=101), process(uid=993), process(gid=982), {**saved, "state": "Z"}):
            descriptor = {"state": "ready", "lifecycle_mode": "bounded", "supervisor": saved}
            with self.subTest(changed=changed), patch.object(supervisor, "identity", return_value=changed):
                with self.assertRaises(RuntimeError):
                    supervisor.refresh_publication_supervisor(descriptor)
                self.assertEqual(descriptor["supervisor"], saved)

    def test_foreground_parent_relationship_remains_required(self):
        owner = process(pid=100)
        saved = process(pid=200, ppid=100)
        descriptor = {"state": "ready", "lifecycle_mode": "deckide-owned",
                      "supervisor": saved, "owner_process": owner}
        with patch.object(supervisor, "identity", side_effect=lambda pid: saved if pid==200 else owner):
            supervisor.refresh_publication_supervisor(descriptor)
        with patch.object(supervisor, "identity", return_value={**saved, "ppid": 1}):
            with self.assertRaises(RuntimeError):
                supervisor.refresh_publication_supervisor(descriptor)
        self.assertEqual(descriptor["owner_process"], owner)
        with patch.object(supervisor, "identity", side_effect=lambda pid: saved if pid==200 else None):
            with self.assertRaises(RuntimeError):
                supervisor.refresh_publication_supervisor(descriptor)

    def test_pid_reuse_between_open_and_signal_never_signals_replacement(self):
        saved = process()
        with patch.object(supervisor, "identity", side_effect=[saved, process(start=101)]), \
             patch.object(supervisor.os, "pidfd_open", return_value=91) as opened, \
             patch.object(supervisor.signal, "pidfd_send_signal") as send, \
             patch.object(supervisor.os, "close") as close:
            self.assertFalse(supervisor.signal_identity(saved, signal.SIGTERM))
            opened.assert_called_once_with(saved["pid"])
            send.assert_not_called()
            close.assert_called_once_with(91)

    def test_matching_process_is_signalled_only_through_pinned_fd(self):
        saved = process()
        with patch.object(supervisor, "identity", return_value=saved), \
             patch.object(supervisor.os, "pidfd_open", return_value=91), \
             patch.object(supervisor.signal, "pidfd_send_signal") as send, \
             patch.object(supervisor.os, "close"):
            self.assertTrue(supervisor.signal_identity(saved, signal.SIGTERM))
            send.assert_called_once_with(91, signal.SIGTERM)

    def test_invalid_or_already_dead_identity_never_opens_pidfd(self):
        with patch.object(supervisor, "identity", return_value=None), patch.object(supervisor.os, "pidfd_open") as opened:
            for saved in (None, {}, process(pid=1), process()):
                self.assertFalse(supervisor.signal_identity(saved, signal.SIGTERM))
            opened.assert_not_called()

    def test_cleanup_cannot_target_foreign_account_or_unowned_root_process(self):
        xvfb = process(pid=200, comm="Xvfb")
        saved = {200: xvfb}
        self.assertTrue(supervisor.cleanup_permitted(xvfb, saved, 993, 982))
        self.assertTrue(supervisor.cleanup_permitted(process(uid=993, gid=982), saved, 993, 982))
        for foreign in (process(pid=201), process(start=101), process(uid=994, gid=982), process(uid=993, gid=999)):
            self.assertFalse(supervisor.cleanup_permitted(foreign, saved, 993, 982))

    def test_session_anchors_select_main_app_and_nonroot_components(self):
        xvfb = process(pid=200, comm="Xvfb")
        runner = process(pid=201, uid=993, gid=982, comm="dbus-run-sessio")
        owned = lambda pid, comm, ppid=201: process(pid=pid, uid=993, gid=982, comm=comm, ppid=ppid)
        snapshot = [xvfb, runner, owned(202, "dbus-daemon"), owned(203, "python3"),
                    owned(204, "openbox", 203), owned(205, "ChatGPT", 203), owned(206, "ChatGPT", 205)]
        anchors = supervisor.session_anchors(snapshot, {200: xvfb, 201: runner}, 993, 982)
        self.assertEqual(anchors["chatgpt"]["pid"], 205)
        self.assertIsNone(supervisor.session_anchors([r for r in snapshot if r["comm"] != "openbox"], {200: xvfb, 201: runner}, 993, 982))

    def test_atomic_descriptor_and_nofollow_read_in_private_test_directory(self):
        with tempfile.TemporaryDirectory(prefix=".lifecycle-tests-", dir=BASE) as tmp:
            work = Path(tmp)
            descriptor = work / "descriptor.json"
            with patch.object(supervisor, "WORKSPACE", work), patch.object(supervisor, "DESCRIPTOR", descriptor):
                supervisor.write_descriptor({"state": "first"})
                previous = descriptor.stat().st_ino
                supervisor.write_descriptor({"state": "next"})
                self.assertNotEqual(descriptor.stat().st_ino, previous)
                self.assertEqual(supervisor.read_descriptor(), {"state": "next"})
                self.assertEqual(descriptor.stat().st_mode & 0o777, 0o600)
                descriptor.unlink()
                target = work / "untouched.json"
                target.write_text('{"secret":"unit-test-placeholder"}')
                descriptor.symlink_to(target)
                with self.assertRaises(OSError):
                    supervisor.read_descriptor()
                self.assertEqual(json.loads(target.read_text())["secret"], "unit-test-placeholder")

if __name__ == "__main__":
    unittest.main()
