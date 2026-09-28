// Private storage for cache diagnostics: control file, HMAC key, rotated logs and
// per-session baseline state. Every path below the root is refused when it is a
// symlink, not a regular file/directory, or not owned by this user. All IO is
// synchronous, small and best effort; callers catch and never alter requests.
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MiB = 1024 * 1024;
const LOG_FILES = 4; // events.jsonl plus three rotated generations
const LINE_BYTES = 32 * 1024;
const STATE_BYTES = 512 * 1024;
const MAX_SESSIONS = 128;
const CONTROL_BYTES = 4096;
const STALE_LOCK_MS = 30_000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
/** Limits are read per call so tests can lower them; values outside the bounds are ignored. */
export function limits() {
  return {
    logBytes: envInt("PI_CACHE_DIAGNOSTICS_LOG_BYTES", MiB, 4096, 16 * MiB),
    hashChars: envInt("PI_CACHE_DIAGNOSTICS_HASH_BUDGET", 16 * MiB, 1024, 64 * MiB),
    logFiles: LOG_FILES, lineBytes: LINE_BYTES, stateBytes: STATE_BYTES, sessions: MAX_SESSIONS,
  };
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
/** PI_CACHE_DIAGNOSTICS_ROOT (tests) > $PI_CODING_AGENT_DIR/cache-diagnostics > ~/.pi/agent/cache-diagnostics. */
export function rootDir(): string {
  const explicit = process.env.PI_CACHE_DIAGNOSTICS_ROOT;
  if (explicit) return resolve(expandHome(explicit));
  const agent = process.env.PI_CODING_AGENT_DIR;
  return join(agent ? resolve(expandHome(agent)) : join(homedir(), ".pi", "agent"), "cache-diagnostics");
}
export const paths = () => {
  const root = rootDir();
  return {
    root, control: join(root, "control.json"), key: join(root, "key"),
    logs: join(root, "logs"), lock: join(root, "logs", ".rotate.lock"), state: join(root, "state"),
  };
};
export const logFile = (generation: number) =>
  join(paths().logs, generation === 0 ? "events.jsonl" : `events.${generation}.jsonl`);

export class UnsafePathError extends Error {}
// O_NONBLOCK: a FIFO or device planted at a private path must not block open();
// the regular-file check after open then refuses it. No effect on regular files.
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);
const code = (error: unknown) => (error as { code?: string })?.code;

/** Creates (0700) or validates a private directory. The agent root above it may be a symlink. */
export function ensurePrivateDir(path: string): void {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafePathError("private directory is not a real directory");
  if (uid() !== undefined && info.uid !== uid()) throw new UnsafePathError("private directory has another owner");
  // chmod follows symlinks, but the lstat above proved this is a real directory.
  if ((info.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

function checkOpenFile(fd: number, maxBytes?: number, maxLinks = 1): void {
  const info = fstatSync(fd);
  if (!info.isFile()) throw new UnsafePathError("not a regular file");
  if (info.nlink > maxLinks) throw new UnsafePathError("hard-linked file refused");
  if (uid() !== undefined && info.uid !== uid()) throw new UnsafePathError("file has another owner");
  if (maxBytes !== undefined && info.size > maxBytes) throw new UnsafePathError("file exceeds size cap");
}

/** Reads a small private file without following symlinks. Throws ENOENT when absent. */
export function readPrivate(path: string, maxBytes: number): string {
  const fd = openSync(path, READ);
  try {
    checkOpenFile(fd, maxBytes);
    const buffer = Buffer.alloc(fstatSync(fd).size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally { closeSync(fd); }
}

function writeNew(path: string, data: string): void {
  const fd = openSync(path, CREATE, 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, data); } finally { closeSync(fd); }
}
function refuseSymlink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new UnsafePathError("symlink refused"); }
  catch (error) { if (code(error) !== "ENOENT") throw error; }
}
/** Atomic replace: private temp file in the same directory, then rename. */
export function writeAtomic(dir: string, name: string, data: string): void {
  const target = join(dir, name);
  refuseSymlink(target);
  const temp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  writeNew(temp, data);
  try { renameSync(temp, target); } catch (error) { try { unlinkSync(temp); } catch { /* gone */ } throw error; }
}

// ---------------------------------------------------------------- control

export type Control = { enabled: boolean; since?: number; problem?: "unsafe" | "invalid" };
/** Fails closed: absent, unsafe, oversized, corrupt or wrong-shape control means OFF. Never creates files. */
export function readControl(): Control {
  try {
    const parsed: unknown = JSON.parse(readPrivate(paths().control, CONTROL_BYTES));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { enabled: false, problem: "invalid" };
    const { enabled, since } = parsed as { enabled?: unknown; since?: unknown };
    return { enabled: enabled === true, ...(typeof since === "number" && Number.isFinite(since) ? { since } : {}) };
  } catch (error) {
    if (code(error) === "ENOENT") return { enabled: false };
    return { enabled: false, problem: error instanceof SyntaxError ? "invalid" : "unsafe" };
  }
}
export function writeControl(enabled: boolean): void {
  const { root } = paths();
  ensurePrivateDir(root);
  writeAtomic(root, "control.json", JSON.stringify({ enabled, since: Date.now() }) + "\n");
}

// ---------------------------------------------------------------- key

/**
 * Persistent random HMAC key. Creation is race-free across processes: a complete
 * private temp file is hard-linked to the final name, so readers never observe a
 * partial key and exactly one creator wins. Loose permissions are refused.
 */
export function loadKey(create: boolean): Buffer | undefined {
  const { root, key } = paths();
  const read = (): Buffer => {
    const fd = openSync(key, READ);
    let text: string;
    try {
      // Two links exist only while a creator is between link() and unlink() below.
      checkOpenFile(fd, 128, 2);
      if ((fstatSync(fd).mode & 0o077) !== 0) throw new UnsafePathError("key permissions too open");
      const buffer = Buffer.alloc(128);
      text = buffer.subarray(0, readSync(fd, buffer, 0, 128, 0)).toString("utf8").trim();
    } finally { closeSync(fd); }
    if (!/^[0-9a-f]{64}$/.test(text)) throw new UnsafePathError("key file malformed");
    return Buffer.from(text, "hex");
  };
  try { return read(); } catch (error) { if (code(error) !== "ENOENT" || !create) { if (code(error) === "ENOENT") return undefined; throw error; } }
  ensurePrivateDir(root);
  const temp = join(root, `.key.${randomBytes(6).toString("hex")}.tmp`);
  writeNew(temp, randomBytes(32).toString("hex") + "\n");
  try {
    // link() fails with EEXIST when another process won; the O_EXCL temp file is
    // what the link points at, so hard-link count is 2 only for this instant.
    try { linkSync(temp, key); } catch (error) { if (code(error) !== "EEXIST") throw error; }
  } finally { try { unlinkSync(temp); } catch { /* best effort */ } }
  return read();
}

// ---------------------------------------------------------------- logs

function sizeOf(path: string): number {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new UnsafePathError("log path is not a regular file");
    return info.size;
  } catch (error) { if (code(error) === "ENOENT") return 0; throw error; }
}
function acquireLock(): boolean {
  const { lock } = paths();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); return true; } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      try {
        const info = lstatSync(lock);
        if (!info.isSymbolicLink() && info.isDirectory() && Date.now() - info.mtimeMs > STALE_LOCK_MS) { rmdirSync(lock); continue; }
      } catch { /* raced */ }
      return false;
    }
  }
  return false;
}
function rotate(): void {
  const { logFiles, logBytes } = limits();
  if (!acquireLock()) return;
  try {
    if (sizeOf(logFile(0)) < logBytes) return; // another process rotated already
    for (let generation = logFiles - 1; generation >= 1; generation--) {
      const source = logFile(generation - 1);
      try { lstatSync(source); } catch { continue; } // generation absent
      sizeOf(source); // throws for symlinks and non-files
      renameSync(source, logFile(generation)); // replaces the oldest generation
    }
  } finally { try { rmdirSync(paths().lock); } catch { /* best effort */ } }
}
/** Appends one JSON line. A single O_APPEND write per record keeps concurrent writers line-atomic. */
export function appendRecord(record: Record<string, unknown>): void {
  const { logs, root } = paths();
  const { lineBytes, logBytes } = limits();
  const line = Buffer.from(JSON.stringify(record) + "\n");
  if (line.length > lineBytes) throw new Error("record exceeds line cap");
  ensurePrivateDir(root); ensurePrivateDir(logs);
  if (sizeOf(logFile(0)) + line.length > logBytes) rotate();
  // A busy rotation lock lets writers exceed the cap by at most one extra cap.
  if (sizeOf(logFile(0)) + line.length > 2 * logBytes) throw new Error("log full and rotation busy");
  const fd = openSync(logFile(0), APPEND, 0o600);
  try {
    checkOpenFile(fd);
    if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    writeSync(fd, line);
  } finally { closeSync(fd); }
}
/** Reads every log generation, oldest first, bounded by the rotation caps. */
export function readLogLines(): string[] {
  const { logFiles, logBytes } = limits();
  const lines: string[] = [];
  for (let generation = logFiles - 1; generation >= 0; generation--) {
    try { lines.push(...readPrivate(logFile(generation), 2 * logBytes + LINE_BYTES).split("\n").filter(Boolean)); }
    catch (error) { if (code(error) !== "ENOENT") throw error; }
  }
  return lines;
}

// ---------------------------------------------------------------- per-session baseline state

const STATE_NAME = /^[0-9a-f]{24}\.json$/;
/** Reads one baseline and validates it with `parse`; absent or invalid state is undefined. */
export function readState<T>(sessionHash: string, parse: (value: unknown) => T | undefined): T | undefined {
  if (!STATE_NAME.test(`${sessionHash}.json`)) return undefined;
  let text: string;
  try { text = readPrivate(join(paths().state, `${sessionHash}.json`), STATE_BYTES); }
  catch (error) { if (code(error) === "ENOENT") return undefined; throw error; }
  try { return parse(JSON.parse(text)); } catch { return undefined; }
}
export function writeState(sessionHash: string, state: Record<string, unknown>): void {
  const { root, state: dir } = paths();
  const name = `${sessionHash}.json`;
  if (!STATE_NAME.test(name)) throw new Error("invalid state name");
  const data = JSON.stringify(state);
  if (Buffer.byteLength(data) > STATE_BYTES) throw new Error("state exceeds cap");
  ensurePrivateDir(root); ensurePrivateDir(dir);
  let existed = true;
  try { lstatSync(join(dir, name)); } catch { existed = false; }
  writeAtomic(dir, name, data);
  if (!existed) pruneStates();
}
/** Keeps the newest MAX_SESSIONS baselines. Runs only when a new session file appears. */
function pruneStates(): void {
  const dir = paths().state;
  const entries = readdirSync(dir).filter((name) => STATE_NAME.test(name))
    .map((name) => { try { return { name, mtime: lstatSync(join(dir, name)).mtimeMs }; } catch { return undefined; } })
    .filter((entry): entry is { name: string; mtime: number } => !!entry)
    .sort((a, b) => a.mtime - b.mtime);
  for (const entry of entries.slice(0, Math.max(0, entries.length - limits().sessions)))
    try { unlinkSync(join(dir, entry.name)); } catch { /* raced */ }
}

// ---------------------------------------------------------------- status / purge

export function status() {
  const p = paths();
  const control = readControl();
  let logBytes = 0, logFilesPresent = 0, sessions = 0, keyPresent = false;
  for (let generation = 0; generation < limits().logFiles; generation++) {
    try { const info = lstatSync(logFile(generation)); if (info.isFile()) { logBytes += info.size; logFilesPresent++; } } catch { /* absent */ }
  }
  try { sessions = readdirSync(p.state).filter((name) => STATE_NAME.test(name)).length; } catch { /* absent */ }
  try { keyPresent = lstatSync(p.key).isFile(); } catch { /* absent */ }
  return { control, logBytes, logFilesPresent, sessions, keyPresent, root: p.root };
}
/** Removes logs, baselines and the key. Symlinks are unlinked, never followed. The control file stays. */
export function purge(): void {
  const p = paths();
  for (const path of [p.logs, p.state, p.key]) {
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || info.isFile()) unlinkSync(path);
      else rmSync(path, { recursive: true, force: true });
    } catch (error) { if (code(error) !== "ENOENT") throw error; }
  }
  try { for (const name of readdirSync(p.root)) if (/^\..*\.tmp$/.test(name)) unlinkSync(join(p.root, name)); } catch { /* absent */ }
}
export const exists = (path: string) => { try { statSync(path); return true; } catch { return false; } };
