import { expect, test, spyOn, mock, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Resolve the real host helper for standalone Bun tests outside Pi's loader.
const PACKAGE = process.env.PI_CODING_AGENT_PACKAGE ?? join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent");
const { convertToLlm } = await import(join(PACKAGE, "dist/core/messages.js"));
mock.module("@earendil-works/pi-coding-agent", () => ({ convertToLlm }));
const tui = await import(join(PACKAGE, "../pi-tui/dist/index.js"));
mock.module("@earendil-works/pi-tui", () => tui);
const { CACHE_TTL, installCodexKeepalive, installKeepalive, keepalivePolicy, refreshPayload } = await import("../codex-keepalive");
const oldConfigPath = process.env.PI_IDLE_COMPACT_CONFIG;
const configDir = mkdtempSync(join(tmpdir(), "idle-policy-"));
process.env.PI_IDLE_COMPACT_CONFIG = join(configDir, "settings.json");
afterAll(() => {
	if (oldConfigPath === undefined) delete process.env.PI_IDLE_COMPACT_CONFIG; else process.env.PI_IDLE_COMPACT_CONFIG = oldConfigPath;
	rmSync(configDir, { recursive: true, force: true });
});

test("refresh preserves prefix and cache key without mutating the original", () => {
	const original = { model: "test", input: [{ role: "user", content: "hello" }], prompt_cache_key: "session", tools: [{ name: "bash" }] };
	const refreshed = refreshPayload(original);
	expect(refreshed.input.slice(0, -1)).toEqual(original.input);
	expect(original.input.length).toBe(1);
	expect(refreshed.prompt_cache_key).toBe("session");
	expect(refreshed.tools).toEqual(original.tools);
	expect(refreshed.tool_choice).toBe("none");
});

test("bounded hidden refreshes, cancellation, failure and compaction handoff", async () => {
	let now = 1000;
	const timers = new Map<object, { due: number; fn: Function }>();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const set = spyOn(globalThis, "setTimeout").mockImplementation(((fn: Function, delay: number) => {
		const id = { unref() {} }; timers.set(id, { due: now + delay, fn }); return id;
	}) as any);
	const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: object) => timers.delete(id)) as any);
	try {
		const handlers = new Map<string, Function[]>();
		const entries: unknown[] = [];
		let calls = 0, compactions = 0;
		let fail = false;
		let hold = false;
		let finish: (() => void) | undefined;
		let signal: AbortSignal | undefined;
		const ctx = {
			model: { provider: "openai-codex", id: "test" }, isIdle: () => true, hasPendingMessages: () => false,
			getContextUsage: () => ({ tokens: 200_001 }),
			sessionManager: { getSessionId: () => "session" },
			modelRegistry: { streamSimple: (_model: unknown, context: any, options: any) => {
				calls++; signal = options.signal; expect(context.messages).toEqual([]);
				expect(options.transport).toBe("sse");
				expect(options.onPayload().input.length).toBe(2);
				return { result: async () => {
					if (hold) await new Promise<void>(resolve => { finish = resolve; });
					return { stopReason: fail ? "error" : "stop", usage: { cost: { total: 0.01 } } };
				} };
			} },
		};
		installCodexKeepalive({ on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), registerCommand() {}, appendEntry: (...args: unknown[]) => entries.push(args) } as any, () => compactions++);
		const emit = (name: string, event = {}) => handlers.get(name)?.forEach(fn => fn(event, ctx));
		const advance = async (ms: number) => {
			now += ms;
			for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
			await Promise.resolve(); await Promise.resolve();
		};
		const request = () => emit("before_provider_request", { payload: { model: "test", input: [{ role: "user", content: "hello" }] } });
		request(); await advance(240_000); expect(calls).toBe(0); // Not settled.
		emit("agent_settled"); await advance(0); expect(calls).toBe(1);
		for (let i = 0; i < 13; i++) await advance(240_000);
		expect(calls).toBe(14); expect(compactions).toBe(0);
		await advance(240_000); expect(compactions).toBe(1);
		await advance(240_000); expect(calls).toBe(14); expect(entries.length).toBe(14);
		request(); emit("agent_settled"); emit("input"); await advance(240_000); expect(calls).toBe(14);
		request(); emit("agent_settled"); fail = true;
		await advance(240_000); expect(calls).toBe(15);
		await advance(240_000); expect(calls).toBe(15);
		await advance(52 * 60_000); expect(compactions).toBe(2);
		fail = false; hold = true;
		request(); emit("agent_settled"); await advance(240_000);
		expect(signal?.aborted).toBe(false);
		emit("input"); expect(signal?.aborted).toBe(true);
		const recorded = entries.length;
		finish?.(); await advance(0);
		expect(entries.length).toBe(recorded); // No stale writes after cancellation.
		expect(timers.size).toBe(0);
		request(); emit("agent_settled"); await advance(240_000);
		await advance(20_000); expect(signal?.aborted).toBe(true);
		emit("session_shutdown"); finish?.(); await advance(0);
		expect(timers.size).toBe(0);
	} finally { clock.mockRestore(); set.mockRestore(); clear.mockRestore(); }
});

async function harness(run: (h: any) => Promise<void>, installer = installCodexKeepalive) {
	let now = 1000;
	const timers = new Map<object, { fn: Function; due: number }>();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const set = spyOn(globalThis, "setTimeout").mockImplementation(((fn: Function, delay: number) => {
		const id = { unref() {} }; timers.set(id, { fn, due: now + delay }); return id;
	}) as any);
	const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: object) => timers.delete(id)) as any);
	try {
		const handlers = new Map<string, Function[]>();
		const h: any = { calls: 0, compactions: 0, tokens: 100_001, busy: false, pending: false };
		const ctx = h.ctx = {
			model: { provider: "openai-codex", id: "any-codex-model-without-ttl" },
			getContextUsage: () => ({ tokens: h.tokens }), isIdle: () => !h.busy, hasPendingMessages: () => h.pending,
			sessionManager: { getSessionId: () => "session" },
			modelRegistry: { streamSimple: () => {
				h.calls++;
				return { result: async () => ({ stopReason: "stop", usage: { cost: { total: 0 } } }) };
			} },
		};
		installer({
			on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
			registerCommand() {}, appendEntry() {},
		} as any, () => h.compactions++);
		h.emit = (name: string, event = {}) => handlers.get(name)?.forEach(fn => fn(event, ctx));
		h.request = () => {
			h.emit("agent_start");
			h.emit("before_provider_request", { payload: { model: ctx.model.id, input: [] } });
			h.emit("agent_settled");
		};
		h.advance = async (ms: number) => {
			now += ms;
			for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
			await Promise.resolve(); await Promise.resolve();
		};
		await run(h);
	} finally { clock.mockRestore(); set.mockRestore(); clear.mockRestore(); }
}

test("Codex policy: 5-minute assumed TTL, refresh only strictly above 100k known context", () => harness(async h => {
	expect(CACHE_TTL).toBe(300_000);
	for (const tokens of [null, 0, 100_000]) {
		h.tokens = tokens; h.request(); await h.advance(240_000); expect(h.calls).toBe(0);
	}
	h.tokens = 100_001; h.request();
	await h.advance(239_999); expect(h.calls).toBe(0);
	await h.advance(1); expect(h.calls).toBe(1);
}));

test("every Codex model eligible, non-Codex providers remain untouched", () => harness(async h => {
	for (const provider of ["claude-bridge", "opencode-go", "xai", "zai", "agy", "new-provider"]) {
		h.ctx.model.provider = provider; h.request(); await h.advance(240_000); expect(h.calls).toBe(0);
	}
	h.ctx.model.provider = "openai-codex";
	h.ctx.model.id = "future-codex-model"; h.request(); await h.advance(240_000); expect(h.calls).toBe(1);
}));

test("threshold, busy and pending checks repeat at deadline", () => harness(async h => {
	for (const [field, value] of [["tokens", 100_000], ["busy", true], ["pending", true]]) {
		h.request(); const old = h[field]; h[field] = value;
		await h.advance(240_000); expect(h.calls).toBe(0); h[field] = old;
	}
}));

test("late timer cannot pay to rebuild cache; waits for fixed 60-minute horizon", () => harness(async h => {
	h.tokens = 200_001; h.request(); await h.advance(270_001); expect(h.calls).toBe(0);
	await h.advance(60 * 60_000 - 270_001); expect(h.compactions).toBe(1);
	await h.advance(60 * 60_000); expect(h.compactions).toBe(1); expect(h.calls).toBe(0);
}));

test("new real request resets horizon, keepalive responses do not", () => harness(async h => {
	h.request(); await h.advance(240_000); expect(h.calls).toBe(1);
	h.request();
	for (let i = 0; i < 14; i++) await h.advance(240_000);
	expect(h.compactions).toBe(0);
	await h.advance(240_000); expect(h.compactions).toBe(1);
}));

test("approved policies are provider-specific; unknown providers have no invented default", () => {
	for (const provider of ["openai-codex", "xai", "opencode-go"]) {
		expect(keepalivePolicy({ provider } as any)).toEqual({ ttl: 300_000, interval: 240_000, basis: "assumed" });
	}
	expect(keepalivePolicy({ provider: "claude-bridge" } as any)).toEqual({ ttl: 3_600_000, interval: 3_000_000, basis: "subscription" });
	expect(keepalivePolicy({ provider: "other" } as any)).toBeUndefined();
	expect(keepalivePolicy(undefined)).toBeUndefined();
	for (const env of [{ FORCE_PROMPT_CACHING_5M: "1" }, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }]) {
		expect(keepalivePolicy({ provider: "claude-bridge" } as any, env)).toEqual({ ttl: 300_000, interval: 240_000, basis: "assumed" });
	}
});

test("xAI and Go refresh at four minutes; bridge only at fifty, stops at sixty", async () => {
	for (const provider of ["xai", "opencode-go", "claude-bridge"]) {
		await harness(async h => {
			h.ctx.model.provider = provider; h.request();
			const interval = provider === "claude-bridge" ? 3_000_000 : 240_000;
			await h.advance(interval - 1); expect(h.calls).toBe(0);
			await h.advance(1); expect(h.calls).toBe(1);
			if (provider === "claude-bridge") {
				await h.advance(600_000); expect(h.calls).toBe(1); expect(h.compactions).toBe(1);
			}
		}, installKeepalive);
	}
});

test("non-Codex serialized formats append transient instruction without rewriting original prefix", () => {
	const messages = { messages: [{ role: "system", content: "stable" }], tools: [{ name: "tool" }] };
	const replay = refreshPayload(messages, "openai-completions");
	expect((replay.messages as unknown[]).slice(0, -1)).toEqual(messages.messages);
	expect(messages.messages).toHaveLength(1); expect(replay.tools).toEqual(messages.tools);
	expect(replay.tool_choice).toBe("none");
	const google = { contents: [{ role: "user", parts: [{ text: "stable" }] }], config: { thinkingConfig: { thinkingLevel: "HIGH" } } };
	const next = refreshPayload(google, "google-generative-ai");
	expect((next.contents as unknown[]).slice(0, -1)).toEqual(google.contents);
	expect(google.contents).toHaveLength(1); expect(next.config).toEqual(google.config);
});

test.skipIf(!existsSync(join(PACKAGE, "dist/core/extensions/loader.js")))("real Pi loader: bridge logical-only capture, timing, usage, and compaction threshold", async () => {
	const { loadExtensions, createExtensionRuntime } = await import(join(PACKAGE, "dist/core/extensions/loader.js"));
	const runtime = createExtensionRuntime();
	const entries: any[] = [];
	runtime.getThinkingLevel = () => "high";
	runtime.appendEntry = (...args: any[]) => entries.push(args);
	const loaded = await loadExtensions([join(import.meta.dir, "..", "index.ts")], process.cwd(), undefined, runtime);
	expect(loaded.errors).toEqual([]);
	const handlers = loaded.extensions[0].handlers;
	let now = 1000, calls = 0, compactions = 0;
	let tokens = 200_001;
	const timers = new Map<object, { due: number; fn: Function }>();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const set = spyOn(globalThis, "setTimeout").mockImplementation(((fn: Function, delay: number) => {
		const id = { unref() {} }; timers.set(id, { due: now + delay, fn }); return id;
	}) as any);
	const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: object) => timers.delete(id)) as any);
	const ctx: any = {
		model: { provider: "claude-bridge", id: "claude-opus-5-5", api: "claude-bridge" }, hasUI: false,
		isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens }),
		sessionManager: { getSessionId: () => "same-session" }, compact: (options: any) => { compactions++; options.onComplete(); },
		modelRegistry: { streamSimple: (_model: any, context: any, options: any) => {
			calls++; expect(context.messages[0].content).toBe("stable system");
			expect(context.messages).toHaveLength(3); expect(options.sessionId).toBe("same-session");
			expect(options.reasoning).toBe("high"); expect(options.transport).toBeUndefined();
			return { result: async () => ({ stopReason: "stop", usage: { cacheRead: 200_000, cost: { total: 0.02 } } }) };
		} },
	};
	const emit = async (name: string, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
	const advance = async (ms: number) => {
		now += ms;
		for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
		await Promise.resolve(); await Promise.resolve();
	};
	const messages = [{ role: "system", content: "stable system", timestamp: 1 }, { role: "user", content: "question", timestamp: 2 }];
	const request = async () => {
		await emit("agent_start"); await emit("turn_start"); await emit("context_with_system", { messages });
		await emit("agent_settled");
	};
	try {
		await request(); await advance(54 * 60_000); // Too late for dispatch: no cold rebuild.
		expect(calls).toBe(0); await advance(6 * 60_000); expect(compactions).toBe(1);
		await request(); await advance(50 * 60_000); expect(calls).toBe(1);
		expect(messages).toHaveLength(2); expect(entries).toHaveLength(1);
		expect(entries[0][0]).toBe("idle-keepalive-usage"); expect(entries[0][1].usage.cacheRead).toBe(200_000);
		await advance(10 * 60_000); expect(compactions).toBe(2); expect(calls).toBe(1);
		tokens = 150_000; await request(); await advance(50 * 60_000); expect(calls).toBe(2);
		await advance(10 * 60_000); expect(compactions).toBe(2); // Keepalive threshold != compaction threshold.
		await emit("session_shutdown"); expect(timers.size).toBe(0);
	} finally { clock.mockRestore(); set.mockRestore(); clear.mockRestore(); }
});
