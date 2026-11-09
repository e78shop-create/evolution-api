"""Synthetic checks for the offline watcher guard. No database and no live file."""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import watcher_guard as guard  # noqa: E402

FIXTURES = ROOT / "fixtures"
SINCE = 1_700_000_000
SKIP = {"stub", "protocol"}


def row(**overrides):
    base = {
        "messageTimestamp": SINCE + 10,
        "fromMe": False,
        "jidAllowed": True,
        "messageType": "conversation",
        "status": None,
        "message": None,
    }
    base.update(overrides)
    return base


def run(args, cwd):
    completed = subprocess.run(
        [sys.executable, str(ROOT / "watcher_guard.py"), *args],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    return completed.returncode, payload


class GuardSemantics(unittest.TestCase):
    def test_history_status_alone_is_excluded_and_timestamp_would_have_allowed_it(self):
        sample = row(status="HISTORY", message=None, messageTimestamp=SINCE + 5)
        self.assertTrue(guard.legacy_candidate(sample, SINCE, SKIP))
        self.assertFalse(guard.guarded_candidate(sample, SINCE, SKIP))

    def test_provenance_alone_is_excluded(self):
        sample = row(
            status=None,
            message={"conversation": "synthetic-body-token", "_evolutionRecovery": {"provenance": "on-demand-history"}},
        )
        self.assertTrue(guard.legacy_candidate(sample, SINCE, SKIP))
        self.assertFalse(guard.guarded_candidate(sample, SINCE, SKIP))

    def test_null_status_and_provenance_still_pass_live_filters(self):
        sample = row(status=None, message=None, fromMe=None)
        self.assertTrue(guard.guarded_candidate(sample, SINCE, SKIP))
        delivered = row(status="DELIVERY_ACK", message={"conversation": "synthetic-live-token"})
        self.assertTrue(guard.guarded_candidate(delivered, SINCE, SKIP))
        self.assertFalse(guard.guarded_candidate(row(fromMe=True), SINCE, SKIP))
        self.assertFalse(guard.guarded_candidate(row(messageType="stub"), SINCE, SKIP))
        self.assertFalse(guard.guarded_candidate(row(messageTimestamp=SINCE - 1), SINCE, SKIP))

    def test_live_row_stays_while_recovered_sibling_does_not(self):
        live = row(status="DELIVERY_ACK", message={"conversation": "synthetic-live-token"})
        history = row(status="HISTORY", message={"_evolutionRecovery": {"provenance": "on-demand-history"}})
        kept = [item for item in (live, history) if guard.guarded_candidate(item, SINCE, SKIP)]
        self.assertEqual(kept, [live])


class PatchTool(unittest.TestCase):
    def copy(self, name):
        directory = tempfile.TemporaryDirectory()
        target = Path(directory.name) / "copied_watcher.py"
        shutil.copy(FIXTURES / name, target)
        return directory, target

    def test_dry_run_does_not_write(self):
        directory, target = self.copy("synthetic_watcher.py")
        original = target.read_bytes()
        code, payload = run(["--target", str(target)], directory.name)
        self.assertEqual(code, 0)
        self.assertEqual(payload["mode"], "dry-run")
        self.assertTrue(payload["wouldChange"])
        self.assertFalse(payload["changed"])
        self.assertEqual(target.read_bytes(), original)
        self.assertIn("fromMe", target.read_text(encoding="utf-8"))
        directory.cleanup()

    def test_apply_is_idempotent_and_keeps_live_filters(self):
        directory, target = self.copy("synthetic_watcher.py")
        code, first = run(["--target", str(target), "--apply"], directory.name)
        self.assertEqual(code, 0)
        self.assertTrue(first["changed"])
        text = target.read_text(encoding="utf-8")
        self.assertEqual(text.count(guard.GUARD_STATUS), 2)
        self.assertEqual(text.count(guard.GUARD_PROVENANCE), 2)
        self.assertIn('"messageTimestamp"', text)
        self.assertIn("fromMe", text)
        self.assertIn('"messageType"', text)
        code, second = run(["--target", str(target), "--apply"], directory.name)
        self.assertEqual(code, 0)
        self.assertTrue(second["alreadyApplied"])
        self.assertFalse(second["changed"])
        self.assertEqual(target.read_text(encoding="utf-8").count(guard.GUARD_STATUS), 2)
        directory.cleanup()

    def test_unexpected_source_is_rejected(self):
        directory, target = self.copy("unexpected.py")
        original = target.read_bytes()
        code, payload = run(["--target", str(target), "--apply"], directory.name)
        self.assertEqual(code, 2)
        self.assertFalse(payload["ok"])
        self.assertEqual(target.read_bytes(), original)
        directory.cleanup()

    def test_changed_layout_and_extra_queue_are_rejected(self):
        for name in ("changed_layout.py", "extra_queue.py"):
            directory, target = self.copy(name)
            original = target.read_bytes()
            code, payload = run(["--target", str(target), "--apply"], directory.name)
            self.assertEqual(code, 2, name)
            self.assertFalse(payload["ok"], payload)
            self.assertEqual(target.read_bytes(), original)
            directory.cleanup()

    def test_rollback_restores_original_bytes(self):
        directory, target = self.copy("synthetic_watcher.py")
        original = target.read_bytes()
        code, _payload = run(["--target", str(target), "--apply"], directory.name)
        self.assertEqual(code, 0)
        self.assertNotEqual(target.read_bytes(), original)
        code, payload = run(["--target", str(target), "--rollback"], directory.name)
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(target.read_bytes(), original)
        code, again = run(["--target", str(target), "--rollback"], directory.name)
        self.assertEqual(code, 2)
        self.assertFalse(again["ok"])
        self.assertEqual(target.read_bytes(), original)
        directory.cleanup()

    def test_production_path_is_refused_unread(self):
        code, payload = run(["--target", "/home/box/wa-watch/wa_watch.py", "--apply"], ROOT)
        self.assertEqual(code, 3)
        self.assertIn("refusing", payload["reasons"][0])


if __name__ == "__main__":
    unittest.main()
