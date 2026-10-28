'use strict';
// Real classic-canvas input with a disposable local server/profile. No upstream calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-phase1-interactions-'));
const evidence = process.env.PHASE1_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'dw-phase1-interaction-evidence-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [], errors = [], external = [], generation = [];
let server, browser, page, base, serverLog = '';
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {method, headers: {'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  assert(response.ok, await response.clone().text());
  return response.json();
}
async function view() { return page.evaluate(() => ({...viewport})); }
async function blank() {
  return page.evaluate(() => {
    const surface = document.querySelector('.smart-back') ? document.getElementById('shell') : document.getElementById('board');
    const backgrounds = [surface, document.getElementById('world'), document.getElementById('nodes'), document.getElementById('links')];
    const rect = surface.getBoundingClientRect();
    for (const fy of [.65, .45, .8, .3]) for (const fx of [.8, .65, .45, .3]) {
      const point = {x: rect.left + rect.width * fx, y: rect.top + rect.height * fy};
      if (backgrounds.includes(document.elementFromPoint(point.x, point.y))) return point;
    }
    throw Error('No unobstructed canvas point');
  });
}
async function header(id) {
  return page.evaluate(id => {
    const rect = nodesEl.querySelector(`[data-id="${CSS.escape(id)}"] .node-head`).getBoundingClientRect();
    return {x: rect.x + 75, y: rect.y + rect.height / 2};
  }, id);
}
async function clickBlank() {const point = await blank(); await page.mouse.click(point.x, point.y);}
async function fixture(title, kind = 'classic') {
  const canvas = (await api('/api/canvases', 'POST', {title, kind})).canvas;
  if (kind === 'smart') {
    await api('/api/canvases/' + canvas.id, 'PUT', {...canvas, base_updated_at: canvas.updated_at,
      nodes: [{id: 'smart-text', type: 'smart-prompt', x: 120, y: 160, w: 316, h: 240, title: '滚动测试', text: '智能画布的长文本。\n'.repeat(100), llmEnabled: false}], connections: [], viewport: {x: 0, y: 0, scale: 1}});
    await page.goto(base + '/static/smart-canvas.html?id=' + canvas.id);
    await page.waitForFunction(id => canvas?.id === id && window.StudioSmartV2, canvas.id);
    await page.locator('[data-id="smart-text"] .prompt-node-text').waitFor(); await sleep(150); return;
  }
  await api('/api/canvases/' + canvas.id, 'PUT', {...canvas, base_updated_at: canvas.updated_at,
    viewport: {x: 100, y: 100, scale: 1}, nodes: [
      {id: 'prompt', type: 'prompt', x: 40, y: 100, w: 280, h: 230, text: '源文字\n'.repeat(100)},
      {id: 'image', type: 'generator', x: 400, y: 100, w: 440, apiProvider: 'offline', model: 'deepwhiteai-image-g2', studioPrompt: '需要逐行滚动检查的本地提示词。\n'.repeat(100)}
    ], connections: [{id: 'wire', from: 'prompt', to: 'image'}]});
  await page.goto(base + '/static/canvas.html?id=' + canvas.id);
  await page.waitForFunction(id => canvas?.id === id && window.StudioCanvasV2?.ready, canvas.id);
  await page.locator('[data-id="image"] .studio-prompt-input').waitFor();
  await sleep(150);
}
async function check(name, body, kind = 'classic') {
  try {await fixture(name, kind); await body(); results.push({name, passed: true}); console.log('PASS ' + name);}
  catch (error) {results.push({name, passed: false, error: error.message}); console.error('FAIL ' + name + ': ' + error.message); await page.screenshot({path: path.join(evidence, 'failure-' + results.length + '.png')}).catch(() => {});}
  finally {for (const key of ['Alt', 'Control', 'Meta', 'Shift']) await page.keyboard.up(key).catch(() => {});}
}
async function wheel(dx, dy, key) {
  const point = await blank(); await page.mouse.move(point.x, point.y);
  if (key) await page.keyboard.down(key);
  await page.mouse.wheel(dx, dy); await sleep(70);
  if (key) await page.keyboard.up(key);
}
async function main() {
  fs.mkdirSync(evidence, {recursive: true});
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); base = 'http://127.0.0.1:' + port;
  try {
    const bundled = path.join(root, 'python/python.exe');
    const python = process.env.PYTHON_EXECUTABLE || (fs.existsSync(bundled) ? bundled : 'python');
    server = spawn(python, ['-B', path.join(root, 'tests/catalog-browser-server.py')], {cwd: root, windowsHide: true,
      env: {...process.env, DEEPWHITE_STUDIO_RUNTIME_DIR: runtime, DEEPWHITE_STUDIO_PORT: String(port), PYTHONUTF8: '1'}});
    server.on('error', error => {serverLog += error.stack;});
    server.stdout.on('data', data => {serverLog += data;}); server.stderr.on('data', data => {serverLog += data;});
    let ready = false;
    for (let i = 0; i < 120; i++) {try {await api('/api/studio/health'); ready = true; break;} catch {if (server.exitCode !== null) break; await sleep(150);}}
    assert(ready, serverLog);
    await api('/api/studio/settings/sync-models', 'POST', {id: 'offline', name: 'Phase 1 offline fixture', base_url: 'https://api.deepwhiteai.com/v1', api_key: 'offline-fixture', enabled: true, primary: true});
    browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
    const context = await browser.newContext({viewport: {width: 1500, height: 1000}, reducedMotion: 'reduce'});
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) {external.push(url.origin); return route.abort();}
      if (request.method() === 'POST' && /\/api\/(?:studio\/generations|canvas-(?:image|comfy)-tasks|canvas-(?:video|llm)|online-image|generate(?:\/|$)|midjourney\/(?:submit|actions|modal)|runninghub\/(?:submit|workflow)|studio\/runninghub\/tasks|studio\/mj\/submit)/.test(url.pathname)) {
        generation.push(url.pathname); return route.fulfill({status: 503, json: {detail: 'Generation forbidden in interaction verification'}});
      }
      return route.continue();
    });
    await check('Alt drag is one undoable copy and redo restores its final position', async () => {
      const start = await header('prompt'); await page.mouse.move(start.x, start.y); await page.keyboard.down('Alt');
      await page.mouse.down(); await page.mouse.move(start.x + 55, start.y + 35, {steps: 8}); await page.mouse.up(); await page.keyboard.up('Alt');
      const copied = await page.evaluate(() => nodes.filter(n => !['prompt', 'image'].includes(n.id)).map(n => ({id: n.id, x: n.x, y: n.y})));
      assert.equal(copied.length, 1); assert(copied[0].x > 40 && copied[0].y > 100, 'the copy moved, allowing the existing grid snap');
      await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(() => nodes.length), 2, 'one undo must remove only the Alt-created copy');
      await page.keyboard.press('Control+Shift+z');
      assert.deepEqual(await page.evaluate(() => nodes.filter(n => !['prompt', 'image'].includes(n.id)).map(n => ({id: n.id, x: n.x, y: n.y}))), copied);
    });
    await check('Focus without typing keeps the redo branch', async () => {
      const point = await header('prompt'); await page.mouse.click(point.x, point.y);
      await page.keyboard.press('Control+d'); assert.equal(await page.evaluate(() => nodes.length), 3);
      await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(() => nodes.length), 2);
      await page.locator('[data-id="image"] .studio-prompt-input').click(); await clickBlank();
      await page.keyboard.press('Control+Shift+z'); assert.equal(await page.evaluate(() => nodes.length), 3, 'a no-op focus must not discard redo');
    });
    await check('Alt Shift copy preserves incoming links and undo removes only the copy', async () => {
      const start = await header('image'); await page.mouse.move(start.x, start.y); await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
      await page.mouse.down(); await page.mouse.move(start.x + 60, start.y + 40, {steps: 8}); await page.mouse.up(); await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
      const copied = await page.evaluate(() => ({id: nodes.find(n => !['prompt', 'image'].includes(n.id))?.id, edges: connections.map(({from, to}) => ({from, to}))}));
      assert(copied.id); assert(copied.edges.some(edge => edge.from === 'prompt' && edge.to === copied.id)); assert.equal(copied.edges.length, 2);
      await page.keyboard.press('Control+z'); assert.deepEqual(await page.evaluate(() => ({ids: nodes.map(n => n.id).sort(), edges: connections.map(({from, to}) => ({from, to}))})), {ids: ['image', 'prompt'], edges: [{from: 'prompt', to: 'image'}]});
    });
    await check('A real prompt editing session has one undo and can be redone', async () => {
      const input = page.locator('[data-id="image"] .studio-prompt-input'), original = await input.inputValue();
      await input.fill('第一段'); await page.keyboard.insertText('，第二段'); await clickBlank();
      await page.keyboard.press('Control+z'); assert.equal(await input.inputValue(), original);
      await page.keyboard.press('Control+Shift+z'); assert.equal(await input.inputValue(), '第一段，第二段');
    });
    await check('Long prompt scrolling stays inside its textarea', async () => {
      const input = page.locator('[data-id="image"] .studio-prompt-input'); await input.hover(); const before = await view();
      await page.mouse.wheel(0, 180); await sleep(100);
      assert.deepEqual(await view(), before, 'scrolling text must not transform the canvas');
      assert(await input.evaluate(element => element.scrollTop) > 0, 'native textarea scroll must remain available');
    });
    await check('Scrollable upstream panel does not transform the canvas', async () => {
      const list = page.locator('[data-id="image"] .studio-upstream-list'); await list.hover(); const before = await view();
      await page.mouse.wheel(0, 150); await sleep(100); assert.deepEqual(await view(), before);
      assert(await list.evaluate(element => element.scrollTop) > 0);
    });
    await check('Horizontal and diagonal trackpad input pans without changing scale', async () => {
      const before = await view(); await wheel(45, 25); const after = await view();
      assert.equal(after.scale, before.scale); assert.equal(after.x, before.x - 45); assert.equal(after.y, before.y - 25);
    });
    await check('Shift vertical wheel pans horizontally without zoom', async () => {
      const before = await view(); await wheel(0, 120, 'Shift'); const after = await view();
      assert.equal(after.scale, before.scale); assert.equal(after.x, before.x - 120); assert.equal(after.y, before.y);
    });
    await check('Vertical wheel zoom magnitude follows delta and opposite deltas cancel', async () => {
      // A plain wheel pans; Ctrl+wheel zooms (the canvas v2 design).
      const initial = await view(); await wheel(0, -20, 'Control'); const small = await view(); await wheel(0, 20, 'Control'); const restored = await view();
      assert(Math.abs(restored.scale - initial.scale) < 1e-10, 'equal opposite deltas must cancel, without zoom drift');
      await wheel(0, -100, 'Control'); const large = await view(); assert(large.scale - restored.scale > (small.scale - initial.scale) * 2, 'larger wheel input must cause larger zoom');
    });
    await check('Ctrl zoom preserves the pointer anchor and takes priority over pan', async () => {
      const point = await blank(); await page.mouse.move(point.x, point.y);
      const before = await page.evaluate(point => ({world: screenToWorld(point.x, point.y), scale: viewport.scale}), point);
      await page.keyboard.down('Control'); await page.mouse.wheel(20, -60); await sleep(100); await page.keyboard.up('Control');
      const after = await page.evaluate(point => ({world: screenToWorld(point.x, point.y), scale: viewport.scale}), point);
      assert(after.scale > before.scale); assert(Math.abs(after.world.x - before.world.x) < 1e-8); assert(Math.abs(after.world.y - before.world.y) < 1e-8);
    });
    await check('Zero wheel delta does not zoom or dirty the view', async () => {
      const before = await view(), point = await blank();
      await page.evaluate(point => document.elementFromPoint(point.x, point.y).dispatchEvent(new WheelEvent('wheel', {bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, deltaX: 0, deltaY: 0})), point);
      await sleep(50); assert.deepEqual(await view(), before);
    });
    await check('Wheel zoom bounds remain finite at both extremes', async () => {
      await wheel(0, -1e7, 'Control'); const max = await view(); /* ZOOM_MAX = 8 in studio-canvas-v2.js */assert(max.scale <= 8 && max.scale > 1, 'max zoom '+JSON.stringify(max)); assert(Number.isFinite(max.x) && Number.isFinite(max.y));
      await wheel(0, 1e7, 'Control'); const min = await view(); assert(min.scale >= .06 && min.scale < 1, 'min zoom '+JSON.stringify(min)); assert(Number.isFinite(min.x) && Number.isFinite(min.y));
    });
    await check('Smart horizontal and diagonal wheel pans without changing scale', async () => {
      const before = await view(); await wheel(45, 25); const after = await view();
      assert.equal(after.scale, before.scale); assert.equal(after.x, before.x - 45); assert.equal(after.y, before.y - 25);
    }, 'smart');
    await check('Smart Shift wheel pans horizontally without zoom', async () => {
      const before = await view(); await wheel(0, 120, 'Shift'); const after = await view();
      assert.equal(after.scale, before.scale); assert.equal(after.x, before.x - 120); assert.equal(after.y, before.y);
    }, 'smart');
    await check('Smart Ctrl wheel retains its anchor and opposite deltas cancel', async () => {
      const point = await blank(); await page.mouse.move(point.x, point.y);
      const before = await page.evaluate(point => ({world: screenToWorld({clientX: point.x, clientY: point.y}), scale: viewport.scale}), point);
      await page.keyboard.down('Control'); await page.mouse.wheel(20, -60); await sleep(100);
      const after = await page.evaluate(point => ({world: screenToWorld({clientX: point.x, clientY: point.y}), scale: viewport.scale}), point);
      assert(after.scale > before.scale); assert(Math.abs(after.world.x - before.world.x) < 1e-8); assert(Math.abs(after.world.y - before.world.y) < 1e-8);
      await page.mouse.wheel(-20, 60); await sleep(100); await page.keyboard.up('Control'); assert(Math.abs((await view()).scale - before.scale) < 1e-10);
    }, 'smart');
    await check('Smart long text scroll remains isolated from the canvas', async () => {
      const input = page.locator('[data-id="smart-text"] .prompt-node-text'); await input.hover(); const before = await view();
      await page.mouse.wheel(0, 180); await sleep(100); assert.deepEqual(await view(), before); assert(await input.evaluate(element => element.scrollTop) > 0);
    }, 'smart');
    await check('Smart repeated zoom stays within usable finite bounds', async () => {
      for (let i = 0; i < 5; i++) await wheel(0, -1000, 'Control');
      const max = await view(); assert(max.scale <= 8 && max.scale > 1, 'zoom must not grow beyond usable canvas limits '+JSON.stringify(max)); assert(Number.isFinite(max.x) && Number.isFinite(max.y));
      for (let i = 0; i < 10; i++) await wheel(0, 1000, 'Control');
      const min = await view(); assert(min.scale >= .06 && min.scale < 1); assert(Number.isFinite(min.x) && Number.isFinite(min.y));
    }, 'smart');
    await page.locator('#smartV2Fit').click(); await sleep(100);
    await page.screenshot({path: path.join(evidence, 'final-canvas.png')});
    assert.deepEqual(errors, [], 'no browser execution errors'); assert.deepEqual(external, [], 'no external browser requests'); assert.deepEqual(generation, [], 'no paid generation requests');
    const report = {passed: results.every(result => result.passed), tests: results.length, results, errors, external, generation, browser: browser.version(), evidence};
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(evidence, 'server.log'), serverLog);
    await browser?.close();
    if (server && server.exitCode === null) {const closed = new Promise(resolve => server.once('close', resolve)); server.kill(); await Promise.race([closed, sleep(8000)]);}
    const resolved = path.resolve(runtime), temporary = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), temporary.toLowerCase()); assert(path.basename(resolved).startsWith('dw-phase1-interactions-'));
    fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
}
main().catch(error => {console.error(error.stack); console.error(serverLog.slice(-2200)); process.exitCode = 1;});
