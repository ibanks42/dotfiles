// Offline tests for ../cache-forensics.ts. They use a fake Pi API and a
// temporary root only: no credentials, no live captures, no network or model calls.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["PI_CACHE_FORENSICS_ROOT", "PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR", "PI_CLAUDE_CODE_PROVIDER_METRICS_LOG"];
let saved: Record<string, string | undefined> = {};
let root = "";
let loads = 0;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  root = mkdtempSync(join(tmpdir(), "cache-forensics-test-"));
  process.env.PI_CACHE_FORENSICS_ROOT = root;
});
afterEach(() => {
  for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  rmSync(root, { recursive: true, force: true });
  if (existsSync(root)) throw new Error(`temporary root not removed: ${root}`);
});

type Handler = (event: any, ctx: any) => unknown;
/** Loads a fresh module instance (fresh module state) bound to the temporary root. */
async function load() {
  const { default: extension } = await import(`../cache-forensics.ts?test=${++loads}`);
  const handlers = new Map<string, Handler[]>();
  let command: ((arg: string, ctx: any) => Promise<void>) | undefined;
  const notes: string[] = [];
  extension({
    on: (name: string, fn: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
    registerCommand: (name: string, spec: { handler: typeof command }) => { if (name === "forensics") command = spec.handler; },
    getThinkingLevel: () => "off",
  });
  const ctx = (session = "s1") => ({
    sessionManager: { getSessionId: () => session },
    model: { id: "fake", provider: "fake", api: "fake" },
    ui: { notify: (text: string) => notes.push(text) },
  });
  const emit = async (name: string, event: any = {}, session = "s1") => {
    for (const fn of handlers.get(name) ?? []) await fn({ type: name, ...event }, ctx(session));
  };
  const run = async (arg: string) => { await command!(arg, ctx()); return notes.at(-1) ?? ""; };
  return { emit, run, notes, handlers };
}

const data = () => join(root, "data");
const log = () => join(data(), "pi.jsonl");
const records = (): any[] => existsSync(log()) ? readFileSync(log(), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const state = (text: string) => writeFileSync(join(root, "state.json"), text);
const request = (pi: Awaited<ReturnType<typeof load>>, session = "s1") => pi.emit("before_provider_request", { payload: { n: 1 } }, session);
const reply = (pi: Awaited<ReturnType<typeof load>>, session = "s1") => pi.emit("message_end", {
  message: { role: "assistant", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
}, session);
const usage = () => records().filter((r) => r.kind === "usage").map((r) => r.requestSequence);
const requests = () => records().filter((r) => r.kind === "request").map((r) => r.sequence);

async function captureAll(pi: Awaited<ReturnType<typeof load>>) {
  await pi.emit("session_start", { reason: "startup" });
  await pi.emit("before_agent_start", { systemPrompt: "# Prompt", systemPromptOptions: {} });
  await pi.emit("context", { messages: [{ role: "user", content: "secret" }] });
  await pi.emit("context_with_system", { messages: [] });
  await request(pi);
  await reply(pi);
}

// Fail-closed state handling.
const closed: [string, string | undefined][] = [
  ["missing state.json", undefined],
  ["corrupt JSON", "{enabled:"],
  ["empty file", ""],
  ["JSON null", "null"],
  ["array", "[true]"],
  ["bare boolean", "true"],
  ["object without enabled", "{}"],
  ["enabled string", '{"enabled":"true"}'],
  ["enabled number", '{"enabled":1}'],
  ["enabled null", '{"enabled":null}'],
  ["enabled false", '{"enabled":false}'],
];
for (const [name, text] of closed) {
  test(`capture stays off with ${name}`, async () => {
    if (text !== undefined) state(text);
    const pi = await load();
    await captureAll(pi);
    expect(existsSync(log())).toBe(false);
    expect(process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR).toBeUndefined();
    expect(await pi.run("status")).toContain("OFF");
  });
}

test("capture runs only when state.json has enabled === true", async () => {
  state('{"enabled":true}');
  const pi = await load();
  await captureAll(pi);
  expect(records().map((r) => r.kind)).toEqual(["before_agent_start", "context", "context_with_system", "request", "usage"]);
  expect(process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR).toBe(data());
});

// Commands.
test("/forensics on and off toggle capture and provider environment", async () => {
  const pi = await load();
  expect(await pi.run("on")).toContain("ON");
  expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8"))).toEqual({ enabled: true });
  expect(process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG).toBe(join(data(), "metrics.jsonl"));
  expect(await pi.run("off")).toContain("OFF");
  expect(process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR).toBeUndefined();
  await request(pi);
  expect(existsSync(log())).toBe(false);
});

test("/forensics with an unknown argument changes nothing", async () => {
  const pi = await load();
  expect(await pi.run("maybe")).toContain("Use /forensics");
  expect(existsSync(join(root, "state.json"))).toBe(false);
});

for (const [where, dir] of [["ROOT/STOP", () => root], ["DATA/STOP", data]] as const) {
  test(`${where} stops capture while state is on, and /forensics on resumes`, async () => {
    const pi = await load();
    await pi.run("on");
    writeFileSync(join(dir(), "STOP"), "");
    expect(await pi.run("status")).toContain("OFF");
    expect(process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR).toBeUndefined();
    await request(pi);
    expect(existsSync(log())).toBe(false);
    expect(await pi.run("on")).toContain("ON");
    expect(existsSync(join(dir(), "STOP"))).toBe(false);
    await request(pi);
    expect(requests()).toEqual([1]);
  });
}

test("/forensics purge removes captures only and keeps state", async () => {
  const pi = await load();
  await pi.run("on");
  await request(pi);
  for (const f of ["README.md", "analyze.py"]) writeFileSync(join(root, f), "keep");
  for (const f of ["pi.jsonl", "provider.jsonl", "wire-1.json"]) writeFileSync(join(root, f), "old");
  mkdirSync(join(root, "blobs"));
  await pi.run("purge");
  expect(existsSync(log())).toBe(false);
  for (const f of ["pi.jsonl", "provider.jsonl", "wire-1.json", "blobs"]) expect(existsSync(join(root, f))).toBe(false);
  for (const f of ["README.md", "analyze.py", "state.json"]) expect(existsSync(join(root, f))).toBe(true);
  expect(await pi.run("status")).toContain("ON");
});

// Bookkeeping and lifecycle.
test("disabled requests do not advance the sequence", async () => {
  const pi = await load();
  for (let i = 0; i < 5; i++) await request(pi);
  await pi.run("on");
  await request(pi);
  await reply(pi);
  expect(requests()).toEqual([1]);
  expect(usage()).toEqual([1]);
});

test("disable and re-enable by command clears pending requests", async () => {
  const pi = await load();
  await pi.run("on");
  await request(pi);
  await pi.run("off");
  await pi.run("on");
  await request(pi);
  await reply(pi);
  expect(requests()).toEqual([1, 1]);
  expect(usage()).toEqual([1]);
});

test("disable and re-enable through state.json from another process clears pending requests", async () => {
  state('{"enabled":true}');
  const pi = await load();
  await request(pi);
  state('{"enabled":false}');
  await request(pi);
  await reply(pi);
  state('{"enabled":true}');
  await request(pi);
  await reply(pi);
  expect(requests()).toEqual([1, 1]);
  expect(usage()).toEqual([1]);
});

test("session_shutdown clears session state and is idempotent", async () => {
  state('{"enabled":true}');
  const pi = await load();
  await request(pi);
  await pi.emit("session_shutdown", { reason: "reload" });
  await pi.emit("session_shutdown", { reason: "quit" });
  await reply(pi);
  await request(pi);
  await reply(pi);
  expect(requests()).toEqual([1, 1]);
  expect(usage()).toEqual([undefined, 1]);
});

test("one session's lifecycle does not erase another session's pending requests", async () => {
  state('{"enabled":true}');
  const pi = await load();
  await request(pi, "a");
  await request(pi, "b");
  await pi.emit("session_start", { reason: "new" }, "c");
  await pi.emit("session_shutdown", { reason: "quit" }, "a");
  await request(pi, "a");
  await reply(pi, "b");
  await reply(pi, "a");
  const byKind = (kind: string) => records().filter((r) => r.kind === kind).map((r) => [r.sessionId, r.sequence]);
  expect(byKind("request")).toEqual([["a", 1], ["b", 1], ["a", 1]]);
  expect(byKind("usage")).toEqual([["b", 1], ["a", 1]]);
});

for (const [name, stop] of [
  ["invalid state.json", () => state("{broken")],
  ["ROOT/STOP", () => writeFileSync(join(root, "STOP"), "")],
  ["DATA/STOP", () => writeFileSync(join(data(), "STOP"), "")],
] as const) {
  test(`${name} set outside Pi clears provider capture env at the next request`, async () => {
    const pi = await load();
    await pi.run("on");
    expect(process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR).toBe(data());
    stop();
    await request(pi);
    expect(process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR).toBeUndefined();
    expect(process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG).toBeUndefined();
    expect(existsSync(log())).toBe(false);
  });
}

test("200 MiB limit stops capture and clears provider env at once", async () => {
  const pi = await load();
  await pi.run("on");
  expect(process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR).toBe(data());
  // Sparse file: stat size is 200 MiB, but no content is written or read.
  const dummy = join(data(), "dummy.bin");
  writeFileSync(dummy, "");
  truncateSync(dummy, 200 * 1024 * 1024);
  await request(pi);
  expect(process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR).toBeUndefined();
  expect(process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG).toBeUndefined();
  expect(existsSync(log())).toBe(false);
  expect(pi.notes.some((n) => n.includes("200 MiB cap"))).toBe(true);
  expect(await pi.run("status")).toContain("OFF");
  await request(pi);
  await reply(pi);
  expect(existsSync(log())).toBe(false);
  expect(process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR).toBeUndefined();
});

test("pending requests stay bounded and drop the oldest first", async () => {
  state('{"enabled":true}');
  const pi = await load();
  for (let i = 0; i < 1000; i++) await request(pi);
  await reply(pi);
  const [first] = usage();
  expect(first).toBeGreaterThan(1);
  expect(first).toBeLessThanOrEqual(1000);
  await reply(pi);
  expect(usage()[1]).toBe(first + 1);
});

test("tracked sessions stay bounded and recent sessions still match", async () => {
  state('{"enabled":true}');
  const pi = await load();
  for (let i = 0; i < 1000; i++) await request(pi, `s${i}`);
  await reply(pi, "s0");
  await reply(pi, "s999");
  expect(usage()).toEqual([undefined, 1]);
});

test("non-assistant message_end does not consume a pending request", async () => {
  state('{"enabled":true}');
  const pi = await load();
  await request(pi);
  await pi.emit("message_end", { message: { role: "user" } });
  await reply(pi);
  expect(usage()).toEqual([1]);
});
