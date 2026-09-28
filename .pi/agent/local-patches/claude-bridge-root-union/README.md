# Claude bridge root-union schemas

Local patch for `pi-claude-bridge`. It lets the bridge serve Pi tools whose parameters are a root-level union of object schemas.

## Problem

`pi-codex-conversion` Notebook mode registers a `notebook` tool with a TypeBox `Type.Union` of object variants, which serializes to a root `anyOf`.
The bridge requires every tool schema to have `type: "object"` at the root. It throws in `createToolServer`, and the whole Pi tool server is lost for that turn:

```text
notebook: MCP tool parameters must be an object schema, got {"anyOf":[...]}
```

## Fix

- `schema-flatten.ts` is copied to `src/schema-flatten.ts`. It turns a root `anyOf`/`oneOf` of object schemas into one object schema. The flat schema has all properties, merges string enums and consts (such as `action`), and requires only the fields that every variant requires.
- `mcp-server.patch` adds the import and one call at the start of `createToolServer`.

Other schemas are unchanged. Non-object schemas are still rejected.
The flat schema is looser than the union. That's safe because Pi validates each call against the tool's real schema.

This is independent of `claude-bridge-cache-trace`, which patches only `src/index.ts` and `src/cache-trace.ts`.

## Use

```sh
./apply.sh status   # 0 patched or upstream fixed, 2 can apply, 1 patch no longer applies
./apply.sh apply    # idempotent; runs the regression test afterward
./apply.sh revert
node --test regression.test.mjs
```

Restart Pi after `apply` or `revert`. `PI_CLAUDE_BRIDGE_ROOT` selects another package root.

`pi-update-with-cache-fixes` runs `apply.sh apply` after every update.

## Keeping up with upstream

The patch is not tied to a version or hash. `patch` applies it with context matching and no fuzz, so upstream changes elsewhere in `mcp-server.ts` don't break it.

After a bridge update, `apply` does one of three things:

- **Patch applies.** Done.
- **Regression test passes without the patch.** Upstream has fixed the bug. `apply` skips the patch and says so. Delete this directory and its line in `pi-update-with-cache-fixes`.
- **Patch no longer applies.** Upstream changed the lines near the patch. Edit a copy of the new `src/mcp-server.ts`, then regenerate `mcp-server.patch` with `diff -u a/src/mcp-server.ts b/src/mcp-server.ts`.

`notebook-schema.json` is the notebook schema from `pi-codex-conversion` 3.0.39. The test uses it as a fixture, so it doesn't need to load that package.

See `UPSTREAM.md` for the issue to file with the bridge.
