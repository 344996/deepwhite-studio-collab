'use strict';
// Production canvas with isolated local data; no upstream generation or real account.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path');
const executablePath=process.env.CHROMIUM_EXECUTABLE||'data/local-path';
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-content-library-'));
const artifacts=path.join(os.tmpdir(),'deepwhite-content-library-compatibility');fs.mkdirSync(artifacts,{recursive:true});
const catalogPath=path.join(root,'static/fisher-library/catalog.json'),catalogBytes=fs.readFileSync(catalogPath),catalog=JSON.parse(catalogBytes);
const mj=catalog.entries.find(e=>e.kind==='mj'&&e.vibe&&e.parameters),style=catalog.entries.find(e=>e.kind==='style'),filter=catalog.entries.find(e=>e.kind==='filter');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const groups=[];
async function main(){
 const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const base=`http://127.0.0.1:${port}`;let server,browser,page,log='';const errors=[],external=[],paid=[];
 const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(response.ok,await response.clone().text());return response.json();};
 const pass=name=>{groups.push(name);console.log('PASS: '+name);};
 try{
  server=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});
  server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
  let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await sleep(200);}}assert(ready,log);
  await api('/api/studio/settings/sync-models','POST',{id:'offline',name:'Isolated fixture',base_url:'https://api.deepwhiteai.com/v1',api_key:'mock-content-library-only',enabled:true,primary:true});
  const canvas=(await api('/api/canvases','POST',{title:'内容库兼容隔离检查',kind:'classic'})).canvas;
  browser=await chromium.launch({headless:true,executablePath});const context=await browser.newContext({viewport:{width:1280,height:800}});page=await context.newPage();page.setDefaultTimeout(10000);
  const route=route=>{const request=route.request(),u=new URL(request.url());if(u.origin!==base){external.push(request.url());return route.abort();}
   if(request.method()==='POST'&&/\/api\/(?:studio\/(?:generations|mj\/submit|runninghub\/tasks)|canvas-(?:image|video|llm)|online-image)/.test(u.pathname)){paid.push(u.pathname);return route.fulfill({status:503,json:{detail:'Generation forbidden in content-library acceptance'}});}
   return route.continue();};
  await context.route('**/*',route);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/static/canvas.html?id='+canvas.id);await page.locator('#shell:not(.no-canvas) #board').waitFor();await page.waitForFunction(()=>window.StudioContentLibrary&&window.StudioCanvas0929&&StudioAudio.modelsForChannel('offline','speech').length);
  await page.evaluate(()=>{nodes=[];connections=[];selected.clear();const p=addPromptNode({x:40,y:60});p.id='upstream';p.text='引用的原始故事';const a=addGeneratorNode({x:320,y:40});a.id='ordinary-a';a.apiProvider='offline';a.model='deepwhiteai-image-g2';a.studioPrompt='手写原文 A\n 空格保留';const b=addGeneratorNode({x:1000,y:40});b.id='ordinary-b';b.apiProvider='offline';b.model='deepwhiteai-image-g2';b.studioPrompt='手写原文 B';const m=addGeneratorNode({x:1600,y:40});m.id='mj-target';m.apiProvider='offline';m.model='midjourney-imagine';m.studioPrompt='MJ 手写原文';const v=addVideoNode({x:2100,y:40});v.id='video-target';v.apiProvider='offline';v.model='seedance-2-0-fast';v.studioPrompt='视频手写原文';a.inputs=[p.id];connections.push({from:p.id,to:a.id});selected.add(a.id);view={x:0,y:0,scale:1};render();});
  const dialog=page.locator('dialog.studio-content-library'),category=dialog.getByLabel('内容分类'),search=dialog.getByLabel('搜索内容库'),tabs=dialog.getByLabel('内容类型'),insert=dialog.getByLabel('MJ 应用方式');
  const open=async(kind,id)=>{await page.evaluate(({kind,id})=>StudioContentLibrary.open(kind,id),{kind,id});await dialog.locator('.library-count').waitFor();await page.waitForFunction(()=>document.querySelector('.studio-content-library .library-count')?.textContent.includes('项'));};
  const close=async()=>{await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});};
  const nodeState=id=>page.evaluate(id=>JSON.parse(JSON.stringify(nodes.find(n=>n.id===id))),id);
  const card=id=>dialog.locator(`[data-library-entry="${id}"]`);
  const choose=async entry=>{await search.fill(entry.name);await card(entry.id).locator('strong').click();};
  const assertManual=async()=>{assert.equal((await nodeState('ordinary-a')).studioPrompt,'手写原文 A\n 空格保留');assert.equal((await nodeState('ordinary-a')).model,'deepwhiteai-image-g2');assert.equal((await nodeState('ordinary-b')).studioPrompt,'手写原文 B');assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='upstream').text),'引用的原始故事');};
  const sources=id=>page.evaluate(id=>generatorSources(nodes.find(n=>n.id===id)).map(s=>s.prompt).join('\n'),id);

  await page.locator('[data-id="ordinary-a"] [data-content-kind="mj"]').click();await dialog.locator('.library-grid article').first().waitFor();
  assert.equal(await insert.inputValue(),'vibe','non-MJ defaults to compatible atmosphere');
  for(const mode of ['style','parameters','full'])assert(await insert.locator(`option[value="${mode}"]`).evaluate(o=>o.disabled),'code mode is disabled');
  assert(await dialog.locator('.library-compatibility').isVisible());assert.match(await dialog.locator('.library-compatibility').innerText(),/不支持 MJ.*不会切换模型/);
  await choose(mj);
  const refused=await page.evaluate(entry=>StudioContentLibrary.apply(entry,'parameters'),mj);assert.equal(refused,false);assert(await dialog.locator('.library-inline-status').isVisible());assert.match(await dialog.locator('.library-inline-status').innerText(),/不支持|不能应用/);await assertManual();
  for(const viewport of [{width:1280,height:800},{width:1500,height:900}]){await page.setViewportSize(viewport);await page.waitForTimeout(180);const r=await dialog.boundingBox();assert(r.x>=0&&r.y>=0&&r.x+r.width<=viewport.width+1&&r.y+r.height<=viewport.height+1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await card(mj.id).locator('img').evaluate(img=>img.decode());await page.screenshot({path:path.join(artifacts,`non-mj-${viewport.width}x${viewport.height}.png`)});}
  await dialog.getByRole('button',{name:'仅使用氛围描述',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const aVibe=await nodeState('ordinary-a');assert.equal(aVibe.studioCreative.mj.kind,'mj');assert.equal(aVibe.studioCreative.mj.mode,'vibe');assert.equal(aVibe.studioCreative.mj.prompt,mj.vibe);assert.equal(aVibe.studioCreative.mj.prefix,'');assert(!(await sources('ordinary-a')).includes('--sref'));await assertManual();
  await open('mj','ordinary-a');assert(await card(mj.id).evaluate(el=>el.classList.contains('selected')));await dialog.getByRole('button',{name:'仅使用氛围描述',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.deepEqual((await nodeState('ordinary-a')).studioCreative,aVibe.studioCreative);await assertManual();
  pass('non-MJ inline reason, disabled code modes, explicit atmosphere, repeated apply without model or handwritten changes');

  await open('style','ordinary-a');await choose(style);await card(style.id).getByRole('button',{name:'应用',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await open('filter','ordinary-a');await choose(filter);await card(filter.id).getByRole('button',{name:'应用',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const allPresets=(await nodeState('ordinary-a')).studioCreative;assert.deepEqual(new Set(Object.keys(allPresets)),new Set(['mj','style','filter']));assert.equal(allPresets.style.prompt,style.prompt);assert.equal(allPresets.filter.prompt,filter.prompt);assert.equal(allPresets.filter.prefix,filter.prefix||'');
  const combined=await sources('ordinary-a');assert(combined.includes(mj.vibe)&&combined.includes(style.prompt)&&combined.includes(filter.prompt));await assertManual();assert.equal((await nodeState('ordinary-b')).studioCreative,undefined);
  pass('three distinct preset kinds compose detached sources and preserve node/upstream isolation');

  const counts={};for(const e of catalog.entries.filter(e=>e.kind==='style'))counts[e.category]=(counts[e.category]||0)+1;
  const largeCategory=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];assert(counts[largeCategory]>24);
  await open('style','ordinary-a');await category.selectOption(largeCategory);await search.fill(largeCategory);await dialog.getByRole('button',{name:'下一页',exact:true}).click();
  const chosen=await dialog.locator('.library-grid article').first().getAttribute('data-library-entry');await card(chosen).locator('strong').click();
  const savedCount=await dialog.locator('.library-count').innerText();assert.match(savedCount,/第 2/);
  await search.focus();await close();
  await open('style','ordinary-a');assert.equal(await category.inputValue(),largeCategory);assert.equal(await search.inputValue(),largeCategory);assert.equal(await dialog.locator('.library-count').innerText(),savedCount);assert(await card(chosen).evaluate(el=>el.classList.contains('selected')));
  await close();await open('style','ordinary-b');assert.equal(await search.inputValue(),'');assert.equal(await category.inputValue(),'');assert.match(await dialog.locator('.library-count').innerText(),/第 1/);assert.equal(await dialog.locator('.library-grid article.selected').count(),0);
  await search.fill('只属于 B 的无结果草稿');assert.equal(await dialog.locator('.library-grid article').count(),0);assert.match(await dialog.locator('.library-grid').innerText(),/没有匹配/);await close();
  await open('style','ordinary-a');assert.equal(await search.inputValue(),largeCategory);assert(await card(chosen).evaluate(el=>el.classList.contains('selected')));
  await tabs.selectOption('mj');assert.equal(await search.inputValue(),mj.name);assert.equal(await insert.inputValue(),'vibe');assert(await card(mj.id).evaluate(el=>el.classList.contains('selected')));
  await tabs.selectOption('style');assert.equal(await search.inputValue(),largeCategory);assert.equal(await category.inputValue(),largeCategory);assert.equal(await dialog.locator('.library-count').innerText(),savedCount);
  pass('search/category/page/selected-entry/mode drafts persist per node and per content type; empty state is clear');

  await dialog.locator('header strong').click();assert(await dialog.isVisible());const r=await dialog.boundingBox();await page.mouse.move(r.x+30,r.y+30);await page.mouse.down();await page.mouse.move(3,3,{steps:5});await page.mouse.up();assert(await dialog.isVisible(),'inside-to-outside drag does not dismiss');
  await page.mouse.click(3,3);await dialog.waitFor({state:'hidden'});await open('style','ordinary-a');assert.equal(await search.inputValue(),largeCategory);assert(await card(chosen).evaluate(el=>el.classList.contains('selected')));
  await card(chosen).locator('.library-preview').click();const preview=page.locator('dialog.studio-library-preview');await preview.waitFor();const v=await preview.boundingBox();await page.mouse.move(v.x+25,v.y+25);await page.mouse.down();await page.mouse.move(3,3,{steps:4});await page.mouse.up();assert(await preview.isVisible());await page.mouse.click(3,3);await preview.waitFor({state:'hidden'});assert(await dialog.isVisible(),'preview backdrop only closes preview');
  await card(chosen).locator('.library-preview').click();await preview.waitFor();await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});assert(await dialog.isVisible());await close();
  pass('inside click/drag protection, backdrop and Escape for main library and nested preview preserve drafts');

  await open('mj','mj-target');assert.equal(await insert.inputValue(),'style');for(const mode of ['style','parameters','full','vibe'])assert.equal(await insert.locator(`option[value="${mode}"]`).evaluate(o=>o.disabled),false);
  await choose(mj);await insert.selectOption('parameters');await card(mj.id).getByRole('button',{name:'应用',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const applied=await nodeState('mj-target');assert.equal(applied.model,'midjourney-imagine');assert.equal(applied.studioPrompt,'MJ 手写原文');assert.equal(applied.studioCreative.mj.prompt,[mj.vibe,mj.parameters].filter(Boolean).join('\n'));assert((await sources('mj-target')).includes('--sref')||(await sources('mj-target')).includes('--profile'));
  await open('mj','mj-target');assert.equal(await insert.inputValue(),'parameters');assert.equal(await search.inputValue(),mj.name);await close();
  await page.evaluate(()=>{const n=nodes.find(n=>n.id==='mj-target');n.model='deepwhiteai-image-g2';render();});
  assert(!/--(?:sref|profile|ar|stylize|chaos|hd)\b/.test(await sources('mj-target')),'stored MJ codes never leak to ordinary model');
  assert.match(await page.locator('[data-id="mj-target"] [data-creative-key="mj"]').innerText(),/当前模型不应用/);assert.equal((await nodeState('mj-target')).studioPrompt,'MJ 手写原文');
  await open('mj','mj-target');assert.equal(await insert.inputValue(),'vibe');assert(await insert.locator('option[value="parameters"]').evaluate(o=>o.disabled));await close();
  pass('MJ parameter mode is real; switching to ordinary model retains card but excludes code without automatic model switching');

  await open('mj','ordinary-a');await choose(mj);
  const original=await nodeState('ordinary-a');
  await page.evaluate(()=>{window.libraryOrigin={canvas,nodes,connections};canvas={...canvas,id:'fixture-other-canvas'};nodes=nodes.map(n=>({...n,studioCreative:undefined,studioPrompt:'另一画布同编号手写'}));});
  await dialog.getByRole('button',{name:'仅使用氛围描述',exact:true}).click();assert(await dialog.isVisible());assert.match(await dialog.locator('.library-inline-status').innerText(),/原画布或节点已变化/);
  assert.equal((await nodeState('ordinary-a')).studioPrompt,'另一画布同编号手写');assert.equal((await nodeState('ordinary-a')).studioCreative,undefined);await close();
  await open('mj','ordinary-a');assert.equal(await search.inputValue(),'');assert.equal(await dialog.locator('.library-grid article.selected').count(),0,'same node id on different canvas has independent draft');await close();
  await page.evaluate(()=>{({canvas,nodes,connections}=libraryOrigin);delete window.libraryOrigin;});assert.deepEqual(await nodeState('ordinary-a'),original);
  await open('mj','ordinary-a');assert.equal(await search.inputValue(),mj.name);assert(await card(mj.id).evaluate(el=>el.classList.contains('selected')));
  await page.evaluate(()=>{window.libraryOriginalNode=nodes.find(n=>n.id==='ordinary-a');nodes=nodes.map(n=>n.id==='ordinary-a'?{...n,studioCreative:undefined}:n);});
  await dialog.getByRole('button',{name:'仅使用氛围描述',exact:true}).click();assert.match(await dialog.locator('.library-inline-status').innerText(),/原画布或节点已变化/);assert.equal((await nodeState('ordinary-a')).studioCreative,undefined);await close();
  await page.evaluate(()=>{nodes=nodes.map(n=>n.id==='ordinary-a'?libraryOriginalNode:n);delete window.libraryOriginalNode;render();});
  pass('captured canvas and node identity prevent cross-canvas same-id and replaced-node writes; drafts do not bleed');

  await open('filter','video-target');await choose(filter);await card(filter.id).getByRole('button',{name:'应用',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal((await nodeState('video-target')).studioCreative.filter.prompt,filter.prompt);assert((await sources('video-target')).includes(filter.prompt));assert.equal((await nodeState('video-target')).studioPrompt,'视频手写原文');
  await page.evaluate(async()=>{await saveCanvas();});await page.reload();await page.waitForFunction(()=>window.StudioContentLibrary&&nodes.some(n=>n.id==='ordinary-a'));const stored=await nodeState('ordinary-a');assert.equal(stored.studioPrompt,'手写原文 A\n 空格保留');assert.deepEqual(stored.studioCreative,allPresets);assert.equal((await nodeState('video-target')).studioCreative.filter.kind,'filter');
  pass('existing video preset semantics and applied node snapshots survive real isolated save/reload');

  assert.equal(catalog.entries.length,727);const manifest=JSON.parse(fs.readFileSync(path.join(root,'references/fisher-0927/manifest.json')));assert.equal(manifest.assets.length,1220);
  for(const asset of manifest.assets){assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'static/fisher-library',asset.path))).digest('hex'),asset.sha256,asset.path);}
  assert.deepEqual(fs.readFileSync(catalogPath),catalogBytes,'authorized catalog remains unchanged');assert.deepEqual(paid,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  pass('727 catalog entries and 1220 source hashes unchanged; zero generation, external traffic or page errors');
  console.log('Content-library compatibility acceptance: '+groups.length+' groups passed. Screenshots: '+artifacts);
 }catch(error){if(page){await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(artifacts,'failure-state.json'),JSON.stringify(await page.evaluate(()=>({canvasId:canvas?.id,nodes})).catch(()=>null),null,2));}throw error;}
 finally{if(browser)await browser.close();if(server)server.kill();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
