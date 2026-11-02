import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { installKeepalive, keepalivePolicy } from "./codex-keepalive";
import { meetsMinimum, thresholdsFor, formatMinimum, showSettings } from "./settings";

/** Best-effort timing, not a provider cache-expiry guarantee. */
export function delayMs(model: ExtensionContext["model"], env = process.env): number | undefined {
	if (!model) return undefined;
	const override = env.PI_IDLE_COMPACT_MINUTES;
	if (override !== undefined) {
		const minutes = Number(override);
		return Number.isFinite(minutes) && minutes > 0 && minutes <= 1440 ? minutes * 60_000 : undefined;
	}
	if (model.provider === "claude-bridge") return 54 * 60_000;
	const tier = env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	const seconds = model.promptCache?.[tier];
	if (seconds && seconds > 0) return Math.min(seconds * 900, seconds * 1000 - 10_000);
	// Conservative heuristic for ChatGPT/Codex, not a published subscription SLA.
	if (model.provider === "openai-codex") return 4.5 * 60_000;
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let startedAt: number | undefined;
	let settled = false;
	let enabled = true;
	let compacting = false;
	let generation = 0;

	function clearTimer() {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}
	function reset() {
		clearTimer();
		startedAt = undefined;
		settled = false;
		compacting = false;
		generation++;
	}
	function eligible(ctx: ExtensionContext) {
		return enabled && settled && !compacting && ctx.isIdle() && !ctx.hasPendingMessages()
			&& meetsMinimum(ctx.getContextUsage()?.tokens, thresholdsFor(ctx.model)?.compactionMinimumTokens);
	}
	function compact(ctx: ExtensionContext) {
		if (!eligible(ctx)) return;
		clearTimer();
		startedAt = undefined; // One attempt per real request, including failures.
		compacting = true;
		const current = generation;
		const done = (error?: Error) => {
			if (current !== generation) return;
			compacting = false;
			if (ctx.hasUI) ctx.ui.notify(error ? `Idle compaction failed: ${error.message}` : "Idle compaction completed", error ? "error" : "info");
		};
		if (ctx.hasUI) ctx.ui.notify("Large context near estimated cache expiry: compacting while idle", "info");
		try {
			ctx.compact({ onComplete: () => done(), onError: done });
		} catch (error) {
			done(error instanceof Error ? error : new Error(String(error)));
		}
	}
	function schedule(ctx: ExtensionContext, dueAt?: number) {
		clearTimer();
		// Managed providers keep their cache alive first; the 60-minute horizon calls compact.
		if (keepalivePolicy(ctx.model)) return;
		const delay = delayMs(ctx.model);
		if (!eligible(ctx) || startedAt === undefined || delay === undefined || delay <= 0) return;
		const current = generation;
		// Defer even an overdue deadline: never compact inside a notification handler.
		timer = setTimeout(() => {
			timer = undefined;
			if (current === generation) compact(ctx);
		}, Math.max(0, (dueAt ?? startedAt + delay) - Date.now()));
		timer.unref();
	}

	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("session_tree", reset);
	pi.on("model_select", reset);
	pi.on("input", () => { settled = false; clearTimer(); });
	pi.on("before_agent_start", () => { settled = false; clearTimer(); });
	pi.on("agent_start", () => { settled = false; clearTimer(); });
	pi.on("turn_start", () => { startedAt = Date.now(); clearTimer(); });
	pi.on("agent_settled", (_event, ctx) => { settled = true; schedule(ctx); });
	pi.on("session_before_compact", () => { clearTimer(); startedAt = undefined; compacting = true; });
	pi.on("session_compact", () => { compacting = false; });
	pi.on("session_compact_failed", () => { compacting = false; });
	pi.on("cache_warming_decision", (_event, ctx) => {
		// Prefer Pi's real cache deadline when available; don't pay to warm a
		// large idle context that is about to be compacted instead.
		if (!keepalivePolicy(ctx.model) && eligible(ctx) && startedAt !== undefined && delayMs(ctx.model) !== undefined) {
			schedule(ctx, Date.now());
			return { action: "stop" };
		}
	});
	const keepalive = installKeepalive(pi, compact);
	pi.registerCommand("idle-compact", {
		description: "Idle cache settings: settings | status | on | off (defaults and per-model overrides)",
		handler: async (args, ctx) => {
			const action = args.trim() || "settings";
			if (action === "settings") {
				await showSettings(ctx, () => { keepalive.reconcile(ctx); schedule(ctx); });
				return;
			}
			if (!["on", "off", "status"].includes(action)) {
				ctx.ui.notify("Usage: /idle-compact [settings|status|on|off]", "warning");
				return;
			}
			if (action === "off") { enabled = false; clearTimer(); }
			if (action === "on") { enabled = true; schedule(ctx); }
			if (keepalivePolicy(ctx.model)) {
				ctx.ui.notify(`Idle compaction ${enabled ? "on" : "off"}; minimum ${formatMinimum(thresholdsFor(ctx.model)?.compactionMinimumTokens)}; compacts after the 60-minute keepalive horizon. See /idle-keepalive status.`, "info");
				return;
			}
			const delay = delayMs(ctx.model);
			ctx.ui.notify(`Idle compaction ${enabled ? "on" : "off"}; minimum ${formatMinimum(thresholdsFor(ctx.model)?.compactionMinimumTokens)}; timing ${delay === undefined ? "unknown (disabled for this model)" : `${delay / 60_000} min after request start`}; ${timer ? "scheduled" : "not scheduled"}`, "info");
		},
	});
}
