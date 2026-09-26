import { test, expect, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseConfig, classify, resolvePattern, resolveOverride, universe, pickModel, markRateLimited, quotaBlock, ROUTER_PROMPT,
} from "../policy.ts";
import { rpc } from "../rpc.ts";

// Resolve the extension-local package through its public "." export, relative to this file.
// createRequire cannot be used: the package exports only an "import" condition.
const piAi = Bun.resolveSync("@earendil-works/pi-ai", fileURLToPath(new URL("../../../npm/", import.meta.url)));
const ai = await import(pathToFileURL(piAi).href);
mock.module("@earendil-works/pi-ai", () => ai);
mock.module("@earendil-works/pi-coding-agent", () => ({
  createCodingTools: () => ["read", "bash", "edit", "write"].map(name => ({ name })),
  createReadOnlyTools: () => ["read", "grep", "find", "ls"].map(name => ({ name })),
}));
const { default: extension } = await import("../index.ts");
const { runInChildSessionContext } = await import("../../../npm/node_modules/@tintinweb/pi-subagents/src/child-context.ts");

const luna = { provider: "openai-codex", id: "gpt-6-luna", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" } };
const opus = { provider: "pi-claude-code-provider", id: "opus", reasoning: true };
const sol = { provider: "openai-codex", id: "gpt-6-sol", reasoning: true };
const ctx = (models = [luna], reply = '{"tier":"low","thinking":"medium","reason":"Reference audit"}') => ({
  cwd: "/tmp",
  scopedModels: models.map(model => ({ model })),
  modelRegistry: {
    getAvailable: () => models,
    streamSimple: mock(() => ({ result: async () => ({
      content: [{ type: "text", text: reply }], stopReason: "stop",
    }) })),
  },
  ui: { setStatus: mock(() => {}), notify: mock(() => {}) },
});

function harness() {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const pi = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: mock(() => {}),
    appendEntry: mock(() => {}),
    events: bus(),
  };
  extension(pi as any);
  return { pi, handlers, tools };
}

function bus() {
  const e = new EventEmitter();
  return {
    on: (name: string, fn: any) => { e.on(name, fn); return () => { e.off(name, fn); }; },
    emit: (name: string, value: any) => { e.emit(name, value); },
    count: () => e.eventNames().reduce((n, name) => n + e.listenerCount(name), 0),
  };
}

test("partial settings preserve defaults and current quota/output customizations", () => {
  const c = parseConfig({ tiers: { menial: { candidates: ["test/fast"] } }, quota: { maxUsedPercent: 95 }, maxOutputChars: 400000 });
  expect(c.tiers.menial.thinking).toBe("minimal");
  expect(c.tiers.high.candidates[0]).toContain("fable");
  expect(c.maxOutputChars).toBe(400000);
  expect(() => parseConfig({ router: { timeoutMs: -1 } })).toThrow();
  expect(() => parseConfig({ tiers: { low: { candidates: "bad" } } })).toThrow();
});

test("removed maxParallel/maxDepth keys are dropped and do not control routing", async () => {
  const current = parseConfig({});
  const legacy = parseConfig({ maxParallel: 0, maxDepth: 0 });
  for (const cfg of [current, legacy]) {
    expect(cfg).not.toHaveProperty("maxParallel");
    expect(cfg).not.toHaveProperty("maxDepth");
  }
  expect(legacy).toEqual(current);
  const c = ctx([luna, opus, sol] as any);
  for (const tier of ["low", "mid"] as const) {
    expect(pickModel(c as any, legacy, tier, new Set()).model.id).toBe(pickModel(c as any, current, tier, new Set()).model.id);
  }
  expect(await classify(ctx() as any, legacy, { task: "Audit references" })).toMatchObject({ tier: "low", thinking: "medium" });
});

test("scope intersects availability; family patterns survive versions", () => {
  const c = ctx([luna, sol]);
  c.modelRegistry.getAvailable = () => [luna];
  expect(universe(c as any)).toEqual([luna]);
  expect(resolvePattern("openai-codex/gpt-*-luna", [luna, { ...luna, id: "gpt-7-luna" }])?.id).toBe("gpt-7-luna");
  expect(() => resolveOverride("fable", [luna])).toThrow();
  expect(() => resolveOverride("opus", [opus, { ...opus, provider: "different" }])).toThrow("Ambiguous");
});

test("classifier selects reasoning independently, with cheap malformed-response fallback", async () => {
  expect(await classify(ctx() as any, parseConfig({}), { task: "Audit references" })).toMatchObject({ tier: "low", thinking: "medium" });
  expect(await classify(ctx([luna], "invalid") as any, parseConfig({}), { task: "x" })).toMatchObject({ tier: "low", by: "fallback" });
  expect(ROUTER_PROMPT).toContain("folder count");
  expect(ROUTER_PROMPT).toContain("no edits -> low, medium");
});

test("native call gets model AND effort; no competing subtask tool", async () => {
  const h = harness();
  expect([...h.tools.keys()]).toEqual(["stop_subagent"]);
  const e = { toolName: "Agent", toolCallId: "a", input: { prompt: "Audit packages", subagent_type: "general-purpose" } };
  await h.handlers.get("tool_call")(e, ctx());
  expect(e.input).toMatchObject({ model: "openai-codex/gpt-6-luna", thinking: "medium" });
  const result = h.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "a", details: { agentId: "backend-id" } });
  expect(result.details.agentId).toBe("backend-id");
  expect(result.details.routing.effectiveThinking).toBe("medium");
});

test("explicit effort survives routing; explicit model still gets classified effort", async () => {
  const h = harness();
  const a = { toolName: "Agent", toolCallId: "a", input: { prompt: "Task", thinking: "high" } };
  await h.handlers.get("tool_call")(a, ctx());
  expect(a.input.thinking).toBe("high");
  const c = ctx();
  const b = { toolName: "Agent", toolCallId: "b", input: { prompt: "Task", model: "gpt-6-luna" } };
  await h.handlers.get("tool_call")(b, c);
  expect(b.input).toMatchObject({ thinking: "medium" });
  expect(c.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
});

test("full overrides skip classification and resumes keep their session", async () => {
  const h = harness(), c = ctx();
  const e = { toolName: "Agent", toolCallId: "a", input: { prompt: "Task", model: "gpt-6-luna", thinking: "high" } };
  await h.handlers.get("tool_call")(e, c);
  expect(c.modelRegistry.streamSimple).not.toHaveBeenCalled();
  const input = { prompt: "Continue", resume: "abc" };
  await h.handlers.get("tool_call")({ toolName: "Agent", input }, c);
  expect(input).toEqual({ prompt: "Continue", resume: "abc" });
});

test("unsupported reasoning is clamped; non-reasoning models get off", async () => {
  const h = harness();
  const e = { toolName: "Agent", toolCallId: "a", input: { prompt: "Task", model: "gpt-6-luna", thinking: "minimal" } };
  await h.handlers.get("tool_call")(e, ctx());
  expect(e.input.thinking).toBe("low");
  const noThinking = { ...luna, reasoning: false, thinkingLevelMap: undefined };
  const e2 = { toolName: "Agent", toolCallId: "b", input: { prompt: "Task", model: "gpt-6-luna", thinking: "high" } };
  await h.handlers.get("tool_call")(e2, ctx([noThinking] as any));
  expect(e2.input.thinking).toBe("off");
});

test("native child sessions register no parent controls or quota hooks", async () => {
  await runInChildSessionContext(async () => {
    const h = harness();
    expect(h.handlers.size).toBe(0);
    expect(h.tools.size).toBe(0);
  });
});

test("quota cooldown moves mid tasks from Opus to Sol", () => {
  const cfg = parseConfig({});
  const c = ctx([opus, sol] as any);
  expect(pickModel(c as any, cfg, "mid", new Set()).model.id).toBe("opus");
  markRateLimited(opus, "HTTP 429 quota exceeded", cfg);
  expect(quotaBlock(opus, cfg)).toContain("rate-limited");
  expect(pickModel(c as any, cfg, "mid", new Set()).model.id).toBe("gpt-6-sol");
});

test("stop RPC propagates response errors and cleans listeners", async () => {
  const b = bus();
  const off = b.on("subagents:rpc:stop", (p: any) => b.emit("subagents:rpc:stop:reply:" + p.requestId, { success: false, error: "Agent not found" }));
  await expect(rpc(b, "stop", { agentId: "missing" })).rejects.toThrow("Agent not found");
  expect(b.count()).toBe(1);
  off();
  await expect(rpc(b, "stop", {}, undefined, 5)).rejects.toThrow("did not reply");
  expect(b.count()).toBe(0);
});

test("stop RPC supports success and cancellation", async () => {
  const b = bus();
  const off = b.on("subagents:rpc:stop", (p: any) => b.emit("subagents:rpc:stop:reply:" + p.requestId, { success: true }));
  await rpc(b, "stop", {});
  off();
  const controller = new AbortController();
  const pending = rpc(b, "stop", {}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("Cancelled");
  expect(b.count()).toBe(0);
});
