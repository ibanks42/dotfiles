# Dynamic tool activation never engages in standard installs: version probe uses `import.meta.resolve` on a package that cannot resolve there

**pi-web-access:** 0.31.0
**pi:** 0.87.1 (bun global install)
**OS:** Linux x64

## Symptom

Every startup prints:

```
[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.
```

...even though Pi is 0.87.1. The `web_enable` loader tool is never registered and all web tools load eagerly.

## Root cause

`supportsDynamicTools()` in `tool-activation.ts` reads Pi's version by resolving the host package from the extension's own install location:

```ts
const packagePath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..", "package.json");
```

In the standard layout, Pi is installed globally (bun/npm/pnpm global tree) while packages install into Pi's own npm directory (`~/.pi/agent/npm/node_modules/<pkg>`). Node/Bun resolution walks up from that directory, where `@earendil-works/pi-coding-agent` is **not installed** — it is a peer dependency, and Pi deliberately supplies its own modules to extensions by aliasing those specifiers (which is why the extension's top-level `import` statements work fine). `import.meta.resolve()` bypasses that aliasing and does raw resolution, so it throws `ERR_MODULE_NOT_FOUND`; the `catch { return false }` then reports "too old" even though the running Pi supports dynamic tools.

This affects essentially every real install; the probe only succeeds in a dev monorepo checkout (or if `pi-coding-agent` coincidentally sits in the same `node_modules` tree as the package).

Minimal repro from the installed package directory:

```
$ cd ~/.pi/agent/npm/node_modules/pi-web-access
$ bun -e 'import.meta.resolve("@earendil-works/pi-coding-agent")'
error: Cannot find module '@earendil-works/pi-coding-agent' from '.../pi-web-access/[eval]'
```

## Suggested fix

Treat the version probe as best-effort:

1. Try the current `import.meta.resolve` walk.
2. Try `createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json")`.
3. Check well-known global locations (bun global tree, npm global roots, Pi's npm dir).
4. If the capability functions (`getAllTools`/`getActiveTools`/`setActiveTools`) exist but the version is undetermined, enable dynamic activation anyway: function presence is the actual capability gate, and `registerWebToolActivation` already handles `setActiveTools` failures gracefully inside the `web_enable` execute path.

Alternatively, expose the running version on `ExtensionAPI` so extensions don't need filesystem probes at all.

## Impact

Cosmetic warning plus eager tool registration (per-request token overhead) for all standard installs. No functional loss.

