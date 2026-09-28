#!/usr/bin/env python3
"""Offline, hash-gated installation and restoration. Never enables tracing."""
import argparse
import fcntl
import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

ASSETS = Path(__file__).resolve().parent
MANIFEST_SHA256 = "02fae9c9e4b9696b632d4b1dff8c38c6c7de9a3d42d3094560ce5e2dceaef75c"
TARGETS = ("src/index.ts", "src/cache-trace.ts")
DEFAULT_PACKAGE = Path.home() / ".pi/agent/npm/node_modules/pi-claude-bridge"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path, optional=False):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if optional:
            return None
        raise
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("not a regular single-link file")
        return file.read()


def checked_assets():
    raw = read_regular(ASSETS / "manifest.json")
    assert raw is not None
    if digest(raw) != MANIFEST_SHA256:
        raise ValueError("manifest hash mismatch")
    manifest = json.loads(raw)
    if tuple(manifest["targets"]) != TARGETS or manifest["version"] != "0.9.0":
        raise ValueError("unexpected manifest scope")
    for name, expected in manifest["assets"].items():
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("unsafe asset path")
        if digest(read_regular(ASSETS / name)) != expected:
            raise ValueError("asset hash mismatch: " + name)
    return manifest


def snapshot(root, manifest):
    # The package root can be a package-manager symlink. No targets beneath it can be symlinks.
    if (root / "src").is_symlink() or not (root / "src").is_dir():
        raise ValueError("unsafe src directory")
    package = read_regular(root / "package.json")
    assert package is not None
    if json.loads(package).get("version") != "0.9.0":
        raise ValueError("wrong package version")
    if digest(package) != manifest["package_sha256"]:
        raise ValueError("package.json hash mismatch")
    values = {name: read_regular(root / name, optional=True) for name in TARGETS}
    modes = {name: stat.S_IMODE((root / name).stat().st_mode) if value is not None else 0o644
             for name, value in values.items()}
    states = []
    for name, value in values.items():
        actual = digest(value) if value is not None else None
        expected = manifest["targets"][name]
        if actual == expected["pristine"]:
            states.append("pristine")
        elif actual == expected["patched"]:
            states.append("patched")
        else:
            raise ValueError("unexpected target hash: " + name)
    if len(set(states)) != 1:
        raise ValueError("mixed state; refuse partial installation")
    return states[0], values, modes


def atomic(path, data, mode):
    if data is None:
        path.unlink()
        return
    fd, temporary = tempfile.mkstemp(prefix=".cache-trace-repair-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            os.fchmod(file.fileno(), mode)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def repair(action, package):
    manifest = checked_assets()
    root = package.resolve(strict=True)
    state, original, modes = snapshot(root, manifest)
    if action == "check":
        return state
    desired = "patched" if action == "apply" else "pristine"
    if state == desired:
        return state + " (no change)"
    replacement = {}
    for name in TARGETS:
        expected = manifest["targets"][name][desired]
        source = ("payload/" if desired == "patched" else "pristine/") + name
        replacement[name] = read_regular(ASSETS / source) if expected is not None else None
        if replacement[name] is not None and digest(replacement[name]) != expected:
            raise ValueError("replacement hash mismatch")
    # Validate every target before the first write. Stop running Pi before this command.
    if snapshot(root, manifest)[1] != original:
        raise ValueError("targets changed during validation")
    written = []
    try:
        order = tuple(reversed(TARGETS)) if action == "apply" else TARGETS
        for name in order:
            if read_regular(root / name, optional=True) != original[name]:
                raise ValueError("target changed before replacement")
            atomic(root / name, replacement[name], modes[name])
            written.append(name)
        if snapshot(root, manifest)[0] != desired:
            raise ValueError("post-write state mismatch")
    except BaseException:
        for name in reversed(written):
            # Never undo edits from another writer, even during rollback.
            if read_regular(root / name, optional=True) != replacement[name]:
                raise RuntimeError("concurrent edit prevents rollback: " + name) from None
            atomic(root / name, original[name], modes[name])
        raise
    return desired


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "apply", "restore"))
    parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE)
    args = parser.parse_args()
    # Serialize this repair tool without creating a lock file in the package.
    with open(__file__, "rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        print(repair(args.action, args.package))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("REFUSED: " + str(error), file=sys.stderr)
        sys.exit(1)
