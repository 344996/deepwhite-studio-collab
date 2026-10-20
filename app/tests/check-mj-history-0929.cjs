'use strict';

// Exercise the production history UI in an isolated host with mocked local routes.
// No Python server, real canvas data, account, upstream request, or generation is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.PLAYWRIGHT_MODULE || 'data/local-path'); }
const executablePath = process.env.CHROMIUM_EXECUTABLE || 'data/local-path';
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/studio-stage-one.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'static/studio-stage-one.css'), 'utf8');
const base = 'http://mj-history.invalid';
const out = path.join(os.tmpdir(), 'deepwhite-mj-history-0929');
fs.mkdirSync(out, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const host = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>MJ history isolated fixture</title><style>
:root{--panel:#30352d;--surface:#30352d;--border:#ffffff20;--muted:#b3b9a7;--text:#e6e5d9;--accent:#e3bd83}body{margin:0;background:#20231f;color:#e6e5d9;font:14px 'Microsoft YaHei',sans-serif}button{font:inherit;color:inherit;background:#383e32;border:1px solid #ffffff20;border-radius:7px;padding:8px;cursor:pointer}button:disabled{opacity:.6}dialog{background:#30352d;color:#e6e5d9}dialog::backdrop{background:#0009}small{display:block}a{color:#e3bd83}#outputLightbox{display:none}
</style></head><body><button id="canvasArrangeBtn">整理选中</button><div id="outputLightbox"></div><script>
var saveTimer=null,canvas={id:'mock-canvas',logs:[]},nodes=[],selected=new Set(),apiProviders=[{id:'mock-channel',base_url:'https://mock.invalid/v1',model_names:{'midjourney-imagine':'Midjourney','image-model':'普通图片'}}],fixtureActions=[];
function saveCanvas(){return Promise.resolve()}function render(){}function scheduleSave(){fixtureActions.push('save')}function startNodeDrag(){}function openOutputLightbox(){}function outputLightboxItems(){return []}function generatorSources(){return []}
function renderGeneratorBody(){return document.createElement('div')}function renderVideoBody(){return document.createElement('div')}function renderLLMBody(){return document.createElement('div')}function renderNode(){const el=document.createElement('div');el.innerHTML='<span class="node-title">node</span>';return el}
function callCanvasLLM(){}function setStatus(message){fixtureActions.push(message)}function defaultPoint(){return {x:10,y:20}}function pushUndo(){fixtureActions.push('undo')}function createImageCardFromUrl(url,point,name){fixtureActions.push({use:url,name})}
function addGeneratorNode(point){const n={id:'restored-'+nodes.length,type:'generator',...point};nodes.push(n);return n}function addLLMNode(point){const n=addGeneratorNode(point);n.type='llm';return n}function addVideoNode(point){const n=addGeneratorNode(point);n.type='video';return n}function studioAddMj(point){return addGeneratorNode(point)}function copyTextToClipboard(text){fixtureActions.push({copy:text})}
</script><script src="/static/studio-stage-one.js"></script></body></html>`;

function job(id, status, fields = {}) {
  return { id, source: 'mj', status, created_at: 1800000000, resolved_model: 'midjourney-imagine', request: { canvas_id: 'mock-canvas', node_id: 'absent-node', provider_id: 'mock-channel', model: 'midjourney-imagine', kind: 'image', prompt: '独立测试提示词', params: { ratio: '16:9', version: '8.2', speed: 'relax' }, references: [], count: 1 }, task_ids: ['original-' + id], outputs: [], text: '', children: [], error: '', remote_status: 'pending', media_status: 'not_required', ...fields };
}

async function run() {
  const records = new Map([
    ['mj_archive', job('mj_archive', 'paused', { remote_status: 'succeeded', media_status: 'failed', error: 'MJ 已完成，但结果保存失败。<img src=x onerror="window.bad=1">', outputs: [{ url: '/unarchived.png', kind: 'image' }] })],
    ['mj_immediate', job('mj_immediate', 'paused', { task_ids: [], remote_status: 'succeeded', media_status: 'failed', error: '立即结果没有任务编号，保存失败；保留历史编号可恢复。' })],
    ['mj_uncertain', job('mj_uncertain', 'uncertain', { task_ids: [], remote_status: 'uncertain', error: '提交结果待核实 <script>window.bad=2</script>' })],
    ['mj_query_error', job('mj_query_error', 'running')],
    ['mj_refresh_error', job('mj_refresh_error', 'paused', { error: '之前的查询错误' })],
    ['mj_failed', job('mj_failed', 'failed', { remote_status: 'failed', error: '平台明确返回失败' })],
    ['mj_queued', job('mj_queued', 'queued')],
    ['mj_saved', job('mj_saved', 'succeeded', { remote_status: 'succeeded', media_status: 'completed', text: '描述结果', outputs: [{ url: '/saved.svg', kind: 'image', name: 'saved.png' }] })],
    ['generic_paused', job('generic_paused', 'paused', { source: 'generic', resolved_model: 'image-model', request: { canvas_id: 'mock-canvas', node_id: 'not-on-canvas', provider_id: 'mock-channel', model: 'image-model', kind: 'image', prompt: '普通图片记录', params: { ratio: '1:1' }, references: [], count: 1 }, remote_status: undefined, media_status: undefined })],
  ]);
  const requests = []; const errors = []; const forbidden = [];
  let historyFailure = false; let queryFailures = 0;
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : undefined });
    if (url.origin !== base) { forbidden.push(request.url()); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: host });
    if (url.pathname === '/static/studio-stage-one.js') return route.fulfill({ contentType: 'application/javascript', body: source });
    if (url.pathname === '/static/studio-stage-one.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname === '/static/studio-generation-history.css') return route.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(root, 'static/studio-generation-history.css'), 'utf8') });
    if (url.pathname === '/api/studio/capabilities') return route.fulfill({ json: { providers: {} } });
    if (url.pathname === '/api/studio/generations' && request.method() === 'GET') {
      if (historyFailure) { historyFailure = false; return route.fulfill({ status: 503, json: { detail: '记录刷新暂时失败' } }); }
      return route.fulfill({ json: { items: [...records.values()] } });
    }
    const resume = /^\/api\/studio\/mj\/history\/([^/]+)\/resume$/.exec(url.pathname);
    if (resume && request.method() === 'POST') {
      assert.deepEqual(request.postDataJSON(), {}, 'resume posts no generation payload');
      const record = records.get(decodeURIComponent(resume[1])); assert.ok(record, 'resume uses history ID');
      await wait(300);
      if (record.id === 'mj_query_error' && queryFailures++ === 0) return route.fulfill({ status: 502, json: { detail: '查询网络错误 <img src=x onerror="window.bad=3">' } });
      record.status = 'succeeded'; record.remote_status = 'succeeded'; record.media_status = 'completed'; record.error = ''; record.outputs = [{ url: '/saved.svg', kind: 'image' }];
      if (record.id === 'mj_refresh_error') historyFailure = true;
      return route.fulfill({ json: { task_id: record.task_ids[0] || '', history_id: record.id, status: 'succeeded', remote_status: 'succeeded', media_status: 'completed', images: ['/saved.svg'], videos: [], error: '' } });
    }
    if (url.pathname === '/api/studio/generations/generic_paused/resume' && request.method() === 'POST') return route.fulfill({ json: records.get('generic_paused') });
    if (url.pathname === '/saved.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24"><rect width="40" height="24" fill="#e3bd83"/></svg>' });
    forbidden.push(url.pathname); return route.fulfill({ status: 400, json: { detail: 'Unexpected route' } });
  });
  const card = id => page.locator(`.studio-history article[data-job-id="${id}"]`);
  const mjPosts = () => requests.filter(r => /^\/api\/studio\/mj\/history\/.+\/resume$/.test(r.path));
  try {
    await page.goto(base + '/?id=mock-canvas');
    await page.locator('.studio-history-button').click();
    await card('mj_archive').waitFor();
    assert.equal(await page.locator('.studio-history article').count(), records.size);
    assert.ok(await page.locator('.studio-history-body').evaluate(body => {
      const cards = [...body.querySelectorAll('article')].map(card => card.getBoundingClientRect());
      return cards.every((card, index) => index < 3 || card.top >= cards[index - 3].bottom);
    }), 'multi-row history cards keep their full height without covering previous-row controls');
    assert.match(await card('mj_archive').locator('small').first().textContent(), /远端已完成 · 保存失败/);
    assert.match(await card('mj_archive').locator('.studio-history-error').textContent(), /<img src=x/);
    assert.equal(await card('mj_archive').locator('img, .studio-history-output, a[download]').count(), 0, 'unarchived result never appears downloadable');
    assert.match(await card('mj_archive').textContent(), /结果尚未保存到本地/);
    await card('mj_archive').locator('summary').click();
    assert.match(await card('mj_archive').locator('details pre').textContent(), /mj_archive/);
    assert.match(await card('mj_archive').locator('details pre').textContent(), /original-mj_archive/);
    await card('mj_archive').locator('summary').click();
    assert.equal(await card('mj_uncertain').getByRole('button', { name: /查询|恢复|重试|重新生成/ }).count(), 0);
    assert.match(await card('mj_uncertain').textContent(), /先核对平台任务记录/);
    assert.match(await card('mj_uncertain').locator('.studio-history-error').textContent(), /<script>/);
    await wait(1700);
    assert.equal(mjPosts().length, 0, 'MJ uncertain and other history rows are not auto-resumed');
    assert.equal(await page.evaluate(() => window.bad), undefined, 'server errors are rendered as text');
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1500, height: 1050 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: path.join(out, `history-${viewport.width}x${viewport.height}.png`) });
    }

    const archiveButton = card('mj_archive').getByRole('button', { name: '重试保存结果', exact: true });
    await archiveButton.click(); await page.waitForFunction(() => document.querySelector('[data-job-id="mj_archive"] button:last-child').disabled);
    await card('mj_archive').locator('button:disabled').evaluate(button => button.onclick());
    await page.waitForFunction(() => document.querySelector('[data-job-id="mj_archive"]')?.dataset.status === 'succeeded');
    assert.equal(mjPosts().filter(r => r.path.includes('/mj_archive/')).length, 1, 'disabled button blocks duplicate recovery');
    assert.equal(await page.locator('.studio-history').evaluate(el => el.open), true, 'success refresh keeps dialog open');
    assert.equal(await card('mj_archive').locator('a[download]').count(), 1, 'download appears after archive succeeds');
    assert.match(await card('mj_archive').locator('.studio-history-remote').textContent(), /结果已保存/);

    await card('mj_immediate').getByRole('button', { name: '重试保存结果', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-job-id="mj_immediate"]')?.dataset.status === 'succeeded');
    assert.equal(mjPosts().filter(r => r.path.includes('/mj_immediate/')).length, 1, 'immediate result resumes by history ID despite empty task IDs');
    assert.deepEqual(records.get('mj_immediate').task_ids, []);

    await card('mj_query_error').getByRole('button', { name: '继续查询', exact: true }).click();
    await card('mj_query_error').locator('.studio-history-error').waitFor();
    assert.match(await card('mj_query_error').locator('.studio-history-error').textContent(), /查询网络错误 <img/);
    assert.equal(await card('mj_query_error').getByRole('button', { name: '继续查询', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('.studio-history').evaluate(el => el.open), true, 'failed query leaves the card and window visible');
    assert.equal(await card('mj_query_error').locator('img').count(), 0);
    await card('mj_query_error').getByRole('button', { name: '继续查询', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-job-id="mj_query_error"]')?.dataset.status === 'succeeded');

    await card('mj_refresh_error').getByRole('button', { name: '继续查询', exact: true }).click();
    await page.locator('.studio-history-body > .studio-history-error').waitFor();
    assert.match(await page.locator('.studio-history-body > .studio-history-error').textContent(), /记录刷新暂时失败/);
    assert.match(await card('mj_refresh_error').locator('.studio-history-error').textContent(), /之前的查询错误/, 'refresh failure retains the original card error');
    assert.equal(await page.locator('.studio-history').evaluate(el => el.open), true);
    await page.locator('.studio-history-button').evaluate(button => button.onclick());
    assert.equal(await card('mj_refresh_error').getAttribute('data-status'), 'succeeded');

    await card('mj_failed').getByRole('button', { name: '核对原任务', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-job-id="mj_failed"]')?.dataset.status === 'succeeded');
    assert.equal(mjPosts().filter(r => r.path.includes('/mj_uncertain/')).length, 0);
    await card('generic_paused').getByRole('button', { name: '继续查询', exact: true }).click();
    await card('generic_paused').getByRole('button', { name: '已恢复查询，稍后查看记录', exact: true }).waitFor();
    assert.equal(requests.filter(r => r.path === '/api/studio/generations/generic_paused/resume').length, 1, 'non-MJ recovery keeps its existing endpoint');

    assert.equal(await card('mj_saved').locator('a[download]').getAttribute('href'), '/saved.svg');
    await card('mj_saved').getByRole('button', { name: '复制文本', exact: true }).click();
    assert.ok(await page.evaluate(() => fixtureActions.some(action => action?.copy === '描述结果')), 'text reuse remains available');
    await card('generic_paused').getByRole('button', { name: '复用这次设置', exact: true }).click();
    assert.equal(await page.evaluate(() => nodes.length), 1);
    assert.equal(await page.evaluate(() => nodes[0].studioPrompt), '普通图片记录');
    assert.equal(await page.locator('.studio-history').evaluate(el => el.open), false, 'reusing settings keeps native behavior');
    await page.locator('.studio-history-button').click(); await card('mj_saved').getByRole('button', { name: '放入画布', exact: true }).click();
    assert.ok(await page.evaluate(() => fixtureActions.some(action => action?.use === '/saved.svg')), 'archived media can still be reused');

    assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/api/studio/generations').length, 0);
    assert.equal(requests.filter(r => /\/mj\/(tasks|submit)/.test(r.path)).length, 0, 'no old task query or fresh MJ submission route');
    assert.deepEqual(forbidden, [], 'no external traffic or unapproved routes');
    assert.deepEqual(errors, [], 'no unhandled browser errors');
    console.log('PASS MJ history: statuses/errors, archive failure, empty-task-ID recovery, disabled in-flight action, visible exceptions, refresh retention, uncertain safety, and non-MJ reuse.');
    console.log('Screenshots: ' + out);
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
