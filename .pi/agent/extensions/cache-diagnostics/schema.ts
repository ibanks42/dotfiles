// Last line of defense for records: every key must be a known field name and
// every string must be an HMAC hex id, a fixed enum, or a registry-verified
// provider/model id passed in `allowed`. Anything else is redacted and flagged,
// so a coding mistake cannot leak prompt text, paths or payload field names.
import { AFFINITY_KEYS, ENUM_VALUES, HEADER_NAMES, OPTION_KEYS, PLAIN_PATHS } from "./fingerprint.ts";

export const STOPS = new Set(["stop", "length", "toolUse", "error", "aborted", "deferred", "pending"]);
const APIS = [
  "anthropic-messages", "openai-responses", "openai-codex-responses", "azure-openai-responses", "openai-completions",
  "google-generative-ai", "google-vertex", "bedrock-converse-stream", "mistral-conversations", "pi-messages",
  "cloudflare-ai-binding", "openrouter-images", "faux",
];
export const ENUMS = new Set<string>([
  ...ENUM_VALUES, ...STOPS, ...APIS, ...OPTION_KEYS,
  // record kinds, pairing, layers, formats
  "request", "response", "unanchored_request", "marker", "unfinished",
  "single_request", "context_only", "ambiguous", "unpaired", "provider_payload", "context",
  "responses", "anthropic", "chat", "google", "bedrock", "opaque",
  // comparison
  "no_baseline", "extends", "early_change", "same", "changed", "added", "removed", "absent", "unknown",
  "identical", "append", "rewrite", "shorter",
  // message kinds
  "system", "developer", "user", "assistant", "tool", "toolResult", "function", "model", "message", "function_call",
  "function_call_output", "reasoning", "custom_tool_call", "custom_tool_call_output", "compaction", "item_reference",
  "web_search_call", "local_shell_call", "branchSummary", "compactionSummary", "custom", "bashExecution",
  // usage, gaps, baselines, classification
  "positive", "zero_or_unreported", "no_usage", "user_turn", "tool_boundary", "other_continuation",
  "memory", "disk", "warm_candidate", "warm", "stale", "session_shutdown", "agent_end",
  // markers and their details
  "session_startup", "session_reload", "session_new", "session_resume", "session_fork", "session_other",
  "startup", "reload", "new", "resume", "fork", "tree_navigation", "model_select", "thinking_select",
  "warming_decision", "manual", "threshold", "overflow", "set", "cycle", "restore",
  "5m", "1h", "ONE_HOUR", "FIVE_MINUTES", "other", "deleted",
]);

export const ALLOWED_KEYS = new Set<string>([
  ...OPTION_KEYS, ...AFFINITY_KEYS, ...HEADER_NAMES, ...PLAIN_PATHS,
  "v", "kind", "at", "run", "inst", "seq", "session", "sanitized",
  "marker", "proposed", "warmCost", "missCost", "continuationProbability", "reason", "willRetry", "summarized",
  "source", "from", "to", "layers", "payloads", "responses", "classification", "evidence", "warmDecisionPending",
  "openAttempts", "format", "complete", "vsBaseline", "prefix", "messages", "system", "tools", "options", "plain",
  "pairing", "stop", "api", "actual", "responseModel", "usage", "markers", "prompt", "warming", "decisions",
  "proposedWarm", "proposedStop", "candidates", "pending", "unanchored", "requested", "replyModelDiffers",
  "baseline", "restart", "stale", "predatesEnable", "modelChanged", "providerChanged", "promptTokens", "cacheRead",
  "gap", "ms", "boundary", "cmp", "payload", "context", "headers", "cacheMarkers", "count", "ttl", "statuses",
  "short", "long", "provider", "model", "h", "input", "output", "cacheWrite", "cacheWrite1h", "state", "verified",
  "readRatio", "layer", "formatChanged", "systemChunk", "systemSection", "systemChars", "toolsRelation",
  "toolCounts", "toolFirstChanged", "toolsAdded", "toolsRemoved", "toolsReordered", "toolDefsChanged",
  "msgCounts", "commonPrefix", "firstChanged", "firstChangedKind", "affinity", "markersMoved", "opaque",
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const HEX = /^[0-9a-f]{12,24}$/;
const MAX_ARRAY = 256;
const MAX_DEPTH = 8;

export function sanitize(record: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  let flagged = false;
  const walk = (value: unknown, depth: number): Json => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      if (HEX.test(value) || ENUMS.has(value) || allowed.has(value)) return value;
      flagged = true;
      return "[redacted]";
    }
    if (depth >= MAX_DEPTH) { flagged = true; return null; }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY) flagged = true;
      return value.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1));
    }
    if (typeof value === "object") {
      const result: { [key: string]: Json } = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        if (!ALLOWED_KEYS.has(key)) { flagged = true; continue; }
        result[key] = walk(item, depth + 1);
      }
      return result;
    }
    flagged = true; // functions, symbols, bigint
    return null;
  };
  // SAFETY: walk() maps a plain object to a plain object.
  const clean = walk(record, 0) as Record<string, unknown>;
  if (flagged) clean.sanitized = true;
  return clean;
}
