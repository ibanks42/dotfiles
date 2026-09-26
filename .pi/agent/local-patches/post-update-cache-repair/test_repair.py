#!/usr/bin/env python3
"""Tests for repair.py.

Each test copies repair.py, manifest.json, and payload/ into a temporary
directory and runs that copy. Backups and fixtures therefore stay out of the
repository.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH_ROOT = HERE.parent
PRISTINE = PATCH_ROOT / "pi-web-access-dyn-activation/index.before.js"
PAYLOAD = "payload/pi-web-access/dist/index.js"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(directory: Path) -> dict[str, str]:
    """Map every entry below a directory to a hash or link target."""
    result: dict[str, str] = {}
    for path in sorted(directory.rglob("*")):
        key = str(path.relative_to(directory))
        if path.is_symlink():
            result[key] = "link:" + os.readlink(path)
        elif path.is_file():
            result[key] = digest(path)
        else:
            result[key] = "dir"
    return result


def load_module(repair_path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(f"repair_under_test_{id(repair_path)}", repair_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Sandbox(unittest.TestCase):
    """Temporary copy of the tool and a temporary pi-web-access package."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cache-repair-test-")
        self.base = Path(self.temporary.name).resolve()
        self.tool = self.base / "tool"
        self.tool.mkdir()
        shutil.copy2(HERE / "repair.py", self.tool / "repair.py")
        shutil.copy2(HERE / "manifest.json", self.tool / "manifest.json")
        shutil.copytree(HERE / "payload", self.tool / "payload")
        self.repair = self.tool / "repair.py"
        self.web = self.base / "pi-web-access"
        (self.web / "dist").mkdir(parents=True)
        (self.web / "package.json").write_text(json.dumps({"version": "0.31.0"}))
        shutil.copy2(PRISTINE, self.web / "dist/index.js")
        self.outside = self.base / "outside"
        self.outside.mkdir()
        self.environment = {
            **os.environ,
            "PI_CACHE_REPAIR_PI_WEB_ACCESS_ROOT": str(self.web),
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_repair(self, action: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.repair), action],
            env=self.environment, text=True, capture_output=True, check=False,
        )


class CliTests(Sandbox):
    def test_clean_reapply_and_idempotent_noop(self) -> None:
        check = self.run_repair("check")
        self.assertEqual(check.returncode, 2, check.stderr)
        self.assertIn("1 reviewed file(s) need repair", check.stdout)
        applied = self.run_repair("apply")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertIn("applied 1 file(s)", applied.stdout)
        healthy = self.run_repair("check")
        self.assertEqual(healthy.returncode, 0, healthy.stderr)
        self.assertIn("healthy (1 files", healthy.stdout)
        noop = self.run_repair("apply")
        self.assertEqual(noop.returncode, 0, noop.stderr)
        self.assertIn("already applied", noop.stdout)
        self.assertEqual(digest(self.web / "dist/index.js"), digest(self.tool / PAYLOAD))

    def test_backup_stays_in_sandbox(self) -> None:
        applied = self.run_repair("apply")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        backups = list((self.tool / "backups").rglob("index.js"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(digest(backups[0]), digest(PRISTINE))
        self.assertIn(str(self.tool / "backups"), applied.stdout)

    def test_unknown_hash_refuses_write(self) -> None:
        web_target = self.web / "dist/index.js"
        web_target.write_text("locally edited dist bundle\n")
        junk = digest(web_target)
        refused = self.run_repair("apply")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("unknown hash", refused.stderr)
        self.assertEqual(digest(web_target), junk)

    def test_unreviewed_version_is_refused(self) -> None:
        (self.web / "package.json").write_text(json.dumps({"version": "0.32.0"}))
        before = snapshot(self.web)
        refused = self.run_repair("apply")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("not reviewed version", refused.stderr)
        self.assertEqual(snapshot(self.web), before)

    def test_symlinked_target_parent_to_outside_is_refused_without_outside_write(self) -> None:
        shutil.move(str(self.web / "dist"), str(self.outside / "dist"))
        (self.web / "dist").symlink_to(self.outside / "dist", target_is_directory=True)
        before = snapshot(self.outside)
        refused = self.run_repair("apply")
        self.assertEqual(refused.returncode, 1, refused.stdout)
        self.assertIn("symlink", refused.stderr)
        self.assertEqual(snapshot(self.outside), before)
        self.assertFalse((self.tool / "backups").exists())

    def test_symlinked_payload_parent_to_outside_is_refused(self) -> None:
        shutil.move(str(self.tool / "payload"), str(self.outside / "payload"))
        (self.tool / "payload").symlink_to(self.outside / "payload", target_is_directory=True)
        before_web = snapshot(self.web)
        refused = self.run_repair("apply")
        self.assertEqual(refused.returncode, 1, refused.stdout)
        self.assertIn("symlink", refused.stderr)
        self.assertEqual(snapshot(self.web), before_web)


class SafeChildTests(Sandbox):
    def setUp(self) -> None:
        super().setUp()
        self.module = load_module(self.repair)
        self.root = self.base / "package"
        (self.root / "dist").mkdir(parents=True)

    def assertRejected(self, relative: str) -> None:
        with self.assertRaises(ValueError):
            self.module.safe_child(self.root, relative)

    def test_symlinked_parent_to_outside_is_rejected(self) -> None:
        (self.root / "lib").symlink_to(self.outside, target_is_directory=True)
        self.assertRejected("lib/file.js")

    def test_symlinked_parent_inside_root_is_rejected(self) -> None:
        (self.root / "alias").symlink_to(self.root / "dist", target_is_directory=True)
        self.assertRejected("alias/file.js")

    def test_final_symlink_is_rejected(self) -> None:
        (self.outside / "file.js").write_text("outside\n")
        (self.root / "dist/file.js").symlink_to(self.outside / "file.js")
        self.assertRejected("dist/file.js")

    def test_dangling_final_symlink_is_rejected(self) -> None:
        (self.root / "dist/file.js").symlink_to(self.outside / "missing.js")
        self.assertRejected("dist/file.js")

    def test_absolute_empty_and_traversal_paths_are_rejected(self) -> None:
        for relative in ("", ".", "/etc/passwd", str(self.outside / "x"), "../x",
                         "dist/../../x", "dist/.."):
            with self.subTest(relative=relative):
                self.assertRejected(relative)

    def test_valid_contained_paths_are_accepted(self) -> None:
        (self.root / "dist/file.js").write_text("inside\n")
        self.assertEqual(self.module.safe_child(self.root, "dist/file.js"),
                         self.root / "dist/file.js")
        self.assertEqual(self.module.safe_child(self.root, "dist/new.js"),
                         self.root / "dist/new.js")
        self.assertEqual(self.module.safe_child(self.root, "newdir/new.js"),
                         self.root / "newdir/new.js")

    def test_symlinked_root_is_canonicalized(self) -> None:
        link = self.base / "root-link"
        link.symlink_to(self.root, target_is_directory=True)
        self.assertEqual(self.module.safe_child(link, "dist/file.js"),
                         self.root / "dist/file.js")


class LocatorTests(Sandbox):
    def test_retired_root_kinds_are_unknown(self) -> None:
        module = load_module(self.repair)
        for kind in ("pi-ai", "pi-goal-x", "pi-tasks", "pi-warm-cache"):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                module.package_root(kind)
        self.assertEqual(module.package_root("pi-web-access"), self.web)

    def setUp(self) -> None:
        super().setUp()
        os.environ["PI_CACHE_REPAIR_PI_WEB_ACCESS_ROOT"] = str(self.web)

    def tearDown(self) -> None:
        os.environ.pop("PI_CACHE_REPAIR_PI_WEB_ACCESS_ROOT", None)
        super().tearDown()


class RollbackTests(Sandbox):
    def test_failed_apply_restores_earlier_files(self) -> None:
        module = load_module(self.repair)
        root = self.base / "pkg"
        (root / "dist").mkdir(parents=True)
        first = root / "dist/a.js"
        second = root / "dist/b.js"
        first.write_text("original a\n")
        second.write_text("original b\n")
        payload = self.base / "payload.js"
        payload.write_text("patched\n")
        good = digest(payload)
        plan = [
            {"package": "pkg", "version": "1", "root": root, "target": first,
             "relative": "dist/a.js", "payload": payload, "patchedHash": good,
             "currentHash": digest(first), "state": "pristine"},
            {"package": "pkg", "version": "1", "root": root, "target": second,
             "relative": "dist/b.js", "payload": payload, "patchedHash": "0" * 64,
             "currentHash": digest(second), "state": "pristine"},
        ]
        with self.assertRaises(RuntimeError):
            module.apply(plan)
        self.assertEqual(first.read_text(), "original a\n")
        self.assertEqual(second.read_text(), "original b\n")
        self.assertEqual(sorted(p.name for p in (root / "dist").iterdir()), ["a.js", "b.js"])
        self.assertTrue(str(module.HERE).startswith(str(self.base)))


if __name__ == "__main__":
    unittest.main()
