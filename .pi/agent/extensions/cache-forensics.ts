import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = process.env.PI_CACHE_FORENSICS_ROOT ?? join(homedir(), ".pi/agent/cache-forensics");
const DATA = join(ROOT, "data");
const STATE = join(ROOT, "state.json");
const LIMIT = 200 * 1024 * 1024;
const instance = randomUUID();
// Request/usage pairing is best effort. Both bounds drop the OLDEST entries, so a
// provider call that never reaches message_end cannot grow memory without limit.
const MAX_PENDING = 64;
const MAX_SESSIONS = 32;
const sessions = new Map<string, { sequence: number; pending: number[] }>();
let lastEnabled: boolean | undefined;
let warned = false;
let stopped = false;
let accounting: { bytes: number; writes: number; checked: number } | undefined;
function ensure(): void {
  for (const path of [ROOT, DATA, join(DATA, "blobs")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
  }
}
function enabled(): boolean {
  if (stopped || existsSync(join(ROOT, "STOP")) || existsSync(join(DATA, "STOP"))) return false;
  // Fail closed: capture needs an explicit {"enabled": true} object. Missing,
  // corrupt, wrong-shape and non-boolean state all mean OFF.
  try {
    const state: unknown = JSON.parse(readFileSync(STATE, "utf8"));
    return !!state && typeof state === "object" && !Array.isArray(state) && (state as { enabled?: unknown }).enabled === true;
  } catch { return false; }
}
/** Returns enabled() and drops all pairing state on every on/off transition. */
function sync(): boolean {
  const now = enabled();
  if (now !== lastEnabled) { sessions.clear(); lastEnabled = now; }
  return now;
}
/** Drops pairing state for ONE session; other concurrent sessions keep theirs. */
function forget(ctx: any): void {
  try { sessions.delete(ctx.sessionManager.getSessionId()); } catch { /* no session */ }
}
function size(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((n, item) => {
    const path = join(dir, item.name);
    return n + (item.isDirectory() ? size(path) : statSync(path).size);
  }, 0);
}
function bytes(): typeof accounting {
  if (!accounting || accounting.writes >= 50 || Date.now() - accounting.checked > 60_000)
    accounting = { bytes: size(DATA), writes: 0, checked: Date.now() };
  return accounting;
}
/** JSON-safe capture value. undefined is kept because JSON.stringify drops it. */
type Json = null | undefined | boolean | number | string | Json[] | { [key: string]: Json };
function safe(value: unknown, seen = new WeakSet<object>()): Json {
  if (typeof value === "bigint") return String(value) + "n";
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (!value || typeof value !== "object") return value as null | undefined | boolean | number | string;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const result = Array.isArray(value) ? value.map((v) => safe(v, seen)) :
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, safe(v, seen)]));
  seen.delete(value);
  return result;
}
function save(data: Record<string, unknown>): void {
  ensure();
  const tally = bytes()!;
  const store = (value: unknown): { blob: { sha256: string; bytes: number; json?: true } } => {
    const content = Buffer.from(typeof value === "string" ? value : JSON.stringify(safe(value)));
    const sha256 = createHash("sha256").update(content).digest("hex");
    const file = join(DATA, "blobs", sha256);
    if (!existsSync(file)) {
      if (tally.bytes + content.length > LIMIT) throw new Error("200 MiB capture limit reached");
      try { writeFileSync(file, content, { flag: "wx", mode: 0o600 }); tally.bytes += content.length; }
      catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
    }
    return { blob: { sha256, bytes: content.length, ...(typeof value === "string" ? {} : { json: true as const }) } };
  };
  // Arrays are stored as one content-addressed blob PER ITEM: a growing transcript
  // only writes its new messages, and the index line keeps the ordered hash list.
  const leaf = (value: unknown): Json =>
    (typeof value === "string" && value.length > 1024) || (value !== null && typeof value === "object") ? store(value) : safe(value);
  const itemize = (value: unknown): Json => Array.isArray(value) ? { __items: value.map(leaf) }
    : value && typeof value === "object"
      ? { __fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? itemize(v) : leaf(v)])) }
      : leaf(value);
  const packed = { ...data };
  for (const key of ["messages", "payload"]) if (key in packed) packed[key] = itemize(packed[key]);
  for (const key of ["systemPromptOptions", "systemPrompt"]) if (key in packed) packed[key] = leaf(packed[key]);
  const line = JSON.stringify(safe(packed)) + "\n";
  if (tally.bytes + Buffer.byteLength(line) > LIMIT) throw new Error("200 MiB capture limit reached");
  appendFileSync(join(DATA, "pi.jsonl"), line, { mode: 0o600 });
  chmodSync(join(DATA, "pi.jsonl"), 0o600);
  tally.bytes += Buffer.byteLength(line); tally.writes++;
}
function markers(prompt: string): string[] {
  return [...prompt.matchAll(/^(?:#{1,3} .+|Current date[^\n]*|<codex_[^>]+>|<cwd>|<skills>)/gm)].map((m) => m[0]);
}
/**
 * Pi 0.87.1 package-manager.resolveResources first resolves package sources,
 * then explicit project/user entries, then addAutoDiscoveredResources. Thus this
 * auto-loaded user extension runs AFTER package handlers such as pi-codex-conversion.
 * Handler snapshots are at this registration position, not final provider wire bytes;
 * explicit project/user extensions and later handlers can still rewrite them.
 * context hides system messages; context_with_system includes them. Provider
 * pairing is best effort by session and time: parallel requests can finish out of order.
 */
export default function (pi: ExtensionAPI): void {
  function warn(ctx: any, cap: boolean): void {
    if (cap) { stopped = true; try { environment(); } catch { /* best effort */ } }
    if (!warned) { warned = true; try { ctx.ui.notify(`Cache forensics ${cap ? "stopped at 200 MiB cap" : "record failed; capture will retry"}.`, "warning"); } catch { /* no UI */ } }
  }
  function observe(ctx: any, kind: string, value: Record<string, unknown>, sequence?: number): void {
    if (!enabled()) return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      save({ kind, at: new Date().toISOString(), instance, sessionId, sequence,
        model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider, api: ctx.model.api } : null,
        thinkingLevel: pi.getThinkingLevel(), ...value });
    } catch (error) { warn(ctx, String(error).includes("200 MiB")); }
  }
  function environment(): void {
    if (enabled()) {
      ensure();
      process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR = DATA;
      process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = join(DATA, "metrics.jsonl");
    } else {
      delete process.env.PI_CLAUDE_CODE_PROVIDER_CAPTURE_DIR;
      delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    }
  }
  pi.registerCommand("forensics", {
    description: "Cache capture: on | off | status | purge",
    handler: async (arg, ctx) => {
      try {
        const action = arg.trim();
        if (action === "purge") {
          rmSync(DATA, { recursive: true, force: true });
          for (const entry of readdirSync(ROOT))
            if (["pi.jsonl", "provider.jsonl", "metrics.jsonl", "capture-errors.jsonl", "blobs"].includes(entry) || /^wire-.*\.json$/.test(entry))
              rmSync(join(ROOT, entry), { recursive: true, force: true });
          accounting = undefined; stopped = false; warned = false;
        } else if (action === "on" || action === "off") {
          ensure(); writeFileSync(STATE, JSON.stringify({ enabled: action === "on" }), { mode: 0o600 }); chmodSync(STATE, 0o600);
          if (action === "on") {
            for (const dir of [ROOT, DATA]) rmSync(join(dir, "STOP"), { force: true });
            stopped = false; warned = false;
          }
        } else if (action !== "status") { ctx.ui.notify("Use /forensics on|off|status|purge", "warning"); return; }
        environment();
        ctx.ui.notify(`Cache forensics ${sync() ? "ON" : "OFF"}; ${size(DATA)} / ${LIMIT} bytes at ${DATA}`, "info");
      } catch { warn(ctx, false); }
    },
  });
  pi.on("session_start", (_event, ctx) => { forget(ctx); try { environment(); } catch { /* best effort */ } });
  // Idempotent: quit, reload and session replacement can all reach this path.
  // Only this session's state goes; capture on/off transitions clear all (sync()).
  pi.on("session_shutdown", (_event, ctx) => { forget(ctx); });
  pi.on("before_agent_start", (event, ctx) => {
    // Re-sync the process-wide provider env with STOP/state each prompt, so every
    // Pi process follows /forensics on|off and the STOP file without a reload.
    try { environment(); } catch { /* best effort */ }
    observe(ctx, "before_agent_start", { systemPrompt: event.systemPrompt,
      systemPromptOptions: event.systemPromptOptions, sections: markers(event.systemPrompt) });
  });
  pi.on("context", (event, ctx) => observe(ctx, "context", { messages: event.messages }));
  pi.on("context_with_system", (event, ctx) => observe(ctx, "context_with_system", { messages: event.messages }));
  pi.on("before_provider_request", (event, ctx) => {
    // Fail closed at every request: external state/STOP changes also clear the
    // provider capture env here, without waiting for the next user turn.
    try { environment(); } catch { /* best effort */ }
    if (!sync()) return;
    const id = ctx.sessionManager.getSessionId();
    const state = sessions.get(id) ?? { sequence: 0, pending: [] };
    const seq = ++state.sequence; state.pending.push(seq);
    if (state.pending.length > MAX_PENDING) state.pending.splice(0, state.pending.length - MAX_PENDING);
    sessions.delete(id); sessions.set(id, state); // Map order = least recently used first.
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    observe(ctx, "request", { payload: event.payload }, seq);
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !sync()) return;
    const usage = event.message.usage;
    const state = sessions.get(ctx.sessionManager.getSessionId());
    const seq = state?.pending.shift();
    observe(ctx, "usage", { requestSequence: seq, usage: { input: usage.input, output: usage.output,
      cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cacheWrite1h: (usage as { cacheWrite1h?: number }).cacheWrite1h },
      stopReason: event.message.stopReason }, seq);
  });
}
