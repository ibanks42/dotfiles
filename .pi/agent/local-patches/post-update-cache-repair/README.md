# Guarded post-update cache repair

This utility preserves the reviewed local cache fix for `pi-web-access` 0.31.0.
The fix probes dynamic tool activation in `dist/index.js`. It prevents a false
Pi-version warning with the standard bun-global Pi and npm-installed package
layout. See `../pi-web-access-dyn-activation/` for the pristine copy and
upstream issue.

## Recommended update command

Use this command instead of `pi update` while the local fix is required:

```sh
pi-update-with-cache-fixes --all
```

The wrapper passes all arguments to `pi update`. Examples:

```sh
pi-update-with-cache-fixes                 # update Pi, then repair
pi-update-with-cache-fixes --extensions    # update packages, then repair
pi-update-with-cache-fixes --all           # update Pi and packages, then repair
```

The wrapper exits if the update fails. After a successful update, it runs the
guarded repair. It exits with an error if the installed version or source hash
is not reviewed. Restart running Pi processes after success.

## Manual commands

```sh
pi-cache-fix-repair check
pi-cache-fix-repair apply
```

`check` exits 0 when the patch is present, 2 when the exact reviewed pristine
file can be repaired, and 1 when a version or hash is unknown or unsafe. `apply`
validates the package and payload before it writes. It changes nothing if a
safety check fails.

## Safety behavior

- Exact package-version gate.
- Exact pristine and patched SHA-256 hashes for the target file.
- Payload hash check before any write.
- Refusal of unknown or missing targets.
- Refusal of absolute paths, `..` components, and symlinks in any path
  component below the package root. This rule applies to targets and payloads.
- Resolved paths must stay inside the canonical package root or tool directory.
- Validation of all targets before mutation.
- Atomic writes with verification afterward.
- Backup of changed originals under `backups/<UTC timestamp>-<pid>/`.
- Rollback attempt after a failed apply.
- No change on repeated apply.

The path checks occur once, before the writes. They do not stop another
process that replaces a path component after the check.

The script does not patch an unreviewed future version. If an update changes the
package version or source hash, inspect the upstream fix. Then retire or refresh
the manifest.

Environment overrides used by tests and unusual installations:

- `PI_CACHE_REPAIR_PI_WEB_ACCESS_ROOT`
- `PI_REAL_BIN` (update wrapper only)

Launchers in `~/.local/bin/` are symlinks to this directory.

## Tests

```sh
python3 test_repair.py
```

Each test copies `repair.py`, `manifest.json`, and `payload/` into a temporary
directory. Fixtures and backups stay in that directory. The tests do not change
the installed package or this repository.
