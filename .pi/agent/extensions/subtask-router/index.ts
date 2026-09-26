/**
 * Native Agent routing. Tintinweb owns execution, UI, sessions, and controls.
 * No subprocesses, independent result notifications, or duplicate task manager.
 */
import { Type, clampThinkingLevel } from "@earendil-works/pi-ai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentConfig } from "../../npm/node_modules/@tintinweb/pi-subagents/src/agent-types.ts";
import { inChildSessionContext } from "../../npm/node_modules/@tintinweb/pi-subagents/src/child-context.ts";
import {
  TIERS, THINKING, ROUTER_PROMPT, loadConfig, universe, key, resolvePattern, resolveOverride,
  pickModel, classify, ensureClaude, tierNeedsClaude, quotaBlock, quotaSummary, markRateLimited,
  type Route, type Thinking, type M,
} from "./policy.ts";
import { rpc } from "./rpc.ts";

interface NativeRecord { session?: { model?: M }; error?: string }
function nativeRecord(id: string): NativeRecord | undefined {
  const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
  return manager?.getRecord(id);
}

export default function (pi: ExtensionAPI) {
  // These two imports are the only private backend APIs. The backend is unpinned;
  // test after an upgrade. The guard must run at factory time: children share
  // the process/event bus, but must not expose stop controls for the parent's fleet.
  if (inChildSessionContext()) return;

  const decisions = new Map<string, Route & { model: string; effectiveThinking: string }>();
  let pending = 0;
  let offFailure: (() => void) | undefined;

  pi.registerTool({
    name: "stop_subagent",
    label: "Stop subagent",
    description: "Stop a running or queued native Agent by its exact agent ID. Partial work remains. Use get_subagent_result to inspect it.",
    promptSnippet: "Stop a running or queued subagent.",
    promptGuidelines: [
      "Delegate with Agent. A cheap router selects its model and thinking effort. Omit model and thinking unless the user explicitly requests them.",
      "Use run_in_background:true when you need to monitor or steer work. Use get_subagent_result for status, partial reports, or waiting.",
      "Use steer_subagent to redirect work or request a progress report. Use stop_subagent to stop it. Resume with Agent(resume: agent_id, prompt: ...).",
      "Give agents self-contained tasks. Parallel agents must not edit the same files.",
    ],
    parameters: Type.Object({ agent_id: Type.String({ description: "Exact ID returned by Agent (not an @handle)" }) }),
    async execute(_id, args, signal) {
      await rpc(pi.events, "stop", { agentId: args.agent_id }, signal);
      return {
        content: [{ type: "text", text: "Stop requested for " + args.agent_id + ". Inspect partial output with get_subagent_result." }],
        details: { agentId: args.agent_id },
      };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "Agent" || event.input.resume) return;
    const input = event.input;
    if (typeof input.prompt !== "string") return;
    const cfg = loadConfig();
    if (tierNeedsClaude(ctx, cfg)) void ensureClaude(cfg); // NEVER await Claude CLI.
    const available = universe(ctx);
    const definition = getAgentConfig(String(input.subagent_type ?? "general-purpose"));
    // User-authored frontmatter is authoritative in the backend. Validate its pins
    // too, rather than displaying a routed model that cannot actually take effect.
    const pinnedModel = definition?.model ?? (typeof input.model === "string" ? input.model : undefined);
    const pinnedThinking = definition?.thinking ?? input.thinking;
    if (pinnedThinking !== undefined && !THINKING.includes(pinnedThinking as Thinking)) {
      return { block: true, reason: "Unsupported thinking level: " + String(pinnedThinking) };
    }
    const modelOverride = pinnedModel ? resolveOverride(pinnedModel, available) : undefined;
    let route: Route;
    pending++;
    ctx.ui.setStatus("subtask-router", "Routing " + pending + " agent(s)…");
    try {
      // A model pin still needs an effort decision unless effort is pinned too.
      route = modelOverride && pinnedThinking !== undefined
        ? { tier: "low", thinking: pinnedThinking as Thinking, reason: "explicit model and effort", by: "caller/config" }
        : await classify(ctx, cfg, { task: input.prompt, description: String(input.description ?? "") }, ctx.signal);
      ctx.signal?.throwIfAborted();
      const selected = modelOverride ?? pickModel(ctx, cfg, route.tier, new Set()).model;
      const requested = (pinnedThinking as Thinking | undefined) ?? route.thinking;
      const effort = clampThinkingLevel(selected as any, requested);
      // Pi passes this same validated argument object to native Agent.execute.
      input.model = key(selected);
      input.thinking = effort;
      const decision = { ...route, model: key(selected), requestedThinking: requested, effectiveThinking: effort };
      decisions.set(event.toolCallId, decision);
      if (decisions.size > 200) decisions.delete(decisions.keys().next().value!);
      pi.appendEntry("subtask-routing", decision); // metadata, NOT a changing prompt prefix
      ctx.ui.notify((input.description || "Agent") + " → " + key(selected) + " · thinking " + effort
        + " · " + (pinnedModel ? "pinned model" : route.tier) + " (" + route.reason + ")", "info");
    } finally {
      pending--;
      ctx.ui.setStatus("subtask-router", pending ? "Routing " + pending + " agent(s)…" : undefined);
    }
  });

  // Attach route metadata without replacing native result details/renderers.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "Agent" && event.toolName !== "get_subagent_result") return;
    const routing = decisions.get(event.toolCallId);
    decisions.delete(event.toolCallId);
    const changes: any = {};
    if (routing) {
      changes.details = { ...(event.details as object ?? {}), routing };
      if (routing.usage) {
        const a = event.usage, b = routing.usage;
        changes.usage = {
          input: (a?.input ?? 0) + b.input, output: (a?.output ?? 0) + b.output,
          cacheRead: (a?.cacheRead ?? 0) + b.cacheRead, cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite,
          totalTokens: (a?.totalTokens ?? 0) + b.totalTokens,
          cost: Object.fromEntries(Object.keys(b.cost).map(k => [k, ((a?.cost as any)?.[k] ?? 0) + (b.cost as any)[k]])),
        };
      }
    }
    const limit = loadConfig().maxOutputChars;
    const text = (event.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
    if (text.length > limit) {
      const fullOutput = join(mkdtempSync(join(tmpdir(), "pi-agent-output-")), "output.txt");
      writeFileSync(fullOutput, text, { mode: 0o600 });
      changes.content = [{ type: "text", text: text.slice(0, limit) + "\n[Truncated. Full output: " + fullOutput + "]" },
        ...(event.content ?? []).filter(c => c.type !== "text")];
    }
    return changes;
  });

  pi.registerCommand("subtask-router", {
    description: "Routing policy and quota: prompt | test <task> | refresh",
    handler: async (args, ctx) => {
      const cfg = loadConfig();
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (sub === "prompt") {
        ctx.ui.notify(ROUTER_PROMPT, "info");
        return;
      }
      const refresh = ensureClaude(cfg, sub === "refresh");
      if (sub === "refresh") await refresh; // Only explicit refresh blocks.
      const models = universe(ctx);
      const router = resolvePattern(cfg.router.model, models);
      const lines = ["Backend: pi-subagents 0.19.0 · Agent + native UI and controls",
        "Router: " + (router ? key(router) : "unavailable; low-tier fallback") + " · " + cfg.router.thinking];
      for (const tier of TIERS) {
        lines.push(tier + ":");
        for (const pattern of cfg.tiers[tier].candidates) {
          const model = resolvePattern(pattern, models);
          const blocked = model && quotaBlock(model, cfg);
          lines.push("  " + (model ? (blocked ? "✗ " : "✓ ") + key(model) + (blocked ? " (" + blocked + ")" : "") : "· " + pattern + " (not in scope)"));
        }
      }
      lines.push("Claude quota: " + quotaSummary(), "Reasoning is classified separately for every task; native Pi clamps unsupported levels.");
      if (sub === "test" && rest.length) {
        const route = await classify(ctx, cfg, { task: rest.join(" ") }, ctx.signal);
        const selected = pickModel(ctx, cfg, route.tier, new Set()).model;
        lines.push("Test: " + route.tier + " → " + key(selected) + " · thinking "
          + (selected.reasoning === false ? "off" : route.thinking) + " (" + route.reason + ")");
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    decisions.clear();
    offFailure?.();
    offFailure = pi.events.on("subagents:failed", (raw: any) => {
      const record = nativeRecord(raw.id);
      const model = record?.session?.model;
      if (model) markRateLimited(model, String(raw.error ?? record?.error ?? ""), loadConfig());
      // Do not silently rerun a native Agent: it may already have changed files.
    });
    const cfg = loadConfig();
    if (tierNeedsClaude(ctx, cfg)) void ensureClaude(cfg);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    offFailure?.(); offFailure = undefined;
    decisions.clear();
    ctx.ui.setStatus("subtask-router", undefined);
  });
}
