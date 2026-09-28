// Metadata-only prompt-cache diagnostics for every provider and session.
//
// Observer only: every handler returns undefined and never mutates payloads,
// headers, messages or settings. No model calls, no keepalive, no raw capture.
// Disabled by default; `/cache-diagnostics on` enables it for all Pi processes.
// See README.md for hook order, record schema and coverage limits.
import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  compare, fingerprintContext, fingerprintPayload, Hasher, headerAffinity, parseFingerprint,
  type Fingerprint, type Hash, type View,
} from "./fingerprint.ts";
import { buildReport } from "./report.ts";
import { ALLOWED_KEYS, ENUMS, sanitize, STOPS } from "./schema.ts";
import * as store from "./store.ts";

const PROCESS_RUN = Symbol.for("pi.cache-diagnostics.process-run");
/** One random id per OS process, shared by every extension instance in it. Identity only, no state. */
function processRun(): string {
  // SAFETY: globalThis is an ordinary object; only this symbol-keyed slot is used.
  const scope = globalThis as unknown as Record<symbol, unknown>;
  if (typeof scope[PROCESS_RUN] !== "string") scope[PROCESS_RUN] = randomBytes(8).toString("hex");
  return scope[PROCESS_RUN] as string;
}

const MAX_TRACKS = 64;
const MAX_MARKERS = 32;
const STALE_ATTEMPT_MS = 30 * 60_000;
/** pi-ai adapters whose `usage.input` was verified (source) to exclude cacheRead and cacheWrite. */
const VERIFIED_USAGE_APIS = new Set([
  "anthropic-messages", "openai-responses", "openai-codex-responses", "azure-openai-responses",
  "openai-completions", "google-generative-ai", "google-vertex", "bedrock-converse-stream",
]);
const COMPLETED = new Set(["stop", "length", "toolUse"]);

type HeaderHashes = Record<string, Hash | "deleted">;
interface Baseline {
  v: 1; session: string; at: number; run: string;
  lastCompletedAt: number | null; lastStop: string | null;
  model: string | null; provider: string | null;
  promptTokens: number | null; cacheRead: number | null;
  payload: Fingerprint | null; context: Fingerprint | null; headers: HeaderHashes | null;
}
interface Attempt {
  id: number; at: number; context?: View; payload?: View; payloads: number; headers?: HeaderHashes;
  statuses: number[]; requested: Label | null; ambiguous: boolean;
}
interface Track {
  sessionH: string; open: Attempt[]; pendingHeaders?: HeaderHashes | "ambiguous"; markers: string[]; prompt: boolean;
  warm: { decisions: number; proposedWarm: number; proposedStop: number; candidates: number; pending: boolean };
  unanchored: number; stale: boolean; baseline?: Baseline; baselineSource: "none" | "memory" | "disk"; loaded: boolean;
}
interface Label { provider?: string; model?: string; h: string }

function parseBaseline(value: unknown): Baseline | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  const hex = (x: unknown) => x === null || (typeof x === "string" && /^[0-9a-f]{12,24}$/.test(x));
  const num = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x));
  if (b.v !== 1 || typeof b.session !== "string" || !/^[0-9a-f]{24}$/.test(b.session)) return undefined;
  if (typeof b.run !== "string" || !/^[0-9a-f]{16}$/.test(b.run) || typeof b.at !== "number") return undefined;
  if (!num(b.lastCompletedAt) || !num(b.promptTokens) || !num(b.cacheRead) || !hex(b.model) || !hex(b.provider)) return undefined;
  if (b.lastStop !== null && !(typeof b.lastStop === "string" && STOPS.has(b.lastStop))) return undefined;
  const payload = b.payload === null ? null : parseFingerprint(b.payload);
  const context = b.context === null ? null : parseFingerprint(b.context);
  if (payload === undefined || context === undefined) return undefined;
  const headers = b.headers;
  if (headers !== null && !(headers && typeof headers === "object" && Object.entries(headers).every(([name, hash]) =>
    ALLOWED_KEYS.has(name) && (hash === "deleted" || hex(hash))))) return undefined;
  // SAFETY: every Baseline field was validated above; nested fingerprints by parseFingerprint.
  return { ...(b as unknown as Baseline), payload, context };
}

export default function cacheDiagnostics(pi: ExtensionAPI): void {
  const run = processRun();
  const instance = randomBytes(6).toString("hex");
  const tracks = new Map<string, Track>(); // keyed by raw session id, memory only
  let lastEnabled: boolean | undefined;
  let warned = false;
  let sequence = 0;
  let attemptIds = 0;

  function active(): store.Control | undefined {
    const control = store.readControl();
    if (control.enabled !== lastEnabled) { tracks.clear(); lastEnabled = control.enabled; }
    return control.enabled ? control : undefined;
  }
  function warn(ctx: any): void {
    if (warned) return;
    warned = true;
    try { ctx.ui.notify("Cache diagnostics could not record an observation; requests are unchanged.", "warning"); } catch { /* no UI */ }
  }
  /** Runs an observation; any failure drops that session's pairing state and never propagates. */
  function guard(ctx: any, body: (control: store.Control, hasher: Hasher, track: Track) => void): void {
    let id: string | undefined;
    try {
      const control = active();
      if (!control) return;
      const key = store.loadKey(true);
      if (!key) return;
      id = ctx.sessionManager.getSessionId();
      if (typeof id !== "string" || !id) return;
      const hasher = new Hasher(key, store.limits().hashChars);
      body(control, hasher, trackFor(id, hasher));
    } catch {
      if (id !== undefined) tracks.delete(id);
      warn(ctx);
    }
  }
  function trackFor(id: string, hasher: Hasher): Track {
    let track = tracks.get(id);
    if (!track) {
      track = {
        sessionH: hasher.id("session", id), open: [], markers: [], prompt: false,
        warm: { decisions: 0, proposedWarm: 0, proposedStop: 0, candidates: 0, pending: false },
        unanchored: 0, stale: false, baselineSource: "none", loaded: false,
      };
      while (tracks.size >= MAX_TRACKS) tracks.delete(tracks.keys().next().value!);
    }
    tracks.delete(id); tracks.set(id, track); // least recently used first
    if (!track.loaded) {
      track.loaded = true;
      const baseline = store.readState(track.sessionH, parseBaseline);
      if (baseline && baseline.session === track.sessionH) { track.baseline = baseline; track.baselineSource = "disk"; }
    }
    return track;
  }
  function label(ctx: any, hasher: Hasher, provider: unknown, model: unknown, allowed: Set<string>): Label | null {
    if (typeof provider !== "string" || typeof model !== "string") return null;
    const result: Label = { h: hasher.id("model", `${provider}\0${model}`, 16) };
    // Plain names only when the live registry knows this exact provider/model pair.
    try {
      if (ctx.modelRegistry?.find?.(provider, model)) { result.provider = provider; result.model = model; allowed.add(provider); allowed.add(model); }
    } catch { /* registry unavailable: hash only */ }
    return result;
  }
  function emit(track: Track, kind: string, fields: Record<string, unknown>, allowed = new Set<string>()): void {
    const record = { v: 1, kind, at: Date.now(), run, inst: instance, seq: ++sequence, session: track.sessionH, ...fields };
    store.appendRecord(sanitize(record, allowed));
  }
  function marker(ctx: any, name: string, detail: Record<string, unknown> = {}, allowed?: Set<string>): void {
    guard(ctx, (_control, _hasher, track) => {
      if (track.markers.length < MAX_MARKERS) track.markers.push(name);
      emit(track, "marker", { marker: name, ...detail }, allowed);
    });
  }
  function closeUnfinished(track: Track, attempt: Attempt, reason: string): void {
    emit(track, "unfinished", {
      reason, layers: layers(attempt), payloads: attempt.payloads, responses: attempt.statuses.length,
    });
    track.stale = true;
  }
  const layers = (attempt: Attempt) => [...(attempt.context ? ["context"] : []), ...(attempt.payload ? ["provider_payload"] : [])];

  // ------------------------------------------------------------ request side

  pi.on("before_agent_start", (_event, ctx) => {
    guard(ctx, (_control, _hasher, track) => { track.prompt = true; });
  });

  pi.on("context_with_system", (event, ctx) => {
    guard(ctx, (_control, hasher, track) => {
      const now = Date.now();
      // A proposed warm that never produced a payload (later handler said stop,
      // refresh skipped, auth failed) must not capture this real request. Headers
      // left by a provider without payload hooks (e.g. the Claude bridge) are dropped.
      track.warm.pending = false;
      track.pendingHeaders = undefined;
      for (const attempt of track.open.filter((item) => now - item.at > STALE_ATTEMPT_MS)) closeUnfinished(track, attempt, "stale");
      track.open = track.open.filter((item) => now - item.at <= STALE_ATTEMPT_MS);
      const allowed = new Set<string>();
      const requested = label(ctx, hasher, ctx.model?.provider, ctx.model?.id, allowed);
      const thinking = (() => { try { return String(pi.getThinkingLevel()); } catch { return "unknown"; } })();
      const options: Record<string, string> = { thinking };
      if (requested) options.model = requested.h;
      const attempt: Attempt = {
        id: ++attemptIds, at: now, context: fingerprintContext(hasher, event.messages, options), payloads: 0,
        statuses: [], requested, ambiguous: false,
      };
      // Another request of this session is still open: neither can be paired safely.
      if (track.open.length > 0) { attempt.ambiguous = true; for (const other of track.open) other.ambiguous = true; }
      track.open.push(attempt);
    });
  });

  pi.on("before_provider_headers", (event, ctx) => {
    guard(ctx, (_control, hasher, track) => {
      // Fires in auth setup before the provider builds its own headers and payload.
      // Two header events before one payload cannot be attributed; attach neither.
      track.pendingHeaders = track.pendingHeaders ? "ambiguous" : headerAffinity(hasher, event.headers);
    });
  });

  pi.on("cache_warming_decision", (event, ctx) => {
    guard(ctx, (_control, _hasher, track) => {
      const proposed = event.action === "warm" || event.action === "stop" ? event.action : "unknown";
      track.warm.decisions++;
      if (proposed === "warm") { track.warm.proposedWarm++; track.warm.pending = true; }
      if (proposed === "stop") track.warm.proposedStop++;
      const round = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : null);
      // Later handlers can still override `action`; only the proposal at this position is observable.
      emit(track, "marker", {
        marker: "warming_decision", proposed, warmCost: round(event.warmCost), missCost: round(event.missCost),
        continuationProbability: round(event.continuationProbability),
      });
    });
  });

  pi.on("before_provider_request", (event, ctx) => {
    guard(ctx, (_control, hasher, track) => {
      const view = fingerprintPayload(hasher, event.payload);
      const headers = track.pendingHeaders === "ambiguous" ? undefined : track.pendingHeaders;
      track.pendingHeaders = undefined;
      const free = track.open.filter((attempt) => attempt.payloads === 0);
      if (track.open.length === 1 && free.length === 1 && !track.warm.pending) {
        const attempt = free[0];
        attempt.payload = view; attempt.payloads = 1; attempt.headers = headers;
        return;
      }
      // No agent context event precedes this payload (or its attempt already sent one):
      // a cache-warm replay, a provider-internal re-send, or a side call. Never paired with usage.
      const warmCandidate = track.warm.pending && free.length === 0;
      track.warm.pending = false;
      if (warmCandidate) track.warm.candidates++;
      else { track.unanchored++; for (const attempt of track.open) attempt.ambiguous = true; }
      const baseline = track.baseline?.payload ?? undefined;
      const cmp = compare(baseline, view);
      emit(track, "unanchored_request", {
        classification: warmCandidate ? "warm_candidate" : "unknown",
        evidence: { warmDecisionPending: warmCandidate, openAttempts: track.open.length },
        format: view.fp.format, complete: view.fp.complete,
        vsBaseline: { prefix: cmp.prefix, messages: cmp.messages, system: cmp.system, tools: cmp.tools, options: cmp.options },
        plain: view.plain,
      });
    });
  });

  pi.on("after_provider_response", (event, ctx) => {
    guard(ctx, (_control, _hasher, track) => {
      const sent = track.open.filter((attempt) => attempt.payload);
      const status = typeof event.status === "number" && Number.isInteger(event.status) ? event.status : 0;
      // Provider-internal retries produce several responses for one payload.
      if (sent.length === 1 && sent[0].statuses.length < 16) sent[0].statuses.push(status);
      else if (sent.length !== 1) track.stale = true;
    });
  });

  // ------------------------------------------------------------ response side

  pi.on("message_end", (event, ctx) => {
    const message = event.message as any;
    if (message?.role !== "assistant") return;
    guard(ctx, (control, hasher, track) => {
      const now = Date.now();
      const allowed = new Set<string>();
      const stop = typeof message.stopReason === "string" && STOPS.has(message.stopReason) ? message.stopReason : "other";
      const actual = label(ctx, hasher, message.provider, message.model, allowed);
      const responseModel = typeof message.responseModel === "string" && message.responseModel !== message.model
        ? hasher.id("model", `${message.provider}\0${message.responseModel}`, 16) : null;
      const providerH = typeof message.provider === "string" ? hasher.id("provider", message.provider, 16) : null;
      const api = typeof message.api === "string" && ENUMS.has(message.api) ? message.api : "other";
      const usage = usageView(ctx, message, api);

      let pairing: "single_request" | "context_only" | "ambiguous" | "unpaired";
      let attempt: Attempt | undefined;
      if (track.open.length === 0) pairing = "unpaired";
      else if (track.open.length === 1 && !track.open[0].ambiguous && track.open[0].payloads <= 1) {
        attempt = track.open.pop()!;
        pairing = attempt.payload ? "single_request" : "context_only";
      } else {
        // Which open request produced this response is unknowable: drop one slot
        // without choosing, keep the rest ambiguous, and make no causal claim.
        pairing = "ambiguous";
        track.open.pop();
        for (const other of track.open) other.ambiguous = true;
      }

      const baseline = track.baseline;
      const common = {
        pairing, stop, api, actual, responseModel, usage,
        markers: track.markers, prompt: track.prompt, warming: { ...track.warm, pending: undefined },
        unanchored: track.unanchored,
      };
      if (!attempt) {
        emit(track, "response", common, allowed);
        track.stale = true;
      } else {
        const payloadCmp = attempt.payload ? compare(baseline?.payload ?? undefined, attempt.payload) : undefined;
        const contextCmp = attempt.context ? compare(baseline?.context ?? undefined, attempt.context) : undefined;
        const headerStatus = attempt.headers && baseline?.headers
          ? Object.fromEntries([...new Set([...Object.keys(attempt.headers), ...Object.keys(baseline.headers)])].map((name) => {
            const a = baseline.headers![name], b = attempt!.headers![name];
            return [name, a === undefined ? "added" : b === undefined ? "removed" : a === null || b === null ? "unknown" : a === b ? "same" : "changed"];
          })) : null;
        const lastCompletedAt = baseline?.lastCompletedAt ?? null;
        const boundary = lastCompletedAt === null ? "unknown" : track.prompt ? "user_turn"
          : baseline?.lastStop === "toolUse" ? "tool_boundary" : "other_continuation";
        const ttl = declaredTtl(ctx, message.provider, message.model);
        emit(track, "request", {
          ...common,
          requested: attempt.requested,
          replyModelDiffers: attempt.requested && actual ? attempt.requested.h !== actual.h : null,
          layers: layers(attempt),
          baseline: baseline ? {
            source: track.baselineSource, restart: baseline.run !== run, stale: track.stale,
            predatesEnable: control.since !== undefined && baseline.at < control.since,
            modelChanged: baseline.model !== null && actual ? baseline.model !== actual.h : null,
            providerChanged: baseline.provider !== null && providerH ? baseline.provider !== providerH : null,
            promptTokens: baseline.promptTokens, cacheRead: baseline.cacheRead,
          } : null,
          // Idle gap ends when this request started (context_with_system), so the
          // time spent generating this response is not counted as idle time.
          gap: { ms: lastCompletedAt === null ? null : Math.max(0, attempt.at - lastCompletedAt), boundary },
          cmp: { payload: payloadCmp ?? null, context: contextCmp ?? null, headers: headerStatus },
          format: attempt.payload?.fp.format ?? null,
          plain: attempt.payload?.plain ?? {},
          cacheMarkers: attempt.payload ? { count: attempt.payload.markerCount, ttl: attempt.payload.markerTtl } : null,
          responses: { count: attempt.statuses.length, statuses: attempt.statuses.slice(0, 8) },
          ttl,
        }, allowed);
        // Only completed responses advance the baseline; failures keep the previous one.
        if (COMPLETED.has(stop)) {
          const next: Baseline = {
            v: 1, session: track.sessionH, at: now, run, lastCompletedAt: now, lastStop: stop,
            model: actual?.h ?? null, provider: providerH,
            promptTokens: usage.promptTokens, cacheRead: usage.cacheRead,
            payload: attempt.payload?.fp ?? null, context: attempt.context?.fp ?? null, headers: attempt.headers ?? null,
          };
          // SAFETY: Baseline is a plain JSON object of hashes, numbers and enums.
          store.writeState(track.sessionH, next as unknown as Record<string, unknown>);
          track.baseline = next; track.baselineSource = "memory"; track.stale = false;
          // Markers, prompt and warming evidence describe the gap since the last
          // completed response, so they reset only when the baseline advances.
          track.markers = []; track.prompt = false; track.unanchored = 0;
          track.warm = { decisions: 0, proposedWarm: 0, proposedStop: 0, candidates: 0, pending: false };
        }
      }
    });
  });

  function usageView(ctx: any, message: any, api: string) {
    const u = message.usage ?? {};
    const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
    const input = n(u.input), output = n(u.output), cacheRead = n(u.cacheRead), cacheWrite = n(u.cacheWrite);
    const all = [input, output, cacheRead, cacheWrite];
    const state = all.every((value) => value === null || value === 0) ? "no_usage"
      : cacheRead !== null && cacheRead > 0 ? "positive" : "zero_or_unreported";
    let verified = VERIFIED_USAGE_APIS.has(api);
    // Extension providers with their own stream function may normalize differently.
    try { if (verified && ctx.modelRegistry?.getRegisteredProviderConfig?.(message.provider)?.streamSimple) verified = false; }
    catch { verified = false; }
    const promptTokens = verified && input !== null && cacheRead !== null && cacheWrite !== null ? input + cacheRead + cacheWrite : null;
    return {
      input, output, cacheRead, cacheWrite, cacheWrite1h: n(u.cacheWrite1h), state, verified, promptTokens,
      readRatio: promptTokens ? Math.round(((cacheRead ?? 0) / promptTokens) * 1e4) / 1e4 : null,
    };
  }
  function declaredTtl(ctx: any, provider: unknown, model: unknown) {
    try {
      const found = typeof provider === "string" && typeof model === "string" ? ctx.modelRegistry?.find?.(provider, model) : undefined;
      if (!found) return null;
      const tiers = found.promptCache ?? {};
      const seconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
      return { short: seconds(tiers.short), long: seconds(tiers.long) };
    } catch { return null; }
  }

  // ------------------------------------------------------------ lifecycle markers

  pi.on("session_start", (event, ctx) => {
    try { tracks.delete(ctx.sessionManager.getSessionId()); } catch { /* no session */ }
    const reason = ENUMS.has(event.reason) ? event.reason : "other";
    marker(ctx, `session_${reason}`);
  });
  pi.on("session_compact", (event, ctx) => {
    marker(ctx, "compaction", { reason: ENUMS.has(event.reason) ? event.reason : "other", willRetry: event.willRetry === true });
  });
  pi.on("session_tree", (event, ctx) => { marker(ctx, "tree_navigation", { summarized: !!event.summaryEntry }); });
  pi.on("model_select", (event, ctx) => {
    guard(ctx, (_control, hasher, track) => {
      const allowed = new Set<string>();
      if (track.markers.length < MAX_MARKERS) track.markers.push("model_select");
      emit(track, "marker", {
        marker: "model_select", source: ENUMS.has(event.source) ? event.source : "other",
        from: label(ctx, hasher, event.previousModel?.provider, event.previousModel?.id, allowed),
        to: label(ctx, hasher, event.model?.provider, event.model?.id, allowed),
      }, allowed);
    });
  });
  pi.on("thinking_level_select", (event, ctx) => {
    marker(ctx, "thinking_select", {
      from: ENUMS.has(event.previousLevel) ? event.previousLevel : "other", to: ENUMS.has(event.level) ? event.level : "other",
    });
  });
  // The agent loop has emitted every message_end it will emit. A request still open
  // here never gets usage from the loop; leaving it would poison later pairing. A
  // late response for it is then recorded as unpaired, never paired by guess.
  pi.on("agent_end", (_event, ctx) => {
    guard(ctx, (_control, _hasher, track) => {
      for (const attempt of track.open) closeUnfinished(track, attempt, "agent_end");
      track.open = [];
    });
  });
  // Idempotent: quit, reload and session replacement can all reach this path.
  pi.on("session_shutdown", (_event, ctx) => {
    guard(ctx, (_control, _hasher, track) => {
      for (const attempt of track.open) closeUnfinished(track, attempt, "session_shutdown");
      track.open = [];
    });
    try { tracks.delete(ctx.sessionManager.getSessionId()); } catch { /* no session */ }
  });

  // ------------------------------------------------------------ command

  pi.registerCommand("cache-diagnostics", {
    description: "Metadata-only prompt-cache diagnostics: on | off | status | report [n] | purge",
    getArgumentCompletions: (prefix: string) => ["on", "off", "status", "report", "purge"]
      .filter((item) => item.startsWith(prefix.trim())).map((item) => ({ value: item, label: item })),
    handler: async (args, ctx) => {
      const [action = "status", count] = args.trim().split(/\s+/);
      try {
        if (action === "on" || action === "off") { store.writeControl(action === "on"); tracks.clear(); lastEnabled = undefined; }
        else if (action === "purge") { store.purge(); tracks.clear(); }
        else if (action === "report") {
          const limit = Number.isInteger(Number(count)) && Number(count) > 0 ? Math.min(Number(count), 100) : 10;
          ctx.ui.notify(buildReport(store.readLogLines(), { limit }), "info");
          return;
        } else if (action !== "status") { ctx.ui.notify("Use /cache-diagnostics on|off|status|report [n]|purge", "warning"); return; }
        const s = store.status();
        const problem = s.control.problem ? ` (control file ${s.control.problem}: treated as OFF)` : "";
        ctx.ui.notify(`Cache diagnostics ${s.control.enabled ? "ON" : "OFF"}${problem}; ${s.logBytes} log bytes in ${s.logFilesPresent} file(s), ` +
          `${s.sessions} session baseline(s), key ${s.keyPresent ? "present" : "absent"}. Metadata only; see README for limits.`, "info");
      } catch (error) {
        ctx.ui.notify(`Cache diagnostics command failed: ${error instanceof store.UnsafePathError ? "unsafe path refused" : "storage error"}.`, "warning");
      }
    },
  });
}
