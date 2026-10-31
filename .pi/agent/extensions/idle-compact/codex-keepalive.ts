import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const INTERVAL = 4 * 60_000;
const HORIZON = 30 * 60_000;
const TIMEOUT = 20_000;
type Payload = { input: unknown[]; [key: string]: unknown };

/** Reuse the exact serialized prefix, not a reconstructed or shortened transcript. */
export function refreshPayload(payload: Payload): Payload {
	return {
		...structuredClone(payload),
		input: [...structuredClone(payload.input), {
			role: "user", content: [{ type: "input_text", text: "Cache keepalive only. Reply exactly OK. Do not perform any task or call tools." }],
		}],
		tool_choice: "none",
	};
}

export function installCodexKeepalive(pi: ExtensionAPI, compact: (ctx: ExtensionContext) => void) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let payload: Payload | undefined;
	let started = 0;
	let lastRefresh = 0;
	let settled = false;
	let enabled = true;
	let generation = 0;
	let cost = 0;
	let count = 0;
	let status = "waiting for a Codex request";
	const isCodex = (ctx: ExtensionContext) => ctx.model?.provider === "openai-codex";
	function cancel() {
		generation++;
		if (timer) clearTimeout(timer);
		timer = undefined;
		controller?.abort(); controller = undefined;
	}
	function reset() { cancel(); payload = undefined; started = 0; settled = false; }
	function idle(ctx: ExtensionContext) { return enabled && settled && isCodex(ctx) && ctx.isIdle() && !ctx.hasPendingMessages(); }
	function schedule(ctx: ExtensionContext) {
		if (!idle(ctx) || !started || timer || controller) return;
		const due = payload ? Math.min(lastRefresh + INTERVAL, started + HORIZON) : started + HORIZON;
		const version = generation;
		timer = setTimeout(() => {
			timer = undefined;
			if (version !== generation || !idle(ctx)) return;
			if (Date.now() >= started + HORIZON) {
				payload = undefined;
				started = 0;
				status = "30-minute limit reached";
				compact(ctx); // The caller rechecks the >200k threshold.
				return;
			}
			// Never pay to rebuild a cache after sleep/a badly delayed timer.
			if (Date.now() > due + 30_000) {
				payload = undefined; status = "missed refresh deadline"; schedule(ctx); return;
			}
			void refresh(ctx, version);
		}, Math.max(0, due - Date.now()));
		timer.unref();
		status = payload ? "scheduled" : "warming stopped; waiting for compaction horizon";
	}
	async function refresh(ctx: ExtensionContext, version: number) {
		if (!payload || !ctx.model) return;
		const request = refreshPayload(payload);
		const abort = new AbortController(); controller = abort;
		const timeout = setTimeout(() => abort.abort(), TIMEOUT); timeout.unref();
		status = "refreshing";
		try {
			// SSE avoids disturbing the foreground request's cached WebSocket state.
			// maxTokens is advisory: this installed Codex adapter ignores it.
			const result = await ctx.modelRegistry.streamSimple(ctx.model, { messages: [] }, {
				sessionId: ctx.sessionManager.getSessionId(), transport: "sse",
				maxTokens: 1, maxRetries: 0, signal: abort.signal,
				onPayload: () => request,
			}).result();
			if (generation !== version) return;
			cost += result.usage.cost.total; count++;
			// Custom metadata is not chat context. Pi does not include this in its
			// built-in usage total, so expose the separate total in our command.
			pi.appendEntry("codex-keepalive-usage", { usage: result.usage, stopReason: result.stopReason });
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				payload = undefined; status = "refresh failed; waiting for next real request";
			} else {
				lastRefresh = Date.now();
			}
		} catch {
			if (generation === version) { payload = undefined; status = "refresh failed; waiting for next real request"; }
		} finally {
			clearTimeout(timeout);
			if (generation === version) { controller = undefined; schedule(ctx); }
		}
	}
	pi.on("before_provider_request", (event, ctx) => {
		if (!isCodex(ctx) || !enabled) return;
		const body = event.payload as Partial<Payload> | null;
		if (!body || !Array.isArray(body.input) || body.model !== ctx.model?.id) return;
		cancel(); payload = structuredClone(body) as Payload;
		started = lastRefresh = Date.now();
	});
	pi.on("agent_settled", (_event, ctx) => { settled = true; schedule(ctx); });
	for (const name of ["input", "before_agent_start", "agent_start"] as const) {
		pi.on(name, () => { cancel(); settled = false; });
	}
	for (const name of ["session_start", "session_shutdown", "session_tree", "model_select", "session_before_compact"] as const) pi.on(name, reset);
	// We own Codex warming to avoid a second, uncapped native replay.
	pi.on("cache_warming_decision", (_event, ctx) => isCodex(ctx) ? { action: "stop" } : undefined);
	pi.registerCommand("codex-keepalive", {
		description: "Codex keepalive: status | on | off (4-minute refresh, 30-minute maximum)",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "off") { enabled = false; reset(); status = "off"; }
			else if (action === "on") { enabled = true; status = "waiting for next real request"; }
			else if (action !== "status") { ctx.ui.notify("Usage: /codex-keepalive [status|on|off]", "warning"); return; }
			ctx.ui.notify(`Codex keepalive ${enabled ? "on" : "off"}: ${status}. ${count} refresh responses, ~$${cost.toFixed(4)} since reload (separate from Pi totals; cancelled requests may have unreported usage).`, "info");
		},
	});
}
