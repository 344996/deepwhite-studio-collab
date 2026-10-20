'use strict';
// Real pages in an isolated local runtime. Media/tasks are fixtures, all external
// traffic and generation writes are rejected. No user projects or accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-interaction-details-'));
const evidence = path.join(root, 'test-output/interaction-details');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], external = [], paid = [], writes = [];
let server, browser, page, base, project, classic, smart, log = '';
fs.mkdirSync(evidence, {recursive:true});
const scene = fs.readFileSync(path.join(root, 'static/design-review/assets/scene-v1.png'));
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {method, headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
  assert(response.ok, await response.clone().text()); return response.json();
}
async function check(name, action) {await action(); checks.push(name); console.log('PASS ' + name);}
async function route(context) {
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (['blob:', 'data:'].includes(url.protocol)) return route.continue();
    if (url.origin !== base) {external.push(url.origin); return route.abort();}
    if (url.pathname === '/output/interaction-scene.png' || (url.pathname === '/api/media-preview' && url.searchParams.get('url') === '/output/interaction-scene.png')) {
      return route.fulfill({contentType:'image/png', body:scene});
    }
    if (url.pathname === '/api/studio/assets' && request.method() === 'GET') {
      return route.fulfill({json:{items:[{version_id:'interaction-fixture', project_id:project.id, name:'林间来信 · 测试素材', status:'candidate', kind:'image', url:'/output/interaction-scene.png', source:'local', created_at:Date.now()/1000}]}});
    }
    if (url.pathname === '/api/studio/generations' && request.method() === 'GET') {
      return route.fulfill({json:{items:[{id:'interaction-history', status:'succeeded', created_at:Date.now()/1000, resolved_model:'图片预览 · 测试记录',
        request:{provider_id:'offline', node_id:'sample', kind:'image', model:'deepwhiteai-image-g2', prompt:'山谷与薄雾，柔和的清晨光线。', params:{}, references:[], count:1},
        outputs:[{kind:'image',url:'/output/interaction-scene.png',name:'test-scene.png'}],children:[],task_ids:[],text:''}]}});
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(request.method() + ' ' + url.pathname);
      if (/\/api\/(?:studio\/generations|generate|canvas-(?:image|comfy|video|llm)|studio\/mj\/submit)/.test(url.pathname)) {
        paid.push(url.pathname); return route.fulfill({status:503,json:{detail:'Paid requests are disabled in interaction tests'}});
      }
    }
    return route.continue();
  });
}
async function ready(url = '/?project=' + project.id) {
  await page.goto(base + url);
  await page.waitForFunction(() => window.StudioInteractions?.ready &&
    [...document.querySelectorAll('link[rel=stylesheet]')].every(link => !!link.sheet));
}
async function home() {
  await ready(); await page.waitForFunction(() => window.StudioWorkspace?.ready && document.querySelector('.home-canvas-cover>img')?.complete);
}
async function visual(locator) {
  return locator.evaluate(el => {
    const style = getComputedStyle(el);
    return {scale:style.scale, filter:style.filter, paint:style.backgroundImage, transition:style.transitionDuration, outline:style.outlineStyle};
  });
}
async function pressAndCancel(locator) {
  await locator.hover(); await wait(220);
  await page.mouse.down(); await wait(100);
  const pressed = await visual(locator);
  await page.mouse.move(4, 4); await page.mouse.up(); await wait(250);
  assert.equal(await locator.getAttribute('data-dw-press'), null);
  return pressed;
}
(async () => {
  const port = await new Promise(resolve => {const socket=net.createServer().listen(0,'127.0.0.1',()=>{const value=socket.address().port;socket.close(()=>resolve(value));});});
  base = 'http://127.0.0.1:' + port;
  server = spawn(process.env.PYTHON_EXECUTABLE || 'python', ['-B','tests/catalog-browser-server.py'], {
    cwd:root, windowsHide:true, env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'},
  });
  server.stdout.on('data',value=>log+=value);server.stderr.on('data',value=>log+=value);
  for (let i=0;i<140;i++) {try {await api('/api/studio/health');break;} catch {await wait(150);}}
  project = (await api('/api/projects','POST',{name:'微交互验收 · 临时项目'})).project;
  classic = (await api('/api/canvases','POST',{kind:'classic',project:project.id,title:'林间来信 · 视觉验收'})).canvas;
  classic = (await api('/api/canvases/'+classic.id,'PUT',{...classic,base_updated_at:classic.updated_at,nodes:[
    {id:'image',type:'image',url:'/output/interaction-scene.png',x:160,y:120,w:320,h:240},
    {id:'prompt',type:'prompt',text:'清晨山谷与薄雾',x:560,y:120,w:280,h:200},
  ],connections:[],viewport:{x:0,y:0,scale:1}})).canvas;
  smart = (await api('/api/canvases','POST',{kind:'smart',project:project.id,title:'镜头笔记 · 交互验收'})).canvas;
  browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE});
  const context = await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'no-preference'});
  await route(context);
  page = await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await check('home hover is gentle; press has feedback and drag-away cancels without activation', async () => {
    await home();
    const quick = page.locator('.workspace-quickstart [data-workspace-create="classic"]');
    const rest = await visual(quick);
    await quick.hover();await wait(260);
    const hover = await visual(quick);
    assert.notEqual(hover.paint, rest.paint);
    assert.match(hover.filter,/brightness\(1\.06\)/);
    const down = await pressAndCancel(quick);
    assert(Number(down.scale)<1 && Number(down.scale)>.95);
    assert.match(down.filter,/brightness\(0\.94\)/);
    assert(['none','1'].includes((await visual(quick)).scale));
    assert.equal(await page.locator('.ws-create-pop:visible').count(),0);
    assert.deepEqual(writes,[]);
  });
  await check('real view toggle fires once by mouse, Space and Enter; release always clears', async () => {
    const list = page.getByRole('button',{name:'列表视图',exact:true}), grid = page.getByRole('button',{name:'网格视图',exact:true});
    await list.evaluate(el=>{window.interactionClicks=0;el.addEventListener('click',()=>window.interactionClicks++);});
    await list.click();assert.equal(await page.evaluate(()=>window.interactionClicks),1);
    assert.equal(await list.getAttribute('aria-pressed'),'true');
    await grid.click();await list.focus();await page.keyboard.down('Space');await wait(90);
    assert(Number((await visual(list)).scale)<1);assert.equal(await page.evaluate(()=>window.interactionClicks),1);
    await page.keyboard.up('Space');await wait(250);assert.equal(await page.evaluate(()=>window.interactionClicks),2);
    await grid.click();await list.focus();await page.keyboard.press('Enter');await wait(250);
    assert.equal(await page.evaluate(()=>window.interactionClicks),3);
    assert.equal(await list.getAttribute('data-dw-press'),null);await grid.click();
  });
  await check('project cover moves gently, nested menu remains independent and keyboard focus returns', async () => {
    const card = page.locator('.ws-card').filter({hasText:'林间来信'}).first(), cover = card.locator('.home-canvas-cover>img');
    await card.hover({position:{x:70,y:80}});await wait(300);
    assert(Number((await visual(cover)).scale)>1);
    await page.screenshot({path:path.join(evidence,'home-hover.png')});
    const menu = card.locator('.ws-card-menu');await menu.hover();await wait(300);
    assert.equal(await card.getAttribute('data-dw-hover'),null);
    assert(['none','1'].includes((await visual(cover)).scale));
    await menu.click();assert.equal(await menu.getAttribute('aria-expanded'),'true');
    await page.keyboard.press('Escape');assert.equal(await menu.evaluate(el=>el===document.activeElement),true);
    assert.equal(await card.getAttribute('data-dw-press'),null);
  });
  await check('disabled, inert, busy and editable descendants do not show enabled press feedback', async () => {
    const button = page.getByRole('button',{name:'列表视图',exact:true});
    for (const attr of ['disabled','aria-disabled','aria-busy','inert']) {
      await button.evaluate((el,attr)=>el.setAttribute(attr,'true'),attr);
      const box = await button.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await wait(100);
      assert.equal(await button.getAttribute('data-dw-press'),null,attr);
      assert(['none','1'].includes((await visual(button)).scale),attr);await page.mouse.move(4,4);await page.mouse.up();
      await button.evaluate((el,attr)=>el.removeAttribute(attr),attr);
    }
    await page.locator('.v2-home-search input').fill('林间');await page.locator('.v2-home-search input').focus();
    await page.keyboard.press('Space');assert.equal(await page.locator('[data-dw-press]').count(),0);
    await page.locator('.v2-home-search input').fill('');
  });
  await check('asynchronous disabled/busy states clear a held press, including ancestor states', async () => {
    const button = page.getByRole('button',{name:'列表视图',exact:true});
    for (const [attr,ancestor] of [['disabled',false],['inert',false],['aria-disabled',true],['aria-busy',true],['class',false],['class',true]]) {
      await button.hover();await page.mouse.down();await wait(90);assert.equal(await button.getAttribute('data-dw-press'),'');
      await button.evaluate((el,{attr,ancestor})=>{const target=ancestor?el.parentElement:el;if(attr==='class')target.classList.add('busy');else target.setAttribute(attr,'true');},{attr,ancestor});
      await page.waitForFunction(()=>!document.querySelector('[data-dw-hover],[data-dw-press]'));
      await page.mouse.move(4,4);await page.mouse.up();
      await button.evaluate((el,{attr,ancestor})=>{const target=ancestor?el.parentElement:el;if(attr==='class')target.classList.remove('busy');else target.removeAttribute(attr);},{attr,ancestor});
    }
  });
  await check('light theme keeps selected controls; reduced motion keeps colour without movement', async () => {
    await page.evaluate(()=>{localStorage.setItem('studio_theme','light');localStorage.setItem('canvas_theme','light');localStorage.setItem('deepwhite_canvas_material','');});
    await home();
    const button = page.getByRole('button',{name:'网格视图',exact:true});
    await button.click();
    await button.hover();await wait(240);assert.match((await visual(button)).filter,/brightness\(0\.985\)/);
    assert.equal(await button.getAttribute('aria-pressed'),'true');
    await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('Tab');await button.focus();await page.keyboard.down('Space');
    const down = await visual(button);assert.equal(down.scale,'none');assert.equal(down.transition,'0s');assert.equal(down.outline,'solid');assert.notEqual(down.paint,'none');
    await page.screenshot({path:path.join(evidence,'light-focus.png')});
    await page.keyboard.up('Space');await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>{localStorage.removeItem('studio_theme');localStorage.removeItem('canvas_theme');localStorage.removeItem('deepwhite_canvas_material');});
  });
  for (const [kind, canvas] of [['classic',classic],['smart',smart]]) {
    await check(kind + ' chrome feedback leaves node coordinates and viewport transforms unchanged', async () => {
      await ready('/static/'+(kind==='smart'?'smart-':'')+'canvas.html?id='+canvas.id);
      await page.waitForFunction(({id,count})=>window.StudioCanvasWorkspace?.ready&&window.StudioNodeComposer?.ready&&canvas?.id===id&&nodes.length===count,{id:canvas.id,count:kind==='classic'?2:0});
      const before = await page.evaluate(()=>({nodes:nodes.map(n=>({id:n.id,x:n.x,y:n.y})),world:getComputedStyle(document.getElementById('world')).transform}));
      const add = page.locator(kind==='smart'?'#smartV2Add':'#studioV2Add');
      const down = await pressAndCancel(add);assert(Number(down.scale)<1);
      const after = await page.evaluate(()=>({nodes:nodes.map(n=>({id:n.id,x:n.x,y:n.y})),world:getComputedStyle(document.getElementById('world')).transform}));
      assert.deepEqual(after,before);
      await page.screenshot({path:path.join(evidence,kind+'-chrome.png')});
    });
    await check(kind + ' focused toolbar buttons accept Space once without activating canvas pan', async () => {
      const history = page.locator(kind==='smart'?'#smartLogToggle':'.studio-history-button');
      await history.waitFor({state:'visible'});
      await history.focus();await page.keyboard.down('Space');await wait(100);
      assert.equal(await history.getAttribute('data-dw-press'),'');
      assert.equal(await page.locator('.workspace-hand,.v2-hand').count(),0);
      await page.keyboard.up('Space');await page.getByRole('button',{name:'关闭生成记录',exact:true}).waitFor();
      assert.equal(await page.locator('.studio-history-view:visible').count(),1);
      await page.getByRole('button',{name:'关闭生成记录',exact:true}).click();
      assert.equal(await history.getAttribute('data-dw-press'),null);
      await page.locator('body').evaluate(el=>{el.tabIndex=-1;el.focus();});
      await page.keyboard.down('Space');
      assert.equal(await page.locator(kind==='smart'?'.workspace-hand':'.v2-hand').count(),1);
      await page.keyboard.up('Space');
      assert.equal(await page.locator('.workspace-hand,.v2-hand').count(),0);
    });
  }
  await check('history image itself opens the preview once, including Enter, with focus restored', async () => {
    await ready('/static/canvas.html?id='+classic.id);await page.waitForFunction(()=>window.StudioNodeComposer?.ready);
    await page.locator('.studio-history-button').click();
    const preview = page.locator('.studio-history-image-preview');await preview.waitFor();
    const media = page.locator('.studio-history-preview>img');await media.evaluate(el=>el.decode());
    const bounds = await media.boundingBox();await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
    await wait(300);assert(Number((await visual(media)).scale)>1);
    await page.mouse.down();await wait(120);await page.screenshot({path:path.join(evidence,'history-pressed.png')});await page.mouse.up();
    await page.locator('.studio-media-preview-dialog').waitFor();assert.equal(await page.locator('.studio-media-preview-dialog').count(),1);
    await page.getByRole('button',{name:'关闭预览',exact:true}).click();
    assert.equal(await preview.evaluate(el=>el===document.activeElement),true);
    await preview.focus();await page.keyboard.press('Enter');await page.locator('.studio-media-preview-dialog').waitFor();
    assert.equal(await page.locator('.studio-media-preview-dialog').count(),1);await page.keyboard.press('Escape');
    assert.equal(await preview.evaluate(el=>el===document.activeElement),true);
    await page.getByRole('button',{name:'关闭生成记录',exact:true}).click();
  });
  await check('settings controls inherit mouse and keyboard feedback inside the actual iframe', async () => {
    await home();await page.locator('#studioSettingsButton').click();
    const frame = page.frameLocator('#studioSettingsDialog iframe');
    await frame.locator('#closeSettings').waitFor();
    await page.waitForFunction(()=>document.querySelector('#studioSettingsDialog iframe')?.contentWindow?.StudioInteractions?.ready);
    const close = frame.locator('#closeSettings');await close.hover();await wait(250);
    assert.notEqual((await visual(close)).paint,'none');
    await close.focus();await page.keyboard.press('Enter');await page.locator('#studioSettingsDialog').waitFor({state:'hidden'});
  });
  await check('asset thumbnails are named native buttons with hover, click and keyboard preview', async () => {
    await ready('/static/studio-assets.html?project_id='+project.id);
    const thumb = page.getByRole('button',{name:'预览素材：林间来信 · 测试素材',exact:true});await thumb.waitFor();
    await thumb.hover();await wait(300);assert(Number((await visual(thumb.locator('img'))).scale)>1);
    await thumb.click();await page.locator('#previewDialog[open]').waitFor();await page.keyboard.press('Escape');
    assert.equal(await thumb.evaluate(el=>el===document.activeElement),true);
    await thumb.focus();await page.keyboard.press('Space');await page.locator('#previewDialog[open]').waitFor();
    await page.keyboard.press('Escape');await page.screenshot({path:path.join(evidence,'assets-focus.png')});
  });
  await check('touch scroll cancels pressed feedback, tap activates once and no sticky hover remains', async () => {
    const touch = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'no-preference'});
    await route(touch);const saved = page;page = await touch.newPage();
    await home();
    const list=page.getByRole('button',{name:'列表视图',exact:true});
    await list.evaluate(el=>{window.touchClicks=0;el.addEventListener('click',()=>window.touchClicks++);});
    await list.tap();assert.equal(await page.evaluate(()=>window.touchClicks),1);
    assert.equal(await page.locator('[data-dw-hover],[data-dw-press]').count(),0);
    const quick=page.locator('.workspace-quickstart button').first();await quick.scrollIntoViewIfNeeded();const box=await quick.boundingBox();
    const cdp=await touch.newCDPSession(page),x=box.x+box.width/2,y=box.y+box.height/2;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await wait(100);
    assert.equal(await quick.getAttribute('data-dw-press'),'');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-45}]});await wait(100);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(250);
    assert.equal(await page.locator('[data-dw-hover],[data-dw-press]').count(),0);
    assert.equal(await page.locator('.ws-create-pop:visible').count(),0);
    await page.screenshot({path:path.join(evidence,'touch-390.png')});await touch.close();page=saved;
  });
  // A short browser recording demonstrates real hover/press/release on test data.
  const demo = await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:path.join(evidence,'video'),size:{width:1440,height:1000}}});
  await route(demo);page=await demo.newPage();await home();await wait(600);
  const quick=page.locator('.workspace-quickstart button').first();
  await quick.hover();await wait(600);await page.mouse.down();await wait(260);await page.mouse.move(4,4);await page.mouse.up();await wait(500);
  const cover=page.locator('.ws-card').filter({hasText:'林间来信'}).first().locator('.home-canvas-cover');
  await cover.hover();await wait(800);await page.mouse.down();await wait(200);await page.mouse.move(4,4);await page.mouse.up();await wait(500);
  const menu=page.locator('.ws-card').filter({hasText:'林间来信'}).first().locator('.ws-card-menu');
  await menu.hover();await wait(500);await menu.click();await wait(600);await page.keyboard.press('Escape');
  await ready('/static/canvas.html?id='+classic.id);await page.waitForFunction(()=>window.StudioNodeComposer?.ready);await page.locator('.studio-history-button').click();
  await page.locator('.studio-history-preview>img').evaluate(el=>el.decode());
  const preview=page.locator('.studio-history-image-preview');await preview.hover();await wait(700);await page.mouse.down();await wait(220);await page.mouse.up();await wait(1100);
  await page.getByRole('button',{name:'关闭预览',exact:true}).click();await wait(500);
  const video=page.video();await demo.close();await video.saveAs(path.join(evidence,'interaction-demo.webm'));
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(paid,[]);
  assert(writes.every(item=>/^POST \/api\/canvases\/[^/]+\/touch$/.test(item)||item==='POST /api/canvas-assets/check'),'Only normal canvas-open bookkeeping is allowed: '+JSON.stringify(writes));
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({passed:true,checks,errors,external,paid,writes,video:'interaction-demo.webm'},null,2));
  console.log(JSON.stringify({passed:checks.length,evidence}));
})().catch(async error=>{
  process.exitCode=1;console.error(error.stack);console.error(log.slice(-1200));
  await page?.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({passed:false,checks,error:String(error),errors,external,paid,writes},null,2));
}).finally(async()=>{
  await browser?.close();
  if(server){server.kill();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),wait(4000)]);}
  assert(path.dirname(runtime)===os.tmpdir()&&path.basename(runtime).startsWith('dw-interaction-details-'));
  fs.rmSync(runtime,{recursive:true,force:true});
});
