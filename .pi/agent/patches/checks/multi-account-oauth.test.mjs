import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { dependency, target } from './target.mjs';

// A failed native import elsewhere in Pi can leave pi-ai provider modules
// half-loaded in Node's ESM map. require() then throws
// ERR_REQUIRE_ESM_RACE_CONDITION, but import() still completes. Each scenario
// runs in a new process because the poisoned module state is process-wide.
// The checks never call a login or refresh function, so they make no network
// requests and read no credentials.
const root = target('pi-multi-account');
const jiti = dependency(root, 'jiti');
const scratch = mkdtempSync(join(tmpdir(), 'pi-multi-account-oauth-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const home = join(scratch, 'home');
mkdirSync(join(home, 'agent'), { recursive: true });

// Load index.ts with jiti, as Pi does, optionally poison the pi-ai root first,
// and report a JSON summary of the bridge and the load diagnostic.
const scenario = String.raw`
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { index, jiti, poisonDir, poison } = JSON.parse(process.env.SCENARIO);
const { createJiti } = await import(jiti);
const mod = await createJiti(index, { moduleCache: false, tryNative: false }).import(index);
const piAi = mod.piAiRootCandidates(index, createRequire(index).resolve)
 .find(candidate => existsSync(join(candidate, 'package.json')));
const providers = ['anthropic', 'openai-codex', 'kimi-coding', 'xai']
 .map(name => join(piAi, 'dist', 'providers', name + '.js')).filter(existsSync);
let raced = 0;
if (poison) {
 mkdirSync(poisonDir, { recursive: true });
 const entry = join(poisonDir, 'entry.mjs');
 writeFileSync(entry, providers.map(file => 'import ' + JSON.stringify(file) + ';\n').join('')
  + 'import "pi-multi-account-oauth-missing-dependency";\n');
 await import(entry).then(() => { throw new Error('poison import unexpectedly succeeded'); }, () => {});
 const require = createRequire(index);
 raced = providers.filter(file => {
  try { require(file); return false; } catch (error) { return error.code === 'ERR_REQUIRE_ESM_RACE_CONDITION'; }
 }).length;
}
const summary = { raced, providers: providers.length, exports: Object.keys(mod).sort() };
if (typeof mod.warmPiAiOauth === 'function') {
 const bridge = await mod.warmPiAiOauth();
 const again = await mod.warmPiAiOauth();
 summary.cached = bridge !== undefined && bridge === again;
 summary.bridge = bridge && {
  era: bridge.era,
  anthropic: [typeof bridge.anthropic.login, typeof bridge.anthropic.refresh],
  codex: [typeof bridge.codex.login, typeof bridge.codex.refresh, typeof bridge.codex.getApiKey, bridge.codex.usesCallbackServer],
  kimi: bridge.kimi ? [typeof bridge.kimi.login, typeof bridge.kimi.refresh] : null,
  xai: bridge.xai ? [typeof bridge.xai.refresh] : null,
  apiKey: bridge.codex.getApiKey({ access: 'fixture-access' }),
 };
}
if (typeof mod.piAiOauthUnavailableReason === 'function') summary.reason = mod.piAiOauthUnavailableReason() ?? null;
if (process.env.SCENARIO_REPAIR) {
 writeFileSync(process.env.SCENARIO_REPAIR, process.env.SCENARIO_REPAIR_SOURCE);
 const bridge = await mod.warmPiAiOauth();
 summary.repaired = { era: bridge?.era ?? null, reason: mod.piAiOauthUnavailableReason() ?? null };
}
console.log('SCENARIO ' + JSON.stringify(summary));
`;

function run(index, { poison = false, repair } = {}) {
 const result = spawnSync(process.execPath, ['--input-type=module', '-e', scenario], {
  encoding: 'utf8',
  timeout: 60_000,
  env: {
   PATH: process.env.PATH,
   HOME: home,
   PI_CODING_AGENT_DIR: join(home, 'agent'),
   SCENARIO: JSON.stringify({ index, jiti, poison, poisonDir: mkdtempSync(join(scratch, 'poison-')) }),
   ...(repair ? { SCENARIO_REPAIR: repair.file, SCENARIO_REPAIR_SOURCE: repair.source } : {}),
  },
 });
 const line = result.stdout.split('\n').find(text => text.startsWith('SCENARIO '));
 assert.ok(line, `scenario failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
 return JSON.parse(line.slice('SCENARIO '.length));
}

const provider = (name, oauth = true) => `export function ${name}() {
 return { auth: ${oauth ? '{ oauth: { login: async () => { throw new Error("fixture login"); }, refresh: async () => { throw new Error("fixture refresh"); } } }' : '{}'} };
}
`;

// Copy the target next to a fixture pi-ai, so findPiAiRoot() resolves the fixture.
function fixturePackage(files) {
 const dir = mkdtempSync(join(scratch, 'fixture-'));
 const pkg = join(dir, 'node_modules', 'pi-multi-account');
 cpSync(root, pkg, { recursive: true, filter: source => !['node_modules', '.git'].includes(basename(source)) });
 const piAi = join(dir, 'node_modules', '@earendil-works', 'pi-ai');
 mkdirSync(join(piAi, 'dist', 'providers'), { recursive: true });
 writeFileSync(join(piAi, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.0.0-fixture', type: 'module' }));
 writeFileSync(join(piAi, 'dist', 'oauth.js'), 'export {};\n');
 for (const [name, source] of Object.entries(files)) writeFileSync(join(piAi, 'dist', 'providers', name), source);
 return { index: join(pkg, 'index.ts'), providers: join(piAi, 'dist', 'providers') };
}

const complete = ['function', 'function'];
const codex = ['function', 'function', 'function', true];

test('factory awaits the async OAuth warmup before it reads the load result', () => {
 const source = readFileSync(join(root, 'index.ts'), 'utf8');
 const factory = source.indexOf('export default async function piMultiAccount(');
 assert.ok(factory >= 0, 'the default factory must be async so Pi awaits the warmup');
 const warm = source.indexOf('await warmPiAiOauth();', factory);
 const reason = source.indexOf('piAiOauthUnavailableReason();', factory);
 assert.ok(warm > factory && reason > warm, 'the warmup must finish before the unavailable reason is read');
});

test('installed pi-ai: OAuth recovers after a failed native import poisons require()', () => {
 const result = run(join(root, 'index.ts'), { poison: true });
 assert.ok(result.raced > 0, 'the fixture must reproduce ERR_REQUIRE_ESM_RACE_CONDITION');
 assert.ok(result.exports.includes('warmPiAiOauth'), `missing async OAuth warmup; exports: ${result.exports.join(', ')}`);
 assert.equal(result.bridge?.era, 'provider-factories');
 assert.deepEqual(result.bridge.anthropic, complete);
 assert.deepEqual(result.bridge.codex, codex);
 assert.equal(result.bridge.apiKey, 'fixture-access');
 assert.equal(result.cached, true);
 assert.equal(result.reason, null);
});

test('installed pi-ai: the synchronous fast path still returns the cached bridge', () => {
 const result = run(join(root, 'index.ts'));
 assert.equal(result.raced, 0);
 assert.equal(result.bridge?.era, 'provider-factories');
 assert.deepEqual(result.bridge.anthropic, complete);
 assert.deepEqual(result.bridge.codex, codex);
 assert.equal(result.cached, true);
 assert.equal(result.reason, null);
});

test('fixture pi-ai: recovery works without the optional Kimi and xAI providers', () => {
 const fixture = fixturePackage({
  'anthropic.js': provider('anthropicProvider'),
  'openai-codex.js': provider('openaiCodexProvider'),
 });
 const result = run(fixture.index, { poison: true });
 assert.equal(result.raced, 2);
 assert.equal(result.bridge?.era, 'provider-factories');
 assert.deepEqual(result.bridge.anthropic, complete);
 assert.deepEqual(result.bridge.codex, codex);
 assert.equal(result.bridge.kimi, null);
 assert.equal(result.bridge.xai, null);
 assert.equal(result.reason, null);
});

test('fixture pi-ai: a real failure after recovery is still reported', () => {
 const fixture = fixturePackage({
  'anthropic.js': provider('anthropicProvider'),
  'openai-codex.js': provider('openaiCodexProvider', false),
 });
 const result = run(fixture.index, { poison: true });
 assert.equal(result.raced, 2);
 assert.equal(result.bridge, undefined);
 assert.equal(result.cached, false);
 // After import() completes, require() works again, so the reason describes the
 // actual missing OAuth surface instead of the transient loader race.
 assert.doesNotMatch(result.reason, /not yet fully loaded/);
 assert.match(result.reason, /exposes no OAuth surface.*Async import retry: .*exposed no auth\.oauth/);
});

test('fixture pi-ai: a later successful load clears the earlier failure', () => {
 const fixture = fixturePackage({ 'anthropic.js': provider('anthropicProvider') });
 const result = run(fixture.index, {
  repair: { file: join(fixture.providers, 'openai-codex.js'), source: provider('openaiCodexProvider') },
 });
 assert.equal(result.bridge, undefined);
 assert.match(result.reason, /exposes no OAuth surface/);
 assert.deepEqual(result.repaired, { era: 'provider-factories', reason: null });
});
