// Regression test for claude-bridge-root-union. Runs against the installed
// bridge (or PI_CLAUDE_BRIDGE_ROOT), so it also shows whether upstream fixed it.
// Usage: node --test regression.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, "../../npm/node_modules");
const bridge = process.env.PI_CLAUDE_BRIDGE_ROOT ?? path.join(modules, "pi-claude-bridge");
const { createJiti } = await import(path.join(modules, "jiti/lib/jiti.mjs"));
const jiti = createJiti(path.join(bridge, "src/"));

const { createToolServer } = await jiti.import(path.join(bridge, "src/mcp-server.ts"));
const { Client } = await jiti.import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await jiti.import("@modelcontextprotocol/sdk/inMemory.js");
// pi-codex-conversion 3.0.39's notebook parameters, as Pi hands them to the bridge.
const NOTEBOOK_PARAMETERS = JSON.parse(readFileSync(path.join(here, "notebook-schema.json"), "utf8"));

const plain = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

async function listTools(tools) {
	const server = createToolServer("pi", tools.map((tool) => ({ description: "", handler: async () => ({}), ...tool })));
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.instance.connect(serverSide);
	const client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(clientSide);
	const { tools: listed } = await client.listTools();
	await client.close();
	return Object.fromEntries(listed.map((tool) => [tool.name, tool.inputSchema]));
}

test("notebook's root union is served as one object schema", async () => {
	const { notebook } = await listTools([{ name: "notebook", inputSchema: NOTEBOOK_PARAMETERS }]);
	assert.equal(notebook.type, "object");
	assert.equal(notebook.anyOf, undefined);
	assert.deepEqual(notebook.required, ["action"]);
	assert.equal(notebook.additionalProperties, false);
	assert.deepEqual(new Set(notebook.properties.action.enum), new Set([
		"status", "list", "checkpoint", "restart", "diagnostics", "reset",
		"save", "load", "pin", "unpin", "release", "prune",
	]));
	for (const variant of NOTEBOOK_PARAMETERS.anyOf) {
		for (const name of Object.keys(variant.properties)) assert.ok(notebook.properties[name], name);
	}
	assert.equal(notebook.properties.hook.anyOf.length, 2);
});

test("object schemas pass through unchanged", async () => {
	const { read } = await listTools([{ name: "read", inputSchema: plain }]);
	assert.deepEqual(read, plain);
});

test("non-object schemas are still rejected", () => {
	assert.throws(() => createToolServer("pi", [{ name: "bad", description: "", inputSchema: { type: "string" }, handler: async () => ({}) }]));
	assert.throws(() => createToolServer("pi", [{
		name: "mixed", description: "", handler: async () => ({}),
		inputSchema: { anyOf: [plain, { type: "string" }] },
	}]));
});
