// Offline report over the metadata log. Observed facts and suspected causes are
// printed separately; nothing here can prove a miss was preventable.
// CLI: bun agent/extensions/cache-diagnostics/report.ts [--limit N]
import { readLogLines, rootDir } from "./store.ts";

interface Label { provider?: string; model?: string; h?: string }
interface Cmp {
  layer?: string; prefix?: string; formatChanged?: boolean; system?: string; systemSection?: number | null;
  systemChunk?: number | null; tools?: string; toolsRelation?: string; toolFirstChanged?: number | null;
  toolsAdded?: number; toolsRemoved?: number; toolsReordered?: boolean; toolDefsChanged?: number; messages?: string;
  msgCounts?: number[]; commonPrefix?: number; firstChanged?: number | null; firstChangedKind?: string | null;
  options?: string[]; affinity?: Record<string, string>; opaque?: string;
}
/** Fields the report reads. Records are written by index.ts through sanitize(); all are optional here. */
interface Rec {
  v: number; kind: string; at: number; run?: string; session?: string; seq?: number; pairing?: string; stop?: string;
  api?: string; classification?: string; actual?: Label | null; requested?: Label | null; replyModelDiffers?: boolean | null;
  usage?: { state?: string; verified?: boolean; cacheRead?: number | null; input?: number | null; cacheWrite?: number | null; promptTokens?: number | null };
  baseline?: { promptTokens?: number | null; cacheRead?: number | null; modelChanged?: boolean | null; providerChanged?: boolean | null;
    restart?: boolean; stale?: boolean; predatesEnable?: boolean } | null;
  gap?: { ms?: number | null; boundary?: string }; markers?: string[]; unanchored?: number;
  warming?: { decisions?: number; proposedWarm?: number; proposedStop?: number; candidates?: number };
  ttl?: { short?: number | null; long?: number | null } | null;
  cmp?: { payload?: Cmp | null; context?: Cmp | null; headers?: Record<string, string> | null };
}
const OK_STOPS = new Set(["stop", "length", "toolUse"]);

function parse(lines: string[]): Rec[] {
  const records: Rec[] = [];
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object") continue;
      const record = value as { v?: unknown; kind?: unknown; at?: unknown };
      // SAFETY: only version/kind/time are checked; every other field is read optionally.
      if (record.v === 1 && typeof record.kind === "string" && typeof record.at === "number") records.push(value as Rec);
    } catch { /* torn or foreign line */ }
  }
  return records;
}
const CHANGED = new Set(["changed", "added", "removed"]);
const short = (hash: unknown) => (typeof hash === "string" ? hash.slice(0, 8) : "?");
const num = (value: unknown) => (typeof value === "number" ? value.toLocaleString("en-US") : "n/a");
const secs = (ms: unknown) => (typeof ms === "number" ? `${Math.round(ms / 1000)}s` : "unknown");
function model(label: Label | null | undefined): string {
  if (!label) return "unknown";
  return label.provider && label.model ? `${label.provider}/${label.model}` : `unlisted#${short(label.h)}`;
}

/** Observed miss: zero/unreported cache read, or a verified read below half of the previous prompt. */
export function missKind(record: Rec): "zero_read" | "reduced_read" | undefined {
  if (record.kind !== "request" || !OK_STOPS.has(record.stop ?? "") || !record.baseline) return undefined;
  const usage = record.usage ?? {};
  if (usage.state === "zero_or_unreported") return "zero_read";
  const previous = record.baseline.promptTokens;
  if (usage.verified && typeof previous === "number" && previous > 0 && typeof usage.cacheRead === "number"
    && usage.cacheRead < previous * 0.5) return "reduced_read";
  return undefined;
}

function primary(record: Rec): Cmp | null {
  const cmp = record.cmp ?? {};
  if (cmp.payload && cmp.payload.prefix !== "no_baseline") return cmp.payload;
  if (cmp.context && cmp.context.prefix !== "no_baseline") return cmp.context;
  return cmp.payload ?? cmp.context ?? null;
}

function prefixLine(cmp: Cmp | null): string {
  if (!cmp) return "no fingerprint for this request";
  const parts: string[] = [];
  parts.push(`system ${cmp.system}${cmp.systemSection !== null && cmp.systemSection !== undefined ? ` (first changed section ${cmp.systemSection}, chunk ${cmp.systemChunk ?? "n/a"})` : ""}`);
  if (cmp.tools === "absent") parts.push("tools absent");
  else parts.push(`tools ${cmp.tools}${cmp.toolsRelation === "append" || cmp.toolsRelation === "rewrite" ? ` (${cmp.toolsRelation} at index ${cmp.toolFirstChanged}; +${cmp.toolsAdded}/-${cmp.toolsRemoved}, reordered ${cmp.toolsReordered}, definitions changed ${cmp.toolDefsChanged})` : ""}`);
  const [before, after] = cmp.msgCounts ?? [0, 0];
  const where = cmp.firstChanged !== null && cmp.firstChanged !== undefined ? `, first changed item ${cmp.firstChanged} (${cmp.firstChangedKind ?? "unknown kind"})` : "";
  parts.push(`history ${cmp.messages} (${before} -> ${after} items, common prefix ${cmp.commonPrefix}${where})`);
  parts.push(cmp.options?.length ? `options changed: ${cmp.options.join(", ")}` : "options same");
  const affinity = Object.entries(cmp.affinity ?? {}).map(([name, status]) => `${name} ${status}`);
  if (affinity.length) parts.push(`affinity: ${affinity.join(", ")}`);
  if (cmp.opaque !== "absent") parts.push(`unknown fields ${cmp.opaque}`);
  if (cmp.formatChanged) parts.push("payload format changed");
  return parts.join("; ");
}

function suspects(record: Rec, cmp: Cmp | null): string[] {
  const out: string[] = [];
  if (record.pairing !== "single_request" && record.pairing !== "context_only")
    return ["none: request/usage pairing is not reliable, so no causal verdict"];
  if (cmp?.prefix === "early_change") {
    if (cmp.formatChanged) out.push("payload format changed (different adapter or provider path)");
    if (CHANGED.has(cmp.system ?? "")) out.push(`system/instructions changed${typeof cmp.systemSection === "number" ? ` from section ${cmp.systemSection}` : ""}`);
    if (CHANGED.has(cmp.tools ?? "")) out.push(`tool definitions changed (${cmp.toolsRelation} at index ${cmp.toolFirstChanged})`);
    if (cmp.messages === "rewrite" || cmp.messages === "shorter")
      out.push(`history rewritten before item ${cmp.firstChanged} of ${cmp.msgCounts?.[0]}${record.markers?.includes("compaction") ? " (compaction marker present)" : ""}${record.markers?.includes("tree_navigation") ? " (tree navigation marker present)" : ""}`);
  }
  if (cmp?.options?.length) out.push(`cache-relevant options changed: ${cmp.options.join(", ")}`);
  const affinity = Object.entries({ ...(cmp?.affinity ?? {}), ...(record.cmp?.headers ?? {}) })
    .filter(([, status]) => status !== "same" && status !== "absent").map(([name, status]) => `${name} ${status}`);
  if (affinity.length) out.push(`cache affinity changed: ${affinity.join(", ")}`);
  if (record.baseline?.modelChanged) out.push("actual model differs from previous response");
  if (record.baseline?.providerChanged) out.push("actual provider differs from previous response (account/provider switch)");
  if (record.baseline?.restart) out.push("process restart or other process since previous request (connection-scoped state such as WebSocket continuation is lost; not a prefix change by itself)");
  if (record.baseline?.stale || (record.unanchored ?? 0) > 0) out.push("unpaired or ambiguous traffic since the baseline; comparison may skip requests");
  if (record.baseline?.predatesEnable) out.push("baseline predates the current enablement; unobserved requests may exist in between");
  if (cmp?.prefix === "unknown") out.push("prefix comparison incomplete (hash budget, caps or unserializable parts)");
  if (out.length === 0) {
    const ttl = record.ttl?.short;
    const gap = record.gap?.ms;
    const within = typeof ttl === "number" && typeof gap === "number" && gap < ttl * 1000;
    out.push(`no observed prefix, option, affinity or model change. Provider TTL, eviction or routing are not observable here${within ? "; the gap is inside pi's declared TTL, so this is unexplained by the evidence" : ""}.`);
  }
  return out;
}

export function buildReport(lines: string[], options: { limit?: number } = {}): string {
  const records = parse(lines);
  const requests = records.filter((r) => r.kind === "request");
  const responses = records.filter((r) => r.kind === "response");
  const unanchored = records.filter((r) => r.kind === "unanchored_request");
  const sessions = new Set(records.map((r) => r.session));
  const runs = new Set(records.map((r) => r.run));
  const count = (list: Rec[], test: (r: Rec) => boolean) => list.filter(test).length;
  const misses = requests.map((r) => ({ r, kind: missKind(r) })).filter((m) => m.kind);
  const cold = count(requests, (r) => !r.baseline && r.usage?.state !== "positive");
  const out: string[] = [];
  out.push("Cache diagnostics report (metadata only; HMAC ids, counts and allowlisted names)");
  out.push(`Records: ${requests.length} paired requests (${count(requests, (r) => r.pairing === "single_request")} with provider payload, ` +
    `${count(requests, (r) => r.pairing === "context_only")} logical context only), ${responses.length} ambiguous/unpaired responses, ` +
    `${unanchored.length} unanchored requests (${count(unanchored, (r) => r.classification === "warm_candidate")} warm candidates), ` +
    `${sessions.size} sessions, ${runs.size} process runs.`);
  out.push(`Usage: ${count(requests, (r) => r.usage?.state === "positive")} with cache read > 0, ` +
    `${count(requests, (r) => r.usage?.state === "zero_or_unreported")} with cache read 0 or not reported, ` +
    `${count(requests, (r) => r.usage?.state === "no_usage")} without usage, ` +
    `${count(requests, (r) => !OK_STOPS.has(r.stop ?? ""))} error/aborted/other. Cold requests without baseline: ${cold}.`);
  out.push(`Observed misses after a baseline: ${misses.length} (${misses.filter((m) => m.kind === "zero_read").length} zero/unreported read, ${misses.filter((m) => m.kind === "reduced_read").length} reduced read).`);
  const limit = options.limit ?? 10;
  if (misses.length) out.push("", `Newest ${Math.min(limit, misses.length)} observed misses:`);
  for (const { r, kind } of misses.slice(-limit).reverse()) {
    const cmp = primary(r);
    const u = r.usage ?? {};
    out.push("");
    out.push(`- session ${short(r.session)} seq ${r.seq} at ${new Date(r.at).toISOString()}: ${kind}`);
    out.push(`  model: ${model(r.actual)}${r.replyModelDiffers ? ` (requested ${model(r.requested)})` : ""}; previous ${r.baseline?.modelChanged ? "different" : r.baseline?.modelChanged === false ? "same" : "unknown"}; api ${r.api}`);
    out.push(`  facts: cacheRead ${num(u.cacheRead)}, input ${num(u.input)}, cacheWrite ${num(u.cacheWrite)}, prompt ${u.verified ? num(u.promptTokens) : "n/a (usage normalization unverified)"}; previous prompt ${num(r.baseline?.promptTokens)}, previous cacheRead ${num(r.baseline?.cacheRead)}`);
    out.push(`  gap: ${secs(r.gap?.ms)} from previous completed response to this request's start (${r.gap?.boundary}); restart ${r.baseline?.restart ? "yes" : "no"}; markers ${r.markers?.length ? r.markers.join(", ") : "none"}`);
    out.push(`  layer: ${cmp?.layer ?? "none"}${cmp?.layer === "context" ? " (logical context only; provider bypasses before_provider_request, wire prefix not observed)" : " (hook-time payload, not wire bytes)"}; pairing ${r.pairing}`);
    out.push(`  prefix: ${cmp?.prefix ?? "unknown"}: ${prefixLine(cmp)}`);
    const w = r.warming ?? {};
    const tier = (seconds: number | null | undefined) => (typeof seconds === "number" ? `${seconds}s` : "none");
    const ttl = r.ttl ? `pi-declared TTL short ${tier(r.ttl.short)}, long ${tier(r.ttl.long)}` : "no pi-declared TTL for this model (pi's warmer cannot schedule without one)";
    out.push(`  warming: ${w.decisions ?? 0} decisions (${w.proposedWarm ?? 0} proposed warm, ${w.proposedStop ?? 0} stop), ${w.candidates ?? 0} warm-candidate requests in the gap; ${ttl}. Missing warm evidence is not proof warming never ran.`);
    for (const line of suspects(r, cmp)) out.push(`  suspected: ${line}`);
  }
  out.push("", "Limits: hooks see Pi's payload/context before later extension handlers and transport rewrites; provider-built headers, " +
    "account ids and connection state are mostly invisible; provider TTL and eviction are unknown; zero cache read may mean " +
    "'not reported'. Claude bridge and other custom providers expose only the logical context layer. The Claude bridge trace " +
    "is independent (separate memory-only key) and is not joined here.");
  return out.join("\n");
}

if ((import.meta as { main?: boolean }).main) {
  const index = process.argv.indexOf("--limit");
  const limit = index > 0 ? Number(process.argv[index + 1]) : 10;
  console.log(`Root: ${rootDir()}`);
  console.log(buildReport(readLogLines(), { limit: Number.isInteger(limit) && limit > 0 ? limit : 10 }));
}
