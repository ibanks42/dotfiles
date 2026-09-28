// HMAC fingerprints of cache-relevant request structure. Nothing here returns text,
// field names from the payload, or raw values: only keyed hashes, counts, fixed
// field names from the lists below, and allowlisted enum/number option values.
import { createHmac } from "node:crypto";

export type Layer = "provider_payload" | "context";
/** 12-24 hex chars, or null when the part was not hashed (budget exhausted or unserializable). */
export type Hash = string | null;
export type Format = "responses" | "anthropic" | "chat" | "google" | "bedrock" | "opaque" | "context";

export interface TextFp { h: Hash; chars: number; chunks: Hash[]; sections: Hash[]; truncated: boolean }
export interface ToolFp { n: Hash; d: Hash }
export interface Fingerprint {
  layer: Layer;
  format: Format;
  /** False when any part was skipped because of the hash budget, caps or serialization failure. */
  complete: boolean;
  sys: TextFp | null;
  tools: ToolFp[] | null;
  msgs: Hash[];
  msgCount: number;
  /** Layout of provider cache breakpoints (cache_control / cachePoint), which are excluded from content hashes. */
  markers: Hash;
  options: Record<string, Hash>;
  affinity: Record<string, Hash>;
  opaque: { count: number; h: Hash };
}
/** Current-request-only facts that never enter the baseline. */
export interface View { fp: Fingerprint; kinds: string[]; plain: Record<string, number | boolean | string>; markerCount: number; markerTtl: string[] }

const CHUNK_CHARS = 2048;
const MAX_CHUNKS = 512;
const MAX_SECTIONS = 256;
const MAX_TOOLS = 512;
export const MAX_MSGS = 4096;

export class Hasher {
  private used = 0;
  exhausted = false;
  constructor(private readonly key: Buffer, private readonly budget: number) {}
  /** Identifier HMAC (session ids, model ids). Not budgeted; inputs are short. */
  id(domain: string, value: string, hex = 24): string {
    return createHmac("sha256", this.key).update(domain).update("\0").update(value).digest("hex").slice(0, hex);
  }
  content(domain: string, text: string | undefined, hex = 16): Hash {
    if (text === undefined) return null;
    if (this.exhausted || this.used + text.length > this.budget) { this.exhausted = true; return null; }
    this.used += text.length;
    return this.id(domain, text, hex);
  }
}

// ---------------------------------------------------------------- canonical serialization

type Markers = { count: number; ttl: Set<string> };
const MARKER_TTL = new Set(["5m", "1h", "ONE_HOUR", "FIVE_MINUTES"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCachePoint = (value: unknown) => isRecord(value) && Object.keys(value).length === 1 && "cachePoint" in value;
function noteMarker(markers: Markers | undefined, value: unknown): void {
  if (!markers) return;
  markers.count++;
  const ttl = isRecord(value) ? (value.ttl ?? (isRecord(value.cachePoint) ? value.cachePoint.ttl : undefined)) : undefined;
  if (typeof ttl === "string") markers.ttl.add(MARKER_TTL.has(ttl) ? ttl : "other");
}
/**
 * JSON in insertion order (wire order matters for cache identity). Nothing is
 * normalized here: ids, signatures and timestamps inside content stay hashed.
 * Returns undefined when serialization fails.
 */
export function canon(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item)) ?? "undefined";
  } catch { return undefined; }
}

// ---------------------------------------------------------------- cache breakpoints

/**
 * Breakpoints move every request and are not prompt content, so they are removed
 * before hashing and counted separately, but ONLY where pi-ai 0.87.1 writes them:
 * - "anthropic" (anthropic-messages; openai-completions with Anthropic cache control):
 *   the top-level `cache_control` key of a typed system/message content block or of
 *   a tool object.
 * - "bedrock": `{cachePoint}` elements of the system array, of a message content
 *   array, and of toolConfig.tools.
 * Never inside tool schemas (input_schema, parameters), tool-call arguments,
 * tool-result content or unknown shapes: a key named cache_control there is real
 * content and stays hashed.
 */
type Breakpoints = "anthropic" | "bedrock" | "none";
const hasCacheControl = (item: unknown) => isRecord(item) && "cache_control" in item;
const isTypedBlock = (item: unknown): item is Record<string, unknown> => isRecord(item) && typeof item.type === "string";
function dropCacheControl(item: Record<string, unknown>, markers: Markers): Record<string, unknown> {
  if (!("cache_control" in item)) return item;
  noteMarker(markers, item.cache_control);
  const { cache_control: _marker, ...rest } = item;
  return rest;
}
function withoutCachePoints(list: unknown[], markers: Markers): unknown[] {
  const kept: unknown[] = [];
  for (const item of list) {
    if (isCachePoint(item)) noteMarker(markers, item);
    else kept.push(item);
  }
  return kept;
}
/**
 * Serialized message with breakpoints removed from its own content array only.
 * In anthropic mode a string is the documented shorthand for one text block, and
 * pi-ai converts the last string message to that block form to attach a
 * breakpoint, so a string hashes as `[{type:"text",text}]`.
 */
function messageJson(message: unknown, mode: Breakpoints, markers: Markers): string | undefined {
  if (mode === "none" || !isRecord(message) || !("content" in message)) return canon(message);
  const content = message.content;
  let next = content;
  if (mode === "anthropic") {
    if (typeof content === "string") next = [{ type: "text", text: content }];
    else if (Array.isArray(content)) next = content.map((block) => (isTypedBlock(block) ? dropCacheControl(block, markers) : block));
  } else if (Array.isArray(content)) next = withoutCachePoints(content, markers);
  return canon({ ...message, content: next });
}
function breakpointMode(format: Format, payload: Record<string, unknown>): Breakpoints {
  if (format === "anthropic") return "anthropic";
  if (format === "bedrock") return "bedrock";
  if (format !== "chat") return "none";
  // openai-completions adds Anthropic breakpoints only for some compat targets.
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const marked = tools.some(hasCacheControl) || messages.some((message) => isRecord(message) && Array.isArray(message.content)
    && message.content.some((block) => isTypedBlock(block) && hasCacheControl(block)));
  return marked ? "anthropic" : "none";
}

function textFp(hasher: Hasher, domain: string, text: string, sections?: string[]): TextFp {
  const h = hasher.content(domain, text);
  const chunks: Hash[] = [];
  for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS; i += CHUNK_CHARS)
    chunks.push(hasher.content(`${domain}:chunk`, text.slice(i, i + CHUNK_CHARS), 12));
  const parts = sections ?? text.split(/\n(?=#{1,6} |<[A-Za-z_][\w-]*>)/);
  return {
    h, chars: text.length, chunks,
    sections: parts.slice(0, MAX_SECTIONS).map((part) => hasher.content(`${domain}:section`, part, 12)),
    truncated: text.length > CHUNK_CHARS * MAX_CHUNKS || parts.length > MAX_SECTIONS,
  };
}

// ---------------------------------------------------------------- known payload fields

const STRUCTURE_KEYS = new Set(["instructions", "system", "input", "messages", "contents", "tools"]);
export const OPTION_KEYS = [
  "model", "modelId", "stream", "store", "temperature", "top_p", "topP", "top_k", "max_tokens", "max_output_tokens",
  "max_completion_tokens", "maxTokens", "reasoning", "reasoning_effort", "reasoningEffort", "thinking", "output_config",
  "text", "include", "tool_choice", "toolChoice", "parallel_tool_calls", "parallelToolCalls", "service_tier",
  "prompt_cache_retention", "prompt_cache_options", "betas", "stream_options", "inferenceConfig",
  "additionalModelRequestFields", "requestMetadata", "promptMode", "tool_stream", "enable_thinking",
  "chat_template_kwargs", "thinking_budget", "priority", "response_format", "responseFormat", "seed", "random_seed",
  "safe_prompt", "presence_penalty", "frequency_penalty", "stop", "truncation", "verbosity", "config", "toolConfig",
] as const;
export const AFFINITY_KEYS = [
  "prompt_cache_key", "promptCacheKey", "previous_response_id", "conversation", "user", "safety_identifier", "metadata",
] as const;
/** Request header names whose values are HMACed. Every other header, including auth, is never read. */
export const HEADER_NAMES = [
  "session_id", "session-id", "x-session-id", "x-session-affinity", "x-client-request-id", "x-opencode-session",
  "conversation_id", "conversation-id", "x-conversation-id", "chatgpt-account-id", "x-account-id",
  "anthropic-beta", "openai-beta",
] as const;
const OPTIONS = new Set<string>(OPTION_KEYS);
const AFFINITY = new Set<string>(AFFINITY_KEYS);
const HEADERS = new Set<string>(HEADER_NAMES);

/** Option values that may appear in plain text. Everything else is hash-only. */
export const PLAIN_PATHS = [
  "max_tokens", "max_output_tokens", "max_completion_tokens", "maxTokens", "inferenceConfig.maxTokens",
  "config.maxOutputTokens", "reasoning.effort", "reasoning.summary", "reasoning_effort", "thinking.type",
  "thinking.budget_tokens", "thinking.display", "output_config.effort", "text.verbosity", "service_tier",
  "prompt_cache_retention", "store", "parallel_tool_calls", "tool_choice", "temperature",
  "config.thinkingConfig.thinkingLevel", "config.thinkingConfig.thinkingBudget",
] as const;
export const ENUM_VALUES = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "concise", "detailed", "enabled", "disabled",
  "adaptive", "summarized", "omitted", "in_memory", "24h", "5m", "1h", "flex", "priority", "default", "scale",
  "required", "any", "off", "LOW", "MEDIUM", "HIGH", "MINIMAL",
]);
const KINDS = new Set([
  "system", "developer", "user", "assistant", "tool", "toolResult", "function", "model", "message", "function_call",
  "function_call_output", "reasoning", "custom_tool_call", "custom_tool_call_output", "compaction", "item_reference",
  "web_search_call", "local_shell_call", "branchSummary", "compactionSummary", "custom", "bashExecution",
]);
function kindOf(item: unknown): string {
  if (!isRecord(item)) return "other";
  const kind = typeof item.role === "string" ? item.role : typeof item.type === "string" ? item.type : undefined;
  return kind && KINDS.has(kind) ? kind : "other";
}
function plainAt(payload: Record<string, unknown>, path: string): number | boolean | string | undefined {
  let value: unknown = payload;
  for (const part of path.split(".")) value = isRecord(value) ? value[part] : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return typeof value === "string" && ENUM_VALUES.has(value) ? value : undefined;
}

/** Text of a plain text block (`{type:"text",text}` or Bedrock `{text}`), else undefined. */
function plainText(block: unknown): string | undefined {
  if (!isRecord(block) || typeof block.text !== "string") return undefined;
  const keys = Object.keys(block);
  const plain = keys.every((key) => key === "text" || key === "type") && (block.type === undefined || block.type === "text");
  return plain ? block.text : undefined;
}
function systemText(value: unknown, mode: Breakpoints, markers: Markers): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return canon(value);
  const blocks = mode === "bedrock" ? withoutCachePoints(value, markers)
    : mode === "anthropic" ? value.map((block) => (isTypedBlock(block) ? dropCacheControl(block, markers) : block)) : value;
  const parts: string[] = [];
  for (const block of blocks) {
    // Plain text blocks contribute their text so section and chunk positions stay meaningful.
    const text = plainText(block) ?? canon(block);
    if (text === undefined) return undefined;
    parts.push(text);
  }
  return parts.join("\u241e");
}
function flattenTools(list: unknown, mode: Breakpoints, markers: Markers): unknown[] {
  if (!Array.isArray(list)) return [];
  const tools: unknown[] = [];
  for (const tool of mode === "bedrock" ? withoutCachePoints(list, markers) : list) {
    if (isRecord(tool) && Array.isArray(tool.functionDeclarations)) tools.push(...tool.functionDeclarations);
    else tools.push(mode === "anthropic" && isRecord(tool) ? dropCacheControl(tool, markers) : tool);
  }
  return tools;
}
function toolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  const nested = isRecord(tool.function) ? tool.function.name : isRecord(tool.toolSpec) ? tool.toolSpec.name : undefined;
  const name = tool.name ?? nested;
  return typeof name === "string" ? name : undefined;
}
/** Tools must already be breakpoint-normalized (flattenTools). Schemas are hashed verbatim. */
function toolsFp(hasher: Hasher, tools: unknown[]): { list: ToolFp[]; complete: boolean } {
  const list = tools.slice(0, MAX_TOOLS).map((tool) => ({
    n: hasher.content("tool-name", toolName(tool) ?? canon(tool), 12),
    d: hasher.content("tool-def", canon(tool), 12),
  }));
  return { list, complete: tools.length <= MAX_TOOLS && list.every((tool) => tool.n !== null && tool.d !== null) };
}
function hashItems(hasher: Hasher, domain: string, items: unknown[], encode: (item: unknown) => string | undefined): Hash[] {
  return items.slice(0, MAX_MSGS).map((item) => (hasher.exhausted ? null : hasher.content(domain, encode(item))));
}

function detectFormat(payload: Record<string, unknown>): Format {
  if (Array.isArray(payload.input) || typeof payload.instructions === "string") return "responses";
  if (Array.isArray(payload.contents)) return "google";
  if ("modelId" in payload || "inferenceConfig" in payload || "toolConfig" in payload) return "bedrock";
  if (Array.isArray(payload.messages)) return "system" in payload ? "anthropic" : "chat";
  return "opaque";
}

/** Fingerprint of a provider payload as seen by before_provider_request. Never mutates it. */
export function fingerprintPayload(hasher: Hasher, payload: unknown): View {
  const markers: Markers = { count: 0, ttl: new Set() };
  const layout: string[] = [];
  const mark = (label: string, before: number) => { if (markers.count > before) layout.push(`${label}:${markers.count - before}`); };
  const empty = (format: Format): Fingerprint => ({
    layer: "provider_payload", format, complete: true, sys: null, tools: null, msgs: [], msgCount: 0,
    markers: null, options: {}, affinity: {}, opaque: { count: 0, h: null },
  });
  if (!isRecord(payload)) {
    const fp = empty("opaque");
    fp.opaque = { count: 1, h: hasher.content("opaque", canon(payload)) };
    fp.complete = fp.opaque.h !== null;
    return { fp, kinds: [], plain: {}, markerCount: 0, markerTtl: [] };
  }
  const format = detectFormat(payload);
  const mode = breakpointMode(format, payload);
  const fp = empty(format);
  let complete = true;

  // System / instructions.
  let before = markers.count;
  let messages: unknown[] = Array.isArray(payload.input) ? payload.input
    : Array.isArray(payload.messages) ? payload.messages : Array.isArray(payload.contents) ? payload.contents : [];
  const config = isRecord(payload.config) ? payload.config : undefined;
  const systemValue = payload.instructions ?? payload.system ?? config?.systemInstruction;
  let sysText: string | undefined;
  if (systemValue !== undefined) sysText = systemText(systemValue, mode, markers);
  else {
    // Chat Completions style: leading system/developer messages are the system prompt.
    let lead = 0;
    while (lead < messages.length && isRecord(messages[lead]) &&
      ((messages[lead] as { role?: unknown }).role === "system" || (messages[lead] as { role?: unknown }).role === "developer")) lead++;
    if (lead > 0) {
      const parts = messages.slice(0, lead).map((message) => messageJson(message, mode, markers));
      sysText = parts.some((part) => part === undefined) ? undefined : parts.join("\u241e");
      messages = messages.slice(lead);
    }
  }
  if (systemValue !== undefined || sysText !== undefined) {
    if (sysText === undefined) { fp.sys = { h: null, chars: 0, chunks: [], sections: [], truncated: true }; complete = false; }
    else { fp.sys = textFp(hasher, "system", sysText); complete &&= fp.sys.h !== null && !fp.sys.truncated && fp.sys.chunks.every(Boolean); }
  }
  mark("s", before);

  // Tools: top-level, Google config.tools, Bedrock toolConfig.tools.
  before = markers.count;
  const toolConfig = isRecord(payload.toolConfig) ? payload.toolConfig : undefined;
  const toolList = payload.tools ?? config?.tools ?? toolConfig?.tools;
  if (toolList !== undefined) {
    const tools = toolsFp(hasher, flattenTools(toolList, mode, markers));
    fp.tools = tools.list; complete &&= tools.complete;
  }
  mark("t", before);

  // Messages / input items.
  const kinds = messages.slice(0, MAX_MSGS).map(kindOf);
  fp.msgCount = messages.length;
  fp.msgs = messages.slice(0, MAX_MSGS).map((message, index) => {
    const start = markers.count;
    const hash = hasher.exhausted ? null : hasher.content("message", messageJson(message, mode, markers));
    mark(`m${index}`, start);
    return hash;
  });
  complete &&= messages.length <= MAX_MSGS && fp.msgs.every((hash) => hash !== null);

  // Options, affinity, unknown fields.
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    // JSON.stringify drops undefined fields, so they are absent on the wire too.
    if (value === undefined || STRUCTURE_KEYS.has(key)) continue;
    if (AFFINITY.has(key)) { fp.affinity[key] = hasher.content("affinity", canon(value), 16); continue; }
    if (OPTIONS.has(key)) {
      let optionValue = value;
      if (key === "config" && config) { const { systemInstruction: _s, tools: _t, abortSignal: _a, ...rest } = config; optionValue = rest; }
      if (key === "toolConfig" && toolConfig) { const { tools: _t, ...rest } = toolConfig; optionValue = rest; }
      fp.options[key] = hasher.content("option", canon(optionValue), 12);
      complete &&= fp.options[key] !== null;
      continue;
    }
    unknown[key] = value;
  }
  const unknownCount = Object.keys(unknown).length;
  if (unknownCount > 0) {
    fp.opaque = { count: unknownCount, h: hasher.content("opaque", canon(unknown)) };
    complete &&= fp.opaque.h !== null;
  }
  fp.markers = layout.length ? hasher.content("markers", layout.join(","), 12) : null;
  fp.complete = complete && !hasher.exhausted;
  const plain: Record<string, number | boolean | string> = {};
  for (const path of PLAIN_PATHS) { const value = plainAt(payload, path); if (value !== undefined) plain[path] = value; }
  return { fp, kinds, plain, markerCount: markers.count, markerTtl: [...markers.ttl].sort() };
}

/** Only these request headers are read; their values are HMACed. */
export function headerAffinity(hasher: Hasher, headers: unknown): Record<string, Hash | "deleted"> {
  const result: Record<string, Hash | "deleted"> = {};
  if (!isRecord(headers)) return result;
  // Object.keys never invokes getters; values are read for allowlisted names only.
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (!HEADERS.has(lower)) continue;
    const value = headers[name];
    result[lower] = value === null ? "deleted" : typeof value === "string" ? hasher.content("header", value, 16) : null;
  }
  return result;
}

// ---------------------------------------------------------------- logical context layer

/** Local bookkeeping that Pi's provider adapters never serialize; excluded so it cannot fake a change. */
const LOCAL_FIELDS = new Set(["timestamp", "usage", "diagnostics"]);
const withoutLocal = (message: unknown) =>
  isRecord(message) ? Object.fromEntries(Object.entries(message).filter(([key]) => !LOCAL_FIELDS.has(key))) : message;

/** Fingerprint of the logical transcript from context_with_system. It is not wire bytes. */
export function fingerprintContext(hasher: Hasher, messages: unknown, options: Record<string, string>): View {
  const list = Array.isArray(messages) ? messages : [];
  let lead = 0;
  while (lead < list.length && isRecord(list[lead]) && (list[lead] as { role?: unknown }).role === "system") lead++;
  const fp: Fingerprint = {
    layer: "context", format: "context", complete: true, sys: null, tools: null, msgs: [], msgCount: 0,
    markers: null, options: {}, affinity: {}, opaque: { count: 0, h: null },
  };
  if (lead > 0) {
    // Section 0 is each leading message's own content; named sections follow in order.
    const parts: string[] = [];
    const tools: unknown[] = [];
    for (const message of list.slice(0, lead) as Record<string, unknown>[]) {
      const content = typeof message.content === "string" ? message.content : canon(message.content);
      parts.push(content ?? "");
      if (isRecord(message.sections)) for (const [name, value] of Object.entries(message.sections)) parts.push(canon([name, value]) ?? "");
      if (Array.isArray(message.toolsAdded)) tools.push(...message.toolsAdded);
      if (Array.isArray(message.toolsRemoved) && message.toolsRemoved.length) parts.push(canon(message.toolsRemoved) ?? "");
    }
    fp.sys = textFp(hasher, "ctx-system", parts.join("\u241e"), parts);
    const toolFp = toolsFp(hasher, tools);
    fp.tools = toolFp.list;
    fp.complete &&= fp.sys.h !== null && !fp.sys.truncated && toolFp.complete;
  }
  const rest = list.slice(lead);
  fp.msgCount = rest.length;
  fp.msgs = hashItems(hasher, "ctx-message", rest, (message) => canon(withoutLocal(message)));
  for (const [name, value] of Object.entries(options)) fp.options[name] = hasher.content("ctx-option", value, 12);
  fp.complete &&= rest.length <= MAX_MSGS && fp.msgs.every((hash) => hash !== null) && !hasher.exhausted;
  return { fp, kinds: rest.slice(0, MAX_MSGS).map(kindOf), plain: {}, markerCount: 0, markerTtl: [] };
}

// ---------------------------------------------------------------- comparison

export type Status = "same" | "changed" | "added" | "removed" | "absent" | "unknown";
export interface Comparison {
  layer: Layer;
  prefix: "no_baseline" | "extends" | "early_change" | "unknown";
  formatChanged: boolean;
  system: Status; systemChunk: number | null; systemSection: number | null; systemChars: [number, number] | null;
  tools: Status; toolsRelation: "identical" | "append" | "rewrite" | "unknown" | "none"; toolCounts: [number, number];
  toolFirstChanged: number | null; toolsAdded: number; toolsRemoved: number; toolsReordered: boolean; toolDefsChanged: number;
  messages: "identical" | "append" | "rewrite" | "shorter" | "unknown";
  msgCounts: [number, number]; commonPrefix: number; firstChanged: number | null; firstChangedKind: string | null;
  options: string[]; affinity: Record<string, Status>; markersMoved: boolean | null; opaque: Status;
}

const firstDiff = (a: Hash[], b: Hash[]): { index: number; unknown: boolean } => {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] === null || b[i] === null) return { index: i, unknown: true };
    if (a[i] !== b[i]) return { index: i, unknown: false };
  }
  return { index: shared, unknown: false };
};
function statusOf(a: Hash | undefined, b: Hash | undefined, present: [boolean, boolean]): Status {
  if (!present[0] && !present[1]) return "absent";
  if (!present[0]) return "added";
  if (!present[1]) return "removed";
  if (a === null || b === null || a === undefined || b === undefined) return "unknown";
  return a === b ? "same" : "changed";
}
function recordStatus(a: Record<string, Hash | "deleted">, b: Record<string, Hash | "deleted">): Record<string, Status> {
  const result: Record<string, Status> = {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)]))
    result[name] = statusOf(a[name] as Hash, b[name] as Hash, [name in a, name in b]);
  return result;
}

export function compare(prev: Fingerprint | undefined, view: View): Comparison {
  const cur = view.fp;
  const base: Comparison = {
    layer: cur.layer, prefix: "no_baseline", formatChanged: false,
    system: "unknown", systemChunk: null, systemSection: null, systemChars: null,
    tools: "unknown", toolsRelation: "unknown", toolCounts: [0, cur.tools?.length ?? 0], toolFirstChanged: null,
    toolsAdded: 0, toolsRemoved: 0, toolsReordered: false, toolDefsChanged: 0,
    messages: "unknown", msgCounts: [0, cur.msgCount], commonPrefix: 0, firstChanged: null, firstChangedKind: null,
    options: [], affinity: {}, markersMoved: null, opaque: "unknown",
  };
  if (!prev) return base;
  const result = { ...base };
  let definite = false;
  let uncertain = !prev.complete || !cur.complete;
  result.formatChanged = prev.format !== cur.format;
  if (result.formatChanged) definite = true;

  // System.
  result.system = statusOf(prev.sys?.h, cur.sys?.h, [!!prev.sys, !!cur.sys]);
  if (prev.sys && cur.sys) {
    result.systemChars = [prev.sys.chars, cur.sys.chars];
    if (result.system !== "same") {
      const chunk = firstDiff(prev.sys.chunks, cur.sys.chunks);
      const sameChunks = !chunk.unknown && chunk.index === prev.sys.chunks.length && chunk.index === cur.sys.chunks.length;
      result.systemChunk = sameChunks ? null : chunk.index;
      const section = firstDiff(prev.sys.sections, cur.sys.sections);
      result.systemSection = section.index < Math.max(prev.sys.sections.length, cur.sys.sections.length) ? section.index : null;
    }
  }
  if (result.system === "changed" || result.system === "added" || result.system === "removed") definite = true;
  if (result.system === "unknown") uncertain = true;

  // Tools.
  const a = prev.tools ?? [], b = cur.tools ?? [];
  result.toolCounts = [a.length, b.length];
  if (!prev.tools && !cur.tools) { result.tools = "absent"; result.toolsRelation = "none"; }
  else {
    const names = (list: ToolFp[]) => list.map((tool) => tool.n);
    const pairs = (list: ToolFp[]) => list.map((tool) => (tool.n && tool.d ? `${tool.n}:${tool.d}` : null));
    const diff = firstDiff(pairs(a), pairs(b));
    if (diff.unknown) { result.tools = "unknown"; result.toolsRelation = "unknown"; uncertain = true; }
    else if (diff.index === a.length && a.length === b.length) { result.tools = "same"; result.toolsRelation = "identical"; }
    else {
      result.tools = !prev.tools ? "added" : !cur.tools ? "removed" : "changed";
      result.toolsRelation = diff.index === a.length ? "append" : "rewrite";
      result.toolFirstChanged = diff.index;
      const prevNames = new Set(names(a)), curNames = new Set(names(b));
      result.toolsAdded = [...curNames].filter((name) => !prevNames.has(name)).length;
      result.toolsRemoved = [...prevNames].filter((name) => !curNames.has(name)).length;
      const sharedOrder = (list: ToolFp[], other: Set<Hash>) => names(list).filter((name) => other.has(name)).join(",");
      result.toolsReordered = sharedOrder(a, curNames) !== sharedOrder(b, prevNames);
      const defs = new Map(a.map((tool) => [tool.n, tool.d]));
      result.toolDefsChanged = b.filter((tool) => defs.has(tool.n) && defs.get(tool.n) !== tool.d).length;
      definite = true;
    }
  }

  // Messages: the previous request's items must be an exact prefix of this one.
  result.msgCounts = [prev.msgCount, cur.msgCount];
  const diff = firstDiff(prev.msgs, cur.msgs);
  result.commonPrefix = diff.index;
  const storedPrev = prev.msgs.length;
  if (diff.unknown) { result.messages = "unknown"; uncertain = true; result.firstChanged = diff.index; }
  else if (diff.index < Math.min(storedPrev, cur.msgs.length)) {
    result.messages = "rewrite"; result.firstChanged = diff.index; definite = true;
  } else if (cur.msgCount < prev.msgCount && diff.index >= cur.msgs.length) {
    result.messages = "shorter"; result.firstChanged = cur.msgCount; definite = true;
  } else if (storedPrev < prev.msgCount) {
    result.messages = "unknown"; uncertain = true; // previous list exceeded the stored cap
  } else result.messages = cur.msgCount === prev.msgCount ? "identical" : "append";
  if (result.firstChanged !== null && result.firstChanged < view.kinds.length) result.firstChangedKind = view.kinds[result.firstChanged];

  // Options and affinity are reported separately from the prefix verdict.
  for (const [name, status] of Object.entries(recordStatus(prev.options, cur.options)))
    if (status !== "same" && status !== "absent") result.options.push(name);
  result.options.sort();
  result.affinity = recordStatus(prev.affinity, cur.affinity);
  result.markersMoved = prev.markers !== cur.markers;
  result.opaque = statusOf(prev.opaque.h, cur.opaque.h, [prev.opaque.count > 0, cur.opaque.count > 0]);
  // Unknown fields may be cache-relevant and have no known position, so any change
  // there (or a wholly opaque payload) can never support an "extends" verdict.
  if (result.opaque !== "same" && result.opaque !== "absent") uncertain = true;
  result.prefix = definite ? "early_change" : uncertain ? "unknown" : "extends";
  return result;
}

// ---------------------------------------------------------------- baseline validation

const HASH = /^[0-9a-f]{12,24}$/;
const isHash = (value: unknown): value is Hash => value === null || (typeof value === "string" && HASH.test(value));
const hashList = (value: unknown, max: number) => Array.isArray(value) && value.length <= max && value.every(isHash);
const hashRecord = (value: unknown, allowed: Set<string>) => isRecord(value) &&
  Object.entries(value).every(([key, hash]) => allowed.has(key) && (isHash(hash) || hash === "deleted"));
const HEADER_KEYS = new Set(HEADER_NAMES.map((name) => `header:${name}`));
const CTX_OPTIONS = new Set(["model", "thinking"]);
/** Strict shape check for fingerprints loaded from disk. Anything unexpected is rejected. */
export function parseFingerprint(value: unknown): Fingerprint | undefined {
  if (!isRecord(value)) return undefined;
  const { layer, format, complete, sys, tools, msgs, msgCount, markers, options, affinity, opaque } = value;
  if (layer !== "provider_payload" && layer !== "context") return undefined;
  if (typeof format !== "string" || !["responses", "anthropic", "chat", "google", "bedrock", "opaque", "context"].includes(format)) return undefined;
  if (typeof complete !== "boolean" || !isHash(markers) || !Number.isInteger(msgCount) || !hashList(msgs, MAX_MSGS)) return undefined;
  if (sys !== null && !(isRecord(sys) && isHash(sys.h) && Number.isInteger(sys.chars) && hashList(sys.chunks, MAX_CHUNKS)
    && hashList(sys.sections, MAX_SECTIONS) && typeof sys.truncated === "boolean")) return undefined;
  if (tools !== null && !(Array.isArray(tools) && tools.length <= MAX_TOOLS && tools.every((tool) => isRecord(tool) && isHash(tool.n) && isHash(tool.d)))) return undefined;
  const optionNames = layer === "context" ? CTX_OPTIONS : new Set<string>(OPTION_KEYS);
  if (!hashRecord(options, optionNames)) return undefined;
  if (!hashRecord(affinity, new Set<string>([...AFFINITY_KEYS, ...HEADER_KEYS]))) return undefined;
  if (!isRecord(opaque) || !Number.isInteger(opaque.count) || !isHash(opaque.h)) return undefined;
  // SAFETY: every field of Fingerprint was shape-checked above; unknown option,
  // affinity and header names were rejected, and all hashes match HASH.
  return value as unknown as Fingerprint;
}
