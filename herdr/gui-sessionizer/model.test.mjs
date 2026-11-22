import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validateTabs, configFor, fuzzyScore, candidates, combinedCandidates, parseArgv, formatArgv, duplicateSpace, newJournal, launchSpace } from './model.mjs';
const tabs = [{ name: 'pi', argv: ['pi'] }, { name: 'shell', argv: null }];
const config = { version: 1, roots: [{ path: '~', depth: 1 }], tabs, machines: { remote: { roots: [{ path: '~/src', depth: 2 }] } } };
test('versioned config and per-machine overrides', () => {
  assert.equal(configFor(validateConfig(config), 'remote').roots[0].path, '~/src');
  for (const raw of [{}, { ...config, roots: 'invalid' }, { ...config, roots: [{ path: '~', depth: 6 }] }]) assert.throws(() => validateConfig(raw));
  assert.throws(() => validateTabs([{ name: 'oops', argv: 'pi; rm -rf /' }]));
});
test('each machine has independent search roots, never inherited from local', () => {
  const raw = validateConfig({...config,machines:{}});
  assert.deepEqual(configFor(raw,'new-remote').roots,[]);
  const remote = configFor(validateConfig(config),'remote');
  assert.equal(remote.roots[0].path,'~/src');
  raw.roots=[{machine:null,path:'~/changed-local',depth:1}];
  assert.deepEqual(configFor(raw,'new-remote').roots,[]);
  assert.equal(validateConfig({...raw,roots:[]}).roots.length,0);
});
test('global machine/path rows retain cross-machine priority and migrate legacy lists losslessly', () => {
  const global=validateConfig({version:2,roots:[
    {machine:'server',path:'~/dev/work',depth:1},
    {machine:null,path:'~/dev/personal',depth:1},
    {machine:'server',path:'~/dev/personal',depth:1},
  ],tabs,machines:{}});
  assert.deepEqual(configFor(global,'server').roots.map(r=>r.priority),[0,2]);
  assert.deepEqual(configFor(global,null).roots.map(r=>r.priority),[1]);
  const catalogs=[null,'server'].map(machine=>{
    const roots=configFor(global,machine).roots;
    return {machine,paths:roots.map(r=>r.path),priorities:Object.fromEntries(roots.map(r=>[r.path,r.priority]))};
  });
  assert.deepEqual(combinedCandidates([],catalogs,'').map(r=>[r.machine,r.path]),
    [['server','~/dev/work'],[null,'~/dev/personal'],['server','~/dev/personal']]);
  const migrated=validateConfig(config);
  assert.equal(migrated.version,2);assert.equal(migrated.roots[0].machine,null);assert.equal(migrated.roots[1].machine,'remote');
  assert.equal(migrated.roots[1].path,'~/src');assert.deepEqual(migrated.machines,{});
});
test('default tab names and commands apply globally, even with legacy machine overrides', () => {
  const raw={...config,machines:{remote:{tabs:[{name:'legacy override',argv:['nvim']}]}}};
  const normalized=validateConfig(raw);
  assert.deepEqual(configFor(normalized,null).tabs,tabs);
  assert.deepEqual(configFor(normalized,'remote').tabs,tabs);
  assert.deepEqual(normalized.machines,{});
});
test('command editor safely parses argument quoting, shells and literal arguments', () => {
  assert.equal(parseArgv(''),null);
  for(const argv of [['pi','--model','a b'],['printf',''],['echo','quote\"','a\\b'],['printf','line\nnext']]) assert.deepEqual(parseArgv(formatArgv(argv)),argv);
  assert.throws(()=>parseArgv('pi; evil'),/Shell operators/);
  assert.throws(()=>parseArgv('pi "broken'),/Unclosed/);
});
test('fuzzy subsequences, boundaries and stable empty query', () => {
  assert(fuzzyScore('rdc', 'rodecaster') > -Infinity);
  assert(fuzzyScore('xyz', 'rodecaster') === -Infinity);
  assert(fuzzyScore('app', 'app') > fuzzyScore('app', 'a long paragraph p'));
});
test('paths deduplicate against canonical Spaces ONLY on selected machine', () => {
  const spaces = [{ id: 'local', machine: null, folder: '/alias', name: 'local' }, { id: 'remote', machine: 'remote', folder: '/repo', name: 'remote' }];
  const rows = candidates(null, spaces, ['/repo', '/repo', '/new'], { local: '/repo' }, '');
  assert.deepEqual(rows.map(r => r.key), ['space:local', 'path:/new']);
  assert.equal(duplicateSpace(null, '/repo', spaces, { local: '/repo' }).id, 'local');
  assert.equal(duplicateSpace('elsewhere', '/repo', spaces), undefined);
});
test('configured root priority beats alphabetic order and fuzzy score for directories', () => {
  const rows = candidates(null, [{ id: 'live', name: 'zzz', folder: '/live' }], ['/late/aaa', '/early/zzz', '/early/abc'], {}, '', { '/late/aaa': 1, '/early/zzz': 0, '/early/abc': 0 });
  assert.deepEqual(rows.map(r => r.key), ['space:live', 'path:/early/abc', 'path:/early/zzz', 'path:/late/aaa']);
  const filtered = candidates(null, [], ['/late/app', '/early/a-long-project-p'], {}, 'app', { '/late/app': 1, '/early/a-long-project-p': 0 });
  assert.equal(filtered[0].path, '/early/a-long-project-p');
});
test('combined list has distinct machine-scoped folders and no redundant Space rows', () => {
  const spaces = [{id:'s1',machine:null,name:'existing',folder:'/same'}];
  const rows = combinedCandidates(spaces, [
    {machine:null,paths:['/same','/early/z'],priorities:{'/same':1,'/early/z':0}},
    {machine:'server',paths:['/same','/late/a'],priorities:{'/same':1,'/late/a':1}},
  ],'');
  assert(rows.every(row=>row.kind==='path'));
  assert.equal(rows[0].path,'/early/z');
  assert.equal(rows.filter(row=>row.path==='/same').length,2);
  assert.equal(new Set(rows.map(row=>row.key)).size,rows.length);
  assert.equal(combinedCandidates(spaces,[{machine:'server',paths:['/same']}],'server').length,1);
});
test('launcher captures IDs, journals before writes, routes machine explicitly', async () => {
  const journal = newJournal('remote', { path: '/tmp/space with quotes\' and spaces', name: 'project', tabs });
  const states = [], calls = [];
  await launchSpace(journal, async (name, args) => {
    calls.push([name, args]);
    assert.equal(states.at(-1).phase, name === 'space.new' ? 'creating-space' : 'creating-tab');
    return name === 'space.new' ? { space: 'remote/s1', tab: 'remote/t1' } : { tab: 'remote/t2' };
  }, state => states.push(structuredClone(state)));
  assert.equal(calls[0][1].machine, 'remote');
  assert.deepEqual(calls[0][1].argv, ['pi']);
  assert.equal(calls[1][1].space, 'remote/s1');
  assert.equal('argv' in calls[1][1], false);
  assert.equal(journal.phase, 'complete');
  assert.deepEqual(journal.createdTabs, ['remote/t1', 'remote/t2']);
});
test('ambiguous and partial errors never retry or destroy anything', async () => {
  const journal = newJournal(null, { path: '/repo', name: 'repo', tabs });
  let calls = 0;
  await assert.rejects(launchSpace(journal, async () => { if (++calls === 1) return { space: 's', tab: 't' }; throw Error('connection lost'); }, () => {}));
  assert.equal(calls, 2); assert.equal(journal.phase, 'creating-tab'); assert.equal(journal.space, 's');
  const unknown = newJournal(null, { path: '/repo', name: 'repo', tabs });
  await assert.rejects(launchSpace(unknown, async () => ({ ok: true }), () => {}), /missing IDs/);
  assert.equal(unknown.phase, 'creating-space');
});
test('Windows paths get folder names and separator-aware fuzzy bonuses', () => {
  const [row] = candidates(null, [], ['C:\\Users\\me\\dev\\herdr'], {}, 'herdr');
  assert.equal(row.name, 'herdr');
  assert.ok(fuzzyScore('h', 'dev\\herdr') > fuzzyScore('e', 'dev\\herdr'));
});
