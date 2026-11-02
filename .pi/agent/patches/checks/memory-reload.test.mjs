import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { target, dependency } from './target.mjs';

const root = target('pi-memory');
const { createJiti } = await import(pathToFileURL(dependency(root, 'jiti')).href);
const load = () => createJiti(join(root, 'index.ts'), { moduleCache: false }).import(join(root, 'index.ts'));
const temporary = mkdtempSync(join(tmpdir(), 'pi-memory-reload-'));
process.env.PI_MEMORY_EXIT_SUMMARY = '0';
process.env.PI_MEMORY_SNAPSHOT = 'stable';
const base = 'UNCHANGED BASE INSTRUCTIONS';
const handoff = Symbol.for('pi-memory.reload-extensions.snapshot.v1');

async function instance(sessionId = 'session-a', directory = temporary, qmdAvailable = false) {
 const memory = await load();
 memory._setBaseDir(directory);
 memory._resetMemorySnapshot();
 // No subprocess, qmd/model call, embedding, or live memory directory access.
 memory._setExecFileForTest((...args) => args.at(-1)(qmdAvailable ? null : new Error('qmd disabled in fixture'), '["pi-memory"]', ''));
 const handlers = new Map();
 const commands = new Map();
 const pi = {
  on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  registerCommand(name, command) { commands.set(name, command); },
  registerTool() {},
 };
 memory.default(pi);
 const ctx = { hasUI: false, sessionManager: { getSessionId: () => sessionId } };
 const emit = async (name, event = {}) => {
  let result;
  for (const fn of handlers.get(name) ?? []) result = (await fn(event, ctx)) ?? result;
  return result;
 };
 const prompt = async () => (await emit('before_agent_start', { systemPrompt: base, prompt: '' })).systemPrompt;
 return { ctx, commands, emit, prompt };
}

test('reload-extensions preserves exact memory bytes/timestamp across fresh module runtimes; ordinary reload refreshes', async () => {
 try {
  writeFileSync(join(temporary, 'MEMORY.md'), 'ORIGINAL MEMORY');
  const old = await instance();
  await old.emit('session_start', { reason: 'startup' });
  const before = await old.prompt();
  assert.match(before, /ORIGINAL MEMORY/);
  assert.ok(old.commands.has('reload-extensions'), 'patch must register the command');
  writeFileSync(join(temporary, 'MEMORY.md'), 'UPDATED MEMORY ON DISK');
  let next, waited = false;
  const ctx = {
   ...old.ctx,
   async waitForIdle() { waited = true; },
   async reload() {
    assert.equal(waited, true);
    await old.emit('session_shutdown', { reason: 'reload' });
    next = await instance();
    await next.emit('session_start', { reason: 'reload' });
   },
  };
  await old.commands.get('reload-extensions').handler('', ctx);
  assert.equal(await next.prompt(), before, 'the entire injected snapshot and timestamp must be byte-identical');
  assert.equal(globalThis[handoff].size, 0, 'handoff consumed exactly once');
  // Plugin/base instructions are not frozen: this command preserves memory only.
  const changedBase = await next.emit('before_agent_start', { systemPrompt: 'NEW BASE', prompt: '' });
  assert.ok(changedBase.systemPrompt.startsWith('NEW BASE'));
  const full = await instance();
  await full.emit('session_start', { reason: 'reload' });
  assert.match(await full.prompt(), /UPDATED MEMORY ON DISK/);
  assert.notEqual(await full.prompt(), before);
 } finally { globalThis[handoff]?.clear(); }
});

test('failed reload clears its handoff so a later ordinary reload cannot accidentally preserve stale memory', async () => {
 writeFileSync(join(temporary, 'MEMORY.md'), 'BEFORE FAILURE');
 const old = await instance(); await old.emit('session_start', { reason: 'startup' });
 await assert.rejects(old.commands.get('reload-extensions').handler('', {
  ...old.ctx, async waitForIdle() {}, async reload() { throw new Error('reload fixture failure'); },
 }), /reload fixture failure/);
 assert.equal(globalThis[handoff].size, 0);
 writeFileSync(join(temporary, 'MEMORY.md'), 'AFTER FAILURE');
 const next = await instance(); await next.emit('session_start', { reason: 'reload' });
 assert.match(await next.prompt(), /AFTER FAILURE/);
});

test('handoff is session-scoped; a new/resumed session does not consume another session snapshot', async () => {
 writeFileSync(join(temporary, 'MEMORY.md'), 'SESSION A SNAPSHOT');
 const old = await instance('a'); await old.emit('session_start', { reason: 'startup' });
 const before = await old.prompt();
 let next;
 await old.commands.get('reload-extensions').handler('', {
  ...old.ctx, async waitForIdle() {}, async reload() {
   writeFileSync(join(temporary, 'MEMORY.md'), 'CURRENT DISK SNAPSHOT');
   const other = await instance('b'); await other.emit('session_start', { reason: 'startup' });
   assert.match(await other.prompt(), /CURRENT DISK SNAPSHOT/);
   next = await instance('a'); await next.emit('session_start', { reason: 'reload' });
  },
 });
 assert.equal(await next.prompt(), before);
 assert.equal(globalThis[handoff].size, 0);
});

test('new-session startup never restores a reload-only handoff', async () => {
 writeFileSync(join(temporary, 'MEMORY.md'), 'OLD SESSION');
 const old = await instance(); await old.emit('session_start', { reason: 'startup' });
 await old.commands.get('reload-extensions').handler('', {
  ...old.ctx, async waitForIdle() {}, async reload() {
   writeFileSync(join(temporary, 'MEMORY.md'), 'NEW SESSION');
   const next = await instance(); await next.emit('session_start', { reason: 'new' });
   assert.match(await next.prompt(), /NEW SESSION/);
  },
 });
 assert.equal(globalThis[handoff].size, 0);
});

test('preservation also works when qmd/collection checks succeed', async () => {
 writeFileSync(join(temporary, 'MEMORY.md'), 'QMD SNAPSHOT');
 const old = await instance('qmd-session', temporary, true);
 await old.emit('session_start', { reason: 'startup' });
 const before = await old.prompt();
 await old.commands.get('reload-extensions').handler('', {
  ...old.ctx, async waitForIdle() {}, async reload() {
   writeFileSync(join(temporary, 'MEMORY.md'), 'QMD CHANGED DISK');
   const next = await instance('qmd-session', temporary, true);
   await next.emit('session_start', { reason: 'reload' });
   assert.equal(await next.prompt(), before);
  },
 });
 assert.equal(globalThis[handoff].size, 0);
});

process.on('exit', () => { globalThis[handoff]?.clear(); rmSync(temporary, { recursive: true, force: true }); });
