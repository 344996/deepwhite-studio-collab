'use strict';
// Real local pages with disposable data; all external traffic is blocked by the fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-workspace-test-'));
const output = path.resolve(process.env.WORKSPACE_EVIDENCE_DIR || path.join(root, 'test-output/workspace-requirements'));
fs.mkdirSync(output, {recursive:true});
let server, browser, log = '', base, page;
const results = [], errors = [], external = [], paid = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {method,headers:{'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
  assert(response.ok, await response.clone().text()); return response.json();
}
async function check(name, run) {await run(); results.push({name,passed:true}); console.log('PASS ' + name);}
async function go(url) {
  await page.goto(base + url);await page.waitForFunction(()=>window.StudioWorkspace?.ready);
  const id = new URL(page.url()).searchParams.get('id');
  if (id) await page.waitForFunction(id => typeof canvas !== 'undefined' && canvas?.id === id, id);
}
async function closeDialog() {await page.keyboard.press('Escape');}
async function visibleInViewport(selector) {
  const item = page.locator(selector); await item.waitFor({state:'visible'});
  const r = await item.boundingBox(), size = page.viewportSize();
  assert(r.x >= -1 && r.y >= -1 && r.x+r.width <= size.width+1 && r.y+r.height <= size.height+1, `${selector} outside ${size.width}px viewport: ${JSON.stringify(r)}`);
  assert(await item.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),selector+' is covered');
}
(async () => {
  const port=await new Promise(resolve=>{const socket=net.createServer().listen(0,'127.0.0.1',()=>{const p=socket.address().port;socket.close(()=>resolve(p));});});
  base=`http://127.0.0.1:${port}`;
  server=spawn(process.env.PYTHON_EXECUTABLE || 'python',['-B','tests/catalog-browser-server.py'],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});
  server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);server.on('error',e=>log+=e.stack);
  let ready=false;for(let n=0;n<120;n++){try{await api('/api/studio/health');ready=true;break;}catch{await sleep(150);}}
  assert(ready,log);
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  await context.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==base){external.push(url.origin);return route.abort();}
    if(request.method()==='POST'&&/\/api\/(?:studio\/generations|generate|canvas-(?:image|comfy|video|llm)|runninghub\/(?:submit|workflow)|studio\/mj\/submit)/.test(url.pathname)){paid.push(url.pathname);return route.fulfill({status:503,json:{detail:'Generation forbidden in UI tests'}});}
    return route.continue();
  });
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await check('Local workspace exposes navigation, creation and optional account without login',async()=>{
    await go('/');assert.equal(await page.locator('.workspace-nav').count(),1);
    await visibleInViewport('#newCanvasBtn');await visibleInViewport('#studioAccountButton');
    assert.match(await page.locator('.workspace-local-note').innerText(),/本地/);
  });
  const urls={home:'/'};
  // U10: only a classic canvas can be created; an old smart canvas is seeded as existing user data.
  await check('the home page offers no smart canvas creation',async()=>{
    await go('/');assert.equal(await page.locator('[data-workspace-create="smart"]').count(),0);
    const legacy=(await api('/api/canvases','POST',{title:'需求验收 smart',kind:'smart'}));const id=(legacy.canvas||legacy).id;
    urls.smart='/static/smart-canvas.html?id='+encodeURIComponent(id);
  });
  for(const kind of ['classic'])await check(`Create ${kind} canvas while logged out`,async()=>{
    await go('/');await page.locator(`[data-workspace-create="${kind}"]`).click();
    await page.locator('#homeCreateDialog input').fill('需求验收 '+kind);
    await page.locator('#homeCreateDialog .ws-create-confirm').click();
    await page.locator('.ws-card').filter({hasText:'需求验收 '+kind}).click();
    await page.waitForURL(/(?:smart-)?canvas\.html\?id=/);await page.waitForFunction(()=>window.StudioWorkspace?.ready);
    urls[kind]=new URL(page.url()).pathname+new URL(page.url()).search;
    const id=new URL(page.url()).searchParams.get('id');const result=await api('/api/canvases/'+id);
    assert.equal((result.canvas||result).kind,kind);await visibleInViewport('#studioAccountButton');
  });
  for(const [name,url]of Object.entries(urls))await check(`${name}: public gallery configuration persists without uploading canvas data`,async()=>{
    await page.setViewportSize({width:390,height:900});await go(url);const before=page.url();
    if(name==='home')await page.locator('#workspaceMenuToggle').click();else await page.locator('#workspaceMoreTools summary').click();
    await page.getByRole('button',{name:'公共画廊',exact:true}).click();await visibleInViewport('#workspaceGalleryDialog');
    await page.waitForFunction(()=>!document.querySelector('#workspaceGalleryURL').disabled);
    await page.locator('#workspaceGalleryURL').fill('http://public.invalid');
    await page.locator('#workspaceGalleryDialog button[type=submit]').click();
    await page.locator('#workspaceGalleryMessage').filter({hasText:'HTTPS'}).waitFor();
    await page.locator('#workspaceGalleryURL').fill('https://gallery.example/');
    await page.locator('#workspaceGalleryDialog button[type=submit]').click();
    await page.locator('#workspaceGalleryOpen').waitFor();
    assert.equal(await page.locator('#workspaceGalleryOpen').getAttribute('href'),'https://gallery.example');
    assert.equal(await page.locator('#workspaceGalleryOpen').getAttribute('rel'),'noopener noreferrer');
    assert.equal((await api('/api/studio/gallery')).url,'https://gallery.example');
    await page.keyboard.press('Escape');await page.locator('#workspaceGalleryDialog').waitFor({state:'hidden'});
    assert.equal(page.url(),before);await page.setViewportSize({width:1440,height:900});
  });
  for(const [name,url]of Object.entries(urls))await check(`${name}: account and API settings keep the current page mounted`,async()=>{
    await go(url);const before=page.url();await page.locator('#studioAccountButton').click();
    await page.locator('.dw-library input[name=username]').waitFor();
    assert.match(await page.locator('.dw-library').innerText(),/本地画布/);
    await closeDialog();assert.equal(page.url(),before);
    await page.locator('#studioSettingsButton').click();await page.frameLocator('#studioSettingsDialog iframe').locator('#apiPanel').waitFor();
    await page.locator('#studioSettingsDialog iframe').focus();await closeDialog();assert.equal(page.url(),before);
  });
  for(const width of [1440,1024,768,390,320])for(const[name,url]of Object.entries(urls))await check(`${name}: main controls fit ${width}px`,async()=>{
    await page.setViewportSize({width,height:900});await go(url);
    await visibleInViewport('#studioAccountButton');await visibleInViewport('#studioSettingsButton');
    if(name==='home'){
      await visibleInViewport('#newCanvasBtn');
      if(width<=768){await page.locator('#workspaceMenuToggle').focus();await page.keyboard.press('Enter');assert(await page.locator('.workspace-nav button').first().evaluate(e=>e===document.activeElement));await page.keyboard.press('Enter');assert.equal(await page.locator('#workspaceMenuToggle').getAttribute('aria-expanded'),'false');}
    }else{
      await visibleInViewport(name==='smart'?'#smartV2Add':'#studioV2Add');
      await visibleInViewport(name==='smart'?'.smart-back':'#backToManagerBtn');
      await page.locator('#workspaceMoreTools summary').click();await visibleInViewport('#workspaceMoreTools .workspace-more-panel');await closeDialog();assert.equal(await page.locator('#workspaceMoreTools').getAttribute('open'),null);
    }
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal document overflow');
    await page.screenshot({path:path.join(output,`${name}-${width}.png`)});
  });
  await check('Reduced motion and isolated generation',async()=>{
    assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('studioAccountButton')).transitionDuration),'0s');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(paid,[]);
  });
  await page.setViewportSize({width:1440,height:900});
  for(const theme of ['graphite','milk','light','dark'])for(const[name,url]of Object.entries(urls))await check(`${name}: ${theme} appearance remains usable`,async()=>{
    await page.evaluate(theme=>{localStorage.removeItem('deepwhite_canvas_material');localStorage.removeItem('studio_theme');localStorage.removeItem('canvas_theme');if(['graphite','milk'].includes(theme))localStorage.setItem('deepwhite_canvas_material',theme);else{localStorage.setItem('studio_theme',theme);localStorage.setItem('canvas_theme',theme);}},theme);
    await go(url);await visibleInViewport('#studioAccountButton');await visibleInViewport('#studioSettingsButton');
    const palette=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return {background:s.getPropertyValue('--dw-bg').trim(),text:s.getPropertyValue('--dw-ink').trim()};});
    assert.notEqual(palette.background,palette.text);assert(palette.background&&palette.text);
    await page.screenshot({path:path.join(output,`${name}-${theme}.png`)});
  });
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(paid,[]);
})().catch(async error=>{results.push({passed:false,error:error.stack});if(page){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.html'),await page.content().catch(()=>''));}console.error(error);process.exitCode=1;}).finally(async()=>{
  await browser?.close();server?.kill();fs.writeFileSync(path.join(output,'server.log'),log);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({results,errors,external,paid},null,2));
});
