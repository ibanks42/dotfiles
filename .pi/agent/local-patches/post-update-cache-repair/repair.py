#!/usr/bin/env python3
"""Check or reapply reviewed local cache fixes after Pi/package updates."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "manifest.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pi_web_access_root() -> Path:
    override = os.environ.get("PI_CACHE_REPAIR_PI_WEB_ACCESS_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / ".pi/agent/npm/node_modules/pi-web-access").resolve()


def package_root(kind: str) -> Path:
    if kind == "pi-web-access":
        return pi_web_access_root()
    raise ValueError(f"Unknown rootKind: {kind}")


def safe_child(root: Path, relative: str) -> Path:
    """Return root/relative if no component below the canonical root is a symlink.

    This check is a point-in-time validation. It does not stop a concurrent
    process that replaces a path component after the check.
    """
    parts = Path(relative).parts if relative else ()
    if not parts or Path(relative).is_absolute() or ".." in parts or parts == (".",):
        raise ValueError(f"Unsafe relative path: {relative!r}")
    try:
        canonical_root = root.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"Package root is not available: {root}: {error}") from error
    current = canonical_root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Refusing symlink path component: {current}")
    target = canonical_root.joinpath(*parts)
    if not target.resolve().is_relative_to(canonical_root) or target == canonical_root:
        raise ValueError(f"Target escapes package root: {target}")
    return target


def load_plan() -> tuple[list[dict], list[str]]:
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read manifest {MANIFEST}: {error}") from error
    if manifest.get("schemaVersion") != 1:
        raise ValueError("Unsupported manifest schema")
    plan: list[dict] = []
    errors: list[str] = []
    for package in manifest.get("packages", []):
        name = package["name"]
        root = package_root(package["rootKind"])
        package_json = root / "package.json"
        if not package_json.is_file():
            errors.append(f"{name}: package.json not found at {package_json}")
            continue
        try:
            version = json.loads(package_json.read_text(encoding="utf-8"))["version"]
        except Exception as error:  # noqa: BLE001 - boundary validation
            errors.append(f"{name}: cannot read version: {error}")
            continue
        expected = package["expectedVersion"]
        if version != expected:
            errors.append(f"{name}: version {version!r} is not reviewed version {expected!r}")
            continue
        for item in package.get("files", []):
            try:
                target = safe_child(root, item["path"])
                payload = safe_child(HERE, item["payload"])
            except ValueError as error:
                errors.append(f"{name}: {error}")
                continue
            if not payload.is_file():
                errors.append(f"{name}: payload missing: {payload}")
                continue
            payload_hash = sha256(payload)
            patched_hash = item["patchedSha256"]
            if payload_hash != patched_hash:
                errors.append(f"{name}:{item['path']}: payload hash mismatch ({payload_hash})")
                continue
            pristine_hash = item.get("pristineSha256")
            if target.exists():
                current_hash = sha256(target)
                if current_hash == patched_hash:
                    state = "patched"
                elif pristine_hash is not None and current_hash == pristine_hash:
                    state = "pristine"
                else:
                    errors.append(
                        f"{name}:{item['path']}: unknown hash {current_hash}; refusing to overwrite"
                    )
                    continue
            elif pristine_hash is None:
                current_hash = None
                state = "pristine"
            else:
                errors.append(f"{name}:{item['path']}: unexpectedly missing; refusing to create")
                continue
            plan.append({
                "package": name, "version": version, "root": root, "target": target,
                "relative": item["path"], "payload": payload, "patchedHash": patched_hash,
                "currentHash": current_hash, "state": state,
            })
    return plan, errors


def atomic_copy(source: Path, target: Path, mode: int | None = None) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as input_stream, tempfile.NamedTemporaryFile(
        mode="wb", dir=target.parent, prefix=f".{target.name}.repair-", delete=False
    ) as output_stream:
        temporary = Path(output_stream.name)
        shutil.copyfileobj(input_stream, output_stream)
        output_stream.flush()
        os.fsync(output_stream.fileno())
    try:
        os.chmod(temporary, mode if mode is not None else source.stat().st_mode & 0o777)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def apply(plan: list[dict]) -> None:
    changes = [item for item in plan if item["state"] == "pristine"]
    if not changes:
        print("cache-fix repair: already applied; no files changed")
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_root = HERE / "backups" / f"{stamp}-{os.getpid()}"
    originals: list[tuple[dict, Path | None, int | None]] = []
    try:
        for item in changes:
            target: Path = item["target"]
            backup = backup_root / item["package"].replace("/", "__") / item["relative"]
            if target.exists():
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup)
                originals.append((item, backup, target.stat().st_mode & 0o777))
            else:
                marker = backup.with_suffix(backup.suffix + ".absent")
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_text("absent before repair\n", encoding="utf-8")
                originals.append((item, None, None))
        for item, _backup, mode in originals:
            atomic_copy(item["payload"], item["target"], mode)
            if sha256(item["target"]) != item["patchedHash"]:
                raise RuntimeError(f"post-write hash mismatch: {item['target']}")
    except Exception:
        for item, backup, mode in reversed(originals):
            target = item["target"]
            if backup is None:
                target.unlink(missing_ok=True)
            elif backup.exists():
                atomic_copy(backup, target, mode)
        raise
    print(f"cache-fix repair: applied {len(changes)} file(s); backup: {backup_root}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=("check", "apply"), default="check")
    args = parser.parse_args()
    try:
        plan, errors = load_plan()
    except Exception as error:  # noqa: BLE001 - top-level safety boundary
        print(f"cache-fix repair: manifest/locator failure: {error}", file=sys.stderr)
        return 1
    if errors:
        print("cache-fix repair: REFUSED; reviewed version/hash gate failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    pending = [item for item in plan if item["state"] == "pristine"]
    if args.action == "check":
        if pending:
            print(f"cache-fix repair: {len(pending)} reviewed file(s) need repair")
            for item in pending:
                print(f"  - {item['package']}@{item['version']}:{item['relative']}")
            return 2
        print(f"cache-fix repair: healthy ({len(plan)} files match reviewed patched hashes)")
        return 0
    try:
        apply(plan)
    except Exception as error:  # noqa: BLE001 - rollback and report
        print(f"cache-fix repair: apply failed and rollback was attempted: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
