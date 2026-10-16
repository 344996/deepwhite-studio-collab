/* Real classic/smart pages and local RH library; all generation traffic mocked. */
const {chromium}=require('data/local-path');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-rh-workbench-'));
let child,browser,base,log='',passed=0;const errors=[],submitted=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),pass=text=>{passed++;console.log('PASS '+text);};
const definition={kind:'workflow',target_id:'12345678',entry:{id:'12345678',title:'RH 固定版本',optionalImageMode:'keep-workflow',fields:[
  {nodeId:'1',fieldName:'seed',fieldType:'INT',label:'随机种子',fieldValue:'18446744073709551615',enabled:true,sourceFromUpstream:false},
  {nodeId:'1',fieldName:'steps',fieldType:'INT',label:'采样步数',fieldValue:0,enabled:true},
  {nodeId:'1',fieldName:'flag',fieldType:'BOOLEAN',label:'开关',fieldValue:false,enabled:true},
  {nodeId:'1',fieldName:'choice',fieldType:'SELECT',label:'选项',fieldValue:'one',options:['one','two'],enabled:true}],
  workflowJson:{'1':{class_type:'Fixture',inputs:{seed:'18446744073709551615',steps:0,flag:false,choice:'one'}}}}};
async function api(url,body,method='POST'){
  const response=await fetch(base+url,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  assert(response.ok,await response.clone().text());return response.json();
}
(async()=>{
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 base='http://127.0.0.1:'+port;
 child=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/comfy-workflows-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await pause(200);}}assert(ready,log);
 browser=await chromium.launch({executablePath:'data/local-path',headless:true});
 const context=await browser.newContext({viewport:{width:1500,height:900}});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==base)return route.abort();
  if(url.pathname==='/api/studio/runninghub/tasks'&&req.method()==='POST'){
   const request=req.postDataJSON();submitted.push(request);return route.fulfill({json:{id:request.request_id,request,status:'failed',error:'隔离测试终态，不访问上游',outputs:[]}});
  }
  if(/\/api\/(?:runninghub\/(?:create|workflow-submit|submit|upload)|canvas-.*-tasks|studio\/generations)/.test(url.pathname)&&req.method()==='POST')return route.fulfill({status:503,json:{detail:'test blocks generation'}});
  return route.continue();
 });
 const project=(await api('/api/projects',{name:'RH 工作台隔离验证'})).project;
 const classic=(await api('/api/canvases',{title:'RH 经典画布',kind:'classic',project:project.id})).canvas;
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/static/canvas.html?id='+classic.id);await page.waitForFunction(()=>typeof nodes!=='undefined'&&window.StudioRhWorkflows&&window.StudioSave);
 await page.evaluate(()=>StudioWorkflows.open());const modal=page.locator('.studio-workflow-modal');await modal.waitFor();
 await modal.locator('[data-import-open]').click();const dialog=page.locator('.studio-workflow-subdialog[open]');
 await dialog.locator('[data-import-provider]').selectOption('runninghub');await dialog.locator('[data-kind]').selectOption('workflow');
 await dialog.locator('[data-json]').fill(JSON.stringify({definition}));await dialog.locator('[data-name]').fill('RH 固定版本');await dialog.locator('[data-import]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-import-provider]').closest('dialog').open);
 const keep=page.locator('.studio-workflow-subdialog[open] [data-keep]');if(await keep.isVisible())await keep.click();
 await page.waitForFunction(()=>document.querySelector('[data-heading]')?.textContent==='RH 固定版本'&&document.querySelectorAll('.studio-workflow-modal .sw-field').length===4);
 assert.deepEqual((await api('/api/studio/runninghub/workflows')).items,[]);assert.equal(submitted.length,0);pass('shared UI RH preview makes no library or task');
 assert.equal(await modal.locator('.sw-field').nth(0).locator('.sw-default input').inputValue(),'18446744073709551615');
 assert.equal(await modal.locator('.sw-field').nth(1).locator('.sw-default input').inputValue(),'0');
 assert.equal(await modal.locator('.sw-field').nth(2).locator('.sw-default input').isChecked(),false);
 await modal.locator('[data-save]').click();await page.waitForFunction(()=>document.querySelector('[data-version]')?.textContent.includes('当前 v1'));
 let record=(await api('/api/studio/runninghub/workflows')).items[0];assert.equal(record.revision,1);
 assert.equal(record.fields[0].fieldValue,'18446744073709551615');assert.equal(record.fields[1].fieldValue,0);assert.equal(record.fields[2].fieldValue,false);pass('explicit RH save preserves exact seed, zero and false');
 await page.screenshot({path:path.join(runtime,'rh-config-1500.png')});await page.setViewportSize({width:1280,height:800});await page.screenshot({path:path.join(runtime,'rh-config-1280.png')});
 await modal.locator('[data-add]').click();await page.waitForFunction(()=>nodes.some(n=>n.studioRhWorkflow?.revision===1));
 const nodeId=await page.evaluate(()=>nodes.find(n=>n.studioRhWorkflow).id);
 const savedCanvas=await api('/api/canvases/'+classic.id);assert(JSON.stringify(savedCanvas).includes('18446744073709551615'));assert.equal(submitted.length,0);pass('add saves pinned classic node without generation');
 const changed=structuredClone(definition);changed.entry.fields[1].fieldValue=25;changed.entry.workflowJson['1'].inputs.steps=25;
 record=await api('/api/studio/runninghub/workflows/'+record.id,{name:'RH 新版本',expected_revision:1,definition:changed},'PUT');assert.equal(record.revision,2);
 const outgoing=await page.evaluate(async id=>{const n=nodes.find(n=>n.id===id),media=rhMediaSources(n),fields=await rhBuildNodeInfoList(n,media);return {fields,extras:await rhBuildWorkflowRequestExtras(n,media,fields),revision:n.studioRhWorkflow.revision};},nodeId);
 assert.equal(outgoing.revision,1);assert.equal(outgoing.extras.workflow['1'].inputs.steps,0);assert.equal(outgoing.fields.find(f=>f.fieldName==='seed').fieldValue,'18446744073709551615');pass('new library version cannot rewrite saved node or pinned full graph');
 await page.evaluate(id=>runRhNode(id),nodeId);assert.equal(submitted.length,1);assert.equal(submitted[0].payload.workflow['1'].inputs.steps,0);
 assert.equal(submitted[0].payload.nodeInfoList.find(f=>f.fieldName==='seed').fieldValue,'18446744073709551615');pass('native durable RH submit receives pinned graph and exact parameters');
 await page.evaluate(id=>StudioSave.ensureCurrent({canvasId:String(canvas.id),nodeId:id}),nodeId);
 await page.reload();await page.waitForFunction(()=>typeof nodes!=='undefined'&&nodes.some(n=>n.studioRhWorkflow));
 assert.equal(await page.evaluate(()=>nodes.find(n=>n.studioRhWorkflow).studioRhWorkflow.revision),1);assert.equal(submitted.length,1);pass('reload keeps original version and does not repeat submission');
 // Version defaults are independent from native runtime/task receipts.
 const before=await page.evaluate(()=>nodes.length);
 const blocked=await page.evaluate(async()=>{const id=nodes.find(n=>n.studioRhWorkflow).id,old=window.StudioSave;window.StudioSave={...old,ensureCurrent:async()=>{throw Error('mock save refused');}};try{await runRhNode(id);return nodes.find(n=>n.id===id).studioRhStatus;}finally{window.StudioSave=old;}});
 assert.equal(blocked,'not_submitted');assert.equal(submitted.length,1);assert.equal(await page.evaluate(()=>nodes.length),before);pass('failed canvas save prevents native RH dispatch');
 const smart=(await api('/api/canvases',{title:'RH 智能画布',kind:'smart',project:project.id})).canvas;
 await page.goto(base+'/static/smart-canvas.html?id='+smart.id);await page.waitForFunction(()=>window.StudioRhWorkflows&&window.StudioWorkflows);
 const smartResult=await page.evaluate(async id=>{const adapter=StudioRhWorkflows.adapter,items=await adapter.list();try{await adapter.createNode({id},1);return {items:items.items.length,error:''};}catch(e){return {items:items.items.length,error:e.message};}},record.id);
 assert(smartResult.items>=1);assert.match(smartResult.error,/经典画布/);assert.equal(submitted.length,1);pass('smart canvas reads library and clearly rejects unsupported node creation');
 assert.deepEqual(errors,[]);console.log('PASS '+passed+' RH browser groups; screenshots: '+runtime);
})().catch(e=>{console.error(e);if(log)console.error(log.slice(-3500));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(2500)]);}});
