/**
 * Manual review of the latest delegation batch.
 *
 * A batch is every Agent spawn or resume in one parent run, plus the router's restarts.
 * Before its first agent starts, the tracker snapshots the workspace. After its last
 * agent settles, it snapshots again. Changes are attributed only from the agents' own
 * tool calls (edit patches, write content, apply_patch text) and are verified by replay
 * on the baseline. Changes that the transcripts do not explain are reported, never
 * reviewed as agent work.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyPatch, createTwoFilesPatch } from "../../npm/node_modules/diff/libesm/index.js";

/** Fixed by the user: no routing, no fallback, no other model. */
const REVIEWER_TYPE = "subtask-reviewer";
const REVIEWER_MODEL = "openai-codex/gpt-6-astra";
const REVIEWER_THINKING = "high";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const STORE = process.env.PI_SUBTASK_ROUTER_REVIEWS || path.join(AGENT_DIR, "subtask-reviews");

/** Mutable so that tests can use small limits. */
const LIMITS = {
  files: 50_000,
  hashBytes: 32 << 20,
  hashTotalBytes: 256 << 20,
  /** File timestamps are coarse: a stat is trusted only when the file was last changed this long before the baseline. */
  racyMs: 3_000,
  contentBytes: 512 << 10,
  storeBytes: 64 << 20,
  opBytes: 1 << 20,
  fileChars: 60_000,
  packetChars: 250_000,
  taskChars: 4_000,
  retentionMs: 14 * 86_400_000,
};

const ACTIVE = new Set(["queued", "running"]);
const BATCH_ID = /^b[0-9a-z]+-[0-9a-f]{6}$/;
const HASH = /^[0-9a-f]{40}$/;

/** Tools that cannot change workspace files. Any other tool counts as an untraceable writer. */
const NO_WRITES = new Set([
  "read", "grep", "find", "ls", "view_image", "web_search", "fetch_content", "get_search_content", "source_check",
  "get_context_remaining", "change_reasoning", "StructuredOutput", "history", "notes", "new_context",
  "ast_grep_search", "ast_grep_outline", "read_symbol", "read_enclosing", "symbol_search", "module_report",
  "project_report", "lens_diagnostics", "get_subagent_result",
]);

// ---------------------------------------------------------------- secrets and file kinds

const SECRET_FILE = /^(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|auth\.json|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|age))$/i;
const SECRET_WORD = /(^|[-_.])(secrets?|credentials?|passwords?|tokens?)([-_.]|$)/i;
const CONFIG_EXT = /\.(json|ya?ml|toml|ini|conf|cfg|env|properties|txt|xml)$|^[^.]+$/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const REDACTIONS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk|pk|rk)-(live-|test-|proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

function isSecretPath(p: string): boolean {
  const base = path.basename(p);
  return SECRET_FILE.test(base) || (SECRET_WORD.test(base) && CONFIG_EXT.test(base));
}

function redact(text: string): { text: string; count: number } {
  let count = 0;
  for (const re of REDACTIONS) text = text.replace(re, () => { count++; return "[redacted]"; });
  return { text, count };
}

/** Git's blob ID: lets clean tracked files point at HEAD instead of being copied. */
function blobHash(buf: Buffer): string {
  return createHash("sha1").update("blob " + buf.length + "\0").update(buf).digest("hex");
}

type Kind = "text" | "binary" | "large" | "secret" | "link";

function kindOf(key: string, buf: Buffer): Kind {
  if (isSecretPath(key)) return "secret";
  if (buf.subarray(0, 8000).includes(0)) return "binary";
  if (buf.length > LIMITS.contentBytes) return "large";
  if (PRIVATE_KEY.test(buf.toString("utf8"))) return "secret";
  return "text";
}

// ---------------------------------------------------------------- snapshots

/** Read-only git plumbing. Never writes the index, refs, or objects. */
function git(cwd: string, args: string[]): Buffer | undefined {
  try {
    return execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
      cwd, maxBuffer: 512 << 20, timeout: 30_000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch { return undefined; }
}

function workspaceRoot(cwd: string): { root: string; git: boolean } {
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.toString("utf8").trim();
  return top ? { root: path.resolve(top), git: true } : { root: path.resolve(cwd), git: false };
}

const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".next", "target", "dist", "build"]);

/** The artifact store never belongs to a snapshot, even when it is inside the workspace. */
const inStore = (abs: string) => abs === STORE || abs.startsWith(STORE + path.sep);

function listFiles(root: string, isGit: boolean): { paths: string[]; truncated?: string } {
  if (isGit) {
    const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--full-name"]);
    if (out) {
      const paths = [...new Set(out.toString("utf8").split("\0").filter(Boolean))].filter(p => !inStore(path.join(root, p)));
      if (paths.length <= LIMITS.files) return { paths };
      return { paths: paths.slice(0, LIMITS.files), truncated: "the workspace has more than " + LIMITS.files + " files" };
    }
  }
  const paths: string[] = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const child = rel ? rel + "/" + e.name : e.name;
      if (inStore(path.join(root, child))) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(child); continue; }
      if (paths.length >= LIMITS.files) return { paths, truncated: "the workspace has more than " + LIMITS.files + " files" };
      paths.push(child);
    }
  }
  return { paths };
}

function headBlobs(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const out = git(root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
  for (const rec of out?.toString("utf8").split("\0") ?? []) {
    const tab = rec.indexOf("\t");
    const [, type, sha] = rec.slice(0, tab).split(" ");
    if (tab > 0 && type === "blob") map.set(rec.slice(tab + 1), sha);
  }
  return map;
}

interface FileState {
  /** Git blob ID of the content, or "sig:<stat>" when the file was not read (over a size limit). */
  hash: string; size: number; kind: Kind;
  /** size:mtime:ctime:inode. Equal stat in the final snapshot means the file was not written. */
  stat?: string;
  /** "git:<sha>" (a HEAD blob) or "blob:<sha>" (a private copy). Absent: content was not kept. */
  ref?: string;
  /** Read because an agent named it, not because the workspace listing contains it. */
  extra?: boolean;
}
interface Snapshot {
  root: string; git: boolean; at: number; files: Record<string, FileState>; truncated?: string;
  /** Changed text files whose content exceeded the storage limit. */
  skipped?: number;
  /** Files that were not read because the hashing budget was spent. */
  unread?: number;
}

const keyOf = (root: string, abs: string) => {
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
};
const absOf = (root: string, key: string) => (path.isAbsolute(key) ? key : path.join(root, key));

/** Private artifact directory of one batch. */
class Artifacts {
  constructor(readonly dir: string, readonly root: string) {}
  ensure(): void { fs.mkdirSync(path.join(this.dir, "blobs"), { recursive: true, mode: 0o700 }); }
  put(hash: string, buf: Buffer): void {
    const file = path.join(this.dir, "blobs", hash);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf, { mode: 0o600 });
  }
  get(ref: string | undefined): Buffer | undefined {
    const [scheme, hash] = (ref ?? "").split(":");
    if (!HASH.test(hash ?? "")) return undefined;
    if (scheme === "blob") { try { return fs.readFileSync(path.join(this.dir, "blobs", hash)); } catch { return undefined; } }
    if (scheme === "git") return git(this.root, ["cat-file", "blob", hash]);
    return undefined;
  }
  write(name: string, value: unknown): void {
    this.ensure();
    const file = path.join(this.dir, name);
    fs.writeFileSync(file + ".tmp", typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }
  read<T>(name: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as T; } catch { return undefined; }
  }
}

/**
 * Hash every listed file. Text content is kept only when it differs from HEAD (baseline)
 * or from the base snapshot (post). Secrets, binaries, and large files keep only a hash.
 */
function captureSnapshot(root: string, isGit: boolean, store: Artifacts, opts: { base?: Snapshot; extra?: string[] } = {}): Snapshot {
  store.ensure();
  const listed = listFiles(root, isGit);
  const head = isGit && !opts.base ? headBlobs(root) : new Map<string, string>();
  const snap: Snapshot = { root, git: isGit, at: Date.now(), files: {}, truncated: listed.truncated };
  let stored = 0, skipped = 0, hashed = 0, unread = 0;
  const visit = (key: string, extra: boolean) => {
    if (snap.files[key]) return;
    const abs = absOf(root, key);
    if (inStore(abs)) return;
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return; }
    const flag = extra ? { extra } : {};
    if (st.isSymbolicLink()) {
      let target = "";
      try { target = fs.readlinkSync(abs); } catch { /* keep empty */ }
      snap.files[key] = { hash: blobHash(Buffer.from("link:" + target)), size: target.length, kind: "link", ...flag };
      return;
    }
    if (!st.isFile()) return;
    const stat = st.size + ":" + st.mtimeMs + ":" + st.ctimeMs + ":" + st.ino;
    const prev = opts.base?.files[key];
    // Any write changes ctime, so an equal stat means unchanged content, unless the file was
    // changed within one timestamp tick of the baseline (git's "racily clean" case): re-read it.
    const settled = Number(prev?.stat?.split(":")[2]) < (opts.base?.at ?? 0) - LIMITS.racyMs;
    if (prev?.stat === stat && settled) { snap.files[key] = { ...prev, ...flag }; if (!extra) delete snap.files[key].extra; return; }
    if (st.size > LIMITS.hashBytes || hashed + st.size > LIMITS.hashTotalBytes) {
      if (st.size <= LIMITS.hashBytes) unread++;
      snap.files[key] = { hash: "sig:" + stat, size: st.size, kind: "large", stat, ...flag };
      return;
    }
    let buf: Buffer;
    try { buf = fs.readFileSync(abs); } catch { return; }
    hashed += buf.length;
    const state: FileState = { hash: blobHash(buf), size: buf.length, kind: kindOf(key, buf), stat, ...flag };
    if (state.kind === "text") {
      if (prev?.hash === state.hash) { if (prev.ref) state.ref = prev.ref; }
      else if (head.get(key) === state.hash) state.ref = "git:" + state.hash;
      else if (stored + buf.length <= LIMITS.storeBytes) { store.put(state.hash, buf); state.ref = "blob:" + state.hash; stored += buf.length; }
      else skipped++;
    }
    snap.files[key] = state;
  };
  for (const key of listed.paths) visit(key, false);
  for (const abs of opts.extra ?? []) visit(keyOf(root, abs), true);
  if (skipped) snap.skipped = skipped;
  if (unread) snap.unread = unread;
  return snap;
}

// ---------------------------------------------------------------- transcripts

interface PatchSection { type: "add" | "delete" | "update"; path: string; move?: string; lines: string[] }
interface Op {
  agent: string; tool: string; call: string; at: number;
  kind: "edit" | "write" | "patch" | "other";
  /** False when the tool may have changed the file only in part (aborted, no result, partial failure). */
  certain: boolean;
  paths: string[];
  patch?: string;
  edits?: Array<{ oldText: string; newText: string }>;
  content?: string;
  sections?: PatchSection[];
  /** Evidence not kept: secret-like file, or larger than the limit. */
  omitted?: string;
}
interface Evidence { agent: string; ops: Op[]; untraceable: Record<string, number>; complete: boolean; note?: string }

function argsOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") { try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {}; } catch { return {}; } }
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function editList(args: Record<string, unknown>): Array<{ oldText: string; newText: string }> | undefined {
  let edits: any = args.edits;
  if (typeof edits === "string") { try { edits = JSON.parse(edits); } catch { edits = undefined; } }
  if (edits && !Array.isArray(edits) && typeof edits === "object") edits = [edits];
  const list = Array.isArray(edits) ? [...edits] : [];
  if (typeof args.oldText === "string" && typeof args.newText === "string") list.push({ oldText: args.oldText, newText: args.newText });
  return list.length && list.every(e => typeof e?.oldText === "string" && typeof e?.newText === "string") ? list : undefined;
}

const cleanPatchPath = (p: string) => p.trim().replace(/^@/, "").replace(/^['"]|['"]$/g, "");

/** Codex apply_patch sections, with paths resolved against the agent's working directory. */
function patchSections(text: string, cwd: string): PatchSection[] | undefined {
  let lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (/^<<['"]?EOF['"]?$/.test(lines[0] ?? "") && lines.at(-1)?.endsWith("EOF")) lines = lines.slice(1, -1);
  if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch") return undefined;
  const out: PatchSection[] = [];
  let cur: PatchSection | undefined;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
    if (header) {
      cur = { type: header[1].toLowerCase() as PatchSection["type"], path: path.resolve(cwd, cleanPatchPath(header[2])), lines: [] };
      out.push(cur);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && cur?.type === "update" && !cur.lines.length) { cur.move = path.resolve(cwd, cleanPatchPath(move[1])); continue; }
    if (!cur) return undefined;
    cur.lines.push(line);
  }
  return out.length ? out : undefined;
}

/** Messages of an agent's run. The session manager keeps entries that compaction removed from context. */
function transcriptOf(rec: any): { messages?: any[]; complete: boolean } {
  try {
    const entries = rec?.session?.sessionManager?.getEntries?.();
    if (Array.isArray(entries)) return { messages: entries.filter((e: any) => e?.type === "message").map((e: any) => e.message), complete: true };
  } catch { /* try the next source */ }
  if (Array.isArray(rec?.session?.messages)) return { messages: rec.session.messages, complete: !(Number(rec.compactionCount) > 0) };
  if (typeof rec?.sessionFile === "string") {
    try {
      const messages = fs.readFileSync(rec.sessionFile, "utf8").split("\n").filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return undefined; } })
        .filter((e: any) => e?.type === "message").map((e: any) => e.message);
      return { messages, complete: true };
    } catch { /* no transcript */ }
  }
  return { complete: false };
}

const textOf = (r: any) => (r?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");

/** Tool calls of one agent that finished at or after `since`, as file operations. */
function extractEvidence(agent: string, rec: any, cwd: string, since: number): Evidence | undefined {
  const { messages, complete } = transcriptOf(rec);
  if (!messages) return undefined;
  const results = new Map<string, any>();
  for (const m of messages) if (m?.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
  const ops: Op[] = [];
  const untraceable: Record<string, number> = {};
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c?.type !== "toolCall" || typeof c.name !== "string") continue;
      const r = results.get(c.id);
      const at = Number(r?.timestamp ?? m.timestamp ?? 0);
      if (at < since || NO_WRITES.has(c.name)) continue;
      const args = argsOf(c.arguments);
      const aborted = r?.isError && /abort/i.test(textOf(r));
      const base = { agent, tool: c.name, call: String(c.id), at };
      if ((c.name === "edit" || c.name === "write") && typeof args.path === "string") {
        if (r?.isError && !aborted) continue; // Not applied: both tools fail before writing.
        const abs = path.resolve(cwd, args.path);
        const op: Op = { ...base, kind: c.name, certain: !!r && !r.isError, paths: [abs] };
        if (isSecretPath(abs)) op.omitted = "secret-like file";
        else if (c.name === "edit") {
          const patch = r?.details?.patch;
          if (typeof patch === "string") op.patch = patch;
          op.edits = editList(args);
          if ((op.patch?.length ?? 0) + JSON.stringify(op.edits ?? []).length > LIMITS.opBytes) { op.patch = undefined; op.edits = undefined; op.omitted = "larger than the evidence limit"; }
        } else if (typeof args.content !== "string" || args.content.length > LIMITS.opBytes || PRIVATE_KEY.test(args.content)) {
          op.omitted = typeof args.content === "string" ? (PRIVATE_KEY.test(args.content) ? "contains a private key" : "larger than the evidence limit") : "no content";
        } else op.content = args.content;
        ops.push(op);
        continue;
      }
      if (c.name === "apply_patch" && typeof args.input === "string") {
        if (r?.isError && !aborted) continue; // Failed before any file changed; partial failures are not errors.
        const sections = patchSections(args.input, cwd);
        if (!sections) { untraceable[c.name] = (untraceable[c.name] ?? 0) + 1; continue; }
        const paths = [...new Set(sections.flatMap(s => s.move ? [s.path, s.move] : [s.path]))];
        const op: Op = { ...base, kind: "patch", certain: !!r && !r.isError && r.details?.status !== "partial_failure", paths };
        if (paths.some(isSecretPath)) op.omitted = "secret-like file";
        else if (args.input.length > LIMITS.opBytes) op.omitted = "larger than the evidence limit";
        else op.sections = sections;
        ops.push(op);
        continue;
      }
      untraceable[c.name] = (untraceable[c.name] ?? 0) + 1;
    }
  }
  return { agent, ops, untraceable, complete, ...(complete ? {} : { note: "the transcript was compacted and no full session history was available" }) };
}

// ---------------------------------------------------------------- replay

const normalizePunct = (s: string) => s.normalize("NFKC")
  .replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
const LINE_MATCHERS = [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim(), (s: string) => normalizePunct(s.trim())];

function seek(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return -1;
  const from = eof ? lines.length - pattern.length : start;
  for (const same of LINE_MATCHERS) {
    for (let i = Math.max(0, from); i <= lines.length - pattern.length; i++) {
      if (pattern.every((p, j) => same(lines[i + j]) === same(p))) return i;
    }
  }
  return -1;
}

/** Codex update hunks, modeled on the upstream apply-patch algorithm. Replay results are verified by hash. */
function applyUpdate(content: string, body: string[]): string | undefined {
  interface Chunk { anchor?: string; old: string[]; next: string[]; eof: boolean }
  const chunks: Chunk[] = [];
  let cur: Chunk | undefined;
  for (const line of body) {
    if (line === "@@" || line.startsWith("@@ ")) {
      cur = { anchor: line === "@@" ? undefined : line.slice(3), old: [], next: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (line === "*** End of File") { if (cur) cur.eof = true; continue; }
    if (!cur) { cur = { old: [], next: [], eof: false }; chunks.push(cur); }
    if (line === "") { cur.old.push(""); cur.next.push(""); continue; }
    const tag = line[0], text = line.slice(1);
    if (tag === " ") { cur.old.push(text); cur.next.push(text); }
    else if (tag === "-") cur.old.push(text);
    else if (tag === "+") cur.next.push(text);
    else return undefined;
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements: Array<[number, number, string[]]> = [];
  let index = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== undefined) {
      const at = seek(lines, [chunk.anchor], index, false);
      if (at < 0) return undefined;
      index = at + 1;
    }
    if (!chunk.old.length) { replacements.push([lines.length, 0, chunk.next]); continue; }
    let pattern = chunk.old, next = chunk.next;
    let at = seek(lines, pattern, index, chunk.eof);
    if (at < 0 && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (next.at(-1) === "") next = next.slice(0, -1);
      at = seek(lines, pattern, index, chunk.eof);
    }
    if (at < 0) return undefined;
    replacements.push([at, pattern.length, next]);
    index = at + pattern.length;
  }
  replacements.sort((a, b) => a[0] - b[0]);
  for (let i = replacements.length - 1; i >= 0; i--) lines.splice(replacements[i][0], replacements[i][1], ...replacements[i][2]);
  if (lines.at(-1) !== "") lines.push("");
  return lines.join("\n");
}

/** Pi's edit tool: matched on BOM-stripped, LF-normalized text; line endings restored afterwards. */
function applyEdit(before: string, op: Op): string | undefined {
  const bom = before.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? before.slice(1) : before;
  const lf = text.indexOf("\n"), crlf = text.indexOf("\r\n");
  const ending = crlf !== -1 && crlf < lf ? "\r\n" : "\n";
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let next: string | undefined;
  if (op.patch) {
    const applied = applyPatch(norm, op.patch);
    next = typeof applied === "string" ? applied : undefined;
  } else if (op.edits) {
    const found = op.edits.map(e => {
      const old = e.oldText.replace(/\r\n/g, "\n");
      const at = norm.indexOf(old);
      return at >= 0 && norm.indexOf(old, at + 1) < 0 ? { at, len: old.length, text: e.newText.replace(/\r\n/g, "\n") } : undefined;
    });
    if (found.every(Boolean)) {
      next = norm;
      for (const f of [...found].sort((a, b) => b!.at - a!.at)) next = next.slice(0, f!.at) + f!.text + next.slice(f!.at + f!.len);
    }
  }
  if (next === undefined) return undefined;
  return bom + (ending === "\r\n" ? next.replace(/\n/g, "\r\n") : next);
}

/** File content after one operation. null: the file does not exist. undefined: cannot replay. */
function applyOp(op: Op, abs: string, before: string | null | undefined): string | null | undefined {
  if (!op.certain || op.omitted) return undefined;
  if (op.kind === "write") return op.content;
  if (op.kind === "edit") return typeof before === "string" ? applyEdit(before, op) : undefined;
  if (op.kind === "patch") {
    const s = op.sections?.find(x => x.path === abs || x.move === abs);
    if (!s || s.move) return undefined; // Moves span two files; they are shown as operations.
    if (s.type === "delete") return null;
    if (s.type === "add") return s.lines.every(l => l.startsWith("+")) ? (s.lines.length ? s.lines.map(l => l.slice(1)).join("\n") + "\n" : "") : undefined;
    return typeof before === "string" ? applyUpdate(before, s.lines) : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- analysis

type FileStatus = "verified" | "operations" | "unattributed" | "excluded";
interface FileFinding { key: string; status: FileStatus; why?: string; diff?: string; ops?: Op[]; withheld?: string }
type Coverage = "complete" | "tracked" | "incomplete";
interface Analysis {
  coverage: Coverage; notes: string[]; files: FileFinding[];
  /** Untraceable tool calls per agent ID. */
  untraceable: Record<string, Record<string, number>>;
}

function unifiedDiff(key: string, before: string | null, after: string | null): string {
  const text = createTwoFilesPatch(before === null ? "/dev/null" : "a/" + key, after === null ? "/dev/null" : "b/" + key,
    before ?? "", after ?? "", undefined, undefined, { context: 3 });
  return text.replace(/^(Index:.*\n)?=+\n/, "");
}

const describeTools = (tools: Record<string, number>) => Object.entries(tools).map(([t, n]) => t + " ×" + n).join(", ");

function analyzeBatch(base: Snapshot, post: Snapshot, evidence: Evidence[], store: Artifacts): Analysis {
  const notes: string[] = [];
  let incomplete = false;
  const untraceable: Record<string, number> = {};
  const perAgent: Record<string, Record<string, number>> = {};
  for (const ev of evidence) {
    perAgent[ev.agent] = ev.untraceable;
    for (const [t, n] of Object.entries(ev.untraceable)) untraceable[t] = (untraceable[t] ?? 0) + n;
    if (!ev.complete) { incomplete = true; notes.push("Agent " + ev.agent + ": " + (ev.note ?? "the transcript is incomplete") + "."); }
  }
  const shell = Object.keys(untraceable).length > 0;
  const ops = evidence.flatMap(ev => ev.ops).sort((a, b) => a.at - b.at);
  const byPath = new Map<string, Op[]>();
  for (const op of ops) for (const p of op.paths) byPath.set(p, [...(byPath.get(p) ?? []), op]);

  const listed = (s: Snapshot, key: string) => !!s.files[key] && !s.files[key].extra;
  const keys = new Set<string>();
  for (const k of new Set([...Object.keys(base.files), ...Object.keys(post.files)])) {
    if ((listed(base, k) || listed(post, k)) && base.files[k]?.hash !== post.files[k]?.hash) keys.add(k);
  }
  for (const abs of byPath.keys()) keys.add(keyOf(base.root, abs));

  const content = (s: FileState | undefined): string | null | undefined => {
    if (!s) return null;
    if (s.kind !== "text") return undefined;
    return store.get(s.ref)?.toString("utf8");
  };
  const files: FileFinding[] = [];
  for (const key of [...keys].sort()) {
    const abs = absOf(base.root, key);
    const fileOps = byPath.get(abs) ?? [];
    const b = base.files[key], p = post.files[key];
    if (!fileOps.length) {
      files.push(shell
        ? { key, status: "unattributed", why: "changed while agents ran tools whose writes cannot be traced (" + describeTools(untraceable) + "); the parent session or the user can also have made this change" }
        : { key, status: "excluded", why: "no agent tool call changed this file; the parent session or the user changed it" });
      if (shell) incomplete = true;
      continue;
    }
    const kind = p?.kind ?? b?.kind;
    const withheld = isSecretPath(key) || kind === "secret" ? "secret-like file"
      : kind === "binary" ? "binary file" : kind === "link" ? "symbolic link" : undefined;
    if (withheld || fileOps.some(o => o.omitted)) {
      incomplete = true;
      files.push({ key, status: "operations", ops: fileOps, withheld: withheld ?? fileOps.find(o => o.omitted)!.omitted,
        why: "the evidence for this file was not kept, so the review does not cover it" });
      continue;
    }
    if (fileOps.some(o => !o.certain)) {
      incomplete = true;
      files.push({ key, status: "operations", ops: fileOps, why: "an operation was aborted, failed in part, or has no result, so its effect is unknown" });
      continue;
    }
    // The baseline: known content, known absence (listed in the post snapshot but not the baseline), or unknown.
    let before: string | null | undefined;
    if (b) before = content(b);
    else if (listed(post, key) && !base.truncated) before = null;
    const beforeKnown = before !== undefined;
    let expected: string | null | undefined = before;
    for (const op of fileOps) { if (expected === undefined && op.kind !== "write") break; expected = applyOp(op, abs, expected); if (expected === undefined) break; }
    const after = content(p);
    const expectedHash = expected === undefined ? undefined : expected === null ? null : blobHash(Buffer.from(expected, "utf8"));
    const matches = expectedHash !== undefined && (expectedHash === null ? !p : p?.hash === expectedHash);
    if (beforeKnown && matches && after !== undefined) {
      files.push({ key, status: "verified", ops: fileOps, diff: unifiedDiff(key, before!, after) });
      continue;
    }
    let why: string;
    if (!beforeKnown) why = b ? "the baseline content of this " + (b.kind === "large" ? "large file" : "file") + " was not kept"
      : "the file is outside the snapshot (ignored, outside the workspace, or over the file limit), so its earlier content is unknown";
    else if (expected === undefined) why = "the operations do not replay on the baseline content";
    else if (matches) why = "the operations explain the final state, but its content was not kept for a diff";
    else why = "the file also contains changes that these operations do not explain; only the operations are attributed";
    incomplete = true; // Unreconciled operations do not establish a complete delta.
    files.push({ key, status: "operations", ops: fileOps, why });
  }
  if (base.truncated) {
    notes.push("The snapshot is partial: " + base.truncated + ".");
    if (shell) incomplete = true;
  }
  if (base.skipped || post.skipped) notes.push("Some changed text files exceeded the storage limit; their content was not kept.");
  if (base.unread) notes.push(base.unread + " files were not read for the baseline (hashing budget); a change to them shows without a diff.");
  if (shell) {
    notes.push("Agents ran tools whose file writes cannot be traced: " + describeTools(untraceable) + ".");
    notes.push("Writes by these tools outside the listed files (ignored files, other directories) cannot be detected.");
  }
  return { coverage: incomplete ? "incomplete" : shell ? "tracked" : "complete", notes, files, untraceable: perAgent };
}

// ---------------------------------------------------------------- batches

interface AgentEntry {
  id: string; description: string; type: string; route?: string; thinking?: string; prompt?: string;
  since: number; settled: boolean; evidence: boolean;
}
type Origin = "turn" | "escalation" | "restart";
interface BatchMeta {
  version: 1; id: string; origin: Origin; createdAt: number; cwd: string; root: string; git: boolean;
  agents: AgentEntry[]; baselineError?: string; sealedAt?: number; sealError?: string; lost?: string;
}
interface Batch { meta: BatchMeta; store: Artifacts; open: boolean; pending: Map<string, AgentInfo>; announced: boolean }
interface AgentInfo { description?: string; type?: string; route?: string; thinking?: string; prompt?: string }
interface TrackerHost {
  /** Live backend record of an agent, or undefined after /reload or eviction. */
  record(id: string): any;
  append(customType: string, data: Record<string, unknown>): void;
}
type Target = { batch: Batch } | { refuse: string };

class BatchTracker {
  private batches: Batch[] = [];
  private run: { batch?: Batch } | undefined;
  private unbaselinedAt = 0;
  private seq = 0;
  constructor(private readonly host: TrackerHost) {}

  reset(): void { this.batches = []; this.run = undefined; this.unbaselinedAt = 0; }
  list(): readonly Batch[] { return this.batches; }

  beginRun(): void {
    if (this.run) this.endRun(); // A missed agent_end must not leave a batch open forever.
    this.run = {};
  }

  /** The parent run ended: every Agent call of it has returned. */
  endRun(): void {
    const b = this.run?.batch;
    this.run = undefined;
    if (!b) return;
    b.open = false;
    for (const k of [...b.pending.keys()]) if (k.startsWith("call:")) b.pending.delete(k);
    this.settle(b);
  }

  /** Before an Agent call runs. The first call of a run takes the baseline. Returns the batch ID. */
  dispatch(toolCallId: string, cwd: string, info: AgentInfo): string {
    let b = this.run?.batch;
    if (!b && !this.run) {
      // No parent run (a programmatic caller): calls join the last turn batch while it still has calls in flight.
      const last = this.batches.at(-1);
      if (last?.meta.origin === "turn" && last.pending.size && !last.meta.sealedAt) b = last;
    }
    if (!b) {
      b = this.create(cwd, "turn", !!this.run);
      if (this.run) this.run.batch = b;
    }
    b.pending.set("call:" + toolCallId, info);
    return b.meta.id;
  }

  /** The Agent call was blocked or threw before it started an agent. */
  dispatchFailed(toolCallId: string): void {
    const b = this.batches.find(x => x.pending.has("call:" + toolCallId));
    if (!b) return;
    b.pending.delete("call:" + toolCallId);
    this.settle(b);
  }

  /** The Agent call returned, with the agent ID when an agent started or resumed. */
  link(toolCallId: string, agentId: string | undefined, info: AgentInfo = {}): void {
    const b = this.batches.find(x => x.pending.has("call:" + toolCallId));
    if (!b) return;
    const dispatched = b.pending.get("call:" + toolCallId)!;
    b.pending.delete("call:" + toolCallId);
    if (agentId) this.addAgent(b, agentId, { ...dispatched, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) });
    this.settle(b);
  }

  /** Keep the agent's batch unfinished while a restart is decided. Returns the release. */
  hold(agentId: string): () => void {
    const b = this.unsealedWith(agentId);
    if (!b) return () => {};
    const k = "hold:" + agentId + ":" + ++this.seq;
    b.pending.set(k, {});
    return () => { b.pending.delete(k); this.settle(b); };
  }

  /** A router-owned spawn. A restart joins the failed agent's batch; an escalation starts a new batch. */
  spawnTicket(origin: "restart" | "escalation", cwd: string, from?: string): { batchId: string; done(agentId: string | undefined, info: AgentInfo): void } {
    const b = (origin === "restart" && from ? this.unsealedWith(from) : undefined) ?? this.create(cwd, origin, false);
    const k = "spawn:" + ++this.seq;
    b.pending.set(k, {});
    return {
      batchId: b.meta.id,
      done: (agentId, info) => {
        b.pending.delete(k);
        if (agentId) this.addAgent(b, agentId, info);
        this.settle(b);
      },
    };
  }

  /**
   * A backend agent reached a terminal state. Only batches that wait for it capture its
   * transcript: a batch that already holds its evidence keeps it when a later turn resumes it.
   */
  settled(agentId: string): void {
    for (const b of this.batches) {
      const a = b.meta.agents.find(x => x.id === agentId);
      if (!a || a.settled || b.meta.sealedAt || b.meta.lost) continue;
      this.observe(b, a);
      this.settle(b);
    }
  }

  isTracked(agentId: string): boolean { return this.batches.some(b => b.meta.agents.some(a => a.id === agentId)); }

  /** The latest delegation batch, or why it cannot be reviewed now. */
  target(): Target {
    const b = [...this.batches].reverse().find(x => x.meta.agents.length || x.pending.size || x.open);
    if (this.unbaselinedAt && (!b || this.unbaselinedAt > b.meta.createdAt)) {
      return { refuse: "The latest delegation in this session (" + new Date(this.unbaselinedAt).toISOString()
        + ") has no baseline snapshot: it started before batch tracking, so its changes cannot be attributed. Delegate again to review new work." };
    }
    if (!b) return { refuse: "This session has no delegation batch to review." };
    const why = this.blocker(b, true);
    if (why) return { refuse: "Batch " + b.meta.id + " cannot be reviewed yet: " + why };
    if (!b.meta.sealedAt) this.seal(b);
    if (!b.meta.sealedAt) return { refuse: "Batch " + b.meta.id + ": the final snapshot failed: " + (b.meta.sealError ?? "unknown error") };
    return { batch: b };
  }

  analyze(b: Batch): Analysis {
    const base = b.store.read<Snapshot>("baseline.json");
    const post = b.store.read<Snapshot>("post.json");
    if (!base || !post) throw new Error("the snapshots of batch " + b.meta.id + " are missing from " + b.store.dir);
    const evidence = b.meta.agents.map(a => b.store.read<Evidence>(evidenceFile(a.id)));
    if (evidence.some(e => !e)) throw new Error("the agent evidence of batch " + b.meta.id + " is missing from " + b.store.dir);
    return analyzeBatch(base, post, evidence as Evidence[], b.store);
  }

  savePacket(b: Batch, text: string): string {
    const name = "review-" + Date.now().toString(36) + ".md";
    b.store.write(name, text);
    return path.join(b.store.dir, name);
  }

  /** Restore batches after /reload or a session switch. Agents that had not finished are lost. */
  rebuild(entries: any[]): void {
    this.reset();
    const ids: Array<{ id: string; at: number }> = [];
    for (const e of entries) {
      if (e?.type !== "custom") continue;
      const d = e.data;
      if (e.customType === "subtask-review-batch" && typeof d?.batchId === "string" && BATCH_ID.test(d.batchId)) {
        if (!ids.some(x => x.id === d.batchId)) ids.push({ id: d.batchId, at: Number(d.createdAt) || 0 });
      }
      if ((e.customType === "subtask-routing" || e.customType === "subtask-routing-spawn") && d && !d.reviewBatch) {
        const at = Date.parse(e.timestamp);
        if (Number.isFinite(at)) this.unbaselinedAt = Math.max(this.unbaselinedAt, at);
      }
    }
    for (const { id, at } of ids.sort((a, b) => a.at - b.at)) {
      const store = new Artifacts(path.join(STORE, id), "/");
      const meta = store.read<BatchMeta>("batch.json");
      if (!meta || meta.id !== id) {
        const lost: BatchMeta = { version: 1, id, origin: "turn", createdAt: at, cwd: "", root: "", git: false, agents: [{ id: "?", description: "", type: "", since: at, settled: true, evidence: false }],
          lost: "its artifacts are missing from " + store.dir };
        this.batches.push({ meta: lost, store, open: false, pending: new Map(), announced: true });
        continue;
      }
      this.batches.push({ meta, store: new Artifacts(store.dir, meta.root), open: false, pending: new Map(), announced: true });
    }
  }

  // ---- internals

  private create(cwd: string, origin: Origin, open: boolean): Batch {
    prune();
    const id = "b" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
    const { root, git: isGit } = workspaceRoot(cwd);
    const store = new Artifacts(path.join(STORE, id), root);
    const meta: BatchMeta = { version: 1, id, origin, createdAt: Date.now(), cwd, root, git: isGit, agents: [] };
    try { store.write("baseline.json", captureSnapshot(root, isGit, store)); }
    catch (e: any) { meta.baselineError = String(e?.message ?? e).slice(0, 300); }
    const b: Batch = { meta, store, open, pending: new Map(), announced: false };
    this.batches.push(b);
    return b;
  }

  private unsealedWith(agentId: string): Batch | undefined {
    return [...this.batches].reverse().find(b => !b.meta.sealedAt && !b.meta.lost && b.meta.agents.some(a => a.id === agentId));
  }

  private addAgent(b: Batch, id: string, info: AgentInfo): void {
    let a = b.meta.agents.find(x => x.id === id);
    if (!a) {
      a = { id, description: info.description ?? "", type: info.type ?? "", route: info.route, thinking: info.thinking,
        prompt: info.prompt?.slice(0, LIMITS.taskChars), since: b.meta.createdAt, settled: false, evidence: false };
      b.meta.agents.push(a);
    } else {
      a.settled = false; // Resumed within the same batch: capture again when it settles.
      if (info.prompt) a.prompt = ((a.prompt ? a.prompt + "\n\n[Resumed]\n" : "") + info.prompt).slice(0, LIMITS.taskChars);
    }
    if (!b.announced) {
      b.announced = true;
      this.host.append("subtask-review-batch", { batchId: b.meta.id, createdAt: b.meta.createdAt, origin: b.meta.origin });
    }
    this.persist(b);
    this.observe(b, a);
  }

  /** Capture an agent's evidence once its record is terminal. */
  private observe(b: Batch, a: AgentEntry): void {
    const rec = this.host.record(a.id);
    if (!rec) return;
    if (ACTIVE.has(rec.status)) { if (a.settled) { a.settled = false; this.persist(b); } return; }
    const ev = extractEvidence(a.id, rec, rec.worktree?.path ?? b.meta.cwd, a.since);
    if (ev) b.store.write(evidenceFile(a.id), ev);
    a.evidence = !!ev;
    a.settled = true;
    this.persist(b);
  }

  /** Why the batch is unfinished. Only a review request (`final`) declares missing evidence lost. */
  private blocker(b: Batch, final = false): string | undefined {
    if (b.meta.sealedAt) return undefined;
    if (b.meta.lost) return "its evidence is lost: " + b.meta.lost + ".";
    if (b.meta.baselineError) return "the baseline snapshot failed: " + b.meta.baselineError;
    if (b.open) return "the parent turn that started it is still running.";
    if (b.pending.size) return b.pending.size + " Agent call(s) or router restarts have not returned yet.";
    const running: string[] = [];
    for (const a of b.meta.agents) {
      const rec = this.host.record(a.id);
      if (rec && ACTIVE.has(rec.status)) running.push(a.id + " (" + (a.description || a.type) + ", " + rec.status + ")");
      else if (rec && !a.settled) this.observe(b, a);
    }
    if (running.length) return "agents still running: " + running.join(", ") + ". Wait for them, or stop them.";
    const missing = b.meta.agents.filter(a => !a.settled || !a.evidence);
    if (missing.length && !final) return "waiting for the records of agent(s) " + missing.map(a => a.id).join(", ") + ".";
    if (missing.length) {
      b.meta.lost = "no transcript for agent(s) " + missing.map(a => a.id).join(", ")
        + " (they had not finished when Pi reloaded, or their records are gone)";
      this.persist(b);
      return "its evidence is lost: " + b.meta.lost + ".";
    }
    return undefined;
  }

  private settle(b: Batch): void {
    if (b.meta.sealedAt || b.meta.lost || b.meta.baselineError) return;
    if (!b.meta.agents.length) {
      if (!b.open && !b.pending.size) this.discard(b);
      return;
    }
    if (!b.open && !b.pending.size && !this.blocker(b)) this.seal(b);
  }

  /** Final snapshot: every listed file, plus every path that an agent operation named. */
  private seal(b: Batch): void {
    try {
      const base = b.store.read<Snapshot>("baseline.json");
      if (!base) throw new Error("the baseline snapshot is missing");
      const extra = new Set<string>();
      for (const a of b.meta.agents) for (const op of b.store.read<Evidence>(evidenceFile(a.id))?.ops ?? []) for (const p of op.paths) extra.add(p);
      b.store.write("post.json", captureSnapshot(b.meta.root, b.meta.git, b.store, { base, extra: [...extra] }));
      b.meta.sealedAt = Date.now();
      b.meta.sealError = undefined;
    } catch (e: any) {
      b.meta.sealError = String(e?.message ?? e).slice(0, 300);
    }
    this.persist(b);
  }

  private discard(b: Batch): void {
    this.batches = this.batches.filter(x => x !== b);
    try { fs.rmSync(b.store.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  private persist(b: Batch): void {
    try { b.store.write("batch.json", b.meta); } catch { /* the in-memory state still works until reload */ }
  }
}

const evidenceFile = (agentId: string) => "agent-" + agentId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json";

/** Remove batch directories older than the retention period. */
function prune(): void {
  let names: string[];
  try { fs.mkdirSync(STORE, { recursive: true, mode: 0o700 }); names = fs.readdirSync(STORE); } catch { return; }
  const cutoff = Date.now() - LIMITS.retentionMs;
  for (const name of names) {
    if (!BATCH_ID.test(name)) continue;
    const dir = path.join(STORE, name);
    try { if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* skip */ }
  }
}

// ---------------------------------------------------------------- packet

const COVERAGE_TEXT: Record<Coverage, string> = {
  complete: "COMPLETE: every change is attributed to agent tool calls, and no agent ran a tool with untraceable writes.",
  tracked: "COMPLETE FOR TRACKED FILES ONLY: every change to the listed files is accounted for, but agents ran tools with untraceable writes.",
  incomplete: "INCOMPLETE: some changes in this batch cannot be attributed. The review does not cover them.",
};

function fence(text: string, lang = ""): string {
  const ticks = text.includes("```") ? "````" : "```";
  return ticks + lang + "\n" + text.replace(/\n?$/, "\n") + ticks;
}

function renderOp(op: Op, key: string, abs: string): string {
  const head = "- " + op.tool + " by agent " + op.agent + " at " + new Date(op.at).toISOString() + (op.certain ? "" : " (effect unknown)");
  if (op.omitted) return head + ": evidence not kept (" + op.omitted + ").";
  if (op.kind === "edit") {
    if (op.patch) return head + ":\n" + fence(op.patch, "diff");
    if (op.edits) return head + ":\n" + op.edits.map((e, i) => "Replacement " + (i + 1) + ", old text:\n" + fence(e.oldText) + "\nnew text:\n" + fence(e.newText)).join("\n");
    return head + ": no edit details were recorded.";
  }
  if (op.kind === "write") return head + ", full new content:\n" + fence(op.content ?? "");
  if (op.kind === "patch") {
    const s = op.sections?.find(x => x.path === abs || x.move === abs);
    if (!s) return head + ".";
    const header = "*** " + s.type[0].toUpperCase() + s.type.slice(1) + " File: " + key + (s.move ? "\n*** Move to: " + s.move : "");
    return head + ":\n" + fence([header, ...s.lines].join("\n"), "diff");
  }
  return head + ".";
}

/** The reviewer's task message. Attributed evidence first; everything else only by name. */
function buildPacket(meta: BatchMeta, analysis: Analysis, focus?: string): { text: string; redactions: number; truncated: boolean } {
  const out: string[] = [];
  let budget = LIMITS.packetChars, truncated = false;
  const add = (s: string) => { out.push(s); budget -= s.length + 1; };
  const clip = (s: string, max: number) => {
    if (s.length <= max) return s;
    truncated = true;
    return s.slice(0, Math.max(0, max)) + "\n[Evidence truncated; omitted changes are not covered. Current files are context only.]";
  };

  add("# Review packet for delegation batch " + meta.id);
  add("");
  add("Started " + new Date(meta.createdAt).toISOString() + ", sealed " + new Date(meta.sealedAt ?? Date.now()).toISOString()
    + ". Origin: " + meta.origin + ". Workspace: " + meta.root + (meta.git ? " (git)" : "") + ".");
  add("");
  add("## Coverage");
  add(COVERAGE_TEXT[analysis.coverage]);
  for (const n of analysis.notes) add("- " + n);
  add("");
  add("## Agents");
  for (const a of meta.agents) {
    const t = analysis.untraceable[a.id] ?? {};
    add("- " + a.id + ": " + (a.description || "(no description)") + " · type " + (a.type || "?") + (a.route ? " · " + a.route : "")
      + (a.thinking ? " · thinking " + a.thinking : "") + (Object.keys(t).length ? " · untraceable tools: " + describeTools(t) : ""));
  }
  add("");
  add("## Tasks the agents received");
  for (const a of meta.agents) {
    if (!a.prompt) continue;
    add("### " + a.id + (a.description ? ": " + a.description : ""));
    add(fence(clip(a.prompt, LIMITS.taskChars)));
  }
  if (focus?.trim()) { add(""); add("## Focus requested by the user"); add(focus.trim()); }
  add("");
  add("## Attributed changes");
  const attributed = analysis.files.filter(f => f.status === "verified" || f.status === "operations");
  if (!attributed.length) add("None.");
  for (const f of attributed) {
    const abs = absOf(meta.root, f.key);
    if (budget < 2_000) { truncated = true; add("### " + f.key + "\n[omitted: evidence limit reached; these changes are not reviewed]"); continue; }
    if (f.status === "verified") {
      add("### " + f.key + " (verified: diff from the baseline to the final state)");
      add(f.diff?.trim() ? fence(clip(f.diff, Math.min(LIMITS.fileChars, budget - 1_000)), "diff") : "No net change: the operations cancel out.");
      continue;
    }
    add("### " + f.key + " (operations only: " + f.why + ")");
    if (f.withheld) { add("Content withheld: " + f.withheld + "."); continue; }
    add(clip((f.ops ?? []).map(op => renderOp(op, f.key, abs)).join("\n"), Math.min(LIMITS.fileChars, budget - 1_000)));
  }
  const unattributed = analysis.files.filter(f => f.status === "unattributed");
  if (unattributed.length) {
    add("");
    add("## Changed files that are not attributed (not agent work as far as the evidence shows)");
    for (const f of unattributed) add("- " + f.key + ": " + f.why);
  }
  const excluded = analysis.files.filter(f => f.status === "excluded");
  if (excluded.length) {
    add("");
    add("## Excluded: changed by the parent session or the user");
    for (const f of excluded.slice(0, 200)) add("- " + f.key);
    if (excluded.length > 200) add("- ... and " + (excluded.length - 200) + " more");
  }
  if (truncated) { add(""); add("Evidence was truncated. Do not claim coverage of omitted changes; current files cannot reconstruct the attributed delta."); }
  if (truncated) {
    const i = out.indexOf(COVERAGE_TEXT[analysis.coverage]);
    if (i >= 0) out[i] = "INCOMPLETE: review evidence was truncated. Omitted changes are not covered.";
  }
  const { text, count } = redact(out.join("\n"));
  return { text, redactions: count, truncated };
}

/** One-line summary for the user. */
function summarize(a: Analysis): string {
  const n = (s: FileStatus) => a.files.filter(f => f.status === s).length;
  return a.coverage + " coverage · " + n("verified") + " verified, " + n("operations") + " by operations, "
    + n("unattributed") + " unattributed, " + n("excluded") + " excluded";
}

export {
  REVIEWER_TYPE, REVIEWER_MODEL, REVIEWER_THINKING, STORE, LIMITS, NO_WRITES,
  BatchTracker, Artifacts, captureSnapshot, workspaceRoot, extractEvidence, analyzeBatch, buildPacket, summarize,
  applyUpdate, applyEdit, patchSections, isSecretPath, redact, blobHash, unifiedDiff,
};
export type { Batch, BatchMeta, AgentEntry, AgentInfo, Analysis, Evidence, Op, Snapshot, FileState, FileFinding, Coverage, TrackerHost, Target };
