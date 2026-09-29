import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { target } from './target.mjs';

// Evaluate the unmodified activation implementation from the installed bundle,
// with only its external Pi/Typebox dependencies supplied by the test.
const dist = readFileSync(join(target('pi-web-access'), 'dist/index.js'), 'utf8');
const start = dist.indexOf('// tool-activation.ts\n');
const end = dist.indexOf('// index.ts\n', start);
assert.ok(start >= 0 && end > start, 'installed bundle must contain tool activation');
const implementation = dist.slice(start, end)
 .split('\n').filter(line => !line.startsWith('import ')).join('\n')
 // In the original 0.31.0 version, import.meta.resolve failed in standard
 // installs. A sandboxed resolver reproduces that layout without touching disk.
 .replaceAll('import.meta.resolve(', 'resolvePiPackage(');
const sandbox = {
 console: { warn(message) { warnings.push(message); } },
 Type: { Object: () => ({ type: 'object' }) },
 buildSessionContext: branch => ({ messages: branch }),
 resolvePiPackage() { throw new Error('Pi is supplied by the host alias'); },
};
const warnings = [];
vm.createContext(sandbox);
vm.runInContext(implementation + '\nthis.activation = registerWebToolActivation;', sandbox);

function fakePi() {
 const registered = new Map([['web_search', { name: 'web_search' }]]);
 const callbacks = new Map();
 let active = ['web_search'];
 return {
  registered, callbacks,
  on(event, callback) { callbacks.set(event, callback); return () => callbacks.delete(event); },
  registerTool(tool) { registered.set(tool.name, tool); },
  getAllTools() { return [...registered.values()]; },
  getActiveTools() { return active; },
  setActiveTools(names) { active = [...names]; },
 };
}

test('installed web access exposes loader and activates tools without Pi package resolution', async () => {
 const pi = fakePi();
 sandbox.activation(pi, [{ name: 'web_search', capability: 'search' }]);
 assert.ok(pi.registered.has('web_enable'), `missing loader; warnings: ${warnings.join('; ')}`);
 const empty = { sessionManager: { getBranch: () => [] } };
 await pi.callbacks.get('session_start')({}, empty);
 assert.deepEqual(pi.getActiveTools(), ['web_enable']);
 const result = await pi.registered.get('web_enable').execute();
 assert.equal(result.isError, undefined);
 assert.deepEqual(pi.getActiveTools(), ['web_enable', 'web_search']);
 assert.deepEqual([...result.details.enabled], ['web_search']);
 await pi.callbacks.get('session_tree')({}, empty);
 assert.deepEqual(pi.getActiveTools(), ['web_enable']);
 assert.equal(warnings.length, 0);
});
