/* Exercise the shipped async functions in memory; no server, accounts, files or paid calls. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../static/studio-stage-one.js'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,'production section exists');return source.slice(a,b);}
const operations=section('  const generationTarget=','  const draw=renderNode;');
const recovery=section("  let recovered='';setInterval(async()=>{",'  window.StudioStageOne=');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const node=(id='shared-node',job='')=>({id,type:'generator',model:'mock',apiProvider:'mock',studioJob:job,studioJobState:job?'running':'',running:Boolean(job)});
function receipt(id,canvas='canvas-A',status='succeeded',extra={}){return {id,request:{canvas_id:canvas,node_id:'shared-node',prompt:'original',references:[],params:{},provider_id:'mock'},status,error:'',outputs:[{url:'/mock/'+id+'.png'}],task_ids:['remote-'+id],children:[],created_at:1,updated_at:2,resolved_model:'mock',...extra};}
function fixture(n=node()){
  const writes=[],requests=[],timers=[],jobs=new Map(),polling=new Map();
  const context={canvas:{id:'canvas-A'},nodes:[n],jobs,polling,location:{search:'?id=old-location'},URLSearchParams,Object,Map,Set,JSON,String,Number,encodeURIComponent,Error,
    crypto:{randomUUID:()=> 'new-request'},confirm:()=>true,supported:()=>true,provider:()=> 'mock',submissionError:()=>'',StudioSave:{ensureCurrent:()=>Promise.resolve({ok:true})},
    request:(current,id)=>({request_id:id,canvas_id:context.canvas.id,node_id:current.id,prompt:'example'}),
    api:async(url,body)=>{requests.push({url,body});return receipt(body?.request_id||url.split('/').at(-1));},
    scheduleSave:()=>writes.push('save'),render:()=>writes.push('render'),refreshNodes:()=>writes.push('refresh'),setStatus:()=>writes.push('status'),changed:()=>writes.push('changed'),
    runSnapshot:()=>({}),outputForNode:()=>{writes.push('output:'+context.canvas.id);return {};},appendOutputImages:()=>writes.push('append'),mergeGeneratedOutputs:()=>writes.push('merge'),addGenerationLog:()=>writes.push('log'),outputNodesForSource:()=>[],
    callCanvasLLM:async()=> 'native',setTimeout:fn=>queueMicrotask(fn),setInterval:fn=>timers.push(fn)};
  context.window=context;
  for(const name of ['runGenerator','runVideoNode','runLLMNode'])context[name]=()=>{};
  vm.createContext(context);
  vm.runInContext("const canvasId=()=>canvas?.id||new URLSearchParams(location.search).get('id')||'';\n"+operations+recovery+'\nthis.testStage={run,track,resume,apply,generationTarget,currentTarget};',context);
  const api=(fn)=>context.api=async(url,body)=>{requests.push({url,body});return fn(url,body);};
  return {context,n,writes,requests,timers,jobs,polling,api,...context.testStage};
}
const checks=[];
async function check(name,fn){await fn();checks.push(name);}
(async()=>{
  await check('normal submission uses actual canvas and applies outputs',async()=>{
    const f=fixture();const done=await f.run(f.n);assert.equal(f.requests[0].body.canvas_id,'canvas-A');assert.equal(done.status,'succeeded');assert.equal(f.n.runStatus,'done');assert(f.writes.includes('output:canvas-A'));assert.equal(f.polling.size,0);
  });
  for(const change of ['canvas','replacement','new-task'])await check('late POST ignored after '+change,async()=>{
    const f=fixture(),d=deferred();f.api(()=>d.promise);const pending=f.run(f.n);for(let i=0;i<10&&!f.requests.length;i++)await Promise.resolve();assert.equal(f.requests.length,1);const before=f.writes.length;
    if(change==='canvas'){f.context.canvas={id:'canvas-B',project:'other'};f.context.nodes=[node('shared-node','job-B')];}
    if(change==='replacement')f.context.nodes=[node('shared-node','replacement-task')];
    if(change==='new-task'){f.n.studioJob='newer-task';f.n.studioJobState='running';}
    const current=JSON.stringify(f.context.nodes);d.resolve(receipt('new-request'));await pending;
    assert.equal(JSON.stringify(f.context.nodes),current);assert.equal(f.writes.length,before);assert.equal(f.jobs.get('new-request').status,'succeeded');assert.equal(f.requests.length,1);assert.equal(f.polling.size,0);
  });
  await check('late polling success cannot overwrite a newer task',async()=>{
    const f=fixture(node('shared-node','old-task')),d=deferred();f.api(()=>d.promise);const pending=f.track(f.n,'old-task');f.n.studioJob='newer-task';f.n.studioJobState='running';d.resolve(receipt('old-task'));await pending;
    assert.equal(f.n.studioJob,'newer-task');assert.equal(f.n.studioJobState,'running');assert.equal(f.writes.length,0);assert.equal(f.jobs.get('old-task').status,'succeeded');assert.equal(f.polling.size,0);
  });
  await check('late polling error leaves replacement node untouched',async()=>{
    const f=fixture(node('shared-node','old-task')),d=deferred();f.api(()=>d.promise);const pending=f.track(f.n,'old-task');f.context.nodes=[node('shared-node','replacement-task')];const current=JSON.stringify(f.context.nodes);d.reject(Error('network unavailable'));await pending;
    assert.equal(JSON.stringify(f.context.nodes),current);assert.equal(f.writes.length,0);assert.equal(f.polling.size,0);
  });
  await check('current polling failure pauses and releases lock',async()=>{
    const f=fixture(node('shared-node','old-task'));f.api(()=>Promise.reject(Error('offline')));await f.track(f.n,'old-task');assert.equal(f.n.studioJobState,'paused');assert.equal(f.n.studioJob,'old-task');assert.equal(f.polling.size,0);assert(f.writes.includes('save'));
  });
  await check('old poll cannot release a replacement node poll lock',async()=>{
    const f=fixture(node('shared-node','same-task')),old=deferred(),fresh=deferred();let count=0;f.api(()=>++count===1?old.promise:fresh.promise);
    const first=f.track(f.n,'same-task');const replacement=node('shared-node','same-task');f.context.nodes=[replacement];const second=f.track(replacement,'same-task');const owner=f.polling.get('same-task');
    old.resolve(receipt('same-task','canvas-A','running',{outputs:[],updated_at:1}));await first;assert.equal(f.polling.get('same-task'),owner);assert.equal(f.writes.length,0);
    fresh.resolve(receipt('same-task'));await second;assert.equal(replacement.runStatus,'done');assert.equal(f.polling.size,0);
  });
  await check('late older receipt cannot regress restored task ledger',async()=>{
    const f=fixture(node('shared-node','same-task')),old=deferred(),fresh=deferred();let count=0;f.api(()=>++count===1?old.promise:fresh.promise);
    const first=f.track(f.n,'same-task'),replacement=node('shared-node','same-task');f.context.nodes=[replacement];const second=f.track(replacement,'same-task');fresh.resolve(receipt('same-task','canvas-A','succeeded',{updated_at:3}));await second;
    const before=f.writes.length;old.resolve(receipt('same-task','canvas-A','running',{outputs:[],updated_at:2}));await first;assert.equal(f.jobs.get('same-task').status,'succeeded');assert.equal(replacement.runStatus,'done');assert.equal(f.writes.length,before);assert.equal(f.polling.size,0);
  });
  await check('late resume 404 cannot erase newer receipt',async()=>{
    const f=fixture(node('shared-node','old-task')),d=deferred();f.api(()=>d.promise);const pending=f.resume(f.n);f.n.studioJob='newer-task';d.reject(Object.assign(Error('missing'),{status:404}));await pending;
    assert.equal(f.n.studioJob,'newer-task');assert.equal(f.writes.length,0);assert(f.requests[0].url.endsWith('/old-task/resume'));
  });
  await check('late resume success stays in original ledger',async()=>{
    const f=fixture(node('shared-node','old-task')),d=deferred();f.api(()=>d.promise);const pending=f.resume(f.n);f.context.canvas={id:'canvas-B'};f.context.nodes=[node('shared-node','job-B')];d.resolve(receipt('old-task'));await pending;
    assert.equal(f.context.nodes[0].studioJob,'job-B');assert.equal(f.writes.length,0);assert.equal(f.jobs.get('old-task').status,'succeeded');assert.equal(f.requests.length,1);
  });
  for(const change of ['canvas','replacement','new-task'])await check('late automatic recovery ignored after '+change,async()=>{
    const f=fixture(),d=deferred();f.api(()=>d.promise);const pending=f.timers[0]();
    if(change==='canvas'){f.context.canvas={id:'canvas-B',project:'other'};f.context.nodes=[node('shared-node','job-B')];}
    if(change==='replacement')f.context.nodes=[node('shared-node')];
    if(change==='new-task'){f.n.studioJob='newer-task';f.n.studioJobState='running';}
    const current=JSON.stringify(f.context.nodes);d.resolve({items:[receipt('old-task')]});await pending;assert.equal(JSON.stringify(f.context.nodes),current);assert.equal(f.writes.length,0);assert.equal(f.jobs.get('old-task').status,'succeeded');
  });
  await check('automatic recovery keeps selected task instead of older history',async()=>{
    const f=fixture(node('shared-node','selected-task'));f.api(()=>({items:[receipt('unrelated-newest'),receipt('selected-task'),receipt('older-task')]}));await f.timers[0]();assert.equal(f.n.studioJob,'selected-task');assert.equal(f.n.runStatus,'done');assert.equal(f.writes.filter(v=>v==='append').length,1);assert.equal(f.jobs.size,3);
  });
  await check('automatic recovery chooses latest only for unbound node',async()=>{
    const f=fixture();f.api(()=>({items:[receipt('latest-task'),receipt('older-task')]}));await f.timers[0]();assert.equal(f.n.studioJob,'latest-task');assert.equal(f.writes.filter(v=>v==='append').length,1);assert.equal(f.jobs.size,2);
  });
  await check('new canvas still recovers while earlier recovery fails',async()=>{
    const f=fixture(),a=deferred(),b=deferred();let count=0;f.api(()=>++count===1?a.promise:b.promise);const first=f.timers[0]();f.context.canvas={id:'canvas-B'};f.context.nodes=[node()];const second=f.timers[0]();a.reject(Error('old request failed'));await first;b.resolve({items:[receipt('job-B','canvas-B')]});await second;await f.timers[0]();assert.equal(count,2);assert.equal(f.context.nodes[0].studioJob,'job-B');assert.equal(f.context.nodes[0].runStatus,'done');
  });
  for(const mismatch of ['canvas','node','request'])await check('mismatched '+mismatch+' receipt is rejected',async()=>{
    const f=fixture(node('shared-node','expected-task'));let job=receipt('expected-task');if(mismatch==='canvas')job.request.canvas_id='canvas-B';if(mismatch==='node')job.request.node_id='other-node';if(mismatch==='request')job.id='other-task';f.api(()=>job);await f.track(f.n,'expected-task');assert.equal(f.n.studioJobState,'paused');assert(!f.writes.some(v=>v.startsWith('output')));assert.equal(f.jobs.size,0);assert.equal(f.polling.size,0);
  });
  await check('late LLM response cannot return text for changed target',async()=>{
    const f=fixture(),d=deferred();f.api(()=>d.promise);const pending=f.context.callCanvasLLM(f.n,'message');for(let i=0;i<10&&!f.requests.length;i++)await Promise.resolve();assert.equal(f.requests.length,1);f.n.studioJob='newer-task';const before=f.writes.length;d.resolve(receipt('new-request','canvas-A','succeeded',{text:'old text',outputs:[]}));await assert.rejects(pending,/已改变/);assert.equal(f.n.outputText,undefined);assert.equal(f.n.studioJob,'newer-task');assert.equal(f.writes.length,before);
  });
  await check('stale node reference never submits',async()=>{const f=fixture();f.context.nodes=[node()];await f.run(f.n);assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);});
  await check('history-restored node ignores direct receipt and performs no track query',async()=>{
    const f=fixture(node('shared-node','held-task'));Object.assign(f.n,{studioHistoryRestored:true,studioJobState:'uncertain',running:false});
    assert.equal(f.apply(f.n,receipt('held-task')),false);await f.track(f.n,'held-task');
    assert.equal(f.n.studioJobState,'uncertain');assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);
  });
  for(const heldAfterRequest of [false,true])await check('automatic recovery preserves history hold '+heldAfterRequest,async()=>{
    const f=fixture(node('shared-node','held-task')),d=deferred();if(!heldAfterRequest)f.n.studioHistoryRestored=true;
    f.api(()=>d.promise);const recovering=f.timers[0]();Object.assign(f.n,{studioHistoryRestored:true,studioJobState:'uncertain',running:false});
    d.resolve({items:[receipt('held-task','canvas-A','running',{outputs:[]})]});await recovering;
    assert.equal(f.n.studioJobState,'uncertain');assert.equal(f.requests.length,1);assert.equal(f.writes.length,0);assert(f.n.studioHistoryRestored);
  });
  await check('explicit new generation clears history hold and persists a fresh request',async()=>{
    const f=fixture(node('shared-node','held-task'));Object.assign(f.n,{studioHistoryRestored:true,studioJobState:'uncertain',running:false});
    await f.run(f.n);assert.equal(f.n.studioHistoryRestored,undefined);assert.equal(f.n.studioJob,'new-request');assert.equal(f.n.runStatus,'done');
    assert.equal(f.requests.filter(r=>r.body?.request_id).length,1);
  });
  await check('explicit LLM generation clears history hold without inheriting old request',async()=>{
    const f=fixture(node('shared-node','held-task'));Object.assign(f.n,{studioHistoryRestored:true,studioJobState:'uncertain',running:false});
    f.api((url,body)=>receipt(body?.request_id||'new-request','canvas-A','succeeded',{text:'new explicit text',outputs:[]}));
    assert.equal(await f.context.callCanvasLLM(f.n,'new prompt'),'new explicit text');assert.equal(f.n.studioHistoryRestored,undefined);assert.equal(f.n.studioJob,'new-request');
  });
  await check('explicit recovery clears hold only after a matching receipt',async()=>{
    const f=fixture(node('shared-node','held-task'));Object.assign(f.n,{studioHistoryRestored:true,studioJobState:'uncertain',running:false});
    f.api(()=>receipt('wrong-task'));await f.resume(f.n);assert(f.n.studioHistoryRestored);assert.equal(f.n.studioJobState,'uncertain');
    f.api(()=>receipt('held-task'));await f.resume(f.n);assert.equal(f.n.studioHistoryRestored,undefined);assert.equal(f.n.runStatus,'done');
  });
  for(const llm of [false,true])for(const reload of [false,true])await check('failed new save keeps its request identity during recovery '+llm+'/'+reload,async()=>{
    let f=fixture(node('shared-node','old-held-task'));Object.assign(f.n,{studioHistoryRestored:true,studioJobState:'uncertain',running:false});
    f.context.StudioSave.ensureCurrent=async()=>{throw Error('isolated save failure');};
    if(llm)await assert.rejects(f.context.callCanvasLLM(f.n,'fresh text'),/save failure/);else await f.run(f.n);
    assert.equal(f.requests.length,0);assert.equal(f.n.studioJob,'');assert.equal(f.n.studioSubmission.id,'new-request');assert.equal(f.n.studioSubmission.submitted,false);
    if(reload)f=fixture(JSON.parse(JSON.stringify(f.n)));
    f.api(url=>url.includes('?')?{items:[receipt('old-held-task','canvas-A','running',{outputs:[]})]}:receipt('old-held-task'));
    await f.timers[0]();await Promise.resolve();
    assert.equal(f.requests.length,1,'recovery may list tasks, but must not query an older job');assert.equal(f.n.studioJob,'');assert.equal(f.n.studioJobState,'failed');assert.equal(f.n.studioSubmission.id,'new-request');assert(!f.writes.includes('append'));
  });
  await check('recovery response rejects a changed submission identity while task pointer is blank',async()=>{
    const f=fixture(),d=deferred();f.api(()=>d.promise);const pending=f.timers[0]();
    f.n.studioSubmission={id:'new-unsent',submitted:false};f.n.studioJobState='failed';
    d.resolve({items:[receipt('older-task')]});await pending;
    assert.equal(f.n.studioJob,'');assert.equal(f.n.studioSubmission.id,'new-unsent');assert.equal(f.writes.length,0);
  });
  for(const llm of [false,true])await check('explicit retry after failed save can replace the unsent identity '+llm,async()=>{
    const f=fixture();f.n.studioSubmission={id:'older-unsent',submitted:false};f.n.studioJobState='failed';
    if(llm)await f.context.callCanvasLLM(f.n,'retry words');else await f.run(f.n);
    assert.equal(f.n.studioJob,'new-request');assert.equal(f.n.studioSubmission.id,'new-request');assert.equal(f.n.studioSubmission.submitted,true);assert.equal(f.requests.filter(r=>r.body?.request_id).length,1);assert.equal(f.n.runStatus,'done');
  });
  await check('rejected POST retains its identity instead of adopting older history',async()=>{
    const f=fixture();f.api(()=>{throw Object.assign(Error('rejected request'),{status:400});});await f.run(f.n);
    assert.equal(f.n.studioJob,'');assert.equal(f.n.studioSubmission.submitted,true);const before=f.requests.length;
    f.api(url=>url.includes('?')?{items:[receipt('older-task','canvas-A','running',{outputs:[]})]}:receipt('older-task'));
    await f.timers[0]();await Promise.resolve();assert.equal(f.requests.length,before+1);assert.equal(f.n.studioJobState,'failed');assert(!f.writes.includes('append'));
  });
  await check('resume 404 keeps the selected identity and allows an explicit new retry',async()=>{
    const f=fixture(node('shared-node','missing-task'));f.n.studioSubmission={id:'missing-task',submitted:true};
    f.api(()=>{throw Object.assign(Error('missing task'),{status:404});});await f.resume(f.n);assert.equal(f.n.studioJob,'');
    f.api(url=>url.includes('?')?{items:[receipt('older-task','canvas-A','running',{outputs:[]})]}:receipt('older-task'));
    await f.timers[0]();await Promise.resolve();assert.equal(f.requests.length,2);assert.equal(f.n.studioJobState,'failed');assert(!f.writes.includes('append'));
    f.api((url,body)=>receipt(body?.request_id||url.split('/').at(-1)));await f.run(f.n);
    assert.equal(f.n.studioJob,'new-request');assert.equal(f.n.studioSubmission.id,'new-request');assert.equal(f.requests.filter(r=>r.body?.request_id).length,1);
  });
  console.log('Stage-one target isolation: '+checks.length+' checks passed. All requests and canvases were in-memory mocks.');
})().catch(e=>{console.error(e);process.exitCode=1;});
