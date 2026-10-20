'use strict';
// Fixed chrome verification on both native engines with disposable canvas data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-canvas-chrome-'));
const evidence = path.resolve(process.env.CANVAS_CHROME_EVIDENCE || path.join(root, 'test-output/ui-polish/canvas'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], external = [], paid = [];
let server, browser, page, base, log = '';
fs.mkdirSync(evidence, {recursive:true});
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {method, headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
  assert(response.ok, await response.clone().text());
  return response.json();
}
async function check(name, run) { await run(); checks.push(name); console.log('PASS ' + name); }
async function fixture(kind) {
  const canvas = (await api('/api/canvases', 'POST', {kind, title:'创作分镜 · ' + kind})).canvas;
  const nodes = kind === 'classic'
    ? [{id:'prompt', type:'prompt', x:180, y:160, w:280, h:230, text:'树影与月光，安静的电影画面。'},
       {id:'image', type:'generator', x:620, y:160, w:600, studioPrompt:'清晨的森林，柔和光线。'}]
    : [{id:'prompt', type:'smart-prompt', x:180, y:160, w:316, h:240, text:'树影与月光，安静的电影画面。', llmEnabled:false},
       {id:'image', type:'smart-image', x:620, y:160, title:'图片创作', images:[], runSettings:{engine:'api'}}];
  await api('/api/canvases/' + canvas.id, 'PUT', {...canvas, base_updated_at:canvas.updated_at, nodes, connections:[], viewport:{x:0,y:0,scale:1}});
  await page.goto(base + '/static/' + (kind === 'smart' ? 'smart-' : '') + 'canvas.html?id=' + canvas.id);
  await page.waitForFunction(id => window.StudioNodeComposer?.ready && window.StudioCanvasWorkspace?.ready && canvas?.id === id && nodes.length === 2, canvas.id);
  return canvas.id;
}
async function assertChrome(width, kind) {
  const issue = await page.evaluate(() => {
    const rail = document.getElementById('workspaceCanvasRail').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#workspaceCanvasRail>button')];
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      if (rect.left < rail.left + 3 || rect.right > rail.right - 3) return 'rail alignment: ' + button.id;
    }
    const controls = [...document.querySelectorAll('.workspace-canvas-tools>button,.workspace-canvas-tools>details>summary,#workspaceCanvasRail>button,.workspace-viewport button,#studioGridLayoutTools button,.sv2-bottom button')];
    for (const control of controls.filter(el => el.getClientRects().length && !el.disabled)) {
      const rect = control.getBoundingClientRect();
      if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < 0 || rect.bottom > innerHeight + 1) return 'outside viewport: ' + control.id;
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!control.contains(hit)) return 'covered: ' + control.id;
    }
    return document.documentElement.scrollWidth > innerWidth + 1 ? 'page overflow' : '';
  });
  assert.equal(issue, '', kind + ' at ' + width + ': ' + issue);
}
(async () => {
  const port = await new Promise(resolve => {
    const socket = net.createServer().listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolve(value)); });
  });
  base = 'http://127.0.0.1:' + port;
  server = spawn(process.env.PYTHON_EXECUTABLE || 'python', ['-B','tests/catalog-browser-server.py'], {
    cwd:root, windowsHide:true, env:{...process.env, DEEPWHITE_STUDIO_RUNTIME_DIR:runtime, DEEPWHITE_STUDIO_PORT:String(port), PYTHONUTF8:'1'}
  });
  server.stdout.on('data', value => log += value); server.stderr.on('data', value => log += value);
  for (let attempt = 0; attempt < 140; attempt++) { try { await api('/api/studio/health'); break; } catch { await delay(150); } }
  browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {channel:'msedge'})});
  const context = await browser.newContext({viewport:{width:1440,height:960}, reducedMotion:'reduce'});
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.origin); return route.abort(); }
    if (request.method() === 'POST' && /\/api\/(?:studio\/generations|generate|canvas-(?:image|comfy|video|llm)|studio\/mj\/submit)/.test(url.pathname)) {
      paid.push(url.pathname); return route.fulfill({status:503,json:{detail:'Generation is disabled in chrome verification'}});
    }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  for (const kind of ['classic','smart']) {
    const id = await fixture(kind);
    await check(kind + ': visible controls stay aligned, clickable and in bounds at 320/768/1024/1440', async () => {
      for (const width of [1440,1024,768,320]) {
        await page.setViewportSize({width,height:960}); await delay(250); await assertChrome(width, kind);
        await page.screenshot({path:path.join(evidence,kind + '-' + width + '.png')});
      }
    });
    await check(kind + ': short viewport retains scroll access to every rail tool', async () => {
      await page.setViewportSize({width:320,height:440});
      const rail = page.locator('#workspaceCanvasRail'), last = rail.locator('button').last();
      await last.scrollIntoViewIfNeeded();
      const bounds = await rail.boundingBox(), button = await last.boundingBox();
      assert(button.y >= bounds.y && button.y + button.height <= bounds.y + bounds.height + 1);
      await page.setViewportSize({width:1440,height:960});
    });
    await check(kind + ': light theme, keyboard focus and reduced motion remain usable', async () => {
      await page.evaluate(() => {
        localStorage.setItem('studio_theme','light'); localStorage.setItem('canvas_theme','light'); localStorage.setItem('deepwhite_canvas_material','');
      });
      await page.reload();
      await page.waitForFunction(id => window.StudioCanvasWorkspace?.ready && canvas?.id === id && nodes.length === 2, id);
      await assertChrome(1440, kind);
      const first = page.locator('#workspaceCanvasRail>button').first();
      await page.keyboard.press('Tab'); await first.focus();
      assert.equal(await first.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
      assert.equal(await first.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dw-media-scheme').trim()), 'light');
      await page.screenshot({path:path.join(evidence,kind + '-light.png')});
      await page.evaluate(() => { localStorage.removeItem('studio_theme'); localStorage.removeItem('canvas_theme'); localStorage.removeItem('deepwhite_canvas_material'); });
    });
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(paid, []);
  fs.writeFileSync(path.join(evidence,'results.json'), JSON.stringify({passed:true, checks, errors, external, paid}, null, 2));
  console.log(JSON.stringify({passed:checks.length,evidence}));
})().catch(async error => {
  process.exitCode = 1; console.error(error.stack); console.error(log.slice(-1800));
  await page?.screenshot({path:path.join(evidence,'failure.png')}).catch(() => {});
  fs.writeFileSync(path.join(evidence,'results.json'), JSON.stringify({passed:false, checks, error:String(error), errors, external, paid}, null, 2));
}).finally(async () => {
  await browser?.close();
  if (server) { server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(4000)]); }
  assert(path.dirname(runtime) === os.tmpdir() && path.basename(runtime).startsWith('dw-canvas-chrome-'));
  fs.rmSync(runtime, {recursive:true, force:true});
});
