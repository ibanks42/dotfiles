// Regression against PI_PATCH_PACKAGE_ROOT (or the default installed bridge).
// No model requests; the MCP server and client use linked in-memory transports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { target, dependency, bridgeLoader, sourcePath, fixtures } from './target.mjs';

const bridge = target('pi-claude-bridge');
const jiti = await bridgeLoader(bridge);
const { createToolServer } = await jiti.import(sourcePath(bridge, 'mcp-server.ts'));
const { Client } = await import(dependency(bridge, '@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(dependency(bridge, '@modelcontextprotocol/sdk/inMemory.js'));
// Pi's notebook parameters, as handed to the bridge.
const NOTEBOOK_PARAMETERS = JSON.parse(readFileSync(path.join(fixtures, 'notebook-schema.json'), 'utf8'));

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
