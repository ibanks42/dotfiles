#!/usr/bin/env python3
"""Apply and check manifest-driven diff patches for installed Pi packages.

Usage:
  runner.py [--manifest PATH] [--agent-dir DIR] apply|check

The runner applies standard git unified diffs with `git apply` (exact context,
no fuzz). It only writes the files that the manifest lists for each patch. If a
patch conflicts or a check fails, it restores every file that this invocation
changed. It never runs or reverts a package-manager update.

Exit codes: 0 success, 1 patch or check failure, 2 manifest, usage, or
environment error.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path

SCHEMA_VERSION = 1
LOCK_NAME = "patch-runner.lock"
DEFAULT_CHECK_TIMEOUT = 600
OUTPUT_TAIL_CHARS = 8000

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_CONFIG = 2

PACKAGE_NAME_RE = re.compile(r"^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$")
PATCH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
RESERVED_ENV = {"PI_PATCH_PACKAGE_ROOT", "PI_PATCH_DIR", "PI_PATCH_ID", "PI_PATCH_PACKAGE", "PI_PATCH_AGENT_DIR"}

PACKAGE_KEYS = {"name", "patches"}
PATCH_KEYS = {"id", "file", "files", "check", "env", "timeoutSeconds"}
PATCH_REQUIRED = {"id", "file", "files", "check"}


class ConfigError(Exception):
    """The manifest, a diff, or a package path is invalid or unsafe."""


class PatchFailure(Exception):
    """A patch or check failed after validation."""


class Interrupted(BaseException):
    """SIGTERM or SIGHUP arrived. Raised so that rollback runs before exit."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"interrupted by signal {signum}")
        self.signum = signum


# ---------------------------------------------------------------------------
# Paths and agent directory


def default_agent_dir() -> Path:
    env = os.environ.get("PI_CODING_AGENT_DIR")
    if env:
        return Path(os.path.expanduser(env))
    return Path.home() / ".pi" / "agent"


def default_manifest_path() -> Path:
    env = os.environ.get("PI_PATCH_MANIFEST")
    if env:
        return Path(os.path.expanduser(env))
    return Path(os.path.realpath(__file__)).parent / "manifest.json"


def validate_relative_path(value: object, what: str) -> str:
    """Return value if it is a normalized, relative POSIX path inside its base."""
    if not isinstance(value, str) or not value:
        raise ConfigError(f"{what}: must be a non-empty string")
    if "\\" in value or "\0" in value or any(ord(ch) < 32 for ch in value):
        raise ConfigError(f"{what}: {value!r} contains a backslash or control character")
    if value.startswith("/"):
        raise ConfigError(f"{what}: {value!r} is absolute")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ConfigError(f"{what}: {value!r} is not a normalized relative path (no '.', '..', or empty parts)")
    if parts[0] == ".git":
        raise ConfigError(f"{what}: {value!r} targets .git")
    return value


def check_no_symlink_escape(root_real: Path, rel: str, what: str) -> None:
    """Reject rel if any existing component under root_real is a symlink or not a directory."""
    current = root_real
    parts = rel.split("/")
    for index, part in enumerate(parts):
        current = current / part
        try:
            st = os.lstat(current)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(st.st_mode):
            raise ConfigError(f"{what}: {rel!r} passes through symlink {current}")
        last = index == len(parts) - 1
        if not last and not stat.S_ISDIR(st.st_mode):
            raise ConfigError(f"{what}: {rel!r} has non-directory component {current}")
        if last and not stat.S_ISREG(st.st_mode):
            raise ConfigError(f"{what}: {rel!r} exists but is not a regular file")


# ---------------------------------------------------------------------------
# Diff parsing


@dataclass
class DiffEntry:
    path: str
    kind: str  # "modify", "add", or "delete"


def parse_git_diff(text: str, what: str) -> list[DiffEntry]:
    """Parse a git unified diff and return its targets.

    Only plain text changes are accepted: modify, add (from /dev/null), and
    delete (to /dev/null). Renames, copies, mode changes, symlinks, submodules,
    binary patches, and quoted paths are rejected.
    """
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    entries: list[DiffEntry] = []
    seen: set[str] = set()
    i = 0
    n = len(lines)
    while i < n and not lines[i].startswith("diff --git "):
        if lines[i].startswith(("--- ", "+++ ", "@@ ")):
            raise ConfigError(f"{what}: hunk or file header before the first 'diff --git' line")
        i += 1
    if i >= n:
        raise ConfigError(f"{what}: no 'diff --git' sections found")

    while i < n:
        header = lines[i]
        if not header.startswith("diff --git "):
            raise ConfigError(f"{what}: unexpected line {i + 1}: {header[:80]!r}")
        rest = header[len("diff --git "):]
        if '"' in rest:
            raise ConfigError(f"{what}: quoted paths are not supported: {header!r}")
        if not rest.startswith("a/"):
            raise ConfigError(f"{what}: expected 'a/' prefix: {header!r}")
        half = (len(rest) - 1) // 2
        a_path, b_part = rest[2:half], rest[half + 1:]
        if rest[half] != " " or not b_part.startswith("b/") or b_part[2:] != a_path:
            raise ConfigError(f"{what}: old and new paths differ (renames are not supported): {header!r}")
        path = validate_relative_path(a_path, f"{what}: diff path")
        if path in seen:
            raise ConfigError(f"{what}: {path!r} appears in more than one diff section")
        seen.add(path)
        i += 1

        kind = "modify"
        old_name = new_name = None
        while i < n and not lines[i].startswith(("--- ", "@@ ", "diff --git ")):
            ext = lines[i]
            if ext.startswith("new file mode "):
                if ext != "new file mode 100644" and ext != "new file mode 100755":
                    raise ConfigError(f"{what}: {path!r}: unsupported file mode: {ext!r}")
                kind = "add"
            elif ext.startswith("deleted file mode "):
                kind = "delete"
            elif ext.startswith("index "):
                pass
            elif ext.startswith(("GIT binary patch", "Binary files ")):
                raise ConfigError(f"{what}: {path!r}: binary patches are not supported")
            else:
                raise ConfigError(f"{what}: {path!r}: unsupported extended header: {ext!r}")
            i += 1

        if i < n and lines[i].startswith("--- "):
            old_name = lines[i][4:]
            i += 1
            if i >= n or not lines[i].startswith("+++ "):
                raise ConfigError(f"{what}: {path!r}: '---' line without '+++' line")
            new_name = lines[i][4:]
            i += 1
        else:
            raise ConfigError(f"{what}: {path!r}: no content change (mode-only or empty sections are not supported)")

        expected_old = "/dev/null" if kind == "add" else f"a/{path}"
        expected_new = "/dev/null" if kind == "delete" else f"b/{path}"
        if old_name != expected_old or new_name != expected_new:
            raise ConfigError(
                f"{what}: {path!r}: file headers {old_name!r}/{new_name!r} do not match "
                f"{expected_old!r}/{expected_new!r}"
            )

        hunks = 0
        while i < n and lines[i].startswith("@@ "):
            match = HUNK_RE.match(lines[i])
            if not match:
                raise ConfigError(f"{what}: {path!r}: bad hunk header {lines[i]!r}")
            old_left = int(match.group(2)) if match.group(2) is not None else 1
            new_left = int(match.group(4)) if match.group(4) is not None else 1
            i += 1
            hunks += 1
            while old_left > 0 or new_left > 0:
                if i >= n:
                    raise ConfigError(f"{what}: {path!r}: truncated hunk")
                line = lines[i]
                tag = line[:1]
                if tag == " ":
                    old_left -= 1
                    new_left -= 1
                elif tag == "-":
                    old_left -= 1
                elif tag == "+":
                    new_left -= 1
                elif tag == "\\":
                    pass
                else:
                    raise ConfigError(f"{what}: {path!r}: bad hunk line {i + 1}: {line[:80]!r}")
                if old_left < 0 or new_left < 0:
                    raise ConfigError(f"{what}: {path!r}: hunk line counts do not match its header")
                i += 1
            while i < n and lines[i].startswith("\\"):
                i += 1
        if hunks == 0:
            raise ConfigError(f"{what}: {path!r}: no hunks")
        entries.append(DiffEntry(path=path, kind=kind))
    return entries


# ---------------------------------------------------------------------------
# git apply in an isolated repository


class Git:
    """Runs `git apply` against a package root without touching any enclosing repository.

    A plain `git apply` run in a subdirectory of an unrelated repository silently
    skips paths outside that subdirectory. This class points GIT_DIR at an empty
    temporary bare repository and GIT_WORK_TREE at the package root, and ignores
    user and system git configuration.
    """

    def __init__(self) -> None:
        git = shutil.which("git")
        if not git:
            raise ConfigError("git executable not found on PATH")
        self.git = git
        self._tmp = tempfile.TemporaryDirectory(prefix="pi-patch-git-")
        self.git_dir = Path(self._tmp.name) / "repo.git"
        env = self._base_env()
        result = subprocess.run(
            [self.git, "init", "--quiet", "--bare", str(self.git_dir)],
            env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise ConfigError(f"git init failed: {result.stderr.strip()}")

    def close(self) -> None:
        self._tmp.cleanup()

    @staticmethod
    def _base_env() -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = os.devnull
        env["LC_ALL"] = "C"
        return env

    def apply(self, root: Path, patch: Path, *args: str) -> subprocess.CompletedProcess[str]:
        env = self._base_env()
        env["GIT_DIR"] = str(self.git_dir)
        env["GIT_WORK_TREE"] = str(root)
        return subprocess.run(
            [self.git, "apply", "--whitespace=nowarn", *args, str(patch)],
            cwd=root, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
        )

    def numstat_paths(self, patch: Path) -> list[str]:
        env = self._base_env()
        env["GIT_DIR"] = str(self.git_dir)
        result = subprocess.run(
            [self.git, "apply", "--numstat", "-z", str(patch)],
            env=env, stdin=subprocess.DEVNULL, capture_output=True,
        )
        if result.returncode != 0:
            raise ConfigError(f"{patch}: git cannot parse the diff: {result.stderr.decode(errors='replace').strip()}")
        paths = []
        for record in result.stdout.split(b"\0"):
            if not record:
                continue
            fields = record.split(b"\t", 2)
            if len(fields) != 3:
                raise ConfigError(f"{patch}: unexpected git numstat output")
            paths.append(fields[2].decode("utf-8", errors="surrogateescape"))
        return paths


# ---------------------------------------------------------------------------
# Manifest


@dataclass
class PatchSpec:
    package: str
    id: str
    file: Path
    files: list[str]
    entries: list[DiffEntry]
    check: list[str]
    env: dict[str, str]
    timeout: float

    @property
    def label(self) -> str:
        return f"{self.package}/{self.id}"


@dataclass
class PackageSpec:
    name: str
    patches: list[PatchSpec]


@dataclass
class Manifest:
    path: Path
    patch_dir: Path
    packages: list[PackageSpec]


def _require_keys(obj: dict, allowed: set[str], required: set[str], what: str) -> None:
    unknown = sorted(set(obj) - allowed)
    if unknown:
        raise ConfigError(f"{what}: unknown keys {unknown}")
    missing = sorted(required - set(obj))
    if missing:
        raise ConfigError(f"{what}: missing required keys {missing}")


def load_manifest(path: Path, git: Git) -> Manifest:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise ConfigError(f"manifest not found: {path}") from None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path}: invalid JSON: {exc}") from None
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: top level must be an object")
    _require_keys(data, {"schemaVersion", "packages", "$comment"}, {"schemaVersion", "packages"}, str(path))
    if data["schemaVersion"] != SCHEMA_VERSION or isinstance(data["schemaVersion"], bool):
        raise ConfigError(f"{path}: schemaVersion must be {SCHEMA_VERSION}")
    if not isinstance(data["packages"], list):
        raise ConfigError(f"{path}: packages must be a list")

    patch_dir = Path(os.path.realpath(path)).parent
    packages: list[PackageSpec] = []
    names: set[str] = set()
    for p_index, pkg in enumerate(data["packages"]):
        where = f"{path}: packages[{p_index}]"
        if not isinstance(pkg, dict):
            raise ConfigError(f"{where}: must be an object")
        _require_keys(pkg, PACKAGE_KEYS, PACKAGE_KEYS, where)
        name = pkg["name"]
        if not isinstance(name, str) or not PACKAGE_NAME_RE.match(name) or ".." in name:
            raise ConfigError(f"{where}: invalid package name {name!r}")
        if name in names:
            raise ConfigError(f"{where}: duplicate package {name!r}")
        names.add(name)
        if not isinstance(pkg["patches"], list) or not pkg["patches"]:
            raise ConfigError(f"{where}: patches must be a non-empty list")

        patches: list[PatchSpec] = []
        ids: set[str] = set()
        owners: dict[str, str] = {}
        for x_index, patch in enumerate(pkg["patches"]):
            pwhere = f"{where}.patches[{x_index}]"
            if not isinstance(patch, dict):
                raise ConfigError(f"{pwhere}: must be an object")
            _require_keys(patch, PATCH_KEYS, PATCH_REQUIRED, pwhere)
            pid = patch["id"]
            if not isinstance(pid, str) or not PATCH_ID_RE.match(pid):
                raise ConfigError(f"{pwhere}: invalid id {pid!r}")
            if pid in ids:
                raise ConfigError(f"{pwhere}: duplicate id {pid!r}")
            ids.add(pid)
            pwhere = f"{name}/{pid}"

            rel_file = validate_relative_path(patch["file"], f"{pwhere}: file")
            patch_file = patch_dir / rel_file
            check_no_symlink_escape(patch_dir, rel_file, f"{pwhere}: file")
            if not patch_file.is_file():
                raise ConfigError(f"{pwhere}: diff file not found: {patch_file}")

            files = patch["files"]
            if not isinstance(files, list) or not files:
                raise ConfigError(f"{pwhere}: files must be a non-empty list")
            files = [validate_relative_path(f, f"{pwhere}: files") for f in files]
            if len(set(files)) != len(files):
                raise ConfigError(f"{pwhere}: files has duplicates")
            for f in files:
                if f in owners:
                    raise ConfigError(
                        f"{pwhere}: file {f!r} is also patched by {name}/{owners[f]}; "
                        "combine patches that touch the same file"
                    )
                owners[f] = pid

            try:
                diff_text = patch_file.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                raise ConfigError(f"{pwhere}: diff is not UTF-8") from None
            entries = parse_git_diff(diff_text, f"{pwhere}: {rel_file}")
            diff_paths = {e.path for e in entries}
            git_paths = git.numstat_paths(patch_file)
            if sorted(git_paths) != sorted(diff_paths):
                raise ConfigError(f"{pwhere}: git and the runner disagree about diff targets: {git_paths} vs {sorted(diff_paths)}")
            if diff_paths != set(files):
                raise ConfigError(
                    f"{pwhere}: files {sorted(files)} do not match diff targets {sorted(diff_paths)}"
                )

            check = patch["check"]
            if not isinstance(check, list) or not check or not all(isinstance(c, str) and c for c in check):
                raise ConfigError(f"{pwhere}: check must be a non-empty list of non-empty strings")

            env = patch.get("env", {})
            if not isinstance(env, dict):
                raise ConfigError(f"{pwhere}: env must be an object")
            for key, value in env.items():
                if not ENV_NAME_RE.match(key) or key in RESERVED_ENV:
                    raise ConfigError(f"{pwhere}: invalid or reserved env name {key!r}")
                if not isinstance(value, str):
                    raise ConfigError(f"{pwhere}: env {key!r} must be a string")

            timeout = patch.get("timeoutSeconds", DEFAULT_CHECK_TIMEOUT)
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
                raise ConfigError(f"{pwhere}: timeoutSeconds must be a positive number")

            patches.append(PatchSpec(
                package=name, id=pid, file=patch_file, files=files, entries=entries,
                check=list(check), env=dict(env), timeout=float(timeout),
            ))
        packages.append(PackageSpec(name=name, patches=patches))
    return Manifest(path=path, patch_dir=patch_dir, packages=packages)


# ---------------------------------------------------------------------------
# Snapshots and rollback


@dataclass
class FileSnapshot:
    path: Path
    content: bytes | None  # None when the file did not exist
    mode: int | None
    missing_dirs: list[Path]  # ancestor directories that did not exist, deepest first


@dataclass
class Journal:
    """Original state of every file the invocation may change."""

    snapshots: dict[Path, FileSnapshot] = field(default_factory=dict)

    def capture(self, root: Path, rel: str) -> None:
        target = root / rel
        if target in self.snapshots:
            return
        missing: list[Path] = []
        parent = target.parent
        while parent != root and not parent.exists():
            missing.append(parent)
            parent = parent.parent
        if os.path.lexists(target):
            st = os.lstat(target)
            content = target.read_bytes()
            self.snapshots[target] = FileSnapshot(target, content, stat.S_IMODE(st.st_mode), missing)
        else:
            self.snapshots[target] = FileSnapshot(target, None, None, missing)

    def changed(self) -> bool:
        for snap in self.snapshots.values():
            if snap.content is None:
                if os.path.lexists(snap.path):
                    return True
            elif not snap.path.is_file() or snap.path.read_bytes() != snap.content:
                return True
        return False

    def rollback(self) -> list[str]:
        """Restore every captured file. Return a list of problems (empty when clean)."""
        problems: list[str] = []
        for snap in self.snapshots.values():
            try:
                if snap.content is None:
                    if os.path.lexists(snap.path):
                        os.unlink(snap.path)
                else:
                    _atomic_write(snap.path, snap.content, snap.mode or 0o644)
            except OSError as exc:
                problems.append(f"{snap.path}: {exc}")
        dirs = sorted({d for snap in self.snapshots.values() for d in snap.missing_dirs},
                      key=lambda d: len(d.parts), reverse=True)
        for directory in dirs:
            try:
                os.rmdir(directory)
            except FileNotFoundError:
                pass
            except OSError as exc:
                if exc.errno != errno.ENOTEMPTY:
                    problems.append(f"{directory}: {exc}")
        for snap in self.snapshots.values():
            if snap.content is None:
                if os.path.lexists(snap.path):
                    problems.append(f"{snap.path}: still exists after rollback")
            elif not snap.path.is_file() or snap.path.read_bytes() != snap.content:
                problems.append(f"{snap.path}: content differs after rollback")
        return problems


def _atomic_write(path: Path, content: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".rollback", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise


# ---------------------------------------------------------------------------
# Locking


_held_lock_paths: set[str] = set()


class AgentLock:
    """Exclusive flock on <agentDir>/patch-runner.lock.

    The launcher holds this lock across `pi update` and the repair, and passes
    lock_held=True to the runner. A second acquire of the same path in one
    process raises instead of deadlocking.
    """

    def __init__(self, agent_dir: Path, create_dir: bool = False) -> None:
        self.path = agent_dir / LOCK_NAME
        self.create_dir = create_dir
        self.fd: int | None = None

    def __enter__(self) -> "AgentLock":
        key = os.path.realpath(self.path)
        if key in _held_lock_paths:
            raise RuntimeError(f"patch lock {self.path} is already held by this process")
        if self.create_dir:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        elif not self.path.parent.is_dir():
            raise ConfigError(f"agent directory not found: {self.path.parent}")
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print(f"pi-patch: waiting for lock {self.path} (another update or repair is running)",
                      file=sys.stderr, flush=True)
                fcntl.flock(fd, fcntl.LOCK_EX)
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd
        _held_lock_paths.add(key)
        return self

    def __exit__(self, *exc: object) -> None:
        if self.fd is not None:
            _held_lock_paths.discard(os.path.realpath(self.path))
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


# ---------------------------------------------------------------------------
# Checks


@dataclass
class CheckResult:
    ok: bool
    returncode: int | None
    output: str
    timed_out: bool = False


def _substitute(value: str, tokens: dict[str, str]) -> str:
    for key, replacement in tokens.items():
        value = value.replace("{" + key + "}", replacement)
    return value


def run_check(spec: PatchSpec, root: Path, patch_dir: Path, agent_dir: Path) -> CheckResult:
    tokens = {"packageRoot": str(root), "patchDir": str(patch_dir), "agentDir": str(agent_dir)}
    argv = [_substitute(arg, tokens) for arg in spec.check]
    env = dict(os.environ)
    env.update({k: _substitute(v, tokens) for k, v in spec.env.items()})
    env.update({
        "PI_PATCH_PACKAGE_ROOT": str(root),
        "PI_PATCH_DIR": str(patch_dir),
        "PI_PATCH_AGENT_DIR": str(agent_dir),
        "PI_PATCH_PACKAGE": spec.package,
        "PI_PATCH_ID": spec.id,
    })
    try:
        proc = subprocess.Popen(
            argv, cwd=root, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
        )
    except OSError as exc:
        return CheckResult(False, None, f"cannot start check {argv[0]!r}: {exc}")
    try:
        out, _ = proc.communicate(timeout=spec.timeout)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        out, _ = proc.communicate()
        return CheckResult(False, None, out.decode(errors="replace"), timed_out=True)
    except BaseException:
        _kill_group(proc)
        proc.wait()
        raise
    return CheckResult(proc.returncode == 0, proc.returncode, out.decode(errors="replace"))


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _describe_check(result: CheckResult, spec: PatchSpec) -> str:
    if result.timed_out:
        return f"check timed out after {spec.timeout:g}s"
    if result.returncode is None:
        return "check could not start"
    return f"check exited {result.returncode}"


def _print_output(result: CheckResult) -> None:
    text = result.output.rstrip()
    if not text:
        return
    if len(text) > OUTPUT_TAIL_CHARS:
        text = "...\n" + text[-OUTPUT_TAIL_CHARS:]
    print("  --- check output ---", file=sys.stderr)
    for line in text.splitlines():
        print(f"  | {line}", file=sys.stderr)
    print("  --- end check output ---", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Runner


def package_root(agent_dir: Path, name: str) -> Path:
    return agent_dir / "npm" / "node_modules" / name


def _say(message: str) -> None:
    print(f"pi-patch: {message}", flush=True)


def _warn(message: str) -> None:
    print(f"pi-patch: {message}", file=sys.stderr, flush=True)


def _resolve_roots(manifest: Manifest, agent_dir: Path) -> dict[str, Path | None]:
    """Return the real root of each installed package, or None when it is absent.

    Also rejects unsafe targets in every installed package before any write.
    """
    roots: dict[str, Path | None] = {}
    for pkg in manifest.packages:
        root = package_root(agent_dir, pkg.name)
        if not root.exists():
            roots[pkg.name] = None
            continue
        if not root.is_dir():
            raise ConfigError(f"{pkg.name}: package root is not a directory: {root}")
        real = Path(os.path.realpath(root))
        for spec in pkg.patches:
            for rel in spec.files:
                check_no_symlink_escape(real, rel, spec.label)
                resolved = os.path.realpath(real / rel)
                if os.path.commonpath([resolved, str(real)]) != str(real):
                    raise ConfigError(f"{spec.label}: {rel!r} resolves outside {real}")
        roots[pkg.name] = real
    return roots


def _state(git: Git, root: Path, spec: PatchSpec) -> tuple[bool, bool, str]:
    """Return (reverse_applies, forward_applies, forward_error)."""
    reverse = git.apply(root, spec.file, "--check", "--reverse")
    if reverse.returncode == 0:
        return True, False, ""
    forward = git.apply(root, spec.file, "--check")
    return False, forward.returncode == 0, (forward.stderr or forward.stdout).strip()


def command_check(manifest: Manifest, agent_dir: Path, git: Git) -> int:
    """Report the state of every patch without writing package files."""
    roots = _resolve_roots(manifest, agent_dir)
    failed = False
    for pkg in manifest.packages:
        root = roots[pkg.name]
        if root is None:
            _say(f"{pkg.name}: SKIPPED, package not installed at {package_root(agent_dir, pkg.name)}")
            continue
        for spec in pkg.patches:
            reverse_ok, forward_ok, error = _state(git, root, spec)
            if reverse_ok:
                result = run_check(spec, root, manifest.patch_dir, agent_dir)
                if result.ok:
                    _say(f"{spec.label}: applied, check passed")
                else:
                    failed = True
                    _warn(f"{spec.label}: REGRESSION, patch is applied but {_describe_check(result, spec)}")
                    _print_output(result)
                continue
            result = run_check(spec, root, manifest.patch_dir, agent_dir)
            if result.ok:
                _say(f"{spec.label}: upstream-fixed, check passes without the patch; consider retiring it")
            elif forward_ok:
                failed = True
                _warn(f"{spec.label}: PENDING, patch is not applied and applies cleanly; run 'apply'")
            else:
                failed = True
                _warn(f"{spec.label}: CONFLICT, patch is neither applied nor applicable: {error}")
    return EXIT_FAILED if failed else EXIT_OK


def command_apply(manifest: Manifest, agent_dir: Path, git: Git) -> int:
    """Apply every pending patch. Roll back all changes of this run on any failure."""
    roots = _resolve_roots(manifest, agent_dir)
    journal = Journal()
    changed: list[str] = []
    try:
        for pkg in manifest.packages:
            root = roots[pkg.name]
            if root is None:
                _say(f"{pkg.name}: SKIPPED, package not installed at {package_root(agent_dir, pkg.name)}")
                continue
            for spec in pkg.patches:
                _apply_one(spec, root, manifest.patch_dir, agent_dir, git, journal, changed)
    except BaseException as exc:
        if journal.changed():
            _warn(f"rolling back {len(changed)} patch(es) applied by this run: {', '.join(changed) or '(partial)'}")
            blocked = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP}
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
            try:
                problems = journal.rollback()
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            if problems:
                _warn("ROLLBACK INCOMPLETE; restore these files manually or reinstall the package:")
                for problem in problems:
                    _warn(f"  {problem}")
            else:
                _warn("rollback complete; package files match their state before this run")
        if isinstance(exc, PatchFailure):
            _warn(f"FAILED: {exc}")
            return EXIT_FAILED
        raise
    return EXIT_OK


def _apply_one(spec: PatchSpec, root: Path, patch_dir: Path, agent_dir: Path,
               git: Git, journal: Journal, changed: list[str]) -> None:
    reverse_ok, forward_ok, error = _state(git, root, spec)
    if reverse_ok:
        result = run_check(spec, root, patch_dir, agent_dir)
        if not result.ok:
            _print_output(result)
            raise PatchFailure(f"{spec.label}: patch is already applied but {_describe_check(result, spec)} (regression)")
        _say(f"{spec.label}: already applied, check passed")
        return

    probe = run_check(spec, root, patch_dir, agent_dir)
    if probe.ok:
        _say(f"{spec.label}: upstream-fixed, check passes without the patch; not applied, consider retiring it")
        return

    if not forward_ok:
        raise PatchFailure(f"{spec.label}: patch does not apply cleanly and is not already applied: {error}")

    for rel in spec.files:
        check_no_symlink_escape(root, rel, spec.label)
        journal.capture(root, rel)
    result = git.apply(root, spec.file)
    if result.returncode != 0:
        raise PatchFailure(f"{spec.label}: git apply failed: {(result.stderr or result.stdout).strip()}")
    changed.append(spec.label)
    verify = git.apply(root, spec.file, "--check", "--reverse")
    if verify.returncode != 0:
        raise PatchFailure(f"{spec.label}: patch did not take effect: {(verify.stderr or verify.stdout).strip()}")

    result = run_check(spec, root, patch_dir, agent_dir)
    if not result.ok:
        _print_output(result)
        raise PatchFailure(f"{spec.label}: patch applied but {_describe_check(result, spec)}")
    _say(f"{spec.label}: applied, check passed")


def run(command: str, manifest_path: Path | None = None, agent_dir: Path | None = None,
        lock_held: bool = False) -> int:
    """Entry point shared by the CLI and the launcher.

    Set lock_held=True only when the caller already holds AgentLock for agent_dir.
    """
    if command not in ("apply", "check"):
        raise ValueError(f"unknown command {command!r}")
    manifest_path = manifest_path or default_manifest_path()
    agent_dir = Path(os.path.abspath(agent_dir or default_agent_dir()))
    git: Git | None = None
    previous_handlers = _install_interrupt_handlers()
    try:
        git = Git()
        manifest = load_manifest(manifest_path, git)
        handler = command_apply if command == "apply" else command_check
        if lock_held:
            return handler(manifest, agent_dir, git)
        with AgentLock(agent_dir):
            return handler(manifest, agent_dir, git)
    except ConfigError as exc:
        _warn(f"ERROR: {exc}")
        _warn("no package files were changed")
        return EXIT_CONFIG
    finally:
        if git is not None:
            git.close()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def _raise_interrupted(signum: int, _frame: object) -> None:
    raise Interrupted(signum)


def _install_interrupt_handlers() -> dict[int, object]:
    if threading.current_thread() is not threading.main_thread():
        return {}
    return {signum: signal.signal(signum, _raise_interrupted) for signum in (signal.SIGTERM, signal.SIGHUP)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Apply or check manifest-driven Pi package patches.")
    parser.add_argument("--manifest", type=Path, help="manifest path (default: $PI_PATCH_MANIFEST or manifest.json next to this script)")
    parser.add_argument("--agent-dir", type=Path, help="Pi agent directory (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)")
    parser.add_argument("command", choices=["apply", "check"])
    args = parser.parse_args(argv)
    try:
        return run(args.command, args.manifest, args.agent_dir)
    except KeyboardInterrupt:
        return 130
    except Interrupted as exc:
        return 128 + exc.signum


if __name__ == "__main__":
    sys.exit(main())
