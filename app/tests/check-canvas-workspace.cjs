'use strict';
// Real native engines, synthetic projects, a disposable profile and no upstream generation.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process'), {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-canvas-workspace-'));
const output = path.resolve(process.env.CANVAS_WORKSPACE_EVIDENCE || path.join(root, 'test-output/canvas-workspace'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), results = [], errors = [], external = [], paid = [];
let server, browser, page, base, log = '';
fs.mkdirSync(output, {recursive:true});
async function api(url, method = 'GET', body) { const response = await fetch(base + url, {method,headers:{'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})}); assert(response.ok, await response.clone().text()); return response.json(); }
async function check(name, work) { await work(); results.push({name,passed:true}); console.log('PASS ' + name); }
async function fixture(kind) {
  const data = (await api('/api/canvases', 'POST', {kind,title:'Workspace ' + kind})).canvas;
  const list = kind === 'classic' ? [
    {id:'text',type:'prompt',x:160,y:160,w:280,h:230,studioTitle:'文本素材',text:'原始提示词'},
    {id:'generate',type:'generator',x:540,y:160,w:440,studioTitle:'图片生成',apiProvider:'offline',model:'deepwhiteai-image-g2',studioPrompt:'需要保留的生成提示词'}
  ] : [
    {id:'text',type:'smart-prompt',x:160,y:160,w:316,h:240,title:'文本素材',text:'原始提示词',llmEnabled:false},
    {id:'generate',type:'smart-image',x:560,y:160,title:'图片生成',images:[],runSettings:{engine:'api',provider_id:'offline',model:'deepwhiteai-image-g2'}}
  ];
  await api('/api/canvases/' + data.id, 'PUT', {...data,base_updated_at:data.updated_at,nodes:list,connections:[],viewport:{x:0,y:0,scale:1}});
  await page.goto(base + '/static/' + (kind === 'smart' ? 'smart-' : '') + 'canvas.html?id=' + data.id);
  await page.waitForFunction(id => canvas?.id === id && window.StudioNodeComposer?.ready && nodes.length === 2, data.id);
  await page.locator('[data-id="text"]').first().waitFor(); await pause(150); return data.id;
}
async function selectText() { const smart = await page.locator('html').evaluate(item => item.classList.contains('studio-v2-smart')); const box = await page.locator(smart ? '.image-node[data-id="text"]' : '[data-id="text"] .node-head').boundingBox(); await page.mouse.click(box.x + 80, box.y + (smart ? 7 : box.height / 2)); await page.locator('[data-id="text"] textarea').first().waitFor({state:'visible'}); }
async function blur() { await page.evaluate(()=>document.activeElement?.blur()); await pause(70); }
async function undo(redo = false) { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(redo ? 'Control+Shift+z' : 'Control+z'); await pause(100); }
(async () => {
  const port = await new Promise(resolve => { const socket = net.createServer().listen(0,'127.0.0.1',() => { const value = socket.address().port; socket.close(() => resolve(value)); }); }); base = 'http://127.0.0.1:' + port;
  server = spawn(process.env.PYTHON_EXECUTABLE || 'python', ['-B','tests/catalog-browser-server.py'], {cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});
  server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
  let ready = false; for (let i = 0; i < 120; i++) { try { await api('/api/studio/health'); ready = true; break; } catch { await pause(150); } } assert(ready, log);
  await api('/api/studio/settings/sync-models', 'POST', {id:'offline',name:'Offline test',base_url:'https://api.deepwhiteai.com/v1',api_key:'offline-fixture',enabled:true,primary:true});
  browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {})});
  const context = await browser.newContext({viewport:{width:1500,height:1000},reducedMotion:'reduce'});
  await context.route('**/*', route => { const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.origin); return route.abort(); }
    if (request.method() === 'POST' && /\/api\/(?:studio\/generations|generate|canvas-(?:image|comfy|video|llm)|runninghub\/(?:submit|workflow)|studio\/mj\/submit)/.test(url.pathname)) { paid.push(url.pathname); return route.fulfill({status:503,json:{detail:'Generation forbidden in workspace verification'}}); }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  for (const kind of process.env.WORKSPACE_KIND ? [process.env.WORKSPACE_KIND] : ['classic','smart']) {
    const id = await fixture(kind);
    await check(kind + ': common rail and unique native workflow entry', async () => {
      assert.deepEqual(await page.locator('#workspaceCanvasRail>button>span').allTextContents(), ['添加','选择','移动','素材','工作流']);
      for(const item of await page.locator('#workspaceCanvasRail>button').all()){const box=await item.boundingBox();assert(box.width>=44&&box.height>=44,'labeled tools retain a usable pointer target');}
      assert.equal(await page.locator('[data-workflow-workbench]').count(), 1); assert.equal(await page.locator('#workspaceInspector').count(),0);
      await selectText();await page.evaluate(kind=>{if(kind==='smart'){selectedId='removed-node';selectedIds=[];}else{selected.clear();selected.add('removed-node');}render();},kind);
      assert.equal(await page.locator('#workspaceInspectorToggle').count(),0);
    });
    await check(kind + ': node prompt edit is one undo session and persists exactly', async () => {
      await selectText(); const input = page.locator('[data-id="text"] textarea');
      await input.fill('第一段'); await page.keyboard.insertText('，第二段'); await blur();
      assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'text').text), '第一段，第二段');
      await undo(); assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'text').text), '原始提示词');
      await undo(true); assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'text').text), '第一段，第二段');
      await page.waitForFunction(() => document.querySelector('.workspace-save-state').textContent === '已保存');
      assert.equal((await api('/api/canvases/' + id)).canvas.nodes.find(node => node.id === 'text').text, '第一段，第二段');
    });
    await check(kind + ': no-op native editor focus preserves redo and coordinates', async () => {
      await undo(); await selectText();const before=await page.evaluate(()=>({x:nodes[0].x,y:nodes[0].y}));await page.locator('[data-id="text"] textarea').focus();await blur();await undo(true);await selectText();
      assert.equal(await page.evaluate(()=>nodes.find(node=>node.id==='text').text),'第一段，第二段');assert.deepEqual(await page.evaluate(()=>({x:nodes[0].x,y:nodes[0].y})),before);
    });
    await check(kind + ': focused node text and wheel never manipulate canvas', async () => {
      await selectText();
      const input = page.locator('[data-id="text"] textarea'); await input.fill('长文字\n'.repeat(100)); const before = await page.evaluate(() => ({...viewport}));
      await input.hover(); await page.mouse.wheel(0,120); await page.keyboard.press('Space'); await page.keyboard.press('Delete');
      assert.deepEqual(await page.evaluate(() => ({...viewport})), before); assert.equal(await page.evaluate(() => nodes.length), 2); assert(await input.evaluate(item => item.scrollTop) > 0); await blur();
    });
    await check(kind + ': narrow viewport has native editing and no fixed property drawer', async () => {
      await page.setViewportSize({width:390,height:900});await pause(100);assert.equal(await page.locator('#workspaceInspector,#workspaceInspectorToggle,#workspaceInspectorScrim').count(),0);
      assert(await page.locator('#workspaceCanvasRail').isVisible());await page.screenshot({path:path.join(output,kind+'-mobile.png')});await page.setViewportSize({width:1500,height:1000});
    });
    await check(kind + ': save vocabulary reports pending, failure and version conflict', async () => {
      for (const [event, detail, label] of [['studio-save-pending',{},'有改动'],['studio-save-started',{},'保存中'],['studio-save-state',{ok:false,code:'failed'},'保存失败'],['studio-save-state',{ok:false,code:'conflict'},'版本冲突'],['studio-save-state',{ok:true,code:'saved'},'已保存']]) {
        const actual=await page.evaluate(({event,detail}) => {window.dispatchEvent(new CustomEvent(event,{detail:{canvasId:canvas.id,...detail}}));return document.querySelector('.workspace-save-state').textContent;},{event,detail});
        assert.equal(actual, label);
      }
    });
    await fixture(kind);
    await check(kind + ': node model picker uses native parameters with undo', async () => {
      await page.evaluate(kind=>{if(kind==='smart'){selectedId='generate';selectedIds=[];}else{selected.clear();selected.add('generate');}render();},kind);
      const prior=await page.evaluate(kind=>{const node=nodes.find(n=>n.id==='generate');return kind==='smart'?node.runSettings.model:node.model;},kind);
      await page.locator(kind==='smart'?'#dynamicParams .studio-smart-model .smart-pill':'[data-id="generate"] .studio-model-trigger').first().click();
      const models=page.locator('#studioModelPicker .studio-picker-option');const next=await models.evaluateAll((items,prior)=>items.find(item=>item.dataset.model!==prior)?.dataset.model,prior);assert(next,'fixture exposes another model');
      await page.locator('#studioModelPicker .studio-picker-option').filter({has:page.locator('b')}).evaluateAll((items,next)=>items.find(item=>item.dataset.model===next).click(),next);await pause(100);
      assert.equal(await page.evaluate(kind=>{const node=nodes.find(n=>n.id==='generate');return kind==='smart'?node.runSettings.model:node.model;},kind),next);await undo();assert.equal(await page.evaluate(kind=>{const node=nodes.find(n=>n.id==='generate');return kind==='smart'?node.runSettings.model:node.model;},kind),prior);
    });
    await fixture(kind);
    await check(kind + ': V/H tools and temporary Space pan preserve node coordinates', async () => {
      const before=await page.evaluate(()=>({view:{...viewport},x:nodes[0].x,y:nodes[0].y}));
      await page.keyboard.press('h');await page.mouse.move(1300,650);await page.mouse.down();await page.mouse.move(1340,680,{steps:5});await page.mouse.up();
      assert.equal(await page.evaluate(()=>nodes[0].x),before.x);assert.equal(await page.evaluate(()=>nodes[0].y),before.y);
      assert.equal(await page.evaluate(()=>viewport.x),before.view.x+40);await page.keyboard.press('v');
      const selectedTool=page.locator(kind==='smart'?'#workspaceSelect':'#studioV2Select');assert.equal(await selectedTool.getAttribute('aria-pressed'),'true');
      await page.keyboard.down('Space');await page.mouse.move(1300,630);await page.mouse.down();await page.mouse.move(1320,645,{steps:4});await page.mouse.up();await page.keyboard.up('Space');
      assert.equal(await page.evaluate(()=>viewport.x),before.view.x+60);assert.equal(await page.evaluate(()=>nodes[0].x),before.x);assert.equal(await selectedTool.getAttribute('aria-pressed'),'true');
    });
    await fixture(kind);
    await check(kind + ': connection snap, invalid self drop and Escape remain undoable', async () => {
      const out=page.locator(`[data-id="text"] ${kind==='smart'?'.port-out':'.port.out'}`),input=page.locator(`[data-id="generate"] ${kind==='smart'?'.port-in':'.port.in'}`);
      const point=async locator=>{const r=await locator.boundingBox();return {x:r.x+r.width/2,y:r.y+r.height/2};};
      const prepare=async()=>{if(kind==='smart'){await page.locator('.image-node[data-id="text"]').hover({position:{x:80,y:7}});await pause(50);}return point(out);};
      let start=await prepare(),end=await point(input);
      await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x-12,end.y,{steps:8});
      assert.equal(await page.locator('#workspaceConnectionHint').getAttribute('data-state'),'valid');await page.mouse.up();
      assert.equal(await page.evaluate(kind=>kind==='smart'?canvas.connections.length:connections.length,kind),1);
      if(kind==='smart'){
        const middle=await page.locator('path.conn-line').first().evaluate(item=>{const point=item.getPointAtLength(item.getTotalLength()/2),matrix=item.getScreenCTM();return {x:matrix.a*point.x+matrix.e,y:matrix.d*point.y+matrix.f};});
        await page.keyboard.down('x');await page.mouse.move(middle.x,middle.y-25);await page.mouse.down();await page.mouse.move(middle.x,middle.y+25,{steps:8});await page.mouse.up();await page.keyboard.up('x');
        assert.equal(await page.evaluate(()=>canvas.connections.length),0,'X cutter preserves the native wire removal tool');await undo();assert.equal(await page.evaluate(()=>canvas.connections.length),1);
      }
      await undo();assert.equal(await page.evaluate(kind=>kind==='smart'?canvas.connections.length:connections.length,kind),0);
      start=await prepare();await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x-20,start.y,{steps:3});
      assert.match(await page.locator('#workspaceConnectionHint').innerText(),/自身/);await page.mouse.up();assert.equal(await page.evaluate(()=>nodes.length),2);
      start=await prepare();await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+90,start.y+90,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();
      assert(await page.locator('#workspaceConnectionHint').isHidden());assert.equal(await page.evaluate(()=>nodes.length),2);assert.equal(await page.evaluate(kind=>kind==='smart'?canvas.connections.length:connections.length,kind),0);
    });
    if(kind==='classic')await check('classic: completed link gestures release window cancellation listeners', async()=>{
      const cdp=await context.newCDPSession(page);
      const listeners=async()=>{const value=await cdp.send('Runtime.evaluate',{expression:'window',objectGroup:'workspace-listeners'});const data=await cdp.send('DOMDebugger.getEventListeners',{objectId:value.result.objectId});await cdp.send('Runtime.releaseObjectGroup',{objectGroup:'workspace-listeners'});return data.listeners.filter(item=>['keydown','blur'].includes(item.type)).length;};
      const before=await listeners();
      for(let i=0;i<4;i++){const a=await page.locator('[data-id="text"] .port.out').boundingBox(),b=await page.locator('[data-id="generate"] .port.in').boundingBox();await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:4});await page.mouse.up();}
      assert.equal(await listeners(),before);await cdp.detach();
    });
    await check(kind + ': modal button shortcuts and scroll cannot reach selected nodes',async()=>{
      await selectText();const prior=await page.evaluate(()=>({count:nodes.length,view:{...viewport}}));
      await page.locator('#workspaceMoreTools>summary').click();await page.getByRole('button',{name:'公共画廊',exact:true}).click();
      await page.locator('#workspaceGalleryDialog [data-gallery-close]').focus();await page.keyboard.press('Delete');await page.keyboard.press('Space');
      assert.equal(await page.evaluate(()=>nodes.length),prior.count);assert.deepEqual(await page.evaluate(()=>({...viewport})),prior.view);
      await page.keyboard.press('Escape');
    });
    await fixture(kind);
    await check(kind + ': native copy after typing preserves the original receipt and has its own undo',async()=>{
      await page.evaluate(()=>{nodes[0].studioSubmission={id:'offline-completed-receipt',status:'completed'};});
      await selectText();await page.locator('[data-id="text"] textarea').fill('复制确认');
      await blur();await page.keyboard.press('Control+c');await page.keyboard.press('Control+v');
      await page.waitForFunction(()=>nodes.length===3);
      const data=await page.evaluate(()=>({original:nodes.find(node=>node.id==='text'),copy:nodes.find(node=>!['text','generate'].includes(node.id))}));
      assert.equal(data.original.studioSubmission.id,'offline-completed-receipt');assert.equal(data.copy.studioSubmission,undefined);assert.equal(data.copy.text,'复制确认');
      await undo();assert.equal(await page.evaluate(()=>nodes.length),2);assert.equal(await page.evaluate(()=>nodes[0].text),'复制确认');
    });
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(paid, []);
})().catch(async error => { results.push({passed:false,error:error.stack}); console.error(error.stack); process.exitCode = 1; await page?.screenshot({path:path.join(output,'failure.png')}).catch(() => {}); }).finally(async () => {
  await browser?.close(); if (server && server.exitCode === null) { server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)),pause(5000)]); }
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({results,errors,external,paid},null,2)); fs.writeFileSync(path.join(output,'server.log'),log);
  assert.equal(path.dirname(path.resolve(runtime)).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase()); assert(path.basename(runtime).startsWith('dw-canvas-workspace-')); fs.rmSync(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
