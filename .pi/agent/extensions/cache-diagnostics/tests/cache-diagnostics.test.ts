// Offline tests for ../index.ts. A fake Pi API drives the real hook handlers with
// synthetic payloads shaped like pi-ai 0.87.1 adapters. Temporary roots only:
// no credentials, no network, no model calls.
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "../report.ts";
import { sanitize } from "../schema.ts";

const ENV_KEYS = [
  "PI_CACHE_DIAGNOSTICS_ROOT", "PI_CACHE_DIAGNOSTICS_LOG_BYTES", "PI_CACHE_DIAGNOSTICS_HASH_BUDGET", "PI_CODING_AGENT_DIR",
  "PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR", "PI_CLAUDE_CODE_PROVIDER_METRICS_LOG", "CLAUDE_BRIDGE_DEBUG", "PI_CACHE_FORENSICS_ROOT",
];
let saved: Record<string, string | undefined> = {};
let tmp = "";
let root = "";
let loads = 0;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  tmp = mkdtempSync(join(tmpdir(), "cache-diagnostics-test-"));
  root = join(tmp, "diag");
  process.env.PI_CACHE_DIAGNOSTICS_ROOT = root;
  setSystemTime(new Date("2026-09-28T12:00:00Z"));
});
afterEach(() => {
  setSystemTime();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const advance = (ms: number) => setSystemTime(new Date(Date.now() + ms));
const KNOWN = new Set(["openai-codex/gpt-6-astra", "openai-codex-account-2/gpt-6-astra", "anthropic/claude-sonnet-5",
  "claude-bridge/claude-opus-5-5", "openai/gpt-5.5", "google/gemini-3-pro", "amazon-bedrock/claude-sonnet-5", "zai/glm-5.3"]);
const registry = {
  find: (provider: string, id: string) => (KNOWN.has(`${provider}/${id}`) ? { provider, id, promptCache: { short: 300, long: 3600 } } : undefined),
  getRegisteredProviderConfig: (provider: string) => (provider === "claude-bridge" ? { streamSimple: () => undefined } : undefined),
};
type Handler = (event: any, ctx: any) => unknown;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    // Descriptors, not Object.values: accessor properties (auth getters) must stay unread.
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if ("value" in descriptor) deepFreeze(descriptor.value);
  }
  return value;
}

/** Loads a fresh extension instance. newProcess simulates a Pi restart (new process run id). */
async function load(options: { newProcess?: boolean } = {}) {
  if (options.newProcess) delete (globalThis as any)[Symbol.for("pi.cache-diagnostics.process-run")];
  const { default: extension } = await import(`../index.ts?load=${++loads}`);
  const handlers = new Map<string, Handler[]>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const notes: string[] = [];
  extension({
    on: (name: string, fn: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
    registerCommand: (name: string, spec: { handler: typeof command }) => { if (name === "cache-diagnostics") command = spec.handler; },
    getThinkingLevel: () => "medium",
  });
  const ctx = (session: string, model = { provider: "openai-codex", id: "gpt-6-astra" }) => ({
    sessionManager: { getSessionId: () => session }, model, modelRegistry: registry, cwd: "/home/SENTINEL_CWD_path",
    ui: { notify: (text: string) => notes.push(text) },
  });
  const emit = async (name: string, event: any = {}, session = "s1", model?: any) => {
    for (const fn of handlers.get(name) ?? []) {
      const result = await fn(deepFreeze({ type: name, ...event }), ctx(session, model));
      expect(result).toBeUndefined(); // observer only: never replaces payloads or results
    }
  };
  const run = async (args: string) => { await command!(args, ctx("s1")); return notes.at(-1) ?? ""; };
  return { emit, run, notes, handlers };
}
type Pi = Awaited<ReturnType<typeof load>>;

// ---------------------------------------------------------------- fixtures (shapes from pi-ai 0.87.1 adapters)

const SYSTEM = "You are a coding agent.\n# Tools\nUse tools.\n# Guidelines\nBe brief.\n# Context\nCurrent date: 2026-09-28";
const TOOLS_CODEX = [
  { type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } }, strict: null },
  { type: "function", name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } }, strict: null },
];
/** openai-codex-responses buildRequestBody */
function codex(input: unknown[], over: Record<string, unknown> = {}) {
  return {
    model: "gpt-6-astra", store: false, stream: true, instructions: SYSTEM, input,
    text: { verbosity: "low" }, include: ["reasoning.encrypted_content"], prompt_cache_key: "session-key-1",
    tool_choice: "auto", parallel_tool_calls: true, tools: TOOLS_CODEX, reasoning: { effort: "medium", summary: "auto" }, ...over,
  };
}
const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const call = (id: string) => ({ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "read", arguments: '{"path":"a.ts"}' });
const output = (id: string) => ({ type: "function_call_output", call_id: `call_${id}`, output: "file body" });

/** anthropic-messages buildParams (API key, cache_control on system, last tool and last user block). */
function anthropic(messages: any[], over: Record<string, unknown> = {}) {
  const cc = { type: "ephemeral" };
  const marked = messages.map((message, index) => index === messages.length - 1 && message.role === "user"
    ? { ...message, content: message.content.map((block: any, i: number) => (i === message.content.length - 1 ? { ...block, cache_control: cc } : block)) }
    : message);
  return {
    model: "claude-sonnet-5", messages: marked, max_tokens: 32000, stream: true,
    system: [{ type: "text", text: SYSTEM, cache_control: cc }],
    tools: [
      { name: "read", description: "Read", input_schema: { type: "object", properties: {} } },
      { name: "bash", description: "Bash", input_schema: { type: "object", properties: {} }, cache_control: cc },
    ],
    thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" }, ...over,
  };
}
const aUser = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const aAssistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

/** Pi context messages as context_with_system sees them. */
function context(extra: any[] = [], system = SYSTEM) {
  return [
    { role: "system", content: system, toolsAdded: [{ name: "read", description: "Read", parameters: {} }], timestamp: 1 },
    { role: "user", content: "first question", timestamp: 2 }, ...extra,
  ];
}
interface Turn {
  session?: string; messages?: any[]; payload?: unknown; headers?: Record<string, unknown>; provider?: string; model?: string;
  api?: string; usage?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>; stop?: string;
  errorMessage?: string; requested?: { provider: string; id: string };
}
async function turn(pi: Pi, t: Turn = {}) {
  const session = t.session ?? "s1";
  const provider = t.provider ?? "openai-codex", model = t.model ?? "gpt-6-astra";
  const requested = t.requested ?? { provider, id: model };
  await pi.emit("context_with_system", { messages: t.messages ?? context() }, session, requested);
  if (t.headers) await pi.emit("before_provider_headers", { headers: t.headers }, session, requested);
  if (t.payload !== undefined) await pi.emit("before_provider_request", { payload: t.payload }, session, requested);
  await pi.emit("after_provider_response", { status: 200, headers: { "x-request-id": "SENTINEL_RESPONSE_HEADER" } }, session, requested);
  await end(pi, t);
}
async function end(pi: Pi, t: Turn = {}) {
  const provider = t.provider ?? "openai-codex", model = t.model ?? "gpt-6-astra";
  await pi.emit("message_end", {
    message: {
      role: "assistant", provider, model, api: t.api ?? "openai-codex-responses", stopReason: t.stop ?? "toolUse",
      usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...t.usage },
      content: [{ type: "text", text: "SENTINEL_ASSISTANT_TEXT" }], ...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
    },
  }, t.session ?? "s1", t.requested ?? { provider, id: model });
}

// ---------------------------------------------------------------- helpers over the private root

const logsDir = () => join(root, "logs");
function records(): any[] {
  if (!existsSync(logsDir())) return [];
  const files = readdirSync(logsDir()).filter((name) => name.endsWith(".jsonl"))
    .sort((a, b) => (b === "events.jsonl" ? -1 : a === "events.jsonl" ? 1 : b.localeCompare(a)));
  return files.flatMap((name) => readFileSync(join(logsDir(), name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}
const requests = () => records().filter((r) => r.kind === "request");
const lastRequest = () => requests().at(-1);
const mode = (path: string) => statSync(path).mode & 0o777;
function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}
const reportText = () => buildReport(allLines(), { limit: 50 });
function allLines(): string[] { return records().map((record) => JSON.stringify(record)); }

// ---------------------------------------------------------------- tests

test("disabled by default: hooks and status create no files", async () => {
  const pi = await load();
  await turn(pi, { payload: codex([user("hi")]) });
  await pi.emit("cache_warming_decision", { action: "warm", warmCost: 1, missCost: 2, continuationProbability: 0.5 });
  await pi.emit("session_compact", { reason: "manual", willRetry: false, compactionEntry: {} });
  expect(await pi.run("status")).toContain("OFF");
  await pi.run("report");
  expect(existsSync(root)).toBe(false);
});

test("on/off toggles capture, uses private permissions, and clears pending pairing", async () => {
  const pi = await load();
  expect(await pi.run("on")).toContain("ON");
  expect(mode(root)).toBe(0o700);
  expect(mode(join(root, "control.json"))).toBe(0o600);
  await turn(pi, { payload: codex([user("hi")]) });
  expect(requests()).toHaveLength(1);
  for (const dir of [logsDir(), join(root, "state")]) expect(mode(dir)).toBe(0o700);
  for (const file of allFiles(root)) expect(mode(file)).toBe(0o600);

  await pi.run("off");
  const before = records().length;
  await turn(pi, { payload: codex([user("hi"), call("1"), output("1")]) });
  expect(records().length).toBe(before);

  // A request opened before re-enable must not pair with a response after it.
  await pi.run("on");
  await pi.emit("context_with_system", { messages: context() });
  await pi.run("off");
  await pi.run("on");
  await end(pi);
  expect(records().at(-1).kind).toBe("response");
  expect(records().at(-1).pairing).toBe("unpaired");
});

test("PI_CODING_AGENT_DIR selects the root when no test override is set", async () => {
  delete process.env.PI_CACHE_DIAGNOSTICS_ROOT;
  process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
  const pi = await load();
  await pi.run("on");
  expect(existsSync(join(tmp, "agent", "cache-diagnostics", "control.json"))).toBe(true);
});

test("codex: history append extends the prefix; changed instructions and tools are early changes", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q1")]), messages: context(), usage: { cacheRead: 0 } });
  expect(lastRequest().baseline).toBeNull();

  await turn(pi, { payload: codex([user("q1"), call("1"), output("1")]), usage: { input: 100, cacheRead: 900 },
    messages: context([{ role: "assistant", content: [], timestamp: 3 }, { role: "toolResult", content: [], timestamp: 4 }]) });
  let r = lastRequest();
  expect(r.pairing).toBe("single_request");
  expect(r.cmp.payload.prefix).toBe("extends");
  expect(r.cmp.payload.messages).toBe("append");
  expect(r.cmp.payload.commonPrefix).toBe(1);
  expect(r.cmp.context.prefix).toBe("extends");
  expect(r.gap.boundary).toBe("tool_boundary");
  expect(r.usage.readRatio).toBeCloseTo(0.9);

  const changed = SYSTEM.replace("Be brief.", "Be thorough.");
  await turn(pi, { payload: codex([user("q1"), call("1"), output("1")], { instructions: changed }), usage: { cacheRead: 0 } });
  r = lastRequest();
  expect(r.cmp.payload.prefix).toBe("early_change");
  expect(r.cmp.payload.system).toBe("changed");
  expect(r.cmp.payload.systemSection).toBe(2);
  expect(r.cmp.payload.systemChunk).toBe(0);

  const tools = [TOOLS_CODEX[0], { ...TOOLS_CODEX[1], description: "Run a shell command" }];
  await turn(pi, { payload: codex([user("q1"), call("1"), output("1")], { instructions: changed, tools }), usage: { cacheRead: 0 } });
  r = lastRequest();
  expect(r.cmp.payload.tools).toBe("changed");
  expect(r.cmp.payload.toolsRelation).toBe("rewrite");
  expect(r.cmp.payload.toolFirstChanged).toBe(1);
  expect(r.cmp.payload.toolDefsChanged).toBe(1);

  // History rewrite before the end (e.g. an edited early message).
  await turn(pi, { payload: codex([user("q1 edited"), call("1"), output("1")], { instructions: changed, tools }), usage: { cacheRead: 0 } });
  r = lastRequest();
  expect(r.cmp.payload.messages).toBe("rewrite");
  expect(r.cmp.payload.firstChanged).toBe(0);
  expect(r.cmp.payload.firstChangedKind).toBe("user");

  const text = reportText();
  expect(text).toContain("system/instructions changed from section 2");
  expect(text).toContain("tool definitions changed (rewrite at index 1)");
  expect(text).toContain("history rewritten before item 0 of 3");
  expect(text).not.toMatch(/preventable/i);
});

test("anthropic: moving cache_control breakpoints is not a prefix change", async () => {
  const pi = await load();
  await pi.run("on");
  const first = [aUser("q1")];
  await turn(pi, { provider: "anthropic", model: "claude-sonnet-5", api: "anthropic-messages", payload: anthropic(first), usage: { cacheWrite: 900 } });
  await turn(pi, { provider: "anthropic", model: "claude-sonnet-5", api: "anthropic-messages",
    payload: anthropic([...first, aAssistant("a1"), aUser("q2")]), usage: { input: 50, cacheRead: 900 } });
  const r = lastRequest();
  expect(r.cmp.payload.format).toBeUndefined();
  expect(r.format).toBe("anthropic");
  expect(r.cmp.payload.prefix).toBe("extends");
  expect(r.cmp.payload.system).toBe("same");
  expect(r.cmp.payload.tools).toBe("same");
  expect(r.cmp.payload.markersMoved).toBe(true);
  expect(r.cacheMarkers.count).toBe(3);
  expect(r.plain["thinking.type"]).toBe("adaptive");
  expect(r.plain["output_config.effort"]).toBe("high");
  expect(r.actual).toEqual({ provider: "anthropic", model: "claude-sonnet-5", h: expect.any(String) });
});

test("breakpoints are stripped only at pi-ai positions; cache_control-named content still counts", async () => {
  const pi = await load();
  await pi.run("on");
  const cc = { type: "ephemeral" };
  const opts = { provider: "anthropic", model: "claude-sonnet-5", api: "anthropic-messages" };
  const schema = (description: string) => ({ type: "object", properties: { cache_control: { type: "string", description } } });
  const toolUse = (value: string) => ({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { cache_control: value } }] });
  const toolResult = (value: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "r", cache_control: value }] }] });
  const body = (messages: any[], description = "a") => ({
    model: "claude-sonnet-5", max_tokens: 1000, stream: true, system: [{ type: "text", text: SYSTEM, cache_control: cc }], messages,
    tools: [{ name: "read", description: "Read", input_schema: schema(description), cache_control: cc }],
  });
  // Real moving breakpoints: pi-ai turns the last string message into a marked text block.
  const s = "anth-cc";
  await turn(pi, { ...opts, session: s, payload: body([{ role: "user", content: [{ type: "text", text: "q1", cache_control: cc }] }]) });
  await turn(pi, { ...opts, session: s, usage: { cacheRead: 900 }, payload: body([
    { role: "user", content: "q1" }, toolUse("x"), { ...toolResult("y"), content: [...toolResult("y").content, { type: "text", text: "q2", cache_control: cc }] },
  ]) });
  let r = lastRequest();
  expect(r.cmp.payload.prefix).toBe("extends");
  expect(r.cmp.payload.markersMoved).toBe(true);
  const history = [{ role: "user", content: "q1" }, toolUse("x"), toolResult("y"), { role: "user", content: [{ type: "text", text: "q3", cache_control: cc }] }];
  await turn(pi, { ...opts, session: s, payload: body(history) });
  // A schema property named cache_control is real content.
  await turn(pi, { ...opts, session: s, payload: body(history, "b"), usage: { cacheRead: 0 } });
  r = lastRequest();
  expect(r.cmp.payload.tools).toBe("changed");
  expect(r.cmp.payload.toolDefsChanged).toBe(1);
  // So is a cache_control key inside tool-call arguments...
  await turn(pi, { ...opts, session: s, payload: body([history[0], toolUse("CHANGED"), ...history.slice(2)], "b"), usage: { cacheRead: 0 } });
  r = lastRequest();
  expect(r.cmp.payload.messages).toBe("rewrite");
  expect(r.cmp.payload.firstChanged).toBe(1);
  // ...and inside tool-result content.
  await turn(pi, { ...opts, session: s, payload: body([history[0], toolUse("CHANGED"), toolResult("CHANGED"), history[3]], "b"), usage: { cacheRead: 0 } });
  r = lastRequest();
  expect(r.cmp.payload.messages).toBe("rewrite");
  expect(r.cmp.payload.firstChanged).toBe(2);

  // openai-completions with Anthropic cache control: same string-to-block conversion.
  const chat = (messages: any[], tools: any[]) => ({
    model: "glm-5.3", stream: true, messages: [{ role: "system", content: [{ type: "text", text: SYSTEM, cache_control: cc }] }, ...messages], tools,
  });
  const fn = (params: unknown) => ({ type: "function", function: { name: "read", description: "r", parameters: params }, cache_control: cc });
  const c = "chat-cc";
  const zai = { provider: "zai", model: "glm-5.3", api: "openai-completions", session: c };
  await turn(pi, { ...zai, payload: chat([{ role: "user", content: [{ type: "text", text: "q1", cache_control: cc }] }], [fn({})]) });
  await turn(pi, { ...zai, payload: chat([{ role: "user", content: "q1" }, { role: "assistant", content: "a" }, { role: "user", content: [{ type: "text", text: "q2", cache_control: cc }] }], [fn({})]) });
  expect(lastRequest().cmp.payload.prefix).toBe("extends");
  await turn(pi, { ...zai, payload: chat([{ role: "user", content: "q1" }, { role: "assistant", content: "a" }, { role: "user", content: [{ type: "text", text: "q2", cache_control: cc }] }], [fn({ cache_control: { type: "ephemeral" } })]) });
  expect(lastRequest().cmp.payload.tools).toBe("changed");

  // Bedrock: cachePoint blocks move, but a schema property named cachePoint is content.
  const cp = { cachePoint: { type: "default" } };
  const bedrock = (messages: any[], props: Record<string, unknown>) => ({
    modelId: "claude-sonnet-5", system: [{ text: SYSTEM }, cp], messages, inferenceConfig: { maxTokens: 100 },
    toolConfig: { tools: [{ toolSpec: { name: "read", inputSchema: { json: { type: "object", properties: props } } } }, cp] },
  });
  const b = { provider: "amazon-bedrock", model: "claude-sonnet-5", api: "bedrock-converse-stream", session: "bedrock-cp" };
  await turn(pi, { ...b, payload: bedrock([{ role: "user", content: [{ text: "q" }, cp] }], { cachePoint: { type: "string" } }) });
  await turn(pi, { ...b, payload: bedrock([{ role: "user", content: [{ text: "q" }] }, { role: "assistant", content: [{ text: "a" }] }, { role: "user", content: [{ text: "q2" }, cp] }], { cachePoint: { type: "string" } }) });
  expect(lastRequest().cmp.payload.prefix).toBe("extends");
  await turn(pi, { ...b, payload: bedrock([{ role: "user", content: [{ text: "q" }] }, { role: "assistant", content: [{ text: "a" }] }, { role: "user", content: [{ text: "q2" }, cp] }], { cachePoint: { type: "number" } }) });
  expect(lastRequest().cmp.payload.tools).toBe("changed");

  // Responses-style payloads have no breakpoints: nothing named cache_control is stripped.
  const item = (value: string) => ({ role: "user", content: [{ type: "input_text", text: "q", cache_control: value }] });
  await turn(pi, { session: "codex-cc", payload: codex([item("a")]) });
  await turn(pi, { session: "codex-cc", payload: codex([item("b"), user("q2")]) });
  expect(lastRequest().cmp.payload.messages).toBe("rewrite");
  expect(lastRequest().cacheMarkers.count).toBe(0);
});

test("FIFOs at private paths are refused without blocking (subprocess timeout)", async () => {
  const probe = (label: string) => {
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "fifo-probe.ts")], { env: { ...process.env }, timeout: 15_000 });
    expect({ label, exit: result.exitCode, out: result.stdout.toString().trim().startsWith("done") }).toEqual({ label, exit: 0, out: true });
  };
  const fifo = (path: string) => expect(Bun.spawnSync(["mkfifo", "-m", "600", path]).exitCode).toBe(0);
  const isFifo = (path: string) => lstatSync(path).isFIFO();
  mkdirSync(root, { mode: 0o700 });

  fifo(join(root, "control.json"));
  probe("control");
  expect(existsSync(logsDir())).toBe(false);
  rmSync(join(root, "control.json"));

  writeFileSync(join(root, "control.json"), '{"enabled":true}', { mode: 0o600 });
  fifo(join(root, "key"));
  probe("key");
  expect(existsSync(logsDir())).toBe(false);
  expect(isFifo(join(root, "key"))).toBe(true);
  rmSync(join(root, "key"));

  probe("baseline run creates key, log and state"); // no FIFOs: normal operation
  const [state] = readdirSync(join(root, "state"));
  rmSync(join(root, "state", state));
  fifo(join(root, "state", state));
  rmSync(join(logsDir(), "events.jsonl"));
  fifo(join(logsDir(), "events.jsonl"));
  probe("state and log");
  expect(isFifo(join(root, "state", state))).toBe(true);
  expect(isFifo(join(logsDir(), "events.jsonl"))).toBe(true);
});

test("other adapter formats: chat completions, google and bedrock append cleanly", async () => {
  const pi = await load();
  await pi.run("on");
  const chat = (messages: any[]) => ({
    model: "gpt-5.5", stream: true, messages: [{ role: "system", content: SYSTEM }, ...messages],
    prompt_cache_key: "k", stream_options: { include_usage: true }, max_completion_tokens: 4096,
    tools: [{ type: "function", function: { name: "read", description: "Read", parameters: {} } }],
  });
  const google = (contents: any[]) => ({
    model: "gemini-3-pro", contents,
    config: { systemInstruction: SYSTEM, tools: [{ functionDeclarations: [{ name: "read", description: "r", parameters: {} }] }], maxOutputTokens: 8192 },
  });
  const cp = { cachePoint: { type: "default" } };
  const bedrock = (messages: any[]) => ({
    modelId: "claude-sonnet-5", messages: [...messages.slice(0, -1), { ...messages.at(-1), content: [...messages.at(-1).content, cp] }],
    system: [{ text: SYSTEM }, cp], inferenceConfig: { maxTokens: 8192 },
    toolConfig: { tools: [{ toolSpec: { name: "read", description: "r", inputSchema: { json: {} } } }, cp] },
  });
  const cases: [string, string, string, (m: any[]) => unknown, any[], any[]][] = [
    ["openai", "gpt-5.5", "openai-completions", chat, [{ role: "user", content: "q" }], [{ role: "assistant", content: "a" }, { role: "user", content: "q2" }]],
    ["google", "gemini-3-pro", "google-generative-ai", google, [{ role: "user", parts: [{ text: "q" }] }], [{ role: "model", parts: [{ text: "a" }] }, { role: "user", parts: [{ text: "q2" }] }]],
    ["amazon-bedrock", "claude-sonnet-5", "bedrock-converse-stream", bedrock, [{ role: "user", content: [{ text: "q" }] }], [{ role: "assistant", content: [{ text: "a" }] }, { role: "user", content: [{ text: "q2" }] }]],
  ];
  for (const [provider, model, api, build, first, more] of cases) {
    const session = `fmt-${provider}`;
    await turn(pi, { session, provider, model, api, payload: build(first) });
    await turn(pi, { session, provider, model, api, payload: build([...first, ...more]), usage: { cacheRead: 500 } });
    const r = lastRequest();
    expect(r.cmp.payload.prefix).toBe("extends");
    expect(r.cmp.payload.system).toBe("same");
    expect(r.cmp.payload.tools).toBe("same");
    expect(r.cmp.payload.messages).toBe("append");
    expect(r.usage.verified).toBe(true);
  }
});

test("same prefix after an idle gap: miss is reported as unknown TTL/eviction, never certain", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q1")]), stop: "stop" });
  advance(10 * 60_000);
  await pi.emit("before_agent_start", { prompt: "SENTINEL_PROMPT", systemPrompt: "SENTINEL_SYSTEM", systemPromptOptions: {} });
  await turn(pi, { payload: codex([user("q1"), { role: "assistant", content: [] }, user("q2")]), usage: { cacheRead: 0 } });
  const r = lastRequest();
  expect(r.gap).toEqual({ ms: 600_000, boundary: "user_turn" });
  expect(r.cmp.payload.prefix).toBe("extends");
  const text = reportText();
  expect(text).toContain("zero_read");
  expect(text).toContain("no observed prefix, option, affinity or model change. Provider TTL, eviction or routing are not observable here.");
  expect(text).toContain("Missing warm evidence is not proof warming never ran");

  // Inside pi's declared 300 s TTL the same miss is flagged as unexplained, still without a verdict.
  advance(60_000);
  await turn(pi, { payload: codex([user("q1"), { role: "assistant", content: [] }, user("q2"), call("2"), output("2")]), usage: { cacheRead: 0 } });
  expect(reportText()).toContain("the gap is inside pi's declared TTL, so this is unexplained by the evidence");
});

test("gap ends at request start: 6 min idle plus 2 min generation reports 6 min", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q1")]), stop: "stop" });
  advance(6 * 60_000);
  await pi.emit("before_agent_start", { prompt: "p", systemPrompt: "s", systemPromptOptions: {} });
  await pi.emit("context_with_system", { messages: context() });
  await pi.emit("before_provider_request", { payload: codex([user("q1"), user("q2")]) });
  advance(2 * 60_000); // response generation, not idle time
  await end(pi, { stop: "stop", usage: { cacheRead: 0 } });
  expect(lastRequest().gap).toEqual({ ms: 6 * 60_000, boundary: "user_turn" });
  expect(reportText()).toContain("gap: 360s from previous completed response to this request's start (user_turn)");
  // The next gap is measured from this response's completion, 8 min after the first.
  advance(60_000);
  await turn(pi, { payload: codex([user("q1"), user("q2"), user("q3")]) });
  expect(lastRequest().gap.ms).toBe(60_000);
});

test("restart: persistent key and baseline compare across processes", async () => {
  const a = await load({ newProcess: true });
  await a.run("on");
  await turn(a, { payload: codex([user("q1")]), stop: "stop" });
  const first = lastRequest();
  advance(90_000);
  const b = await load({ newProcess: true });
  await b.emit("session_start", { reason: "resume" });
  await b.emit("before_agent_start", { prompt: "p", systemPrompt: "s", systemPromptOptions: {} });
  await turn(b, { payload: codex([user("q1"), { role: "assistant", content: [] }, user("q2")]), usage: { cacheRead: 0 } });
  const second = lastRequest();
  expect(second.session).toBe(first.session);
  expect(second.run).not.toBe(first.run);
  expect(second.baseline.source).toBe("disk");
  expect(second.baseline.restart).toBe(true);
  expect(second.markers).toContain("session_resume");
  expect(second.gap.ms).toBe(90_000);
  expect(second.cmp.payload.prefix).toBe("extends");
  expect(reportText()).toContain("process restart or other process since previous request");
});

test("provider/account and affinity changes are reported by HMAC, auth headers are never read", async () => {
  const pi = await load();
  await pi.run("on");
  let authRead = false;
  const headers = (affinity: string) => {
    const value: Record<string, unknown> = { "x-session-affinity": affinity, "X-Unknown-SENTINEL_HEADER_NAME": "SENTINEL_HEADER_VALUE" };
    Object.defineProperty(value, "Authorization", { enumerable: true, get: () => { authRead = true; return "Bearer SENTINEL_TOKEN"; } });
    return value;
  };
  await turn(pi, { payload: codex([user("q1")]), headers: headers("aff-1") });
  await turn(pi, {
    provider: "openai-codex-account-2", payload: codex([user("q1"), call("1"), output("1")], { prompt_cache_key: "session-key-2" }),
    headers: headers("aff-2"), usage: { cacheRead: 0 },
  });
  const r = lastRequest();
  expect(authRead).toBe(false);
  expect(r.baseline.providerChanged).toBe(true);
  expect(r.baseline.modelChanged).toBe(true);
  expect(r.cmp.payload.affinity.prompt_cache_key).toBe("changed");
  expect(r.cmp.headers["x-session-affinity"]).toBe("changed");
  const text = reportText();
  expect(text).toContain("cache affinity changed: prompt_cache_key changed, x-session-affinity changed");
  expect(text).toContain("actual provider differs from previous response");
});

test("interleaved parent and child sessions pair independently", async () => {
  const parent = await load();
  const child = await load(); // in-process subagent: separate extension instance
  await parent.run("on");
  const msgs = context();
  await parent.emit("context_with_system", { messages: msgs }, "parent");
  await child.emit("context_with_system", { messages: msgs }, "child");
  await child.emit("before_provider_request", { payload: codex([user("child")]) }, "child");
  await parent.emit("before_provider_request", { payload: codex([user("parent")]) }, "parent");
  await parent.emit("message_end", { message: { role: "assistant", provider: "openai-codex", model: "gpt-6-astra", api: "openai-codex-responses", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 111, cacheWrite: 0 } } }, "parent");
  await child.emit("message_end", { message: { role: "assistant", provider: "openai-codex", model: "gpt-6-astra", api: "openai-codex-responses", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 222, cacheWrite: 0 } } }, "child");
  const rs = requests();
  expect(rs).toHaveLength(2);
  expect(rs.every((r) => r.pairing === "single_request")).toBe(true);
  expect(new Set(rs.map((r) => r.session)).size).toBe(2);
  expect(new Set(rs.map((r) => r.inst)).size).toBe(2);
  expect(rs.map((r) => r.usage.cacheRead).sort()).toEqual([111, 222]);
});

test("same-session overlapping requests are ambiguous: no pairing, no verdict, no baseline update", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q1")]) });
  const state = readdirSync(join(root, "state"));
  const before = readFileSync(join(root, "state", state[0]), "utf8");
  await pi.emit("context_with_system", { messages: context() });
  await pi.emit("before_provider_request", { payload: codex([user("q1"), user("side")]) });
  await pi.emit("context_with_system", { messages: context() });
  await pi.emit("before_provider_request", { payload: codex([user("q1"), user("main")]) });
  await end(pi, { usage: { cacheRead: 0 } });
  await end(pi, { usage: { cacheRead: 500 } });
  const tail = records().slice(-2);
  expect(tail.map((r) => [r.kind, r.pairing])).toEqual([["response", "ambiguous"], ["response", "ambiguous"]]);
  expect(readFileSync(join(root, "state", state[0]), "utf8")).toBe(before);
  // A response without any open request is recorded as unpaired and consumes nothing.
  await end(pi);
  expect(records().at(-1).pairing).toBe("unpaired");
  await turn(pi, { payload: codex([user("q1"), call("1"), output("1")]), usage: { cacheRead: 0 } });
  expect(lastRequest().baseline.stale).toBe(true);
  expect(reportText()).toContain("unpaired or ambiguous traffic since the baseline");
});

test("cache warm replay is labelled, never consumes usage, and a later real request still pairs", async () => {
  const pi = await load();
  await pi.run("on");
  const payload = codex([user("q1")]);
  await turn(pi, { payload });
  await pi.emit("cache_warming_decision", { action: "warm", warmCost: 0.01, missCost: 0.2, continuationProbability: 0.5 });
  await pi.emit("before_provider_headers", { headers: {} });
  await pi.emit("before_provider_request", { payload });
  await pi.emit("after_provider_response", { status: 200, headers: {} });
  const warm = records().filter((r) => r.kind === "unanchored_request").at(-1);
  expect(warm.classification).toBe("warm_candidate");
  expect(warm.vsBaseline.prefix).toBe("extends");
  expect(warm.vsBaseline.messages).toBe("identical");

  // A proposed warm that never sent anything must not capture the next real request.
  await pi.emit("cache_warming_decision", { action: "warm", warmCost: 0.01, missCost: 0.2, continuationProbability: 0.5 });
  await turn(pi, { payload: codex([user("q1"), call("1"), output("1")]), usage: { cacheRead: 900 } });
  const r = lastRequest();
  expect(r.pairing).toBe("single_request");
  expect(r.usage.cacheRead).toBe(900);
  expect(r.warming).toEqual({ decisions: 2, proposedWarm: 2, proposedStop: 0, candidates: 1 });
  expect(records().filter((x) => x.kind === "marker" && x.marker === "warming_decision")).toHaveLength(2);
});

test("errors and aborts are recorded as enums and do not advance the baseline", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q1")]) });
  const file = join(root, "state", readdirSync(join(root, "state"))[0]);
  const before = readFileSync(file, "utf8");
  await turn(pi, { payload: codex([user("q1"), user("q2")]), stop: "error", errorMessage: "SENTINEL_ERROR_TEXT /home/SENTINEL_PATH" });
  await turn(pi, { payload: codex([user("q1"), user("q2")]), stop: "aborted" });
  expect(requests().slice(-2).map((r) => r.stop)).toEqual(["error", "aborted"]);
  expect(readFileSync(file, "utf8")).toBe(before);
  // A request left open at agent_end is closed, so it cannot poison later pairing.
  await pi.emit("context_with_system", { messages: context() });
  await pi.emit("agent_end", { messages: [] });
  expect(records().at(-1)).toMatchObject({ kind: "unfinished", reason: "agent_end" });
  await turn(pi, { payload: codex([user("q1"), user("q2")]) });
  expect(lastRequest().pairing).toBe("single_request");
  expect(lastRequest().baseline.stale).toBe(true);
  await pi.emit("context_with_system", { messages: context() });
  await pi.emit("session_shutdown", { reason: "quit" });
  expect(records().at(-1)).toMatchObject({ kind: "unfinished", reason: "session_shutdown" });
});

test("custom providers without payload hooks get logical-context records only", async () => {
  const pi = await load();
  await pi.run("on");
  const opts = { provider: "claude-bridge", model: "claude-opus-5-5", api: "anthropic-messages" };
  await turn(pi, { ...opts, messages: context() });
  await turn(pi, { ...opts, messages: context([{ role: "assistant", content: [], timestamp: 5 }, { role: "user", content: "q2", timestamp: 6 }]), usage: { cacheRead: 0 } });
  const r = lastRequest();
  expect(r.pairing).toBe("context_only");
  expect(r.layers).toEqual(["context"]);
  expect(r.cmp.payload).toBeNull();
  expect(r.cmp.context.prefix).toBe("extends");
  expect(r.usage.verified).toBe(false);
  expect(r.usage.promptTokens).toBeNull();
  expect(reportText()).toContain("logical context only; provider bypasses before_provider_request, wire prefix not observed");

  // A context-level system prompt change is still located by section.
  await turn(pi, { ...opts, messages: context([], SYSTEM.replace("Use tools.", "Use no tools.")), usage: { cacheRead: 0 } });
  expect(lastRequest().cmp.context.system).toBe("changed");
  expect(lastRequest().cmp.context.systemSection).toBe(0);
});

test("no raw sentinel leaks: prompts, tools, unknown names, paths, ids, errors, headers", async () => {
  const pi = await load();
  await pi.run("on");
  const session = "SENTINEL_SESSION_ID";
  const payload = codex([user("SENTINEL_USER_TEXT"), { ...call("SENTINEL_CALL"), name: "SENTINEL_TOOL_NAME", arguments: '{"SENTINEL_ARG":1}' }, output("SENTINEL_RESULT")], {
    instructions: "SENTINEL_SYSTEM_PROMPT", SENTINEL_FIELD_NAME: { nested: "SENTINEL_FIELD_VALUE" }, prompt_cache_key: "SENTINEL_CACHE_KEY",
    tools: [{ type: "function", name: "SENTINEL_TOOL_DEF", description: "SENTINEL_DESCRIPTION", parameters: {} }],
    reasoning: { effort: "SENTINEL_EFFORT" }, metadata: { user_id: "SENTINEL_ACCOUNT" },
  });
  const messages = [{ role: "system", content: "SENTINEL_CTX_SYSTEM", sections: { SENTINEL_SECTION: "x" }, toolsAdded: [{ name: "SENTINEL_CTX_TOOL" }] }, { role: "user", content: "SENTINEL_CTX_USER" }];
  await pi.emit("session_start", { reason: "SENTINEL_REASON", previousSessionFile: "/home/SENTINEL_SESSION_FILE" }, session);
  await pi.emit("before_agent_start", { prompt: "SENTINEL_PROMPT", systemPrompt: "SENTINEL_SYSTEM", systemPromptOptions: { cwd: "/SENTINEL_OPT" } }, session);
  for (let i = 0; i < 2; i++) {
    await turn(pi, {
      session, messages, payload, provider: "SENTINEL_PROVIDER", model: "SENTINEL_MODEL", api: "SENTINEL_API",
      requested: { provider: "SENTINEL_REQ_PROVIDER", id: "SENTINEL_REQ_MODEL" }, headers: { "x-session-id": "SENTINEL_AFFINITY", "x-SENTINEL-name": "v" },
      stop: i ? "error" : "stop", errorMessage: "SENTINEL_ERROR",
    });
  }
  await pi.emit("model_select", { model: { provider: "SENTINEL_P2", id: "SENTINEL_M2" }, previousModel: { provider: "openai-codex", id: "gpt-6-astra" }, source: "SENTINEL_SRC" }, session);
  await pi.emit("session_compact", { reason: "SENTINEL_CR", willRetry: false, compactionEntry: { summary: "SENTINEL_SUMMARY" } }, session);
  await pi.emit("session_tree", { newLeafId: "SENTINEL_LEAF", oldLeafId: null, summaryEntry: { summary: "SENTINEL_BRANCH" } }, session);
  await pi.emit("thinking_level_select", { level: "SENTINEL_LEVEL", previousLevel: "medium" }, session);
  await pi.emit("cache_warming_decision", { action: "SENTINEL_ACTION", warmCost: 1, missCost: 1, continuationProbability: 1 }, session);
  await pi.emit("before_provider_request", { payload: { SENTINEL_OPAQUE: "SENTINEL_OPAQUE_VALUE" } }, session);
  await pi.run("report");
  const files = allFiles(root);
  expect(files.length).toBeGreaterThan(3);
  for (const file of files) expect(readFileSync(file, "utf8")).not.toContain("SENTINEL");
  expect(pi.notes.join("\n")).not.toContain("SENTINEL");
  expect(records().some((r) => r.sanitized)).toBe(false);
  expect(records().filter((r) => r.kind === "request")).toHaveLength(2);
});

test("sanitizer redacts unknown keys and free text as a last line of defense", () => {
  const clean = sanitize({ v: 1, kind: "request", stop: "SENTINEL_STOP", SENTINEL_KEY: 1, actual: { provider: "p", h: "0123456789abcdef" } }, new Set(["p"]));
  expect(JSON.stringify(clean)).not.toContain("SENTINEL");
  expect(clean).toMatchObject({ sanitized: true, stop: "[redacted]", actual: { provider: "p", h: "0123456789abcdef" } });
});

test("tampered or oversized baseline state is ignored, never echoed", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q1")]) });
  const file = join(root, "state", readdirSync(join(root, "state"))[0]);
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.payload.options.SENTINEL_OPTION = "0123456789ab";
  writeFileSync(file, JSON.stringify(state));
  const fresh = await load();
  await turn(fresh, { payload: codex([user("q1"), user("q2")]) });
  expect(lastRequest().baseline).toBeNull();
  writeFileSync(file, "x".repeat(600 * 1024));
  const third = await load();
  await turn(third, { payload: codex([user("q1"), user("q2")]) });
  expect(lastRequest().baseline).toBeNull();
  for (const log of allFiles(logsDir())) expect(readFileSync(log, "utf8")).not.toContain("SENTINEL");
});

test("logs rotate within bounds", async () => {
  process.env.PI_CACHE_DIAGNOSTICS_LOG_BYTES = "4096";
  const pi = await load();
  await pi.run("on");
  const input: unknown[] = [user("q")];
  for (let i = 0; i < 40; i++) { input.push(call(String(i)), output(String(i))); await turn(pi, { payload: codex([...input]) }); }
  const names = readdirSync(logsDir()).filter((name) => name.endsWith(".jsonl")).sort();
  expect(names).toEqual(["events.1.jsonl", "events.2.jsonl", "events.3.jsonl", "events.jsonl"]);
  for (const name of names) expect(statSync(join(logsDir(), name)).size).toBeLessThanOrEqual(2 * 4096);
  expect(existsSync(join(logsDir(), ".rotate.lock"))).toBe(false);
});

test("symlinked control, key, log and state paths are refused without writing through", async () => {
  const outside = join(tmp, "outside");
  writeFileSync(outside, '{"enabled":true}');
  mkdirSync(root, { mode: 0o700 });
  symlinkSync(outside, join(root, "control.json"));
  const pi = await load();
  await turn(pi, { payload: codex([user("q")]) });
  expect(existsSync(logsDir())).toBe(false);
  expect(await pi.run("status")).toContain("control file unsafe: treated as OFF");
  expect(await pi.run("on")).toContain("unsafe path refused");
  rmSync(join(root, "control.json"));

  await pi.run("on");
  symlinkSync(outside, join(root, "key"));
  await turn(pi, { payload: codex([user("q")]) });
  expect(existsSync(logsDir())).toBe(false);
  expect(pi.notes.some((note) => note.includes("could not record"))).toBe(true);
  rmSync(join(root, "key"));

  mkdirSync(logsDir(), { mode: 0o700 });
  symlinkSync(outside, join(logsDir(), "events.jsonl"));
  await turn(pi, { payload: codex([user("q")]) });
  expect(readFileSync(outside, "utf8")).toBe('{"enabled":true}');
  rmSync(join(logsDir(), "events.jsonl"));

  await turn(pi, { session: "state-link", payload: codex([user("q")]) });
  const [name] = readdirSync(join(root, "state"));
  rmSync(join(root, "state", name));
  symlinkSync(outside, join(root, "state", name));
  const fresh = await load();
  await turn(fresh, { session: "state-link", payload: codex([user("q"), user("r")]) });
  expect(readFileSync(outside, "utf8")).toBe('{"enabled":true}');
  expect(lstatSync(join(root, "state", name)).isSymbolicLink()).toBe(true);
});

test("a loosened key file is refused", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q")]) });
  const count = records().length;
  const { chmodSync } = await import("node:fs");
  chmodSync(join(root, "key"), 0o644);
  await turn(pi, { payload: codex([user("q"), user("r")]) });
  expect(records().length).toBe(count);
});

test("hash budget exhaustion marks fingerprints incomplete instead of claiming an extension", async () => {
  process.env.PI_CACHE_DIAGNOSTICS_HASH_BUDGET = "4096";
  const pi = await load();
  await pi.run("on");
  const big = "x".repeat(5000);
  await turn(pi, { payload: codex([user("q"), user(big)]) });
  await turn(pi, { payload: codex([user("q"), user(big), user("more")]) });
  const r = lastRequest();
  expect(r.cmp.payload.prefix).toBe("unknown");
  expect(r.cmp.payload.messages).toBe("unknown");
});

test("opaque payloads never yield an extends verdict when they change", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: { weird: [1, 2] } });
  await turn(pi, { payload: { weird: [1, 2, 3] } });
  expect(lastRequest().format).toBe("opaque");
  expect(lastRequest().cmp.payload.prefix).toBe("unknown");
});

test("purge removes logs, baselines and key but keeps the control file", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q")]) });
  await pi.run("purge");
  expect(readdirSync(root).sort()).toEqual(["control.json"]);
  expect(await pi.run("status")).toContain("ON");
});

test("concurrent processes share one key and write whole lines through rotation", async () => {
  process.env.PI_CACHE_DIAGNOSTICS_LOG_BYTES = "8192";
  const writers = Array.from({ length: 6 }, () => Bun.spawn(["bun", join(import.meta.dir, "concurrent-writer.ts")], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }));
  const outputs = await Promise.all(writers.map(async (child) => { await child.exited; return (await new Response(child.stdout).text()).trim(); }));
  expect(writers.every((child) => child.exitCode === 0)).toBe(true);
  expect(new Set(outputs).size).toBe(1);
  expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  for (const file of allFiles(logsDir())) {
    expect(statSync(file).size).toBeLessThanOrEqual(2 * 8192);
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) expect(JSON.parse(line).kind).toBe("marker");
  }
});

test("report CLI reads the private root", async () => {
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q")]) });
  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "report.ts"), "--limit", "5"], { env: { ...process.env } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Cache diagnostics report");
});

test("forensics and bridge debug state are untouched", async () => {
  process.env.PI_CACHE_FORENSICS_ROOT = join(tmp, "forensics");
  const pi = await load();
  await pi.run("on");
  await turn(pi, { payload: codex([user("q")]) });
  await pi.run("purge");
  await pi.run("off");
  for (const key of ["PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR", "PI_CLAUDE_CODE_PROVIDER_METRICS_LOG", "CLAUDE_BRIDGE_DEBUG"]) expect(process.env[key]).toBeUndefined();
  expect(existsSync(join(tmp, "forensics"))).toBe(false);
  for (const name of ["index.ts", "store.ts", "fingerprint.ts", "report.ts", "schema.ts"]) {
    const source = readFileSync(join(import.meta.dir, "..", name), "utf8");
    expect(source).not.toMatch(/process\.env\.[A-Z_]+\s*=[^=]/);
    expect(source).not.toMatch(/cache-forensics|CLAUDE_BRIDGE_DEBUG|PI_CLAUDE_CODE_PROVIDER/);
  }
});
