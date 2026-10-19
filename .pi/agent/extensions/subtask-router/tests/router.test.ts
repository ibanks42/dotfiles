import { test, expect, mock, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createTwoFilesPatch } from "../../../npm/node_modules/diff/libesm/index.js";

// Isolated agent dir: config, history state, and a usage-meters stub (no network).
const AGENT = mkdtempSync(join(tmpdir(), "router-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_SUBTASK_ROUTER_STATE = join(AGENT, "state.json");
const OUTCOMES = join(AGENT, "outcomes.jsonl");
process.env.PI_SUBTASK_ROUTER_OUTCOMES = OUTCOMES;
const METERS = join(AGENT, "meters.mjs");
writeFileSync(METERS, "export async function fetchClaudeUsageDirect() { return globalThis.__testMeters; }\n"
  + "export function parseClaudeUsage() { return []; }\nexport async function runClaudeUsage() { return ''; }\n");
process.env.PI_SUBTASK_ROUTER_USAGE_METERS = METERS;
process.env.PI_SUBTASK_ROUTER_REVIEWS = join(AGENT, "reviews");
const REAL_AGENT = fileURLToPath(new URL("../../../", import.meta.url));

// Resolve the extension-local package through its public "." export, relative to this file.
const piAi = Bun.resolveSync("@earendil-works/pi-ai", fileURLToPath(new URL("../../../npm/", import.meta.url)));
const ai = await import(pathToFileURL(piAi).href);
mock.module("@earendil-works/pi-ai", () => ai);
mock.module("@earendil-works/pi-coding-agent", () => ({
  createCodingTools: () => ["read", "bash", "edit", "write"].map(name => ({ name })),
  createReadOnlyTools: () => ["read", "grep", "find", "ls"].map(name => ({ name })),
}));
const P = await import("../policy.ts");
const { default: extension } = await import("../index.ts");
const { rpc } = await import("../rpc.ts");
const { runInChildSessionContext } = await import("../../../npm/node_modules/@tintinweb/pi-subagents/src/child-context.ts");

const REAL_CONFIG = JSON.parse(readFileSync(join(REAL_AGENT, "subtask-router.json"), "utf8"));
const writeConfig = (patch: object = {}) =>
  writeFileSync(join(AGENT, "subtask-router.json"), JSON.stringify({ ...REAL_CONFIG, agentTypes: { TestReadOnly: { kind: "research", readOnly: true } }, ...patch }));

const mk = (provider: string, id: string, extra: object = {}) => ({ provider, id, reasoning: true, contextWindow: 400_000, ...extra });
const luna1 = mk("openai-codex", "gpt-6-luna", { thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" } });
const luna2 = mk("openai-codex-account-2", "gpt-6-luna");
const solThinking = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const sol1 = mk("openai-codex", "gpt-6.1-sol", { thinkingLevelMap: solThinking });
const sol2 = mk("openai-codex-account-2", "gpt-6.1-sol", { thinkingLevelMap: solThinking });
const astra1 = mk("openai-codex", "gpt-6-astra"), astra2 = mk("openai-codex-account-2", "gpt-6-astra");
const levels = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const sonnet = mk("claude-bridge", "claude-sonnet-5-5"), opus = mk("claude-bridge", "claude-opus-5-5", { thinkingLevelMap: levels }), fable = mk("claude-bridge", "claude-fable-5-1");
const muse = mk("opencode-zen-free", "muse-spark-1.3-contributor-free"), haiku = mk("claude-bridge", "claude-haiku-5-5", { contextWindow: 200_000 });
const ALL = [luna1, luna2, sol1, sol2, astra1, astra2, sonnet, opus, fable, muse, haiku];

const decision = (o: object = {}) => JSON.stringify({ level: "routine", kind: "research", model: "luna", thinking: "low", reason: "test", ...o });
const toolCallMsg = { content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }], stopReason: "toolUse" };

function ctx(replies: any[] = [decision()], models: any[] = ALL, opts: { cwd?: string; scoped?: any[]; entries?: any[] } = {}) {
  const queue = [...replies];
  return {
    cwd: opts.cwd ?? AGENT, model: opus, signal: undefined,
    scopedModels: (opts.scoped ?? models).map(model => ({ model })),
    sessionManager: { getEntries: () => opts.entries ?? [] },
    modelRegistry: {
      getAvailable: () => models,
      streamSimple: mock((_m: any, _context: any) => ({ result: async () => {
        const r = queue.length > 1 ? queue.shift() : queue[0];
        return typeof r === "string" ? { content: [{ type: "text", text: r }], stopReason: "stop" } : r;
      } })),
    },
    ui: { setStatus: mock(() => {}), notify: mock(() => {}) },
  };
}

function bus() {
  const e = new EventEmitter();
  return {
    on: (name: string, fn: any) => { e.on(name, fn); return () => { e.off(name, fn); }; },
    emit: (name: string, value: any) => { e.emit(name, value); },
    count: () => e.eventNames().reduce((n, name) => n + e.listenerCount(name), 0),
  };
}

function harness(spawnError?: string) {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const spawns: any[] = [];
  /** Session entries appended by the extension, in the session file format. */
  const entries: any[] = [];
  const events = bus();
  let next = 0;
  events.on("subagents:rpc:spawn", (p: any) => {
    spawns.push(p);
    events.emit("subagents:rpc:spawn:reply:" + p.requestId, spawnError ? { success: false, error: spawnError } : { success: true, data: { id: "spawned-" + ++next } });
  });
  const pi = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
    appendEntry: mock((customType: string, data: any) => {
      entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)), timestamp: new Date().toISOString() });
    }),
    sendMessage: mock(async () => {}),
    events,
  };
  extension(pi as any);
  return { pi, handlers, tools, commands, spawns, events, entries };
}

const records: Record<string, any> = {};
(globalThis as any)[Symbol.for("pi-subagents:manager")] = { getRecord: (id: string) => records[id] };
const flush = () => new Promise(r => setTimeout(r, 30));

beforeEach(() => {
  P._resetForTests();
  (globalThis as any).__testMeters = [];
  writeConfig();
  writeFileSync(join(AGENT, "state.json"), JSON.stringify({ models: {} }));
  rmSync(OUTCOMES, { force: true });
  for (const k of Object.keys(records)) delete records[k];
});
const outcomeLines = () => existsSync(OUTCOMES) ? readFileSync(OUTCOMES, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];

test("config validation: exact routes, known links, legacy keys ignored", () => {
  expect(() => P.parseConfig({})).toThrow("No models configured");
  const base = { models: { a: { routes: ["p/a"], family: "x", profile: "y" } } };
  expect(() => P.parseConfig({ models: { a: { ...base.models.a, fallback: "missing" } } })).toThrow("unknown model");
  expect(() => P.parseConfig({ models: { a: { ...base.models.a, routes: ["sol"] } } })).toThrow("exact provider/id");
  expect(() => P.parseConfig({ ...base, fallbackModel: "nope" })).toThrow("fallbackModel");
  expect(() => P.parseConfig({ ...base, direct: { model: "nope" } })).toThrow("direct.model");
  expect(() => P.parseConfig({ ...base, direct: { model: "a", thinking: "ultra" } })).toThrow("direct.thinking");
  expect(P.parseConfig(base).direct).toEqual({ model: null, thinking: "low" });
  expect(P.parseConfig({ ...base, direct: { model: "p/a" } }).direct).toEqual({ model: "a", thinking: "low" });
  expect(P.parseConfig({ ...base, maxParallel: 1, maxDepth: 0, tiers: {} })).toEqual(P.parseConfig(base));
});

test("October 12 policy: Luna medium classifier, Luna low direct path, Sol → Opus → Astra → Fable escalation", () => {
  const real = P.parseConfig(REAL_CONFIG);
  expect(real.router).toEqual({ model: "openai-codex/gpt-6-luna", thinking: "medium", timeoutMs: 45000 });
  expect(real.direct).toEqual({ model: "luna", thinking: "low" });
  expect(["sol", "opus", "astra", "fable"].map(n => real.models[n].stronger)).toEqual(["opus", "astra", "fable", undefined]);
  expect(["luna", "muse-spark", "haiku", "sonnet"].map(n => real.models[n].stronger)).toEqual(["sol", "sol", "sol", "opus"]);
  expect(real.models.haiku).toMatchObject({ routes: ["claude-bridge/claude-haiku-5-5"], family: "anthropic", fallback: "sol" });
  expect(real.models["glm-flash"]).toBeUndefined(); // Subscription cancelled on October 12.
  expect(Object.values(real.models).flatMap(m => m.routes).some(r => r.startsWith("zai/"))).toBe(false);
});

test("the real configuration loads; its fallbackModel names a configured model", () => {
  const real = P.parseConfig(REAL_CONFIG);
  if (real.fallbackModel !== null) expect(Object.keys(real.models)).toContain(real.fallbackModel);
  const routes = [real.router.model, ...Object.values(real.models).flatMap(m => m.routes)];
  const models = routes.map(k => ({ provider: k.slice(0, k.indexOf("/")), id: k.slice(k.indexOf("/") + 1) }));
  expect(P.configWarnings(real, models).filter(w => !w.startsWith("fallbackModel"))).toEqual([]);
});

test("Sol 6.1 replaces both old Sol routes and is the safe classifier fallback", () => {
  const real = P.parseConfig(REAL_CONFIG);
  expect(real.models.sol.routes).toEqual(["openai-codex/gpt-6.1-sol", "openai-codex-account-2/gpt-6.1-sol"]);
  expect(real.fallbackModel).toBe("sol");
  expect(Object.values(real.models).flatMap(m => m.routes).some(route => route.endsWith("/gpt-6-sol"))).toBe(false);
});

test("fallbackModel accepts a model name or the one model's exact route, and explains anything else", () => {
  const models = {
    flash: { routes: ["v/flash"], family: "v", profile: "y" },
    a: { routes: ["p/shared"], family: "x", profile: "y" },
    b: { routes: ["p/shared", "p/b"], family: "x", profile: "y" },
  };
  expect(P.parseConfig({ models, fallbackModel: "flash" }).fallbackModel).toBe("flash");
  expect(P.parseConfig({ models, fallbackModel: "v/flash" }).fallbackModel).toBe("flash");
  expect(P.parseConfig({ models, fallbackModel: "p/b" }).fallbackModel).toBe("b");
  expect(() => P.parseConfig({ models, fallbackModel: "p/shared" })).toThrow("more than one model (a, b)");
  expect(() => P.parseConfig({ models, fallbackModel: "v/other" })).toThrow("Use a model name from models (flash, a, b)");
  expect(() => P.parseConfig({ models, fallbackModel: "" })).toThrow("fallbackModel must be a model name");
  expect(() => P.parseConfig({ models, fallbackModel: "toString" })).toThrow("unknown model toString");
});

test("routing uses every authenticated model, not only /scoped-models", async () => {
  const h = harness();
  const c = ctx([decision({ model: "sol", kind: "implementation" })], ALL, { scoped: [luna1] });
  const e: any = { toolName: "Agent", toolCallId: "a", input: { prompt: "Edit", routing: { level: "routine" } } };
  expect(await h.handlers.get("tool_call")(e, c)).toBeUndefined();
  expect(e.input.model).toBe("openai-codex/gpt-6.1-sol");
  expect(P.universe(c as any)).toHaveLength(ALL.length);
  // An unauthenticated route is skipped for the next one, with an availability reason.
  expect(P.pickRoute("sol", P.loadConfig(), [sol2]).skipped.join()).toContain("not available");
});

test("a missing route and a stronger loop are reported", () => {
  const cfg = P.parseConfig({ models: {
    a: { routes: ["p/a"], family: "x", profile: "y", stronger: "b" },
    b: { routes: ["p/missing"], family: "x", profile: "y", stronger: "a" },
  } });
  const w = P.configWarnings(cfg, [{ provider: "p", id: "a" }]).join("\n");
  expect(w).toContain("p/missing");
  expect(w).toContain("loops back");
});

test("Claude meters match by display-name word", () => {
  expect(P.meterApplies("Week (Fable)", "claude-fable-5-1")).toBe(true);
  expect(P.meterApplies("Week (Fable)", "claude-opus-5-5")).toBe(false);
  expect(P.meterApplies("Session (5h)", "claude-opus-5-5")).toBe(true);
  expect(P.meterApplies("Week (all models)", "claude-sonnet-5")).toBe(true);
});

test("routes go account 1, account 2, then the fallback model", async () => {
  const cfg = P.loadConfig();
  expect(P.pickRoute("sol", cfg, ALL).model).toBe(sol1);
  await P.markRateLimited(sol1, "HTTP 429 Too Many Requests", cfg);
  const second = P.pickRoute("sol", cfg, ALL);
  expect(second.model).toBe(sol2);
  expect(second.skipped.join()).toContain("rate-limited");
  expect(P.pickRoute("sol", cfg, ALL, new Set(["openai-codex-account-2/gpt-6.1-sol"])).model).toBe(opus);
  expect(await P.markRateLimited(sol2, "context length exceeded", cfg)).toBe(false);
});

test("frontier fallback reaches Sonnet instead of looping between Opus and Astra", () => {
  const cfg = P.loadConfig();
  expect(P.pickRoute("sol", cfg, [sonnet]).model).toBe(sonnet);
  expect(P.pickRoute("sonnet", cfg, [sol2]).model).toBe(sol2);
  // A frontier task must not silently fall back to an auxiliary budget worker.
  for (const name of ["sol", "opus", "astra", "sonnet"]) {
    expect(() => P.pickRoute(name, cfg, [luna1, muse, haiku])).toThrow("No usable route");
  }
});

test("auxiliary fallback can reach Sol and Muse uses the model vendor family", () => {
  const cfg = P.loadConfig();
  expect(P.pickRoute("muse-spark", cfg, [sol1]).model).toBe(sol1);
  expect(P.pickRoute("haiku", cfg, [sol1]).model).toBe(sol1);
  expect(P.candidates(cfg, ALL, { task: "Review OpenAI code", reviewAuthor: "anthropic" })).not.toContain("haiku");
  expect(P.familyOf(muse, cfg)).toBe("meta");
  expect(P.candidates(cfg, ALL, { task: "Review a Meta model's code", reviewAuthor: "meta" })).not.toContain("muse-spark");
});

test("classifier can return max for an exceptional task when the profile warrants it", () => {
  expect(P.ROUTER_PROMPT).toContain('"thinking":"off|minimal|low|medium|high|xhigh|max"');
  expect(P.parseDecision(decision({ model: "sonnet", level: "extreme", thinking: "max" }), ["sonnet"], "implementation"))
    .toMatchObject({ model: "sonnet", thinking: "max", level: "extreme" });
});

test("Claude rate limits are scoped by the fresh meters", async () => {
  const cfg = P.loadConfig();
  (globalThis as any).__testMeters = [{ label: "Week (Fable)", percent: 99, resetMs: Date.now() + 1e7 }];
  await P.markRateLimited(fable, "rate limit reached", cfg);
  expect(P.quotaBlock(fable, cfg)).toContain("Week (Fable)");
  expect(P.quotaBlock(opus, cfg)).toBeUndefined();
  (globalThis as any).__testMeters = [];
  await P.markRateLimited(opus, "429", cfg);
  expect(P.quotaBlock(opus, cfg)).toContain("rate-limited");
  expect(P.quotaBlock(sonnet, cfg)).toBeUndefined();
});

test("a close parent rating skips the scout", async () => {
  const c = ctx([decision({ level: "hard", model: "sol", thinking: "medium" })]);
  const read = { name: "read", description: "r", parameters: {}, execute: mock(async () => ({ content: [] })) };
  const rating = { level: "hard" as const, kind: "implementation" as const };
  const route = await P.classify(c as any, P.loadConfig(), { task: "x", rating }, { scoutTools: [read] });
  expect(route).toMatchObject({ model: "sol", thinking: "medium", scout: "skipped" });
  expect(c.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
});

test("no parent rating runs the scout with read-only tools", async () => {
  const c = ctx([decision({ level: "routine", model: "luna" }), toolCallMsg, decision({ level: "hard", model: "opus", thinking: "high" })]);
  const read = { name: "read", description: "r", parameters: {}, execute: mock(async () => ({ content: [{ type: "text", text: "code" }] })) };
  const route = await P.classify(c as any, P.loadConfig(), { task: "x" }, { scoutTools: [read] });
  expect(route).toMatchObject({ model: "opus", thinking: "high", level: "hard", scout: "ok" });
  expect(read.execute).toHaveBeenCalledTimes(1);
});

test("a 2-level disagreement with an unsure scout keeps the model and raises its effort", async () => {
  const c = ctx([decision({ level: "hard", model: "sol", thinking: "medium" }), "not json"]);
  const read = { name: "read", description: "r", parameters: {}, execute: mock(async () => ({ content: [] })) };
  const route = await P.classify(c as any, P.loadConfig(), { task: "x", rating: { level: "trivial" } }, { scoutTools: [read] });
  expect(route).toMatchObject({ model: "sol", thinking: "high", scout: "unsure" });
  // An unsure scout must not move UI work off Opus, even though Opus now has an escalation link.
  const ui = ctx([decision({ level: "hard", model: "opus", thinking: "medium" }), "not json"]);
  const uiRoute = await P.classify(ui as any, P.loadConfig(), { task: "x", rating: { level: "trivial" } }, { scoutTools: [read] });
  expect(uiRoute).toMatchObject({ model: "opus", thinking: "high", scout: "unsure" });
});

test("a trivial or mechanical parent rating skips the classifier; reviews and pins do not", async () => {
  const h = harness();
  const c = ctx([decision({ model: "sol", thinking: "medium" })]);
  const trivial: any = { toolName: "Agent", toolCallId: "d1", input: { prompt: "Run git status", routing: { level: "trivial", kind: "mechanical" } } };
  expect(await h.handlers.get("tool_call")(trivial, c)).toBeUndefined();
  expect(trivial.input).toMatchObject({ model: "openai-codex/gpt-6-luna", thinking: "low" });
  expect(c.modelRegistry.streamSimple).toHaveBeenCalledTimes(0);
  expect(h.entries.find(e => e.customType === "subtask-routing")?.data).toMatchObject({ by: "parent-rating", level: "trivial", kind: "mechanical", modelName: "luna" });

  const mechanical: any = { toolName: "Agent", toolCallId: "d2", input: { prompt: "Copy the table", routing: { level: "routine", kind: "mechanical" } } };
  await h.handlers.get("tool_call")(mechanical, c);
  expect(mechanical.input.model).toBe("openai-codex/gpt-6-luna");
  const trivialNoKind: any = { toolName: "Agent", toolCallId: "d3", input: { prompt: "List files", routing: { level: "trivial" } } };
  await h.handlers.get("tool_call")(trivialNoKind, c);
  expect(h.entries.filter(e => e.customType === "subtask-routing").pop()?.data).toMatchObject({ by: "parent-rating", kind: "mechanical" });
  expect(c.modelRegistry.streamSimple).toHaveBeenCalledTimes(0);

  // Luna unavailable: the direct path follows Luna's fallback chain, still without a classifier call.
  const noLuna = ctx([decision({ model: "sol" })], ALL.filter(m => !m.id.includes("luna")));
  const spill: any = { toolName: "Agent", toolCallId: "d4", input: { prompt: "Run git status", routing: { level: "trivial", kind: "mechanical" } } };
  await h.handlers.get("tool_call")(spill, noLuna);
  expect(spill.input).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "low" });
  expect(noLuna.modelRegistry.streamSimple).toHaveBeenCalledTimes(0);

  // A review keeps the classifier and the author-family rule; a model pin keeps the classifier for its effort.
  const review: any = { toolName: "Agent", toolCallId: "d5", input: { prompt: "Review the diff", routing: { level: "trivial", kind: "review", reviewing: "openai" } } };
  const rc = ctx([decision({ model: "sonnet", kind: "review", thinking: "medium" })]);
  await h.handlers.get("tool_call")(review, rc);
  expect(review.input.model).toBe("claude-bridge/claude-sonnet-5-5");
  expect(rc.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
  const pinned: any = { toolName: "Agent", toolCallId: "d6", input: { prompt: "Run git status", model: "sol", routing: { level: "trivial", kind: "mechanical" } } };
  const pc = ctx([decision({ model: "sol", thinking: "low" })]);
  await h.handlers.get("tool_call")(pinned, pc);
  expect(pinned.input.model).toBe("openai-codex/gpt-6.1-sol");
  expect(pc.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);

  // Direct path off: the classifier decides.
  writeConfig({ direct: { model: null } });
  const off = ctx([decision({ model: "luna", thinking: "low" })]);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "d7", input: { prompt: "Run git status", routing: { level: "trivial", kind: "mechanical" } } }, off);
  expect(off.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
});

test("the review rule removes the author's family from the candidates", () => {
  const cfg = P.loadConfig();
  const names = P.candidates(cfg, ALL, { task: "x", reviewAuthor: "openai" });
  expect(names).not.toContain("sol");
  expect(names).toContain("opus");
  expect(P.describeTask(cfg, ALL, names, { task: "x", reviewAuthor: "openai" })).toContain("written by the openai family");
});

test("review fallback skips the author's family throughout the chain", () => {
  const cfg = P.loadConfig();
  expect(P.pickRoute("sonnet", cfg, ALL, new Set([P.key(sonnet)]), "openai").model).toBe(opus);
  expect(P.pickRoute("opus", cfg, ALL, new Set(), "anthropic").model).toBe(astra1);
  expect(() => P.pickRoute("sonnet", cfg, [sol1, astra1], new Set(), "openai")).toThrow("No usable route");
  expect(P.candidates(cfg, [sol1, astra1], { task: "review", reviewAuthor: "openai" })).toEqual([]);
  expect(() => P.pickRoute("removed-model", cfg, ALL, new Set(), "openai")).toThrow("not configured");
});

test("classifier failure still selects an independent reviewer", async () => {
  const h = harness();
  const e: any = { toolName: "Agent", toolCallId: "review-fallback", input: { prompt: "Review code", routing: { level: "hard", kind: "review", reviewing: "openai" } } };
  expect(await h.handlers.get("tool_call")(e, ctx(["garbage"]))).toBeUndefined();
  expect(e.input.model).toBe(P.key(opus));
});

test("automatic reviews refuse same-family-only availability but explicit pins remain authoritative", async () => {
  const h = harness();
  const blocked = await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "review-unavailable", input: { prompt: "Review OpenAI code",
    routing: { level: "routine", kind: "review", reviewing: "openai" } } }, ctx([], [luna1, sol1, astra1]));
  expect(blocked.block).toBe(true);
  expect(blocked.reason).toContain("same family as review author");
  const pinned: any = { toolName: "Agent", toolCallId: "review-pinned", input: { prompt: "Review OpenAI code", model: "sol", thinking: "high",
    routing: { level: "routine", kind: "review", reviewing: "openai" } } };
  expect(await h.handlers.get("tool_call")(pinned, ctx([], [sol1]))).toBeUndefined();
  expect(pinned.input.model).toBe(P.key(sol1));
});

test("a review recognized by the classifier also enforces family exclusion", async () => {
  const h = harness();
  // With no parent kind, the initial candidate list is unrestricted. The final pick must still enforce review independence.
  const e: any = { toolName: "Agent", toolCallId: "inferred-review", input: { prompt: "Review this code", routing: { level: "routine" } } };
  expect(await h.handlers.get("tool_call")(e, ctx([decision({ model: "opus", kind: "review" })]))).toBeUndefined();
  expect(e.input.model).toBe(P.key(astra1)); // The parent is Opus/Anthropic.
});

test("review retries and escalations retain the author family, including after reload", async () => {
  const h = harness(), c = ctx([decision({ model: "sonnet", kind: "review", thinking: "high" })]);
  h.handlers.get("session_start")({}, c);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "review-retry", input: { prompt: "Review code", subagent_type: "TestReadOnly",
    routing: { level: "routine", kind: "review", reviewing: "openai" } } }, c);
  records.r1 = { id: "r1", toolCallId: "review-retry", session: { model: sonnet, messages: [] }, toolUses: 0 };
  h.events.emit("subagents:failed", { id: "r1", error: "429 Too Many Requests", toolUses: 0 });
  await flush();
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].options.model).toBe(P.key(opus));

  const original = harness(), reviewer = ctx([decision({ model: "sol", kind: "review", thinking: "medium" })]);
  original.handlers.get("session_start")({}, reviewer);
  await original.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "review-escalate", input: { prompt: "Review Claude code", routing: { level: "routine", kind: "review", reviewing: "anthropic" } } }, reviewer);
  original.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "review-escalate", details: { agentId: "r2" } });
  // Simulate a pre-upgrade launch record: the author was stored on the routing entry only.
  const saved = structuredClone(original.entries);
  delete saved.find(e => e.customType === "subtask-routing").data.launch.reviewAuthor;
  const reloaded = harness(), restored = ctx([], ALL, { entries: saved });
  reloaded.handlers.get("session_start")({}, restored);
  records.r2 = { id: "r2", status: "completed", result: "Needs another pass" };
  await reloaded.commands.get("subtask-router").handler("escalate r2", restored);
  expect(reloaded.spawns).toHaveLength(1);
  expect(reloaded.spawns[0].options.model).toBe(P.key(astra1));
});

test("legacy review spawn records without an author refuse automatic recovery", async () => {
  const h = harness();
  const launch = { prompt: "Review code", description: "Legacy review", type: "TestReadOnly", name: "sol", route: P.key(sol1),
    kind: "review", level: "hard", thinking: "medium", readOnly: true, retries: 0 };
  const c = ctx([], ALL, { entries: [{ type: "custom", customType: "subtask-routing-spawn", data: { agentId: "legacy-review", launch } }] });
  h.handlers.get("session_start")({}, c);
  records["legacy-review"] = { id: "legacy-review", status: "completed", session: { model: sol1, messages: [] }, toolUses: 0 };
  await h.commands.get("subtask-router").handler("escalate legacy-review", c);
  expect(h.spawns).toHaveLength(0);
  expect(c.ui.notify.mock.calls.some(call => String(call[0]).includes("no saved author family"))).toBe(true);
  h.events.emit("subagents:failed", { id: "legacy-review", error: "429 Too Many Requests", toolUses: 0 });
  await flush();
  expect(h.spawns).toHaveLength(0);
  expect(h.pi.sendMessage.mock.calls.some(call => String(call[0].content).includes("no saved author family"))).toBe(true);
});

test("Agent calls get a route, effort, and lose the router-only field", async () => {
  const h = harness();
  expect([...h.tools.keys()]).toEqual(["report_subagent_outcome", "stop_subagent"]);
  const e: any = { toolName: "Agent", toolCallId: "a", input: { prompt: "Audit packages", subagent_type: "TestReadOnly",
    routing: { level: "routine", kind: "research", edits: false, why: "inventory" } } };
  expect(await h.handlers.get("tool_call")(e, ctx())).toBeUndefined();
  expect(e.input).toMatchObject({ model: "openai-codex/gpt-6-luna", thinking: "low" });
  expect(e.input.routing).toBeUndefined();
  const result = h.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "a", details: { agentId: "backend-id" } });
  expect(result.details.agentId).toBe("backend-id");
  expect(result.details.routing).toMatchObject({ modelName: "luna", effectiveThinking: "low", rated: true });
});

test("classifier failure uses fallbackModel, or blocks when it is unset", async () => {
  writeConfig({ fallbackModel: null });
  const h = harness();
  const blocked = await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "a", input: { prompt: "x" } }, ctx(["garbage"]));
  expect(blocked.block).toBe(true);
  expect(blocked.reason).toContain("fallbackModel");
  writeConfig({ fallbackModel: "sol" });
  const e: any = { toolName: "Agent", toolCallId: "b", input: { prompt: "x", routing: { level: "hard" } } };
  await h.handlers.get("tool_call")(e, ctx(["garbage"]));
  expect(e.input).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "medium" });
});

test("a pinned model name and effort skip classification; resumes are untouched", async () => {
  const h = harness(), c = ctx();
  const e: any = { toolName: "Agent", toolCallId: "a", input: { prompt: "x", model: "opus", thinking: "high" } };
  await h.handlers.get("tool_call")(e, c);
  expect(e.input).toMatchObject({ model: "claude-bridge/claude-opus-5-5", thinking: "high" });
  expect(c.modelRegistry.streamSimple).not.toHaveBeenCalled();
  const input = { prompt: "Continue", resume: "abc" };
  await h.handlers.get("tool_call")({ toolName: "Agent", input }, c);
  expect(input).toEqual({ prompt: "Continue", resume: "abc" });
});

test("unsupported effort is clamped to the selected model", async () => {
  const h = harness();
  const e: any = { toolName: "Agent", toolCallId: "a", input: { prompt: "x", model: "openai-codex/gpt-6-luna", thinking: "minimal" } };
  await h.handlers.get("tool_call")(e, ctx());
  expect(e.input.thinking).toBe("low");
});

test("Sol 6.1 clamps unsupported minimal effort to low", async () => {
  const h = harness();
  const e: any = { toolName: "Agent", toolCallId: "sol-effort", input: { prompt: "x", model: "sol", thinking: "minimal" } };
  await h.handlers.get("tool_call")(e, ctx());
  expect(e.input.model).toBe("openai-codex/gpt-6.1-sol");
  expect(e.input.thinking).toBe("low");
});

test("a rate-limited read-only agent restarts on the next account with its findings", async () => {
  const h = harness(), c = ctx();
  h.handlers.get("session_start")({}, c);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t1", input: { prompt: "Trace refs", subagent_type: "TestReadOnly",
    routing: { level: "routine" } } }, c);
  records.a1 = { id: "a1", toolCallId: "t1", toolUses: 3, result: "partial findings", session: { model: luna1, messages: [] } };
  h.events.emit("subagents:failed", { id: "a1", error: "429 Too Many Requests", toolUses: 3 });
  await flush();
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0].options.model).toBe("openai-codex-account-2/gpt-6-luna");
  expect(h.spawns[0].prompt).toContain("partial findings");
  expect(h.pi.sendMessage).toHaveBeenCalled();
});

test("a rate-limited editing agent that used tools is not restarted", async () => {
  const h = harness(), c = ctx([decision({ model: "sol", kind: "implementation" })]);
  h.handlers.get("session_start")({}, c);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t1", input: { prompt: "Edit", routing: { level: "routine" } } }, c);
  records.a1 = { id: "a1", toolCallId: "t1", toolUses: 2, session: { model: sol1, messages: [] } };
  h.events.emit("subagents:failed", { id: "a1", error: "rate limit", toolUses: 2 });
  await flush();
  expect(h.spawns).toHaveLength(0);
  records.a2 = { id: "a2", toolCallId: "t1", toolUses: 0, session: { model: sol1, messages: [] } };
  h.events.emit("subagents:failed", { id: "a2", error: "rate limit", toolUses: 0 });
  await flush();
  expect(h.spawns[0].options.model).toBe("openai-codex-account-2/gpt-6.1-sol");
});

test("escalate starts a new agent on the stronger model and counts it", async () => {
  const h = harness(), c = ctx([decision({ model: "sol", kind: "debugging", thinking: "medium" })]);
  h.handlers.get("session_start")({}, c);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t1", input: { prompt: "Fix it", description: "Fix",
    routing: { level: "routine" } } }, c);
  h.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "t1", details: { agentId: "a1" } });
  records.a1 = { id: "a1", toolCallId: "t1", status: "completed", result: "weak answer", session: { model: sol1, messages: [] } };
  await h.commands.get("subtask-router").handler("escalate a1", c);
  expect(h.spawns[0].options).toMatchObject({ model: "claude-bridge/claude-opus-5-5", thinkingLevel: "high" });
  expect(h.spawns[0].prompt).toContain("judged insufficient");
  expect(h.spawns[0].prompt).toContain("weak answer");
  // Escalation is also an outcome: the escalated agent is recorded as insufficient once.
  expect(P.loadStats().models.sol.debugging).toEqual({ routed: 1, escalated: 1, ok: 0, insufficient: 1, failed: 0 });
  expect(P.historyLine("sol")).toBe("debugging 1 routed, 1 insufficient, 1 escalated");
  expect(outcomeLines()).toEqual([expect.objectContaining({ agentId: "a1", outcome: "insufficient", by: "user", model: "sol", thinking: "medium", kind: "debugging" })]);
  expect(outcomeLines()[0].prompt).toBeUndefined();
  // The escalation attempt counts as routed for Opus, so its verdict can reach the classifier history.
  expect(P.loadStats().models.opus.debugging).toMatchObject({ routed: 1 });
  expect((await h.tools.get("report_subagent_outcome").execute("x", { agent_id: "spawned-1", outcome: "ok" })).details.recorded).toBe(true);
  expect(P.historyLine("opus")).toBe("debugging 1 routed, 1 ok");
});

test("Opus escalates to Astra as a second opinion; Fable has no link and raises its effort", async () => {
  const h = harness(), c = ctx([decision({ model: "opus", kind: "debugging", thinking: "high", level: "hard" })]);
  h.handlers.get("session_start")({}, c);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t1", input: { prompt: "Fix it", routing: { level: "hard" } } }, c);
  h.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "t1", details: { agentId: "a1" } });
  records.a1 = { id: "a1", toolCallId: "t1", status: "completed", result: "weak", session: { model: opus, messages: [] } };
  await h.commands.get("subtask-router").handler("escalate a1", c);
  expect(h.spawns[0].options.model).toBe("openai-codex/gpt-6-astra");

  const f = ctx([decision({ model: "fable", kind: "debugging", thinking: "medium", level: "hard" })]);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t2", input: { prompt: "Fix it", routing: { level: "hard" } } }, f);
  h.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "t2", details: { agentId: "a2" } });
  records.a2 = { id: "a2", toolCallId: "t2", status: "completed", result: "weak", session: { model: fable, messages: [] } };
  await h.commands.get("subtask-router").handler("escalate a2", f);
  expect(h.spawns[1].options).toMatchObject({ model: "claude-bridge/claude-fable-5-1", thinkingLevel: "high" });
});

test("outcomes: the parent tool and the user command record one verdict per routed agent", async () => {
  const h = harness(), c = ctx([decision({ model: "sol", kind: "implementation", thinking: "medium", level: "routine" })]);
  h.handlers.get("session_start")({}, c);
  const tool = h.tools.get("report_subagent_outcome");
  expect((await tool.execute("x", { agent_id: "nope", outcome: "ok" })).details.recorded).toBe(false);

  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t1", input: { prompt: "Add flag", routing: { level: "routine", kind: "implementation" } } }, c);
  h.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "t1", details: { agentId: "a1" } });
  const first = await tool.execute("x", { agent_id: "a1", outcome: "ok" });
  expect(first.details.recorded).toBe(true);
  expect(first.content[0].text).toContain("Recorded ok for agent a1");
  const again = await tool.execute("x", { agent_id: "a1", outcome: "insufficient", note: "changed my mind" });
  expect(again.details.recorded).toBe(false);
  expect(again.content[0].text).toContain("already has the outcome ok");
  expect(P.loadStats().models.sol.implementation).toEqual({ routed: 1, escalated: 0, ok: 1, insufficient: 0, failed: 0 });
  expect(P.historyLine("sol")).toBe("implementation 1 routed, 1 ok");

  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t2", input: { prompt: "Add flag", routing: { level: "routine", kind: "implementation" } } }, c);
  h.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "t2", details: { agentId: "a2" } });
  await h.commands.get("subtask-router").handler("outcome a2 insufficient missed the tests", c);
  expect(c.ui.notify.mock.calls.pop()?.[0]).toContain("Recorded insufficient for agent a2");
  await h.commands.get("subtask-router").handler("outcome a2 maybe", c);
  expect(c.ui.notify.mock.calls.pop()?.[0]).toContain("Usage:");
  expect(outcomeLines().map(l => [l.agentId, l.outcome, l.by, l.note])).toEqual([["a1", "ok", "parent", undefined], ["a2", "insufficient", "user", "missed the tests"]]);
  expect(h.entries.filter(e => e.customType === "subtask-routing-outcome")).toHaveLength(2);

  // An escalation after a report does not record a second verdict.
  records.a2 = { id: "a2", toolCallId: "t2", status: "completed", result: "weak", session: { model: sol1, messages: [] } };
  await h.commands.get("subtask-router").handler("escalate a2", c);
  expect(P.loadStats().models.sol.implementation).toEqual({ routed: 2, escalated: 1, ok: 1, insufficient: 1, failed: 0 });

  // After /reload the verdicts are restored from the session, so a second report is still refused.
  const reloaded = harness(), restored = ctx([], ALL, { entries: structuredClone(h.entries) });
  reloaded.handlers.get("session_start")({}, restored);
  const late = await reloaded.tools.get("report_subagent_outcome").execute("x", { agent_id: "a1", outcome: "insufficient" });
  expect(late.details.recorded).toBe(false);
});

test("outcomes: a crash is recorded as failed; rate limits and user stops are not outcomes", async () => {
  const h = harness(), c = ctx([decision({ model: "sol", kind: "implementation", thinking: "medium", level: "routine" })]);
  h.handlers.get("session_start")({}, c);
  for (const id of ["t1", "t2", "t3", "t4", "t5"]) {
    await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: id, input: { prompt: "Add flag", routing: { level: "routine", kind: "implementation" } } }, c);
  }
  for (const [i, id] of ["a1", "a2", "a3", "a4", "a5"].entries()) records[id] = { id, toolCallId: "t" + (i + 1), toolUses: 4, session: { model: sol1, messages: [] } };
  // The backend emits subagents:failed for status error, stopped, and aborted. Only error is a verdict.
  h.events.emit("subagents:failed", { id: "a1", status: "error", error: "TypeError: boom", toolUses: 4 });
  h.events.emit("subagents:failed", { id: "a2", status: "error", error: "429 Too Many Requests", toolUses: 4 });
  h.events.emit("subagents:failed", { id: "a3", status: "stopped", error: "", toolUses: 4 });
  h.events.emit("subagents:failed", { id: "a4", status: "aborted", error: "Operation aborted", toolUses: 4 });
  h.events.emit("subagents:failed", { id: "a5", status: "error", error: "connection aborted by peer", toolUses: 4 });
  await flush();
  expect(outcomeLines().map(l => [l.agentId, l.outcome, l.by])).toEqual([["a1", "failed", "router"], ["a5", "failed", "router"]]);
  expect(outcomeLines()[0].note).toContain("boom");
  expect(P.loadStats().models.sol.implementation).toMatchObject({ routed: 5, failed: 2 });
  expect(h.spawns).toHaveLength(0); // The rate-limited agent had edited, so it was not restarted.
});

test("old counters without outcome fields still load and count", () => {
  writeFileSync(join(AGENT, "state.json"), JSON.stringify({ models: { sol: { research: { routed: 4, escalated: 1 } } } }));
  P.bumpStats("sol", "research", "ok");
  expect(P.loadStats().models.sol.research).toEqual({ routed: 4, escalated: 1, ok: 1, insufficient: 0, failed: 0 });
  expect(P.historyLine("sol")).toBe("research 4 routed, 1 ok, 1 escalated");
});

test("files edited by one family send their review to the other family", async () => {
  const h = harness(), c = ctx([decision({ model: "sol", kind: "implementation" })]);
  h.handlers.get("session_start")({}, c);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t1", input: { prompt: "Write relay", routing: { level: "hard" } } }, c);
  records.a1 = { id: "a1", toolCallId: "t1", session: { model: sol1, messages: [
    { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "src/relay.go" } }] }] } };
  h.events.emit("subagents:completed", { id: "a1" });
  const r = ctx([decision({ model: "opus", kind: "review", level: "hard", thinking: "medium" })]);
  const e: any = { toolName: "Agent", toolCallId: "t2", input: { prompt: "Review src/relay.go for bugs", routing: { level: "hard", kind: "review" } } };
  await h.handlers.get("tool_call")(e, r);
  const sent = (r.modelRegistry.streamSimple.mock.calls[0] as any[])[1].messages[0].content;
  expect(sent).toContain("written by the openai family");
  expect(sent).not.toContain("- sol (");
  expect(e.input.model).toBe("claude-bridge/claude-opus-5-5");
});

test("native child sessions register no parent controls or hooks", async () => {
  await runInChildSessionContext(async () => {
    const h = harness();
    expect(h.handlers.size).toBe(0);
    expect(h.tools.size).toBe(0);
  });
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

// ---------------------------------------------------------------- manual reviewer

const put = (dir: string, p: string, c: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };

/** A committed git repository; tests then make dirty and untracked changes on top. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "review-repo-"));
  for (const [p, c] of Object.entries(files)) put(dir, p, c);
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });
  g("init", "-q"); g("add", "-A"); g("commit", "-qm", "init");
  return dir;
}

let callSeq = 0;
/** One tool call of a subagent and its result, as the backend's session stores them. */
function call(name: string, args: object, result: { details?: any; isError?: boolean; text?: string } = {}) {
  const id = "call-" + ++callSeq;
  const at = Date.now();
  return [
    { role: "assistant", timestamp: at, content: [{ type: "toolCall", id, name, arguments: args }] },
    { role: "toolResult", toolCallId: id, toolName: name, isError: !!result.isError, timestamp: at, details: result.details,
      content: [{ type: "text", text: result.text ?? "ok" }] },
  ];
}
/** The agent edits a file on disk; the transcript keeps the edit tool's exact patch. */
function edit(dir: string, p: string, after: string) {
  const before = readFileSync(join(dir, p), "utf8");
  writeFileSync(join(dir, p), after);
  return call("edit", { path: p, edits: [{ oldText: before, newText: after }] }, { details: { patch: createTwoFilesPatch(p, p, before, after) } });
}
function write(dir: string, p: string, content: string) { put(dir, p, content); return call("write", { path: p, content }); }

const reviewerCtx = (dir: string, models: any[] = ALL, entries?: any[]) =>
  ctx([decision({ model: "sol", kind: "implementation" })], models, { cwd: dir, entries });

/** Parallel Agent calls of one assistant message. */
async function launch(h: any, c: any, ...calls: Array<[string, string]>) {
  await Promise.all(calls.map(([toolCallId, prompt]) => h.handlers.get("tool_call")({ toolName: "Agent", toolCallId,
    input: { prompt, description: prompt, routing: { level: "routine", kind: "implementation" } } }, c)));
}
/** The Agent call returns; a finished agent also emits its completion event. */
function finish(h: any, toolCallId: string, agentId: string, messages: any[], status = "completed") {
  records[agentId] = { id: agentId, status, toolCallId, toolUses: 1, session: { model: sol1, messages } };
  h.handlers.get("tool_result")({ toolName: "Agent", toolCallId, details: { agentId } });
  if (status !== "running") h.events.emit("subagents:completed", { id: agentId });
}
async function reviewCmd(h: any, c: any, focus = ""): Promise<[string, string]> {
  await h.commands.get("subtask-router").handler(("review " + focus).trim(), c);
  return c.ui.notify.mock.calls.at(-1) as [string, string];
}
/** One finished batch in which agent a1 appended "two" to a.ts. */
async function editBatch(h: any, c: any, dir: string) {
  h.handlers.get("session_start")({}, c);
  h.handlers.get("agent_start")({}, c);
  await launch(h, c, ["t1", "Append two to a.ts"]);
  finish(h, "t1", "a1", edit(dir, "a.ts", readFileSync(join(dir, "a.ts"), "utf8") + "two\n"));
  h.handlers.get("agent_end")({}, c);
}

test("review: parallel agents form one batch; earlier dirty work and user edits are excluded; a later turn keeps the batch", async () => {
  const dir = repo({ "a.ts": "one\n", "b.ts": "two\n", "c.ts": "three\n" });
  put(dir, "a.ts", "one\ndirty\n"); // Uncommitted before the batch.
  put(dir, "notes.txt", "untracked before\n");
  const h = harness(), c = reviewerCtx(dir);
  h.handlers.get("session_start")({}, c);
  h.handlers.get("agent_start")({}, c);
  await launch(h, c, ["t1", "Add an agent line to a.ts"], ["t2", "Rewrite b.ts"]);
  const a1 = [...edit(dir, "a.ts", "one\ndirty\nagent\n"), ...call("read", { path: "a.ts" })];
  const a2 = write(dir, "b.ts", "two\nsecond agent\n");
  put(dir, "c.ts", "three\nuser line\n"); // The user edits another file during the batch.
  finish(h, "t1", "a1", a1);
  finish(h, "t2", "a2", a2);
  h.handlers.get("agent_end")({}, c);
  h.handlers.get("agent_start")({}, c); // A follow-up turn without delegation keeps the batch.
  h.handlers.get("agent_end")({}, c);
  const classifierCalls = c.modelRegistry.streamSimple.mock.calls.length;

  const [text, level] = await reviewCmd(h, c, "focus on a.ts");
  expect(level).toBe("info");
  expect(text).toContain("complete coverage · 2 verified");
  expect(h.spawns).toHaveLength(1);
  const s = h.spawns[0];
  expect(s.type).toBe("subtask-reviewer");
  expect(s.options.model).toBe(astra1); // The exact Model object: the backend never resolves a string.
  expect(s.options).toMatchObject({ thinkingLevel: "high", isolated: true, isBackground: true });
  expect(c.modelRegistry.streamSimple.mock.calls.length).toBe(classifierCalls); // No classifier call.
  expect(s.prompt).toContain("COMPLETE:");
  expect(s.prompt).toContain("+agent");
  expect(s.prompt).not.toContain("+dirty");
  expect(s.prompt).toContain("+second agent");
  expect(s.prompt).toContain("- c.ts");
  expect(s.prompt).not.toContain("user line");
  expect(s.prompt).not.toContain("untracked before");
  expect(s.prompt).toContain("focus on a.ts");
  expect(s.prompt).toContain("Add an agent line to a.ts");
  expect(h.entries.filter(e => e.customType === "subtask-review-batch")).toHaveLength(1);
  expect(h.entries.find(e => e.customType === "subtask-review-run")?.data).toMatchObject({ agentId: "spawned-1", model: "openai-codex/gpt-6-astra" });

  // The reviewer's own completion does not replace the batch, and a second review of it is refused while one runs.
  records["spawned-1"] = { id: "spawned-1", status: "running", session: { model: astra1, messages: [] } };
  expect((await reviewCmd(h, c))[0]).toContain("already reviewing");
  records["spawned-1"].status = "completed";
  h.events.emit("subagents:completed", { id: "spawned-1" });
  await reviewCmd(h, c);
  expect(h.spawns).toHaveLength(2);
  expect(h.spawns[1].prompt).toContain("+second agent");
});

test("review refuses an unfinished batch: open parent turn, running agent", async () => {
  const dir = repo({ "a.ts": "one\n" });
  const h = harness(), c = reviewerCtx(dir);
  h.handlers.get("session_start")({}, c);
  expect((await reviewCmd(h, c))[0]).toContain("no delegation batch");
  h.handlers.get("agent_start")({}, c);
  await launch(h, c, ["t1", "Edit a.ts"]);
  expect((await reviewCmd(h, c))[0]).toContain("parent turn that started it is still running");
  finish(h, "t1", "a1", edit(dir, "a.ts", "one\ntwo\n"), "running");
  h.handlers.get("agent_end")({}, c);
  expect((await reviewCmd(h, c))[0]).toContain("agents still running: a1");
  records.a1.status = "completed";
  h.events.emit("subagents:completed", { id: "a1" });
  expect((await reviewCmd(h, c))[0]).toContain("Reviewer spawned-1 started");
  expect(h.spawns).toHaveLength(1);
});

test("a resume in a later turn is a new batch that attributes only the resumed run", async () => {
  const dir = repo({ "a.ts": "one\n" });
  const h = harness(), c = reviewerCtx(dir);
  await editBatch(h, c, dir);
  const firstRun = records.a1.session.messages;
  h.handlers.get("agent_start")({}, c);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t5", input: { prompt: "Also add three", resume: "a1" } }, c);
  records.a1.session.messages = [...firstRun, ...edit(dir, "a.ts", "one\ntwo\nthree\n")];
  h.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "t5", details: { agentId: "a1" } });
  h.events.emit("subagents:completed", { id: "a1" });
  h.handlers.get("agent_end")({}, c);
  await reviewCmd(h, c);
  const p = h.spawns[0].prompt;
  expect(p).toContain("+three");
  expect(p).not.toContain("+two");
  expect(p).toContain("Also add three");
  expect(h.entries.filter(e => e.customType === "subtask-review-batch")).toHaveLength(2);
});

test("a blocked Agent call leaves no batch; the earlier batch stays the latest", async () => {
  const dir = repo({ "a.ts": "one\n" });
  const h = harness(), c = reviewerCtx(dir);
  await editBatch(h, c, dir);
  writeConfig({ fallbackModel: null });
  h.handlers.get("agent_start")({}, c);
  const blocked = await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t9", input: { prompt: "x" } }, ctx(["garbage"], ALL, { cwd: dir }));
  expect(blocked.block).toBe(true);
  h.handlers.get("agent_end")({}, c);
  await reviewCmd(h, c);
  expect(h.spawns[0].prompt).toContain("+two");
});

test("review reports a shared file and shell-era changes instead of attributing them", async () => {
  const dir = repo({ "a.ts": "one\ntwo\nthree\n", "d.ts": "dee\n" });
  const h = harness(), c = reviewerCtx(dir);
  h.handlers.get("session_start")({}, c);
  h.handlers.get("agent_start")({}, c);
  await launch(h, c, ["t1", "Edit a.ts"]);
  const msgs = [...edit(dir, "a.ts", "one\ntwo\nthree\nagent\n"), ...call("bash", { command: "npm test" })];
  put(dir, "a.ts", "user first\none\ntwo\nthree\nagent\n"); // The user edits the same file.
  put(dir, "d.ts", "dee\nsomeone\n"); // The shell or the user: no way to tell.
  finish(h, "t1", "a1", msgs);
  h.handlers.get("agent_end")({}, c);
  const [text, level] = await reviewCmd(h, c);
  expect(level).toBe("warning");
  expect(text).toContain("incomplete coverage");
  const p = h.spawns[0].prompt;
  expect(p).toContain("INCOMPLETE:");
  expect(p).toContain("### a.ts (operations only: the file also contains changes");
  expect(p).toContain("+agent");
  expect(p).not.toContain("user first");
  expect(p).toContain("- d.ts: changed while agents ran tools whose writes cannot be traced (bash ×1)");
  expect(p).not.toContain("someone");
});

test("the reviewer runs only on openai-codex/gpt-6-astra: no other account, no fallback, no retry", async () => {
  const dir = repo({ "a.ts": "one\n" });
  // Only the second account is authenticated.
  let h = harness(), c = reviewerCtx(dir, ALL.filter(m => m !== astra1));
  await editBatch(h, c, dir);
  let [text, level] = await reviewCmd(h, c);
  expect(level).toBe("error");
  expect(text).toContain("openai-codex/gpt-6-astra is not available");
  expect(text).toContain("does not use another model");
  expect(h.spawns).toHaveLength(0);
  // A known rate limit refuses; it does not switch accounts.
  await P.markRateLimited(astra1, "429 Too Many Requests", P.loadConfig());
  [text, level] = await reviewCmd(h, reviewerCtx(dir));
  expect(text).toContain("is blocked: rate-limited");
  expect(h.spawns).toHaveLength(0);
  P._resetForTests();
  // The backend refuses the start: one attempt, then an error.
  h = harness("Model not in scope");
  c = reviewerCtx(dir);
  await editBatch(h, c, dir);
  [text, level] = await reviewCmd(h, c);
  expect(level).toBe("error");
  expect(text).toContain("did not start: Model not in scope");
  expect(h.spawns).toHaveLength(1);
  // A rate-limited reviewer run is not restarted on another route.
  h = harness();
  c = reviewerCtx(dir);
  await editBatch(h, c, dir);
  await reviewCmd(h, c);
  records["spawned-1"] = { id: "spawned-1", status: "error", toolUses: 0, session: { model: astra1, messages: [] } };
  h.events.emit("subagents:failed", { id: "spawned-1", error: "429 rate limit", toolUses: 0 });
  await flush();
  expect(h.spawns).toHaveLength(1);
});

test("Agent calls cannot start or resume the reviewer", async () => {
  const h = harness(), c = ctx();
  const r = await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "x", input: { prompt: "review", subagent_type: "Subtask-Reviewer" } }, c);
  expect(r).toMatchObject({ block: true });
  expect(r.reason).toContain("manual-only");
  expect(c.modelRegistry.streamSimple).not.toHaveBeenCalled();
  h.handlers.get("session_start")({}, ctx([], ALL, { entries: [{ type: "custom", customType: "subtask-review-run", data: { agentId: "rev1", batchId: "b1-000000" } }] }));
  const r2 = await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "y", input: { prompt: "again", resume: "rev1" } }, c);
  expect(r2).toMatchObject({ block: true });
});

test("review after /reload: a sealed batch survives; unfinished and pre-tracking delegations are refused", async () => {
  const dir = repo({ "a.ts": "one\n" });
  let h = harness(), c = reviewerCtx(dir);
  await editBatch(h, c, dir);
  const sealed = [...h.entries];
  delete records.a1; // The backend forgets its records on reload.
  let h2 = harness(), c2 = reviewerCtx(dir, ALL, sealed);
  h2.handlers.get("session_start")({}, c2);
  expect((await reviewCmd(h2, c2))[0]).toContain("Reviewer spawned-1 started");
  expect(h2.spawns[0].prompt).toContain("+two");

  // An agent that had not finished at the reload: its transcript is gone.
  h = harness();
  c = reviewerCtx(dir);
  h.handlers.get("session_start")({}, c);
  h.handlers.get("agent_start")({}, c);
  await launch(h, c, ["t2", "Edit a.ts again"]);
  finish(h, "t2", "a2", edit(dir, "a.ts", "one\ntwo\nthree\n"), "running");
  h.handlers.get("agent_end")({}, c);
  const unfinished = [...h.entries];
  delete records.a2;
  h2 = harness();
  c2 = reviewerCtx(dir, ALL, unfinished);
  h2.handlers.get("session_start")({}, c2);
  expect((await reviewCmd(h2, c2))[0]).toContain("evidence is lost: no transcript for agent(s) a2");
  expect(h2.spawns).toHaveLength(0);

  // A delegation recorded before batch tracking existed has no baseline.
  const historic = [...sealed, { type: "custom", customType: "subtask-routing", data: { toolCallId: "old", launch: {} },
    timestamp: new Date(Date.now() + 1000).toISOString() }];
  h2 = harness();
  c2 = reviewerCtx(dir, ALL, historic);
  h2.handlers.get("session_start")({}, c2);
  expect((await reviewCmd(h2, c2))[0]).toContain("no baseline snapshot");
  expect(h2.spawns).toHaveLength(0);
});

test("a rate-limit restart joins its batch, and the batch waits for it", async () => {
  const dir = repo({ "a.ts": "one\n" });
  const h = harness(), c = ctx([decision()], ALL, { cwd: dir });
  h.handlers.get("session_start")({}, c);
  h.handlers.get("agent_start")({}, c);
  await h.handlers.get("tool_call")({ toolName: "Agent", toolCallId: "t1", input: { prompt: "Trace refs", subagent_type: "TestReadOnly",
    routing: { level: "routine" } } }, c);
  records.a1 = { id: "a1", toolCallId: "t1", status: "running", toolUses: 0, session: { model: luna1, messages: [] } };
  h.handlers.get("tool_result")({ toolName: "Agent", toolCallId: "t1", details: { agentId: "a1" } });
  h.handlers.get("agent_end")({}, c);
  records.a1.status = "error";
  records["spawned-1"] = { id: "spawned-1", status: "running", session: { model: luna2, messages: [] } };
  h.events.emit("subagents:failed", { id: "a1", error: "429 Too Many Requests", toolUses: 0 });
  expect((await reviewCmd(h, c))[0]).toContain("router restarts have not returned yet");
  await flush();
  expect(h.spawns).toHaveLength(1);
  expect((await reviewCmd(h, c))[0]).toContain("agents still running: spawned-1");
  records["spawned-1"].status = "completed";
  h.events.emit("subagents:completed", { id: "spawned-1" });
  // The 429 put openai-codex on cooldown: the reviewer refuses rather than use account 2.
  expect((await reviewCmd(h, c))[0]).toContain("openai-codex/gpt-6-astra is blocked: rate-limited");
  P._resetForTests();
  expect((await reviewCmd(h, c))[0]).toContain("has no attributed file changes");
  expect(h.spawns).toHaveLength(1);
});

