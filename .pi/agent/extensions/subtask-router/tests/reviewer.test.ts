import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createTwoFilesPatch } from "../../../npm/node_modules/diff/libesm/index.js";

// Private artifact store inside a scratch workspace, so the exclusion of the store is testable.
const SCRATCH = mkdtempSync(join(tmpdir(), "reviewer-test-"));
process.env.PI_SUBTASK_ROUTER_REVIEWS ??= join(SCRATCH, "reviews");
const R = await import("../reviewer.ts");

const put = (dir: string, p: string, c: string | Buffer) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };
const workspace = () => mkdtempSync(join(tmpdir(), "reviewer-ws-"));
const store = (root: string) => new R.Artifacts(mkdtempSync(join(tmpdir(), "reviewer-artifacts-")), root);

let seq = 0;
function call(name: string, args: object, result: { details?: any; isError?: boolean; text?: string } | null = {}, at = Date.now()) {
  const id = "c" + ++seq;
  const msgs: any[] = [{ role: "assistant", timestamp: at, content: [{ type: "toolCall", id, name, arguments: args }] }];
  if (result) msgs.push({ role: "toolResult", toolCallId: id, toolName: name, isError: !!result.isError, timestamp: at,
    details: result.details, content: [{ type: "text", text: result.text ?? "ok" }] });
  return msgs;
}
const evidence = (messages: any[], cwd: string, since = 0) => R.extractEvidence("a1", { session: { messages } }, cwd, since)!;

test("Codex update hunks replay like apply_patch, including anchors, whitespace fuzz, and appends", () => {
  expect(R.applyUpdate("a\nb\nc\nd\n", ["@@ b", " c", "-d", "+D"])).toBe("a\nb\nc\nD\n");
  // Like Codex, matched context lines are rewritten from the patch text.
  expect(R.applyUpdate("x  \ny\n", [" x", "-y", "+z"])).toBe("x\nz\n");
  expect(R.applyUpdate("a\n", ["@@", "+b"])).toBe("a\nb\n");
  expect(R.applyUpdate("a\n", [" missing", "-a"])).toBeUndefined();
  expect(R.applyUpdate("a\n", ["?bad"])).toBeUndefined();
});

test("edit replay uses the tool's patch and keeps CRLF line endings and the BOM", () => {
  const patch = createTwoFilesPatch("f", "f", "a\nb\n", "a\nc\n");
  const op: any = { kind: "edit", certain: true, paths: ["/f"], patch };
  expect(R.applyEdit("﻿a\r\nb\r\n", op)).toBe("﻿a\r\nc\r\n");
  expect(R.applyEdit("a\nZ\n", op)).toBeUndefined();
  // Without a patch, exact unique replacements.
  expect(R.applyEdit("a\nb\n", { ...op, patch: undefined, edits: [{ oldText: "b", newText: "B" }] })).toBe("a\nB\n");
  expect(R.applyEdit("b\nb\n", { ...op, patch: undefined, edits: [{ oldText: "b", newText: "B" }] })).toBeUndefined();
});

test("apply_patch sections resolve paths, moves, and heredoc wrappers", () => {
  const text = "<<'EOF'\n*** Begin Patch\n*** Add File: n.ts\n+new\n*** Update File: @src/a.ts\n*** Move to: src/b.ts\n@@\n-x\n+y\n*** Delete File: /abs/old.ts\n*** End Patch\nEOF";
  const s = R.patchSections(text, "/w")!;
  expect(s.map(x => [x.type, x.path, x.move])).toEqual([["add", "/w/n.ts", undefined], ["update", "/w/src/a.ts", "/w/src/b.ts"], ["delete", "/abs/old.ts", undefined]]);
  expect(R.patchSections("not a patch", "/w")).toBeUndefined();
});

test("transcripts become operations; failures, reads, and earlier runs are not attributed", () => {
  const since = Date.now();
  const ev = evidence([
    ...call("write", { path: "old.ts", content: "earlier run" }, {}, since - 1000),
    ...call("read", { path: "a.ts" }),
    ...call("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, { details: { patch: "PATCH" } }),
    ...call("edit", { path: "b.ts", oldText: "x", newText: "y" }, { isError: true, text: "Could not find the exact text" }),
    ...call("edit", { path: "c.ts", edits: "[{\"oldText\":\"1\",\"newText\":\"2\"}]" }, { isError: true, text: "Operation aborted" }),
    ...call("write", { path: "d.ts", content: "D" }),
    ...call("write", { path: "e.ts", content: "E" }, null),
    ...call("write", { path: ".env", content: "KEY=1" }),
    ...call("write", { path: "k.txt", content: "-----BEGIN RSA PRIVATE KEY-----\nabc" }),
    ...call("apply_patch", { input: "*** Begin Patch\n*** Update File: f.ts\n@@\n-a\n+b\n*** End Patch" }, { details: { status: "success" } }),
    ...call("apply_patch", { input: "*** Begin Patch\n*** Update File: g.ts\n@@\n-a\n+b\n*** End Patch" }, { details: { status: "partial_failure" } }),
    ...call("apply_patch", { input: "*** Begin Patch\n*** Update File: h.ts\n@@\n-a\n+b\n*** End Patch" }, { isError: true, text: "apply_patch failed" }),
    ...call("bash", { command: "npm test" }),
    ...call("exec", { code: "tools.write()" }),
  ], "/w", since);
  const byPath = Object.fromEntries(ev.ops.map(o => [o.paths.join(","), o]));
  expect(Object.keys(byPath).sort()).toEqual(["/w/.env", "/w/a.ts", "/w/c.ts", "/w/d.ts", "/w/e.ts", "/w/f.ts", "/w/g.ts", "/w/k.txt"]);
  expect(byPath["/w/a.ts"]).toMatchObject({ kind: "edit", certain: true, patch: "PATCH" });
  expect(byPath["/w/c.ts"]).toMatchObject({ certain: false, edits: [{ oldText: "1", newText: "2" }] });
  expect(byPath["/w/d.ts"]).toMatchObject({ kind: "write", certain: true, content: "D" });
  expect(byPath["/w/e.ts"].certain).toBe(false);
  expect(byPath["/w/.env"]).toMatchObject({ omitted: "secret-like file" });
  expect(byPath["/w/.env"].content).toBeUndefined();
  expect(byPath["/w/k.txt"]).toMatchObject({ omitted: "contains a private key" });
  expect(byPath["/w/f.ts"]).toMatchObject({ kind: "patch", certain: true });
  expect(byPath["/w/g.ts"].certain).toBe(false);
  expect(ev.untraceable).toEqual({ bash: 1, exec: 1 });
  expect(ev.complete).toBe(true);
  // A compacted live transcript without a session manager is incomplete.
  expect(R.extractEvidence("a1", { compactionCount: 1, session: { messages: [] } }, "/w", 0)!.complete).toBe(false);
  // The session manager keeps entries that compaction removed from the context.
  const full = R.extractEvidence("a1", { compactionCount: 2, session: { messages: [], sessionManager: { getEntries: () =>
    call("write", { path: "z.ts", content: "Z" }).map(message => ({ type: "message", message })) } } }, "/w", 0)!;
  expect(full.complete).toBe(true);
  expect(full.ops[0].paths).toEqual(["/w/z.ts"]);
});

test("snapshots keep no secret, binary, or artifact-store content", () => {
  const ws = dirname(R.STORE);
  mkdirSync(R.STORE, { recursive: true });
  put(R.STORE, "b0-000000/blobs/x", "store content");
  put(ws, "plain.ts", "plain\n");
  put(ws, ".env", "KEY=secret\n");
  put(ws, "tokens.json", "{\"a\":1}\n");
  put(ws, "tokens.ts", "export const tokens = 1;\n");
  put(ws, "key.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
  put(ws, "bin.dat", Buffer.from([1, 0, 2]));
  const s = store(ws);
  const snap = R.captureSnapshot(ws, false, s);
  expect(Object.keys(snap.files).some(k => k.startsWith("reviews/") || k.includes("b0-000000"))).toBe(false);
  expect(snap.files[".env"]).toMatchObject({ kind: "secret" });
  expect(snap.files["tokens.json"].kind).toBe("secret");
  expect(snap.files["tokens.ts"].kind).toBe("text");
  expect(snap.files["key.txt"].kind).toBe("secret");
  expect(snap.files["bin.dat"].kind).toBe("binary");
  for (const k of [".env", "tokens.json", "key.txt", "bin.dat"]) expect(snap.files[k].ref).toBeUndefined();
  const blobs = readdirSync(join(s.dir, "blobs"));
  expect(blobs).toContain(snap.files["plain.ts"].hash);
  expect(blobs).not.toContain(snap.files[".env"].hash);
  rmSync(join(ws, ".env"));
  rmSync(join(ws, "key.txt"));
});

test("the final snapshot sees a same-size rewrite in the same timestamp tick, and reuses settled files by stat", () => {
  const ws = workspace();
  put(ws, "a.txt", "aaaa\n");
  put(ws, "b.txt", "keep\n");
  const s = store(ws);
  const base = R.captureSnapshot(ws, false, s);
  put(ws, "a.txt", "bbbb\n"); // Same size, usually the same coarse timestamp: the stat alone cannot tell.
  const post = R.captureSnapshot(ws, false, s, { base });
  expect(post.files["a.txt"].hash).not.toBe(base.files["a.txt"].hash);
  expect(post.files["b.txt"].hash).toBe(base.files["b.txt"].hash);
  // A file last changed well before the baseline is not read again.
  const old = { ...base, at: base.at + 60_000, files: { ...base.files, "b.txt": { ...base.files["b.txt"], hash: "from-stat" } } };
  expect(R.captureSnapshot(ws, false, s, { base: old }).files["b.txt"].hash).toBe("from-stat");
});

test("shared-file changes stay operations-only and coverage is incomplete", () => {
  const ws = workspace();
  put(ws, "p.ts", "one\ntwo\n");
  put(ws, "shared.ts", "x\ny\n");
  put(ws, "user.ts", "u\n");
  const s = store(ws);
  const base = R.captureSnapshot(ws, false, s);
  const since = Date.now();
  put(ws, "p.ts", "one\nTWO\n");
  put(ws, "new.ts", "created\n");
  put(ws, "shared.ts", "x\nY\n");
  const patch = createTwoFilesPatch("shared.ts", "shared.ts", "x\ny\n", "x\nY\n");
  put(ws, "shared.ts", "user\nx\nY\n"); // The user edits the same file afterwards.
  put(ws, "user.ts", "u\nchanged\n");
  const ev = evidence([
    ...call("apply_patch", { input: "*** Begin Patch\n*** Update File: p.ts\n@@\n one\n-two\n+TWO\n*** Add File: new.ts\n+created\n*** End Patch" }, { details: { status: "success" } }),
    ...call("edit", { path: "shared.ts", edits: [{ oldText: "y", newText: "Y" }] }, { details: { patch } }),
  ], ws, since);
  const post = R.captureSnapshot(ws, false, s, { base, extra: ev.ops.flatMap(o => o.paths) });
  const a = R.analyzeBatch(base, post, [ev], s);
  const status = Object.fromEntries(a.files.map(f => [f.key, f.status]));
  expect(status).toEqual({ "new.ts": "verified", "p.ts": "verified", "shared.ts": "operations", "user.ts": "excluded" });
  expect(a.coverage).toBe("incomplete");
  expect(a.files.find(f => f.key === "p.ts")!.diff).toContain("+TWO");
  const packet = R.buildPacket({ version: 1, id: "b1-000000", origin: "turn", createdAt: since, cwd: ws, root: ws, git: false,
    agents: [{ id: "a1", description: "d", type: "general-purpose", prompt: "Task text", since, settled: true, evidence: true }] }, a);
  expect(packet.text).toContain("INCOMPLETE:");
  expect(packet.text).toContain("### shared.ts (operations only:");
  expect(packet.text).toContain("+Y");
  expect(packet.text).not.toContain("user\nx");
  expect(packet.text).not.toContain("+user");
  expect(packet.text).toContain("- user.ts");
  expect(packet.text).not.toContain("+changed");
});

test("secret-like files changed by agents are withheld and make coverage incomplete", () => {
  const ws = workspace();
  put(ws, ".env", "A=1\n");
  const s = store(ws);
  const base = R.captureSnapshot(ws, false, s);
  put(ws, ".env", "A=2\n");
  const ev = evidence(call("write", { path: ".env", content: "A=2\n" }), ws);
  const post = R.captureSnapshot(ws, false, s, { base, extra: [join(ws, ".env")] });
  const a = R.analyzeBatch(base, post, [ev], s);
  expect(a.coverage).toBe("incomplete");
  expect(a.files[0]).toMatchObject({ key: ".env", status: "operations", withheld: "secret-like file" });
  const packet = R.buildPacket({ version: 1, id: "b1-000000", origin: "turn", createdAt: 0, cwd: ws, root: ws, git: false, agents: [] }, a);
  expect(packet.text).not.toContain("A=2");
});

test("files outside the snapshot keep exact operations but no invented baseline", () => {
  const ws = workspace(), outside = workspace();
  const s = store(ws);
  const base = R.captureSnapshot(ws, false, s);
  put(outside, "o.ts", "made\n");
  const ev = evidence(call("write", { path: join(outside, "o.ts"), content: "made\n" }), ws);
  const post = R.captureSnapshot(ws, false, s, { base, extra: [join(outside, "o.ts")] });
  const a = R.analyzeBatch(base, post, [ev], s);
  expect(a.files[0]).toMatchObject({ status: "operations" });
  expect(a.files[0].why).toContain("outside the snapshot");
  expect(a.coverage).toBe("incomplete");
});

test("secret-like values are redacted from packets", () => {
  const r = R.redact("a sk-abcdefghijklmnopqrstuvwxyz123 b ghp_" + "x".repeat(36) + " c AKIAABCDEFGHIJKLMNOP");
  expect(r.count).toBe(3);
  expect(r.text).toBe("a [redacted] b [redacted] c [redacted]");
});

test("per-file truncation cannot claim complete review coverage", () => {
  const old = R.LIMITS.fileChars;
  try {
    R.LIMITS.fileChars = 10;
    const packet = R.buildPacket({ version: 1, id: "b1-000000", origin: "turn", createdAt: 0, cwd: "/w", root: "/w", git: false, agents: [] },
      { coverage: "complete", notes: [], untraceable: {}, files: [{ key: "a.ts", status: "verified", diff: "a".repeat(100) }] });
    expect(packet.truncated).toBe(true);
    expect(packet.text).toContain("INCOMPLETE: review evidence was truncated");
  } finally { R.LIMITS.fileChars = old; }
});
