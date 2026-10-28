'use strict';
// Run the shipped MJ submission function with an in-memory transport and save barrier.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../static/studio-tools.js'),'utf8');
const start=source.indexOf('  async function run(node,action){'),end=source.indexOf('  function failure(',start);
assert(start>=0&&end>start);
function fixture(status){
  const node={id:'mj-node',apiProvider:'offline',studioHistoryRestored:true,studioMjTask:'original-task',studioMjHistory:'original-history',studioMjStatus:status,studioMjRequest:{params:{prompt:'original'}}};
  const events=[],context={canvas:{id:'isolated-canvas'},nodes:[node],polling:new Set(),JSON,Error,
    mjParams:()=>({prompt:'explicit new prompt'}),mjCount:()=>1,rerender:()=>{},scheduleSave:()=>{},saveCanvas:()=>{},reconcile:async()=>{},
    persistAttempt:async(n,request)=>{assert(!n.studioHistoryRestored);assert.equal(n.studioMjStatus,'submitting');assert.equal(n.studioMjTask,'');events.push({kind:'save',request:JSON.parse(JSON.stringify(request))});},
    api:async(url,body)=>{assert.equal(events.at(-1).kind,'save');events.push({kind:'submit',url,body});return {task_id:'fresh-task',history_id:'fresh-history'};},
    track:async n=>{n.studioMjStatus='succeeded';return true;},resume:async n=>events.push({kind:'resume',id:n.studioMjTask}),failure:(_n,error)=>{throw error;}};
  vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.run=run;',context);return {node,events,run:context.run};
}
(async()=>{
  const fresh=fixture('succeeded');await fresh.run(fresh.node,'imagine');
  assert.equal(fresh.node.studioHistoryRestored,undefined);assert.equal(fresh.node.studioMjTask,'fresh-task');
  assert.deepEqual(fresh.events.map(e=>e.kind),['save','submit']);assert.equal(fresh.events[1].body.canvas_id,'isolated-canvas');
  assert.equal(fresh.node.studioMjPastTasks[0].task_id,'original-task');assert.equal(fresh.node.studioMjPastTasks[0].request.params.prompt,'original');
  const paused=fixture('paused');await paused.run(paused.node,'imagine');assert.deepEqual(paused.events,[{kind:'resume',id:'original-task'}]);assert(paused.node.studioHistoryRestored);
  const uncertain=fixture('uncertain');await uncertain.run(uncertain.node,'imagine');assert.equal(uncertain.events.length,0);assert(uncertain.node.studioHistoryRestored);
  console.log('MJ submit history: 3 checks passed. Save barrier, fresh receipt and original-task recovery use in-memory mocks only.');
})().catch(error=>{console.error(error);process.exitCode=1;});
