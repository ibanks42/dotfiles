import { expect, test, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const host = process.env.PI_CODING_AGENT_PACKAGE ?? join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent");
const realTui = await import(join(host, "../pi-tui/dist/index.js"));
const { convertToLlm } = await import(join(host, "dist/core/messages.js"));
mock.module("@earendil-works/pi-tui", () => realTui);
mock.module("@earendil-works/pi-coding-agent", () => ({ convertToLlm }));
const { readSettings, saveSetting, resolveThresholds, thresholdsFor, settingsPath, parseMinimum, meetsMinimum, showSettings } = await import("../settings");
const { installKeepalive } = await import("../codex-keepalive");
const { default: install } = await import("../index");
let directory: string;
let previous: string | undefined;
beforeEach(() => {
	previous = process.env.PI_IDLE_COMPACT_CONFIG;
	directory = mkdtempSync(join(tmpdir(), "idle-settings-"));
	process.env.PI_IDLE_COMPACT_CONFIG = join(directory, "config.json");
});
afterEach(() => {
	if (previous === undefined) delete process.env.PI_IDLE_COMPACT_CONFIG; else process.env.PI_IDLE_COMPACT_CONFIG = previous;
	rmSync(directory, { recursive: true, force: true });
});

test("default floors and per-model overrides independently inherit each field", () => {
	expect(readSettings().defaults).toEqual({ keepaliveMinimumTokens: 100_000, compactionMinimumTokens: 200_000 });
	saveSetting(undefined, "keepaliveMinimumTokens", 50_000);
	saveSetting("openai-codex/astra", "keepaliveMinimumTokens", 25_000);
	saveSetting("openai-codex/astra", "compactionMinimumTokens", null);
	expect(resolveThresholds(readSettings(), "openai-codex/astra")).toEqual({ keepaliveMinimumTokens: 25_000, compactionMinimumTokens: null });
	expect(resolveThresholds(readSettings(), "openai-codex/sol")).toEqual({ keepaliveMinimumTokens: 50_000, compactionMinimumTokens: 200_000 });
	saveSetting("openai-codex/astra", "keepaliveMinimumTokens", "inherit");
	expect(resolveThresholds(readSettings(), "openai-codex/astra").keepaliveMinimumTokens).toBe(50_000);
	saveSetting("openai-codex/astra", "compactionMinimumTokens", "inherit");
	expect(readSettings().modelOverrides["openai-codex/astra"]).toBeUndefined();
	expect(JSON.parse(readFileSync(settingsPath(), "utf8")).defaults.keepaliveMinimumTokens).toBe(50_000);
});

test("custom granularity, no minimum, exact boundaries, and invalid input", () => {
	for (const [input, expected] of [["25k", 25_000], ["50k", 50_000], ["75k", 75_000], ["125000", 125_000], ["1.5m", 1_500_000], ["250,000", 250_000], ["0", null], ["No minimum", null]] as const) {
		expect(parseMinimum(input)).toBe(expected);
	}
	for (const value of ["-1", "1.5", "Infinity", "", "NaN", "9007199254740992"]) expect(() => parseMinimum(value)).toThrow();
	expect(meetsMinimum(25_000, 25_000)).toBe(false);
	expect(meetsMinimum(25_001, 25_000)).toBe(true);
	expect(meetsMinimum(0, null)).toBe(true);
	for (const tokens of [undefined, null, NaN, -1]) expect(meetsMinimum(tokens, null)).toBe(false);
	expect(meetsMinimum(500_000, undefined)).toBe(false);
});

test("invalid persisted config fails closed and is not silently overwritten", () => {
	writeFileSync(settingsPath(), '{"defaults":{"keepaliveMinimumTokens":-1}}');
	expect(thresholdsFor({ provider: "xai", id: "grok" } as any)).toBeUndefined();
	expect(() => saveSetting(undefined, "compactionMinimumTokens", 25_000)).toThrow();
	expect(readFileSync(settingsPath(), "utf8")).toContain('"keepaliveMinimumTokens":-1');
});

async function runtime(run: (h: any) => Promise<void>, whole = true) {
	let now = 1000;
	const timers = new Map<object, { due: number; fn: Function }>();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const set = spyOn(globalThis, "setTimeout").mockImplementation(((fn: Function, delay: number) => {
		const id = { unref() {} }; timers.set(id, { due: now + delay, fn }); return id;
	}) as any);
	const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: object) => timers.delete(id)) as any);
	try {
		const handlers = new Map<string, Function[]>();
		const h: any = { tokens: 50_000, calls: 0, compactions: 0 };
		const ctx = h.ctx = {
			model: { provider: "openai-codex", id: "astra" }, hasUI: false,
			getContextUsage: () => ({ tokens: h.tokens }), isIdle: () => true, hasPendingMessages: () => false,
			sessionManager: { getSessionId: () => "test" }, compact: (options: any) => { h.compactions++; options.onComplete(); },
			modelRegistry: { streamSimple: () => { h.calls++; return { result: async () => ({ stopReason: "stop", usage: { cost: { total: 0 } } }) }; } },
		};
		const pi: any = { on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), registerCommand() {}, appendEntry() {} };
		if (whole) install(pi); else h.control = installKeepalive(pi, () => h.compactions++);
		h.emit = (name: string, event = {}) => handlers.get(name)?.forEach(fn => fn(event, ctx));
		h.request = () => {
			h.emit("agent_start"); h.emit("turn_start");
			h.emit("before_provider_request", { payload: { model: "astra", input: [] } }); h.emit("agent_settled");
		};
		h.advance = async (ms: number) => {
			now += ms;
			for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
			await Promise.resolve(); await Promise.resolve();
		};
		await run(h); h.emit("session_shutdown");
	} finally { clock.mockRestore(); set.mockRestore(); clear.mockRestore(); }
}

test("25k keepalive minimum allows smaller contexts without lowering compaction minimum", () => runtime(async h => {
	saveSetting(undefined, "keepaliveMinimumTokens", 25_000);
	h.request(); await h.advance(240_000); expect(h.calls).toBe(1);
	await h.advance(56 * 60_000); expect(h.compactions).toBe(0);
}));

test("compaction can have a lower floor than keepalive and still gets its own horizon", () => runtime(async h => {
	saveSetting(undefined, "compactionMinimumTokens", 25_000);
	h.request(); await h.advance(240_000); expect(h.calls).toBe(0);
	await h.advance(56 * 60_000); expect(h.compactions).toBe(1);
}));

test("No minimum independently permits zero-size known contexts for both gates", () => runtime(async h => {
	saveSetting(undefined, "keepaliveMinimumTokens", null); saveSetting(undefined, "compactionMinimumTokens", null);
	h.tokens = 0; h.request(); await h.advance(240_000); expect(h.calls).toBe(1);
	await h.advance(56 * 60_000); expect(h.compactions).toBe(1);
}));

test("per-model minimums take effect at runtime, not just in the menu", () => runtime(async h => {
	saveSetting("openai-codex/astra", "keepaliveMinimumTokens", 25_000);
	h.request(); await h.advance(240_000); expect(h.calls).toBe(1);
}));

test("lowering the floor reconciles an existing captured request without extending its clock", () => runtime(async h => {
	h.request(); await h.advance(60_000); expect(h.calls).toBe(0);
	saveSetting(undefined, "keepaliveMinimumTokens", 25_000); h.control.reconcile(h.ctx);
	await h.advance(180_000); expect(h.calls).toBe(1);
}, false));

test("SettingsList menu saves a 25k preset, custom count, and model-specific No minimum", async () => {
	let changes = 0;
	const notices: string[] = [];
	const ctx: any = {
		mode: "tui", model: { provider: "openai-codex", id: "astra" },
		scopedModels: [{ model: { provider: "xai", id: "grok" } }],
		ui: {
			notify: (s: string) => notices.push(s),
			custom: async (factory: any) => {
				let closed = false;
				const component = factory({ requestRender() {} }, { fg: (_name: string, s: string) => s }, {}, () => { closed = true; });
				const down = () => component.handleInput("\x1b[B");
				const enter = () => component.handleInput("\r");
				component.render(80); down(); enter(); // Keepalive submenu.
				for (let i = 0; i < 3; i++) component.handleInput("\x1b[A"); enter(); // 100k -> 25k.
				expect(readSettings().defaults.keepaliveMinimumTokens).toBe(25_000);
				down(); enter(); // Compaction submenu, Custom is last of 12 choices.
				for (let i = 0; i < 5; i++) down();
				enter(); component.handleInput("\x01"); component.handleInput("\x0b"); component.handleInput("-1"); enter();
				expect(readSettings().defaults.compactionMinimumTokens).toBe(200_000);
				component.handleInput("\x01"); component.handleInput("\x0b"); component.handleInput("125k"); enter();
				expect(readSettings().defaults.compactionMinimumTokens).toBe(125_000);
				component.handleInput("\x1b[A"); component.handleInput("\x1b[A"); enter(); // Scope.
				down(); enter(); // First model, openai-codex/astra.
				down(); enter(); // Keepalive override submenu: inherit then No minimum.
				down(); enter();
				expect(readSettings().modelOverrides["openai-codex/astra"].keepaliveMinimumTokens).toBeNull();
				for (const width of [18, 30, 80]) {
					const lines = component.render(width); expect(lines.length).toBeGreaterThan(0);
					for (const line of lines) expect(realTui.visibleWidth(line)).toBeLessThanOrEqual(width);
				}
				enter(); component.handleInput("\x1b[A"); enter(); // No minimum -> Use default.
				expect(readSettings().modelOverrides["openai-codex/astra"]).toBeUndefined();
				component.handleInput("\x1b"); expect(closed).toBe(true);
			},
		},
	};
	await showSettings(ctx, () => { changes++; });
	expect(changes).toBe(4); expect(notices).toEqual([]);
});
