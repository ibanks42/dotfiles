# Claude tool schema filter

Local patch for pi-claude-code-provider 0.4.0. No routing, auth, or global tool changes.
Root anyOf/allOf/oneOf and non-object schemas are excluded after the payload hook, before transport maps.
Nested unions remain available. Excluded tools have no callable mapping. Historical references receive unavailable labels.
Warnings use the interactive UI or stderr, with per-session duplicate suppression.

## Files

- `fix.patch`: the complete local change against pristine 0.4.0. It changes 5 files and adds `src/tool-schema-compatibility.ts`.
- `manifest.json`: the package name, version, tarball integrity, and `fix.patch` SHA-256. It also has the pristine and patched SHA-256 of all 36 package files.
- `installed-hashes.json`: older record of the 6 patched hashes. The values are the same as in `manifest.json`.
- `repair.py`: the check/apply helper.
- `test_repair.py`: tests for `repair.py`. They use temp copies only.
- `regression.test.mjs`: 8 offline behavior tests for the patched provider.

## Completeness evidence (2026-09-26)

The pristine tarball came from the local npm cache (`npm pack --offline --ignore-scripts`). Its sha512 is the same as the `integrity` in `npm/package-lock.json`.
A comparison of the pristine tarball and the installed package excluded only `node_modules`. It found 6 different files and no other difference.
Pristine 0.4.0 plus `fix.patch` is byte-identical to the installed package.
Thus `fix.patch` contains all local changes. An older note in this file said that earlier local changes were missing. That note was wrong.
A secret scan of the added lines found no credentials, tokens, keys, or home paths.

## Check or restore the patch

The helper requires Python 3.10 or newer on Linux or macOS. It uses POSIX filesystem APIs.

`repair.py` uses the provider package root. The default root is `<agent>/npm/node_modules/pi-claude-code-provider`. `<agent>` is the parent of the `local-patches` directory.

1. Run `python3 repair.py check`. Use `--root DIR` to select another package root.
2. Read the exit status. 0 = reviewed patched state. 2 = reviewed pristine 0.4.0. 1 = refused.
3. If the status is 2, run `python3 repair.py apply`.
4. Run `python3 repair.py check` again. Make sure that the status is 0.
5. Run `node regression.test.mjs`. Make sure that 8 tests pass and 0 tests fail.
6. In Pi, use `/reload`.

If `apply` finds the patched state, it writes nothing and exits with 0. Add `--json` to get one JSON result line.

### Refusals

The helper refuses in these conditions. It writes nothing:

- The package name or version is not `pi-claude-code-provider@0.4.0`.
- A file has a SHA-256 that is not the recorded pristine or patched value.
- A file is missing, or a file is not in `manifest.json`.
- The root, a file, or a directory in scope is a symlink or a special file.
- Some changed files are pristine and others are patched (mixed state).
- `fix.patch` does not match its SHA-256, or its file set is not the changed set in `manifest.json`.
- A patch result does not match the recorded patched SHA-256.

The helper validates all inputs before the first write. Each write uses a temp file, fsync, and rename.
The helper records each write before it starts. If a step fails, the helper rolls back every recorded write of the same run. This includes a write that replaced the file and then failed at fsync.
If a file changed during the run, the rollback does not overwrite it. The message then names the file. The rollback continues for the other files.
The CLI reports a filesystem error as a refusal (exit status 1). The helper does not lock files, so it cannot prevent all races.

The scope is the package root, except the top-level `node_modules`. The helper does not read or write auth, session, or settings data.

## Tests

The recovery tests require Python 3.12 or newer, Node.js, and the reviewed tarball.
They also use the dependencies already installed under `<agent>/npm/node_modules`.

- Run `python3 -B test_repair.py`. The tests get pristine 0.4.0 with `npm pack --offline --ignore-scripts` into a private temp dir.
- If the npm cache does not have the tarball, set `CLAUDE_PROVIDER_TGZ` to a local copy. The tests make sure that its integrity matches `manifest.json`.
- The 23 tests cover restore to the recorded hashes and idempotence. They also cover refusals without writes, rollback after a fault or an fsync failure, and concurrent edits.
- One test runs the 8 regressions against a restored temp copy. That copy uses a `node_modules` symlink to `<agent>/npm/node_modules`.
- To run the regressions against another copy, set `CLAUDE_PROVIDER_ROOT` to its package root.

No test writes to the installed provider. No test calls a model or uses the network. All temp files are in the system temp dir.

## Limits

- The helper supports only pristine 0.4.0 and this patch. A new provider version needs a new review, patch, and manifest.
- The pristine source is not in this repository. The recovery tests need the reviewed 0.4.0 tarball in the npm cache or as a local file. The extension declaration is unpinned.
- The helper does not install packages and does not repair `node_modules`.
- The helper does not lock the directory. Do not run Pi updates while it runs.
- A symlink above the root (for example `~/.pi`) is accepted. Only the root and the paths inside it are checked.
- The helper does not run automatically after an update. Reinstalling reviewed version 0.4.0 replaces the patched files. Then `check` reports 2, and `apply` restores the patch. A different version is refused until reviewed.
- LSP checks were partly inconclusive. Full type checking was not available.
- Source audit: notebook has a root union. Code exec and wait have object schemas. Other dynamic catalogs were not fully audited.
