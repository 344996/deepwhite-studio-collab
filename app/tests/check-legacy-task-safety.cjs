'use strict';
// Real production pages + temporary canvas persistence. Every generation route is mocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path');
const executablePath=process.env.CHROMIUM_EXECUTABLE||'data/local-path';
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-legacy-safety-'));
const artifacts=path.join(os.tmpdir(),'deepwhite-legacy-task-safety');fs.mkdirSync(artifacts,{recursive:true});
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const passed=[];
async function main(){
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port;let server,browser,log='',page,profile={};const posts=[],reads=[],external=[],pageErrors=[],ledger=new Map();let delayedResolve;
 const api=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json();};
 const pass=label=>{passed.push(label);console.log('PASS: '+label);};
 try{
  server=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});
  server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
  let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await sleep(200);}}assert(ready,log);
  await api('/api/studio/settings/sync-models','POST',{id:'offline',name:'Offline legacy fixture',base_url:'https://api.deepwhiteai.com/v1',api_key:'mock-legacy-only',enabled:true,primary:true});
  browser=await chromium.launch({headless:true,executablePath});
  for(const smart of [false,true]){
   const c=(await api('/api/canvases','POST',{title:smart?'Smart legacy safety':'Classic legacy safety',kind:smart?'smart':'classic'})).canvas;
   const context=await browser.newContext({viewport:{width:1280,height:800}});page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>pageErrors.push(e.message));
   await context.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url());if(u.origin!==base){external.push(request.url());return route.abort();}
    if(profile.saveFail&&request.method()==='PUT'&&u.pathname==='/api/canvases/'+c.id)return route.fulfill({status:503,json:{detail:'fixture save failure'}});
    const m=u.pathname.match(/^\/api\/canvas-(image|comfy)-tasks(?:\/(.*))?$/);
    if(m){
     if(request.method()==='POST'){
      const body=request.postDataJSON(),saved=(await api('/api/canvases/'+c.id)).canvas,owner=saved.nodes.find(n=>n.id===body.node_id),a=owner?.studioLegacyAttempts?.[body.request_id];
      assert(a,'POST must follow saved per-attempt snapshot');assert.deepEqual(a.snapshot.request,body);assert.equal(a.id,body.request_id);assert.equal(body.canvas_id,c.id);
      posts.push({kind:m[1],body});const status=profile.status||'queued',record={task_id:'mock-'+body.request_id,status,recovery_status:profile.recovery||'',retryable:false,queryable:profile.recovery==='receipt_saved',result:{images:[image]},error:profile.error||''};
      if(!profile.orphan){ledger.set(body.request_id,record);ledger.set(record.task_id,record);}
      if(profile.mutate)await page.evaluate(profile.mutate);
      if(profile.delay)await new Promise(r=>{delayedResolve=r;});
      if(profile.lost)return route.abort('failed');
      return route.fulfill({json:record});
     }
     const id=decodeURIComponent((m[2]||'').replace(/^by-request\//,''));reads.push({kind:m[1],id,byRequest:(m[2]||'').startsWith('by-request/')});let record=ledger.get(id);
     if(!record)return route.fulfill({status:404,json:{detail:'mock original request not found'}});
     if(profile.complete&&record.status==='queued'){record={...record,status:'succeeded'};ledger.set(id,record);}
     return route.fulfill({json:record});
    }
    if(request.method()==='POST'&&/\/api\/(?:studio\/(?:generations|mj\/submit|runninghub\/tasks)|canvas-(?:llm|video)|online-image|runninghub\/create|jimeng\/generate)/.test(u.pathname))throw Error('Unexpected generation route: '+u.pathname);
    return route.continue();
   });
   await page.goto(base+'/static/'+(smart?'smart-canvas.html':'canvas.html')+'?id='+c.id);
   await page.waitForFunction(()=>window.StudioSave&&typeof canvas!=='undefined'&&canvas?.id&&typeof prepareLegacyTask==='function');
   if(!smart)await page.waitForFunction(()=>window.StudioAudio&&StudioAudio.modelsForChannel('offline','speech').length);
   await page.waitForTimeout(250);
   const fixture=async()=>{profile={};await page.evaluate(({smart,image})=>{
    if(typeof stopCanvasRemotePolling==='function')stopCanvasRemotePolling();if(typeof stopCanvasMetaPoll==='function')stopCanvasMetaPoll();
    nodes=[];canvas.nodes=nodes;canvas.connections=[];
    if(smart){const n=createNode(60,80,[{url:image,name:'previous-success.png',kind:'image'}]);n.id='source';n.runPrompt='handwritten original';n.promptDraftText='handwritten original';window.fixtureOwner=n;window.fixtureOut=n;selectedId=n.id;selectedIds=[];viewport={x:0,y:0,scale:1};}
    else{connections=[];selected.clear();const n=addGeneratorNode({x:60,y:80});n.id='source';n.apiProvider='offline';n.model='deepwhiteai-image-g2';n.studioPrompt='handwritten original';n.generatedOutputs=[image];const o=outputForNode(n,450);o.id='output';o.images=[{url:image,name:'previous-success.png',kind:'image'}];o.x=520;o.y=80;window.fixtureOwner=n;window.fixtureOut=o;selected.add(n.id);view={x:0,y:0,scale:1};}
    render();scheduleSave();
   },{smart,image});assert((await page.evaluate(()=>saveCanvas())).ok);};
   const prep=async(kind='image',count=1)=>page.evaluate(({kind,count})=>{
    window.legacyContexts=Array.from({length:count},(_,i)=>prepareLegacyTask(kind,{prompt:'frozen '+i,provider_id:'offline',model:'deepwhiteai-image-g2',params:{seed:21+i}},{node:fixtureOwner,out:fixtureOut,run:{node:{id:fixtureOwner.id}},mediaKind:'image'}));render();return legacyContexts.map(x=>x.attempt.id);
   },{kind,count});
   const dispatch=()=>page.evaluate(async()=>{const results=await Promise.allSettled(legacyContexts.map(ctx=>dispatchLegacyTask(ctx)));results.forEach(r=>{if(r.status==='rejected')holdLegacyTask(r.reason);});return results.map(r=>r.status==='fulfilled'?{status:r.value.status,taskId:r.value.task_id}:{held:!!r.reason.legacyTaskHeld,message:r.reason.message});});
   const state=()=>page.evaluate(()=>({owner:JSON.parse(JSON.stringify(fixtureOwner)),out:JSON.parse(JSON.stringify(fixtureOut)),attempts:legacyContexts.map(x=>JSON.parse(JSON.stringify(x.attempt)))}));
   await fixture();await prep();const before=posts.length;profile={saveFail:true};let result=await dispatch();assert(result[0].held);assert.equal(posts.length,before);assert.equal((await state()).attempts[0].recovery_status,'safe_to_dispatch');assert(await page.locator('#studioSaveNotice').isVisible());
   pass((smart?'smart':'classic')+': failed save blocks dispatch and keeps original unsent attempt');
   await fixture();const ids=await prep('image',3);profile={status:'paused',recovery:'receipt_saved'};const start=posts.length;result=await dispatch();assert(result.every(r=>r.held));assert.equal(posts.length-start,3);assert.equal(new Set(ids).size,3);let st=await state();assert.equal(Object.keys(st.owner.studioLegacyAttempts).length,3);assert(st.attempts.every(a=>a.snapshot.request.request_id===a.id));assert(st.attempts.every(a=>a.status==='paused'));assert.equal(smart?st.out.pendingTasks.length:st.out._pending.length,3);assert.equal(st.out.images[0].name,'previous-success.png');
   pass((smart?'smart':'classic')+': parallel batch snapshots save independently; held tasks retain prior success');
   await fixture();await prep('comfy');profile={lost:true,status:'paused',recovery:'receipt_saved'};const lostStart=posts.length,readStart=reads.length;result=await dispatch();assert(result[0].held);assert.equal(posts.length-lostStart,1);
   // Compare exact fixed UUID after response loss, never submit again.
   st=await state();assert(reads.slice(readStart).some(r=>r.byRequest&&r.id===st.attempts[0].id));assert(st.attempts[0].taskId);await page.evaluate(()=>queryLegacyTask(legacyContexts[0]));assert.equal(posts.length-lostStart,1);
   pass((smart?'smart':'classic')+': lost receipt resolves original UUID via read-only ledger query');
   await fixture();await prep();profile={lost:true,orphan:true};const orphanStart=posts.length;result=await dispatch();assert(result[0].held);st=await state();assert.equal(st.attempts[0].status,'uncertain');assert.equal(st.attempts[0].taskId,'');await page.evaluate(()=>queryLegacyTask(legacyContexts[0]));assert.equal(posts.length-orphanStart,1);assert.equal(smart?st.out.pendingTasks.length:st.out._pending.length,1);
   pass((smart?'smart':'classic')+': absent receipt remains uncertain with original ID, no blind resubmit');
   for(const recovery of ['receipt_saved','safe_to_dispatch','verification_required']){
    await fixture();await prep('comfy');profile={status:recovery==='verification_required'?'uncertain':'paused',recovery};await dispatch();const count=reads.length;await page.evaluate(async()=>{try{await waitLegacyTask(legacyContexts[0]);}catch(e){holdLegacyTask(e);}});assert.equal(reads.length-count,1,'held status stops infinite poll');
   }
   pass((smart?'smart':'classic')+': all paused/uncertain states stop polling and remain query-only');
   const repeatedStart=posts.length;await dispatch();assert.equal(posts.length,repeatedStart,'same held attempt never issues another POST');
   pass((smart?'smart':'classic')+': repeated invocation of same attempt only reads original request');
   await fixture();await prep();profile={delay:true,status:'succeeded'};await page.evaluate(()=>{window.latePromise=dispatchLegacyTask(legacyContexts[0]).catch(e=>({held:holdLegacyTask(e)}));});for(let i=0;i<100&&!delayedResolve;i++)await sleep(20);assert(delayedResolve);await page.evaluate(()=>{window.originalFixture={canvas,nodes};canvas={...canvas,id:'different-canvas'};nodes=nodes.map(n=>({...n,studioLegacyAttempts:undefined,images:[{url:'new-canvas.png'}]}));});delayedResolve();delayedResolve=null;result=await page.evaluate(()=>latePromise);assert(result.held);assert.equal(await page.evaluate(()=>nodes.find(n=>n.id===fixtureOut.id).images[0].url),'new-canvas.png');await page.evaluate(()=>{canvas=originalFixture.canvas;nodes=originalFixture.nodes;});
   pass((smart?'smart':'classic')+': delayed response cannot write cross-canvas same-ID node');
   await fixture();await prep();profile={delay:true,status:'succeeded'};await page.evaluate(()=>{window.replacedPromise=dispatchLegacyTask(legacyContexts[0]).catch(e=>({held:holdLegacyTask(e)}));});for(let i=0;i<100&&!delayedResolve;i++)await sleep(20);assert(delayedResolve);await page.evaluate(()=>{window.originalNodes=nodes;nodes=nodes.map(n=>({...n,studioLegacyAttempts:undefined,images:[{url:'replacement.png'}]}));});delayedResolve();delayedResolve=null;result=await page.evaluate(()=>replacedPromise);assert(result.held);assert.equal(await page.evaluate(()=>nodes.find(n=>n.id===fixtureOut.id).images[0].url),'replacement.png');await page.evaluate(()=>{nodes=originalNodes;});
   pass((smart?'smart':'classic')+': same-canvas replacement object rejects late original receipt');
   await fixture();await prep('comfy');profile={status:'succeeded'};await dispatch();await page.evaluate(()=>queryLegacyTask(legacyContexts[0]));st=await state();assert.equal(smart?(st.out.pendingTasks||[]).length:(st.out._pending||[]).length,0);assert(st.out.images.some(i=>i.name==='previous-success.png'));assert(st.out.images.length>=1);
   pass((smart?'smart':'classic')+': original succeeded task completes while preserving prior media');
   await fixture();await prep('comfy');profile={status:'paused',recovery:'receipt_saved'};await dispatch();
   const copied=await page.evaluate(smart=>{fixtureOwner.studioJob='original-job';fixtureOwner.studioRhRequest='original-rh';fixtureOwner.studioPrompt='copy handwritten';const copy=smart?cloneSmartNode(fixtureOwner,40,40):cloneNode(fixtureOwner,40,40);nodes.push(copy);render();return JSON.parse(JSON.stringify(copy));},smart);
   assert.equal(copied.studioLegacyAttempts,undefined);assert.equal(copied.studioJob,undefined);assert.equal(copied.studioRhRequest,undefined);assert.equal(copied.pendingTasks,undefined);assert.equal(copied._pending,undefined);assert.equal(copied.studioPrompt,'copy handwritten');assert.equal(copied.running,false);const copyReads=reads.length;await page.evaluate(smart=>smart?resumeSmartPendingTasks():resumeCanvasImageTasks(),smart);await page.waitForTimeout(80);assert(!reads.slice(copyReads).some(r=>r.id===copied.id));
   pass((smart?'smart':'classic')+': cloned nodes keep inputs/media but inherit no job, attempt or waiting identity');
   await fixture();profile={status:'succeeded'};const nativeStart=posts.length;
   if(smart){await page.evaluate(async()=>{const result=await runApiGeneration('native frozen',[],{provider_id:'offline',model:'deepwhiteai-image-g2',count:3,resolution:'1k',ratio:'1:1'},{node:fixtureOwner,out:fixtureOut});await resumeSmartPendingNode(fixtureOut);return result;});}
   else await page.evaluate(async()=>{fixtureOwner.count=3;fixtureOwner.apiProvider='legacy-fixture';fixtureOwner.model='legacy-fixture-model';await runGenerator(fixtureOwner.id);});
   assert.equal(posts.length-nativeStart,3);assert.equal(new Set(posts.slice(nativeStart).map(p=>p.body.request_id)).size,3);assert.equal(await page.evaluate(()=>Object.keys(fixtureOwner.studioLegacyAttempts).length),3);assert.equal(await page.evaluate(smart=>smart?smartPendingTasks(fixtureOut).length:(fixtureOut._pending||[]).length,smart),0);
   pass((smart?'smart':'classic')+': native image batch uses saved independent attempts and applies all results');
   await fixture();await prep();profile={status:'paused',recovery:'receipt_saved'};await dispatch();const heldId=(await state()).attempts[0].id,explicitStart=posts.length;profile={status:'succeeded'};
   if(smart)await page.evaluate(async()=>{if(smartNodeInFlight(fixtureOwner))throw Error('Explicit new task incorrectly locked by held ledger');await runApiGeneration('explicit new',[],{provider_id:'offline',model:'deepwhiteai-image-g2',count:1,resolution:'1k'},{node:fixtureOwner,out:fixtureOut});await resumeSmartPendingNode(fixtureOut);});
   else await page.evaluate(async()=>{fixtureOwner.count=1;fixtureOwner.apiProvider='legacy-fixture';fixtureOwner.model='legacy-fixture-model';await runGenerator(fixtureOwner.id);});
   assert.equal(posts.length-explicitStart,1);assert.notEqual(posts.at(-1).body.request_id,heldId);st=await state();assert.equal(st.owner.studioLegacyAttempts[heldId].status,'paused');assert.equal(smart?st.out.pendingTasks.length:st.out._pending.length,1);assert.equal(st.owner.studioLegacyAttempts[posts.at(-1).body.request_id].snapshot.run.node?.studioLegacyAttempts,undefined);
   pass((smart?'smart':'classic')+': explicit new task gets new UUID without overwriting held attempt or nesting historical snapshots');
   await fixture();const historicalId=(smart?'smart':'classic')+'-historical-id';ledger.set(historicalId,{task_id:historicalId,status:'paused',recovery_status:'receipt_saved',retryable:false});const oldPostCount=posts.length,oldReadCount=reads.length;
   await page.evaluate(({smart,id})=>{if(smart)fixtureOut.pendingTasks=[{taskId:id,kind:'image',providerId:'offline'}];else fixtureOut._pending=[{id:'old-slot',canvasTaskId:id,canvasTaskType:'online-image',startedAt:Date.now(),run:{node:{id:fixtureOwner.id}}}];smart?resumeSmartPendingTasks():resumeCanvasImageTasks();},{smart,id:historicalId});await page.waitForTimeout(100);assert.equal(posts.length,oldPostCount);assert(reads.slice(oldReadCount).some(r=>r.id===historicalId&&!r.byRequest));assert(await page.evaluate(()=>Object.values(fixtureOwner.studioLegacyAttempts||fixtureOut.studioLegacyAttempts||{}).some(a=>a.taskId)));
   pass((smart?'smart':'classic')+': historical saved task ID reads original ledger without creating a replacement');
   await fixture();const unknownReads=reads.length,unknownPosts=posts.length;
   if(smart){await page.evaluate(()=>{fixtureOwner.pending=1;fixtureOwner.runSettings={engine:'comfy'};scheduleSave();});assert((await page.evaluate(()=>saveCanvas())).ok);await page.reload();await page.waitForFunction(()=>window.StudioSave&&typeof canvas!=='undefined'&&canvas?.id);await page.waitForTimeout(150);assert(await page.evaluate(()=>nodes.some(n=>n.studioLegacyUnknown&&n.images?.length)));}
   else{await page.evaluate(()=>{fixtureOut._pending=[{id:'old-comfy-no-id',startedAt:Date.now(),run:{node:{id:fixtureOwner.id,type:'comfy'}}}];resumeCanvasImageTasks();render();});assert.match(await page.locator('[data-pending-id="old-comfy-no-id"]').innerText(),/无法定位原任务/);assert(await page.locator('[data-pending-id="old-comfy-no-id"] .output-recover-query').isDisabled());}
   assert.equal(reads.length,unknownReads);assert.equal(posts.length,unknownPosts);
   pass((smart?'smart':'classic')+': historical no-ID placeholder explains verification, preserves media, does not invent or resubmit a task');
   await fixture();await page.evaluate(()=>{window.legacyContexts=[prepareLegacyTask('comfy',{prompt:'first phase'},{node:fixtureOwner,out:fixtureOut,final:false,pipeline:{upscaleSeed:123,editUpscale:true}})];});profile={status:'succeeded'};await dispatch();const phasePosts=posts.length;await page.evaluate(()=>queryLegacyTask(legacyContexts[0]));st=await state();assert.equal(st.attempts[0].recovery_status,'next_phase_not_started');assert.equal(posts.length,phasePosts);assert.equal(smart?st.out.pendingTasks.length:st.out._pending.length,1);
   pass((smart?'smart':'classic')+': completed first phase is retained without silently dispatching the unstarted next phase');
   if(!smart){
    await fixture();profile={status:'succeeded'};await page.evaluate(()=>{fixtureOwner.apiProvider='legacy-fixture';fixtureOwner.model='legacy-frozen-model';fixtureOwner.quality='high';fixtureOwner.count=1;window.originalSize=generatorSizeForRun;generatorSizeForRun=()=>new Promise(resolve=>{window.releaseSize=()=>resolve('1024x1024');});window.sizePromise=runGenerator(fixtureOwner.id);});await page.waitForFunction(()=>typeof releaseSize==='function');await page.evaluate(()=>{fixtureOwner.apiProvider='edited-provider';fixtureOwner.model='edited-model';fixtureOwner.quality='low';fixtureOwner.count=4;releaseSize();});await page.evaluate(()=>sizePromise);await page.evaluate(()=>{generatorSizeForRun=originalSize;});assert.equal(posts.at(-1).body.quality,'high');assert.notEqual(posts.at(-1).body.model,'edited-model');assert.notEqual(posts.at(-1).body.provider_id,'edited-provider');
    pass('classic: image model/channel/quality/count freeze before asynchronous size preparation');
    await fixture();await page.evaluate(({image})=>{fixtureOwner.type='comfy';fixtureOwner.mode='enhance';fixtureOwner.enhanceStrength=0.4;fixtureOwner.enhanceUpscale=true;fixtureOwner.enhanceUpscaleRes=1536;const ref={id:'reference',type:'image',url:image,name:'reference.png',comfy_name:'fixture.png',x:0,y:300};nodes.push(ref);fixtureOwner.inputs=[ref.id];connections.push({from:ref.id,to:fixtureOwner.id});uploadCanvasUrlToComfy=async()=> 'fixture-upload.png';render();},{image});
    profile={status:'succeeded',mutate:()=>{const n=nodes.find(n=>n.id==='source');n.enhanceStrength=0.9;n.enhanceUpscaleRes=4096;n.enhanceUpscale=false;n.studioPrompt='edited while rendering';}};
    const twoPhaseStart=posts.length;await page.evaluate(()=>runComfyNode(fixtureOwner.id));const phases=posts.slice(twoPhaseStart);assert.equal(phases.length,2);assert.notEqual(phases[0].body.request_id,phases[1].body.request_id);assert.equal(phases[0].body.params['204'].value,0.4);assert.equal(phases[1].body.params['172'].resolution,1536);st=await state();const records=Object.values(st.owner.studioLegacyAttempts);assert.equal(records.length,2);assert.equal(records[0].snapshot.pipeline.upscaleSeed,phases[1].body.params['172'].seed);assert.equal(st.owner.studioPrompt,'edited while rendering');assert.equal((st.out._pending||[]).length,0);
    pass('classic: native enhance + upscale have separate UUIDs and freeze both stages despite subsequent editing');
    const spatial=await page.evaluate(()=>{const child={id:'spatial-child',type:'image',url:'data:image/png;base64,',x:50,y:50,w:100,h:100},group={id:'spatial-group',type:'group',studioSpatialGroup:true,x:0,y:0,w:500,h:500,items:['source']};nodes.push(child,group);connections=[{id:'original-connection',from:child.id,to:fixtureOwner.id}];const before=JSON.stringify(connections),handoff=handoffExistingInputsToGroup(group,[child]);updateGroupMembership([child]);return {handoff,items:group.items,unchanged:before===JSON.stringify(connections)};});assert.equal(spatial.handoff,false);assert.deepEqual(spatial.items,['source']);assert(spatial.unchanged);
    pass('classic: fixed spatial group does not absorb media or rewrite original connections');
   }else{
    await fixture();profile={status:'succeeded'};const comfyStart=posts.length;await page.evaluate(async()=>{const rs={...settings,engine:'comfy',comfyMode:'text',width:768,height:512};await runComfyGeneration(fixtureOwner,'native Comfy frozen',[],fixtureOut,{sourceNodeId:fixtureOwner.id},rs);});assert.equal(posts.length-comfyStart,1);assert.equal(posts.at(-1).kind,'comfy');assert.equal(posts.at(-1).body.width,768);assert.equal(await page.evaluate(()=>smartPendingTasks(fixtureOut).length),0);
    pass('smart: native Comfy producer persists its own attempt and retires only completed wait state');
   }
   await fixture();await prep('comfy');profile={status:'paused',recovery:'receipt_saved'};await dispatch();for(const size of [{width:1280,height:800},{width:1500,height:900}]){await page.setViewportSize(size);await page.evaluate(()=>render());await page.waitForTimeout(150);assert((await page.locator('body').innerText()).includes('仅查询本地任务记录'));const query=page.locator(smart?'[data-image-task-query]':'.output-recover-query').first();const oldCount=reads.length,postCount=posts.length;await query.click();await page.waitForTimeout(80);assert.equal(reads.length,oldCount+1);assert.equal(posts.length,postCount);const bounds=await query.boundingBox();assert(bounds&&bounds.width>60&&bounds.x>=0&&bounds.x+bounds.width<=size.width);await page.screenshot({path:path.join(artifacts,(smart?'smart':'classic')+'-'+size.width+'x'+size.height+'.png')});}
   await page.evaluate(()=>saveCanvas());const savedAttempts=(await api('/api/canvases/'+c.id)).canvas.nodes.find(n=>n.id==='source').studioLegacyAttempts;assert(savedAttempts);const reloadPosts=posts.length;await page.reload();await page.waitForFunction(()=>window.StudioSave&&typeof canvas!=='undefined'&&canvas?.id);await page.waitForTimeout(300);assert.equal(posts.length,reloadPosts,'reload never submits generation');assert(await page.evaluate(()=>nodes.some(n=>Object.values(n.studioLegacyAttempts||{}).some(a=>a.status==='paused'))));
   pass((smart?'smart':'classic')+': held attempts survive actual save/reload; two viewport notices visible');
   await context.close();
  }
  assert.deepEqual(external,[]);assert.deepEqual(pageErrors,[]);console.log('ALL '+passed.length+' GROUPS PASSED\nScreenshots: '+artifacts);
 }catch(err){if(page&&!page.isClosed())await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});throw err;}
 finally{await browser?.close();server?.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
