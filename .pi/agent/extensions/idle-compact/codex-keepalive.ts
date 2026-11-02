import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { meetsMinimum, thresholdsFor, formatMinimum } from "./settings";

/** User-selected fallback, not a provider retention guarantee. */
export const CACHE_TTL = 5 * 60_000;
const HORIZON = 60 * 60_000;
const TIMEOUT = 20_000;
const INSTRUCTION = "Cache keepalive only. Reply exactly OK. Do not perform any task or call tools.";
type Payload = Record<string, unknown>;
type Model = ExtensionContext["model"];
export type Policy = { ttl: number; interval: number; basis: "subscription" | "assumed" };

/** Explicit approved routes only; do not invent defaults for other providers. */
export function keepalivePolicy(model: Model, env = process.env): Policy | undefined {
	if (model?.provider === "claude-bridge") {
		if (env.FORCE_PROMPT_CACHING_5M === "1" || env.CLAUDE_CODE_PROMPT_CACHE_TTL === "5m") {
			return { ttl: CACHE_TTL, interval: 4 * 60_000, basis: "assumed" };
		}
		return { ttl: 60 * 60_000, interval: 50 * 60_000, basis: "subscription" };
	}
	if (model && ["openai-codex", "xai", "opencode-go"].includes(model.provider)) {
		return { ttl: CACHE_TTL, interval: 4 * 60_000, basis: "assumed" };
	}
	return undefined;
}

/** Reuse the serialized prefix when available; never mutate the real request. */
export function refreshPayload(payload: Payload, api = "openai-codex-responses"): Payload {
	const copy = structuredClone(payload);
	if (Array.isArray(copy.input)) {
		copy.input.push({ role: "user", content: [{ type: "input_text", text: INSTRUCTION }] });
		copy.tool_choice = "none";
	} else if (Array.isArray(copy.messages)) {
		copy.messages.push({ role: "user", content: api === "anthropic-messages" ? [{ type: "text", text: INSTRUCTION }] : INSTRUCTION });
		copy.tool_choice = api === "anthropic-messages" ? { type: "none" } : "none";
	} else if (Array.isArray(copy.contents)) {
		copy.contents.push({ role: "user", parts: [{ text: INSTRUCTION }] });
	} else {
		throw new Error("Unsupported keepalive payload shape");
	}
	return copy;
}

export function installKeepalive(pi: ExtensionAPI, compact: (ctx: ExtensionContext) => void,
	policyFor: (model: Model) => Policy | undefined = keepalivePolicy) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let payload: Payload | undefined;
	let context: Context | undefined;
	let modelKey: string | undefined;
	let reasoning: SimpleStreamOptions["reasoning"];
	let started: number | undefined;
	let lastRefresh = 0;
	let settled = false;
	let enabled = true;
	let generation = 0;
	let cost = 0;
	let count = 0;
	let status = "waiting for a real request";
	const key = (ctx: ExtensionContext) => ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
	function cancel() {
		generation++;
		if (timer) clearTimeout(timer);
		timer = undefined;
		controller?.abort(); controller = undefined;
	}
	function reset() {
		cancel(); payload = undefined; context = undefined; modelKey = undefined;
		started = undefined; settled = false; status = "waiting for a real request";
	}
	function idle(ctx: ExtensionContext) {
		return enabled && settled && !!policyFor(ctx.model) && key(ctx) === modelKey
			&& ctx.isIdle() && !ctx.hasPendingMessages();
	}
	function schedule(ctx: ExtensionContext) {
		const policy = policyFor(ctx.model);
		if (!policy || !idle(ctx) || started === undefined || timer || controller) return;
		const limits = thresholdsFor(ctx.model), tokens = ctx.getContextUsage()?.tokens;
		const warm = (payload || context) && meetsMinimum(tokens, limits?.keepaliveMinimumTokens);
		if (!warm && !meetsMinimum(tokens, limits?.compactionMinimumTokens)) return;
		const due = warm ? Math.min(lastRefresh + policy.interval, started + HORIZON) : started + HORIZON;
		const version = generation;
		timer = setTimeout(() => {
			timer = undefined;
			if (version !== generation || !idle(ctx) || started === undefined) return;
			if (Date.now() >= started + HORIZON) {
				payload = undefined; context = undefined; started = undefined;
				status = "60-minute limit reached";
				compact(ctx); // Caller separately checks its configurable compaction minimum.
				return;
			}
			if (!meetsMinimum(ctx.getContextUsage()?.tokens, thresholdsFor(ctx.model)?.keepaliveMinimumTokens)) {
				schedule(ctx); return;
			}
			const margin = Math.min(30_000, (policy.ttl - policy.interval) / 2);
			if (Date.now() > due + margin) {
				payload = undefined; context = undefined; status = "missed refresh deadline"; schedule(ctx); return;
			}
			void refresh(ctx, version);
		}, Math.max(0, due - Date.now()));
		timer.unref();
		if (warm) status = "scheduled";
		else status = "warming ineligible/stopped; waiting for compaction horizon";
	}
	async function refresh(ctx: ExtensionContext, version: number) {
		if ((!payload && !context) || !ctx.model) return;
		const model = ctx.model;
		const abort = new AbortController(); controller = abort;
		const timeout = setTimeout(() => abort.abort(), TIMEOUT); timeout.unref();
		status = "refreshing";
		try {
			const request = payload && refreshPayload(payload, model.api);
			const logical: Context = context ? structuredClone(context) : { messages: [] };
			if (context) logical.messages.push({ role: "user", content: INSTRUCTION, timestamp: Date.now() });
			const result = await ctx.modelRegistry.streamSimple(model, logical, {
				sessionId: ctx.sessionManager.getSessionId(), reasoning, toolChoice: "none",
				...(model.provider === "openai-codex" ? { transport: "sse" as const } : {}),
				// Preserve original output/thinking settings for non-Codex prefix reuse.
				// Codex ignores maxTokens: instruction + abort are best effort, not a cap.
				...(model.provider === "openai-codex" ? { maxTokens: 1 } : {}),
				maxRetries: 0, signal: abort.signal,
				...(request ? { onPayload: () => request } : {}),
			}).result();
			if (generation !== version) return;
			cost += result.usage.cost.total; count++;
			pi.appendEntry("idle-keepalive-usage", {
				provider: model.provider, model: model.id, usage: result.usage, stopReason: result.stopReason,
			});
			if (result.stopReason === "error" || result.stopReason === "aborted" || abort.signal.aborted) {
				payload = undefined; context = undefined; status = "refresh failed; waiting for next real request";
			} else lastRefresh = Date.now();
		} catch {
			if (generation === version) {
				payload = undefined; context = undefined; status = "refresh failed; waiting for next real request";
			}
		} finally {
			clearTimeout(timeout);
			if (generation === version) { controller = undefined; schedule(ctx); }
		}
	}
	pi.on("context_with_system", (event, ctx) => {
		if (!enabled || !policyFor(ctx.model) || controller) return;
		cancel(); payload = undefined;
		context = { messages: structuredClone(convertToLlm(event.messages)) };
		modelKey = key(ctx);
		const level = pi.getThinkingLevel(); reasoning = level === "off" ? undefined : level;
		started = lastRefresh = Date.now();
		status = "waiting for settlement";
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !policyFor(ctx.model) || controller) return;
		const body = event.payload as Payload | null;
		if (!body || !(Array.isArray(body.input) || Array.isArray(body.messages) || Array.isArray(body.contents))) return;
		if (typeof body.model === "string" && body.model !== ctx.model?.id) return;
		// With context hooks this is the same request, not a new idle horizon.
		if (!context) { cancel(); started = lastRefresh = Date.now(); modelKey = key(ctx); }
		payload = structuredClone(body);
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason)) {
			payload = undefined; context = undefined; status = "real request failed; waiting for next real request";
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		settled = true;
		if (!meetsMinimum(ctx.getContextUsage()?.tokens, thresholdsFor(ctx.model)?.keepaliveMinimumTokens)) {
			status = "below configured minimum, unknown context, or invalid settings";
		}
		schedule(ctx);
	});
	const activity = () => { cancel(); settled = false; };
	pi.on("input", activity);
	pi.on("before_agent_start", activity);
	pi.on("agent_start", activity);
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("session_tree", reset);
	pi.on("model_select", reset);
	pi.on("session_before_compact", reset);
	// Own warming on these routes, avoiding duplicate or uncapped native refreshes.
	pi.on("cache_warming_decision", (_event, ctx) => policyFor(ctx.model) ? { action: "stop" } : undefined);
	const command: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description: "Provider-aware idle keepalive: status | on | off (configured minimum, maximum 60m)",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "off") { enabled = false; reset(); status = "off"; }
			else if (action === "on") { enabled = true; status = "waiting for next real request"; }
			else if (action !== "status") { ctx.ui.notify("Usage: /idle-keepalive [status|on|off]", "warning"); return; }
			const policy = policyFor(ctx.model);
			const timing = policy ? `${policy.basis} TTL ${policy.ttl / 60_000}m; refresh ${policy.interval / 60_000}m` : "no policy for this provider";
			ctx.ui.notify(`Idle keepalive ${enabled ? "on" : "off"}: ${status}; ${timing}; horizon 60m; minimum ${formatMinimum(thresholdsFor(ctx.model)?.keepaliveMinimumTokens)}. ${count} refresh responses, ~$${cost.toFixed(4)} since reload (separate from Pi totals; cancelled usage may be unreported).`, "info");
		},
	};
	pi.registerCommand("idle-keepalive", command);
	pi.registerCommand("codex-keepalive", command); // Compatibility alias.
	return { reconcile(ctx: ExtensionContext) { cancel(); schedule(ctx); } };
}

/** Compatibility export for Codex-only consumers and existing regression tests. */
export function installCodexKeepalive(pi: ExtensionAPI, compact: (ctx: ExtensionContext) => void) {
	installKeepalive(pi, compact, model => model?.provider === "openai-codex" ? keepalivePolicy(model) : undefined);
}
