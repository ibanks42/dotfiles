# Issue draft for elidickinson/pi-claude-bridge

**Title:** Tools with a root-level union schema break the whole MCP tool server

`createToolServer` calls `assertObjectSchema` on every tool and throws if one tool's schema isn't `type: "object"` at the root. Some Pi extensions declare parameters as a TypeBox `Type.Union` of object variants. One example is the `notebook` tool from `@howaboua/pi-codex-conversion` in Notebook mode. The throw then removes every Pi tool from the turn, not just that one:

```text
notebook: MCP tool parameters must be an object schema, got {"anyOf":[{"type":"object",...},...]}
```

Pi accepts these schemas, and Codex/OpenAI providers send them as-is. MCP and the Anthropic API need an object at the root, so the schema can't be passed through unchanged.

**Suggested fix:** before the assertion, flatten a root `anyOf`/`oneOf` whose variants are all objects into one object schema:

- include all properties from all variants
- merge string enums and consts into one enum
- if a property has other conflicting definitions, use a nested `anyOf`
- in `required`, include only the fields that every variant requires
- keep `additionalProperties: false` if every variant has it

Being looser than the union is safe for the reason `mcp-server.ts` already gives: Pi validates arguments against the real schema.
Other non-object schemas can keep failing loudly.

A working implementation (about 60 lines) and tests are available: `schema-flatten.ts` and `regression.test.mjs` in this directory.
