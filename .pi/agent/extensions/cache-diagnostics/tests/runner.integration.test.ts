// Loads index.ts through Pi's real jiti loader and dispatches through the real
// ExtensionRunner, proving the observer returns nothing that changes requests.
// Skipped when the installed Pi package is not found. No model calls.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE = process.env.PI_CODING_AGENT_PACKAGE
  ?? join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent");
const EXTENSIONS = join(PACKAGE, "dist/core/extensions");
const available = existsSync(join(EXTENSIONS, "runner.js"));
let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cache-diagnostics-runner-"));
  process.env.PI_CACHE_DIAGNOSTICS_ROOT = join(tmp, "diag");
});
afterEach(() => {
  delete process.env.PI_CACHE_DIAGNOSTICS_ROOT;
  rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!available)("real Pi loader and runner: requests pass through unchanged", async () => {
  const { loadExtensions, createExtensionRuntime } = await import(join(EXTENSIONS, "loader.js"));
  const { ExtensionRunner } = await import(join(EXTENSIONS, "runner.js"));
  const runtime = createExtensionRuntime();
  const loaded = await loadExtensions([join(import.meta.dir, "..", "index.ts")], tmp, undefined, runtime);
  expect(loaded.errors).toEqual([]);
  const registry = { find: (provider: string, id: string) => (provider === "openai" && id === "gpt-5.5" ? { promptCache: { short: 300 } } : undefined) };
  const runner = new ExtensionRunner(loaded.extensions, runtime, tmp, { getSessionId: () => "runner-session" }, registry);
  const errors: unknown[] = [];
  runner.onError?.((error: unknown) => errors.push(error));
  await runner.getCommand("cache-diagnostics").handler("on", runner.createCommandContext());

  const messages = [{ role: "system", content: "sys", timestamp: 1 }, { role: "user", content: "hi", timestamp: 2 }];
  const contextOut = await runner.emitContext(messages);
  expect(contextOut).toEqual(messages);
  let authRead = false;
  const headers: Record<string, string | null> = { "x-session-id": "s" };
  Object.defineProperty(headers, "authorization", { enumerable: true, get: () => { authRead = true; return "Bearer t"; } });
  expect(await runner.emitBeforeProviderHeaders(headers)).toBe(headers);
  expect(authRead).toBe(false);
  const payload = { model: "gpt-5.5", instructions: "sys", input: [{ role: "user", content: "hi" }], prompt_cache_key: "k" };
  const snapshot = JSON.stringify(payload);
  expect(await runner.emitBeforeProviderRequest(payload)).toBe(payload);
  expect(JSON.stringify(payload)).toBe(snapshot);
  const message = { role: "assistant", provider: "openai", model: "gpt-5.5", api: "openai-responses", stopReason: "stop", content: [],
    usage: { input: 10, output: 1, cacheRead: 90, cacheWrite: 0 } };
  const ended = await runner.emitMessageEnd({ type: "message_end", message });
  expect(ended === undefined || ended === message).toBe(true);
  expect(await runner.emitCacheWarmingDecision({ type: "cache_warming_decision", warmCost: 0, missCost: 1, continuationProbability: 1, action: "warm" })).toBe("warm");
  expect(errors).toEqual([]);

  const lines = readFileSync(join(tmp, "diag", "logs", "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const request = lines.find((record) => record.kind === "request");
  expect(request.pairing).toBe("single_request");
  expect(request.actual).toMatchObject({ provider: "openai", model: "gpt-5.5" });
  expect(request.usage).toMatchObject({ cacheRead: 90, verified: true, promptTokens: 100, readRatio: 0.9 });
});
