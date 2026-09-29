import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from 'node:fs';
import { target, bridgeLoader, sourcePath } from './target.mjs';

const root = target('pi-claude-bridge');
const jiti = await bridgeLoader(root);
const { getModels } = await jiti.import('@earendil-works/pi-ai/compat');
const { withCatalogFallbacks } = await jiti.import(sourcePath(root, 'catalog-fallbacks.ts'));
const { applyLongContext, buildModels, resolveClaudeCodeRuntimeModel, resolveModel } = await jiti.import(sourcePath(root, 'models.ts')); 

const ID = "claude-sonnet-5-5";
const PRO = { plan: "pro", longContextExtraUsage: false };
const template = () => getModels("anthropic").find((m) => m.id === "claude-sonnet-5");

describe("local Sonnet 5.5 catalog fallback", () => {
 it('installed provider wires catalog supplementation into registration', () => {
  const index = readFileSync(sourcePath(root, 'index.ts'), 'utf8');
  assert.match(index, /const MODELS\s*=\s*buildModels\(withCatalogFallbacks\(getModels\("anthropic"\)\)\)/);
 });
	it("fills only the missing id using provisional registration fields", () => {
		const source = getModels("anthropic").filter((m) => m.id !== ID);
		const supplemented = withCatalogFallbacks(source);
		const fallback = supplemented.find((m) => m.id === ID);
		const sonnet5 = template();
		assert.ok(fallback);
		assert.equal(supplemented.length, source.length + 1);
		assert.deepEqual(fallback, {
			id: ID, name: "Claude Sonnet 5.5", reasoning: sonnet5.reasoning,
			input: sonnet5.input, contextWindow: sonnet5.contextWindow,
			maxTokens: sonnet5.maxTokens, thinkingLevelMap: sonnet5.thinkingLevelMap,
		});
		assert.equal(fallback.cost, undefined, "do not copy Sonnet 5 pricing");
		assert.equal(fallback.compat, undefined, "do not extrapolate model capabilities");
	});

	it("preserves the authoritative future entry unchanged, without duplicates", () => {
		const authoritative = { ...template(), id: ID, name: "Catalog name", contextWindow: 200000, maxTokens: 12345,
			thinkingLevelMap: { xhigh: null }, cost: { input: 99 } };
		const source = [template(), authoritative];
		const result = withCatalogFallbacks(source);
		assert.equal(result.filter((m) => m.id === ID).length, 1);
		assert.strictEqual(result.find((m) => m.id === ID), authoritative);
		assert.deepEqual(result[1], authoritative);
	});

	it("does not mutate shared arrays or maps, even when projected and sorted", () => {
		const original = template();
		const source = Object.freeze([{ ...original, input: Object.freeze([...original.input]),
			thinkingLevelMap: Object.freeze({ ...original.thinkingLevelMap }) }]);
		const supplemented = withCatalogFallbacks(source);
		assert.notStrictEqual(supplemented, source);
		assert.notStrictEqual(supplemented[1].input, source[0].input);
		assert.notStrictEqual(supplemented[1].thinkingLevelMap, source[0].thinkingLevelMap);
		buildModels(supplemented);
		assert.deepEqual(source.map((m) => m.id), ["claude-sonnet-5"]);
		assert.deepEqual(source[0].thinkingLevelMap, original.thinkingLevelMap);
	});

	it("does nothing without a Sonnet 5 template", () => {
		assert.deepEqual(withCatalogFallbacks([]), []);
		assert.deepEqual(withCatalogFallbacks([{ ...template(), id: "claude-haiku-5" }]).map((m) => m.id), ["claude-haiku-5"]);
	});

	it("projects safely, resolves newest sonnet, preserves effort support and measured runtime policy", () => {
		const models = buildModels(withCatalogFallbacks(getModels("anthropic").filter((m) => m.id !== ID)));
		const model = models.find((m) => m.id === ID);
		assert.ok(model);
		assert.equal(resolveModel(models, "sonnet")?.id, ID);
		assert.equal(resolveModel([...models].reverse(), "sonnet")?.id, ID);
		assert.equal(model.baseUrl, undefined);
		assert.equal(model.api, undefined);
		assert.equal(model.provider, undefined);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.maxTokens, 128000);
		assert.equal(model.thinkingLevelMap.xhigh, "xhigh");
		assert.equal(model.thinkingLevelMap.max, "max");
		assert.deepEqual(resolveClaudeCodeRuntimeModel(model, PRO), { cliModelId: `${ID}[1m]`, contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel(model, { ...PRO, forceTwoHundredK: [ID] }),
			{ cliModelId: ID, contextWindow: 200000 });
		assert.equal(applyLongContext([model], PRO)[0].name, "Claude Sonnet 5.5 1M");
		assert.equal(applyLongContext([model], { ...PRO, forceTwoHundredK: [ID] })[0].contextWindow, 200000);
	});
});
