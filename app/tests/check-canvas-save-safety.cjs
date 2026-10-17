/* Real temporary canvas storage and UI; every upstream is blocked or mocked. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path'));}
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-save-safety-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],submitted=[],puts=[],errors=[],external=[],jobs=new Map();
let child,browser,log='',mode='ok',held=null,release=null,holdGeneration=false,heldGeneration=null,releaseGeneration=null;
async function main(){
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port;
 const api=async(url,method='GET',body)=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json();};
 try{
  child=spawn(process.env.PYTHON_EXECUTABLE||path.join(root,'python/python.exe'),['-B',path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:String(port),DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'}});
  child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
  let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await delay(200);}}assert(ready,log);
  await api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'Save offline fixture',base_url:'https://api.deepwhiteai.com/v1',api_key:'offline-save-test',enabled:true,primary:true});
  const a=(await api('/api/canvases','POST',{title:'Save fixture A',kind:'classic'})).canvas;
  const b=(await api('/api/canvases','POST',{title:'Save fixture B',kind:'classic'})).canvas;
  const smart=(await api('/api/canvases','POST',{title:'Smart save fixture',kind:'smart'})).canvas;
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1500,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!==base){external.push(url.origin);return route.abort();}
   if(mode==='read-fail'&&url.pathname.startsWith('/api/canvases/')&&req.method()==='GET')return route.fulfill({status:503,json:{detail:'mock verification outage'}});
   if(url.pathname.startsWith('/api/canvases/')&&req.method()==='PUT'){
    puts.push({id:url.pathname.split('/').at(-1),body:req.postDataJSON()});
    if(mode==='fail')return route.fulfill({status:500,json:{detail:'isolated save failure'}});
    if(mode==='conflict'){
     const remote=(await api(url.pathname)).canvas;
     remote.nodes=remote.nodes.map(n=>({...n,promptDraftHtml:'远端旧描述',promptDraftText:'远端旧描述',studioPrompt:'远端旧描述'}));
     return route.fulfill({status:409,json:{detail:{canvas:remote}}});
    }
    if(mode==='unconfirmed')return route.fulfill({json:{canvas:(await api(url.pathname)).canvas}});
    if(mode==='delay'){
     held={id:url.pathname.split('/').at(-1),body:req.postDataJSON()};await new Promise(r=>release=r);
    }
    return route.continue();
   }
   if(url.pathname==='/api/studio/generations'&&req.method()==='POST'){
    const body=req.postDataJSON(),stored=(await api('/api/canvases/'+body.canvas_id)).canvas.nodes.find(n=>n.id===body.node_id);
    assert.equal(stored?.studioJob,body.request_id,'UUID must be durable before a generation POST');
    assert.deepEqual(stored.studioSubmission.request,body,'original immutable request must already be saved');
    assert.equal(stored.studioSavingSubmission,undefined,'transient save lock must not survive reload');
    submitted.push(body);
    const job={id:body.request_id,request:body,resolved_model:body.model,status:'succeeded',created_at:Date.now()/1000,updated_at:Date.now()/1000,error:'',children:[],task_ids:['mock-'+submitted.length],outputs:body.kind==='chat'?[]:[{url:'/static/studio-mark.svg',kind:body.kind}],text:body.kind==='chat'?'offline text':''};jobs.set(job.id,job);if(holdGeneration){holdGeneration=false;heldGeneration=body;await new Promise(r=>releaseGeneration=r);}return route.fulfill({json:job});
   }
   if(url.pathname==='/api/studio/generations')return route.fulfill({json:{items:[...jobs.values()].filter(j=>j.request.canvas_id===url.searchParams.get('canvas_id')).reverse()}});
   if(url.pathname.startsWith('/api/studio/generations/'))return route.fulfill({json:jobs.get(url.pathname.split('/')[4])||{detail:'No task'},status:jobs.has(url.pathname.split('/')[4])?200:404});
   if(req.method()==='POST'&&/\/api\/(canvas-(image|video|llm)|online-image|studio\/mj\/submit|studio\/runninghub\/tasks)/.test(url.pathname))throw Error('Unexpected paid route: '+url.pathname);
   return route.continue();
  });
  const openClassic=async()=>{await page.goto(base+'/static/canvas.html?id='+a.id);await page.locator('#shell:not(.no-canvas) #board').waitFor();await page.waitForFunction(()=>canvas?.id&&StudioStageOne.getCapabilities().deepwhite);};
  await openClassic();await page.evaluate(()=>{const n=addGeneratorNode({x:90,y:90});n.id='save-node';n.apiProvider='deepwhite';n.model='deepwhiteai-image-g-v2.5-lowprice';n.studioPrompt='手写猫咪在窗边晒太阳';render();clearTimeout(saveTimer);saveTimer=null;});
  mode='fail';await page.evaluate(()=>StudioStageOne.run(nodes.find(n=>n.id==='save-node')));
  assert.equal(submitted.length,0);assert.equal(await page.locator('#studioSaveNotice').isVisible(),true);
  assert.deepEqual(await page.evaluate(()=>{const n=nodes.find(n=>n.id==='save-node');return {text:n.studioPrompt,state:n.studioJobState,id:n.studioJob,posted:n.studioSubmission.submitted,locked:!!n.studioSavingSubmission};}),{text:'手写猫咪在窗边晒太阳',state:'failed',id:'',posted:false,locked:false});
  const reviewDir=path.join(os.tmpdir(),'deepwhite-save-safety-review');fs.mkdirSync(reviewDir,{recursive:true});
  await page.setViewportSize({width:600,height:800});
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('studio-save-state',{detail:{ok:false,canvasId:canvas.id,code:'failed',error:'保存错误：'+('X'.repeat(1100))}})));
  const longTextBounds=await page.locator('#studioSaveNotice span').boundingBox();assert(longTextBounds&&longTextBounds.x>=0&&longTextBounds.x+longTextBounds.width<=600,'long error text wraps within a narrow viewport');
  assert(await page.locator('#studioSaveNotice span').evaluate(el=>el.scrollWidth<=el.clientWidth),'long error must not overflow its visible text box');assert(await page.locator('#studioSaveNotice button').isVisible());await page.evaluate(()=>saveCanvas());
  for(const [width,height] of [[1280,800],[1500,900]]){
   await page.setViewportSize({width,height});await page.locator('[data-id="save-node"] .studio-prompt-input').focus();
   const notice=page.locator('#studioSaveNotice'),bounds=await notice.boundingBox();assert(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width&&bounds.y+bounds.height<=height,'save notice stays within viewport');
   assert(await notice.getByRole('button',{name:'重试保存',exact:true}).isVisible());assert.equal(await page.locator('[data-id="save-node"] .studio-prompt-input').inputValue(),'手写猫咪在窗边晒太阳');
   await page.screenshot({path:path.join(reviewDir,'save-failure-'+width+'x'+height+'.png')});
  }
  await page.setViewportSize({width:1500,height:1000});checks.push('failed save retains editable input and visible retry at 1280x800 and 1500x900; review screenshots outside temporary fixture');
  const result=await page.evaluate(()=>saveCanvas());assert.equal(result.ok,false);assert.equal(result.code,'failed');
  await page.evaluate(()=>returnToCanvasManager());assert.equal(await page.evaluate(()=>canvas?.id),a.id,'failed save cannot discard canvas on return');
  checks.push('classic 500 is visible, preserves handwriting, returns failure, blocks POST and leaving the draft');
  mode='ok';await page.evaluate(()=>StudioStageOne.run(nodes.find(n=>n.id==='save-node')));assert.equal(submitted.length,1);
  await page.evaluate(()=>saveCanvas());assert.equal(await page.locator('#studioSaveNotice').count(),0);
  await page.reload();await page.locator('#shell:not(.no-canvas) #board').waitFor();await page.waitForFunction(()=>canvas?.id&&StudioStageOne.getCapabilities().deepwhite);assert.equal(submitted.length,1);assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='save-node').studioPrompt),'手写猫咪在窗边晒太阳');
  checks.push('retry saves UUID and original request before one POST; reload retains handwriting and never resubmits');
  const beforeInvalid=submitted.length,putBefore=puts.length;
  for(const text of ['短','x'.repeat(5001)]){
   const error=await page.evaluate(async text=>{const n=nodes.find(n=>n.id==='save-node');n.studioPrompt=text;try{await runGenerator(n.id,{cascade:true});return '';}catch(e){return e.message;}},text);assert(error.includes('5–5000'));
  }
  const missing=await page.evaluate(async()=>{const n=addVideoNode({x:800,y:100});n.apiProvider='deepwhite';n.model='seedance-2.0-fast';n.studioPrompt='根据 @图片1 运动，没有关联素材';clearTimeout(saveTimer);saveTimer=null;try{await StudioStageOne.run(n,{cascade:true});return '';}catch(e){return e.message;}});assert(missing.includes('素材'));
  const actualLLM=await page.evaluate(async()=>{const n=addLLMNode({x:800,y:500});n.llmProvider='deepwhite';render();n.userInput='有效的节点输入';clearTimeout(saveTimer);saveTimer=null;try{await callCanvasLLM(n,'');return '';}catch(e){return e.message;}});assert(actualLLM.includes('提示词'),actualLLM);
  assert.equal(submitted.length,beforeInvalid);assert.equal(puts.length,putBefore);checks.push('direct/cascade short or long input, missing references and actual empty LLM message are rejected before save/POST');
  await page.evaluate(()=>{nodes=nodes.filter(n=>n.id==='save-node');nodes[0].studioPrompt='等待保存时固定的原始猫咪描述';render();clearTimeout(saveTimer);saveTimer=null;});
  mode='delay';held=null;await page.evaluate(()=>{window.pendingRun=StudioStageOne.run(nodes[0]);});await page.waitForFunction(()=>nodes[0].studioSavingSubmission);for(let i=0;i<100&&!held;i++)await delay(20);assert(held);
  await page.evaluate(()=>StudioStageOne.run(nodes[0]));assert.equal(submitted.length,beforeInvalid);
  await page.evaluate(()=>{nodes[0].studioPrompt='保存等待期间的新手写内容';});mode='ok';release();await page.evaluate(()=>window.pendingRun);
  assert.equal(submitted.length,beforeInvalid+1);assert.equal(submitted.at(-1).prompt,'等待保存时固定的原始猫咪描述');assert.equal(await page.evaluate(()=>nodes[0].studioPrompt),'保存等待期间的新手写内容');
  await page.evaluate(()=>saveCanvas());assert.equal((await api('/api/canvases/'+a.id)).canvas.nodes.find(n=>n.id==='save-node').studioPrompt,'保存等待期间的新手写内容');
  checks.push('duplicate click during save is blocked; edits remain live while POST uses the fixed durable snapshot');
  // A completed older text task must not release a newer text task's save lock.
  holdGeneration=true;heldGeneration=null;await page.evaluate(()=>{const n=addLLMNode({x:800,y:500});n.id='owner-text';n.llmProvider='deepwhite';render();clearTimeout(saveTimer);saveTimer=null;window.oldText=callCanvasLLM(n,'第一个有效文本任务').catch(e=>e.message);});for(let i=0;i<100&&!heldGeneration;i++)await delay(20);assert(heldGeneration);
  mode='delay';held=null;await page.evaluate(()=>{window.newText=callCanvasLLM(nodes.find(n=>n.id==='owner-text'),'第二个有效文本任务').catch(e=>e.message);});for(let i=0;i<100&&!held;i++)await delay(20);assert(held);const newTextId=held.body.nodes.find(n=>n.id==='owner-text').studioJob;
  releaseGeneration();await page.evaluate(()=>window.oldText);assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='owner-text').studioSavingSubmission),newTextId);
  const third=await page.evaluate(async()=>{try{await callCanvasLLM(nodes.find(n=>n.id==='owner-text'),'第三个有效文本任务');return '';}catch(e){return e.message;}});assert(third.includes('正在保存'));assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='owner-text').studioJob),newTextId);
  mode='ok';release();await page.evaluate(()=>window.newText);assert.equal(submitted.filter(j=>j.node_id==='owner-text').length,2);checks.push('older LLM completion cannot clear the new owner save lock; a third call is blocked while saving');
  await page.evaluate(()=>{nodes=nodes.filter(n=>n.id!=='owner-text');});
  mode='unconfirmed';await page.evaluate(()=>StudioStageOne.run(nodes[0]));assert.equal(submitted.length,beforeInvalid+3);assert.equal(await page.evaluate(()=>nodes[0].studioJobState),'failed');
  assert(await page.locator('#studioSaveNotice').isVisible());
  mode='read-fail';await page.evaluate(()=>StudioStageOne.run(nodes[0]));assert.equal(submitted.length,beforeInvalid+3);assert.equal(await page.evaluate(()=>nodes[0].studioJobState),'failed');assert((await page.locator('#studioSaveNotice').innerText()).includes('核实'));
  checks.push('HTTP 200 without a durable receipt and failed read-back both block generation with visible failure');
  mode='ok';await page.evaluate(()=>{nodes[0].studioPrompt='本地冲突手写内容不会消失';scheduleSave();});mode='conflict';await page.evaluate(()=>StudioStageOne.run(nodes[0]));assert.equal(submitted.length,beforeInvalid+3);assert.equal(await page.evaluate(()=>nodes[0].studioPrompt),'本地冲突手写内容不会消失');assert(await page.locator('#studioSaveNotice').isVisible());
  mode='ok';await openClassic();
  mode='delay';held=null;const beforeSwitch=submitted.length;await page.evaluate(()=>{nodes[0].studioPrompt='提交保存期间切换项目';window.pendingRun=StudioStageOne.run(nodes[0]);});for(let i=0;i<100&&!held;i++)await delay(20);assert(held);await page.evaluate(b=>{canvas=b;nodes=[{id:'save-node',type:'generator',studioPrompt:'新项目手写'}];connections=[];},b);mode='ok';release();await page.evaluate(()=>window.pendingRun);assert.equal(submitted.length,beforeSwitch);assert.equal(await page.evaluate(()=>nodes[0].studioPrompt),'新项目手写');checks.push('switching canvas while pre-submit save is pending blocks POST entirely');
  await openClassic();
  // A slow save and a queued second save both belong to A, even if B reuses its node id.
  mode='delay';held=null;await page.evaluate(()=>{nodes[0].studioPrompt='切换前的原项目输入';window.pendingSave=saveCanvas();window.queuedSave=saveCanvas();});for(let i=0;i<100&&!held;i++)await delay(20);assert(held);
  await page.evaluate(b=>{canvas=b;nodes=[{id:'save-node',type:'generator',studioPrompt:'新项目内容'}];connections=[];},b);mode='ok';release();
  const switched=await page.evaluate(async()=>({first:await pendingSave,queued:await queuedSave,title:canvas.title,revision:canvas.updated_at,text:nodes[0].studioPrompt}));assert.equal(switched.first.code,'target-changed');assert.equal(switched.queued.code,'target-changed');assert.equal(switched.title,b.title);assert.equal(switched.revision,b.updated_at);assert.equal(switched.text,'新项目内容');assert.equal(puts.at(-1).id,a.id);
  checks.push('classic conflicts preserve local draft; late and queued saves never update/write the new canvas');
  await page.goto(base+'/static/smart-canvas.html?id='+smart.id);await page.waitForFunction(()=>canvas?.id&&window.StudioSave);await delay(400);
  await page.evaluate(()=>{const n=createNode(120,120,[]);n.id='smart-save';n.promptDraftHtml='智能画布的手写描述';n.promptDraftText='智能画布的手写描述';canvas.nodes=nodes;clearTimeout(saveTimer);saveTimer=null;});
  mode='fail';const smartFailed=await page.evaluate(()=>saveCanvas());assert.equal(smartFailed.ok,false);assert(await page.locator('#studioSaveNotice').isVisible());assert.equal(await page.evaluate(()=>nodes[0].promptDraftText),'智能画布的手写描述');
  mode='ok';assert.equal((await page.evaluate(()=>saveCanvas())).ok,true);assert.equal((await api('/api/canvases/'+smart.id)).canvas.nodes[0].promptDraftText,'智能画布的手写描述');
  await page.evaluate(()=>{nodes[0].studioRhRequest='rh-offline-request';nodes[0].studioRhSnapshot={prompt:'RH原始描述',value:0};});
  const rhSaved=await page.evaluate(()=>StudioSave.ensureCurrent({canvasId:canvas.id,nodeId:nodes[0].id,jobId:'rh-offline-request',requestField:'studioRhRequest',snapshotField:'studioRhSnapshot'}));assert.equal(rhSaved.ok,true);assert.equal(rhSaved.node.studioRhSnapshot.value,0);
  checks.push('smart 500 is visible and recoverable; StudioSave verifies RH custom UUID/snapshot fields without a paid call');
  const independent=await page.evaluate(async()=>{
   const node=nodes[0];node.studioLegacyAttempts={};
   const requests=[{request_id:'batch-slot-a',prompt:'同一节点第一张',count:0},{request_id:'batch-slot-b',prompt:'同一节点第二张',count:2}];
   for(const request of requests)node.studioLegacyAttempts[request.request_id]={id:request.request_id,snapshot:{request}};
   return Promise.all(requests.map(request=>StudioSave.ensureCurrent({canvasId:canvas.id,nodeId:node.id,jobId:request.request_id,request,
     requestField:['studioLegacyAttempts',request.request_id,'id'],snapshotField:['studioLegacyAttempts',request.request_id,'snapshot']})));
  });
  assert(independent.every(r=>r.ok));const batchStored=(await api('/api/canvases/'+smart.id)).canvas.nodes[0].studioLegacyAttempts;
  assert.equal(batchStored['batch-slot-a'].snapshot.request.count,0);assert.equal(batchStored['batch-slot-b'].snapshot.request.prompt,'同一节点第二张');
  checks.push('parallel batch slots verify independent nested receipt paths without overwriting each other');

  mode='conflict';await page.evaluate(()=>{lastComposerNodeId=nodes[0].id;promptInput.textContent='智能冲突后的本地手写';nodes[0].promptDraftHtml='智能冲突后的本地手写';nodes[0].promptDraftText='智能冲突后的本地手写';});const conflict=await page.evaluate(()=>saveCanvas());assert.equal(conflict.code,'conflict');assert.equal(await page.evaluate(()=>nodes[0].promptDraftText),'智能冲突后的本地手写');assert.equal(await page.locator('#promptInput').innerText(),'智能冲突后的本地手写');mode='ok';await page.evaluate(()=>{clearTimeout(saveTimer);saveTimer=null;});assert.equal((await page.evaluate(()=>saveCanvas())).ok,true);assert.equal((await api('/api/canvases/'+smart.id)).canvas.nodes[0].promptDraftText,'智能冲突后的本地手写');
  checks.push('smart native conflict merge preserves local handwritten draft and can save it on retry');
  mode='delay';held=null;await page.evaluate(()=>{window.pendingSave=saveCanvas();});for(let i=0;i<100&&!held;i++)await delay(20);assert(held);await page.evaluate(()=>{canvas={id:'different-smart',title:'新智能项目',updated_at:7};nodes=[{id:'smart-save',promptDraftText:'新项目'}];});mode='ok';release();const smartSwitched=await page.evaluate(async()=>({result:await pendingSave,revision:canvas.updated_at,text:nodes[0].promptDraftText}));assert.equal(smartSwitched.result.code,'target-changed');assert.equal(smartSwitched.revision,7);assert.equal(smartSwitched.text,'新项目');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);checks.push('smart late save cannot update the new canvas; no browser errors, private account data or external/paid requests');
  console.log(JSON.stringify({passed:true,checks},null,2));
 }finally{release?.();releaseGeneration?.();await browser?.close();if(child){child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,5000);});}const relative=path.relative(os.tmpdir(),runtime);assert(relative.startsWith('dw-save-safety-')&&!relative.includes(path.sep),'cleanup remains inside this exact temp fixture');fs.rmSync(runtime,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack);console.error(log.slice(-3500));process.exitCode=1;});
