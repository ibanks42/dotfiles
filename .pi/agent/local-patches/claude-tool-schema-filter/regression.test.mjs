import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// <agent>/local-patches/claude-tool-schema-filter/regression.test.mjs
const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Optional override for a restored temp copy. The copy must resolve the same dependencies.
const root = resolve(process.env.CLAUDE_PROVIDER_ROOT || resolve(agentDir, 'npm', 'node_modules', 'pi-claude-code-provider')) + '/';
const { createJiti } = await import(pathToFileURL(resolve(agentDir, 'npm', 'node_modules', 'jiti', 'lib', 'jiti.mjs')).href);
const load = createJiti(import.meta.url, { fsCache: false });
const { prepareRequestWithLimits: prepare } = await load.import(root + 'src/context-serializer.ts');
const { claudeToolSchemaExclusion: exclude, createToolSchemaExclusionNotifier: notifier, reportToolSchemaExclusionWarning: report, formatToolSchemaExclusionWarning: format } = await load.import(root + 'src/tool-schema-compatibility.ts');
const { resolveSession } = await load.import(root + 'src/session-registry.ts');
const { ClaudeEventMapper } = await load.import(root + 'src/stream-events.ts');
const { createOutput } = await load.import(root + 'src/output.ts');
const tool = (name, parameters = { type: 'object', properties: {} }) => ({ name, description: name, parameters });
const union = { anyOf: [{ type: 'object' }, { type: 'object' }] };
async function withRequest(tools, check, messages = []) {
  const p = await prepare({ tools, messages });
  try { await check(p); } finally { await rm(p.directory, { recursive: true, force: true }); }
}
test('root incompatibilities only; nested unions preserved', () => {
  for (const key of ['anyOf', 'allOf', 'oneOf']) {
    assert.equal(exclude('x', { type: 'object', [key]: [] }).reason, 'root_' + key);
  }
  assert.equal(exclude('x', {}).reason, 'root_type');
  assert.equal(exclude('x', { type: 'string' }).reason, 'root_type');
  assert.equal(exclude('x', { type: 'object', properties: { value: union } }), undefined);
});
test('filter before transport maps; preserve original catalog and code tools', async () => {
  const tools = [tool('wait'), tool('notebook', union), tool('exec')];
  const before = JSON.stringify(tools);
  await withRequest(tools, async p => {
    assert.deepEqual([...p.toolNames.values()], ['exec', 'wait']);
    assert.deepEqual(p.toolExclusions, [{ name: 'notebook', reason: 'root_anyOf' }]);
    assert.deepEqual(JSON.parse(await readFile(p.catalogPath, 'utf8')).map(t => t.name), ['exec', 'wait']);
    assert.equal(p.toolNames.has('mcp__pi__notebook'), false);
    assert.equal(JSON.parse(p.transcriptBlocks[0]).toolNameMap.length, 2);
  });
  assert.equal(JSON.stringify(tools), before);
});
test('all excluded produces tool-free transport', async () => {
  await withRequest([tool('notebook', union)], p => {
    assert.equal(p.toolNames.size, 0);
    assert.equal(p.catalogPath, undefined);
    assert.equal(p.catalogBytes, 0);
  });
});
test('history of excluded tool is unavailable, not callable', async () => {
  await withRequest([tool('notebook', union)], p => {
    assert.match(p.transcriptBlocks.join('\n'), /unavailable Pi tool/);
    assert.doesNotMatch(p.transcriptBlocks.join('\n'), /mcp__pi__notebook/);
  }, [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call1', name: 'notebook', arguments: { action: 'status' } }] }]);
});
test('duplicate, malformed, cyclic and oversized input still fails closed', async () => {
  const cyclic = { type: 'object' }; cyclic.self = cyclic;
  for (const tools of [[tool('a'), tool('a', union)], [null], [tool('a', null)], [tool('a', cyclic)]]) {
    await assert.rejects(prepare({ tools, messages: [] }));
  }
  await assert.rejects(prepare({ tools: [tool('a', union)], messages: [] }, { catalogBytes: 1 }));
  await assert.rejects(prepare({ tools: [tool('a', union)], messages: [] }, { tools: 0 }));
});
test('warning sanitized, bounded, deduplicated and visible with or without UI', () => {
  const exclusions = Array.from({ length: 256 }, (_, i) => ({ name: '\x1b\u202e' + 'x'.repeat(100) + i, reason: 'root_anyOf' }));
  const message = format(exclusions);
  assert.doesNotMatch(message, /[\x1b\u202e]/);
  assert.ok(message.length < 2500);
  assert.match(message, /244 more/);
  const ui = [], stderr = [];
  const notify = notifier(m => report(true, s => ui.push(s), s => stderr.push(s), m));
  notify(exclusions); notify(exclusions); notify([]);
  assert.equal(ui.length, 1); assert.equal(stderr.length, 0);
  report(false, s => ui.push(s), s => stderr.push(s), message);
  assert.deepEqual(stderr, [message]);
});
test('session resolution retains warning callback', () => {
  const callback = () => {};
  const registry = new Map([['test', { cwd: '/tmp', imageStore: {}, onRateLimitNotice() {}, onToolSchemaExclusions: callback }]]);
  for (const request of [{ sessionId: 'test', hasTools: true }, { systemPrompt: '<cwd>\n/tmp\n</cwd>', hasTools: true }, { hasTools: false }, { hasTools: true, allowBorrowSoleDirectory: true }]) {
    assert.equal(resolveSession(registry, request).onToolSchemaExclusions, callback);
  }
});
test('excluded proposal rejected before publishing callable content', async () => {
  await withRequest([tool('exec'), tool('notebook', union)], async p => {
    const output = createOutput({ id: 'fable', api: 'claude-code', provider: 'claude-code' });
    const mapper = new ClaudeEventMapper({ output, stream: { push() {}, end() {} }, expectedTools: new Set(p.toolNames.keys()), toolNames: p.toolNames, onToolUse() {} });
    mapper.accept({ type: 'system', subtype: 'init', tools: [...p.toolNames.keys()], permissionMode: 'dontAsk', slash_commands: [], skills: [], plugins: [], apiKeySource: 'none', mcp_servers: [{ name: 'pi', status: 'connected' }], model: 'claude-fable-5-1' });
    await mapper.settleResponseAnnouncement();
    mapper.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg', model: 'claude-fable-5-1', usage: { input_tokens: 0, output_tokens: 0 } } } });
    assert.throws(() => mapper.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'mcp__pi__notebook', input: {} } } }), /unknown tool/);
    assert.equal(output.content.some(c => c.type === 'toolCall'), false);
  });
});
