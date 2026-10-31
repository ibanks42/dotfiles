import { expect, test, spyOn } from "bun:test";
import { installCodexKeepalive, refreshPayload } from "../codex-keepalive";

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
		for (let i = 0; i < 6; i++) await advance(240_000);
		expect(calls).toBe(7); expect(compactions).toBe(0);
		await advance(120_000); expect(compactions).toBe(1);
		await advance(240_000); expect(calls).toBe(7); expect(entries.length).toBe(7);
		request(); emit("agent_settled"); emit("input"); await advance(240_000); expect(calls).toBe(7);
		request(); emit("agent_settled"); fail = true;
		await advance(240_000); expect(calls).toBe(8);
		await advance(240_000); expect(calls).toBe(8);
		await advance(22 * 60_000); expect(compactions).toBe(2);
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
