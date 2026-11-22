import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as policy from './model.mjs';
const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default class Sessionizer', 'globalThis.Sessionizer = class Sessionizer');
const config = {version:1,roots:[{path:'~',depth:1}],tabs:[{name:'shell',argv:null}],machines:{server:{roots:[{path:'~/server-projects',depth:1}]}}};
function harness() {
  const nodes=[], tasks=[], saved={}, calls=[];
  let spaceList=[];
  function element() { let proxy; const n={nodes:[],events:{}};proxy=new Proxy(n,{get(o,k){
    if(k in o)return o[k];
    if(k==='child')return child=>{o.nodes.push(child);return proxy};
    if(k==='children')return children=>{o.nodes.push(...children);return proxy};
    if(k==='when')return (yes,fn)=>{if(yes)fn(proxy);return proxy};
    if(k==='id')return id=>{o.key=id;return proxy};
    if(k.startsWith('on_'))return fn=>{o.events[k]=fn;return proxy};
    return ()=>proxy;
  }});nodes.push(n);return proxy; }
  const cx={notify(){},stop_propagation(){},focus_handle:()=>({}),timer:{every(){}},spawn(fn){const p=Promise.resolve().then(()=>fn(cx));tasks.push(p)}};
  const context={...policy,View:class{},div:element,svg:element,v_flex:element,h_flex:element,
    InputState:{new:({value=''})=>({text:value,value(){return this.text},set_value(v){this.text=v},on(){},focus(){}})},Input:{new:element},
    v_virtual_list:(id,count,size,key,render)=>element().id(id).children(render({start:0,end:count})),
    VirtualListScrollHandle:{new:()=>({scroll_to_item:(...args)=>calls.push({scroll:args}),release(){}})},Scrollbar:{vertical:()=>element()},
    appHome:()=>'/app',readTextFile:async path=>path.endsWith('config.json')?JSON.stringify(config):'backend',
    writeTextFile:async (path,text,expected)=>{calls.push({write:path,text,expected})},
    exec:async (cmd,args,opts)=>{calls.push({cmd,args,opts});return {code:0,stdout:JSON.stringify({ok:true,result:{paths:['/repo'],canonicalSpaces:{},warnings:[],truncated:false}})}},
    spaces:()=>spaceList,panes:()=>[],machines:()=>[{name:null,layout:'ready'},{name:'server',layout:'ready'}],run:(name,args)=>calls.push({name,args}),
    theme:()=>({}),settings:()=>({}),props:()=>({overlay:'test'}),closeOverlay:id=>calls.push({close:id}),shared:key=>saved[key],setShared:(key,value)=>{saved[key]=value},Date,JSON,Promise};
  vm.createContext(context);vm.runInContext(source,context);
  const view=new context.Sessionizer();
  async function drain(){while(tasks.length)await Promise.all(tasks.splice(0));}
  return {view,cx,context,nodes,saved,calls,drain,setSpaces:v=>{spaceList=v}};
}
test('initial async config and folder loading completes, every UI mode renders', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  assert.equal(h.view.loading,false);assert.equal(h.view.catalogs.length,2);assert.equal(h.view.catalogs[0].paths[0],'/repo');
  for(const mode of ['browse','new','clone','path','preview']){
    h.view.mode=mode;h.view.plan={path:'/repo',name:'repo',tabs:config.tabs,warnings:[]};h.view.render(h.cx);
  }
  assert(h.nodes.some(n=>n.key==='launch'));assert(h.nodes.some(n=>n.key==='create'));
});
test('results use native scrolling, arrows reveal selection, missing-root notices are hidden', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  h.view.fs=async()=>({paths:Array.from({length:40},(_,n)=>`/project-${n}`),priorities:{},canonicalSpaces:{},warnings:['Missing root: /gone'],truncated:false});
  h.view.refresh(h.cx);await h.drain();const root=h.view.render(h.cx);
  assert.equal(h.view.warnings.length,0);
  assert(h.nodes.some(n=>n.key==='sessionizer-results'));
  assert(!h.nodes.some(n=>n.key==='next'||n.key==='previous'));
  root.events.on_key_down({key:'down'},h.cx);
  assert.deepEqual(h.calls.at(-1).scroll,[1,'center']);
});
test('combined refresh ignores stale discovery replies from either machine', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  const pending=[];h.view.fs=()=>new Promise(resolve=>pending.push(resolve));
  h.view.refresh(h.cx);await Promise.resolve();h.view.refresh(h.cx);await Promise.resolve();
  pending[2]({paths:['/new-local'],canonicalSpaces:{},warnings:[]});
  pending[3]({paths:['/new-remote'],canonicalSpaces:{},warnings:[]});await Promise.resolve();
  pending[0]({paths:['/stale-local'],canonicalSpaces:{},warnings:[]});
  pending[1]({paths:['/stale-remote'],canonicalSpaces:{},warnings:[]});await h.drain();
  assert.equal(h.view.catalogs[0].paths[0],'/new-local');assert.equal(h.view.catalogs[1].paths[0],'/new-remote');
});
test('no automatic launch when preparing a folder; duplicate selects existing Space', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  h.view.fs=async()=>({path:'/repo',name:'repo',tabs:config.tabs,warnings:[]});
  h.view.prepare('/repo',h.cx);await h.drain();assert.equal(h.view.mode,'preview');
  assert(!h.calls.some(c=>c.name==='space.new'));
  h.setSpaces([{id:'already',machine:null,folder:'/repo'}]);
  h.view.prepare('/repo',h.cx);await h.drain();assert(h.calls.some(c=>c.name==='space.select'&&c.args.id==='already'));
});
test('busy guard and recovery record prevent repeated mutations', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  let resolve,count=0;h.view.perform(h.cx,()=>{count++;return new Promise(r=>{resolve=r})});
  h.view.perform(h.cx,()=>{count++});await Promise.resolve();assert.equal(count,1);resolve();await h.drain();
  h.saved['sessionizer.operation']={phase:'creating-space'};h.view.plan={path:'/repo'};
  h.view.launch(h.cx);await h.drain();assert.equal(h.view.busy,false);
});
test('post-preflight guard does not overwrite another dialog operation', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  h.view.rootInput.set_value('/root');h.view.nameInput.set_value('new');
  let release;h.view.fs=()=>new Promise(resolve=>{release=resolve});
  h.view.createFolder(h.cx);await Promise.resolve();
  const existing={phase:'creating-tab',space:'another'};h.saved['sessionizer.operation']=existing;
  release({path:'/root/new'});await h.drain();
  assert.equal(h.saved['sessionizer.operation'],existing);assert.match(h.view.error,/Another operation/);
});
test('clone completion is durable and does not auto-launch programs', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  h.saved['sessionizer.clone']={machine:'server',job:'abc',path:'/clone',state:'running'};
  h.view.fs=async(request,machine)=>{assert.equal(machine,'server');return {state:'complete',path:'/clone'}};
  h.view.pollClone(h.cx);await h.drain();
  assert.equal(h.saved['sessionizer.clone'].state,'complete');
  assert(!h.calls.some(c=>c.name==='space.new'));assert.equal(h.view.polling,false);
  h.view.render(h.cx);assert(h.nodes.some(n=>n.key==='open-clone'));
});
test('GUI settings save validated layouts and ordered roots atomically', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();h.view.startSettings(h.cx);
  h.view.editRoots[0].inputs[0].set_value('~/priority');
  h.view.editTabs[0].inputs[0].set_value('agent');
  h.view.editTabs[0].inputs[1].set_value('pi --model "a b"');
  h.view.render(h.cx);assert(h.nodes.some(n=>n.key==='save-settings'));
  h.view.saveSettings(h.cx);await h.drain();
  const write=h.calls.find(c=>c.write);
  assert.equal(JSON.parse(write.text).roots[0].path,'~/priority');
  assert.deepEqual(JSON.parse(write.text).tabs[0].argv,['pi','--model','a b']);
  assert.equal(JSON.parse(write.text).tabs[0].name,'agent');
  assert.equal(policy.configFor(JSON.parse(write.text),'server').tabs[0].name,'agent');
  assert.equal(policy.configFor(JSON.parse(write.text),null).tabs[0].name,'agent');
  assert.equal(write.expected,JSON.stringify(config));assert.equal(h.view.mode,'browse');
});
test('one global path editor assigns machines per row, with no top-level machine selector', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();h.view.startSettings(h.cx);
  assert.equal(h.view.editRoots.length,2);
  h.view.editRoots[0].machine='server';h.view.editRoots[0].inputs[0].set_value('~/dev/work');
  h.view.editRoots[1].machine=null;h.view.editRoots[1].inputs[0].set_value('~/dev/personal');
  h.view.startSettings(h.cx,'server');
  assert.equal(h.view.editRoots[0].machine,'server');assert.equal(h.view.editRoots[0].inputs[0].value(),'~/dev/work');
  h.view.moveEditor(h.view.editRoots,1,-1,h.cx);
  h.view.settingsTab='roots';h.view.render(h.cx);
  assert(!h.nodes.some(n=>n.key==='scope-defaults'||n.key==='scope-server'));
  assert(h.nodes.some(n=>n.key==='machine-root-'+h.view.editRoots[0].id));
  const row=h.view.editRoots[0];
  h.nodes.find(n=>n.key===`machine-root-${row.id}`).events.on_click({},h.cx);
  assert.equal(row.machineOpen,true);
  h.view.render(h.cx);
  h.nodes.find(n=>n.key===`machine-choice-${row.id}-local`).events.on_click({},h.cx);
  assert.equal(row.machine,null);assert.equal(row.machineOpen,false);
  h.view.saveSettings(h.cx);await h.drain();const saved=JSON.parse(h.calls.find(c=>c.write).text);
  assert.equal(saved.version,2);
  assert.deepEqual(saved.roots.map(r=>[r.machine,r.path]),[[null,'~/dev/personal'],['server','~/dev/work']]);
});
test('one-off startup edits do not change saved defaults, stale saves preserve draft', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  h.view.plan={path:'/repo',name:'repo',tabs:config.tabs,warnings:[]};h.view.customizeTabs(h.cx);
  h.view.editTabs[0].inputs[1].set_value('nvim');h.view.applyTabs(h.cx);
  assert.equal(h.view.plan.tabs[0].argv[0],'nvim');assert.equal(h.view.config.tabs[0].argv,null);
  assert(!h.calls.some(c=>c.write));
  h.view.startSettings(h.cx);h.context.writeTextFile=async()=>{throw Error('stale snapshot')};
  h.view.saveSettings(h.cx);await h.drain();assert.equal(h.view.mode,'settings');assert.match(h.view.error,/stale snapshot/);
});
test('folder result carries its machine into plan preparation', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();let on;
  h.view.fs=async(request,machine)=>{on=machine;return {path:'/remote',name:'remote',tabs:config.tabs,warnings:[]}};
  h.view.choose({kind:'path',machine:'server',path:'/remote'},h.cx);await h.drain();
  assert.equal(on,'server');assert.equal(h.view.machine,'server');assert.equal(h.view.mode,'preview');
});
test('opening with defaults uses configured names and commands in one click', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  h.view.plan={path:'/repo',name:'repo',tabs:[{name:'project override',argv:['nvim']}],warnings:[]};h.view.mode='preview';
  let launched;h.view.launch=()=>{launched=h.view.plan.tabs};h.view.render(h.cx);
  h.nodes.find(n=>n.key==='launch-defaults').events.on_click({},h.cx);
  assert.deepEqual(JSON.parse(JSON.stringify(launched)),config.tabs);
});
test('unavailable remote discovery does not hide local results', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  h.view.fs=async(request,machine)=>{if(machine==='server')throw Error('offline');return {paths:['/local'],canonicalSpaces:{},warnings:[]}};
  h.view.refresh(h.cx);await h.drain();
  assert.equal(h.view.rows()[0].machine,null);assert.equal(h.view.rows()[0].path,'/local');
  assert.match(h.view.warnings[0],/server: offline/);assert.equal(h.view.loading,false);
});
test('filesystem adapter never interpolates path or machine into shell source', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  const request={action:'plan',path:"/tmp/a'; $(touch bad)"};
  await h.view.fs(request,'server');const call=h.calls.at(-1);
  assert.equal(call.cmd,'python3');assert.equal(call.opts.on,'server');assert.equal(call.args[0],'-c');
  assert.equal(call.args[1],'backend');assert.deepEqual(JSON.parse(call.args[2]),request);
});
test('settings controls: depth stepper is bounded, drag reorders, dirty state tracked', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();h.view.startSettings(h.cx);
  h.view.settingsTab='roots';h.view.render(h.cx);
  const row=h.view.editRoots[0];assert.equal(h.view.draft(),h.view.savedDraft);
  const click=key=>{h.view.render(h.cx);h.nodes.findLast(n=>n.key===key).events.on_click({},h.cx)};
  for(let i=0;i<9;i++)click(`depth-inc-${row.id}`);assert.equal(row.depth,5);
  assert.notEqual(h.view.draft(),h.view.savedDraft);
  const [a,b]=h.view.editRoots;h.view.drag={rows:h.view.editRoots,id:a.id};
  h.view.dragOver(h.view.editRoots,b,h.cx);assert.deepEqual(h.view.editRoots.map(r=>r.id),[b.id,a.id]);
  h.view.editTabs[0].inputs[1].set_value('pi | tee');h.view.render(h.cx);
  assert.match(h.view.commandError(h.view.editTabs[0]),/Shell operators/);
  h.view.settingsTab='tabs';const root=h.view.render(h.cx);
  root.events.on_key_down({key:'s',modifiers:{control:true}},h.cx);await h.drain();
  assert.equal(h.view.mode,'settings');assert.match(h.view.error,/Shell operators/);
});
test('filesystem adapter falls back to python / py -3 and remembers the working one per machine', async()=>{
  const h=harness();h.view.init({},h.cx);await h.drain();
  const tried=[];
  h.context.exec=async(cmd,args)=>{tried.push([cmd,...args.slice(0,args.indexOf('-c'))].join(' '));
    if(cmd==='python3')throw Error('not found');
    if(cmd==='python')return {code:9009,stdout:'',stderr:'Python was not found; run without arguments to install from the Microsoft Store'};
    return {code:0,stdout:JSON.stringify({ok:true,result:{path:'C:\\repo'}})}};
  assert.deepEqual(await h.view.fs({action:'destination'},'win'),{path:'C:\\repo'});
  assert.deepEqual(tried,['python3','python','py -3']);
  tried.length=0;await h.view.fs({action:'destination'},'win');assert.deepEqual(tried,['py -3']);
  h.context.exec=async()=>{throw Error('not found')};
  await assert.rejects(h.view.fs({action:'destination'},'bare'),/Python 3 is required on bare \(tried python3, python, py -3\): not found/);
});
