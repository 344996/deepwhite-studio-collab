/* Isolated production UI acceptance: all Comfy endpoints are browser mocks, no GPU/API. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-comfy-safety-'));
const evidence=fs.mkdtempSync(path.join(os.tmpdir(),'dw-comfy-evidence-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms)),copy=v=>JSON.parse(JSON.stringify(v));
let child,browser,page,base,serverLog='',checks=0;
const errors=[],writes=[],tasks=new Map(),records=new Map();
let failSave=false,capability=true,failWorkflowOnce=false,holdPost=null,holdPoll=null,holdCanvasRead=null,submitCount=0,pollCount=0;
const stage=label=>{checks++;console.log('PASS '+checks+': '+label);};
const info={
 FixtureText:{input:{required:{text:['STRING',{multiline:true}],steps:['INT',{}],enabled:['BOOLEAN',{}],choice:[[0,false,'one'],{}],seed:['INT',{}]}},output:['IMAGE'],output_names:['image']},
 SaveImage:{input:{required:{images:['IMAGE'],filename_prefix:['STRING',{}]}},output:[]}
};
const graph={'1':{class_type:'FixtureText',inputs:{text:'原始文字',steps:0,enabled:false,choice:0,seed:'18446744073709551615'}},'2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'test'}}};
const outputs=[{node_id:'2',type:'image',name:'图像保存输出'}];
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
async function api(url,body){const r=await fetch(base+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert(r.ok,await r.clone().text());return r.json();}
async function mock(route){
 const req=route.request(),url=new URL(req.url()),p=url.pathname,method=req.method();
 if(url.origin!==base){await route.abort();return;}
 if(p==='/static/fixture-comfy.png'||p==='/api/download-output')return route.fulfill({contentType:'image/png',body:Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex')});
 if(p.startsWith('/api/studio/local-engine'))return route.fulfill({json:{state:'ready',base_url:'http://127.0.0.1:8188',message:'隔离Mock引擎',settings:{directory:'fixture',base_url:'http://127.0.0.1:8188',auto_start:false,start_with_app:false}}});
 if(p.startsWith('/api/canvases/')&&method==='GET'&&holdCanvasRead&&p.endsWith('/'+holdCanvasRead.id)){holdCanvasRead.called=true;await holdCanvasRead.promise;}
 if(p.startsWith('/api/canvases/')&&method==='PUT'&&failSave)return route.fulfill({status:503,json:{detail:'fixture保存拒绝'}});
 if(p.startsWith('/api/studio/runninghub/workflows'))return route.fulfill({json:{items:[]}});
 if(!p.startsWith('/api/studio/comfy')) {
  if(method==='POST'&&/generate|resume|canvas-(?:image|comfy|llm|video)-tasks|canvas-llm|runninghub/.test(p)){errors.push('Unexpected generation request '+p);return route.fulfill({status:503,json:{detail:'Forbidden generation in fixture'}});}
  return route.continue();
 }
 const endpoint=p.slice('/api/studio/comfy'.length),body=method==='GET'?null:req.postDataJSON();
 if(method!=='GET')writes.push({endpoint,body:copy(body)});
 if(endpoint==='/workflow-capabilities')return route.fulfill({status:capability?200:404,json:capability?{schema:1,preview:true,integer_wire:'decimal-string',request_lookup:true}:{detail:'old backend'}});
 if(endpoint==='/object-info')return route.fulfill({json:info});
 if(endpoint==='/workflows'&&method==='GET')return route.fulfill({json:{items:[...records.values()].map(w=>({id:w.id,name:w.name,revision:w.versions.at(-1).revision,fields:w.versions.at(-1).bindings,outputs:w.versions.at(-1).outputs}))}});
 if(endpoint==='/workflows/preview')return route.fulfill({json:{draft:true,name:body.name,versions:[{revision:1,prompt:body.workflow.prompt||body.workflow,bindings:body.bindings||[],outputs}]}});
 if(endpoint==='/workflows/import'){
  const record={id:'wf_'+(records.size+1),name:body.name,versions:[{revision:1,prompt:body.workflow,bindings:body.bindings||[],outputs:body.outputs||outputs}]};
  records.set(record.id,record);return route.fulfill({json:record});
 }
 const byRequest=endpoint.match(/^\/tasks\/by-request\/(.+)$/);
 if(byRequest){const task=[...tasks.values()].find(t=>t.request_id===decodeURIComponent(byRequest[1]));return route.fulfill({status:task?200:404,json:task||{detail:'没有原请求回执'}});}
 const taskMatch=endpoint.match(/^\/tasks\/([^/]+)$/);
 if(taskMatch){pollCount++;if(holdPoll)await holdPoll.promise;const task=tasks.get(taskMatch[1]);return route.fulfill({status:task?200:404,json:task||{detail:'原任务不存在'}});}
 const submit=endpoint.match(/^\/workflows\/([^/]+)\/submit$/);
 if(submit){
  submitCount++;const task={id:'task_'+submitCount,request_id:body.request_id,canvas_id:body.canvas_id,node_id:body.node_id,status:'succeeded',outputs:[{kind:'image',url:base+'/static/fixture-comfy.png',name:'fixture.png'}]};
  tasks.set(task.id,task);if(holdPost)await holdPost.promise;
  return route.fulfill({json:task});
 }
 const item=endpoint.match(/^\/workflows\/([^/]+)$/);
 if(item){
  if(method==='GET'){if(failWorkflowOnce){failWorkflowOnce=false;return route.fulfill({status:503,json:{detail:'fixture版本读取中断'}});}const w=records.get(item[1]);return route.fulfill({status:w?200:404,json:w||{detail:'没有工作流'}});}
  if(method==='PUT'){const w=records.get(item[1]);if(w.versions.at(-1).revision!==body.expected_revision)return route.fulfill({status:409,json:{detail:'版本已更新'}});w.name=body.name;w.versions.push({revision:body.expected_revision+1,prompt:body.prompt,bindings:body.bindings,outputs:body.outputs});return route.fulfill({json:w});}
 }
 return route.fulfill({status:404,json:{detail:'mock route unavailable: '+endpoint}});
}
async function openManager(){await page.getByRole('button',{name:'工作流',exact:true}).click();await page.locator('.studio-workflow-modal[open]').waitFor();}
const modal=()=>page.locator('.studio-workflow-modal[open]');
const nodePanel=()=>page.locator('.studio-workflow-node').first();
async function nodeId(){return page.evaluate(()=>nodes.find(n=>n.studioWorkflowId).id);}

async function settle(){await page.waitForFunction(()=>{const n=nodes.find(n=>n.studioWorkflowId);return n?.studioWorkflowTaskStatus==='succeeded';});await pause(150);}
(async()=>{
 const port=await freePort();base='http://127.0.0.1:'+port;
 child=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/comfy-workflows-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:String(port),DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'},stdio:['ignore','pipe','pipe']});
 console.log('ISOLATED PID '+child.pid+' runtime '+runtime);
 child.stdout.on('data',d=>serverLog+=d);child.stderr.on('data',d=>serverLog+=d);
 let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await pause(200);}}assert(ready,serverLog);
 const project=(await api('/api/projects',{name:'隔离工作台验收'})).project;
 const a=(await api('/api/canvases',{title:'A',kind:'classic',project:project.id})).canvas;
 const b=(await api('/api/canvases',{title:'B',kind:'classic',project:project.id})).canvas;
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,headless:true});
 page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('**/*',mock);
 await page.goto(base+'/static/canvas.html?id='+a.id);await page.waitForFunction(id=>canvas?.id===id&&window.StudioWorkflows,a.id);
 await openManager();assert.equal(await modal().getByLabel('来源筛选').count(),1);stage('真实工作台入口/三阶段，空库可导入');
 await modal().getByLabel('导入工作流',{exact:true}).click();
 const imp=page.locator('.studio-workflow-subdialog[open]').first();
 await imp.getByLabel('工作流 JSON').fill('{bad');await imp.getByRole('button',{name:'导入并预览配置'}).click();assert.match(await imp.locator('[data-error]').innerText(),/无法读取/);stage('非法JSON就地拒绝，无API写库');
 const raw=JSON.stringify(graph).replace('"18446744073709551615"','18446744073709551615');
 await imp.getByLabel('工作流 JSON').fill(raw);await imp.getByLabel('导入工作流名称').fill('精确种子工作流');
 await imp.getByRole('button',{name:'导入并预览配置'}).click();await modal().locator('.sw-field').first().waitFor();
 assert.equal(records.size,0);assert.equal(writes.find(x=>x.endpoint==='/workflows/preview').body.workflow['1'].inputs.seed,'18446744073709551615');stage('预览零写库，导入原整数token精确保真');
 assert.equal(await modal().locator('.sw-field').count(),6);assert.equal(await modal().locator('.sw-field[data-key="2:images"]').count(),0);stage('普通输入识别，连线不暴露为字段');
 const rows=modal().locator('.sw-field');for(let i=0;i<await rows.count();i++)await rows.nth(i).locator('[data-enabled]').check();
 assert.equal(await modal().locator('.sw-field[data-key="1:seed"] [data-default]').inputValue(),'18446744073709551615');
 await modal().getByRole('button',{name:'保存新版本',exact:true}).click();await modal().getByText(/已保存版本 1/).waitFor();
 const wf=records.get('wf_1');assert.equal(wf.versions[0].bindings.find(f=>f.input==='seed').default,'18446744073709551615');assert.equal(wf.versions[0].bindings.find(f=>f.input==='steps').default,0);assert.equal(wf.versions[0].bindings.find(f=>f.input==='enabled').default,false);assert.equal(wf.versions[0].bindings.find(f=>f.input==='choice').default,0);stage('显式保存，seed字符串/0/false/数字枚举不变');
 for(const size of [{width:1280,height:800},{width:1500,height:900}]){
  await page.setViewportSize(size);await pause(100);
  const bounds=await modal().evaluate(el=>({w:el.scrollWidth,c:el.clientWidth,r:el.getBoundingClientRect().toJSON()}));assert(bounds.w<=bounds.c+1);assert(bounds.r.right<=size.width&&bounds.r.bottom<=size.height);
  await page.screenshot({path:path.join(evidence,'workbench-'+size.width+'.png')});
 }
 stage('两尺寸工作台无横向溢出，完整保存/添加按钮');
 await modal().getByRole('button',{name:'添加画布节点',exact:true}).click();await page.waitForFunction(()=>nodes.some(n=>n.studioWorkflowId));
 const id=await nodeId();assert.equal(await page.evaluate(()=>nodes.find(n=>n.studioWorkflowId).studioWorkflowRevision),1);stage('添加固定版本节点，不提交生成');
 await openManager();await modal().getByLabel('工作流名称',{exact:true}).fill('未保存标题');await modal().getByLabel('关闭工作流工作台').click();
 await page.getByRole('button',{name:'保留草稿',exact:true}).click();await page.reload();await page.waitForFunction(()=>window.StudioWorkflows&&canvas?.id);await openManager();
 assert.equal(await modal().getByLabel('工作流名称',{exact:true}).inputValue(),'未保存标题');assert(await modal().getByRole('button',{name:'保存后添加'}).isDisabled());stage('关闭保留草稿/刷新恢复，草稿不可悄悄添加旧版');
 await modal().getByRole('button',{name:'保存新版本',exact:true}).click();await modal().getByText(/已保存版本 2/).waitFor();assert.equal(await page.evaluate(()=>nodes.find(n=>n.studioWorkflowId).studioWorkflowRevision),1);stage('新版本保存不修改旧节点');
 await modal().getByLabel('关闭工作流工作台').click();
 await page.evaluate(()=>fitAllNodesViewport());await nodePanel().waitFor();
 failSave=true;const before=submitCount;
 await page.evaluate(id=>window.runComfyNode(id).catch(()=>{}),id);
 assert.equal(submitCount,before);assert.match(await nodePanel().locator('[data-state]').innerText(),/保存/);stage('保存失败零生成POST，节点可见原因');
 failSave=false;await page.evaluate(()=>saveCanvas());
 assert.equal(await page.evaluate(()=>nodes.find(n=>n.studioWorkflowId).studioWorkflowTaskStatus),'failed');
 await nodePanel().locator('[data-submit]').click();await settle();
 assert.equal(submitCount,before+1);assert.equal(tasks.get('task_'+submitCount).node_id,id);
 assert.equal(await page.evaluate(()=>nodes.find(n=>n.type==='output').images.length),1);stage('已知未提交的保存失败可正常重试：保存/回读后才POST，结果写固定输出');
 const saved=await api('/api/canvases/'+a.id);assert(saved.canvas.nodes.find(n=>n.id===id).studioWorkflowSubmission.request.request_id);stage('任务UUID/冻结快照及回执持久回读');
 const p0=pollCount;await page.evaluate(()=>{render();render();render();});await pause(350);assert.equal(pollCount,p0);stage('终态重复render不重复轮询');
 // Legacy receipt compatibility: real stored node, no invented original request snapshot.

 await page.evaluate(id=>{const n=nodes.find(n=>n.id===id);delete n.studioWorkflowSubmission;n.studioWorkflowTaskStatus='paused';n.studioHistoryRestored=true;render();},id);
 const heldPolls=pollCount;await pause(350);assert.equal(pollCount,heldPolls);stage('历史恢复hold不自动查询');
 await nodePanel().locator('[data-submit]').click();await settle();assert.equal(submitCount,before+1);assert.equal(await page.evaluate(id=>Boolean(nodes.find(n=>n.id===id).studioHistoryRestored),id),false);stage('旧格式无submission查询原ID零POST，核实后解除hold');
 // Keep a successful POST in-flight and navigate through the actual native openCanvas.
 holdPost=gate();await nodePanel().locator('[data-new]').click();
 await page.waitForFunction(()=>nodes.find(n=>n.studioWorkflowId)?.studioWorkflowTaskStatus==='submitting');while(submitCount<before+2)await pause(30);
 const oldRequest=await page.evaluate(id=>nodes.find(n=>n.id===id).studioWorkflowRequestId,id);
 await page.evaluate(id=>openCanvas(id),b.id);holdPost.resolve();holdPost=null;await pause(200);
 assert.equal(await page.evaluate(()=>nodes.some(n=>n.studioWorkflowTaskId)),false);stage('等待提交回执切画布，晚回复不污染新画布');
 await page.evaluate(id=>openCanvas(id),a.id);await nodePanel().waitFor();const count=submitCount;
 await nodePanel().locator('[data-submit]').click();await settle();assert.equal(submitCount,count);assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).studioWorkflowRequestId,id),oldRequest);stage('丢回执按原UUID账本恢复，不再POST');
 // A detached output must not be replaced at completion; mutate only isolated fixture graph.
 holdPoll=gate();await nodePanel().locator('[data-new]').click();while(submitCount<count+1)await pause(20);await pause(50);
 await page.evaluate(id=>{const n=nodes.find(n=>n.id===id),out=nodes.find(candidate=>candidate.id===n.studioWorkflowSubmission.output.id);nodes=nodes.filter(x=>x!==out);connections=connections.filter(c=>c.to!==out.id);const replacement={id:'replacement',type:'output',x:850,y:200,images:[]};nodes.push(replacement);connections.push({id:'rewire',from:id,to:replacement.id});render();},id);
 holdPoll.resolve();holdPoll=null;await settle();
 assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='replacement').images.length),0);assert.match(await nodePanel().locator('[data-state]').innerText(),/原输出槽已改变/);stage('删除/重连输出槽，旧结果仅链接取回不串写');
 // Rejected Promise cache must be evicted. New revision avoids the already warm cache.
 const latest=records.get('wf_1');latest.versions.at(-1).bindings.find(f=>f.input==='steps').required=false;latest.versions.at(-1).bindings.find(f=>f.input==='steps').min=0;latest.versions.at(-1).bindings.find(f=>f.input==='steps').max=60;latest.versions.at(-1).bindings.find(f=>f.input==='steps').step=2;latest.versions.push({...copy(latest.versions.at(-1)),revision:3});
 failWorkflowOnce=true;await page.evaluate(id=>{nodes.find(n=>n.id===id).studioWorkflowRevision=3;render();},id);
 await nodePanel().getByRole('button',{name:'重新读取版本'}).waitFor();await nodePanel().getByRole('button',{name:'重新读取版本'}).click();await nodePanel().getByLabel('随机种子').waitFor();stage('暂时503不会永久缓存失败，可重新读取固定版本');
 // One owner/poll chain, including external invocation while a real button starts the task.
 holdPoll=gate();const singleBefore=submitCount,singlePoll=pollCount;
 await nodePanel().locator('[data-new]').click();
 while(submitCount===singleBefore||pollCount===singlePoll)await pause(20);
 await page.evaluate(id=>{window._fixtureFlights=[runComfyNode(id).catch(()=>{}),runComfyNode(id).catch(()=>{})];render();render();},id);
 await pause(100);assert.equal(submitCount,singleBefore+1);assert.equal(pollCount,singlePoll+1);
 const wrong=tasks.get('task_'+submitCount);wrong.request_id='wrong_request';wrong.revision=999;
 holdPoll.resolve();holdPoll=null;
 await page.waitForFunction(id=>nodes.find(n=>n.id===id).studioWorkflowTaskStatus==='paused',id);
 assert.match(await nodePanel().locator('[data-state]').innerText(),/任务回执.*不匹配/);
 stage('singleflight/重复render只有单轮询；同节点错误request/revision拒绝写回');
 // Hold only StudioSave's readback, then perform an actual native canvas navigation.
 holdCanvasRead=gate();holdCanvasRead.id=a.id;const switchBefore=submitCount;
 await nodePanel().locator('[data-new]').click();while(!holdCanvasRead.called)await pause(20);
 await page.evaluate(id=>openCanvas(id),b.id);
 holdCanvasRead.resolve();holdCanvasRead=null;await pause(180);
 assert.equal(submitCount,switchBefore);assert.equal(await page.evaluate(()=>nodes.length),0);
 stage('保存核对等待中切画布，原节点不POST且新画布不受影响');
 await page.evaluate(id=>openCanvas(id),a.id);await nodePanel().waitFor();
 // A real AbortController timeout releases the query lock. Shorten only its fixture timeout.
 const timed={id:'timeout_task',request_id:await page.evaluate(id=>nodes.find(n=>n.id===id).studioWorkflowRequestId,id),canvas_id:a.id,node_id:id,status:'running',outputs:[]};
 tasks.set(timed.id,timed);holdPoll=gate();
 await page.evaluate(({id,task})=>{const n=nodes.find(n=>n.id===id);n.studioWorkflowTaskId=task;n.studioWorkflowTaskStatus='paused';window._fixtureSetTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>window._fixtureSetTimeout(fn,ms===20000?100:ms,...args);render();},{id,task:timed.id});
 await nodePanel().locator('[data-submit]').click();
 await page.waitForFunction(id=>nodes.find(n=>n.id===id).studioWorkflowError?.includes('超时'),id);
 assert(await nodePanel().locator('[data-submit]').isEnabled());
 holdPoll.resolve();holdPoll=null;await page.evaluate(()=>{window.setTimeout=window._fixtureSetTimeout;delete window._fixtureSetTimeout;});
 stage('查询网络超时可见/释放锁，保留原ID且不重提');

 // Existing ledger unknown: explicit lookup preserves UUID and never creates a task.
 await page.evaluate(id=>{const n=nodes.find(n=>n.id===id);n.studioWorkflowTaskId='';n.studioWorkflowRequestId='sw_missing';n.studioWorkflowTaskStatus='uncertain';n.studioWorkflowSubmission={request:{request_id:'sw_missing'}};render();},id);
 const lookupBefore=submitCount;await nodePanel().locator('[data-submit]').click();await page.waitForFunction(id=>nodes.find(n=>n.id===id).studioWorkflowError?.includes('尚未找到'),id);assert.equal(submitCount,lookupBefore);stage('原UUID不存在仍待核实，禁止自动重提');
 capability=false;await page.reload();await page.waitForFunction(()=>window.StudioWorkflows&&canvas?.id);await openManager();
 await modal().getByLabel('工作流名称',{exact:true}).fill('旧服务禁止写');const writesBefore=writes.length;await modal().getByRole('button',{name:'保存新版本',exact:true}).click();await modal().getByText(/需要重新启动/).waitFor();assert.equal(writes.length,writesBefore);stage('旧后端缺能力明确提示，零保存/生成POST');
 capability=true;
 // Storage and keyboard checks use independent browser tabs/contexts, never production data.
 const corrupt=await browser.newPage({viewport:{width:1280,height:800}});
 corrupt.on('pageerror',e=>errors.push(e.message));await corrupt.route('**/*',mock);
 await corrupt.addInitScript(()=>sessionStorage.setItem('deepwhite-comfy-workspace-drafts-v1','{broken'));
 await corrupt.goto(base+'/static/canvas.html?id='+a.id);await corrupt.waitForFunction(()=>window.StudioWorkflows&&canvas?.id);
 await corrupt.getByRole('button',{name:'工作流',exact:true}).click();
 const cm=corrupt.locator('.studio-workflow-modal[open]');await cm.getByLabel('工作流名称',{exact:true}).waitFor();
 await cm.getByLabel('工作流名称',{exact:true}).fill('损坏存储下的新草稿');
 assert.match(await cm.locator('[data-storage-warning]').innerText(),/原数据未覆盖/);
 await cm.getByRole('button',{name:'节点预览',exact:false}).click();
 assert.equal(await corrupt.evaluate(()=>sessionStorage.getItem('deepwhite-comfy-workspace-drafts-v1')),'{broken');
 await corrupt.keyboard.press('Escape');await corrupt.getByRole('button',{name:'保留草稿',exact:true}).waitFor();
 await corrupt.keyboard.press('Escape');assert(await cm.isVisible());
 stage('损坏草稿导航不覆盖，Esc取消退出仍保留编辑');
 await cm.getByLabel('关闭工作流工作台').click();await corrupt.getByRole('button',{name:'放弃改动',exact:true}).click();
 await corrupt.getByRole('button',{name:'工作流',exact:true}).click();
 assert.notEqual(await cm.getByLabel('工作流名称',{exact:true}).inputValue(),'损坏存储下的新草稿');
 stage('放弃草稿后再打开不复活已放弃内容');
 await cm.getByRole('button',{name:'导入与配置',exact:false}).click();
 await cm.locator('.sw-field[data-key="1:steps"] [data-label]').fill('新的步数标题');
 await cm.getByRole('button',{name:'保存新版本',exact:true}).click();await cm.getByText(/已保存版本 4/).waitFor();
 const constrained=records.get('wf_1').versions.at(-1).bindings.find(f=>f.input==='steps');assert.deepEqual({required:constrained.required,min:constrained.min,max:constrained.max,step:constrained.step},{required:false,min:0,max:60,step:2});
 stage('只改标签保存新版本仍保留旧required/min/max/step');
 await corrupt.close();
 const quota=await browser.newPage({viewport:{width:1500,height:900}});
 quota.on('pageerror',e=>errors.push(e.message));await quota.route('**/*',mock);
 await quota.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='deepwhite-comfy-workspace-drafts-v1')throw new DOMException('fixture','QuotaExceededError');return original.call(this,key,value);};});
 await quota.goto(base+'/static/canvas.html?id='+a.id);await quota.waitForFunction(()=>window.StudioWorkflows&&canvas?.id);
 await quota.getByRole('button',{name:'工作流',exact:true}).click();
 const qm=quota.locator('.studio-workflow-modal[open]');await qm.getByLabel('工作流名称',{exact:true}).fill('配额失败草稿');
 assert.match(await qm.locator('[data-storage-warning]').innerText(),/未能保存/);
 const download=quota.waitForEvent('download');await qm.getByRole('button',{name:'导出配置草稿'}).click();assert.equal((await download).suggestedFilename(),'comfy-workflow-drafts.json');
 stage('session配额失败固定提示且仍可导出草稿');
 for(const size of [{width:1280,height:800},{width:1500,height:900}]){
  await quota.setViewportSize(size);
  for(const theme of ['graphite','milk','light','dark']){
   await quota.evaluate(value=>{StudioTheme.set(value==='dark'?'dark':'light');const material=['graphite','milk'].includes(value)?value:null;if(material)localStorage.setItem('deepwhite_canvas_material',material);else localStorage.removeItem('deepwhite_canvas_material');window.dispatchEvent(new StorageEvent('storage',{key:'deepwhite_canvas_material',newValue:material}));},theme);
   await qm.locator('.sw-editor-panel').evaluate(el=>el.scrollTop=0);await pause(120);
   const m=await qm.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),button=getComputedStyle(el.querySelector('[data-save]')),input=getComputedStyle(el.querySelector('[data-title]'));return {w:el.scrollWidth,c:el.clientWidth,right:r.right,bottom:r.bottom,bg:s.backgroundColor,ink:s.color,inputBg:input.backgroundColor,inputInk:input.color,buttonBg:button.backgroundColor,gold:getComputedStyle(document.documentElement).getPropertyValue('--dw-gold').trim()};});
   assert(m.w<=m.c+1&&m.right<=size.width&&m.bottom<=size.height);assert(m.bg!==m.ink&&m.inputBg!==m.inputInk);assert(m.gold);
   await quota.screenshot({path:path.join(evidence,'workbench-'+theme+'-'+size.width+'.png')});
  }
 }
 stage('四主题实切/两尺寸顶部配置和按钮可见，无横向溢出');
 await quota.emulateMedia({reducedMotion:'reduce'});assert.equal(await qm.locator('[data-save]').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
 stage('减少动效不影响控件');
 await quota.close();
 const smartCanvas=(await api('/api/canvases',{title:'Smart 管理',kind:'smart',project:project.id})).canvas;
 const smart=await browser.newPage({viewport:{width:1280,height:800}});smart.on('pageerror',e=>errors.push(e.message));await smart.route('**/*',mock);
 await smart.goto(base+'/static/smart-canvas.html?id='+smartCanvas.id);await smart.waitForFunction(()=>window.StudioWorkflows&&canvas?.id);
 await smart.getByRole('button',{name:'工作流',exact:true}).click();const sm=smart.locator('.studio-workflow-modal[open]');await sm.getByLabel('工作流名称',{exact:true}).waitFor();
 assert(await sm.getByRole('button',{name:'添加画布节点',exact:true}).isDisabled());assert.match(await sm.locator('[data-add-note]').innerText(),/经典画布/);
 stage('Smart真实入口可管理/预览，未支持节点创建明确受限');
 await smart.close();

 assert.deepEqual(errors,[]);stage('无pageerror，所有生成端点仅Mock');
 console.log(JSON.stringify({checks,evidence,submitCount,pollCount,externalRequests:'blocked',runtimeCleanup:true},null,2));
})().catch(async e=>{console.error(e);if(page)try{await page.screenshot({path:path.join(evidence,'failure.png')});}catch{}console.error('Evidence: '+evidence);console.error(serverLog.slice(-4000));process.exitCode=1;}).finally(async()=>{
 if(browser)await browser.close();
 if(child){const stopped=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([stopped,pause(5000)]);if(child.exitCode===null&&child.pid){try{process.kill(child.pid);}catch{}await Promise.race([stopped,pause(3000)]);}}
 const resolved=path.resolve(runtime),temp=path.resolve(os.tmpdir());if(path.dirname(resolved)===temp&&path.basename(resolved).startsWith('dw-comfy-safety-')&&(!child||child.exitCode!==null))fs.rmSync(resolved,{recursive:true,force:true});
});
