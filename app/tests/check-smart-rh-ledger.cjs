/* RH-SMART-NATIVE-DURABILITY: smart-canvas RH app/workflow runs go through the request ledger.
   Simulated only: a fake RH upstream records submits; nothing is billed. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const image=id=>({id,type:'smart-image',title:'RH '+id,x:100,y:100,images:[]});
async function main(){
 const h=await start('smart-rh-ledger',{server:'tests/rh-ledger-browser-server.py'});
 const statePath=path.join(h.runtime,'fake-rh-upstream.json');
 const upstream=()=>fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf-8')):{submits:[],lose_next:false};
 const loseNextUpstreamResponse=()=>{const s=upstream();s.lose_next=true;fs.writeFileSync(statePath,JSON.stringify(s));};
 try{
  const c=await h.smartCanvas('RH ledger',[image('rh1'),image('rh2')]);
  const page=await h.newPage();
  // Drop the studio's reply to the browser once, after the request has reached the server.
  let dropNextReply=false,serviceDown=false;const browserPosts=[];
  // While the service is "restarting", follow-up ledger lookups from the page fail too.
  await page.route(/\/api\/studio\/runninghub\/tasks\/[^/]+$/,route=>serviceDown?route.abort('connectionrefused'):route.fallback());
  await page.route(/\/api\/(studio\/runninghub\/tasks|runninghub\/(submit|workflow-submit))$/,async route=>{
   const req=route.request();if(req.method()!=='POST')return route.fallback();
   browserPosts.push({path:new URL(req.url()).pathname,body:req.postDataJSON()});
   if(!dropNextReply)return route.fallback();
   dropNextReply=false;serviceDown=true;await route.fetch();return route.abort('connectionreset');
  });
  const dialogs=[];let acceptDialog=false;
  page.on('dialog',d=>{dialogs.push(d.message());acceptDialog?d.accept():d.dismiss();});
  // Stub only the selected-app lookup; payload building, saving, submitting and polling are the real code.
  const stubConfig=()=>page.addInitScript(()=>{
   addEventListener('DOMContentLoaded',()=>{
    selectedRunningHubRef=()=>({kind:'app',id:'1234567890'});
    rhActiveFields=()=>[{nodeId:'1',fieldName:'prompt',fieldType:'STRING'}];
    rhBuildNodeInfoList=async()=>[{nodeId:'1',fieldName:'prompt',fieldValue:'雨夜里的猫'}];
   });
  });
  await stubConfig();
  const run=id=>page.evaluate(async id=>{
   try{const urls=await runRunningHubGeneration('雨夜里的猫',[],{...settings,engine:'runninghub',rhPayment:'free'},{node:nodes.find(n=>n.id===id)});return {ok:true,urls};}
   catch(e){return {ok:false,error:String(e.message||e)};}
  },id);
  await h.openSmart(page,c.id);

  // 1) Accepted upstream, reply lost on the way to the browser, then the service restarts.
  dropNextReply=true;
  const first=await run('rh1');
  assert.equal(first.ok,false,'first attempt should surface the lost reply');
  assert.equal(upstream().submits.length,1);
  const saved=(await h.api('/api/canvases/'+c.id)).canvas.nodes.find(n=>n.id==='rh1');
  await h.restart();serviceDown=false;
  await page.reload();await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioSave);await delay(300);
  const second=await run('rh1');
  assert.equal(upstream().submits.length,1,'retrying the same node submitted to RH again; upstream submits='+upstream().submits.length);
  assert(saved.studioRhRequest,'request id was not saved with the canvas before submitting');
  assert.equal(browserPosts[0].body.request_id,saved.studioRhRequest,'submitted request id differs from the saved one');
  assert.deepEqual(saved.studioRhSnapshot?.payload?.nodeInfoList,[{nodeId:'1',fieldName:'prompt',fieldValue:'雨夜里的猫'}],'submission snapshot missing');
  assert.equal(second.ok,true,'retry did not recover the original task: '+second.error);
  assert.equal(second.urls.length,1);
  const ledger=await h.api('/api/studio/runninghub/tasks/'+encodeURIComponent(saved.studioRhRequest));
  assert.equal(ledger.status,'succeeded');assert.equal(ledger.task_id,'fake-task-1');
  console.log('PASS lost reply + restart: retry queries the saved request id, one upstream submit, same task');

  // 2) Upstream accepted but its reply never reached the ledger: the result stays "uncertain".
  loseNextUpstreamResponse();
  const third=await run('rh2');
  assert.equal(third.ok,false);assert.match(third.error,/待核实/);
  assert.equal(upstream().submits.length,2);
  const fourth=await run('rh2');
  assert.equal(fourth.ok,false,'an uncertain submit was retried silently');
  assert.equal(upstream().submits.length,2,'uncertain request was submitted again');
  assert(dialogs.some(m=>/待核实/.test(m)),'user was not asked before a possible duplicate charge');
  // Only an explicit confirmation starts a new paid request.
  acceptDialog=true;
  const fifth=await run('rh2');
  assert.equal(fifth.ok,true,fifth.error);
  assert.equal(upstream().submits.length,3);
  console.log('PASS uncertain submit is never resubmitted unless the user explicitly confirms a new request');

  assert(browserPosts.every(p=>p.path==='/api/studio/runninghub/tasks'),'bypassed the request ledger: '+JSON.stringify(browserPosts.map(p=>p.path)));
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-3000));throw e;}
 finally{await h.stop();}
}
main().catch(e=>{console.error(e);process.exit(1);});
