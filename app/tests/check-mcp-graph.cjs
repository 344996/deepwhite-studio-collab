'use strict';
// Disposable server + real stdio bridge + real browser. No paid execution.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), readline = require('node:readline');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-mcp-graph-'));
const output = path.join(root, 'test-output', 'mcp-graph');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, bridge, browser, base, serverLog = '', bridgeLog = '';
const checks = [], errors = [], external = [], generation = [];
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {method, headers: {'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  assert(response.ok, await response.clone().text());
  return response.json();
}
let rpc, call;
function startBridge(config) {
  bridge = spawn(config.command, config.args, {cwd: root, windowsHide: true,
    env: {...process.env, ...config.env, PYTHONUTF8: '1'}, stdio: ['pipe', 'pipe', 'pipe']});
  bridge.stderr.on('data', data => bridgeLog += data);
  const pending = new Map(); let sequence = 0;
  readline.createInterface({input: bridge.stdout}).on('line', line => {
    const result = JSON.parse(line);
    pending.get(result.id)?.(result);
  });
  rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(Error('MCP timeout ' + bridgeLog));}, 15000);
    pending.set(id, response => {
      clearTimeout(timer); pending.delete(id);
      response.error ? reject(Error(JSON.stringify(response.error))) : resolve(response.result);
    });
    bridge.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  });
  call = async (name, args = {}, fail = false) => {
    const result = await rpc('tools/call', {name, arguments: args});
    assert.equal(!!result.isError, fail, JSON.stringify(result));
    return fail ? result : result.structuredContent;
  };
}
async function handshake() {
  const result = await rpc('initialize', {protocolVersion: '2025-11-25',
    capabilities: {}, clientInfo: {name: 'graph-regression', version: '1'}});
  assert.equal(result.protocolVersion, '2025-06-18');
  bridge.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
}
function pass(name) {checks.push(name); console.log('PASS ' + name);}
async function main() {
  fs.mkdirSync(output, {recursive: true});
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve)); base = 'http://127.0.0.1:' + port;
  const python = process.env.PYTHON_EXECUTABLE || path.join(root, '..', '.venv', 'Scripts', 'python.exe');
  async function startServer() {
    server = spawn(python, ['-B', path.join(root, 'tests', 'catalog-browser-server.py')], {
      cwd: root, windowsHide: true, env: {...process.env, PYTHONUTF8: '1',
        DEEPWHITE_STUDIO_RUNTIME_DIR: runtime, DEEPWHITE_STUDIO_PORT: String(port)}});
    server.stdout.on('data', data => serverLog += data);
    server.stderr.on('data', data => serverLog += data);
    server.on('error', error => serverLog += error.message);
    for (let i = 0; i < 120; i++) {
      try {return await api('/api/studio/health');} catch {if (server.exitCode !== null) break; await sleep(100);}
    }
    throw Error('Fixture startup failed: ' + serverLog);
  }
  const health = await startServer();
  assert.equal(health.version, '0.10.2-studio.14');
  const enabled = await api('/api/studio/control/settings', 'PUT', {enabled: true});
  const config = enabled.client_config.mcpServers['deepwhite-studio'];
  startBridge(config); await handshake();
  const listed = await rpc('tools/list', {});
  assert.equal(listed.tools.length, 13);
  const projects = await call('list_projects');
  assert((await call('get_node_schema')).creatable_types.includes('prompt'));
  const creation = {project_id: 'default', title: 'AI 协作画布 · 本地验收',
    expected_revision: projects.revision, operation_id: randomUUID()};
  const created = await call('create_canvas', creation);
  assert.deepEqual(await call('create_canvas', creation), created);
  pass('stdio discovery and idempotent canvas creation');

  browser = await chromium.launch({headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
  const context = await browser.newContext({viewport: {width: 1500, height: 950}});
  await context.route('**/*', route => {
    const url = route.request().url();
    if (!url.startsWith(base)) {external.push(url); return route.abort();}
    if (route.request().method() === 'POST' && /\/generate(?:\/|$)|\/generations$/.test(new URL(url).pathname)) {
      generation.push(url); return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + created.url);
  await page.waitForFunction(id => window.StudioCanvasV2?.ready && canvas?.id === id, created.canvas_id);
  await api('/api/studio/settings/sync-models', 'POST', {id: 'offline', name: 'Offline fixture',
    base_url: 'https://api.deepwhiteai.com/v1', api_key: 'offline-fixture', enabled: true, primary: true});
  const models = (await call('list_models')).items;
  const model = models.find(item => item.provider_id === 'offline' && item.kind === 'image');
  assert(model);
  const generator = await call('apply_nodes', {canvas_id: created.canvas_id,
    expected_revision: (await call('get_canvas', {canvas_id: created.canvas_id})).revision,
    operation_id: randomUUID(), nodes: [{key: 'image', kind: 'image', title: '分镜画面',
      prompt: '柔和自然光的城市街景', provider_id: model.provider_id, model: model.model, params: {}, references: []}]});
  const editArgs = {canvas_id: created.canvas_id, expected_revision: generator.revision,
    operation_id: randomUUID(), operations: [
      {op: 'move_node', node_id: generator.node_ids.image, x: 470, y: 100},
      {op: 'add_prompt', key: 'story', text: '镜头 01：雨后的城市街道，人物缓缓走近。', x: 60, y: 100},
      {op: 'connect', from: '$story', to: generator.node_ids.image}]};
  const edited = await call('edit_canvas', editArgs);
  await page.waitForFunction(result => nodes.some(n => n.id === result.node_ids.story) &&
    connections.some(c => c.id === result.connection_ids[0]), edited);
  assert(await page.locator('[data-id="' + edited.node_ids.story + '"]').isVisible());
  await page.evaluate(() => {viewport = {x: 20, y: 40, scale: 0.9}; render();});
  await page.screenshot({path: path.join(output, 'canvas.png')});
  pass('text, generator and connection appear in the live browser');

  const changedArgs = {...editArgs, operation_id: randomUUID(), expected_revision: edited.revision,
    operations: [{op: 'update_prompt', node_id: edited.node_ids.story, text: '镜头已调整'}]};
  const changed = await call('edit_canvas', changedArgs);
  await page.waitForFunction(id => nodes.find(n => n.id === id)?.text === '镜头已调整', edited.node_ids.story);
  const conflict = await call('edit_canvas', {...changedArgs, operation_id: randomUUID(),
    expected_revision: generator.revision}, true);
  assert.match(conflict.content[0].text, /409/);
  await call('undo_edit', {canvas_id: created.canvas_id, operation_id: changedArgs.operation_id,
    expected_revision: changed.revision});
  await page.waitForFunction(id => nodes.find(n => n.id === id)?.text.includes('雨后的城市'), edited.node_ids.story);
  pass('stale revision is rejected and undo synchronizes');

  const invalid = await call('edit_canvas', {...editArgs, operations: [
    {op: 'add_prompt', key: 'bad', text: 'bad', x: 1e100, y: 0}]}, true);
  assert(invalid.isError);
  await page.reload();
  await page.waitForFunction(id => nodes?.some(n => n.id === id), edited.node_ids.story);
  pass('invalid input rejected and saved graph survives page reload');

  const bridgeExited = new Promise(resolve => bridge.once('exit', resolve));
  bridge.kill(); await bridgeExited;
  const serverExited = new Promise(resolve => server.once('exit', resolve));
  server.kill(); await serverExited;
  await startServer(); startBridge(config); await handshake();
  assert.deepEqual(await call('create_canvas', creation), created);
  assert.deepEqual(await call('edit_canvas', editArgs), edited);
  assert.deepEqual(await call('edit_canvas', changedArgs), changed);
  const saved = (await call('get_canvas', {canvas_id: created.canvas_id})).canvas;
  assert.equal(saved.nodes.filter(n => n.type === 'prompt').length, 1);
  assert(saved.nodes.find(n => n.type === 'prompt').text.includes('雨后的城市'));
  pass('server and bridge restart preserve replay receipts and undo result');

  const settingsPage = await context.newPage();
  settingsPage.on('pageerror', error => errors.push(error.message));
  await settingsPage.goto(base + '/settings');
  await settingsPage.locator('[data-tab="control"]').click();
  assert(await settingsPage.getByText('启用后，智能体可读取项目', {exact: false}).isVisible());
  await settingsPage.screenshot({path: path.join(output, 'settings.png')});
  await api('/api/studio/control/settings', 'PUT', {enabled: false});
  await call('list_projects', {}, true);
  pass('settings describes edit scope and disabling revokes access');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(generation, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
    passed: true, version: health.version, checks, errors, external, generation,
    note: 'real local stdio/browser, mocked provider catalogue; no paid calls'}, null, 2));
}
main().catch(error => {console.error(error); process.exitCode = 1;})
  .finally(async () => {bridge?.kill(); server?.kill(); await browser?.close();});
