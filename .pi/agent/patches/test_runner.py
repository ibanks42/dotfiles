#!/usr/bin/env python3
"""Offline tests for runner.py and the pi launcher.

Run: python3 -m unittest -v test_runner   (from this directory)

The tests use temporary agent directories, fake packages, and a fake `pi`.
They never touch installed packages, run a real update, or call a model.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import pty
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE / "runner.py"
LAUNCHER = HERE / "pi"

sys.path.insert(0, str(HERE))
import runner  # noqa: E402


def load_launcher():
    loader = importlib.machinery.SourceFileLoader("pi_launcher", str(LAUNCHER))
    spec = importlib.util.spec_from_loader("pi_launcher", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


launcher = load_launcher()

GIT_ENV = {
    **{k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
}


def make_patch(before: dict[str, str | None], after: dict[str, str | None]) -> str:
    """Return a standard `git diff` between two file maps (None means absent)."""
    with tempfile.TemporaryDirectory() as tmp:
        def git(*args: str) -> str:
            return subprocess.run(["git", *args], cwd=tmp, env=GIT_ENV, check=True,
                                  capture_output=True, text=True).stdout

        git("init", "-q", ".")

        def write(state: dict[str, str | None]) -> None:
            for rel, content in state.items():
                path = Path(tmp) / rel
                if content is None:
                    if path.exists():
                        path.unlink()
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content)

        write(before)
        git("add", "-A")
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "before")
        write(after)
        git("add", "-A")
        return git("diff", "--cached", "--no-color", "--no-renames", "--no-ext-diff")


BASE = "line 1\nline 2\nline 3\nline 4\nline 5\n"
PATCHED = "line 1\nline 2\nline 3 PATCHED\nline 4\nline 5\n"

CONTAINS_CHECK = textwrap.dedent("""\
    import os, sys
    path, needle = sys.argv[1], sys.argv[2]
    try:
        text = open(path).read()
    except FileNotFoundError:
        print("missing", path)
        sys.exit(1)
    if needle not in text:
        print("needle not found in", path)
        sys.exit(1)
    if os.environ.get("FORCE_FAIL"):
        print("forced failure")
        sys.exit(3)
""")

ENV_CHECK = textwrap.dedent("""\
    import json, os, sys
    out = os.environ["RECORD"]
    with open(out, "w") as handle:
        json.dump({"argv": sys.argv[1:], "cwd": os.getcwd(),
                   "env": {k: v for k, v in os.environ.items() if k.startswith(("PI_PATCH_", "CUSTOM_"))}}, handle)
    sys.exit(1)
""")


class Fixture:
    def __init__(self, test: unittest.TestCase, base: Path | None = None) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="pi-patch-test-")
        test.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.base = base or self.tmp
        self.agent = self.base / "agent"
        self.agent.mkdir(parents=True, exist_ok=True)
        self.patch_dir = self.tmp / "patchset"
        (self.patch_dir / "checks").mkdir(parents=True)
        (self.patch_dir / "diffs").mkdir()
        (self.patch_dir / "checks" / "contains.py").write_text(CONTAINS_CHECK)
        (self.patch_dir / "checks" / "env.py").write_text(ENV_CHECK)
        self.manifest = self.patch_dir / "manifest.json"
        self.packages: list[dict] = []

    def root(self, name: str) -> Path:
        return self.agent / "npm" / "node_modules" / name

    def install(self, name: str, files: dict[str, str]) -> Path:
        root = self.root(name)
        for rel, content in files.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        return root

    def add_patch(self, package: str, patch_id: str, before: dict, after: dict,
                  check: list[str] | None = None, files: list[str] | None = None, **extra) -> dict:
        diff = make_patch(before, after)
        rel = f"diffs/{package.replace('/', '__')}-{patch_id}.patch"
        (self.patch_dir / rel).write_text(diff)
        target = next(k for k, v in after.items() if v is not None) if check is None else None
        if check is None:
            check = [sys.executable, "{patchDir}/checks/contains.py", "{packageRoot}/" + target, "PATCHED"]
        entry = {"id": patch_id, "file": rel, "files": files if files is not None else sorted(set(before) | set(after)),
                 "check": check, **extra}
        for pkg in self.packages:
            if pkg["name"] == package:
                pkg["patches"].append(entry)
                break
        else:
            self.packages.append({"name": package, "patches": [entry]})
        self.save()
        return entry

    def save(self, data: dict | None = None) -> None:
        data = data if data is not None else {"schemaVersion": 1, "packages": self.packages}
        self.manifest.write_text(json.dumps(data, indent=2))

    def run(self, command: str, env: dict | None = None, use_args: bool = True) -> subprocess.CompletedProcess:
        argv = [sys.executable, str(RUNNER)]
        if use_args:
            argv += ["--manifest", str(self.manifest), "--agent-dir", str(self.agent)]
        argv.append(command)
        full_env = {k: v for k, v in os.environ.items()
                    if k not in ("PI_CODING_AGENT_DIR", "PI_PATCH_MANIFEST", "FORCE_FAIL")}
        full_env.update(env or {})
        return subprocess.run(argv, env=full_env, capture_output=True, text=True, timeout=120)


def out(result: subprocess.CompletedProcess) -> str:
    return result.stdout + result.stderr


class DiffParserTests(unittest.TestCase):
    def test_hunk_lines_that_look_like_headers(self) -> None:
        before = {"a.txt": "x\n-- y\n++ z\n"}
        after = {"a.txt": "x\n++ z\n-- w\n"}
        entries = runner.parse_git_diff(make_patch(before, after), "t")
        self.assertEqual([(e.path, e.kind) for e in entries], [("a.txt", "modify")])

    def test_add_modify_delete_kinds(self) -> None:
        diff = make_patch({"m.txt": BASE, "d.txt": "gone\n"}, {"m.txt": PATCHED, "d.txt": None, "n/new.txt": "hi\n"})
        kinds = {e.path: e.kind for e in runner.parse_git_diff(diff, "t")}
        self.assertEqual(kinds, {"m.txt": "modify", "d.txt": "delete", "n/new.txt": "add"})
        self.assertIn("--- /dev/null", diff)

    def test_rejects_unsupported_diffs(self) -> None:
        cases = {
            "rename": "diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n",
            "traversal": "diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n",
            "absolute": "diff --git a//etc/x b//etc/x\n--- a//etc/x\n+++ b//etc/x\n@@ -1 +1 @@\n-a\n+b\n",
            "symlink": "diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+/etc\n",
            "mode": "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n",
            "binary": "diff --git a/x b/x\nindex 1..2\nGIT binary patch\n",
            "quoted": 'diff --git "a/x y" "b/x y"\n--- "a/x y"\n+++ "b/x y"\n@@ -1 +1 @@\n-a\n+b\n',
            "plain": "--- x\n+++ x\n@@ -1 +1 @@\n-a\n+b\n",
            "count": "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n",
            "header": "diff --git a/x b/x\n--- a/y\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
            "git-dir": "diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-a\n+b\n",
        }
        for name, diff in cases.items():
            with self.subTest(name), self.assertRaises(runner.ConfigError):
                runner.parse_git_diff(diff, name)


class ApplyTests(unittest.TestCase):
    def test_apply_then_idempotent(self) -> None:
        fx = Fixture(self)
        root = fx.install("pkg-a", {"src/a.txt": BASE})
        fx.add_patch("pkg-a", "one", {"src/a.txt": BASE}, {"src/a.txt": PATCHED})

        first = fx.run("apply")
        self.assertEqual(first.returncode, 0, out(first))
        self.assertIn("pkg-a/one: applied, check passed", first.stdout)
        self.assertEqual((root / "src/a.txt").read_text(), PATCHED)

        before = os.stat(root / "src/a.txt")
        second = fx.run("apply")
        self.assertEqual(second.returncode, 0, out(second))
        self.assertIn("pkg-a/one: already applied, check passed", second.stdout)
        after = os.stat(root / "src/a.txt")
        self.assertEqual((before.st_mtime_ns, before.st_ino), (after.st_mtime_ns, after.st_ino))

        check = fx.run("check")
        self.assertEqual(check.returncode, 0, out(check))
        self.assertIn("applied, check passed", check.stdout)

    def test_check_command_does_not_write(self) -> None:
        fx = Fixture(self)
        root = fx.install("pkg-a", {"src/a.txt": BASE})
        fx.add_patch("pkg-a", "one", {"src/a.txt": BASE}, {"src/a.txt": PATCHED})
        result = fx.run("check")
        self.assertEqual(result.returncode, 1, out(result))
        self.assertIn("PENDING", out(result))
        self.assertEqual((root / "src/a.txt").read_text(), BASE)

    def test_upstream_fixed_is_not_patched(self) -> None:
        fx = Fixture(self)
        upstream = "line 1\nline 2 PATCHED upstream\nline 3 changed\nline 4\nline 5\n"
        root = fx.install("pkg-a", {"src/a.txt": upstream})
        fx.add_patch("pkg-a", "one", {"src/a.txt": BASE}, {"src/a.txt": PATCHED})
        for command in ("apply", "check"):
            result = fx.run(command)
            self.assertEqual(result.returncode, 0, out(result))
            self.assertIn("upstream-fixed", result.stdout)
        self.assertEqual((root / "src/a.txt").read_text(), upstream)

    def test_rollback_all_when_second_patch_conflicts(self) -> None:
        fx = Fixture(self)
        root_a = fx.install("pkg-a", {"src/a.txt": BASE})
        drifted = BASE.replace("line 3", "line three")
        root_b = fx.install("pkg-b", {"b.txt": drifted})
        fx.add_patch("pkg-a", "one", {"src/a.txt": BASE}, {"src/a.txt": PATCHED})
        fx.add_patch("pkg-b", "two", {"b.txt": BASE}, {"b.txt": PATCHED})

        result = fx.run("apply")
        self.assertEqual(result.returncode, 1, out(result))
        self.assertIn("pkg-b/two: patch does not apply cleanly", out(result))
        self.assertIn("rollback complete", out(result))
        self.assertEqual((root_a / "src/a.txt").read_text(), BASE)
        self.assertEqual((root_b / "b.txt").read_text(), drifted)

    def test_rollback_all_when_second_check_fails_after_apply(self) -> None:
        fx = Fixture(self)
        root_a = fx.install("pkg-a", {"src/a.txt": BASE})
        root_b = fx.install("pkg-b", {"b.txt": BASE})
        fx.add_patch("pkg-a", "one", {"src/a.txt": BASE}, {"src/a.txt": PATCHED})
        fx.add_patch("pkg-b", "two", {"b.txt": BASE}, {"b.txt": PATCHED},
                     check=[sys.executable, "{patchDir}/checks/contains.py", "{packageRoot}/b.txt", "NEVER"])
        mode = stat.S_IMODE(os.stat(root_b / "b.txt").st_mode)

        result = fx.run("apply")
        self.assertEqual(result.returncode, 1, out(result))
        self.assertIn("pkg-b/two: patch applied but check exited 1", out(result))
        self.assertIn("needle not found", out(result))
        self.assertEqual((root_a / "src/a.txt").read_text(), BASE)
        self.assertEqual((root_b / "b.txt").read_text(), BASE)
        self.assertEqual(stat.S_IMODE(os.stat(root_b / "b.txt").st_mode), mode)

    def test_added_files_applied_and_removed_on_rollback(self) -> None:
        fx = Fixture(self)
        root_a = fx.install("pkg-a", {"src/a.txt": BASE})
        fx.install("pkg-b", {"b.txt": BASE.replace("line 3", "drift")})
        fx.add_patch("pkg-a", "one", {"src/a.txt": BASE, "lib/deep/new.js": None},
                     {"src/a.txt": PATCHED, "lib/deep/new.js": "export const PATCHED = 1;\n"})
        fx.add_patch("pkg-b", "two", {"b.txt": BASE}, {"b.txt": PATCHED})

        result = fx.run("apply")
        self.assertEqual(result.returncode, 1, out(result))
        self.assertFalse((root_a / "lib").exists(), "created directories must be removed")
        self.assertEqual((root_a / "src/a.txt").read_text(), BASE)
        self.assertTrue((root_a / "src").is_dir())

        fx.packages = fx.packages[:1]
        fx.save()
        ok = fx.run("apply")
        self.assertEqual(ok.returncode, 0, out(ok))
        self.assertEqual((root_a / "lib/deep/new.js").read_text(), "export const PATCHED = 1;\n")
        again = fx.run("apply")
        self.assertIn("already applied", again.stdout)

    def test_deleted_file_restored_on_rollback(self) -> None:
        fx = Fixture(self)
        root_a = fx.install("pkg-a", {"src/a.txt": BASE, "src/old.txt": "old\n"})
        fx.install("pkg-b", {"b.txt": "drift\n"})
        fx.add_patch("pkg-a", "one", {"src/a.txt": BASE, "src/old.txt": "old\n"},
                     {"src/a.txt": PATCHED, "src/old.txt": None})
        fx.add_patch("pkg-b", "two", {"b.txt": BASE}, {"b.txt": PATCHED})
        result = fx.run("apply")
        self.assertEqual(result.returncode, 1, out(result))
        self.assertEqual((root_a / "src/old.txt").read_text(), "old\n")

    def test_regression_on_already_applied_patch(self) -> None:
        fx = Fixture(self)
        root_a = fx.install("pkg-a", {"a.txt": BASE})
        root_b = fx.install("pkg-b", {"b.txt": PATCHED})
        fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        fx.add_patch("pkg-b", "two", {"b.txt": BASE}, {"b.txt": PATCHED}, env={"FORCE_FAIL": "1"})

        result = fx.run("apply")
        self.assertEqual(result.returncode, 1, out(result))
        self.assertIn("patch is already applied but check exited", out(result))
        self.assertEqual((root_a / "a.txt").read_text(), BASE, "earlier patch of this run is rolled back")
        self.assertEqual((root_b / "b.txt").read_text(), PATCHED, "already-applied patch is left as found")

        check = fx.run("check")
        self.assertEqual(check.returncode, 1)
        self.assertIn("REGRESSION", out(check))

    def test_missing_package_is_skipped(self) -> None:
        fx = Fixture(self)
        root_b = fx.install("pkg-b", {"b.txt": BASE})
        fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        fx.add_patch("pkg-b", "two", {"b.txt": BASE}, {"b.txt": PATCHED})
        for command in ("apply", "check"):
            result = fx.run(command)
            self.assertEqual(result.returncode, 0, out(result))
            self.assertIn(f"pkg-a: SKIPPED, package not installed at {fx.root('pkg-a')}", result.stdout)
        self.assertEqual((root_b / "b.txt").read_text(), PATCHED)
        self.assertFalse(fx.root("pkg-a").exists())

    def test_scoped_package_name(self) -> None:
        fx = Fixture(self)
        root = fx.install("@scope/pkg", {"a.txt": BASE})
        fx.add_patch("@scope/pkg", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        result = fx.run("apply")
        self.assertEqual(result.returncode, 0, out(result))
        self.assertEqual((root / "a.txt").read_text(), PATCHED)

    def test_package_inside_enclosing_git_repository(self) -> None:
        # Plain `git apply` in a repository subdirectory silently skips files.
        with tempfile.TemporaryDirectory() as repo:
            subprocess.run(["git", "init", "-q", repo], env=GIT_ENV, check=True)
            fx = Fixture(self, base=Path(repo) / "dotfiles" / ".pi")
            root = fx.install("pkg-a", {"src/a.txt": BASE})
            fx.add_patch("pkg-a", "one", {"src/a.txt": BASE, "src/new.txt": None},
                         {"src/a.txt": PATCHED, "src/new.txt": "PATCHED\n"})
            result = fx.run("apply")
            self.assertEqual(result.returncode, 0, out(result))
            self.assertEqual((root / "src/a.txt").read_text(), PATCHED)
            self.assertTrue((root / "src/new.txt").exists())

    def test_check_tokens_and_environment(self) -> None:
        fx = Fixture(self)
        root = fx.install("pkg-a", {"a.txt": BASE})
        record = fx.tmp / "record.json"
        fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED},
                     check=[sys.executable, "{patchDir}/checks/env.py", "{packageRoot}/x", "{agentDir}"],
                     env={"CUSTOM_ROOT": "{packageRoot}/dist", "RECORD": str(record)})
        result = fx.run("check")
        self.assertEqual(result.returncode, 1)
        data = json.loads(record.read_text())
        real_root = os.path.realpath(root)
        self.assertEqual(data["argv"], [f"{real_root}/x", str(fx.agent)])
        self.assertEqual(data["cwd"], real_root)
        self.assertEqual(data["env"]["PI_PATCH_PACKAGE_ROOT"], real_root)
        self.assertEqual(data["env"]["PI_PATCH_DIR"], os.path.realpath(fx.patch_dir))
        self.assertEqual(data["env"]["PI_PATCH_PACKAGE"], "pkg-a")
        self.assertEqual(data["env"]["PI_PATCH_ID"], "one")
        self.assertEqual(data["env"]["CUSTOM_ROOT"], f"{real_root}/dist")

    def test_check_timeout(self) -> None:
        fx = Fixture(self)
        fx.install("pkg-a", {"a.txt": BASE})
        fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED},
                     check=[sys.executable, "-c", "import time; time.sleep(30)"], timeoutSeconds=0.5)
        start = time.monotonic()
        result = fx.run("apply")
        self.assertLess(time.monotonic() - start, 20)
        self.assertEqual(result.returncode, 1, out(result))
        self.assertIn("timed out", out(result))
        self.assertEqual((fx.root("pkg-a") / "a.txt").read_text(), BASE)

    def test_environment_defaults(self) -> None:
        fx = Fixture(self)
        root = fx.install("pkg-a", {"a.txt": BASE})
        fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        result = fx.run("apply", use_args=False,
                        env={"PI_CODING_AGENT_DIR": str(fx.agent), "PI_PATCH_MANIFEST": str(fx.manifest)})
        self.assertEqual(result.returncode, 0, out(result))
        self.assertEqual((root / "a.txt").read_text(), PATCHED)

    def test_missing_agent_dir_is_an_error(self) -> None:
        fx = Fixture(self)
        fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        result = subprocess.run([sys.executable, str(RUNNER), "--manifest", str(fx.manifest),
                                 "--agent-dir", str(fx.tmp / "nope"), "apply"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("agent directory not found", result.stderr)
        self.assertFalse((fx.tmp / "nope").exists())


class SafetyTests(unittest.TestCase):
    def _assert_rejected(self, fx: Fixture, message: str) -> subprocess.CompletedProcess:
        result = fx.run("apply")
        self.assertEqual(result.returncode, 2, out(result))
        self.assertIn(message, result.stderr)
        self.assertIn("no package files were changed", result.stderr)
        return result

    def test_symlink_escape_is_rejected(self) -> None:
        fx = Fixture(self)
        outside = fx.tmp / "outside"
        outside.mkdir()
        (outside / "a.txt").write_text(BASE)
        root = fx.root("pkg-a")
        root.mkdir(parents=True)
        (root / "src").symlink_to(outside)
        fx.add_patch("pkg-a", "one", {"src/a.txt": BASE}, {"src/a.txt": PATCHED})
        self._assert_rejected(fx, "passes through symlink")
        self.assertEqual((outside / "a.txt").read_text(), BASE)

    def test_symlink_target_file_is_rejected(self) -> None:
        fx = Fixture(self)
        outside = fx.tmp / "outside.txt"
        outside.write_text(BASE)
        root = fx.root("pkg-a")
        root.mkdir(parents=True)
        (root / "a.txt").symlink_to(outside)
        fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        self._assert_rejected(fx, "passes through symlink")
        self.assertEqual(outside.read_text(), BASE)

    def test_symlinked_package_root_is_allowed(self) -> None:
        fx = Fixture(self)
        real = fx.tmp / "linked-pkg"
        real.mkdir()
        (real / "a.txt").write_text(BASE)
        fx.root("pkg-a").parent.mkdir(parents=True)
        fx.root("pkg-a").symlink_to(real)
        fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        result = fx.run("apply")
        self.assertEqual(result.returncode, 0, out(result))
        self.assertEqual((real / "a.txt").read_text(), PATCHED)

    def test_unsafe_manifest_paths_are_rejected(self) -> None:
        cases = {"../escape.txt": "not a normalized relative path", "/etc/passwd": "is absolute",
                 "./a.txt": "not a normalized", "src//a.txt": "not a normalized", "src\\a.txt": "backslash"}
        for bad, message in cases.items():
            with self.subTest(bad):
                fx = Fixture(self)
                fx.install("pkg-a", {"a.txt": BASE})
                fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED}, files=[bad])
                self._assert_rejected(fx, message)

    def test_diff_with_traversal_is_rejected(self) -> None:
        fx = Fixture(self)
        fx.install("pkg-a", {"a.txt": BASE})
        (fx.tmp / "victim.txt").write_text("a\n")
        diff = "diff --git a/../victim.txt b/../victim.txt\n--- a/../victim.txt\n+++ b/../victim.txt\n@@ -1 +1 @@\n-a\n+b\n"
        (fx.patch_dir / "diffs/bad.patch").write_text(diff)
        fx.save({"schemaVersion": 1, "packages": [{"name": "pkg-a", "patches": [
            {"id": "bad", "file": "diffs/bad.patch", "files": ["../victim.txt"], "check": ["true"]}]}]})
        self._assert_rejected(fx, "not a normalized relative path")
        self.assertEqual((fx.tmp / "victim.txt").read_text(), "a\n")

    def test_patch_file_outside_patch_dir_is_rejected(self) -> None:
        fx = Fixture(self)
        fx.install("pkg-a", {"a.txt": BASE})
        entry = fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        entry["file"] = "../outside.patch"
        fx.save()
        self._assert_rejected(fx, "file: '../outside.patch'")


class ManifestValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fx = Fixture(self)
        self.root = self.fx.install("pkg-a", {"a.txt": BASE, "b.txt": BASE})
        self.entry = self.fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})

    def assert_invalid(self, message: str) -> None:
        result = self.fx.run("apply")
        self.assertEqual(result.returncode, 2, out(result))
        self.assertIn(message, result.stderr)
        self.assertEqual((self.root / "a.txt").read_text(), BASE)

    def test_valid_baseline(self) -> None:
        self.assertEqual(self.fx.run("check").returncode, 1)  # pending, but valid

    def test_files_must_match_diff(self) -> None:
        self.entry["files"] = ["a.txt", "b.txt"]
        self.fx.save()
        self.assert_invalid("do not match diff targets")

    def test_files_required(self) -> None:
        del self.entry["files"]
        self.fx.save()
        self.assert_invalid("missing required keys ['files']")

    def test_unknown_key(self) -> None:
        self.entry["fuzz"] = 3
        self.fx.save()
        self.assert_invalid("unknown keys ['fuzz']")

    def test_schema_version(self) -> None:
        self.fx.save({"schemaVersion": 2, "packages": self.fx.packages})
        self.assert_invalid("schemaVersion must be 1")

    def test_duplicate_patch_id(self) -> None:
        self.fx.packages[0]["patches"].append(dict(self.entry))
        self.fx.save()
        self.assert_invalid("duplicate id 'one'")

    def test_overlapping_files_between_patches(self) -> None:
        self.fx.add_patch("pkg-a", "two", {"a.txt": BASE}, {"a.txt": BASE + "more\n"})
        self.assert_invalid("combine patches that touch the same file")

    def test_duplicate_package(self) -> None:
        self.fx.save({"schemaVersion": 1, "packages": self.fx.packages * 2})
        self.assert_invalid("duplicate package")

    def test_bad_package_name(self) -> None:
        for name in ("../evil", "/abs", "@scope/..", "Up"):
            with self.subTest(name):
                self.fx.packages[0]["name"] = name
                self.fx.save()
                self.assert_invalid("invalid package name")

    def test_check_must_be_argv_list(self) -> None:
        self.entry["check"] = "node --test"
        self.fx.save()
        self.assert_invalid("check must be a non-empty list")

    def test_reserved_env(self) -> None:
        self.entry["env"] = {"PI_PATCH_PACKAGE_ROOT": "/tmp"}
        self.fx.save()
        self.assert_invalid("reserved env name")

    def test_missing_diff_file(self) -> None:
        self.entry["file"] = "diffs/none.patch"
        self.fx.save()
        self.assert_invalid("diff file not found")

    def test_invalid_json(self) -> None:
        self.fx.manifest.write_text("{")
        self.assert_invalid("invalid JSON")

    def test_missing_manifest(self) -> None:
        self.fx.manifest.unlink()
        self.assert_invalid("manifest not found")


class LockTests(unittest.TestCase):
    def test_second_runner_waits_for_lock(self) -> None:
        fx = Fixture(self)
        root = fx.install("pkg-a", {"a.txt": BASE})
        fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        with runner.AgentLock(fx.agent):
            proc = subprocess.Popen([sys.executable, str(RUNNER), "--manifest", str(fx.manifest),
                                     "--agent-dir", str(fx.agent), "apply"],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(1.0)
            self.assertIsNone(proc.poll(), "runner must wait while the lock is held")
            self.assertEqual((root / "a.txt").read_text(), BASE)
        stdout, stderr = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 0, stdout + stderr)
        self.assertIn("waiting for lock", stderr)
        self.assertEqual((root / "a.txt").read_text(), PATCHED)

    def test_nested_acquire_raises_instead_of_deadlock(self) -> None:
        fx = Fixture(self)
        with runner.AgentLock(fx.agent):
            with self.assertRaises(RuntimeError):
                runner.AgentLock(fx.agent).__enter__()


class ClassificationTests(unittest.TestCase):
    def test_classification(self) -> None:
        patch = [
            ["update", "--extensions"],
            ["update", "--all"],
            ["update", "npm:pi-claude-bridge"],
            ["update", "git:github.com/x/y"],
            ["update", "--extension", "npm:pi-claude-bridge"],
            ["update", "self", "--extensions"],
            ["update", "pi", "--extensions"],
            ["update", "--self", "--extensions"],
            ["update", "--extensions", "--force", "-a"],
            ["update", "--no-approve", "--all"],
        ]
        passthrough = [
            [], ["--version"], ["-p", "update --extensions"], ["install", "npm:x"], ["list"],
            ["update"], ["update", "self"], ["update", "pi"], ["update", "--self"],
            ["update", "--models"], ["update", "--help"], ["update", "--extensions", "-h"],
            ["update", "--all", "--extensions"], ["update", "--models", "--extensions"],
            ["update", "--extension"], ["update", "--extension", "--all"],
            ["update", "--extension", "a", "--extension", "b"], ["update", "--extension", "a", "b"],
            ["update", "src", "--extensions"], ["update", "a", "b"], ["update", "--bogus", "--extensions"],
            ["update", "--offline", "--extensions"], ["--offline", "update", "--extensions"],
        ]
        for args in patch:
            with self.subTest(args=args):
                self.assertTrue(launcher.update_includes_extensions(args))
        for args in passthrough:
            with self.subTest(args=args):
                self.assertFalse(launcher.update_includes_extensions(args))


FAKE_PI = textwrap.dedent("""\
    #!{python}
    import json, os, signal, sys
    args = sys.argv[1:]
    record = {{"argv": args, "pid": os.getpid(), "exe": os.path.realpath(__file__),
               "stdin_tty": os.isatty(0), "stdout_tty": os.isatty(1),
               "sigint_ignored": signal.getsignal(signal.SIGINT) == signal.SIG_IGN}}
    if not os.isatty(0):
        record["stdin"] = sys.stdin.read()
    with open(os.environ["FAKE_LOG"], "a") as handle:
        handle.write(json.dumps(record) + "\\n")
    if args[:1] == ["update"] and os.environ.get("FAKE_RESET_FILE"):
        with open(os.environ["FAKE_RESET_FILE"], "w") as handle:
            handle.write(os.environ["FAKE_RESET_CONTENT"])
        with open(os.environ["FAKE_RESET_FILE"] + ".version", "w") as handle:
            handle.write("2.0.0\\n")
    if os.environ.get("FAKE_SIGNAL"):
        os.kill(os.getpid(), int(os.environ["FAKE_SIGNAL"]))
    print("fake pi ran", flush=True)
    sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
""")


class LauncherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fx = Fixture(self)
        self.pkg = self.fx.install("pkg-a", {"a.txt": BASE})
        self.fx.add_patch("pkg-a", "one", {"a.txt": BASE}, {"a.txt": PATCHED})
        self.launch_bin = self.fx.tmp / "launch-bin"
        self.real_bin = self.fx.tmp / "real-bin"
        self.launch_bin.mkdir()
        self.real_bin.mkdir()
        (self.launch_bin / "pi").symlink_to(LAUNCHER)
        self.fake = self.real_bin / "pi"
        self.fake.write_text(FAKE_PI.format(python=sys.executable))
        self.fake.chmod(0o755)
        self.log = self.fx.tmp / "fake.log"
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ("PI_REAL_BIN", "FAKE_EXIT", "FAKE_SIGNAL", "PI_PATCH_MANIFEST")}
        self.env.update({
            "PATH": os.pathsep.join([str(self.launch_bin), str(self.real_bin), os.path.dirname(sys.executable),
                                     "/usr/bin", "/bin"]),
            "PI_CODING_AGENT_DIR": str(self.fx.agent),
            "PI_PATCH_MANIFEST": str(self.fx.manifest),
            "FAKE_LOG": str(self.log),
            "FAKE_RESET_FILE": str(self.pkg / "a.txt"),
            "FAKE_RESET_CONTENT": BASE,
        })
        self.entry = str(self.launch_bin / "pi")

    def records(self) -> list[dict]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def launch(self, args: list[str], stdin: str = "", **env: str) -> tuple[subprocess.CompletedProcess, int]:
        proc = subprocess.Popen([self.entry, *args], env={**self.env, **env}, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = proc.communicate(stdin, timeout=120)
        return subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr), proc.pid

    def test_passthrough_preserves_argv_stdin_exit_and_pid(self) -> None:
        args = ["-p", "hello world", "*", "$HOME", "", "--", "update --extensions", "--offline"]
        result, pid = self.launch(args, stdin="input\x00bytes\n", FAKE_EXIT="7")
        self.assertEqual(result.returncode, 7, out(result))
        [record] = self.records()
        self.assertEqual(record["argv"], args)
        self.assertEqual(record["stdin"], "input\x00bytes\n")
        self.assertEqual(record["pid"], pid, "non-update invocations must exec in place")
        self.assertEqual(record["exe"], str(self.fake))
        self.assertEqual(result.stdout, "fake pi ran\n")
        self.assertEqual(result.stderr, "")

    def test_non_extension_updates_pass_through_without_patching(self) -> None:
        for args in (["update"], ["update", "--help"], ["update", "--models"], ["update", "self"],
                     ["update", "--self"], ["update", "--all", "--extensions"]):
            with self.subTest(args=args):
                self.log.unlink(missing_ok=True)
                result, pid = self.launch(args, FAKE_EXIT="0")
                self.assertEqual(result.returncode, 0, out(result))
                self.assertEqual(self.records()[0]["pid"], pid)
                self.assertEqual(self.records()[0]["argv"], args)
                self.assertEqual((self.pkg / "a.txt").read_text(), BASE)
                self.assertNotIn("pi launcher", result.stdout + result.stderr)

    def test_extension_update_success_applies_patches(self) -> None:
        for args in (["update", "--extensions"], ["update", "--all"], ["update", "npm:pkg-a"],
                     ["update", "--extension", "npm:pkg-a"], ["update", "self", "--extensions"]):
            with self.subTest(args=args):
                self.log.unlink(missing_ok=True)
                result, pid = self.launch(args, stdin="kept\n")
                self.assertEqual(result.returncode, 0, out(result))
                [record] = self.records()
                self.assertEqual(record["argv"], args)
                self.assertEqual(record["stdin"], "kept\n")
                self.assertNotEqual(record["pid"], pid)
                self.assertFalse(record["sigint_ignored"], "the update child must not inherit SIG_IGN")
                self.assertIn("pkg-a/one: applied, check passed", result.stdout)
                self.assertIn("update and patch repair complete", result.stdout)
                self.assertEqual((self.pkg / "a.txt").read_text(), PATCHED)

    def test_failed_update_preserves_exit_and_does_not_patch(self) -> None:
        result, _ = self.launch(["update", "--extensions"], FAKE_EXIT="5")
        self.assertEqual(result.returncode, 5, out(result))
        self.assertIn("patches were NOT applied or checked", result.stderr)
        self.assertNotIn("pkg-a/one", out(result))
        self.assertEqual((self.pkg / "a.txt").read_text(), BASE)

    def test_update_killed_by_signal_is_reraised(self) -> None:
        result, _ = self.launch(["update", "--extensions"], FAKE_SIGNAL=str(int(signal.SIGTERM)))
        self.assertEqual(result.returncode, -signal.SIGTERM, out(result))
        self.assertIn("patches were NOT applied or checked", result.stderr)
        self.assertEqual((self.pkg / "a.txt").read_text(), BASE)

    def test_repair_failure_keeps_update_and_rolls_back_patches(self) -> None:
        self.fx.install("pkg-b", {"b.txt": "drift\n"})
        self.fx.add_patch("pkg-b", "two", {"b.txt": BASE}, {"b.txt": PATCHED})
        result, _ = self.launch(["update", "--extensions"])
        self.assertEqual(result.returncode, 1, out(result))
        self.assertIn("patch repair failed", result.stderr)
        self.assertEqual((self.pkg / "a.txt").read_text(), BASE)
        self.assertEqual((self.pkg / "a.txt.version").read_text(), "2.0.0\n", "update itself is not rolled back")

    def test_missing_manifest_after_update(self) -> None:
        result, _ = self.launch(["update", "--extensions"], PI_PATCH_MANIFEST=str(self.fx.tmp / "none.json"))
        self.assertEqual(result.returncode, 2, out(result))
        self.assertIn("manifest not found", result.stderr)

    def test_update_is_idempotent_through_launcher(self) -> None:
        del self.env["FAKE_RESET_FILE"]
        first, _ = self.launch(["update", "--extensions"])
        second, _ = self.launch(["update", "--extensions"])
        self.assertEqual((first.returncode, second.returncode), (0, 0), out(first) + out(second))
        self.assertIn("already applied, check passed", second.stdout)

    def test_launcher_waits_for_standalone_repair_lock(self) -> None:
        with runner.AgentLock(self.fx.agent):
            proc = subprocess.Popen([self.entry, "update", "--extensions"], env=self.env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(1.0)
            self.assertIsNone(proc.poll())
            self.assertEqual(self.records(), [], "update must not start before the lock is free")
        stdout, stderr = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 0, stdout + stderr)
        self.assertIn("waiting for lock", stderr)

    def test_tty_is_preserved(self) -> None:
        for args in (["--version"], ["update", "--extensions"]):
            with self.subTest(args=args):
                self.log.unlink(missing_ok=True)
                primary, secondary = pty.openpty()
                proc = subprocess.Popen([self.entry, *args], env=self.env, stdin=secondary,
                                        stdout=secondary, stderr=secondary, close_fds=True)
                os.close(secondary)
                output = b""
                while True:
                    ready, _, _ = select.select([primary], [], [], 30)
                    if not ready:
                        break
                    try:
                        chunk = os.read(primary, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output += chunk
                proc.wait(timeout=30)
                os.close(primary)
                self.assertEqual(proc.returncode, 0, output.decode(errors="replace"))
                [record] = self.records()
                self.assertTrue(record["stdin_tty"] and record["stdout_tty"])

    def test_passthrough_restores_default_sigpipe(self) -> None:
        shell_pi = self.real_bin / "pi"
        shell_pi.write_text("#!/bin/sh\nexec grep '^SigIgn' /proc/self/status\n")
        result, _ = self.launch(["--version"])
        self.assertEqual(result.returncode, 0, out(result))
        ignored = int(result.stdout.split()[1], 16)
        self.assertFalse(ignored & (1 << (signal.SIGPIPE - 1)), result.stdout)

    def test_real_bin_override(self) -> None:
        other = self.fx.tmp / "other-pi"
        shutil.copy(self.fake, other)
        other.chmod(0o755)
        self.launch(["--version"], PI_REAL_BIN=str(other))
        self.assertEqual(self.records()[0]["exe"], str(other))

    def test_real_bin_override_pointing_at_launcher_is_rejected(self) -> None:
        for target in (self.entry, str(LAUNCHER)):
            with self.subTest(target=target):
                result, _ = self.launch(["--version"], PI_REAL_BIN=target)
                self.assertEqual(result.returncode, 127)
                self.assertIn("would recurse", result.stderr)
        self.assertEqual(self.records(), [])

    def test_no_real_pi_on_path(self) -> None:
        result, _ = self.launch(["--version"], PATH=os.pathsep.join([str(self.launch_bin), "/usr/bin", "/bin"]))
        self.assertEqual(result.returncode, 127)
        self.assertIn("real pi not found", result.stderr)

    def test_launcher_copy_and_symlink_on_path_are_skipped(self) -> None:
        copy_bin = self.fx.tmp / "copy-bin"
        link_bin = self.fx.tmp / "link-bin"
        copy_bin.mkdir()
        link_bin.mkdir()
        shutil.copy(LAUNCHER, copy_bin / "pi")
        (link_bin / "pi").symlink_to(self.launch_bin / "pi")
        path = os.pathsep.join([str(self.launch_bin), str(copy_bin), str(link_bin), str(self.real_bin),
                                "/usr/bin", "/bin"])
        result, _ = self.launch(["--version"], PATH=path)
        self.assertEqual(result.returncode, 0, out(result))
        self.assertEqual(self.records()[0]["exe"], str(self.fake))

    def test_find_real_pi_unit(self) -> None:
        self_real = str(LAUNCHER)
        env = {"PATH": os.pathsep.join(["", str(self.launch_bin), str(self.real_bin)])}
        self.assertEqual(launcher.find_real_pi(self_real, env), str(self.fake))
        with self.assertRaises(launcher.LauncherError):
            launcher.find_real_pi(self_real, {"PATH": str(self.launch_bin)})
        with self.assertRaises(launcher.LauncherError):
            launcher.find_real_pi(self_real, {"PATH": "", "PI_REAL_BIN": str(self.fx.tmp / "missing")})


if __name__ == "__main__":
    unittest.main()
