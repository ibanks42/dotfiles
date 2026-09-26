#!/usr/bin/env python3
"""Tests for repair.py. They use temp unpacked copies of pristine 0.4.0 only.

Pristine source: set CLAUDE_PROVIDER_TGZ to a local tarball, or the tests run
`npm pack --offline --ignore-scripts <resolved URL>` in a private temp dir.
No network access and no package scripts. The tarball must match the
integrity in manifest.json. The tests never write to the installed provider.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import repair  # noqa: E402

MANIFEST = json.loads((HERE / "manifest.json").read_text("utf-8"))
AGENT_NODE_MODULES = HERE.parent.parent / "npm" / "node_modules"
TEMPLATE: Path | None = None
WORK: tempfile.TemporaryDirectory | None = None


def setUpModule() -> None:
    global TEMPLATE, WORK
    WORK = tempfile.TemporaryDirectory(prefix="claude-schema-repair-")
    os.chmod(WORK.name, 0o700)
    work = Path(WORK.name)
    tgz = os.environ.get("CLAUDE_PROVIDER_TGZ")
    if tgz:
        tgz_path = Path(tgz)
    else:
        env = dict(os.environ, npm_config_offline="true", npm_config_ignore_scripts="true")
        proc = subprocess.run(
            ["npm", "pack", "--offline", "--ignore-scripts", MANIFEST["package"]["resolved"]],
            cwd=work, env=env, capture_output=True, text=True, timeout=120,
        )
        if proc.returncode != 0:
            raise RuntimeError("pristine tarball not in npm cache; set CLAUDE_PROVIDER_TGZ. "
                               "The tests do not use the network.")
        tgz_path = work / proc.stdout.strip().splitlines()[-1]
    data = tgz_path.read_bytes()
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if integrity != MANIFEST["package"]["integrity"]:
        raise RuntimeError("tarball integrity does not match manifest.json")
    with tarfile.open(tgz_path, "r:gz") as tar:
        tar.extractall(work / "unpacked", filter="data")
    TEMPLATE = work / "unpacked" / "package"


def template() -> Path:
    assert TEMPLATE is not None, "setUpModule did not unpack the pristine tarball"
    return TEMPLATE


def tearDownModule() -> None:
    if WORK:
        WORK.cleanup()


def snapshot(root: Path) -> dict:
    """Every entry (including temp files) with content hash, mode, inode and mtime."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d != "node_modules"]
        for name in sorted(dirnames + filenames):
            p = Path(dirpath) / name
            st = os.lstat(p)
            if p.is_dir() or p.is_symlink():
                digest = None
            else:
                try:
                    digest = hashlib.sha256(p.read_bytes()).hexdigest()
                except PermissionError:
                    digest = "unreadable"
            out[os.path.relpath(p, root)] = (digest, st.st_mode, st.st_ino, st.st_mtime_ns)
    return out


def hashes(root: Path) -> dict:
    return {rel: hashlib.sha256((root / rel).read_bytes()).hexdigest()
            for rel in MANIFEST["files"] if (root / rel).is_file() and not (root / rel).is_symlink()}


PRISTINE = {rel: e["pristine"] for rel, e in MANIFEST["files"].items() if e["pristine"]}
PATCHED = {rel: e["patched"] for rel, e in MANIFEST["files"].items()}


class RepairTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="claude-schema-case-")
        self.root = Path(self.tmp.name) / "pi-claude-code-provider"
        shutil.copytree(template(), self.root)
        self.bundle = repair.load_bundle()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def patched_copy(self) -> None:
        repair.apply(self.root, self.bundle)

    def assert_refused(self, pattern: str, action=None) -> None:
        before = snapshot(self.root)
        with self.assertRaisesRegex(repair.Refused, pattern):
            (action or (lambda: repair.apply(self.root, self.bundle)))()
        self.assertEqual(snapshot(self.root), before, "refusal must not write")

    def cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(HERE / "repair.py"), *args, "--root", str(self.root)],
                              capture_output=True, text=True)

    # --- recovery

    def test_pristine_tarball_matches_manifest_pristine_hashes(self) -> None:
        self.assertEqual(hashes(self.root), PRISTINE)
        self.assertEqual(repair.inspect(self.root, self.bundle)["status"], "pristine")

    def test_apply_restores_recorded_patched_hashes(self) -> None:
        result = repair.apply(self.root, self.bundle)
        self.assertEqual(len(result["changed"]), 6)
        self.assertEqual(hashes(self.root), PATCHED)
        legacy = json.loads((HERE / "installed-hashes.json").read_text("utf-8"))
        self.assertEqual({rel: hashes(self.root)[rel] for rel in legacy}, legacy)
        self.assertFalse([p for p in snapshot(self.root) if ".repair-" in p])

    def test_apply_is_idempotent(self) -> None:
        self.patched_copy()
        before = snapshot(self.root)
        self.assertEqual(repair.apply(self.root, self.bundle)["changed"], [])
        self.assertEqual(snapshot(self.root), before)

    def test_new_file_mode_and_existing_mode_preserved(self) -> None:
        os.chmod(self.root / "src/types.ts", 0o640)
        self.patched_copy()
        self.assertEqual(os.stat(self.root / "src/types.ts").st_mode & 0o777, 0o640)
        self.assertTrue((self.root / "src/tool-schema-compatibility.ts").is_file())

    # --- refusals, no writes

    def test_unknown_edit_in_unchanged_file_refused(self) -> None:
        with open(self.root / "README.md", "ab") as f:
            f.write(b"\nlocal edit\n")
        self.assert_refused("unknown content: README.md")

    def test_unknown_edit_in_patched_file_refused(self) -> None:
        self.patched_copy()
        with open(self.root / "src/provider.ts", "ab") as f:
            f.write(b"// drift\n")
        self.assert_refused("unknown content: src/provider.ts")

    def test_unknown_extra_file_refused(self) -> None:
        (self.root / "src/extra.ts").write_text("export {};\n")
        self.assert_refused("unknown files in scope: src/extra.ts")

    def test_missing_file_refused(self) -> None:
        (self.root / "SECURITY.md").unlink()
        self.assert_refused("missing file: SECURITY.md")

    def test_mixed_state_refused(self) -> None:
        self.patched_copy()
        (self.root / "src/types.ts").write_bytes(
            (template() / "src/types.ts").read_bytes())
        self.assert_refused("mixed pristine/patched state")

    def test_version_gate(self) -> None:
        meta_path = self.root / "package.json"
        meta = json.loads(meta_path.read_text())
        meta["version"] = "0.4.1"
        meta_path.write_text(json.dumps(meta))
        self.assert_refused("version gate failed")

    def test_symlinked_file_refused(self) -> None:
        target = self.root / "src/types.ts"
        real = Path(self.tmp.name) / "types.ts"
        shutil.move(target, real)
        target.symlink_to(real)
        self.assert_refused("symlink in scope: src/types.ts")

    def test_symlinked_directory_refused(self) -> None:
        real = Path(self.tmp.name) / "src-real"
        shutil.move(self.root / "src", real)
        (self.root / "src").symlink_to(real)
        self.assert_refused("symlink in scope: src")

    def test_symlinked_root_refused(self) -> None:
        link = Path(self.tmp.name) / "link"
        link.symlink_to(self.root)
        with self.assertRaisesRegex(repair.Refused, "root is a symlink"):
            repair.apply(link, self.bundle)
        self.assertEqual(hashes(self.root), PRISTINE)

    def test_node_modules_is_out_of_scope(self) -> None:
        (self.root / "node_modules").symlink_to(AGENT_NODE_MODULES)
        self.patched_copy()
        self.assertEqual(hashes(self.root), PATCHED)

    def test_corrupt_bundle_refused_before_writes(self) -> None:
        bad = Path(self.tmp.name) / "bundle"
        bad.mkdir()
        shutil.copy(HERE / "manifest.json", bad)
        patch = (HERE / "fix.patch").read_bytes().replace(b"activeToolSchemaNotify = undefined;", b"x = 1;", 1)
        (bad / "fix.patch").write_bytes(patch)
        with self.assertRaisesRegex(repair.Refused, "does not match the SHA-256"):
            repair.load_bundle(bad)
        manifest = json.loads((HERE / "manifest.json").read_text())
        manifest["files"]["../escape"] = manifest["files"].pop("README.md")
        (bad / "manifest.json").write_text(json.dumps(manifest))
        shutil.copy(HERE / "fix.patch", bad)
        with self.assertRaisesRegex(repair.Refused, "unsafe path"):
            repair.load_bundle(bad)

    def test_patch_context_mismatch_refused(self) -> None:
        hunks = self.bundle["hunks"]["src/types.ts"]
        a, b, c, d, body = hunks[0]
        broken = [(" ", "not the real context")] + body[1:]
        with self.assertRaisesRegex(repair.Refused, "context does not match"):
            repair.apply_hunks("src/types.ts", (self.root / "src/types.ts").read_bytes(), [(a, b, c, d, broken)])

    # --- rollback

    def test_fault_mid_apply_rolls_back(self) -> None:
        before = snapshot(self.root)
        calls = []

        def fault(rel: str) -> None:
            calls.append(rel)
            if len(calls) == 4:
                raise OSError("injected fault")

        with self.assertRaisesRegex(repair.Refused, "rolled back"):
            repair.apply(self.root, self.bundle, before_commit=fault)
        self.assertEqual(hashes(self.root), PRISTINE)
        after = snapshot(self.root)
        self.assertEqual(set(after), set(before), "no leftover temp or new files")
        self.assertEqual({k: v[0] for k, v in after.items()}, {k: v[0] for k, v in before.items()})

    def test_concurrent_edit_refused_and_earlier_writes_rolled_back(self) -> None:
        order = [rel for rel, _, _ in repair.inspect(self.root, self.bundle)["plan"]]
        victim = order[2]

        def concurrent(rel: str) -> None:
            if rel == victim:
                with open(self.root / rel, "ab") as f:
                    f.write(b"// user edit\n")

        with self.assertRaisesRegex(repair.Refused, "changed during apply"):
            repair.apply(self.root, self.bundle, before_commit=concurrent)
        now = hashes(self.root)
        for rel in order[:2]:
            self.assertEqual(now[rel], PRISTINE[rel])
        self.assertTrue((self.root / victim).read_bytes().endswith(b"// user edit\n"), "user edit kept")

    def test_fsync_fault_after_successful_commit_rolls_back(self) -> None:
        before = snapshot(self.root)
        real = repair._fsync_dir
        calls = []

        def flaky(directory) -> None:
            calls.append(directory)
            real(directory)
            if len(calls) == 3:  # third target is already renamed into place
                raise OSError("injected fsync fault")

        with (mock.patch.object(repair, "_fsync_dir", flaky),
              self.assertRaisesRegex(repair.Refused, "write failed: injected fsync fault; earlier writes rolled back")):
            repair.apply(self.root, self.bundle)
        self.assertEqual(hashes(self.root), PRISTINE)
        after = snapshot(self.root)
        self.assertEqual(set(after), set(before), "no leftover temp or new files")
        self.assertEqual({k: v[0] for k, v in after.items()}, {k: v[0] for k, v in before.items()})

    def test_rollback_continues_past_non_regular_conflict(self) -> None:
        order = [rel for rel, _, _ in repair.inspect(self.root, self.bundle)["plan"]]

        def replace_then_fail(rel: str) -> None:
            if rel == order[3]:
                (self.root / order[0]).unlink()
                (self.root / order[0]).mkdir()  # concurrent non-regular replacement
                raise OSError("injected fault")

        with self.assertRaisesRegex(repair.Refused, "rollback conflicts, inspect by hand: .*" + order[0]):
            repair.apply(self.root, self.bundle, before_commit=replace_then_fail)
        self.assertTrue((self.root / order[0]).is_dir(), "conflicting entry kept")
        now = hashes(self.root)
        for rel in order[1:]:
            if PRISTINE.get(rel):
                self.assertEqual(now[rel], PRISTINE[rel], rel)
            else:
                self.assertNotIn(rel, now, rel)
        self.assertFalse([p for p in snapshot(self.root) if ".repair-" in p])

    # --- CLI and regressions

    def test_cli_reports_filesystem_error_as_refusal(self) -> None:
        target = self.root / "README.md"
        os.chmod(target, 0)
        try:
            if os.access(target, os.R_OK):
                self.skipTest("running with privileges that ignore file modes")
            before = snapshot(self.root)
            for command in ("check", "apply"):
                proc = self.cli(command)
                self.assertEqual(proc.returncode, 1)
                self.assertIn("refused: filesystem error", proc.stderr)
                self.assertNotIn("Traceback", proc.stderr)
            self.assertEqual(snapshot(self.root), before)
        finally:
            os.chmod(target, 0o644)

    def test_cli_exit_codes(self) -> None:
        self.assertEqual(self.cli("check").returncode, 2)
        self.assertEqual(self.cli("apply").returncode, 0)
        self.assertEqual(self.cli("check").returncode, 0)
        out = self.cli("apply", "--json")
        self.assertEqual(out.returncode, 0)
        self.assertEqual(json.loads(out.stdout)["changed"], [])
        (self.root / "extra").write_text("x")
        self.assertEqual(self.cli("check").returncode, 1)
        self.assertEqual(self.cli("apply").returncode, 1)
        bad = subprocess.run([sys.executable, str(HERE / "repair.py"), "nope"], capture_output=True)
        self.assertEqual(bad.returncode, 1)

    def test_regressions_pass_on_restored_copy(self) -> None:
        self.patched_copy()
        (self.root / "node_modules").symlink_to(AGENT_NODE_MODULES)
        proc = subprocess.run(["node", "--test", "--test-reporter=tap", str(HERE / "regression.test.mjs")],
                              env=dict(os.environ, CLAUDE_PROVIDER_ROOT=str(self.root)),
                              capture_output=True, text=True, timeout=300)
        self.assertEqual(proc.returncode, 0, proc.stdout[-2000:] + proc.stderr[-2000:])
        self.assertIn("# pass 8", proc.stdout)
        self.assertIn("# fail 0", proc.stdout)


if __name__ == "__main__":
    unittest.main()
