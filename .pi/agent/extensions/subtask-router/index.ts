/**
 * Native Agent routing. Tintinweb owns execution, UI, sessions, and controls.
 * This extension picks the model and effort, retries rate-limited agents on the
 * next route, tracks who edited which file, and escalates weak results on request.
 * It also tracks delegation batches for the manual reviewer (/subtask-router review).
 */
import { Type, clampThinkingLevel } from "@earendil-works/pi-ai";
import { createReadOnlyTools, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentConfig } from "../../npm/node_modules/@tintinweb/pi-subagents/src/agent-types.ts";
import { inChildSessionContext } from "../../npm/node_modules/@tintinweb/pi-subagents/src/child-context.ts";
import {
  THINKING, ROUTER_PROMPT, loadConfig, configWarnings, universe, key, familyOf, resolveOverride, routeStates,
  pickRoute, needsClaude, ensureClaude, freshClaude, quotaSummary, markRateLimited, bumpStats, historyLine, parseRating,
  classify, fallbackRoute, findRoute, quotaBlock,
  type Config, type Thinking, type Kind, type Level, type M, type Route, type TaskInput, type ScoutTool, type AgentTypeSpec,
} from "./policy.ts";
import { REVIEWER_TYPE, REVIEWER_MODEL, REVIEWER_THINKING, BatchTracker, buildPacket, summarize } from "./reviewer.ts";
import { rpc } from "./rpc.ts";

interface NativeRecord {
  id: string; type?: string; description?: string; status?: string; result?: string; error?: string;
  toolUses?: number; toolCallId?: string; session?: { model?: M; messages?: any[] };
}
function nativeRecord(id: string): NativeRecord | undefined {
  const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
  return manager?.getRecord(id);
}

/** What the router needs to restart or escalate an agent. */
interface Launch {
  prompt: string; description: string; type: string; name?: string; route: string;
  thinking: Thinking; kind: Kind; level: Level; readOnly: boolean; family?: string; retries: number;
}

const MAX_RETRIES = 3;
const PROMPT_CAP = 20_000;
const REPORT_CAP = 12_000;

/** Path-like tokens in a prompt: "src/a.ts", "./x/y", "README.md". */
function mentionedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s\x60'"(\[])((?:~\/|\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z0-9]{1,8}|(?:~\/|\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)+)(?=[\s\x60'"),:;\]]|$)/g)) {
    out.add(m[1].replace(/^~\//, ""));
  }
  return [...out].slice(0, 200);
}

/** Family that the parent names in routing.reviewing: a configured model, a family, or a well-known name. */
function familyFromName(ref: string, cfg: Config): string | undefined {
  const r = ref.trim().toLowerCase();
  if (cfg.models[r]) return cfg.models[r].family;
  const families = new Set(Object.values(cfg.models).map(m => m.family.toLowerCase()));
  if (families.has(r)) return r;
  if (/claude|anthropic|opus|sonnet|fable|haiku/.test(r)) return "anthropic";
  if (/openai|codex|gpt|sol|luna|astra|terra/.test(r)) return "openai";
  return undefined;
}

const LEVEL_UP: Record<Thinking, Thinking> = { off: "low", minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max", max: "max" };

const isReviewerType = (t: unknown) => typeof t === "string" && t.trim().toLowerCase() === REVIEWER_TYPE;

export default function (pi: ExtensionAPI) {
  // These two imports are the only private backend APIs. The backend is unpinned;
  // test after an upgrade. The guard must run at factory time: children share
  // the process/event bus, but must not expose stop controls for the parent's fleet.
  if (inChildSessionContext()) return;

  const decisions = new Map<string, object>();
  /** Routed Agent calls by toolCallId, and router-started agents by agent ID. */
  const byToolCall = new Map<string, Launch>();
  const byAgent = new Map<string, Launch>();
  /** Absolute path -> family of the model whose agent last edited it. */
  const authors = new Map<string, string>();
  let cwd = process.cwd();
  let pending = 0;
  let current: ExtensionContext | undefined;
  const offs: Array<() => void> = [];
  /** Delegation batches: baseline, agents, evidence. The reviewer never adds to them. */
  const tracker = new BatchTracker({ record: id => nativeRecord(id), append: (type, data) => pi.appendEntry(type, data) });
  /** Reviewer agent ID -> reviewed batch ID. Reviewers are never routed, restarted, or escalated. */
  const reviews = new Map<string, string>();

  const launchFor = (id: string): Launch | undefined => {
    const own = byAgent.get(id);
    if (own) return own;
    const toolCallId = nativeRecord(id)?.toolCallId;
    return toolCallId ? byToolCall.get(toolCallId) : undefined;
  };

  const scoutTools = (ctx: ExtensionContext): ScoutTool[] | undefined => {
    try {
      const tools = createReadOnlyTools(ctx.cwd) as any[];
      const usable = tools.filter(t => typeof t?.execute === "function" && t.parameters);
      return usable.length ? usable : undefined;
    } catch { return undefined; }
  };

  const reviewAuthorFor = (cfg: Config, ctx: ExtensionContext, prompt: string, reviewing?: string): string | undefined => {
    if (reviewing) {
      const named = familyFromName(reviewing, cfg);
      if (named) return named;
    }
    const found = new Set<string>();
    for (const token of mentionedPaths(prompt)) {
      const abs = resolve(ctx.cwd, token);
      for (const [path, family] of authors) {
        if (path === abs || path.endsWith("/" + token.replace(/^\.\//, ""))) found.add(family);
      }
    }
    if (found.size === 1) return [...found][0];
    return familyOf(ctx.model as M | undefined, cfg);
  };

  /**
   * Start a router-owned agent and remember how it was launched. A restart joins the
   * failed agent's delegation batch; an escalation starts a new batch.
   */
  const spawn = async (launch: Launch, prompt: string, reason: string, restartOf?: string): Promise<string> => {
    const ticket = tracker.spawnTicket(restartOf ? "restart" : "escalation", cwd, restartOf);
    let id = "";
    try {
      const reply: any = await rpc(pi.events, "spawn", {
        type: launch.type, prompt,
        options: { description: launch.description, model: launch.route, thinkingLevel: launch.thinking, isBackground: true },
      }, undefined, 30_000);
      id = String(reply?.id ?? "");
      if (!id) throw new Error("pi-subagents returned no agent ID");
    } finally {
      ticket.done(id || undefined, { description: launch.description, type: launch.type, route: launch.route, thinking: launch.thinking, prompt });
    }
    byAgent.set(id, launch);
    pi.appendEntry("subtask-routing-spawn", { agentId: id, reason, reviewBatch: ticket.batchId, launch: { ...launch, prompt: prompt.slice(0, PROMPT_CAP) } });
    return id;
  };

  const tell = (content: string) => {
    current?.ui.notify(content, "info");
    try { void pi.sendMessage({ customType: "subtask-router", content, display: true }, { deliverAs: "followUp" }); } catch { /* UI note is enough */ }
  };

  pi.registerTool({
    name: "stop_subagent",
    label: "Stop subagent",
    description: "Stop a running or queued native Agent by its exact agent ID. Partial work remains. Use get_subagent_result to inspect it.",
    promptSnippet: "Stop a running or queued subagent.",
    promptGuidelines: [
      "Delegate with Agent. A router selects its model and thinking effort. Omit model and thinking unless the user explicitly requests them.",
      "Add a routing field to every new Agent call: routing: {level: \"trivial|routine|hard|extreme\", kind: \"implementation|debugging|review|research|docs|mechanical\", edits: true|false, why: \"one line: what makes this easy or hard\"}. For reviews, add reviewing: \"<model or family that wrote the code>\" when you know it. Rate from what you know about the code and the conversation, not from the prompt length.",
      "Use run_in_background:true when you need to monitor or steer work. Use get_subagent_result for status, partial reports, or waiting.",
      "Use steer_subagent to redirect work or request a progress report. Use stop_subagent to stop it. Resume with Agent(resume: agent_id, prompt: ...).",
      "If an agent's result is clearly insufficient, say so; the user can run /subtask-router escalate <agent_id> to redo it on a stronger model.",
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
    if (event.toolName !== "Agent") return;
    const input = event.input;
    if (!input.resume && isReviewerType(input.subagent_type)) {
      return { block: true, reason: REVIEWER_TYPE + " is manual-only. The user starts it with /subtask-router review." };
    }
    if (input.resume && reviews.has(String(input.resume))) {
      return { block: true, reason: "Reviewer agents are manual-only. The user starts a new review with /subtask-router review." };
    }
    if (typeof input.prompt !== "string") return;
    // Before any await: the first Agent call of a parent run snapshots the workspace.
    const reviewBatch = tracker.dispatch(event.toolCallId, ctx.cwd, {
      description: String(input.description ?? ""), type: String(input.subagent_type ?? "general-purpose"), prompt: input.prompt,
    });
    if (input.resume) return;
    let result: { block: true; reason: string } | undefined;
    try { result = await routeAgent(event, ctx, reviewBatch); }
    catch (e) { tracker.dispatchFailed(event.toolCallId); throw e; }
    if (result?.block) tracker.dispatchFailed(event.toolCallId);
    return result;
  });

  async function routeAgent(event: any, ctx: ExtensionContext, reviewBatch: string): Promise<{ block: true; reason: string } | undefined> {
    const input = event.input;
    let cfg: Config;
    try { cfg = loadConfig(); } catch (e: any) { return { block: true, reason: String(e?.message ?? e) }; }
    if (needsClaude(cfg)) void ensureClaude(cfg); // Refresh in the background; waited on briefly below.
    const models = universe(ctx);
    const type = String(input.subagent_type ?? "general-purpose");
    const definition = getAgentConfig(type);
    const typeKey = Object.keys(cfg.agentTypes).find(k => k.toLowerCase() === type.toLowerCase());
    const typeSpec: AgentTypeSpec | undefined = typeKey ? cfg.agentTypes[typeKey] : undefined;
    const rating = parseRating(input.routing);
    delete input.routing; // Router-only field; the backend does not declare it.
    // User-authored frontmatter is authoritative in the backend. Validate its pins
    // too, rather than displaying a routed model that cannot actually take effect.
    const pinnedModel = definition?.model ?? (typeof input.model === "string" ? input.model : undefined);
    const pinnedThinking = definition?.thinking ?? input.thinking;
    if (pinnedThinking !== undefined && !THINKING.includes(pinnedThinking as Thinking)) {
      return { block: true, reason: "Unsupported thinking level: " + String(pinnedThinking) };
    }
    let override: { name?: string; model?: M } | undefined;
    try { override = pinnedModel ? resolveOverride(pinnedModel, cfg, models) : undefined; }
    catch (e: any) { return { block: true, reason: String(e?.message ?? e) }; }
    const kind = rating?.kind ?? typeSpec?.kind;
    const task: TaskInput = {
      task: input.prompt, description: String(input.description ?? ""), agentType: type, typeSpec, rating,
      reviewAuthor: kind === "review" ? reviewAuthorFor(cfg, ctx, input.prompt, rating?.reviewing) : undefined,
    };

    pending++;
    ctx.ui.setStatus("subtask-router", "Routing " + pending + " agent(s)…");
    try {
      let route: Route;
      if (override && pinnedThinking !== undefined) {
        route = { level: rating?.level ?? "hard", kind: kind ?? "implementation", model: override.name ?? pinnedModel!,
          thinking: pinnedThinking as Thinking, reason: "explicit model and effort", by: "caller/config" };
      } else {
        try {
          route = await classify(ctx, cfg, task, { signal: ctx.signal, scoutTools: scoutTools(ctx) });
        } catch (e: any) {
          if (ctx.signal?.aborted) throw e;
          const why = "router failed: " + String(e?.message ?? e).slice(0, 100);
          const fb = fallbackRoute(cfg, task, why);
          if (!fb) return { block: true, reason: "Routing failed (" + why + ") and fallbackModel is not set in subtask-router.json." };
          route = fb;
        }
      }
      ctx.signal?.throwIfAborted();
      if (needsClaude(cfg)) await freshClaude(cfg); // At most claudeWaitMs.

      let selected: M, name: string | undefined, skipped: string[] = [];
      if (override?.model) { selected = override.model; name = override.name; }
      else {
        try { ({ model: selected, name, skipped } = pickRoute(override?.name ?? route.model, cfg, models)); }
        catch (e: any) { return { block: true, reason: String(e?.message ?? e) }; }
      }
      const requested = (pinnedThinking as Thinking | undefined) ?? route.thinking;
      const effort = clampThinkingLevel(selected as any, requested) as Thinking;
      // Pi passes this same validated argument object to native Agent.execute.
      input.model = key(selected);
      input.thinking = effort;

      const { usage: _usage, ...shown } = route;
      const decision = { ...route, modelName: name, model: key(selected), requestedThinking: requested, effectiveThinking: effort,
        rated: !!rating, reviewAuthor: task.reviewAuthor, skipped };
      decisions.set(event.toolCallId, decision);
      if (decisions.size > 200) decisions.delete(decisions.keys().next().value!);
      const launch: Launch = {
        prompt: input.prompt, description: String(input.description ?? "Agent"), type, name, route: key(selected),
        thinking: effort, kind: route.kind, level: route.level, readOnly: !!typeSpec?.readOnly,
        family: name ? cfg.models[name].family : familyOf(selected, cfg), retries: 0,
      };
      byToolCall.set(event.toolCallId, launch);
      if (name) bumpStats(name, route.kind, "routed");
      // Metadata, NOT a changing prompt prefix. The prompt copy lets escalate work after /reload.
      pi.appendEntry("subtask-routing", { ...shown, modelName: name, model: key(selected), requestedThinking: requested,
        effectiveThinking: effort, rated: !!rating, reviewAuthor: task.reviewAuthor, skipped, toolCallId: event.toolCallId,
        reviewBatch, launch: { ...launch, prompt: launch.prompt.slice(0, PROMPT_CAP) } });
      ctx.ui.notify((input.description || "Agent") + " → " + key(selected) + " · thinking " + effort
        + " · " + route.level + "/" + route.kind + (route.scout === "ok" ? " · scouted" : route.scout === "unsure" ? " · scout unsure" : "")
        + (rating ? "" : " · no parent rating") + " (" + route.reason + ")", "info");
    } finally {
      pending--;
      ctx.ui.setStatus("subtask-router", pending ? "Routing " + pending + " agent(s)…" : undefined);
    }
    return undefined;
  }

  // Attach route metadata without replacing native result details/renderers.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "Agent" && event.toolName !== "get_subagent_result") return;
    if (event.toolName === "Agent") {
      const agentId = (event.details as any)?.agentId;
      const id = typeof agentId === "string" && agentId ? agentId : undefined;
      const launch = byToolCall.get(event.toolCallId) ?? (id ? launchFor(id) : undefined);
      tracker.link(event.toolCallId, id, { route: launch?.route, thinking: launch?.thinking });
    }
    const routing: any = decisions.get(event.toolCallId);
    decisions.delete(event.toolCallId);
    const changes: any = {};
    if (routing) {
      const agentId = (event.details as any)?.agentId;
      const launch = byToolCall.get(event.toolCallId);
      if (typeof agentId === "string" && launch) {
        byAgent.set(agentId, launch);
        pi.appendEntry("subtask-routing-link", { toolCallId: event.toolCallId, agentId });
      }
      const { usage: _u, ...shown } = routing;
      changes.details = { ...(event.details as object ?? {}), routing: shown };
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
    let limit = 400_000;
    try { limit = loadConfig().maxOutputChars; } catch { /* keep default */ }
    const text = (event.content ?? []).filter(c => c.type === "text").map(c => (c as any).text).join("\n");
    if (text.length > limit) {
      const fullOutput = join(mkdtempSync(join(tmpdir(), "pi-agent-output-")), "output.txt");
      writeFileSync(fullOutput, text, { mode: 0o600 });
      changes.content = [{ type: "text", text: text.slice(0, limit) + "\n[Truncated. Full output: " + fullOutput + "]" },
        ...(event.content ?? []).filter(c => c.type !== "text")];
    }
    return changes;
  });

  /** Remember which model family edited which files, for the review rule. */
  const recordAuthorship = (id: string) => {
    const record = nativeRecord(id);
    const family = launchFor(id)?.family ?? (record?.session?.model ? familyOf(record.session.model, safeConfig()) : undefined);
    if (!family) return;
    for (const msg of record?.session?.messages ?? []) {
      if (msg?.role !== "assistant") continue;
      for (const c of msg.content ?? []) {
        if (c?.type === "toolCall" && (c.name === "edit" || c.name === "write") && typeof c.arguments?.path === "string") {
          authors.set(resolve(cwd, c.arguments.path), family);
        }
      }
    }
    if (authors.size > 5000) authors.delete(authors.keys().next().value!);
  };

  const safeConfig = (): Config => { try { return loadConfig(); } catch { return { models: {} } as any; } };

  /** Rate-limited agent: restart on the next route when that cannot duplicate edits. */
  const onFailed = async (raw: any) => {
    const record = nativeRecord(raw.id);
    const model = record?.session?.model;
    const error = String(raw.error ?? record?.error ?? "");
    let cfg: Config;
    try { cfg = loadConfig(); } catch { return; }
    if (!model || !(await markRateLimited(model, error, cfg))) return;
    const launch = launchFor(raw.id);
    if (!launch || !current) return;
    const toolUses = Number(raw.toolUses ?? record?.toolUses ?? 0);
    if (toolUses > 0 && !launch.readOnly) {
      tell("Agent " + raw.id + " (" + launch.description + ") hit a rate limit on " + launch.route + " after " + toolUses
        + " tool uses. It may have changed files, so the router did not restart it.");
      return;
    }
    if (launch.retries >= MAX_RETRIES) return;
    let pick;
    try { pick = pickRoute(launch.name ?? "", cfg, universe(current), new Set([launch.route])); }
    catch {
      tell("Agent " + raw.id + " (" + launch.description + ") hit a rate limit on " + launch.route + ". No other route is usable, so it was not restarted.");
      return;
    }
    let prompt = launch.prompt;
    if (toolUses > 0) {
      const partial = String(record?.result ?? "").trim();
      if (partial) {
        prompt += "\n\n[Router note] A previous run of this task stopped at a rate limit. Its partial findings follow."
          + " Continue from them instead of starting over.\n\n" + partial.slice(0, REPORT_CAP);
      }
    }
    const next: Launch = { ...launch, name: pick.name, route: key(pick.model), family: cfg.models[pick.name]?.family ?? launch.family,
      thinking: clampThinkingLevel(pick.model as any, launch.thinking) as Thinking, retries: launch.retries + 1 };
    try {
      const id = await spawn(next, prompt, "rate-limit retry of " + raw.id, raw.id);
      tell("Agent " + raw.id + " (" + launch.description + ") hit a rate limit on " + launch.route
        + ". The router restarted the task as agent " + id + " on " + next.route + ".");
    } catch (e: any) {
      tell("Agent " + raw.id + " hit a rate limit; the restart on " + next.route + " failed: " + String(e?.message ?? e).slice(0, 200));
    }
  };

  /** Rebuild launch records and review batches from session entries so escalate and review work after /reload. */
  const rebuild = (ctx: ExtensionContext) => {
    let entries: any[] = [];
    try { entries = (ctx.sessionManager as any).getEntries?.() ?? []; } catch { return; }
    for (const e of entries) {
      if (e?.type !== "custom") continue;
      const d = e.data;
      if (e.customType === "subtask-routing" && d?.toolCallId && d.launch) byToolCall.set(d.toolCallId, d.launch);
      if (e.customType === "subtask-routing-link" && d?.agentId && byToolCall.has(d.toolCallId)) byAgent.set(d.agentId, byToolCall.get(d.toolCallId)!);
      if (e.customType === "subtask-routing-spawn" && d?.agentId && d.launch) byAgent.set(d.agentId, d.launch);
      if (e.customType === "subtask-review-run" && typeof d?.agentId === "string") reviews.set(d.agentId, String(d.batchId));
    }
    tracker.rebuild(entries);
  };

  /**
   * Start the fixed reviewer on the latest delegation batch. No classifier, no route list,
   * no fallback: an unavailable model or a failed start ends the attempt.
   */
  async function review(focus: string, ctx: ExtensionContext): Promise<{ text: string; level: "info" | "warning" | "error" }> {
    const target = tracker.target();
    if ("refuse" in target) return { text: target.refuse, level: "warning" };
    const batch = target.batch;
    for (const [agentId, batchId] of reviews) {
      const status = nativeRecord(agentId)?.status;
      if (batchId === batch.meta.id && (status === "running" || status === "queued")) {
        return { text: "Reviewer " + agentId + " is already reviewing batch " + batch.meta.id + ".", level: "warning" };
      }
    }
    const model = (ctx.modelRegistry.getAvailable() as M[]).find(m => key(m) === REVIEWER_MODEL);
    if (!model) {
      return { level: "error", text: "The reviewer model " + REVIEWER_MODEL + " is not available: no authenticated model has this exact ID."
        + " The reviewer does not use another model or account. Log in to this provider, then run the command again." };
    }
    let blocked: string | undefined;
    try { blocked = quotaBlock(model, loadConfig()); } catch { blocked = undefined; }
    if (blocked) {
      return { level: "error", text: "The reviewer model " + REVIEWER_MODEL + " is blocked: " + blocked + "."
        + " The reviewer does not use another model or account. Run the command again after the limit resets." };
    }
    const analysis = tracker.analyze(batch);
    const summary = summarize(analysis);
    const notes = analysis.notes.length ? "\n" + analysis.notes.map(n => "! " + n).join("\n") : "";
    if (!analysis.files.some(f => f.status === "verified" || f.status === "operations")) {
      return { level: "warning", text: "Batch " + batch.meta.id + " has no attributed file changes to review (" + summary + ")." + notes };
    }
    const packet = buildPacket(batch.meta, analysis, focus);
    const file = tracker.savePacket(batch, packet.text);
    // The Model object, not a string: the backend resolves strings fuzzily and across providers.
    const reply: any = await rpc(pi.events, "spawn", {
      type: REVIEWER_TYPE, prompt: packet.text,
      options: { description: "Review of delegation batch " + batch.meta.id, model, thinkingLevel: REVIEWER_THINKING, isBackground: true, isolated: true },
    }, undefined, 30_000);
    const id = String(reply?.id ?? "");
    if (!id) throw new Error("pi-subagents returned no agent ID");
    reviews.set(id, batch.meta.id);
    pi.appendEntry("subtask-review-run", { agentId: id, batchId: batch.meta.id, model: REVIEWER_MODEL, thinking: REVIEWER_THINKING,
      coverage: analysis.coverage, packet: file });
    return { level: analysis.coverage === "complete" ? "info" : "warning",
      text: "Reviewer " + id + " started on " + REVIEWER_MODEL + " · thinking " + REVIEWER_THINKING + " for batch " + batch.meta.id
        + " (" + batch.meta.agents.length + " agent(s)). " + summary + "." + notes
        + (packet.redactions ? "\nRedacted " + packet.redactions + " secret-like value(s) from the packet." : "")
        + (packet.truncated ? "\nThe packet reached its size limit; some evidence is named only." : "")
        + "\nPacket: " + file };
  }

  async function escalate(id: string, ctx: ExtensionContext): Promise<string> {
    const cfg = loadConfig();
    const record = nativeRecord(id);
    const launch = launchFor(id);
    if (!launch) return "No routing record for agent " + id + ". Only routed agents from this session can be escalated.";
    if (record && (record.status === "running" || record.status === "queued")) return "Agent " + id + " is still " + record.status + ". Stop it or wait for it first.";
    if (!launch.name || !cfg.models[launch.name]) return "Agent " + id + " ran on " + launch.route + ", which is not a configured model.";
    // Without a stronger model, escalation re-runs the same model one thinking level higher.
    const target = cfg.models[launch.name].stronger ?? launch.name;
    if (target === launch.name && LEVEL_UP[launch.thinking] === launch.thinking) {
      return launch.name + " has no stronger model and already runs at " + launch.thinking + " thinking.";
    }
    const pick = pickRoute(target, cfg, universe(ctx));
    const report = String(record?.result ?? "").trim()
      || (() => { // After /reload the live record is gone; use the backend's persisted record.
        const entries: any[] = (ctx.sessionManager as any).getEntries?.() ?? [];
        const saved = entries.filter(e => e?.type === "custom" && e.customType === "subagents:record" && e.data?.id === id).pop();
        return String(saved?.data?.result ?? "").trim();
      })();
    const prompt = launch.prompt + "\n\n[Router note] A previous agent on " + launch.route + " attempted this task, and its result was judged insufficient."
      + " It may already have changed files: check the current state before you edit."
      + (report ? " Its final report follows.\n\n" + report.slice(0, REPORT_CAP) : " It left no report.");
    const next: Launch = { ...launch, name: pick.name, route: key(pick.model), family: cfg.models[pick.name].family,
      thinking: clampThinkingLevel(pick.model as any, LEVEL_UP[launch.thinking]) as Thinking, retries: 0 };
    if (next.route === launch.route && next.thinking === launch.thinking) {
      return launch.name + " has no stronger model and does not support more than " + launch.thinking + " thinking.";
    }
    const newId = await spawn(next, prompt, "escalation of " + id);
    bumpStats(launch.name, launch.kind, "escalated");
    const msg = "Escalated agent " + id + " (" + launch.description + ") from " + launch.route + " to " + next.route
      + " · thinking " + next.thinking + ". New agent: " + newId + ".";
    try { await pi.sendMessage({ customType: "subtask-router", content: msg, display: true }, { deliverAs: "followUp" }); } catch { /* notify below */ }
    return msg;
  }

  pi.registerCommand("subtask-router", {
    description: "Routing policy and quota: prompt | test <task> | refresh | escalate <agent-id> | eval [router-route] [thinking] | review [focus]",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (sub === "review") {
        try { const r = await review(rest.join(" "), ctx); ctx.ui.notify(r.text, r.level); }
        catch (e: any) {
          ctx.ui.notify("The reviewer did not start: " + String(e?.message ?? e) + ". It does not retry on another model.", "error");
        }
        return;
      }
      let cfg: Config;
      try { cfg = loadConfig(); } catch (e: any) { ctx.ui.notify(String(e?.message ?? e), "error"); return; }
      if (sub === "prompt") { ctx.ui.notify(ROUTER_PROMPT, "info"); return; }
      if (sub === "escalate") {
        if (!rest[0]) { ctx.ui.notify("Usage: /subtask-router escalate <agent-id>", "warning"); return; }
        try { ctx.ui.notify(await escalate(rest[0], ctx), "info"); }
        catch (e: any) { ctx.ui.notify("Escalation failed: " + String(e?.message ?? e), "error"); }
        return;
      }
      if (sub === "eval") {
        const { runEval } = await import("./eval/eval.ts");
        const router = rest[0] ? { model: rest[0], thinking: (rest[1] ?? cfg.router.thinking) as Thinking } : undefined;
        ctx.ui.notify("Running the routing test set" + (router ? " with " + router.model + " · " + router.thinking : "") + "…", "info");
        try { ctx.ui.notify(await runEval(ctx, cfg, { router, scoutTools: scoutTools(ctx) }), "info"); }
        catch (e: any) { ctx.ui.notify("Eval failed: " + String(e?.message ?? e), "error"); }
        return;
      }
      const refresh = ensureClaude(cfg, sub === "refresh");
      if (sub === "refresh") await refresh; // Only explicit refresh blocks.
      const models = universe(ctx);
      const router = findRoute(cfg.router.model, models);
      const lines = ["Backend: pi-subagents · Agent + native UI and controls",
        "Router: " + (router ? key(router) : cfg.router.model + " (unavailable)") + " · " + cfg.router.thinking
          + " · scout " + cfg.scout.maxTurns + " turns/" + cfg.scout.timeoutMs / 1000 + "s at a " + cfg.scout.levelGap + "-level gap",
        "Fallback model: " + (cfg.fallbackModel ?? "not set"),
        "Reviewer: " + REVIEWER_MODEL + " · " + REVIEWER_THINKING + " · manual (/subtask-router review)"
          + (findRoute(REVIEWER_MODEL, models) ? "" : " (unavailable)")];
      for (const [name, spec] of Object.entries(cfg.models)) {
        const hist = historyLine(name);
        lines.push(name + " (" + spec.family + ")" + (spec.fallback ? " → fallback " + spec.fallback : "") + (spec.stronger ? " · stronger " + spec.stronger : "") + (hist ? " · " + hist : ""));
        for (const r of routeStates(name, cfg, models)) lines.push("  " + (r.block ? (r.model ? "✗ " : "· ") : "✓ ") + r.route + (r.block ? " (" + r.block + ")" : ""));
      }
      const warnings = configWarnings(cfg, models);
      if (warnings.length) lines.push("Warnings:", ...warnings.map(w => "  ! " + w));
      lines.push("Claude quota: " + quotaSummary());
      if (sub === "test" && rest.length) {
        const task: TaskInput = { task: rest.join(" ") };
        try {
          const route = await classify(ctx, cfg, task, { signal: ctx.signal, scoutTools: scoutTools(ctx) });
          const pick = pickRoute(route.model, cfg, models);
          lines.push("Test: " + route.level + "/" + route.kind + " → " + route.model + " (" + key(pick.model) + ") · thinking "
            + clampThinkingLevel(pick.model as any, route.thinking) + (route.scout ? " · scout " + route.scout : "") + " (" + route.reason + ")");
        } catch (e: any) { lines.push("Test failed: " + String(e?.message ?? e)); }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    current = ctx;
    cwd = ctx.cwd;
    decisions.clear(); byToolCall.clear(); byAgent.clear(); authors.clear(); reviews.clear(); tracker.reset();
    while (offs.length) offs.pop()!();
    rebuild(ctx);
    offs.push(pi.events.on("subagents:failed", (raw: any) => {
      recordAuthorship(raw.id);
      // The batch stays unfinished until the restart decision is made.
      const release = tracker.hold(raw.id);
      tracker.settled(raw.id);
      // Do not silently rerun an agent that may have changed files; see onFailed.
      void onFailed(raw).catch(() => {}).finally(release);
    }));
    offs.push(pi.events.on("subagents:completed", (raw: any) => {
      recordAuthorship(raw.id);
      tracker.settled(raw.id);
    }));
    let cfg: Config;
    try { cfg = loadConfig(); } catch (e: any) { ctx.ui.notify("subtask-router: " + String(e?.message ?? e), "error"); return; }
    if (needsClaude(cfg)) void ensureClaude(cfg);
    const warnings = configWarnings(cfg, universe(ctx));
    if (warnings.length) ctx.ui.notify("subtask-router:\n" + warnings.map(w => "! " + w).join("\n"), "warning");
  });
  // A parent run groups its Agent calls into one delegation batch.
  pi.on("agent_start", () => { tracker.beginRun(); });
  pi.on("agent_end", () => { tracker.endRun(); });
  pi.on("session_shutdown", (_event, ctx) => {
    while (offs.length) offs.pop()!();
    decisions.clear();
    current = undefined;
    ctx.ui.setStatus("subtask-router", undefined);
  });
}

export { mentionedPaths, familyFromName };

