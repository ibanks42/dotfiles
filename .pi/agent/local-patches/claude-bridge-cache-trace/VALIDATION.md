# Offline validation

## Commands and results

The commands ran from this asset directory. No command sent a model request.

```text
$ node --version
v26.10.0

$ node --test offline.test.mjs
✔ disabled default creates no directory; runtime off invalidates live state
✔ actual sync branches match stock IO and return values; only observations added
✔ actual compaction/tree, missed steering and discard hooks isolate siblings
✔ query identity survives context replacement; idle excludes tool boundaries; usage snapshots are not added
✔ late completion from discarded query retains original identity
✔ privacy is constructed from allowlists; optional hashes detect prefix changes
✔ symlink control, log directory, and log files fail closed; storage failure never throws
✔ private permissions and bounded rotation
✔ actual provider completion and catch hooks: abort rotation, error enum, isolated exclusion
✔ actual provider late abandoned callback cannot take replacement identity
✔ all index modifications are observational insertions, with stable SDK attribution
ℹ tests 12
ℹ pass 12
ℹ fail 0

$ python3 test_repair.py
Ran 9 tests in 0.031s
OK

$ python3 repair.py check
pristine
```

Node printed its standard experimental warning for `stripTypeScriptTypes`.

The repair tests changed only temporary package copies. The installed package received only the read-only `check` command.

## Installed-state check

```text
installed index unchanged: True
installed cache-trace absent: True
```

No installed source, control file, real log directory, environment configuration, staging entry, or commit changed.

## Hashes

```text
package.json:
b667314c25d4653b7ba1da3deb9371483647d0385cb3fe1c18e1e9807f4b99e6

baseline src/index.ts:
27a9f817fa1116c7c3f0c086c9b755a137fba68c7f19f25c745d3085e085c22c

patched src/index.ts:
395f79cc9ab1020d0a27fa1ee33e634e6f38a961eab528a2e49ce78b487a2350

new src/cache-trace.ts:
ef5de3c2448bc3dad5473c86ccabc92ec55cd70083a7b97f02cda75f9dfc9f52

manifest.json:
02fae9c9e4b9696b632d4b1dff8c38c6c7de9a3d42d3094560ce5e2dceaef75c

repair.py:
02cddb1bb2d82ba78c8c15ef3d20d000a2c1eaf39e30f5e09d3083f9f1fcbd51
```

## Diagnostics and limits

The active LSP checks reported no primary type errors for the new diagnostic module. Python checks reported no type errors.

A later LSP recheck included an inconclusive TypeScript result. The server does not always publish a clean result. This is not a complete package typecheck.

Three Python lint findings were false positives. They concerned exceptions that intentionally propagate to the CLI entry point's exception handler.

The tests extract real sync and lifecycle functions with fake session IO and a fake SDK consumer. They do not prove real cache performance or complete SDK integration.

No paid requests, session synchronization fixes, cache warming, or debug capture occurred.

Parent verification: expanded the fixed model allowlist for current Claude models and added a privacy regression test. Installation now places the dependency before its importer. Regenerated patch and manifest hashes. Rerun: 12 JavaScript tests and 9 Python tests pass. Installed check reports patched. Local control file enabled with fingerprints, mode 0600. No live model requests sent. Restart required; real cache behavior remains unverified.
