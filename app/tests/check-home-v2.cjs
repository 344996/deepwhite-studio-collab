'use strict';
// Real temporary project/canvas persistence; only cover bytes and network faults are mocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path');
const executablePath=process.env.CHROMIUM_EXECUTABLE||'data/local-path';
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-home-v2-')),artifacts=path.join(os.tmpdir(),'deepwhite-home-v2');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`,errors=[],external=[],writes=[],coverReads=[];let browser,log='',active=0,maxActive=0,holdId='',releaseCover;
 const server=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});
 server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
 const api=async(url,method='GET',body)=>{if(method==='PUT'&&/^\/api\/canvases\/[^/]+$/.test(url)){const current=await (await fetch(base+url)).json();body={...body,base_updated_at:current.canvas.updated_at};}const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json()};
 try{
  let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break}catch{await sleep(200)}}assert(ready,log);
  const p1=(await api('/api/projects','POST',{name:'首页验收 · 分镜'})).project,p2=(await api('/api/projects','POST',{name:'首页验收 · 素材'})).project;
  const initial=[];
  for(let i=0;i<12;i++){
   const c=(await api('/api/canvases','POST',{title:['雨夜站台 · 封面测试','人物设定 · 封面测试','空白分镜','远程图片不读取','视频不作封面'][i]||`备用画布 ${i}`,kind:i===1?'smart':'classic',project:p1.id})).canvas;
   let nodes=[];
   if(i===0)nodes=[{id:'out',type:'output',images:['/output/home-scene.png']}];
   if(i===1)nodes=[{id:'ref',type:'image',url:'/assets/input/home-character.png'}];
   if(i===3)nodes=[{id:'remote',type:'output',images:['https://example.invalid/private.png']}];
   if(i===4)nodes=[{id:'video',type:'output',images:[{url:'/output/fake-video.png',kind:'video'}]}];
   await api(`/api/canvases/${c.id}`,'PUT',{title:c.title,nodes,connections:[]});initial.push(c);
  }
  await api(`/api/canvases/${initial[0].id}/meta`,'POST',{pinned:true});await api(`/api/canvases/${initial[1].id}/meta`,'POST',{pinned:true});
  const other=(await api('/api/canvases','POST',{title:'独立项目画布',project:p2.id})).canvas;
  browser=await chromium.launch({headless:true,executablePath});const page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',e=>errors.push(e.message));
  const imageBytes=fs.readFileSync(path.join(root,'static/design-review/assets/scene-v1.png'));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==base){external.push(request.url());return route.abort();}
   if(request.method()!=='GET'){writes.push({path:url.pathname,method:request.method(),body:request.postData()});if(!/^\/api\/(?:projects|canvases)/.test(url.pathname))throw Error('Unexpected external action '+url.pathname);}
   if(['/output/home-scene.png','/assets/input/home-character.png'].includes(url.pathname))return route.fulfill({contentType:'image/png',body:imageBytes});
   if(/^\/api\/canvases\/[^/]+$/.test(url.pathname)&&url.pathname!=='/api/canvases/trash'&&request.method()==='GET'){
    const id=url.pathname.split('/').at(-1);coverReads.push(id);active++;maxActive=Math.max(maxActive,active);
    try{const data=await api(url.pathname);if(id===holdId)await new Promise(resolve=>releaseCover=resolve);else await sleep(100);return await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});}finally{active--;}
   }
   return route.continue();
  });
  const go=async pid=>{await page.goto(base+'/?project='+pid);await page.waitForFunction(()=>window.StudioHomeV2);await page.locator('.ws-card').first().waitFor();};
  await go(p1.id);await page.waitForTimeout(300);
  assert(await page.locator('html').evaluate(el=>el.classList.contains('studio-graphite')));assert.equal(await page.locator('.home-wallet,.home-demos,.home-floating').count(),0);
  assert.equal(await page.locator('.ws-card').count(),12);assert.equal(writes.length,0,'merely viewing does not persist old board coordinates');
  assert(maxActive<=3);assert(coverReads.length<12,'offscreen cards remain lazy');
  const card=id=>page.locator(`.ws-card[data-canvas-id="${id}"]`),project=id=>page.locator(`.ws-project-row[data-project-id="${id}"]`);
  await card(initial[0].id).locator('.home-canvas-cover img').waitFor();assert.equal(await card(initial[3].id).locator('img').count(),0);assert.equal(await card(initial[4].id).locator('img').count(),0);assert.deepEqual(external,[]);
  fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'home-v2-first-1280.png')});console.log('First screenshot: '+path.join(artifacts,'home-v2-first-1280.png'));
  const beforeCache=coverReads.length;await page.locator('#boardRefresh').click();await page.waitForTimeout(300);assert.equal(coverReads.length,beforeCache,'unchanged cards reuse cover URL cache');
  await page.locator('#homeSearch').fill('没有这个名字');assert(await page.locator('#homeSearchEmpty').isVisible());assert.equal(await page.locator('.ws-card:visible').count(),0);
  await page.locator('#homeSearchEmpty button').click();await page.locator('[data-view="list"]').click();assert(await page.locator('body').evaluate(el=>el.classList.contains('studio-home-list')));await page.reload();await page.waitForFunction(()=>window.StudioHomeV2);assert(await page.locator('body').evaluate(el=>el.classList.contains('studio-home-list')));await page.locator('[data-view="grid"]').click();
  await page.locator('.studio-project-search').fill('素材');assert.equal(await page.locator('.ws-project-row:visible').count(),1);await page.locator('.studio-project-search').fill('');
  await project(p1.id).hover();await project(p1.id).locator('.rename').click();await page.locator('.ws-project-name-input').fill('正式首页 · 分镜');const renamedProject=page.waitForResponse(r=>r.url().endsWith('/api/projects/'+p1.id)&&r.request().method()==='POST');await page.keyboard.press('Enter');await renamedProject;
  await page.locator('#newProjectBtn').click();await page.locator('#newProjectInput').fill('正式首页 · 新文件夹');const newFolderResponse=page.waitForResponse(r=>r.url().endsWith('/api/projects')&&r.request().method()==='POST');await page.locator('#newProjectConfirm').click();const newFolder=(await (await newFolderResponse).json()).project;await project(newFolder.id).waitFor();assert(await page.locator('#boardEmptyHint').isVisible());
  await page.locator('#newCanvasBtn').click();await page.locator('#homeCreateDialog').waitFor();assert.equal(await page.locator('#homeCreateDialog [data-kind]').count(),2);await page.locator('.ws-create-input').fill('真实创建 · 普通');const createdResponse=page.waitForResponse(r=>r.url().endsWith('/api/canvases')&&r.request().method()==='POST');await page.locator('.ws-create-confirm').click();const created=(await (await createdResponse).json()).canvas;await card(created.id).waitFor();assert.equal(created.kind,'classic');assert.equal(created.project,newFolder.id);
  await page.locator('#newCanvasBtn').click();await page.locator('[data-kind="smart"]').click();await page.locator('.ws-create-input').fill('真实创建 · 智能');const smartResponse=page.waitForResponse(r=>r.url().endsWith('/api/canvases')&&r.request().method()==='POST');await page.locator('.ws-create-confirm').click();const smart=(await (await smartResponse).json()).canvas;await card(smart.id).waitFor();assert.equal(smart.kind,'smart');
  await page.locator('#newCanvasBtn').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#homeCreateDialog').count(),0);assert(await page.locator('#newCanvasBtn').evaluate(el=>el===document.activeElement));
  await card(created.id).locator('.ws-card-menu').click();await page.locator('[data-act="rename"]').click();await card(created.id).locator('.ws-card-title-input').fill('重命名的真实画布');const renameResponse=page.waitForResponse(r=>r.url().endsWith(`/api/canvases/${created.id}/meta`));await page.keyboard.press('Enter');await renameResponse;
  await card(created.id).locator('.ws-card-menu').click();await page.locator('[data-act="cut"]').click();await project(p2.id).click();await page.locator('#pasteCanvasBtn').click();await card(created.id).waitFor();assert.equal((await api(`/api/canvases/${created.id}`)).canvas.project,p2.id);assert.equal((await api(`/api/canvases/${created.id}`)).canvas.title,'重命名的真实画布');
  await card(created.id).locator('.ws-card-menu').click();await page.locator('[data-act="delete"]').click();assert(await card(created.id).locator('.ws-card-delete-confirm').isVisible());assert.equal((await api('/api/canvases/trash')).canvases.length,0);await card(created.id).locator('.ws-card-delete-no').click();
  await card(created.id).locator('.ws-card-menu').click();await page.locator('[data-act="delete"]').click();await card(created.id).locator('.ws-card-delete-yes').click();await card(created.id).waitFor({state:'detached'});
  await page.locator('#trashEntry').click();const trash=page.locator(`.ws-trash-card[data-canvas-id="${created.id}"]`);await trash.waitFor();await trash.locator('.purge').click();assert(await trash.locator('.ws-trash-confirm').isVisible());await trash.locator('.ws-trash-confirm-no').click();await trash.locator('.restore').click();await card(created.id).waitFor({state:'attached'});await page.locator('#trashClose').click();assert.equal((await api('/api/canvases/trash')).canvases.length,0);
  await page.reload();await page.waitForFunction(()=>window.StudioHomeV2);await card(created.id).waitFor();assert.equal(await page.locator('#boardProjectName').innerText(),p2.name);assert.equal(await card(created.id).locator('.ws-card-title').innerText(),'重命名的真实画布');
  await page.locator('#studioSettingsButton').click();assert(await page.locator('#studioSettingsDialog').isVisible());await page.frameLocator('#studioSettingsDialog iframe').locator('#closeSettings').click();await page.locator('#studioSettingsDialog').waitFor({state:'hidden'});assert(await page.getByRole('button',{name:'登录 / 账户',exact:true}).isVisible());
  // Hold an old-project cover response across a real project switch. No late painting.
  holdId=initial[0].id;await api(`/api/canvases/${holdId}`,'PUT',{title:initial[0].title,nodes:[{id:'out',type:'output',images:['/output/home-scene.png']}],connections:[]});await project(p1.id).click();for(let i=0;i<50&&!releaseCover;i++)await sleep(50);assert(releaseCover);await page.evaluate(id=>window.oldHomeCard=document.querySelector(`[data-canvas-id="${id}"]`),holdId);await project(p2.id).click();releaseCover();await sleep(200);assert.equal(await card(other.id).locator('img').count(),0);assert.equal(await page.evaluate(()=>oldHomeCard.querySelectorAll('img').length),0);holdId='';
  // A refreshed context reuses persisted files and respects every saved theme.
  for(const theme of ['light','milk','dark']){
   await page.evaluate(theme=>{localStorage.removeItem('deepwhite_canvas_material');localStorage.setItem('studio_theme',theme==='dark'?'dark':'light');if(theme==='milk')localStorage.setItem('deepwhite_canvas_material','milk')},theme);await page.reload();await page.waitForFunction(()=>window.StudioHomeV2);const actual=await page.evaluate(()=>({bg:getComputedStyle(document.body).backgroundColor,milk:document.documentElement.classList.contains('studio-milk'),graphite:document.documentElement.classList.contains('studio-graphite')}));assert.equal(actual.graphite,false);if(theme==='milk')assert(actual.milk);assert.notEqual(actual.bg,'rgb(32, 35, 31)');
  }
  await page.evaluate(()=>{localStorage.removeItem('studio_theme');localStorage.removeItem('canvas_theme');localStorage.removeItem('deepwhite_canvas_material')});await go(p1.id);
  fs.mkdirSync(artifacts,{recursive:true});
  for(const size of [{width:1280,height:800},{width:1500,height:900}]){
   await page.setViewportSize(size);await page.waitForTimeout(300);await page.waitForFunction(()=>[...document.querySelectorAll('.home-canvas-cover img')].every(img=>img.complete&&img.naturalWidth>0));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal clipping');const primary=await page.locator('#newCanvasBtn').boundingBox();assert(primary.x+primary.width<=size.width&&primary.y+primary.height<size.height);
   await page.screenshot({path:path.join(artifacts,`home-v2-${size.width}x${size.height}.png`)});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert(maxActive<=3);
  assert(writes.filter(x=>x.path.endsWith('/meta')).every(x=>!x.body||!x.body.includes('board_x')),'view, rename and move never rewrite board coordinates');
  console.log(`Homepage V2 checks passed: real temporary CRUD/persistence, lazy covers (${maxActive} max concurrency), project isolation, themes, 2 screenshots at ${artifacts}. No generation or upstream traffic.`);
 }finally{if(releaseCover)releaseCover();if(browser)await browser.close();server.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
