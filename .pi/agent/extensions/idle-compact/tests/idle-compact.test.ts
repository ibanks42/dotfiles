import { afterEach, afterAll, expect, test, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const host = process.env.PI_CODING_AGENT_PACKAGE ?? join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent");
const { convertToLlm } = await import(join(host, "dist/core/messages.js"));
mock.module("@earendil-works/pi-coding-agent", () => ({ convertToLlm }));
const tui = await import(join(host, "../pi-tui/dist/index.js"));
mock.module("@earendil-works/pi-tui", () => tui);
const { default: install, delayMs } = await import("../index");
const oldConfigPath = process.env.PI_IDLE_COMPACT_CONFIG;
const configDir = mkdtempSync(join(tmpdir(), "idle-compaction-"));
process.env.PI_IDLE_COMPACT_CONFIG = join(configDir, "settings.json");
afterAll(() => {
	if (oldConfigPath === undefined) delete process.env.PI_IDLE_COMPACT_CONFIG; else process.env.PI_IDLE_COMPACT_CONFIG = oldConfigPath;
	rmSync(configDir, { recursive: true, force: true });
});

const original = process.env.PI_IDLE_COMPACT_MINUTES;
afterEach(() => {
	if (original === undefined) delete process.env.PI_IDLE_COMPACT_MINUTES;
	else process.env.PI_IDLE_COMPACT_MINUTES = original;
});
function harness(tokens: number | null = 200_001) {
	const handlers = new Map<string, Function[]>();
	let calls = 0;
	const ctx = {
		model: { provider: "unmanaged", promptCache: { short: 300 } }, hasUI: false,
		isIdle: () => true, hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens }),
		compact: () => { calls++; },
	};
	install({ on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), registerCommand: () => {} } as any);
	return { ctx, emit: (name: string) => handlers.get(name)?.map(fn => fn({}, ctx)).find(result => result !== undefined), calls: () => calls };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
test("provider defaults and explicit override", () => {
	expect(delayMs({ provider: "claude-bridge" } as any, {})).toBe(54 * 60_000);
	expect(delayMs({ provider: "openai-codex" } as any, {})).toBe(270_000);
	expect(delayMs({ provider: "custom" } as any, {})).toBeUndefined();
	expect(delayMs({ promptCache: { short: 300 } } as any, {})).toBe(270_000);
	expect(delayMs({} as any, { PI_IDLE_COMPACT_MINUTES: "0" })).toBeUndefined();
});
test("requires strictly greater than threshold and known usage", async () => {
	process.env.PI_IDLE_COMPACT_MINUTES = "0.0001";
	for (const tokens of [null, 200_000, 10]) {
		const h = harness(tokens); h.emit("turn_start"); h.emit("agent_settled");
		await tick(); expect(h.calls()).toBe(0); h.emit("session_shutdown");
	}
});
test("waits for settlement, then attempts only once", async () => {
	process.env.PI_IDLE_COMPACT_MINUTES = "0.0001";
	const h = harness(); h.emit("turn_start");
	await tick(); expect(h.calls()).toBe(0);
	h.emit("agent_settled"); await tick(); expect(h.calls()).toBe(1);
	h.emit("session_compact_failed"); h.emit("agent_settled"); await tick(); expect(h.calls()).toBe(1);
});
test("new activity, shutdown, navigation and model changes cancel timers", async () => {
	process.env.PI_IDLE_COMPACT_MINUTES = "0.0001";
	for (const event of ["input", "agent_start", "session_shutdown", "session_tree", "model_select", "session_before_compact"]) {
		const h = harness(); h.emit("turn_start"); h.emit("agent_settled"); h.emit(event);
		await tick(); expect(h.calls()).toBe(0);
	}
});
test("rechecks busy and queued work at deadline", async () => {
	process.env.PI_IDLE_COMPACT_MINUTES = "0.0001";
	for (const key of ["isIdle", "hasPendingMessages"] as const) {
		const h = harness(); h.emit("turn_start"); h.emit("agent_settled");
		h.ctx[key] = () => key !== "isIdle";
		await tick(); expect(h.calls()).toBe(0);
	}
});
test("native warming deadline substitutes compaction without running inside hook", async () => {
	const h = harness(); h.emit("turn_start"); h.emit("agent_settled");
	expect(h.emit("cache_warming_decision")).toEqual({ action: "stop" });
	expect(h.calls()).toBe(0); await tick(); expect(h.calls()).toBe(1);
});
