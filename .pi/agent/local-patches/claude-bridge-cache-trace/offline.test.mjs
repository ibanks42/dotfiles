import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { createCacheTrace } from './payload/src/cache-trace.ts';

const assets = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(join(assets, 'payload/src/index.ts'), 'utf8');
const stock = readFileSync(join(assets, 'pristine/src/index.ts'), 'utf8');
const transcript = readFileSync(join(assets, 'pristine/src/transcript.ts'), 'utf8');
const secret = 'SENTINEL_SECRET_/private/path_AUTH_tool_prompt_session';
function extract(text, name) {
 const start = text.indexOf(`function ${name}`);
 assert.ok(start >= 0, name);
 const end = text.indexOf('\n}', start) + 2;
 return stripTypeScriptTypes(text.slice(start, end));
}
function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), 'cache-trace-test-'));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 let clock = 100;
 const trace = createCacheTrace({ agentDir: root, now: () => clock });
 const enable = (value = true) => writeFileSync(join(root, 'claude-bridge-cache-trace.json'), JSON.stringify({ enabled: value, fingerprints: true }), { mode: 0o600 });
 const records = () => {
  const dir = join(root, 'claude-bridge-cache-trace');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort().flatMap(n => readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
 };
 return { root, trace, enable, records, time: n => clock = n };
}
function start(f, c = {}, session = secret, prompt = secret) {
 const q = {};
 const token = f.trace.start(c, session, 'claude-opus-4-6', 'high', prompt, [{ name: secret, parameters: { description: secret } }], 3);
 f.trace.bind(token, q);
 return { q, c, token };
}
function bridge(trace, text = source) {
 const io = [];
 let next = 0;
 const sandbox = {
  cacheTrace: trace, sharedSessions: new Map(), historyRewrittenBySession: new Set(), activeQueryContexts: new Set(), abandonedQueries: new WeakSet(),
  debug() {}, debugSessionPaths() {}, process: { env: {} },
  readCarriedAttachments() { return []; },
  deleteSession(id) { io.push(['delete', id]); },
  createSession(options) { io.push(['create', options]); return { sessionId: options.sessionId ?? `generated-${++next}`, records: [], save() {}, jsonlPath: secret }; },
  convertAndImportMessages(s, messages) { s.records.push(...messages); }, verifyWrittenSession() {},
  calculateCost() {},
 };
 vm.createContext(sandbox);
 const names = ['sessionKey', 'sessionStateFor', 'setSessionStateFor', 'turnStart', 'syncSharedSession', 'markRebuildForSession', 'armStaleContexts', 'steerMissedSession', 'discardRewrittenQuery', 'updateUsage'];
 vm.runInContext(extract(transcript, 'nonSystemMessages') + '\n' + names.map(n => extract(text, n)).join('\n'), sandbox);
 return { b: sandbox, io };
}
const user = () => ({ role: 'user', content: secret });
const assistant = () => ({ role: 'assistant', content: secret });
const history = () => [{ role: 'system', content: secret }, user(), assistant(), user()];

test('disabled default creates no directory; runtime off invalidates live state', t => {
 const f = fixture(t); const a = start(f); f.trace.finish(a.q, 'completed', secret);
 assert.equal(existsSync(join(f.root, 'claude-bridge-cache-trace')), false);
 f.enable(); const b = start(f); const before = f.records().length;
 f.enable(false); f.trace.continuation(b.c, 9); f.trace.finish(b.q, 'completed');
 assert.equal(f.records().length, before);
 f.enable(); f.trace.finish(b.q, 'completed'); assert.equal(f.records().length, before);
 const fresh = start(f); assert.equal(f.records().at(-1).idleMs, null);
 f.trace.finish(fresh.q, 'completed');
});

test('actual sync branches match stock IO and return values; only observations added', t => {
 const f = fixture(t); f.enable();
 const scenarios = [
  [null, [user()], 'clean_no_priors'],
  [null, history(), 'rebuild_first'],
  [{ sessionId: secret, cursor: 2 }, history(), 'reuse'],
  [{ sessionId: secret, cursor: 1 }, history(), 'reuse_trailing_assistant'],
  [{ sessionId: secret, cursor: 5 }, history(), 'clean_shorter'],
  [{ sessionId: secret, cursor: 0 }, history(), 'rebuild_preserve'],
  [{ sessionId: secret, cursor: 2, needsRebuild: true }, history(), 'rebuild_preserve'],
  [{ sessionId: secret, cursor: 2, needsRebuild: true, forceRotate: true }, history(), 'rebuild_rotate'],
 ];
 for (const [state, messages, branch] of scenarios) {
  const patched = bridge(f.trace); const pristine = bridge(f.trace, stock);
  for (const { b } of [patched, pristine]) b.setSessionStateFor(secret, state ? { ...state } : null);
  start(f);
  const actual = patched.b.syncSharedSession(messages, secret, undefined, 'claude-opus-4-6', secret);
  const expected = pristine.b.syncSharedSession(messages, secret, undefined, 'claude-opus-4-6', secret);
  const normalize = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(normalize(actual), normalize(expected));
  assert.deepEqual(normalize(patched.io), normalize(pristine.io));
  assert.deepEqual(normalize(patched.b.sessionStateFor(secret)), normalize(pristine.b.sessionStateFor(secret)));
  const row = f.records().filter(r => r.event === 'sync').at(-1);
  assert.equal(row.branch, branch);
  assert.equal(row.history, messages.filter(m => m.role !== 'system').length);
  assert.equal(row.needsRebuild, state?.needsRebuild === true);
  assert.equal(row.forceRotate, state?.forceRotate === true);
  assert.ok(row.query);
 }
});

test('actual compaction/tree, missed steering and discard hooks isolate siblings', t => {
 const f = fixture(t); f.enable(); const { b } = bridge(f.trace);
 const make = id => ({ piSessionId: id, activeQuery: {}, turnToolCallIds: [], promptStream: { fail() {} }, releasePendingToolCalls() {} });
 const parent = make(secret); const child = make(secret + '-child');
 start(f, parent, secret); start(f, child, secret + '-child');
 b.activeQueryContexts.add(parent); b.activeQueryContexts.add(child);
 b.setSessionStateFor(secret, { sessionId: secret, cursor: 2 });
 b.setSessionStateFor(secret + '-child', { sessionId: secret + '-child', cursor: 2 });
 b.markRebuildForSession(secret + '-child', `session_compact:${secret}:willRetry=true`);
 assert.equal(child.historyStale, true); assert.equal(parent.historyStale, undefined);
 assert.equal(b.sessionStateFor(secret).needsRebuild, undefined);
 assert.equal(b.sessionStateFor(secret + '-child').needsRebuild, true);
 b.markRebuildForSession(secret + '-child', 'session_tree');
 b.steerMissedSession(child, secret);
 b.discardRewrittenQuery(child);
 assert.equal(b.sessionStateFor(secret + '-child').forceRotate, true);
 assert.equal(b.sessionStateFor(secret).forceRotate, undefined);
 b.syncSharedSession(history(), secret, undefined, undefined, secret + '-child');
 assert.equal(f.records().filter(r => r.event === 'sync').at(-1).branch, 'rebuild_rotate');
 assert.deepEqual(f.records().filter(r => r.event === 'mark').map(r => r.reason), ['missed_steering', 'rewritten_parked_query']);
 assert.equal(f.records().filter(r => r.event === 'rewrite')[0].reason, 'session_compact');
});

test('query identity survives context replacement; idle excludes tool boundaries; usage snapshots are not added', t => {
 const f = fixture(t); f.enable(); const c = {}; const a = start(f, c);
 f.time(200); f.trace.continuation(c, 2); f.time(300); f.trace.continuation(c, 1);
 f.trace.finish(a.q, 'completed', secret);
 f.time(350); const child = start(f, {}, secret + '-child');
 f.time(500); const replacement = start(f, c);
 assert.equal(f.records().filter(r => r.event === 'start').at(-1).idleMs, 200);
 assert.equal(f.records().filter(r => r.event === 'start')[1].idleMs, null);
 const output = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
 const { b } = bridge(f.trace);
 f.trace.output(replacement.q, output);
 const usage = { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 6, [secret]: secret };
 b.updateUsage(output, usage, { id: secret }); b.updateUsage(output, usage, { id: secret });
 const rows = f.records().filter(r => r.event === 'usage');
 assert.equal(rows.length, 2); assert.equal(rows[1].cacheRead, 100); assert.equal(rows[1].aggregation, 'none');
 assert.equal(rows[1].kind, 'snapshot_partial'); assert.equal(rows[1].observation, 2);
 f.trace.finish(a.q, 'abandoned'); // A duplicate cannot finish the replacement.
 f.trace.finish(child.q, 'aborted'); f.trace.finish(replacement.q, 'error');
 const ends = f.records().filter(r => r.event === 'finish');
 assert.deepEqual(ends.map(r => r.reason), ['completed', 'aborted', 'error']);
 assert.equal(ends[2].query, rows[0].query); assert.notEqual(ends[1].session, ends[2].session);
});

test('late completion from discarded query retains original identity', t => {
 const f = fixture(t); f.enable(); const c = {}; const old = start(f, c); const current = start(f, c);
 f.trace.mark(c, 'rewritten_parked_query');
 f.trace.finish(old.q, 'abandoned', secret); f.trace.finish(current.q, 'completed', secret);
 const starts = f.records().filter(r => r.event === 'start'); const ends = f.records().filter(r => r.event === 'finish');
 assert.equal(ends[0].query, starts[0].query); assert.equal(ends[1].query, starts[1].query);
});

test('privacy is constructed from allowlists; optional hashes detect prefix changes', t => {
 const f = fixture(t); f.enable(); const a = start(f);
 f.trace.finish(a.q, 'completed', secret);
 const b = start(f, {}, secret, secret + '-changed');
 f.trace.selected(b.token, secret); f.trace.rewrite(secret, secret); f.trace.mark(b.c, secret);
 f.trace.sync(secret, secret, { sessionId: secret }, 3, 2);
 f.trace.output(b.q, b.c);
 f.trace.usage(b.c, { input_tokens: secret, output_tokens: NaN, cache_read_input_tokens: -1, cache_creation_input_tokens: Infinity, error: new Error(secret) });
 f.trace.finish(b.q, secret, secret); f.trace.finish(b.q, 'error', secret);
 const rows = f.records();
 assert.equal(JSON.stringify(rows).includes(secret), false);
 assert.equal(rows.filter(r => r.event === 'start')[1].promptChanged, true);
 assert.equal(rows.filter(r => r.event === 'start')[1].toolsChanged, false);
 assert.equal(rows.find(r => r.event === 'usage').input, null);
 assert.equal(rows.find(r => r.event === 'selected').effort, 'unspecified');
 assert.equal(rows.find(r => r.event === 'rewrite').reason, 'history_rewrite_unknown');
 assert.equal(rows.some(r => r.event === 'sync'), false);
 const other = createCacheTrace({ agentDir: f.root });
 other.start({}, secret, secret, secret, secret, [], 0);
 const last = f.records().at(-1);
 assert.equal(last.model, 'unknown'); assert.notEqual(last.session, rows[0].session);
});

test('symlink control, log directory, and log files fail closed; storage failure never throws', t => {
 const f = fixture(t); const victim = join(f.root, 'victim'); writeFileSync(victim, '{"enabled":true}');
 symlinkSync(victim, join(f.root, 'claude-bridge-cache-trace.json'));
 assert.doesNotThrow(() => start(f)); assert.equal(existsSync(join(f.root, 'claude-bridge-cache-trace')), false);
 rmSync(join(f.root, 'claude-bridge-cache-trace.json')); f.enable();
 const log = join(f.root, 'claude-bridge-cache-trace'); symlinkSync(f.root, log);
 assert.doesNotThrow(() => start(f)); assert.equal(readFileSync(victim, 'utf8'), '{"enabled":true}'); rmSync(log);
 mkdirSync(log); symlinkSync(victim, join(log, 'trace.jsonl'));
 assert.doesNotThrow(() => start(f)); assert.equal(readFileSync(victim, 'utf8'), '{"enabled":true}');
 rmSync(join(log, 'trace.jsonl')); mkdirSync(join(log, '.lock'));
 assert.doesNotThrow(() => start(f)); assert.equal(existsSync(join(log, 'trace.jsonl')), false);
});

test('private permissions and bounded rotation', t => {
 const f = fixture(t); f.enable(); const a = start(f);
 f.trace.output(a.q, a.c);
 for (let i = 0; i < 3500; i++) f.trace.usage(a.c, { input_tokens: i, cache_read_input_tokens: 123 });
 const dir = join(f.root, 'claude-bridge-cache-trace');
 assert.equal(statSync(dir).mode & 0o777, 0o700);
 const files = readdirSync(dir); assert.deepEqual(files.sort(), ['trace.1.jsonl', 'trace.2.jsonl', 'trace.jsonl']);
 for (const name of files) { const st = statSync(join(dir, name)); assert.equal(st.mode & 0o777, 0o600); assert.ok(st.size <= 256 * 1024); }
});

// Actual provider entry/lifecycle function, with a deferred fake SDK consumer.
// This exercises closure attribution and abort mutations, not SDK event decoding.
function lifecycle(trace) {
 const { b } = bridge(trace);
 class Context {
  activeQuery = null; pendingToolCalls = new Map(); pendingResults = new Map(); turnToolCallIds = [];
  resetTurnState() { this.turnOutput = { stopReason: 'stop' }; }
  releasePendingToolCalls() {}
 }
 const current = new Context(); const pending = [];
 Object.assign(b, {
  QueryContext: Context, ctx: () => current, process: { env: {}, cwd: () => secret },
  showStartupNoticeOnce() {}, toBridgeContext: c => c,
  isolatedStreamFn: () => 'isolated', createAssistantMessageEventStream: () => ({ push() {}, end() {} }),
  extractAllToolResults: () => [], contextForToolResults: () => undefined,
  resolveMcpTools: () => ({ mcpTools: [], customToolNameToSdk: new Map(), customToolNameToPi: new Map() }),
  askClaudeToolName: secret, promptCaptures: { resolveOrDerive: () => undefined },
  claimCurrentPiStream: (stream, _label, c) => c.currentPiStream = stream,
  claudeCodeModelId: m => m.id, longContextSettings: {},
  extractUserPromptBlocks: () => null, extractUserPrompt: () => secret, userMessage: value => value,
  makePromptStream: () => ({ push: async () => {}, fail() {}, end() {}, stream: {} }),
  buildMcpServers: () => undefined, providerSettings: {}, REASONING_TO_EFFORT: { high: 'high' }, VALID_EFFORTS: new Set(['high']),
  CC_CHILD_ENV: {}, CLAUDE_MD_EXCLUDES: [], claudeCodeSettings: () => ({}), makeCliDebugOptions: () => ({}),
  queryImpl: () => ({ interrupt: async () => {}, close() {} }),
  consumeQuery: (q, _names, _model, _aborted, c) => new Promise((resolve, reject) => pending.push({ q, c, resolve, reject })),
  drainForAbort() {}, markStreamComplete() {}, finalizeCurrentStream() {},
 });
 vm.runInContext(extract(source, 'streamClaudeAgentSdk'), b);
 return { b, current, pending, call: options => b.streamClaudeAgentSdk({ id: 'claude-opus-4-6' }, { messages: history() }, { sessionId: secret, ...options }) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('actual provider completion and catch hooks: abort rotation, error enum, isolated exclusion', async t => {
 const f = fixture(t); f.enable(); const h = lifecycle(f.trace);
 assert.equal(h.call({ cacheRetention: 'none' }), 'isolated'); assert.equal(f.records().length, 0);
 const abort = new AbortController(); h.call({ signal: abort.signal });
 abort.abort(); h.pending[0].resolve({ capturedSessionId: secret }); await flush();
 assert.equal(h.b.sessionStateFor(secret).forceRotate, true);
 assert.equal(f.records().filter(r => r.event === 'finish').at(-1).reason, 'aborted');
 h.call();
 assert.equal(f.records().filter(r => r.event === 'sync').at(-1).branch, 'rebuild_rotate');
 h.pending[1].reject(new Error(secret)); await flush();
 assert.equal(h.b.sessionStateFor(secret), null);
 assert.equal(f.records().filter(r => r.event === 'finish').at(-1).reason, 'error');
 h.call(); h.pending[2].resolve({ capturedSessionId: secret }); await flush();
 assert.equal(f.records().filter(r => r.event === 'finish').at(-1).reason, 'completed');
 assert.equal(JSON.stringify(f.records()).includes(secret), false);
});

test('actual provider late abandoned callback cannot take replacement identity', async t => {
 const f = fixture(t); f.enable(); const h = lifecycle(f.trace);
 h.call(); const old = h.pending[0]; h.b.discardRewrittenQuery(old.c);
 h.call(); const fresh = h.pending[1]; assert.equal(old.c, fresh.c);
 old.reject(new Error(secret)); await flush();
 assert.equal(h.current.activeQuery, fresh.q);
 fresh.resolve({ capturedSessionId: secret }); await flush();
 const starts = f.records().filter(r => r.event === 'start'); const ends = f.records().filter(r => r.event === 'finish');
 assert.deepEqual(ends.map(r => r.reason), ['abandoned', 'completed']);
 assert.equal(ends[0].query, starts[0].query); assert.equal(ends[1].query, starts[1].query);
});

test('all index modifications are observational insertions, with stable SDK attribution', () => {
 const without = source.split('\n').filter(line => !line.includes('cacheTrace')).join('\n');
 assert.equal(without, stock);
 assert.ok(source.includes('cacheTrace.output(sdkQuery, queryCtx.turnOutput)'));
 assert.equal((source.match(/cacheTrace.finish\(sdkQuery,/g) ?? []).length, 2);
 assert.ok(source.indexOf('options?.cacheRetention === "none"', source.indexOf('function streamClaudeAgentSdk')) < source.indexOf('const cacheTraceQuery'));
});

test('current configured Claude model identifiers are logged without allowing arbitrary names', t => {
 const f = fixture(t); f.enable();
 for (const model of ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1']) {
  f.trace.start({}, 'session', model, 'high', '', [], 1);
  assert.equal(f.records().at(-1).model, model);
 }
 f.trace.start({}, 'session', secret, 'high', '', [], 1);
 assert.equal(f.records().at(-1).model, 'unknown');
 assert.ok(!JSON.stringify(f.records()).includes(secret));
});
