// Diagnostic-only. No bridge/session mutations, persisted keys, or content records.
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants as F, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LIMIT = 256 * 1024;
const MAX_SESSIONS = 1024;
const branches = new Set(["reuse", "reuse_trailing_assistant", "clean_shorter", "clean_no_priors", "rebuild_first", "rebuild_preserve", "rebuild_rotate"]);
const reasons = new Set(["session_compact", "session_tree", "history_rewrite_unknown", "missed_steering", "rewritten_parked_query"]);
const finishes = new Set(["completed", "aborted", "error", "abandoned"]);
const efforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const models = new Set(["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5", "claude-haiku-4-5-20251001"]);
// Opaque object identity for WeakMap attribution. Never inspect bridge objects.
type Identity = object;
type RecordValue = string | number | boolean | null;
type Row = Record<string, RecordValue>;
type Token = { session: string; query: string; started: number; epoch: number; done: boolean; observations: number };
type Session = { completed?: number; model?: string; effort?: string; prompt?: string; tools?: string; pending?: Token };
type Mirror = { sessionId?: string; cursor?: number; needsRebuild?: boolean; forceRotate?: boolean };
const number = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

// Agent root is a trusted location (Pi commonly symlinks ~/.pi). Pin its resolved
// directory; below it, never follow control/log symlinks. Linux /proc fd paths
// keep writes on the opened directory even if a parent is renamed concurrently.
function privateFile(fd: number): void {
 const st = fstatSync(fd);
 if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.()) throw new Error("unsafe file");
}
function agentFd(root: string): number {
 return openSync(realpathSync(root), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
}
function flag(root: string): { enabled: boolean; fingerprints: boolean } {
 const dir = agentFd(root);
 try {
  const fd = openSync(`/proc/self/fd/${dir}/claude-bridge-cache-trace.json`, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
   privateFile(fd);
   if (fstatSync(fd).size > 1024) return { enabled: false, fingerprints: false };
   const value = JSON.parse(readFileSync(fd, "utf8"));
   return { enabled: value?.enabled === true, fingerprints: value?.fingerprints === true };
  } finally { closeSync(fd); }
 } finally { closeSync(dir); }
}
function sink(root: string, row: Row): void {
 const agent = agentFd(root);
 let dir: number | undefined;
 let locked = false;
 let base = "";
 try {
  const path = `/proc/self/fd/${agent}/claude-bridge-cache-trace`;
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  dir = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  if (fstatSync(dir).uid !== process.getuid?.()) return;
  fchmodSync(dir, 0o700);
  base = `/proc/self/fd/${dir}`;
  // Cross-process rotation lock. A crash can leave a stale lock: fail closed.
  mkdirSync(`${base}/.lock`, { mode: 0o700 });
  locked = true;
  const files = ["trace.jsonl", "trace.1.jsonl", "trace.2.jsonl"].map(n => `${base}/${n}`);
  for (const file of files) {
   try {
    const st = lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.()) return;
    const fd = openSync(file, F.O_WRONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
    try { privateFile(fd); fchmodSync(fd, 0o600); } finally { closeSync(fd); }
   } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const line = Buffer.from(JSON.stringify(row) + "\n");
  if (line.length > 4096) return;
  let fd = openSync(files[0], F.O_WRONLY | F.O_APPEND | F.O_CREAT | F.O_NOFOLLOW | F.O_NONBLOCK, 0o600);
  try {
   privateFile(fd);
   fchmodSync(fd, 0o600);
   if (fstatSync(fd).size + line.length > LIMIT) {
    closeSync(fd); fd = -1;
    try { unlinkSync(files[2]); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    try { renameSync(files[1], files[2]); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    renameSync(files[0], files[1]);
    fd = openSync(files[0], F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    privateFile(fd);
   }
   writeSync(fd, line);
  } finally { if (fd >= 0) closeSync(fd); }
 } finally {
  if (locked) { try { rmdirSync(`${base}/.lock`); } catch {} }
  if (dir !== undefined) closeSync(dir);
  closeSync(agent);
 }
}

/** Factory dependencies are for offline tests. The exported singleton uses Pi's agent directory. */
export function createCacheTrace(deps: { agentDir?: string; now?: () => number } = {}) {
 let secret: Buffer | undefined;
 let epoch = 0;
 let seq = 0;
 const sessions = new Map<string, Session>();
 let contexts = new WeakMap<object, Token>();
 let queries = new WeakMap<object, Token>();
 let outputs = new WeakMap<object, Token>();
 const now = deps.now ?? (() => performance.now());
 const root = () => deps.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
 function clear() { sessions.clear(); contexts = new WeakMap(); queries = new WeakMap(); outputs = new WeakMap(); secret = undefined; epoch++; }
 function safe<T>(fn: (fp: boolean) => T): T | undefined {
  try {
   const config = flag(root());
   if (!config.enabled) { clear(); return; }
   secret ??= randomBytes(32);
   return fn(config.fingerprints);
  } catch { clear(); return; }
 }
 function hash(domain: string, value: unknown): string {
  return createHmac("sha256", secret!).update(domain).update("\0").update(typeof value === "string" ? value : JSON.stringify(value) ?? "null").digest("hex").slice(0, 24);
 }
 function state(session: string): Session {
  let s = sessions.get(session);
  if (!s) {
   if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
   s = {}; sessions.set(session, s);
  }
  return s;
 }
 function emit(event: string, data: Row) {
  try { sink(root(), { schema: 1, time: Date.now(), process: hash("process", "instance"), event, ...data }); } catch { /* Drop only this observation on sink failure. */ }
 }
 function valid(t?: Token): t is Token { return !!t && t.epoch === epoch; }
 function identity(t: Token): Row { return { session: t.session, query: t.query }; }
 return {
  start(c: Identity, piSession: unknown, model: unknown, reasoning: unknown, prompt: unknown, tools: unknown, messages: number): Token | undefined {
   return safe(fp => {
    const session = hash("session", piSession ?? "unattributed");
    const s = state(session);
    const t: Token = { session, query: hash("query", String(++seq)), started: now(), epoch, done: false, observations: 0 };
    const modelHash = typeof model === "string" ? hash("model", model) : undefined;
    const effort = typeof reasoning === "string" && efforts.has(reasoning) ? reasoning : "unspecified";
    const promptHash = fp ? hash("system_append", prompt) : undefined;
    const toolsHash = fp ? hash("tool_definitions", tools) : undefined;
    contexts.set(c, t); s.pending = t;
    emit("start", { ...identity(t), attributed: typeof piSession === "string", messages: number(messages), tools: Array.isArray(tools) ? tools.length : null,
     idleMs: s.completed === undefined ? null : Math.max(0, Math.round(t.started - s.completed)),
     model: typeof model === "string" && models.has(model) ? model : "unknown", provider: "claude-bridge", effort,
     modelChanged: s.model && modelHash ? s.model !== modelHash : null,
     effortChanged: s.effort && s.effort !== "unspecified" && effort !== "unspecified" ? s.effort !== effort : null,
     promptHash: promptHash ?? null, toolsHash: toolsHash ?? null,
     promptChanged: s.prompt && promptHash ? s.prompt !== promptHash : null,
     toolsChanged: s.tools && toolsHash ? s.tools !== toolsHash : null });
    s.model = modelHash; s.effort = effort; s.prompt = promptHash; s.tools = toolsHash;
    return t;
   });
  },
  bind(t: Token | undefined, q: Identity) { safe(() => { if (valid(t)) queries.set(q, t); }); },
  output(q: Identity, output: Identity | null) { safe(() => { const t = queries.get(q); if (valid(t) && output) outputs.set(output, t); }); },
  usage(output: Identity, usage: Record<string, unknown>) { safe(() => {
   const t = outputs.get(output); if (!valid(t)) return;
   emit("usage", { ...identity(t), observation: ++t.observations, kind: "snapshot_partial", source: "update_usage", aggregation: "none",
    input: number(usage.input_tokens), output: number(usage.output_tokens), cacheRead: number(usage.cache_read_input_tokens), cacheWrite: number(usage.cache_creation_input_tokens) });
  }); },
  sync(piSession: unknown, branch: string, mirror: Mirror | null, history: number, prior: number) { safe(() => {
   if (!branches.has(branch)) return;
   const session = hash("session", piSession ?? "unattributed"); const s = state(session); const t = s.pending; s.pending = undefined;
   emit("sync", { session, query: valid(t) ? t.query : null, branch, ccSession: mirror?.sessionId ? hash("cc_session", mirror.sessionId) : null,
    history: number(history), prior: number(prior), cursor: number(mirror?.cursor), missed: mirror ? number(Math.max(0, prior - (mirror.cursor ?? 0))) : null,
    needsRebuild: mirror?.needsRebuild === true, forceRotate: mirror?.forceRotate === true });
  }); },
  rewrite(piSession: unknown, event: string) { safe(() => {
   const reason = event.startsWith("session_compact:") ? "session_compact" : event === "session_tree" ? "session_tree" : "history_rewrite_unknown";
   emit("rewrite", { session: hash("session", piSession ?? "unattributed"), reason });
  }); },
  mark(c: Identity, reason: string) { safe(() => { const t = contexts.get(c); if (valid(t) && reasons.has(reason)) emit("mark", { ...identity(t), reason }); }); },
  continuation(c: Identity, count: number) { safe(() => { const t = contexts.get(c); if (valid(t)) emit("continuation", { ...identity(t), results: number(count) }); }); },
  selected(t: Token | undefined, effort: unknown) { safe(() => { if (valid(t)) emit("selected", { ...identity(t), effort: typeof effort === "string" && efforts.has(effort) ? effort : "unspecified" }); }); },
  finish(q: Identity, reason: string, ccSession?: unknown) { safe(() => {
   const t = queries.get(q); if (!valid(t) || t.done || !finishes.has(reason)) return;
   t.done = true;
   // This is a query terminal event, never a tool/stream boundary.
   state(t.session).completed = now();
   emit("finish", { ...identity(t), reason, durationMs: Math.max(0, Math.round(now() - t.started)), observations: t.observations,
    ccSession: typeof ccSession === "string" ? hash("cc_session", ccSession) : null });
  }); },
 };
}
export const cacheTrace = createCacheTrace();
