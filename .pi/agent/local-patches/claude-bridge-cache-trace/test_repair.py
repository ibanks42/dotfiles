"""All repair writes target temporary packages. No installed package mutation."""
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
ASSETS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("repair", ASSETS / "repair.py")
assert spec is not None and spec.loader is not None
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cache-trace-repair-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "package"
        shutil.copytree(ASSETS / "pristine", self.root)
        self.original = (self.root / "src/index.ts").read_bytes()

    def test_round_trip(self):
        self.assertEqual(repair.repair("check", self.root), "pristine")
        self.assertEqual(repair.repair("apply", self.root), "patched")
        self.assertEqual(repair.repair("check", self.root), "patched")
        self.assertEqual(repair.repair("apply", self.root), "patched (no change)")
        self.assertEqual(repair.repair("restore", self.root), "pristine")
        self.assertEqual((self.root / "src/index.ts").read_bytes(), self.original)
        self.assertFalse((self.root / "src/cache-trace.ts").exists())
        self.assertEqual(repair.repair("restore", self.root), "pristine (no change)")

    def test_wrong_version(self):
        package = self.root / "package.json"
        value = json.loads(package.read_text())
        value["version"] = "0.9.1"
        package.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "wrong package version"):
            repair.repair("apply", self.root)
        self.assertEqual((self.root / "src/index.ts").read_bytes(), self.original)

    def test_wrong_hash(self):
        target = self.root / "src/index.ts"
        target.write_bytes(self.original + b"\n// user edit\n")
        before = target.read_bytes()
        with self.assertRaisesRegex(ValueError, "unexpected target hash"):
            repair.repair("apply", self.root)
        self.assertEqual(target.read_bytes(), before)
        self.assertFalse((self.root / "src/cache-trace.ts").exists())

    def test_new_file_conflict_validates_all_before_writes(self):
        target = self.root / "src/cache-trace.ts"
        target.write_text("user content")
        with self.assertRaisesRegex(ValueError, "unexpected target hash"):
            repair.repair("apply", self.root)
        self.assertEqual((self.root / "src/index.ts").read_bytes(), self.original)
        self.assertEqual(target.read_text(), "user content")

    def test_restore_never_overwrites_new_edits(self):
        repair.repair("apply", self.root)
        target = self.root / "src/cache-trace.ts"
        target.write_text(target.read_text() + "\n// user edit")
        before = (self.root / "src/index.ts").read_bytes()
        with self.assertRaisesRegex(ValueError, "unexpected target hash"):
            repair.repair("restore", self.root)
        self.assertEqual((self.root / "src/index.ts").read_bytes(), before)
        self.assertTrue(target.read_text().endswith("// user edit"))

    def test_partial_state_refused(self):
        shutil.copy2(ASSETS / "payload/src/cache-trace.ts", self.root / "src/cache-trace.ts")
        with self.assertRaisesRegex(ValueError, "mixed state"):
            repair.repair("apply", self.root)
        self.assertEqual((self.root / "src/index.ts").read_bytes(), self.original)

    def test_symlink_refused(self):
        target = self.root / "src/cache-trace.ts"
        target.symlink_to(self.root / "src/index.ts")
        with self.assertRaises(OSError):
            repair.repair("apply", self.root)
        self.assertEqual((self.root / "src/index.ts").read_bytes(), self.original)

    def test_rollback_on_second_write_failure(self):
        original_atomic = repair.atomic
        calls = 0

        def fail_second(path, data, mode):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected storage failure")
            original_atomic(path, data, mode)

        self.enterContext(patch.object(repair, "atomic", fail_second))
        with self.assertRaisesRegex(OSError, "injected storage failure"):
            repair.repair("apply", self.root)
        self.assertEqual(repair.repair("check", self.root), "pristine")
        self.assertEqual((self.root / "src/index.ts").read_bytes(), self.original)

    def test_payload_and_manifest_hashes(self):
        assets = Path(self.temp.name) / "assets"
        shutil.copytree(ASSETS, assets)
        self.enterContext(patch.object(repair, "ASSETS", assets))
        payload = assets / "payload/src/cache-trace.ts"
        payload.write_text(payload.read_text() + "\n// tamper")
        with self.assertRaisesRegex(ValueError, "asset hash mismatch"):
            repair.repair("apply", self.root)
        self.assertEqual((self.root / "src/index.ts").read_bytes(), self.original)
        manifest = assets / "manifest.json"
        manifest.write_text(manifest.read_text() + " ")
        with self.assertRaisesRegex(ValueError, "manifest hash mismatch"):
            repair.repair("apply", self.root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
