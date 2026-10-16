'use strict';
// Diagnostic, not a zero-leak gate. Product code and editing history remain untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'data/local-path');
const root = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-editor-retention-'));
const phase = process.env.RETENTION_PHASE || 'post-fix'; assert(['pre-fix', 'post-fix'].includes(phase));
const artifacts = path.join(os.tmpdir(), 'deepwhite-smart-editor-retention' + (phase === 'post-fix' ? '-post-fix' : ''));
const cycles = Number(process.env.RETENTION_CYCLES || 300);
assert(Number.isInteger(cycles) && cycles >= 10 && cycles <= 600);
const cohorts = (process.env.RETENTION_COHORTS || 'bare-fill,bare-script,textarea-fill,bare-cdp,smart-fill,smart-ui,smart-full').split(',');
const sourceFiles = ['js/smart-canvas.js', 'studio-smart-v2.js', 'studio-models.js', 'studio-canvas-history.js', 'studio-canvas-drafts.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'static', file))).digest('hex')]));
const beforeHashes = hashes(), errors = [], blocked = [], reports = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, server, base, log = '';
fs.mkdirSync(artifacts, {recursive: true});

async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {method, headers: {'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  assert(response.ok, await response.clone().text()); return response.json();
}
function fixture() {
  const model = 'deepwhiteai-image-g-v2.5-lowprice';
  return {nodes: [0, 1].map(i => ({id: 'image-' + i, type: 'smart-image', title: 'EDITOR ' + i,
    x: 120 + i * 650, y: 100, scale: 1, images: [], promptDraftHtml: 'initial-' + i,
    promptDraftText: 'initial-' + i, runSettings: {engine: 'api', apiKind: 'image', provider_id: 'deepwhite', model, count: 1}})),
    connections: [], viewport: {x: 20, y: 60, scale: .75}};
}
async function select(page, i) {
  await page.locator('#smartV2Search').click();
  const dialog = page.locator('#smartV2SearchDialog[open]');
  await dialog.locator('input').fill('EDITOR ' + i);
  await dialog.locator('.sv2-search-result').click();
  await page.waitForFunction(i => activeComposerNode()?.id === 'image-' + i, i);
}
async function selectWithoutSearchEdit(page, i) {
  await page.locator('#smartV2Search').click();
  await page.locator(`#smartV2SearchDialog[open] .sv2-search-result[data-node-id="image-${i}"]`).click();
  await page.waitForFunction(i => activeComposerNode()?.id === 'image-' + i, i);
}
async function modelMenu(page) {
  await page.locator('#dynamicParams .model-control .smart-pill').click();
  await page.waitForFunction(() => document.querySelector('#studioModelPicker').matches(':popover-open'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#studioModelPicker').evaluate(el => el.childElementCount), 0);
}
async function save(page, id) {
  await page.locator('#smartV2Save').click();
  for (let i = 0; i < 80; i++) {
    const expected = await page.evaluate(() => nodes.map(n => ({id: n.id, text: n.promptDraftText})));
    const actual = (await api('/api/canvases/' + id)).canvas.nodes.map(n => ({id: n.id, text: n.promptDraftText}));
    if (JSON.stringify(expected) === JSON.stringify(actual) && await page.locator('#smartV2SaveStatus').innerText() === '已保存') return actual;
    await delay(100);
  }
  assert.fail('isolated draft save did not complete');
}
async function memory(page, cdp, label) {
  await delay(300); await cdp.send('HeapProfiler.collectGarbage');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  return {label, nodes: metrics.Nodes, listeners: metrics.JSEventListeners, heap: metrics.JSHeapUsedSize,
    live: await page.evaluate(() => document.querySelectorAll('*').length)};
}
async function snapshot(cdp, name) {
  const file = path.join(artifacts, name + '.heapsnapshot'), fd = fs.openSync(file, 'w');
  const append = ({chunk}) => fs.writeSync(fd, chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', append);
  try {await cdp.send('HeapProfiler.takeHeapSnapshot', {reportProgress: false, captureNumericValue: false});}
  finally {cdp.off('HeapProfiler.addHeapSnapshotChunk', append); fs.closeSync(fd);}
  return file;
}
function heapIds(file) {
  const h = JSON.parse(fs.readFileSync(file, 'utf8')), fields = h.snapshot.meta.node_fields, width = fields.length, ids = new Set();
  const id = fields.indexOf('id'); for (let i = 0; i < h.nodes.length; i += width) ids.add(h.nodes[i + id]);
  ids.counts = heapCounts(h);
  return ids;
}
function heapCounts(h) {
  const f=h.snapshot.meta.node_fields,w=f.length,t=h.snapshot.meta.node_types[f.indexOf('type')],byType={},nativeNames={};
  for(let i=0;i<h.nodes.length;i+=w){const type=t[h.nodes[i+f.indexOf('type')]],name=h.strings[h.nodes[i+f.indexOf('name')]],item=byType[type]||(byType[type]={count:0,selfBytes:0});
    item.count++;item.selfBytes+=h.nodes[i+f.indexOf('self_size')];
    if(type==='native'&&['Text','<br>','blink::UndoStep','blink::UndoStack'].includes(name))nativeNames[name]=(nativeNames[name]||0)+1;
  }
  return {byType,nativeNames};
}
function inspectHeap(file, oldIds) {
  const h = JSON.parse(fs.readFileSync(file, 'utf8')), m = h.snapshot.meta;
  const nf = m.node_fields, ef = m.edge_fields, nw = nf.length, ew = ef.length;
  const ni = Object.fromEntries(nf.map((name, i) => [name, i])), ei = Object.fromEntries(ef.map((name, i) => [name, i]));
  const types = m.node_types[ni.type], edgeTypes = m.edge_types[ei.type], count = h.nodes.length / nw;
  const starts = new Int32Array(count + 1), parent = new Int32Array(count).fill(-1), via = new Int32Array(count).fill(-1);
  const nativeNew = {}, detachedNew = {}, candidates = [], undoObjects = [];
  for (let i = 0, edge = 0; i < count; i++) {
    starts[i] = edge; edge += h.nodes[i * nw + ni.edge_count] * ew;
    const name = h.strings[h.nodes[i * nw + ni.name]], type = types[h.nodes[i * nw + ni.type]];
    if (/UndoStack|EditCommand|EditingState|UndoStep/.test(name)) undoObjects.push({type, name, id: h.nodes[i * nw + ni.id]});
    if (oldIds.has(h.nodes[i * nw + ni.id]) || type !== 'native') continue;
    nativeNew[name] = (nativeNew[name] || 0) + 1;
    if (ni.detachedness !== undefined && h.nodes[i * nw + ni.detachedness] === 2) detachedNew[name] = (detachedNew[name] || 0) + 1;
    if (name === 'Text' || /HTML(?:Div|Span|BRElement)|UndoStack|EditCommand|UndoStep/.test(name)) candidates.push(i);
  }
  starts[count] = h.edges.length;
  const queue = new Int32Array(count); let tail = 1; queue[0] = 0; parent[0] = 0;
  // Shortest strong path from snapshot root. Weak edges are never treated as retainers.
  for (let head = 0; head < tail; head++) {
    const node = queue[head];
    for (let e = starts[node]; e < starts[node + 1]; e += ew) {
      if (edgeTypes[h.edges[e + ei.type]] === 'weak') continue;
      const to = h.edges[e + ei.to_node] / nw;
      if (parent[to] !== -1) continue;
      parent[to] = node; via[to] = e; queue[tail++] = to;
    }
  }
  const paths = candidates.slice(0, 16).map(target => {
    const chain = []; let at = target;
    for (let step = 0; step < 40 && at >= 0; step++) {
      const e = via[at], edgeType = e < 0 ? '' : edgeTypes[h.edges[e + ei.type]];
      const edgeName = e < 0 ? '' : ['element', 'hidden'].includes(edgeType) ? String(h.edges[e + ei.name_or_index]) : h.strings[h.edges[e + ei.name_or_index]];
      chain.push({type: types[h.nodes[at * nw + ni.type]], name: h.strings[h.nodes[at * nw + ni.name]], edge: edgeName});
      if (at === 0 || parent[at] < 0) break; at = parent[at];
    }
    return {id: h.nodes[target * nw + ni.id], rootReachable: parent[target] >= 0, path: chain.reverse()};
  });
  // Newly assigned object IDs include replacements of live UI; they are not all leaked objects.
  return {nativeNew, detachedNew, baselineCounts:oldIds.counts,finalCounts:heapCounts(h),undoObjects: undoObjects.slice(0, 30), paths};
}
async function prepareSmart(context, label) {
  const c = (await api('/api/canvases', 'POST', {title: 'Retention ' + label, kind: 'smart'})).canvas;
  await api('/api/canvases/' + c.id, 'PUT', {...c, ...fixture(), base_updated_at: c.updated_at});
  const page = await context.newPage(); page.setDefaultTimeout(12000); const ownIds = new Set([c.id]);
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== base) {blocked.push({kind: 'external', path: url.origin}); return route.abort();}
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      const allowed = req.method() === 'PUT' && [...ownIds].some(id => url.pathname === '/api/canvases/' + id)
        || req.method() === 'POST' && (url.pathname === '/api/studio/quote' || [...ownIds].some(id => url.pathname === '/api/canvases/' + id + '/touch'));
      if (!allowed) {blocked.push({kind: 'write', path: url.pathname}); return route.abort();}
    }
    return route.continue();
  });
  await page.goto(base + '/static/smart-canvas.html?id=' + c.id);
  await page.waitForFunction(() => window.StudioSmartV2 && nodes.length === 2);
  await select(page, 0); return {page, id: c.id, allowCanvas: id => ownIds.add(id)};
}
async function runCohort(kind) {
  const context = await browser.newContext({viewport: {width: 1500, height: 900}, reducedMotion: 'reduce'});
  try {
    let page, id; const smart = kind.startsWith('smart');
    if (smart) {
      ({page, id} = await prepareSmart(context, kind));
      if (kind === 'smart-ui-no-search-fill') {
        await page.locator('#smartV2Search').click();
        await page.locator('#smartV2SearchInput').fill('');
        await page.keyboard.press('Escape');
      }
    }
    else {
      page = await context.newPage();
      await page.setContent(kind === 'textarea-fill' ? '<textarea id="edit">initial</textarea>' : '<div id="edit" contenteditable="true">initial</div>');
    }
    const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
    const input = page.locator(smart ? '#promptInput' : '#edit');
    const edit = async i => {
      const value = `retention-${kind}-${i} independent prompt`;
      if (kind === 'smart-ui-no-search-fill') {await selectWithoutSearchEdit(page, ((i % 2) + 2) % 2); await modelMenu(page); await page.evaluate(() => render()); return;}
      if (kind === 'smart-ui') {await select(page, ((i % 2) + 2) % 2); await modelMenu(page); await page.evaluate(() => render()); return;}
      if (kind === 'smart-full') {await select(page, ((i % 2) + 2) % 2); await modelMenu(page);}
      if (kind === 'bare-script') await input.evaluate((el, value) => {el.textContent = value; el.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}));}, value);
      else if (kind === 'bare-cdp') {
        // No element handle or Runtime objectId is returned to the client.
        const selected = await cdp.send('Runtime.evaluate', {expression: "(()=>{document.getElementById('edit').focus();getSelection().selectAllChildren(document.getElementById('edit'));})()", returnByValue: true});
        assert.equal(selected.exceptionDetails, undefined);
        await cdp.send('Input.insertText', {text: value});
      } else await input.fill(value);
      if (kind === 'smart-full') {await save(page, id); await page.evaluate(() => render());}
    };
    for (let i = -8; i < 0; i++) await edit(i);
    if (smart) await (kind === 'smart-ui-no-search-fill' ? selectWithoutSearchEdit(page, 0) : select(page, 0));
    const baseline = await memory(page, cdp, 'warm');
    const firstHeap = await snapshot(cdp, kind + '-warm');
    const oldIds = heapIds(firstHeap), samples = [baseline];
    for (let i = 0; i < cycles; i++) {
      await edit(i);
      if ((i + 1) % 100 === 0 || i === cycles - 1) samples.push(await memory(page, cdp, String(i + 1)));
    }
    if (smart) await (kind === 'smart-ui-no-search-fill' ? selectWithoutSearchEdit(page, 0) : select(page, 0));
    const final = await memory(page, cdp, 'final');
    const finalHeap = await snapshot(cdp, kind + '-final');
    const heap = inspectHeap(finalHeap, oldIds);
    // Inspector handles deliberately created here are released before a final GC comparison.
    await cdp.send('Runtime.releaseObjectGroup', {objectGroup: 'session-listeners'});
    await cdp.detach();
    const fresh = await context.newCDPSession(page); await fresh.send('Performance.enable');
    const afterSessionRelease = await memory(page, fresh, 'after-CDP-session-release');
    const report = {kind, cycles, baseline, final, afterSessionRelease, samples, heap, firstHeap, finalHeap};
    reports.push(report); console.log(JSON.stringify({kind, baseline, final, afterSessionRelease,
      newText: heap.nativeNew.Text, newUndoSteps: heap.nativeNew['blink::UndoStep']}));
    fs.writeFileSync(path.join(artifacts, kind + '-analysis.json'), JSON.stringify(report, null, 2));
  } finally {await context.close();}
}
async function nodeUndoOwnership() {
  const cases = [];
  const scenarios = (process.env.RETENTION_UNDO_CASES || 'direct-typed,after-save-typed,blur-only-typed,save-with-focus,after-save-new-typed,saved-fill,unsaved-fill,typed,switch-before-B-edit').split(',');
  for (const scenario of scenarios) {
  const context = await browser.newContext({viewport: {width: 1500, height: 900}, reducedMotion: 'reduce'});
  try {
    const {page, id} = await prepareSmart(context, 'node-undo-' + scenario);
    await page.evaluate(guardAppend => {
      window.__retentionInputEvents = []; window.__retentionBeforeInput = []; window.__retentionKeys = [];
      window.__retentionDOMTrace = [];
      const trace = kind => window.__retentionDOMTrace.push({kind, focus: document.activeElement?.id, stack: new Error().stack.split('\n').slice(2, 6).join('\n')});
      const append = world.appendChild;
      world.appendChild = function(node) {if(node === composer) {trace(guardAppend && node.parentNode === world ? 'composer-append-skipped-control' : 'composer-append'); if(guardAppend && node.parentNode === world) return node;} return append.call(this, node);};
      const load = loadPromptDraft; loadPromptDraft = function(...args) {trace('load-prompt-draft'); return load.apply(this, args);};
      const setText = setPromptText; setPromptText = function(...args) {trace('set-prompt-text'); return setText.apply(this, args);};
      promptInput.addEventListener('input', e => window.__retentionInputEvents.push({type: e.inputType, owner: activeComposerNode()?.id, text: promptInput.innerText}));
      promptInput.addEventListener('beforeinput', e => window.__retentionBeforeInput.push({type: e.inputType, owner: activeComposerNode()?.id}));
      document.addEventListener('keydown', e => {if(e.ctrlKey && e.key.toLowerCase() === 'z') queueMicrotask(() => window.__retentionKeys.push({target: e.target.id, prevented: e.defaultPrevented}));});
    }, process.env.RETENTION_GUARD_APPEND === '1');
    const states = []; const capture = async label => states.push({label, ...await page.evaluate(() => {
      const s = getSelection(); return {owner: activeComposerNode()?.id, text: promptInput.innerText, active: document.activeElement?.id,
        caret: {inPrompt: promptInput.contains(s?.anchorNode), offset: s?.anchorOffset, focusOffset: s?.focusOffset, collapsed: s?.isCollapsed},
        drafts: nodes.map(n => ({id: n.id, text: n.promptDraftText})), events: window.__retentionInputEvents.slice(), beforeInput: window.__retentionBeforeInput.slice(), keys: window.__retentionKeys.slice(), domTrace: window.__retentionDOMTrace.slice()};
    })});
    if (['direct-typed', 'after-save-typed', 'blur-only-typed', 'save-with-focus', 'after-save-new-typed'].includes(scenario)) {
      await capture('before-typing'); await page.locator('#promptInput').click(); await page.keyboard.press('End');
      await page.keyboard.type('-DIRECT-typed'); await capture('after-typing');
      if (scenario.startsWith('after-save')) {await save(page, id); await page.locator('#promptInput').click(); await page.keyboard.press('End');}
      if (scenario === 'after-save-new-typed') {await page.keyboard.type('-AFTER'); await capture('after-new-typing');}
      if (scenario === 'blur-only-typed') {await page.locator('#smartV2Search').click(); await page.keyboard.press('Escape'); await page.locator('#promptInput').click(); await page.keyboard.press('End');}
      if (scenario === 'save-with-focus') await page.evaluate(() => saveCanvas());
      await capture('before-undo');
      await page.keyboard.press('Control+z'); await delay(150); await capture('after-undo');
      const persisted = await save(page, id), result = {scenario, states, persisted,
        undoChangedText: states.at(-1).text !== states.at(-2).text,
        restoredOriginalInOneStep: states.at(-1).text === states[0].text,
        untouchedB: states.every(s => s.drafts.find(n => n.id === 'image-1').text === 'initial-1'),
        historyInputEvents: states.at(-1).events.filter(e => ['historyUndo', 'historyRedo'].includes(e.type))};
      assert.deepEqual(persisted, states.at(-1).drafts, 'input result persists without changing another node');
      assert(result.untouchedB, 'direct editing must keep B draft unchanged');
      cases.push(result); console.log(JSON.stringify({directUndo: {scenario, changed: result.undoChangedText, before: states.at(-2), after: states.at(-1)}})); continue;
    }
    await page.locator('#promptInput').fill('A-authored'); if (scenario === 'saved-fill') await save(page, id); await capture('A-edited');
    await select(page, 1);
    if (scenario !== 'switch-before-B-edit') {
      if (scenario === 'typed') {
        await page.locator('#promptInput').click(); await page.keyboard.press('End'); await page.keyboard.type('-B-typed');
      } else await page.locator('#promptInput').fill('B-authored');
    }
    if (scenario === 'saved-fill') await save(page, id); await capture('B-edited');
    await page.locator('#promptInput').click(); await page.keyboard.press('End'); await capture('before-undo');
    for (let i = 1; i <= (scenario === 'typed' ? 16 : 4); i++) {await page.keyboard.press('Control+z'); await delay(150); await capture('B-undo-' + i);}
    const persisted = await save(page, id);
    const aUnchanged = states.every(s => s.drafts.find(n => n.id === 'image-0').text === 'A-authored');
    const crossedAIntoB = states.slice(2).some(s => s.text.includes('A-authored') || s.drafts.find(n => n.id === 'image-1').text.includes('A-authored'));
    const result = {scenario, states, persisted, aUnchanged, crossedAIntoB,
      historyInputEvents: states.at(-1).events.filter(e => ['historyUndo', 'historyRedo'].includes(e.type))};
    assert(aUnchanged, 'editing/undoing B must keep A unchanged'); assert(!crossedAIntoB, 'A history must not become B draft');
    assert.deepEqual(persisted, states.at(-1).drafts, 'undo input event must persist its node-scoped draft');
    cases.push(result);
    console.log(JSON.stringify({nodeUndoOwnership: {scenario, aUnchanged, crossedAIntoB, final: persisted, historyInputs: result.historyInputEvents}}));
  } finally {await context.close();}
  }
  fs.writeFileSync(path.join(artifacts, process.env.RETENTION_GUARD_APPEND === '1' ? 'node-undo-guard-control.json' : 'node-undo-ownership.json'), JSON.stringify(cases, null, 2));
  return cases;
}
async function bareUndoFocus() {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<div id="edit" contenteditable="true" style="width:540px;height:124px">initial</div><button id="other">Other</button>');
    const cases = [];
    for (const scenario of ['direct', 'blur-button']) {
      await page.locator('#edit').fill('initial');
      await page.locator('#edit').click(); await page.keyboard.press('End'); await page.keyboard.type('-TYPED');
      if (scenario === 'blur-button') {await page.locator('#other').click(); await page.locator('#edit').click(); await page.keyboard.press('End');}
      const before = await page.locator('#edit').innerText(); await page.keyboard.press('Control+z');
      cases.push({scenario, before, after: await page.locator('#edit').innerText()});
    }
    fs.writeFileSync(path.join(artifacts, 'bare-undo-focus.json'), JSON.stringify(cases, null, 2)); return cases;
  } finally {await context.close();}
}
async function hardUndoRegression() {
  assert.notEqual(process.env.RETENTION_GUARD_APPEND, '1', 'formal regression cannot temporarily replace append behavior');
  const checks = [];
  for (const scenario of ['save-button', 'model-menu', 'parameter-menu', 'blur-render', 'focused-render']) {
    const context = await browser.newContext({viewport: {width: 1500, height: 900}, reducedMotion: 'reduce'});
    try {
      const {page, id} = await prepareSmart(context, 'hard-' + scenario);
      await page.evaluate(() => {window.__undoEvents = []; promptInput.addEventListener('input', e => window.__undoEvents.push({type: e.inputType, owner: activeComposerNode()?.id, text: promptInput.innerText}));});
      const input = page.locator('#promptInput'); await input.click(); await page.keyboard.press('End'); await page.keyboard.type('-SAFE');
      const before = await input.innerText();
      if (scenario === 'save-button') await save(page, id);
      if (scenario === 'model-menu') {await modelMenu(page); await page.evaluate(() => render());}
      if (scenario === 'parameter-menu') {await page.locator('#dynamicParams .count-control > .smart-pill').click(); await page.waitForFunction(()=>document.querySelector('#dynamicParams .count-control')?.classList.contains('pinned')); await page.evaluate(() => render());}
      if (scenario === 'blur-render') {await page.locator('#smartV2Search').click(); await page.evaluate(() => render()); await page.keyboard.press('Escape');}
      if (scenario === 'focused-render') await page.evaluate(() => render());
      await input.click(); await page.keyboard.press('End');
      const caret = await input.evaluate(el => ({focused: document.activeElement === el, inside: el.contains(getSelection().anchorNode)}));
      assert.deepEqual(caret, {focused: true, inside: true});
      await page.keyboard.press('Control+z'); const undone = await input.innerText();
      assert.notEqual(undone, before, scenario + ' must retain real input Undo');
      assert(undone.startsWith('initial-0'), scenario + ' must undo the active node');
      let events = await page.evaluate(() => window.__undoEvents.filter(e => e.type === 'historyUndo'));
      assert(events.length && events.at(-1).owner === 'image-0', 'Undo must dispatch node-scoped input');
      await page.keyboard.press('Control+Shift+z'); assert.equal(await input.innerText(), before, 'editable CtrlShiftZ must redo input');
      await page.keyboard.press('Control+z'); await page.keyboard.press('Control+y'); assert.equal(await input.innerText(), before, 'editable CtrlY must redo input');
      const persisted = await save(page, id); assert.equal(persisted[0].text, before); assert.equal(persisted[1].text, 'initial-1');
      checks.push({scenario, ok: true, undone, redone: before});
    } finally {await context.close();}
  }
  {
    const context = await browser.newContext({viewport: {width: 1500, height: 900}, reducedMotion: 'reduce'});
    try {
      const {page, id, allowCanvas} = await prepareSmart(context, 'hard-selection'); const input = page.locator('#promptInput');
      await input.click(); await page.keyboard.press('Home'); await page.keyboard.down('Shift');
      for(let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
      const selection = await page.evaluate(() => {window.__editorWeak = new WeakRef(promptInput); window.__anchorWeak = new WeakRef(getSelection().anchorNode); const s=getSelection(); return {text:s.toString(),anchor:s.anchorOffset,focus:s.focusOffset};});
      assert(selection.text.length > 0); await page.evaluate(() => render());
      const after = await page.evaluate(() => {const s=getSelection(); return {sameEditor:__editorWeak.deref()===promptInput,sameAnchor:__anchorWeak.deref()===s.anchorNode,focused:document.activeElement===promptInput,selection:{text:s.toString(),anchor:s.anchorOffset,focus:s.focusOffset}};});
      assert(after.sameEditor && after.sameAnchor && after.focused); assert.deepEqual(after.selection, selection);
      checks.push({scenario:'focus-and-selection-render',ok:true});
      // Native history is document-wide: explicitly reach B's history end without writing A into B.
      for (let round = 0; round < 2; round++) {
        await select(page, 0); await input.fill('A-only-' + round); await select(page, 1); await input.fill('B-only-' + round);
        await input.click(); await page.keyboard.press('End');
        for(let i=0;i<20;i++) await page.keyboard.press('Control+z');
        const drafts = await page.evaluate(() => nodes.map(n=>({id:n.id,text:n.promptDraftText})));
        assert.equal(drafts[0].text,'A-only-'+round); assert(!drafts[1].text.includes('A-only'));
        assert(!await input.innerText().then(text=>text.includes('A-only')));
        assert.deepEqual(await save(page,id),drafts);
        await select(page,0); assert.equal(await input.innerText(),'A-only-'+round, 'A/B/A loads A own draft');
        assert.deepEqual(await page.evaluate(()=>nodes.map(n=>({id:n.id,text:n.promptDraftText}))),drafts);
        checks.push({scenario:'A-B-A-history-end-'+round,ok:true,drafts});
      }
      const c = (await api('/api/canvases','POST',{title:'Other same node IDs',kind:'smart'})).canvas;
      const other=fixture(); other.nodes.forEach(n=>{n.promptDraftHtml=n.promptDraftText='Other project '+n.id;});
      await api('/api/canvases/'+c.id,'PUT',{...c,...other,base_updated_at:c.updated_at});
      // The same browser page actually opens the other saved canvas; no in-memory canvas substitution.
      const original = await api('/api/canvases/'+id);
      // Routing permissions remain confined to canvas IDs created in this isolated runtime.
      allowCanvas(c.id);
      await page.goto(base+'/static/smart-canvas.html?id='+c.id); await page.waitForFunction(id=>canvas?.id===id&&window.StudioSmartV2,c.id);
      await select(page,0); await input.click(); await page.keyboard.press('End'); for(let i=0;i<6;i++)await page.keyboard.press('Control+z');
      assert.equal(await input.innerText(),'Other project image-0');
      assert.deepEqual(await save(page,c.id),other.nodes.map(n=>({id:n.id,text:n.promptDraftText})));
      assert.deepEqual((await api('/api/canvases/'+id)).canvas.nodes,original.canvas.nodes);
      checks.push({scenario:'same-node-IDs-project-isolation',ok:true});
    } finally {await context.close();}
  }
  return checks;
}
async function main() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); base = 'http://127.0.0.1:' + port;
  try {
    server = spawn(path.join(root, 'python/python.exe'), [path.join(root, 'tests/catalog-browser-server.py')], {cwd: root, windowsHide: true,
      env: {...process.env, DEEPWHITE_STUDIO_PORT: String(port), DEEPWHITE_STUDIO_RUNTIME_DIR: runtime, PYTHONUTF8: '1'}});
    server.stdout.on('data', chunk => log += chunk); server.stderr.on('data', chunk => log += chunk);
    let ready = false; for (let i = 0; i < 100; i++) {try {await api('/api/studio/health'); ready = true; break;} catch {await delay(150);}}
    assert(ready, log);
    await api('/api/studio/settings/sync-models', 'POST', {id: 'deepwhite', name: 'Offline retention fixture', base_url: 'https://api.deepwhiteai.com/v1', api_key: 'offline-retention-test', enabled: true, primary: true});
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || 'data/local-path'});
    const version = browser.version(); for (const kind of cohorts) if (kind !== 'none') await runCohort(kind);
    const hard = process.env.RETENTION_REQUIRE_UNDO === '1';
    const ownership = hard ? [] : await nodeUndoOwnership(), bareFocus = hard ? [] : await bareUndoFocus();
    const undoRegression = hard ? await hardUndoRegression() : [];
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual(hashes(), beforeHashes);
    const earlierReports = fs.readdirSync(artifacts).filter(name => name.endsWith('-analysis.json')).map(name => ({file: name,
      modifiedAt: fs.statSync(path.join(artifacts, name)).mtime.toISOString(), report: JSON.parse(fs.readFileSync(path.join(artifacts, name), 'utf8'))}));
    fs.writeFileSync(path.join(artifacts, hard ? 'undo-regression.json' : 'results.json'), JSON.stringify({diagnostic: !hard,
      retentionDiagnostic: reports.length > 0, regression: hard ? {passed: true, groups: undoRegression.length} : null,
      temporaryAppendGuard: process.env.RETENTION_GUARD_APPEND === '1', undoRegression, cycles, browser: version, reportsThisRun: reports, earlierReports, ownership, bareFocus, errors, blocked, sourceHashes: beforeHashes, createdAt: new Date().toISOString()}, null, 2));
    console.log(hard ? 'Input Undo/Redo regression passed: ' + undoRegression.length + ' groups; ' + artifacts
      : 'Diagnostic completed (retention is reported, not declared zero): ' + artifacts);
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) await new Promise((resolve, reject) => {const timer = setTimeout(() => reject(Error('isolated server exit timeout')), 8000); server.once('close', () => {clearTimeout(timer); resolve();}); server.kill();});
    const resolved = path.resolve(runtime); assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert(path.basename(resolved).startsWith('dw-editor-retention-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  }
}
main().catch(e => {console.error(e.stack); console.error(log.slice(-1500)); process.exitCode = 1;});
