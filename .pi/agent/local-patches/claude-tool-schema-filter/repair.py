#!/usr/bin/env python3
"""Check or restore the reviewed local patch for pi-claude-code-provider 0.4.0.

Commands:
  check  exit 0 = reviewed patched state, 2 = reviewed pristine state, 1 = refused
  apply  exit 0 = patched (applied or already patched, no-op), 1 = refused

The target is the provider package root. The default is
<agent>/npm/node_modules/pi-claude-code-provider. <agent> is the parent of the
local-patches directory that holds this file's directory. Use --root to select
another package root.

Only paths listed in manifest.json are in scope. The top-level node_modules
directory is excluded. Every other file under the root must match a recorded
pristine or patched SHA-256. The helper never reads or writes auth or session
data. It refuses symlinks, unknown files, unknown content, missing files,
mixed pristine/patched state, a wrong package name or version, and a patch or
manifest that fails validation. It validates all inputs before the first write.
Each write is atomic (temporary file, fsync, rename). A failure rolls back the
earlier writes of the same run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from pathlib import Path

BUNDLE_DIR = Path(__file__).resolve().parent
AGENT_DIR = BUNDLE_DIR.parent.parent
DEFAULT_ROOT = AGENT_DIR / "npm" / "node_modules" / "pi-claude-code-provider"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$")
EXIT_PATCHED, EXIT_REFUSED, EXIT_PRISTINE = 0, 1, 2


class Refused(Exception):
    """The helper refuses to act. No write happened unless the message says so."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_rel(rel: object) -> str:
    if not isinstance(rel, str) or not rel or "\\" in rel or "\0" in rel or rel.startswith("/"):
        raise Refused(f"unsafe path in bundle: {rel!r}")
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise Refused(f"unsafe path in bundle: {rel!r}")
    return rel


# ---------------------------------------------------------------- bundle


def load_bundle(bundle_dir: Path = BUNDLE_DIR) -> dict:
    """Load and validate manifest.json and the patch. Returns a checked bundle."""
    try:
        manifest = json.loads((bundle_dir / "manifest.json").read_text("utf-8"))
    except (OSError, ValueError) as err:
        raise Refused(f"cannot read manifest.json: {err}") from None
    if not isinstance(manifest, dict) or manifest.get("schema") != 1:
        raise Refused("manifest.json has an unsupported schema")
    pkg = manifest.get("package")
    if not isinstance(pkg, dict) or not isinstance(pkg.get("name"), str) or not isinstance(pkg.get("version"), str):
        raise Refused("manifest.json has no package name/version")
    excluded = manifest.get("scope", {}).get("excludedTopLevel")
    if excluded != ["node_modules"]:
        raise Refused("manifest.json scope must exclude only top-level node_modules")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise Refused("manifest.json has no files")
    for rel, entry in files.items():
        safe_rel(rel)
        if rel.split("/")[0] == "node_modules":
            raise Refused(f"manifest.json lists an excluded path: {rel}")
        if not isinstance(entry, dict):
            raise Refused(f"bad manifest entry: {rel}")
        pristine, patched = entry.get("pristine"), entry.get("patched")
        if not (pristine is None or (isinstance(pristine, str) and HEX64.match(pristine))):
            raise Refused(f"bad pristine hash: {rel}")
        if not (isinstance(patched, str) and HEX64.match(patched)):
            raise Refused(f"bad patched hash: {rel}")
    if "package.json" not in files or files["package.json"]["pristine"] != files["package.json"]["patched"]:
        raise Refused("manifest.json must pin an unchanged package.json")
    patch_meta = manifest.get("patch")
    if not isinstance(patch_meta, dict) or patch_meta.get("file") != "fix.patch":
        raise Refused("manifest.json patch.file must be fix.patch")
    try:
        patch_bytes = (bundle_dir / "fix.patch").read_bytes()
    except OSError as err:
        raise Refused(f"cannot read fix.patch: {err}") from None
    if sha256(patch_bytes) != patch_meta.get("sha256"):
        raise Refused("fix.patch does not match the SHA-256 in manifest.json")
    hunks = parse_patch(patch_bytes)
    changed = {rel for rel, e in files.items() if e["pristine"] != e["patched"]}
    if set(hunks) != changed:
        raise Refused("fix.patch file set does not equal the changed files in manifest.json")
    return {"manifest": manifest, "files": files, "hunks": hunks, "changed": sorted(changed)}


def parse_patch(data: bytes) -> dict[str, list]:
    """Strict unified-diff parser. Only the subset in fix.patch is accepted."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("fix.patch is not UTF-8") from None
    if not text.endswith("\n") or "\r" in text:
        raise Refused("fix.patch must use LF line ends and end with a newline")
    lines = text.split("\n")[:-1]
    result: dict[str, list] = {}
    i = 0
    while i < len(lines):
        if not lines[i].startswith("--- a/") or i + 1 >= len(lines) or not lines[i + 1].startswith("+++ b/"):
            raise Refused(f"fix.patch line {i + 1}: expected a file header")
        rel = safe_rel(lines[i][6:])
        if lines[i + 1][6:] != rel:
            raise Refused(f"fix.patch line {i + 2}: header paths differ")
        if rel in result:
            raise Refused(f"fix.patch lists {rel} twice")
        i += 2
        hunks = []
        while i < len(lines) and lines[i].startswith("@@"):
            m = HUNK.match(lines[i])
            if not m:
                raise Refused(f"fix.patch line {i + 1}: bad hunk header")
            a, b, c, d = (int(g) if g is not None else 1 for g in m.groups())
            i += 1
            body, old_n, new_n = [], 0, 0
            while old_n < b or new_n < d:
                if i >= len(lines) or lines[i][:1] not in (" ", "-", "+"):
                    raise Refused(f"fix.patch line {i + 1}: hunk body is short or has an unsupported marker")
                kind, content = lines[i][0], lines[i][1:]
                old_n += kind != "+"
                new_n += kind != "-"
                body.append((kind, content))
                i += 1
            if old_n != b or new_n != d:
                raise Refused(f"fix.patch line {i}: hunk line counts do not match")
            hunks.append((a, b, c, d, body))
        if not hunks:
            raise Refused(f"fix.patch has no hunks for {rel}")
        result[rel] = hunks
    return result


def apply_hunks(rel: str, original: bytes, hunks: list) -> bytes:
    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused(f"{rel}: not UTF-8") from None
    if text and not text.endswith("\n"):
        raise Refused(f"{rel}: no final newline")
    src = text.split("\n")[:-1] if text else []
    out: list[str] = []
    cursor = 0
    for a, b, c, d, body in hunks:
        start = a if b == 0 else a - 1
        if start < cursor or start > len(src):
            raise Refused(f"{rel}: hunk position out of order or out of range")
        out.extend(src[cursor:start])
        if len(out) != (c if d == 0 else c - 1):
            raise Refused(f"{rel}: hunk new-file position does not match")
        pos = start
        for kind, content in body:
            if kind in (" ", "-"):
                if pos >= len(src) or src[pos] != content:
                    raise Refused(f"{rel}: hunk context does not match")
                pos += 1
            if kind in (" ", "+"):
                out.append(content)
        cursor = pos
    out.extend(src[cursor:])
    return ("\n".join(out) + "\n").encode("utf-8") if out else b""


# ---------------------------------------------------------------- target


def read_nofollow(path: Path) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Refused(f"not a regular file: {path}")
        chunks = []
        while chunk := os.read(fd, 1 << 20):
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def check_root(root: Path) -> Path:
    root = Path(os.path.abspath(root))
    try:
        st = os.lstat(root)
    except OSError as err:
        raise Refused(f"root is not readable: {err}") from None
    if stat.S_ISLNK(st.st_mode):
        raise Refused(f"root is a symlink: {root}")
    if not stat.S_ISDIR(st.st_mode):
        raise Refused(f"root is not a directory: {root}")
    return root


def walk(root: Path) -> list[str]:
    found: list[str] = []

    def visit(directory: Path, prefix: str) -> None:
        with os.scandir(directory) as entries:
            for entry in sorted(entries, key=lambda e: e.name):
                rel = prefix + entry.name
                if not prefix and entry.name == "node_modules":
                    continue
                if entry.is_symlink():
                    raise Refused(f"symlink in scope: {rel}")
                if entry.is_dir(follow_symlinks=False):
                    visit(Path(entry.path), rel + "/")
                elif entry.is_file(follow_symlinks=False):
                    found.append(rel)
                else:
                    raise Refused(f"special file in scope: {rel}")

    visit(root, "")
    return found


def inspect(root: Path, bundle: dict) -> dict:
    """Classify the target. Raises Refused for any unknown or mixed state."""
    root = check_root(root)
    files = bundle["files"]
    pkg = bundle["manifest"]["package"]
    try:
        meta = json.loads(read_nofollow(root / "package.json"))
    except (OSError, ValueError) as err:
        raise Refused(f"cannot read package.json: {err}") from None
    if meta.get("name") != pkg["name"] or meta.get("version") != pkg["version"]:
        raise Refused(f"package version gate failed: found {meta.get('name')}@{meta.get('version')}, "
                      f"need {pkg['name']}@{pkg['version']}")
    try:
        present = walk(root)
    except OSError as err:
        raise Refused(f"cannot walk root: {err}") from None
    unknown = sorted(set(present) - set(files))
    if unknown:
        raise Refused(f"unknown files in scope: {', '.join(unknown[:10])}")
    contents: dict[str, bytes | None] = {}
    states: dict[str, str] = {}
    for rel, entry in files.items():
        if rel not in present:
            contents[rel] = None
            if entry["pristine"] is None:
                states[rel] = "pristine"
                continue
            raise Refused(f"missing file: {rel}")
        data = read_nofollow(root / rel)
        contents[rel] = data
        digest = sha256(data)
        if digest == entry["patched"] and digest == entry["pristine"]:
            states[rel] = "same"
        elif digest == entry["patched"]:
            states[rel] = "patched"
        elif digest == entry["pristine"]:
            states[rel] = "pristine"
        else:
            raise Refused(f"unknown content: {rel}")
    changed = {states[rel] for rel in bundle["changed"]}
    if len(changed) != 1:
        detail = ", ".join(f"{rel}={states[rel]}" for rel in bundle["changed"])
        raise Refused(f"mixed pristine/patched state: {detail}")
    status = changed.pop()
    plan = []
    if status == "pristine":
        for rel in bundle["changed"]:
            new = apply_hunks(rel, contents[rel] or b"", bundle["hunks"][rel])
            if sha256(new) != files[rel]["patched"]:
                raise Refused(f"patch result for {rel} does not match the patched SHA-256")
            plan.append((rel, contents[rel], new))
    return {"root": root, "status": status, "plan": plan}


# ---------------------------------------------------------------- writes


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _new_file_mode() -> int:
    mask = os.umask(0)
    os.umask(mask)
    return 0o666 & ~mask


def _atomic_put(target: Path, data: bytes | None, mode: int, create: bool) -> None:
    """Replace target with data. data None deletes. create=True refuses an existing target."""
    parent = target.parent
    if data is None:
        try:
            os.unlink(target)
        except FileNotFoundError:
            return
        _fsync_dir(parent)
        return
    tmp = parent / f".{target.name}.repair-{secrets.token_hex(6)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fchmod(fd, mode)
            os.fsync(fd)
        finally:
            os.close(fd)
        if create:
            os.link(tmp, target)  # fails if target exists
            os.unlink(tmp)
        else:
            os.replace(tmp, target)
        _fsync_dir(parent)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


def _current(path: Path) -> bytes | None:
    try:
        return read_nofollow(path)
    except FileNotFoundError:
        return None


def apply(root: Path, bundle: dict, before_commit=None) -> dict:
    """Apply the reviewed patch. before_commit(rel) is a test hook for fault injection."""
    state = inspect(root, bundle)
    if state["status"] == "patched":
        return {"status": "patched", "changed": []}
    root = state["root"]
    # Each attempted write is registered BEFORE the commit. _atomic_put can
    # replace the target and then fail (directory fsync, temp unlink), so the
    # rollback must consider every attempted target, not only completed ones.
    journal = []  # (target, old bytes or None, new bytes, mode)
    try:
        for rel, old, new in state["plan"]:
            if before_commit:
                before_commit(rel)
            target = root / rel
            if not target.parent.is_dir() or target.parent.is_symlink():
                raise Refused(f"parent directory is not a plain directory: {rel}")
            if _current(target) != old:
                raise Refused(f"{rel} changed during apply")
            mode = _new_file_mode() if old is None else stat.S_IMODE(os.lstat(target).st_mode)
            journal.append((target, old, new, mode))
            _atomic_put(target, new, mode, create=old is None)
        final = inspect(root, bundle)
        if final["status"] != "patched":
            raise Refused("post-apply verification did not reach the patched state")
    except BaseException as err:
        conflicts = []
        for target, old, new, mode in reversed(journal):
            # current == old: this write did not take effect; nothing to undo.
            # current == new: our write; restore old. Anything else (other
            # content, non-regular file, read error): keep it, report conflict.
            try:
                current = _current(target)
                if current == old:
                    continue
                if current != new:
                    conflicts.append(str(target))
                    continue
                _atomic_put(target, old, mode, create=False)
            except (OSError, Refused):
                conflicts.append(str(target))
        note = f"; rollback conflicts, inspect by hand: {', '.join(conflicts)}" if conflicts else "; earlier writes rolled back"
        if isinstance(err, Refused):
            raise Refused(f"{err}{note if journal else ''}") from None
        if isinstance(err, OSError):
            raise Refused(f"write failed: {err}{note if journal else ''}") from None
        raise
    return {"status": "patched", "changed": [rel for rel, _, _ in state["plan"]]}


# ---------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check or restore the reviewed pi-claude-code-provider 0.4.0 patch.")
    parser.add_argument("command", choices=["check", "apply"])
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help=f"provider package root (default: {DEFAULT_ROOT})")
    parser.add_argument("--json", action="store_true", help="print one JSON result line")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:
        return EXIT_REFUSED if exit_.code else EXIT_PATCHED

    def report(status: str, message: str, changed=None) -> None:
        if args.json:
            print(json.dumps({"status": status, "root": str(args.root), "message": message, "changed": changed or []}))
        else:
            print(f"{status}: {message}", file=sys.stderr if status == "refused" else sys.stdout)

    try:
        bundle = load_bundle()
        if args.command == "check":
            status = inspect(args.root, bundle)["status"]
            if status == "patched":
                report("patched", "reviewed patch is present")
                return EXIT_PATCHED
            report("pristine", "reviewed pristine 0.4.0; run apply to patch")
            return EXIT_PRISTINE
        result = apply(args.root, bundle)
        report("patched", f"applied to {len(result['changed'])} files" if result["changed"] else "already patched; no writes", result["changed"])
        return EXIT_PATCHED
    except Refused as err:
        report("refused", str(err))
        return EXIT_REFUSED
    except OSError as err:
        # apply() already rolled back its own writes before any OSError leaves it.
        report("refused", f"filesystem error: {err}")
        return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main())
