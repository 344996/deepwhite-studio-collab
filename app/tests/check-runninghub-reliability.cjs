'use strict';
// Formal canvas + isolated backend. All RH transport is intercepted; server also
// blocks external requests. No user data, private catalogue or paid generation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path');
const executablePath=process.env.CHROMIUM_EXECUTABLE||'data/local-path';
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-rh-reliability-')),artifacts=path.join(os.tmpdir(),'deepwhite-rh-reliability');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`,submitted=[],uploaded=[],errors=[],external=[],jobs=new Map(),queryRequests=[];let log='',browser,uploadMode='ok',submitMode='ok',heldQuery=null,holdQuery=false,holdUpload=false,heldUpload=null,listRecovery=false;
 const server=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});
 server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
 const api=async(url,method='GET',body)=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(response.ok,await response.clone().text());return response.json();};
 try{
  let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await pause(200);}}assert(ready,log);
  const canvas=(await api('/api/canvases','POST',{title:'RH隔离可靠性验收',kind:'classic'})).canvas;
  browser=await chromium.launch({headless:true,executablePath});const page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==base){external.push(request.url());return route.abort();}
   const json=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
   if(url.pathname==='/api/runninghub/upload-asset'){
    uploaded.push(request.postDataJSON());
    if(holdUpload){holdUpload=false;await new Promise(resolve=>heldUpload=resolve);}
    if(uploadMode==='failure')return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({detail:{message:'Image node 9 rejected; "apiKey":"quoted-secret"; token=private-secret https://bad.invalid/?token=leak'}})});
    return json({data:uploadMode==='missing-filename'?{}:{fileName:'api/mock-'+uploaded.length+'.png'}});
   }
   if(url.pathname==='/api/studio/runninghub/tasks'&&request.method()==='POST'){
    const body=request.postDataJSON();submitted.push(body);
    // Independently read real persisted canvas before allowing the mocked submit.
    const saved=(await api('/api/canvases/'+body.canvas_id)).canvas;
    const node=saved.nodes.find(n=>n.id===body.node_id);assert.equal(node.studioRhRequest,body.request_id);assert.deepEqual(node.studioRhSnapshot,body);assert(!node.studioHistoryRestored,'explicit fresh request removes prior history hold before saving');
    if(submitMode==='failure')return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({detail:'连接中断'})});
    const job={id:body.request_id,request:body,task_id:'mock-remote-'+submitted.length,status:'queued',outputs:[],error:''};jobs.set(job.id,job);return json(job);
   }
   if(url.pathname.startsWith('/api/studio/runninghub/tasks/')){
    queryRequests.push(url.pathname);
    if(holdQuery){await new Promise(resolve=>{heldQuery=resolve;});}
    return json(jobs.get(decodeURIComponent(url.pathname.split('/').at(-1))));
   }
   if(url.pathname==='/api/studio/runninghub/tasks')return json({tasks:listRecovery?[...jobs.values()]:[]});
   if(url.pathname==='/api/studio/runninghub/catalog')return json({apps:[],workflows:[]});
   if(url.pathname.startsWith('/api/runninghub/')&&request.method()==='GET')return route.continue();
   if(url.pathname.startsWith('/api/runninghub/'))return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'未允许的RH测试请求'})});
   if(request.method()==='POST'&&/\/api\/(studio\/(generations|mj\/submit)|canvas-image|canvas-video|online-image)/.test(url.pathname))throw Error('Unexpected generation request');
   return route.continue();
  });
  await page.goto(base+'/static/canvas.html?id='+canvas.id);await page.locator('#shell:not(.no-canvas) #board').waitFor();await page.waitForFunction(()=>window.StudioRunningHub&&window.StudioSave?.ensureCurrent);
  const id=await page.evaluate(()=>{
   nodes=[];connections=[];selected.clear();const node=addRhNode({x:70,y:80});node.instanceType='plus';
   const fields=[
    {nodeId:'1',fieldName:'steps',fieldType:'INT',sourceFromUpstream:false,fieldValue:30},
    {nodeId:'2',fieldName:'text',fieldType:'STRING',sourceFromUpstream:false,fieldValue:'默认手写'},
    {nodeId:'3',fieldName:'seed',fieldType:'INT',sourceFromUpstream:false,fieldValue:1,random_enabled:true},
    {nodeId:'8',fieldName:'image',fieldType:'IMAGE',imageOrder:1,required:true},
    {nodeId:'9',fieldName:'image',fieldType:'IMAGE',imageOrder:0,required:true},
    {nodeId:'10',fieldName:'image',fieldType:'IMAGE',imageOrder:2,required:false},
    {nodeId:'11',fieldName:'video',fieldType:'VIDEO',sourceFromUpstream:false,fieldValue:''},
    {nodeId:'12',fieldName:'audio',fieldType:'AUDIO',sourceFromUpstream:false,fieldValue:''}
   ];
   const entry={id:'12345678',workflowId:'12345678',title:'隔离测试工作流',fields,workflowJson:{'9':{class_type:'LoadImage',inputs:{image:'default.png'}},'10':{class_type:'LoadImage',inputs:{image:'optional.png'}}}};
   applyRhEntrySelection(node,{kind:'workflow',id:entry.id,entry});runningHubWorkflowCache[entry.id]=entry;
   node.rhParams={'1::steps':{value:0},'2::text':{value:'手写原文'},'3::seed':{value:'18446744073709551615'},'9::image':{sourceFromUpstream:false,value:'/api/storage-files/local/manual.png'},'11::video':{sourceFromUpstream:false,value:'/api/storage-files/upload/manual.mp4'},'12::audio':{sourceFromUpstream:false,value:'/api/storage-files/generated/manual.wav'}};
   node.rhRandomActive={'3::seed':false};window.rhTestId=node.id;
   window.rhTestMedia={image:[{url:'/api/storage-files/local/upstream-zero.png'},{url:'/api/storage-files/local/upstream-one.png'}],video:[],audio:[],prompt:'上游文本'};
   window.rhMediaOriginal=rhMediaSources;rhMediaSources=()=>rhTestMedia;
   render();return node.id;
  });
  const mapping=await page.evaluate(async()=>{const n=nodes.find(n=>n.id===rhTestId),info=await rhBuildNodeInfoList(n,rhTestMedia),extras=await rhBuildWorkflowRequestExtras(n,rhTestMedia,info);return {info,extras,indexes:rhFieldIndexes(rhActiveFields(n)),params:n.rhParams};});
  assert.equal(mapping.indexes['9::image'],0);assert.equal(mapping.indexes['8::image'],1);assert.equal(mapping.info.find(f=>f.fieldName==='steps').fieldValue,0);assert.equal(mapping.info.find(f=>f.fieldName==='text').fieldValue,'手写原文');assert.equal(mapping.info.find(f=>f.fieldName==='seed').fieldValue,'18446744073709551615');
  assert(uploaded.some(item=>item.url.endsWith('upstream-one.png')));assert(!uploaded.some(item=>item.url.endsWith('upstream-zero.png')));assert.equal(mapping.info.filter(f=>['image','video','audio'].includes(f.fieldName)).length,4);assert.equal(mapping.extras.workflow['9'].inputs.image,'default.png');assert(!mapping.extras.workflow['10']);
  const defaults=await page.evaluate(()=>{const n=nodes.find(n=>n.id===rhTestId),text=rhActiveFields(n).find(f=>f.fieldName==='text'),image={nodeId:'99',fieldName:'image',fieldType:'IMAGE',sourceFromUpstream:false,fieldValue:'api/manual-default.png'};const saved=n.rhParams['2::text'];delete n.rhParams['2::text'];const result={prompt:rhFieldValue(n,text,rhTestMedia),image:rhFieldValue(n,image,rhTestMedia)};n.rhParams['2::text']=saved;return result;});
  assert.equal(defaults.prompt,'默认手写');assert.equal(defaults.image,'api/manual-default.png');
  assert.equal(await page.locator(`[data-id="${id}"] .rh-entry-select`).inputValue(),'workflow:12345678');
  await page.evaluate(async()=>await runRhNode(rhTestId));assert.equal(submitted.length,1);assert.equal(submitted[0].payload.instanceType,'plus');assert.equal(submitted[0].payload.nodeInfoList.find(f=>f.fieldName==='seed').fieldValue,'18446744073709551615');
  // Each new submission gets a fresh random seed; merely querying does not.
  await page.evaluate(()=>{const n=nodes.find(n=>n.id===rhTestId);n.running=false;n.studioRhStatus='succeeded';n.rhRandomActive['3::seed']=true;window.randomCount=100;window.originalRandom=crypto.getRandomValues;crypto.getRandomValues=array=>{array.fill(0);array[array.length-1]=++randomCount;return array;};});
  await page.evaluate(async()=>await runRhNode(rhTestId));await page.evaluate(()=>{const n=nodes.find(n=>n.id===rhTestId);n.running=false;n.studioRhStatus='succeeded';});await page.evaluate(async()=>await runRhNode(rhTestId));
  assert.equal(submitted[1].payload.nodeInfoList.find(f=>f.fieldName==='seed').fieldValue,101);assert.equal(submitted[2].payload.nodeInfoList.find(f=>f.fieldName==='seed').fieldValue,102);
  await page.evaluate(()=>crypto.getRandomValues=originalRandom);
  const ranges=await page.evaluate(async()=>{
   const original=nodes.find(n=>n.id===rhTestId),results=[];
   for(const schema of [{min:0,max:0,step:1},{min:'18446744073709551615',max:'18446744073709551615',step:'1'},{min:'4294967300',max:'4294967310',step:'3'},{min:10,max:0,step:1},{min:0,max:10,step:0},{min:0,max:10,step:'0.5'},{min:9007199254740992,max:'18446744073709551615',step:1}]){
    const n=JSON.parse(JSON.stringify(original)),field={nodeId:'3',fieldName:'seed',fieldType:'INT',random_enabled:true,...schema};n.studioRhDefinition.entry.fields=[field];n.rhRandomValues={};n.rhRandomActive={'3::seed':true};
    try{results.push((await rhBuildNodeInfoList(n,{image:[],video:[],audio:[],prompt:''}))[0].fieldValue);}catch(error){results.push(error.message);}
   }return results;
  });
  assert.equal(ranges[0],0);assert.equal(ranges[1],'18446744073709551615');assert(BigInt(ranges[2])>=4294967300n&&BigInt(ranges[2])<=4294967310n);assert.equal((BigInt(ranges[2])-4294967300n)%3n,0n);assert(ranges[3].includes('小于'));assert(ranges[4].includes('大于0'));assert(ranges[5].includes('整数'));assert(ranges[6].includes('字符串'));
  // Slow upload must not combine old fields/media with a newly selected workflow.
  await page.evaluate(()=>{const n=nodes.find(n=>n.id===rhTestId);n.running=false;n.studioRhStatus='succeeded';window.slowOriginal=JSON.parse(JSON.stringify(n));});
  const beforeSlow=submitted.length,uploadBeforeSlow=uploaded.length;holdUpload=true;
  const slowSubmit=page.evaluate(async()=>await runRhNode(rhTestId));for(let i=0;i<100&&!heldUpload;i++)await pause(10);assert(heldUpload);
  await page.evaluate(()=>{
   const n=nodes.find(n=>n.id===rhTestId),entry={id:'87654321',workflowId:'87654321',title:'上传时新选择',fields:[{nodeId:'99',fieldName:'steps',fieldType:'INT',fieldValue:99}],workflowJson:{}};
   applyRhEntrySelection(n,{kind:'workflow',id:entry.id,entry});runningHubWorkflowCache[entry.id]=entry;n.rhParams={'1::steps':{value:90},'2::text':{value:'上传时改写'}};n.instanceType='';rhTestMedia.image=[{url:'/api/storage-files/local/new-input.png'}];
  });heldUpload();await slowSubmit;
  assert.equal(submitted.length,beforeSlow+1);const slowPayload=submitted.at(-1).payload;assert.equal(slowPayload.workflowId,'12345678');assert.equal(slowPayload.instanceType,'plus');assert.equal(slowPayload.nodeInfoList.find(f=>f.fieldName==='steps').fieldValue,0);assert.equal(slowPayload.nodeInfoList.find(f=>f.fieldName==='text').fieldValue,'手写原文');assert(uploaded.slice(uploadBeforeSlow).some(f=>f.url.endsWith('upstream-one.png')));assert(!uploaded.slice(uploadBeforeSlow).some(f=>f.url.endsWith('new-input.png')));
  await page.evaluate(()=>{const n=nodes.find(n=>n.id===rhTestId),request=n.studioRhRequest,snapshot=n.studioRhSnapshot;Object.assign(n,slowOriginal,{studioRhRequest:request,studioRhSnapshot:snapshot,studioRhStatus:'succeeded',running:false});rhTestMedia.image=[{url:'/api/storage-files/local/upstream-zero.png'},{url:'/api/storage-files/local/upstream-one.png'}];render();});
  // Error before a request exists remains visible; missing fileName cannot leak
  // a local URL into a submitted workflow.
  await page.evaluate(()=>{const n=nodes.find(n=>n.id===rhTestId);n.running=false;n.studioRhStatus='succeeded';});uploadMode='failure';const count=submitted.length;
  await page.evaluate(async()=>await runRhNode(rhTestId));assert.equal(submitted.length,count);
  const error=await page.locator(`[data-id="${id}"] .studio-rh-status`).innerText();assert(error.includes('素材上传失败'));assert(error.includes('Image node 9'));assert(!error.includes('private-secret'));assert(!error.includes('quoted-secret'));assert(!error.includes('bad.invalid'));
  uploadMode='missing-filename';await page.evaluate(async()=>await runRhNode(rhTestId));assert.equal(submitted.length,count);assert((await page.locator(`[data-id="${id}"] .studio-rh-status`).innerText()).includes('fileName'));uploadMode='ok';
  // A failed save cannot dispatch a task, and the next retry can submit instead
  // of trying to query a request that was never sent.
  await page.evaluate(()=>{window.originalSave=StudioSave;window.StudioSave={...StudioSave,ensureCurrent:async()=>{throw Error('隔离测试保存失败');}};});
  await page.evaluate(async()=>await runRhNode(rhTestId));assert.equal(submitted.length,count);assert.equal(await page.evaluate(()=>nodes.find(n=>n.id===rhTestId).studioRhStatus),'not_submitted');assert(!await page.evaluate(()=>nodes.find(n=>n.id===rhTestId).studioRhRequest));
  assert((await page.locator(`[data-id="${id}"] .studio-rh-status`).innerText()).includes('未提交'));assert.equal(await page.locator(`[data-id="${id}"] .studio-rh-status button`).count(),0);
  assert.equal(await page.evaluate(()=>nodes.find(n=>n.id===rhTestId).runStatus),'failed');
  await page.evaluate(()=>window.StudioSave=originalSave);await page.evaluate(async()=>await runRhNode(rhTestId));assert.equal(submitted.length,count+1);
  // A connection failure after dispatch retains identity and only queries it.
  await page.evaluate(()=>{const n=nodes.find(n=>n.id===rhTestId);n.running=false;n.studioRhStatus='succeeded';});submitMode='failure';await page.evaluate(async()=>await runRhNode(rhTestId));const uncertain=submitted.at(-1);jobs.set(uncertain.request_id,{id:uncertain.request_id,request:uncertain,task_id:'mock-recovered',status:'queued',outputs:[],error:''});submitMode='ok';
  const afterFailure=submitted.length;await page.evaluate(async()=>await runRhNode(rhTestId));assert.equal(submitted.length,afterFailure);assert.equal(await page.evaluate(()=>nodes.find(n=>n.id===rhTestId).studioRhRemote),'mock-recovered');
  // Query completion cannot affect another canvas, even with the same node ID.
  holdQuery=true;const pending=page.evaluate(async()=>await StudioRunningHub.resume(nodes.find(n=>n.id===rhTestId)));
  for(let i=0;i<100&&!heldQuery;i++)await pause(10);assert(heldQuery);
  await page.evaluate(()=>{window.originCanvas=canvas;window.originNodes=nodes;canvas={id:'different-canvas'};nodes=[{id:rhTestId,type:'rh',runError:'目标保持',studioRhRequest:'different-request'}];});heldQuery();await pending;holdQuery=false;
  assert.equal(await page.evaluate(()=>nodes[0].runError),'目标保持');assert.equal(await page.evaluate(()=>nodes[0].studioRhRequest),'different-request');
  await page.evaluate(()=>{canvas=originCanvas;nodes=originNodes;render();});
  // Switching while the save barrier is pending cancels before transport.
  await page.evaluate(()=>{const n=nodes.find(n=>n.id===rhTestId);n.running=false;n.studioRhStatus='succeeded';window.StudioSave={...StudioSave,ensureCurrent:()=>new Promise(resolve=>window.releaseRhSave=resolve)};});
  const delayed=page.evaluate(async()=>await runRhNode(rhTestId));await page.waitForFunction(()=>window.releaseRhSave);const beforeSwitch=submitted.length;
  await page.evaluate(()=>{canvas={id:'switched-before-post'};nodes=[];releaseRhSave({ok:true});});await delayed;assert.equal(submitted.length,beforeSwitch);
  await page.evaluate(()=>{window.StudioSave=originalSave;canvas=originCanvas;nodes=originNodes;render();});
  // Model API uses the durable proxy with the original image payload. Changes
  // during the save barrier cannot change the charged request's fixed inputs.
  await page.evaluate(()=>{
   const n=nodes.find(n=>n.id===rhTestId),provider=apiProviders.find(p=>p.id==='runninghub');provider.image_models=['model-fixture'];
   delete n.studioRhRequest;delete n.studioRhSnapshot;n.running=false;n.studioRhStatus='not_submitted';n.workflowId='';n.webappId='';n.count=2;n.quality='high';n.resolution='custom';n.customSize='1024x1024';n.customWidth=1024;n.customHeight=1024;
   applyRhEntrySelection(n,{kind:'model',id:'model-fixture',entry:{id:'model-fixture'}});
   rhTestMedia={sources:[],refs:[{url:'/static/studio-mark.svg',kind:'image'}],image:[{url:'/static/studio-mark.svg'}],video:[],audio:[],prompt:'模型固定原文'};
   window.releaseRhSave=null;window.StudioSave={...originalSave,ensureCurrent:async args=>{const result=await originalSave.ensureCurrent(args);await new Promise(resolve=>window.releaseRhSave=resolve);return result;}};render();
  });
  const beforeModel=submitted.length,modelPending=page.evaluate(async()=>await runRhModelNode(nodes.find(n=>n.id===rhTestId)));
  await page.waitForFunction(()=>window.releaseRhSave);await page.evaluate(async()=>{const n=nodes.find(n=>n.id===rhTestId);await runRhModelNode(n);n.model='different-model';n.rhModel='different-model';n.count=8;n.quality='low';rhTestMedia.prompt='保存时继续修改';releaseRhSave();});await modelPending;
  assert.equal(submitted.length,beforeModel+1);const modelRequest=submitted.at(-1);assert.equal(modelRequest.kind,'model');assert.equal(modelRequest.payload.model,'model-fixture');assert.equal(modelRequest.payload.prompt,'模型固定原文');assert.equal(modelRequest.payload.quality,'high');assert.equal(modelRequest.payload.count,2);assert.equal(modelRequest.payload.reference_images[0].url,'/static/studio-mark.svg');assert(!('instanceType' in modelRequest.payload));
  await page.evaluate(()=>window.StudioSave=originalSave);
  const modelJob=jobs.get(modelRequest.request_id);modelJob.status='succeeded';modelJob.outputs=[{url:'/static/studio-mark.svg'}];modelJob.children=[{task_id:'model-child-1',status:'succeeded'},{task_id:'model-child-2',status:'succeeded'}];
  await page.evaluate(async()=>await StudioRunningHub.resume(nodes.find(n=>n.id===rhTestId)));await page.evaluate(async()=>await StudioRunningHub.resume(nodes.find(n=>n.id===rhTestId)));
  const modelOutputs=await page.evaluate(()=>{const n=nodes.find(n=>n.id===rhTestId),out=nodes.find(o=>o.type==='output');return {status:n.studioRhStatus,generated:n.generatedOutputs,urls:outputLightboxItems(out).map(outputUrlValue)};});
  assert.equal(modelOutputs.status,'succeeded');assert.equal(modelOutputs.generated.filter(url=>url==='/static/studio-mark.svg').length,1);assert.equal(modelOutputs.urls.filter(url=>url==='/static/studio-mark.svg').length,1);
  // Model save failure dispatches nothing; lost POST response stays recoverable
  // by its request ID and never repeats the paid/model submission.
  await page.evaluate(()=>{window.StudioSave={...originalSave,ensureCurrent:async()=>{throw Error('模型保存失败');}};});
  const beforeModelFailure=submitted.length;await page.evaluate(async()=>await runRhModelNode(nodes.find(n=>n.id===rhTestId)));assert.equal(submitted.length,beforeModelFailure);assert.equal(await page.evaluate(()=>nodes.find(n=>n.id===rhTestId).studioRhStatus),'not_submitted');
  await page.evaluate(()=>window.StudioSave=originalSave);submitMode='failure';await page.evaluate(async()=>await runRhModelNode(nodes.find(n=>n.id===rhTestId)));const lostModel=submitted.at(-1);assert.equal(lostModel.kind,'model');submitMode='ok';jobs.set(lostModel.request_id,{id:lostModel.request_id,request:lostModel,task_id:'model-lost-child',status:'unknown',outputs:[],error:'原模型任务服务已重启，提交待核实。'});
  const beforeModelRecovery=submitted.length;await page.evaluate(async()=>await runRhModelNode(nodes.find(n=>n.id===rhTestId)));assert.equal(submitted.length,beforeModelRecovery);assert.equal(await page.evaluate(()=>nodes.find(n=>n.id===rhTestId).studioRhStatus),'unknown');
  await page.evaluate(async()=>await saveCanvas());await page.reload();await page.locator('#shell:not(.no-canvas) #board').waitFor();await page.waitForFunction(()=>window.StudioRunningHub&&window.StudioSave?.ensureCurrent);await page.evaluate(async id=>await StudioRunningHub.resume(nodes.find(n=>n.id===id)),id);
  assert.equal(submitted.length,beforeModelRecovery);assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).studioRhStatus,id),'unknown');
  assert.equal(await page.evaluate(id=>rhCurrentKind(nodes.find(n=>n.id===id)),id),'model');assert.equal(await page.locator(`[data-id="${id}"] .rh-entry-select`).inputValue(),'model:model-fixture');
  // A saved deletion/undo hold must survive the list-recovery timer on reload.
  await page.evaluate(async id=>{const n=nodes.find(n=>n.id===id);n.studioHistoryRestored=true;n.studioRhStatus='uncertain';n.running=false;n.runError='节点通过撤销恢复，请核实原任务';await saveCanvas();},id);
  jobs.get(lostModel.request_id).status='running';listRecovery=true;
  const beforeHeldQueries=queryRequests.length,beforeHeldSubmits=submitted.length;
  await page.reload();await page.waitForFunction(()=>window.StudioRunningHub&&canvas?.id);await page.waitForTimeout(4300);
  assert.equal(queryRequests.length,beforeHeldQueries,'recovery listing must not start polling held tasks');assert.equal(submitted.length,beforeHeldSubmits);
  assert.deepEqual(await page.evaluate(id=>{const n=nodes.find(n=>n.id===id);return {held:n.studioHistoryRestored,status:n.studioRhStatus};},id),{held:true,status:'uncertain'});
  // Explicit verification rejects a mismatched receipt without releasing the hold.
  const heldJob=jobs.get(lostModel.request_id),originalNode=heldJob.request.node_id;heldJob.request.node_id='unrelated-node';
  await page.evaluate(async id=>await StudioRunningHub.resume(nodes.find(n=>n.id===id)),id);
  assert(await page.evaluate(id=>nodes.find(n=>n.id===id).studioHistoryRestored,id));heldJob.request.node_id=originalNode;
  heldJob.status='succeeded';await page.evaluate(async id=>await StudioRunningHub.resume(nodes.find(n=>n.id===id)),id);
  assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).studioHistoryRestored,id),undefined);assert.equal(submitted.length,beforeHeldSubmits);
  // A deliberate new run uses a new UUID and clears the hold before save/submit.
  await page.evaluate(id=>{const n=nodes.find(n=>n.id===id);n.studioHistoryRestored=true;n.studioRhStatus='succeeded';n.running=false;const p={id:'explicit-held-prompt',type:'prompt',x:40,y:700,text:'恢复后用户明确开始的新镜头'};nodes.push(p);connections.push({id:'explicit-held-input',from:p.id,to:n.id});render();},id);
  assert((await page.evaluate(id=>rhMediaSources(nodes.find(n=>n.id===id)).prompt,id)).includes('恢复后用户明确开始的新镜头'));
  await page.evaluate(async id=>await runRhNode(id),id);assert.equal(submitted.length,beforeHeldSubmits+1,await page.evaluate(id=>nodes.find(n=>n.id===id).runError,id));assert.notEqual(submitted.at(-1).request_id,lostModel.request_id);
  assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).studioHistoryRestored,id),undefined);
  fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'rh-error-1280x800.png')});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(JSON.stringify({ok:true,checks:['本地三类素材与手工媒体上传','imageOrder零排序','手写参数/数值零/64位种子保留','随机种子声明范围步长/零/BigInt/精度错误','工作流显存透传','仅真正缺失图片裁剪','重新生成重置随机值','慢上传中改参数/工作流仍提交原完整快照','上传阶段错误可见与脱敏','保存屏障GET核验后提交','保存失败不创建任务且可重试','提交不确定只查原任务','异步查询目标隔离','保存期间切换取消提交','模型固定快照和双击防重','模型结果原节点与output去重','模型保存失败不提交','模型POST丢失和刷新只查原请求','撤销恢复保存刷新不自动查询或应用远端运行态','显式查询须匹配原任务才能解除暂停','明确新任务清暂停并保存新UUID后仅提交一次'],submitted:submitted.length,artifacts},null,2));
 }finally{await browser?.close();server.kill();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
