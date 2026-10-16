'use strict';
// Repeated real editing and persistence in isolated canvases. No paid or external traffic.
// This bounded session measures retention after GC; it does not certify hours of use.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'data/local-path');

const root = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-session-stability-'));
const artifacts = path.join(os.tmpdir(), 'deepwhite-session-stability');
const cycles = Number(process.env.STABILITY_CYCLES || 60);
assert(Number.isInteger(cycles) && cycles >= 12 && cycles <= 600, 'Use 12–600 complete cycles');
const engines = (process.env.STABILITY_ENGINES || 'classic,smart').split(',');
assert(engines.length && engines.every(kind => ['classic', 'smart'].includes(kind)));
const model = 'deepwhiteai-image-g-v2.5-lowprice';
const errors = [], external = [], paid = [], unexpectedWrites = [], reports = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser, page, cdp, base, log = '';
const sourceFiles = ['js/canvas.js', 'js/smart-canvas.js', 'css/canvas.css', 'studio-layout-0927.js',
  'studio-canvas-v2.js', 'studio-canvas-v2.css', 'studio-smart-v2.js', 'studio-smart-v2.css',
  'studio-models.js', 'studio-canvas-history.js', 'studio-canvas-drafts.js'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'static', file))).digest('hex')]));

async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {method, headers: {'Content-Type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {})});
  assert(response.ok, await response.clone().text());
  return response.json();
}

function fixture(kind, label) {
  const nodes = [], connections = [];
  const settings = {engine: 'api', apiKind: 'image', provider_id: 'deepwhite', model, count: 1};
  for (let i = 0; i < 4; i++) {
    const text = `${label} 的独立上游文字 ${i}。`;
    const prompt = `${label} 的独立手写提示词 ${i}。`;
    const x = 120 + i * 660, y = 140;
    if (kind === 'classic') {
      nodes.push({id: 'text-' + i, type: 'prompt', studioTitle: 'TEXT ' + i, x, y, w: 280, h: 230, text},
        {id: 'image-' + i, type: 'generator', studioTitle: 'IMAGE ' + i, x: x + 310, y, w: 440,
          apiProvider: 'deepwhite', model, studioPrompt: prompt, legacyMeta: {label, i}});
    } else {
      nodes.push({id: 'text-' + i, type: 'smart-prompt', title: 'TEXT ' + i, x, y, w: 280, h: 230, text, llmEnabled: false},
        {id: 'image-' + i, type: 'smart-image', title: 'IMAGE ' + i, x: x + 310, y, scale: 1,
          images: [], runSettings: {...settings}, promptDraftHtml: prompt, promptDraftText: prompt,
          legacyMeta: {label, i}});
    }
    connections.push({id: 'wire-' + i, from: 'text-' + i, to: 'image-' + i, kind: 'input'});
  }
  return {nodes, connections, viewport: {x: 20, y: 90, scale: .75}};
}

function projection(canvas) {
  return {
    nodes: canvas.nodes.map(node => ({id: node.id, type: node.type, x: node.x, y: node.y,
      text: node.text, prompt: node.studioPrompt ?? node.promptDraftText,
      model: node.model ?? node.runSettings?.model, legacyMeta: node.legacyMeta})),
    links: canvas.connections.map(({id, from, to}) => ({id, from, to}))
  };
}

async function save(kind, id) {
  if (kind === 'smart') await page.locator('#smartV2Save').click();
  const visible = await page.evaluate(() => ({nodes: JSON.parse(JSON.stringify(nodes)),
    connections: JSON.parse(JSON.stringify(typeof connections === 'undefined' ? canvas.connections : connections))}));
  const expected = projection(visible);
  for (let attempt = 0; attempt < 100; attempt++) {
    const actual = projection((await api('/api/canvases/' + id)).canvas);
    const status = await page.locator(kind === 'classic' ? '#studioV2SaveState' : '#smartV2SaveStatus').innerText();
    if (JSON.stringify(actual) === JSON.stringify(expected) && status === '已保存') return actual;
    await delay(100);
  }
  assert.fail('saved fields did not persist to the active canvas');
}

async function focusImage(kind, index) {
  await page.locator(kind === 'classic' ? '#studioV2Search' : '#smartV2Search').click();
  const dialog = page.locator(kind === 'classic' ? '.v2-search-dialog[open]' : '#smartV2SearchDialog[open]');
  await dialog.locator('input').fill('IMAGE ' + index);
  await dialog.locator(kind === 'classic' ? '.v2-search-result' : '.sv2-search-result').click();
  const picker = kind === 'classic'
    ? `[data-id="image-${index}"] .studio-model-trigger` : '#dynamicParams .model-control .smart-pill';
  await page.locator(picker).click();
  await page.waitForFunction(() => document.querySelector('#studioModelPicker')?.matches(':popover-open'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#studioModelPicker').evaluate(el => el.childElementCount), 0,
    'closed model choices release closures');
  return page.locator(kind === 'classic' ? `[data-id="image-${index}"] .studio-prompt-input` : '#promptInput');
}

async function memory(kind, label) {
  await delay(350);
  await cdp.send('HeapProfiler.collectGarbage');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  const listeners = {};
  for (const expression of ['window', 'document', kind === 'classic' ? 'board' : 'shell']) {
    const result = await cdp.send('Runtime.evaluate', {expression, objectGroup: 'session-listeners'});
    listeners[expression] = (await cdp.send('DOMDebugger.getEventListeners', {objectId: result.result.objectId})).listeners.length;
  }
  await cdp.send('Runtime.releaseObjectGroup', {objectGroup: 'session-listeners'});
  const dom = await page.evaluate(() => ({live: document.querySelectorAll('*').length,
    menus: document.querySelectorAll('#studioModelPicker').length,
    composers: document.querySelectorAll('#composer').length,
    cards: document.querySelectorAll('#nodes .node[data-id],#world .image-node[data-id]').length}));
  return {label, heap: metrics.JSHeapUsedSize, retainedNodes: metrics.Nodes,
    retainedListeners: metrics.JSEventListeners, listeners, ...dom};
}

function retention(baseline, final, kind) {
  assert.deepEqual(final.listeners, baseline.listeners, kind + ' has no accumulated global handlers');
  assert.equal(final.cards, 8);
  assert.equal(final.menus, 1);
  assert.equal(final.composers, kind === 'smart' ? 1 : 0);
  assert(final.live <= baseline.live + 100, kind + ' live DOM grows after settled identical UI');
  assert(final.retainedNodes <= baseline.retainedNodes + 500, kind + ' retains detached DOM after GC');
  assert(final.retainedListeners <= baseline.retainedListeners + 120, kind + ' retains detached listeners after GC');
  assert(final.heap <= baseline.heap * 1.25 + 8 * 1024 * 1024, kind + ' heap exceeds bounded session guard');
}

async function main() {
  const sourceBefore = sourceHashes();
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  base = 'http://127.0.0.1:' + port;
  try {
    server = spawn(path.join(root, 'python/python.exe'), [path.join(root, 'tests/catalog-browser-server.py')],
      {cwd: root, windowsHide: true, env: {...process.env, DEEPWHITE_STUDIO_PORT: String(port),
        DEEPWHITE_STUDIO_RUNTIME_DIR: runtime, PYTHONUTF8: '1'}});
    server.stdout.on('data', chunk => log += chunk); server.stderr.on('data', chunk => log += chunk);
    let ready = false;
    for (let i = 0; i < 100; i++) {try {await api('/api/studio/health'); ready = true; break;} catch {await delay(150);}}
    assert(ready, log);
    await api('/api/studio/settings/sync-models', 'POST', {id: 'deepwhite', name: 'Offline session fixture',
      base_url: 'https://api.deepwhiteai.com/v1', api_key: 'offline-session-test', enabled: true, primary: true});
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE
      || 'data/local-path'});
    for (const kind of engines) {
      const ids = [], expected = new Map();
      for (const label of ['A', 'B']) {
        const c = (await api('/api/canvases', 'POST', {title: kind + ' session ' + label, kind})).canvas;
        await api('/api/canvases/' + c.id, 'PUT', {...c, ...fixture(kind, label), base_updated_at: c.updated_at});
        ids.push(c.id); expected.set(c.id, projection((await api('/api/canvases/' + c.id)).canvas));
      }
      const context = await browser.newContext({viewport: {width: 1500, height: 900}, reducedMotion: 'reduce'});
      page = await context.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push({kind, message: error.message}));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base) {external.push(url.origin); return route.abort();}
        if (request.method() === 'POST' && /^\/api\/(?:studio\/(?:generations|mj\/submit|runninghub\/tasks)|canvas-(?:image|video|llm|comfy)|online-image|generate|midjourney\/(?:submit|actions|modal)|runninghub\/(?:submit|workflow))/.test(url.pathname)) {
          paid.push(url.pathname); return route.abort();
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          const saveOwnCanvas = request.method() === 'PUT' && ids.some(id => url.pathname === '/api/canvases/' + id);
          const touchOwnCanvas = request.method() === 'POST' && ids.some(id => url.pathname === '/api/canvases/' + id + '/touch');
          const quote = request.method() === 'POST' && url.pathname === '/api/studio/quote';
          if (!saveOwnCanvas && !touchOwnCanvas && !quote) {
            unexpectedWrites.push({method: request.method(), path: url.pathname}); return route.abort();
          }
        }
        return route.continue();
      });
      cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      await page.goto(base + `/static/${kind === 'classic' ? 'canvas' : 'smart-canvas'}.html?id=${ids[0]}`);
      await page.waitForFunction(kind => canvas?.id && nodes.length === 8 && (kind === 'classic'
        ? window.StudioCanvasV2?.ready : window.StudioSmartV2), kind);
      let baseline; const samples = [], began = Date.now();
      for (let cycle = -8; cycle < cycles; cycle++) {
        // Each eight-cycle round edits the same four node IDs in both classic projects.
        const index = ((Math.floor(cycle / 2) % 4) + 4) % 4;
        // Classic has same-page project switching. Smart's ID is fixed per document;
        // exercise its repeated native render/update cycle without page reloads.
        const id = kind === 'classic' ? ids[((cycle % 2) + 2) % 2] : ids[0];
        if (kind === 'classic') {
          await page.evaluate(id => openCanvas(id), id);
          await page.waitForFunction(id => canvas?.id === id && nodes.length === 8, id);
          assert.deepEqual(projection(await page.evaluate(() => ({nodes, connections}))), expected.get(id));
        }
        const input = await focusImage(kind, index);
        const text = `${kind} / ${id} / cycle ${cycle} / image ${index}：持续编辑的独立草稿。`;
        const next = structuredClone(expected.get(id));
        next.nodes.find(node => node.id === 'image-' + index).prompt = text;
        await input.fill(text);
        const saved = await save(kind, id);
        assert.deepEqual(saved, next, 'only the explicitly edited node prompt may change');
        expected.set(id, next);
        if (kind === 'smart') {
          await page.evaluate(() => render());
          assert.equal(await page.locator('#promptInput').innerText(), expected.get(id).nodes.find(n => n.id === 'image-' + index).prompt);
        }
        if (cycle === -1) {baseline = await memory(kind, 'warm'); samples.push(baseline);}
        if (cycle >= 0 && ((cycle + 1) % 15 === 0 || cycle === cycles - 1)) {
          // Align the selected controls with warm-up before comparing DOM retention.
          await focusImage(kind, 3);
          const sample = await memory(kind, 'cycle-' + (cycle + 1)); samples.push(sample);
          retention(baseline, sample, kind);
          console.log(JSON.stringify({kind, cycle: cycle + 1, elapsedMs: Date.now() - began, sample}));
        }
      }
      for (const id of ids) assert.deepEqual(projection((await api('/api/canvases/' + id)).canvas), expected.get(id));
      reports.push({kind, cycles, elapsedMs: Date.now() - began, samples});
      await context.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(paid, []);
    assert.deepEqual(unexpectedWrites, []);
    assert.deepEqual(sourceHashes(), sourceBefore, 'tested source must stay unchanged during the session');
    fs.mkdirSync(artifacts, {recursive: true});
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({cycles, browser: browser.version(),
      sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
      sourceStatus: execFileSync('git', ['status', '--short'], {cwd: root, encoding: 'utf8'}).trim(),
      runtimeVersion: (await api('/api/studio/health')).version, viewport: {width: 1500, height: 900},
      reducedMotion: 'reduce', platform: os.platform(), createdAt: new Date().toISOString(),
      sourceHashes: sourceBefore, reports, errors, external, paid, unexpectedWrites}, null, 2));
    console.log('Bounded session checks passed: ' + artifacts);
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('isolated session server did not exit')), 8000);
      server.once('close', () => {clearTimeout(timer); resolve();}); server.kill();
    });
    const resolved = path.resolve(runtime);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert(path.basename(resolved).startsWith('dw-session-stability-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  }
}
main().catch(error => {console.error(error.stack); console.error({errors, external, paid, unexpectedWrites});
  console.error(log.slice(-1500)); process.exitCode = 1;});
