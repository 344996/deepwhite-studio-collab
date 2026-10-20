// End-to-end account bootstrap with real backend routes and an offline upstream.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-account-browser-'));
const output = process.env.ACCOUNT_TEST_OUTPUT || path.join(os.tmpdir(), 'dw-account-provision-evidence');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser, page, log = '';
const checks = [], errors = [], external = [];

(async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  try {
    server = spawn(process.env.PYTHON_EXECUTABLE || path.join(root, '../.venv/Scripts/python.exe'),
      ['-B', path.join(__dirname, 'account-provision-browser-server.py')],
      {cwd: root, windowsHide: true, env: {...process.env, PYTHONUTF8: '1',
        DEEPWHITE_STUDIO_RUNTIME_DIR: runtime, DEEPWHITE_STUDIO_PORT: String(port)}});
    server.stdout.on('data', data => log += data);
    server.stderr.on('data', data => log += data);
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { ready = (await fetch(base + '/api/studio/health')).ok; } catch {}
      if (ready) break;
      await wait(200);
    }
    assert(ready, log);
    browser = await chromium.launch({headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {channel: 'msedge'})});
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base && !['data:', 'blob:'].includes(url.protocol)) {
        external.push(url.origin); return route.abort();
      }
      return route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/');
    await page.locator('#studioAccountButton').waitFor();
    await page.locator('#studioSettingsButton').click();
    const frame = page.frameLocator('#studioSettingsDialog iframe');
    await frame.locator('#apiForm:not([inert])').waitFor();
    await frame.locator('[data-tab=models]').click();
    await frame.locator('#modelCount').filter({hasText: '模型示例'}).waitFor();
    assert(await frame.locator('.model-row input').first().isDisabled());
    checks.push('未登录可查看禁用的模型示例，不伪装为已连接模型');
    await frame.locator('[data-tab=api]').click();
    let releaseReload;
    const delayedReload = async route => {
      const response = await route.fetch();
      await new Promise(resolve => { releaseReload = resolve; });
      await route.fulfill({response});
    };
    await context.route(base + '/api/providers', delayedReload);
    await page.evaluate(() => { const channel = new BroadcastChannel('studio-api'); channel.postMessage({type:'providers-changed'}); channel.close(); });
    for (let i = 0; i < 100 && !releaseReload; i++) await wait(20);
    assert(releaseReload, 'background provider fetch must start');
    await frame.locator('#providerName').fill('未保存的渠道名称');
    releaseReload();
    await wait(150);
    assert.equal(await frame.locator('#providerName').inputValue(), '未保存的渠道名称');
    await context.unroute(base + '/api/providers', delayedReload);
    page.once('dialog', dialog => dialog.dismiss());
    await frame.locator('#closeSettings').click();
    assert(await page.locator('#studioSettingsDialog').isVisible());
    assert.equal(await frame.locator('#providerName').inputValue(), '未保存的渠道名称');
    checks.push('延迟的跨标签页刷新不覆盖未保存输入，取消关闭后字段仍保留');
    page.once('dialog', dialog => dialog.accept());
    await frame.locator('#closeSettings').click();
    await page.locator('#studioSettingsDialog').waitFor({state: 'hidden'});

    let releaseBalances;
    const delayedBalances = async route => {
      await new Promise(resolve => { releaseBalances = resolve; });
      await route.continue();
    };
    await context.route(base + '/api/studio/channel-balances', delayedBalances);
    await page.locator('#studioAccountButton').click();
    await page.getByLabel('用户名', {exact: true}).fill('fixture');
    await page.getByLabel('密码', {exact: true}).fill('fixture-password');
    await page.getByRole('button', {name: '登录并连接 API', exact: true}).click();
    await page.locator('[data-generation-status=ready]').waitFor();
    assert(await page.getByText('官方 API 和模型已自动配置，可以回到画布生成。', {exact: true}).isVisible());
    checks.push('登录实际串起专用令牌创建、官方渠道和模型自动同步，显示结果');
    assert(await page.getByRole('button', {name: '退出登录', exact: true}).isVisible());
    for (let i = 0; i < 100 && !releaseBalances; i++) await wait(20);
    assert(releaseBalances);
    releaseBalances();
    await context.unroute(base + '/api/studio/channel-balances', delayedBalances);
    checks.push('可选渠道余额查询等待时，退出与授权刷新仍然可用');
    await page.locator('.dw-library').getByRole('button', {name: '关闭', exact: true}).click();
    await page.locator('#studioSettingsButton').click();
    await frame.locator('#apiForm:not([inert])').waitFor();
    const pid = await frame.locator('#providerSelect').inputValue();
    assert(pid.startsWith('deepwhite-account-'));
    assert(await frame.locator('#apiKey').isDisabled());
    assert.equal(await frame.locator('#apiKey').inputValue(), '');
    await frame.locator('[data-tab=models]').click();
    const image = frame.locator('.model-row[data-model-id="deepwhiteai-image-g2"] input');
    await image.uncheck();
    await frame.locator('#pickerResult').filter({hasText: '已保存'}).waitFor();
    await frame.locator('[data-tab=api]').click();
    await frame.locator('#settingsAccountConnection button').click();
    await frame.locator('#apiResult').filter({hasText: '模型已自动配置'}).waitFor();
    await frame.locator('[data-tab=models]').click();
    assert(!(await image.isChecked()));
    checks.push('登录渠道凭证不回显且不可手改；重新同步保留模型停用选择');
    await frame.locator('#closeSettings').click();
    await page.locator('#studioAccountButton').click();
    await fetch(base + '/__fixture/models-failure/1', {method: 'POST'});
    await page.getByRole('button', {name: '刷新授权和模型', exact: true}).click();
    await page.locator('[data-generation-status=models_pending]').waitFor();
    assert(await page.getByText(/模型同步未完成/).isVisible());
    await fetch(base + '/__fixture/models-failure/0', {method: 'POST'});
    await page.getByRole('button', {name: '刷新授权和模型', exact: true}).click();
    await page.locator('[data-generation-status=ready]').waitFor();
    checks.push('模型同步失败保留网站登录和重试入口，恢复后无需再次创建令牌');
    fs.mkdirSync(output, {recursive: true});
    await page.screenshot({path: path.join(output, 'account-api-ready.png')});
    await page.getByRole('button', {name: '退出登录', exact: true}).click();
    await page.getByRole('button', {name: '登录 / 注册', exact: true}).waitFor();
    const providers = (await (await fetch(base + '/api/providers')).json()).providers;
    assert(!providers.find(item => item.id === pid).has_key);
    const state = await (await fetch(base + '/__fixture/state')).json();
    assert.equal(state.creates, 1);
    assert.equal(state.generation_requests, 0);
    checks.push('退出立即失效生成授权；整个流程只创建一次模拟令牌，未发起付费生成');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = {passed: true, checks, browser_errors: errors, external_requests: external,
      fixture: 'mock New API only; no real account or paid generation', runtime};
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (page && !page.isClosed()) {
      fs.mkdirSync(output, {recursive: true});
      await page.screenshot({path: path.join(output, 'last-state.png')}).catch(() => {});
    }
    await browser?.close();
    if (server) {
      server.kill();
      await new Promise(resolve => {
        if (server.exitCode !== null) return resolve();
        server.once('exit', resolve); setTimeout(resolve, 4000);
      });
    }
    // Keep this isolated runtime with the evidence for inspection; no user data.
  }
})().catch(error => { console.error(error.stack); console.error(log.slice(-2500)); process.exitCode = 1; });
