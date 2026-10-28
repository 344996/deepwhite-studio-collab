'use strict';
// Real local engines and persistence; synthetic data, blocked paid/remote requests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-1020-ui-'));
const evidence=path.resolve(process.env.UI_1020_EVIDENCE||path.join(root,'test-output/feedback-1020'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),checks=[],errors=[],external=[],paid=[];
let server,browser,page,base,log='';
fs.mkdirSync(evidence,{recursive:true});
async function api(url,method='GET',body){const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(response.ok,await response.clone().text());return response.json();}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#28363b"/><circle cx="490" cy="85" r="38" fill="#e8dcb6"/><path d="M0 330 160 120 360 300 500 190 640 350v10H0" fill="#66786a"/></svg>');
async function fixture(kind){
 const data=(await api('/api/canvases','POST',{kind,title:'1020 isolated '+kind})).canvas;
 const nodes=kind==='classic'?[{id:'generate',type:'generator',x:180,y:160,w:600,apiProvider:'offline',model:'deepwhiteai-image-g2',studioPrompt:'山间月色，远处层叠的树林，电影感画面',generatedOutputs:[{url:image,kind:'image'}]},{id:'text',type:'prompt',x:950,y:180,w:280,h:230,text:'参考提示词'}]:[{id:'generate',type:'smart-image',x:180,y:160,title:'图片创作',images:[{url:image,kind:'image'}],promptDraft:'山间月色，电影感画面',runSettings:{engine:'api',provider_id:'offline',model:'deepwhiteai-image-g2'}},{id:'text',type:'smart-prompt',x:850,y:160,w:316,h:240,title:'文本',text:'参考提示词',llmEnabled:false}];
 await api('/api/canvases/'+data.id,'PUT',{...data,base_updated_at:data.updated_at,nodes,connections:[],viewport:{x:0,y:0,scale:1}});
 await page.goto(base+'/static/'+(kind==='smart'?'smart-':'')+'canvas.html?id='+data.id);
 await page.waitForFunction(id=>canvas?.id===id&&window.StudioNodeComposer?.ready&&nodes.length===2,data.id);
 await pause(200);return data.id;
}
(async()=>{
 const port=await new Promise(resolve=>{const socket=net.createServer().listen(0,'127.0.0.1',()=>{const value=socket.address().port;socket.close(()=>resolve(value));});});base='http://127.0.0.1:'+port;
 server=spawn(process.env.PYTHON_EXECUTABLE||'python',['-B','tests/catalog-browser-server.py'],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});
 server.stdout.on('data',value=>log+=value);server.stderr.on('data',value=>log+=value);
 for(let i=0;i<140;i++){try{await api('/api/studio/health');break;}catch{await pause(150);}}
 await api('/api/studio/settings/sync-models','POST',{id:'offline',name:'测试官方渠道',base_url:'https://api.deepwhiteai.com/v1',api_key:'offline-ui-fixture',enabled:true,primary:true});
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{channel:'msedge'})});
 const context=await browser.newContext({viewport:{width:1500,height:1000},reducedMotion:'reduce'});
 await context.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==base&&!url.protocol.startsWith('data')){external.push(url.origin);return route.abort();}
  if(request.method()==='POST'&&/\/api\/(?:studio\/generations|generate|canvas-(?:image|comfy|video|llm)|studio\/mj\/submit)/.test(url.pathname)){paid.push(url.pathname);return route.fulfill({status:503,json:{detail:'Paid generation disabled in UI verification'}});}return route.continue();});
 page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 const id=await fixture('classic');
 await check('classic: media preview precedes native prompt and parameters; no fixed inspector',async()=>{
  await page.locator('[data-id="generate"] .node-head').click({position:{x:90,y:12}});
  assert.equal(await page.locator('#workspaceInspector,#workspaceInspectorToggle').count(),0);
  const stage=await page.locator('[data-id="generate"] .studio-node-media').boundingBox(),input=await page.locator('[data-id="generate"] .studio-prompt-input').boundingBox();
  assert(stage.y+stage.height<=input.y,'media above prompt');
  assert(await page.locator('[data-id="generate"] .studio-image-footer .studio-model-trigger').isVisible());
  assert.equal(await page.locator('[data-id="generate"] .studio-node-media img').count(),1);
  assert.equal(await page.locator('#studioAgentPanel,#studioAgentToggle').count(),0);
  await page.screenshot({path:path.join(evidence,'classic-node.png')});
 });
 await check('classic: prompt editing saves, undo/redo works and text wheel does not zoom',async()=>{
  const input=page.locator('[data-id="generate"] .studio-prompt-input');await input.fill('山谷中的月光和树林，细节清晰，柔和光线');
  await page.locator('[data-id="generate"] .node-head').click({position:{x:90,y:12}});
  await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='generate').studioPrompt),'山间月色，远处层叠的树林，电影感画面');
  await page.keyboard.press('Control+Shift+z');assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='generate').studioPrompt),'山谷中的月光和树林，细节清晰，柔和光线');
  await input.hover();const scale=await page.evaluate(()=>viewport.scale);await page.mouse.wheel(0,100);assert.equal(await page.evaluate(()=>viewport.scale),scale);
  await page.evaluate(()=>saveCanvas());assert.equal((await api('/api/canvases/'+id)).canvas.nodes.find(n=>n.id==='generate').studioPrompt,'山谷中的月光和树林，细节清晰，柔和光线');
 });
 await check('classic: native model popup, parameters and generation count remain editable',async()=>{
  await page.locator('[data-id="generate"] .studio-model-trigger').click();await page.locator('#studioModelPicker:popover-open').waitFor();
  assert((await page.locator('#studioModelPicker .studio-picker-option').count())>0);await page.keyboard.press('Escape');
  await page.locator('[data-id="generate"] .studio-image-settings').click();await page.locator('.studio-image-settings-popup:popover-open').waitFor();
  const choices=page.locator('.studio-image-settings-popup:popover-open .studio-param-choices button');assert((await choices.count())>1);await choices.nth(1).click();await page.keyboard.press('Escape');
  await page.locator('[data-id="generate"] select[aria-label="生成张数"]').selectOption('2');assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='generate').count),2);
 });
 await check('classic: node drag, port connect and saved reload retain graph',async()=>{
  const head=await page.locator('[data-id="generate"] .node-head').boundingBox();const before=await page.evaluate(()=>nodes.find(n=>n.id==='generate').x);
  await page.mouse.move(head.x+120,head.y+12);await page.mouse.down();await page.mouse.move(head.x+150,head.y+32,{steps:5});await page.mouse.up();assert(Math.abs((await page.evaluate(()=>nodes.find(n=>n.id==='generate').x))-before-30)<=10,'native drag retains grid snapping');
  const point=async locator=>{const r=await locator.boundingBox();return {x:r.x+r.width/2,y:r.y+r.height/2};};
  const from=await point(page.locator('[data-id="text"] .port.out')),to=await point(page.locator('[data-id="generate"] .port.in'));
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:12});await page.mouse.up();assert.equal(await page.evaluate(()=>connections.length),1);
  await page.evaluate(()=>saveCanvas());await page.reload();await page.waitForFunction(()=>window.StudioNodeComposer?.ready&&nodes.length===2);
  assert.equal(await page.evaluate(()=>connections.length),1);assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='generate').count),2);
 });
 const jobs=[{id:'image-job',status:'succeeded',created_at:Date.now()/1000,request:{provider_id:'offline',node_id:'history-only',kind:'image',model:'deepwhiteai-image-g2',prompt:'月光下的山谷',params:{ratio:'16:9'},references:[],count:1},resolved_model:'全能图片 G2',outputs:[{url:image,kind:'image'}],children:[{usage:{amount:.142,currency:'CNY'}}],task_ids:['synthetic-image']},{id:'failed-job',status:'failed',created_at:Date.now()/1000-60,request:{provider_id:'offline',node_id:'history-only-failed',kind:'image',model:'deepwhiteai-image-g2',prompt:'123',params:{},references:[],count:1},resolved_model:'全能图片 G2',outputs:[],children:[],task_ids:[],error:'API 返回 400: prompt length must be between 5 and 2000 characters'}];
 await page.route('**/api/studio/generations?*',route=>route.fulfill({json:{items:jobs}}));
 await check('history: preview grid, status/query filters, readable error and honest unknown fee',async()=>{
  await page.locator('.studio-history-button').click();await page.locator('.studio-history-v3 article').first().waitFor();
  assert.equal(await page.locator('.studio-history-v3 article').count(),2);
  assert((await page.locator('[data-job-id="failed-job"] .studio-history-error').textContent()).includes('5–2000'));
  /* an unknown fee says so and is never shown as 0 (wording since 1bb75c4) */assert(/待对账.*不是 0 元/.test(await page.locator('[data-job-id="failed-job"] .studio-history-bill').textContent()));
  await page.locator('[data-history-status]').selectOption('failed');assert.equal(await page.locator('.studio-history-v3 article:visible').count(),1);
  await page.locator('[data-history-status]').selectOption('');await page.locator('[data-history-search]').fill('月光');assert.equal(await page.locator('.studio-history-v3 article:visible').count(),1);
  await page.locator('[data-history-search]').fill('');await page.screenshot({path:path.join(evidence,'generation-history.png')});
  await page.locator('[data-job-id="image-job"] .studio-history-preview-button').click();await page.locator('.studio-media-preview-dialog').waitFor();await page.getByRole('button',{name:'关闭预览',exact:true}).click();
  const count=await page.evaluate(()=>nodes.length);await page.locator('[data-job-id="image-job"]').getByRole('button',{name:'复用这次设置',exact:true}).click();assert.equal(await page.evaluate(()=>nodes.length),count+1);assert.equal(await page.evaluate(()=>nodes.at(-1).studioPrompt),'月光下的山谷');
 });
 await check('settings: left categories preserve edits, model native controls, storage and feedback',async()=>{
  await page.goto(base+'/static/studio-settings.html');await page.waitForFunction(()=>window.StudioSettingsNavigation&&document.getElementById('apiForm').inert===false);
  assert.equal(await page.locator('[data-tab][aria-selected=true]').textContent(),'账户与 API');assert(await page.locator('#modelManager').isHidden());
  await page.locator('#providerName').fill('未保存的测试名称');await page.locator('[data-tab="models"]').click();assert(await page.locator('#modelManager').isVisible());assert(await page.locator('#baseUrl').isHidden());
  await page.locator('[data-tab="api"]').click();assert.equal(await page.locator('#providerName').inputValue(),'未保存的测试名称');
  for(const tab of ['general','control','comfy','storage','feedback','dreamina']){await page.locator(`[data-tab="${tab}"]`).click();await page.waitForFunction(value=>document.documentElement.dataset.settingsTab===value,tab);assert(await page.locator('#'+tab+'Panel').isVisible());assert.equal(await page.locator('main>section:visible').count(),1);}
  await page.locator('[data-tab="storage"]').click();assert(await page.locator('#studioProjectStorage').isVisible());
  await page.locator('[data-tab="api"]').click();await page.screenshot({path:path.join(evidence,'settings-sidebar.png')});
  for(const width of [768,390,320]){await page.setViewportSize({width,height:900});await page.locator('[data-tab="api"]').click();const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<2,'settings no horizontal page overflow at '+width+': '+overflow);}
  await page.setViewportSize({width:1500,height:1000});
 });
 // Dismiss unsaved-settings navigation dialog: disposable fixture only.
 page.on('dialog',dialog=>dialog.accept());
 await fixture('smart');
 await check('smart: no inspector and native composer/selection remain available',async()=>{
  await page.locator('.image-node[data-id="generate"]').click({position:{x:100,y:30}});await page.locator('#composer.open').waitFor();
  assert.equal(await page.locator('#workspaceInspector,#workspaceInspectorToggle').count(),0);
  assert(await page.locator('#promptInput').isVisible());assert(await page.locator('#dynamicParams').isVisible());
  await page.screenshot({path:path.join(evidence,'smart-node.png')});
 });
 await check('smart history: thumbnails, search/status filters and prompt reuse',async()=>{
  await page.evaluate(image=>{canvas.logs=[{id:'smart-history',status:'success',createdAt:Date.now(),model:'测试模型',prompt:'用于复用的提示词',outputs:[{url:image,kind:'image'}],request:{provider_id:'offline',model:'deepwhiteai-image-g2'}}];},image);
  await page.locator('#smartLogToggle').click();assert.equal(await page.locator('.studio-smart-history .log-item:visible').count(),1);
  await page.locator('.studio-smart-history-filters input').fill('不存在');assert.equal(await page.locator('.studio-smart-history .log-item:visible').count(),0);
  await page.locator('.studio-smart-history-filters input').fill('');const count=await page.evaluate(()=>nodes.length);await page.locator('.studio-smart-history').getByRole('button',{name:'复用提示词',exact:true}).click();
  assert.equal(await page.evaluate(()=>nodes.length),count+1);assert.equal(await page.evaluate(()=>nodes.at(-1).text),'用于复用的提示词');
 });
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(paid,[]);
 fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({passed:true,checks,errors,external,paid},null,2));console.log(JSON.stringify({passed:checks.length,evidence}));
})().catch(async error=>{console.error(error.stack);console.error(log.slice(-2500));process.exitCode=1;if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({passed:false,checks,errors,external,paid,error:String(error)},null,2));}).finally(async()=>{
 await browser?.close();if(server){server.kill();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),pause(4000)]);}
 assert(path.dirname(runtime)===os.tmpdir()&&path.basename(runtime).startsWith('dw-1020-ui-'));fs.rmSync(runtime,{recursive:true,force:true});
});
