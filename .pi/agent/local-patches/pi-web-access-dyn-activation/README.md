# pi-web-access dynamic-activation probe patch

Fixes the false `[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or
newer` warning on pi 0.87.1 with the standard bun-global pi + npm-installed
package layout.

## Cause

`supportsDynamicTools()` probes pi's version via
`import.meta.resolve("@earendil-works/pi-coding-agent")` from the package's own
directory. Pi supplies that module to extensions via import aliasing, but
`import.meta.resolve` bypasses the alias and fails in every standard install
layout, so the probe returned false and printed the misleading warning.

## Change (dist/index.js only; index.ts is not loaded — pi.extensions points to ./dist)

- `piVersionFromPackageJson()`: parse + regex the semver triplet (prerelease-safe).
- `detectPiVersion()`: candidates = import.meta.resolve walk, then
  `createRequire` resolve, then bun-global / npm-global / pi npm-dir locations.
- `supportsDynamicTools()`: unchanged function-presence gate; version gate applies
  only when a version was found; undetermined version + functions present => enable.

Behavior on pi 0.86.1+: identical. On truly old pi: still disabled (no functions).
If the version resolves, the original 0.86.1 comparison still applies.

## Files

- `index.before.js` — pristine pi-web-access 0.31.0 `dist/index.js` (hash gate source).
- `ISSUE.md` — ready-to-paste upstream issue.

## Maintenance

The patch is installed via the hash-gated repair in
`../post-update-cache-repair/` (`pi-cache-fix-repair`, wired into
`pi-update-with-cache-fixes`). After a pi-web-access version bump, refresh
`payload/pi-web-access/dist/index.js` and the manifest hashes after review.

