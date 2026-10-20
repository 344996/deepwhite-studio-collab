'use strict';
// Real project/canvas persistence in a disposable runtime. Covers are bundled
// local illustrations; no user data, API keys, accounts or paid requests are used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-workspace-polish-'));
const evidence = path.join(root, 'test-output/workspace-polish');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], external = [], paid = [], writes = [], unexpectedWrites = [];
let server, browser, page, base, serverLog = '';
fs.mkdirSync(evidence, {recursive:true});

async function api(url, method = 'GET', body) {
  if (method === 'PUT' && /^\/api\/canvases\/[^/]+$/.test(url)) {
    const current = await api(url);
    body = {...body, base_updated_at:current.canvas.updated_at};
  }
  const response = await fetch(base + url, {
    method, headers:{'Content-Type':'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {}),
  });
  assert(response.ok, await response.clone().text());
  return response.json();
}
async function check(name, action) {
  await action(); checks.push(name); console.log('PASS ' + name);
}
async function readyHome(project) {
  await page.goto(base + '/?project=' + project);
  await page.waitForFunction(() => window.StudioWorkspace?.ready && window.StudioHomeV2);
  await page.locator('.ws-card').first().waitFor();
}
async function noOverflow(target, label) {
  const actual = await target.evaluate(() => ({
    width:innerWidth, document:document.documentElement.scrollWidth,
    body:document.body.scrollWidth,
  }));
  assert(actual.document <= actual.width + 1, label + ' document overflow: ' + JSON.stringify(actual));
  assert(actual.body <= actual.width + 1, label + ' body overflow: ' + JSON.stringify(actual));
}
async function reachable(locator, label, minimum = 36) {
  await locator.scrollIntoViewIfNeeded();
  const actual = await locator.evaluate(el => {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x:r.x, y:r.y, w:r.width, h:r.height, width:innerWidth, height:innerHeight,
      reachable:!!hit && (hit === el || el.contains(hit)),
    };
  });
  assert(actual.x >= -1 && actual.x + actual.w <= actual.width + 1, label + ' horizontal bounds: ' + JSON.stringify(actual));
  assert(actual.y >= -1 && actual.y + actual.h <= actual.height + 1, label + ' vertical bounds: ' + JSON.stringify(actual));
  assert(actual.h >= minimum, label + ' usable target height: ' + actual.h);
  assert(actual.reachable, label + ' hit target is covered: ' + JSON.stringify(actual));
}

(async () => {
  const port = await new Promise(resolve => {
    const socket = net.createServer().listen(0, '127.0.0.1', () => {
      const value = socket.address().port; socket.close(() => resolve(value));
    });
  });
  base = 'http://127.0.0.1:' + port;
  server = spawn(process.env.PYTHON_EXECUTABLE || 'python', ['-B', 'tests/catalog-browser-server.py'], {
    cwd:root, windowsHide:true,
    env:{...process.env, DEEPWHITE_STUDIO_RUNTIME_DIR:runtime, DEEPWHITE_STUDIO_PORT:String(port), PYTHONUTF8:'1'},
  });
  server.stdout.on('data', chunk => serverLog += chunk);
  server.stderr.on('data', chunk => serverLog += chunk);
  let ready = false;
  for (let n = 0; n < 140; n++) {
    try {await api('/api/studio/health'); ready = true; break;} catch {await pause(150);}
  }
  assert(ready, serverLog);
  const project = (await api('/api/projects', 'POST', {name:'我的创作 · 秋日灵感'})).project;
  const other = (await api('/api/projects', 'POST', {name:'影片素材'})).project;
  const records = [
    {title:'林间来信 · 短片分镜', kind:'classic', cover:'scene-v1.png', prompt:'清晨薄雾中的森林与湖面，柔和的自然光，电影感构图。'},
    {title:'人物小传 · 角色设定', kind:'smart', cover:'character-v1.png', prompt:'为秋日故事设计一位安静、独立的角色，保留真实的衣物纹理。'},
    {title:'光的形状 · 产品练习', kind:'classic', cover:'props-v1.png', prompt:'浅色静物在窗边柔和的侧光下，细腻的材质与留白。'},
  ];
  const covers = new Map();
  for (const [index, record] of records.entries()) {
    const canvas = (await api('/api/canvases', 'POST', {title:record.title, kind:record.kind, project:project.id})).canvas;
    const cover = '/output/workspace-polish-' + index + '.png';
    covers.set(cover, fs.readFileSync(path.join(root, 'static/design-review/assets', record.cover)));
    const updated = await api('/api/canvases/' + canvas.id, 'PUT', {
      title:record.title, nodes:[
        {id:'prompt-' + index, type:'text', text:record.prompt, x:80, y:80, width:320, height:180},
        {id:'image-' + index, type:'image', url:cover, x:440, y:80, width:320, height:240},
      ], connections:[],
    });
    record.id = updated.canvas?.id || canvas.id;
  }
  await api('/api/canvases/' + records[0].id + '/meta', 'POST', {pinned:true});
  await api('/api/canvases', 'POST', {title:'独立文件夹中的画布', project:other.id});
  const trashed = (await api('/api/canvases', 'POST', {title:'回收站恢复验收 · 本地临时画布', project:other.id})).canvas;
  await api('/api/canvases/' + trashed.id, 'DELETE');
  browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE});
  const context = await browser.newContext({viewport:{width:1440, height:1000}, reducedMotion:'reduce'});
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
    if (url.origin !== base) {external.push(url.origin + url.pathname); return route.abort();}
    if (covers.has(url.pathname)) return route.fulfill({contentType:'image/png', body:covers.get(url.pathname)});
    if (url.pathname === '/api/media-preview' && covers.has(url.searchParams.get('url'))) {
      return route.fulfill({contentType:'image/png', body:covers.get(url.searchParams.get('url'))});
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push({path:url.pathname, method:request.method()});
      if (/\/api\/(?:studio\/generations|generate|canvas-(?:image|comfy|video|llm)|studio\/mj\/submit)/.test(url.pathname)) {
        paid.push(url.pathname); return route.fulfill({status:503, json:{detail:'Generation disabled in UI test'}});
      }
      if (!/^\/api\/(?:projects|canvases)(?:\/|$)/.test(url.pathname)) {
        unexpectedWrites.push(request.method() + ' ' + url.pathname);
        return route.fulfill({status:403, json:{detail:'Unexpected write blocked in presentation test'}});
      }
    }
    return route.continue();
  });

  await check('real local project cards, prompt data and covers load without account or generation', async () => {
    await readyHome(project.id);
    assert.equal(await page.locator('.workspace-nav button').count(), 5);
    assert.equal(await page.locator('.ws-card').count(), 3);
    await page.waitForFunction(() => document.querySelectorAll('.home-canvas-cover img').length === 3 &&
      [...document.querySelectorAll('.home-canvas-cover img')].every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator('.workspace-quickstart [data-workspace-create]').count(), 2);
    assert.deepEqual(writes, [], 'viewing cards does not change saved documents');
    assert.equal((await api('/api/canvases/' + records[0].id)).canvas.nodes[0].text, records[0].prompt);
  });

  await check('home grid fits 320, 768, 1024 and 1440 px with reachable creation and search', async () => {
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({width, height:1000});
      await noOverflow(page, 'home grid ' + width);
      await reachable(page.locator('#newCanvasBtn'), 'primary create ' + width);
      for (const kind of ['classic', 'smart']) await reachable(page.locator('[data-workspace-create="' + kind + '"]'), kind + ' quick create ' + width);
      await reachable(page.locator('.v2-home-search'), 'project search ' + width, 30);
      const clippedCopy = await page.locator('.workspace-quick-copy, .workspace-quick-copy small').evaluateAll(items => items
        .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => ({text:el.textContent, width:el.clientWidth, content:el.scrollWidth})));
      assert.deepEqual(clippedCopy, [], 'quick action copy stays readable at ' + width);
      const cards = await page.locator('.ws-card').evaluateAll(items => items.map(el => {
        const r = el.getBoundingClientRect(); return {left:r.left, right:r.right, width:r.width};
      }));
      assert(cards.every(card => card.left >= -1 && card.right <= width + 1), 'cards stay within home viewport ' + width);
      if (width === 320) assert(cards.every(card => card.width >= 260), 'mobile card uses available width');
      await page.locator('.ws-main').evaluate(el => el.scrollTop = 0);
      await page.screenshot({path:path.join(evidence, 'home-' + width + '.png'), fullPage:false});
    }
  });

  await check('search, no results, grid/list and saved view use real existing cards', async () => {
    await page.locator('#homeSearch').fill('人物小传');
    assert.equal(await page.locator('.ws-card:visible').count(), 1);
    await page.locator('#homeSearch').fill('没有这个创作项目');
    await page.locator('#homeSearchEmpty').waitFor();
    assert.equal(await page.locator('.ws-card:visible').count(), 0);
    await page.locator('#homeSearchEmpty button').click();
    assert.equal(await page.locator('.ws-card:visible').count(), 3);
    await page.locator('[data-view="list"]').click();
    assert(await page.locator('body').evaluate(el => el.classList.contains('studio-home-list')));
    await page.reload();
    await page.waitForFunction(() => window.StudioWorkspace?.ready);
    assert(await page.locator('body').evaluate(el => el.classList.contains('studio-home-list')));
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({width, height:1000});
      await noOverflow(page, 'home list ' + width);
      await reachable(page.locator('.ws-card-menu').first(), 'list card menu ' + width, 28);
      await page.screenshot({path:path.join(evidence, 'list-' + width + '.png')});
    }
    await page.locator('[data-view="grid"]').click();
  });

  await check('card action menu supports keyboard dismissal and restores its trigger', async () => {
    const trigger = page.locator('.ws-card-menu').first();
    await trigger.click();
    const popup = page.locator('.ws-card-pop'); await popup.waitFor();
    assert.equal(await popup.getAttribute('role'), 'menu');
    const items = popup.getByRole('menuitem');
    assert(await items.first().evaluate(el => el === document.activeElement), 'opening menu focuses its first action');
    await page.keyboard.press('ArrowDown');
    assert(await items.nth(1).evaluate(el => el === document.activeElement));
    await page.keyboard.press('End');
    assert(await items.last().evaluate(el => el === document.activeElement));
    await page.keyboard.press('Home');
    assert(await items.first().evaluate(el => el === document.activeElement));
    await page.keyboard.press('Escape');
    assert.equal(await popup.count(), 0);
    assert(await trigger.evaluate(el => el === document.activeElement), 'Escape from a menu item restores the card action button');
    await trigger.click(); await page.keyboard.press('Tab');
    assert.equal(await popup.count(), 0, 'Tab dismisses action menu without trapping the page');
    await trigger.click();
    await popup.locator('[data-act="rename"]').click();
    const rename = page.locator('.ws-card-title-input');
    assert(await rename.evaluate(el => el === document.activeElement), 'rename keeps focus after action menu closes');
    await page.keyboard.press('Escape');
    assert.equal(await rename.count(), 0);
  });

  await check('mobile navigation supports keyboard, Escape, backdrop and inert hidden controls', async () => {
    for (const width of [320, 768]) {
      await page.setViewportSize({width, height:1000});
      const toggle = page.locator('#workspaceMenuToggle'), sidebar = page.locator('.ws-sidebar');
      await reachable(toggle, 'navigation toggle ' + width);
      assert(await sidebar.evaluate(el => el.inert));
      await toggle.focus();
      for (let n = 0; n < 12; n++) {
        await page.keyboard.press('Tab');
        assert(!(await page.evaluate(() => !!document.activeElement.closest('.ws-sidebar'))), 'Tab skips hidden sidebar ' + width);
      }
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert(!(await sidebar.evaluate(el => el.inert)));
      assert(await page.evaluate(() => !!document.activeElement.closest('.workspace-nav')));
      await noOverflow(page, 'opened mobile sidebar ' + width);
      for (let n = 0; n < 30; n++) {
        await page.keyboard.press('Tab');
        assert(await page.evaluate(() => !!document.activeElement.closest('.ws-sidebar')), 'opened navigation retains keyboard focus ' + width);
      }
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert(await toggle.evaluate(el => el === document.activeElement));
      await toggle.click();
      await page.locator('.workspace-sidebar-scrim').click({position:{x:width - 8, y:100}});
      assert(await sidebar.evaluate(el => el.inert));
      assert(await toggle.evaluate(el => el === document.activeElement));
      await toggle.click();
      await page.locator('.workspace-nav').getByRole('button', {name:'项目画布', exact:true}).click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert(await page.locator('#homeSearch').evaluate(el => el === document.activeElement));
    }
    await page.setViewportSize({width:1440, height:1000});
    assert(!(await page.locator('.ws-sidebar').evaluate(el => el.inert)), 'desktop sidebar becomes available after resizing');
  });

  await check('mobile trash restores a real local canvas and project selection closes navigation', async () => {
    await page.setViewportSize({width:320, height:1000});
    const toggle = page.locator('#workspaceMenuToggle');
    await toggle.click();
    await page.locator('#trashEntry').click();
    const trash = page.locator('#trashPanel');
    await trash.waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'trash closes the navigation drawer');
    assert(await page.locator('.ws-sidebar').evaluate(el => el.inert), 'closed drawer is inert');
    assert(await page.locator('.workspace-sidebar-scrim').isHidden(), 'navigation scrim no longer covers trash');
    assert(!(await trash.evaluate(el => !!el.closest('[inert]'))), 'trash panel can receive interaction');
    assert(await page.locator('#trashClose').evaluate(el => el === document.activeElement), 'trash owns keyboard focus');
    await noOverflow(page, 'mobile trash');
    const card = trash.locator('.ws-trash-card[data-canvas-id="' + trashed.id + '"]');
    await card.waitFor();
    await reachable(card.locator('.restore'), 'mobile restore action', 28);
    const restoredResponse = page.waitForResponse(value =>
      new URL(value.url()).pathname === '/api/canvases/' + trashed.id + '/restore' && value.request().method() === 'POST');
    await card.locator('.restore').click();
    assert((await restoredResponse).ok(), 'real local restore endpoint succeeds');
    await card.waitFor({state:'detached'});
    const restored = (await api('/api/canvases/' + trashed.id)).canvas;
    assert.equal(restored.title, trashed.title);
    assert.equal(restored.project, other.id, 'restored canvas retains its original project');
    await page.locator('#trashClose').click();
    await trash.waitFor({state:'hidden'});
    assert(await toggle.evaluate(el => el === document.activeElement), 'closing trash restores the navigation button');
    await toggle.click(); await page.locator('#trashEntry').click();
    await trash.waitFor(); await page.keyboard.press('Escape');
    await trash.waitFor({state:'hidden'});
    assert(await toggle.evaluate(el => el === document.activeElement), 'Escape from trash restores the navigation button');
    for (const target of [other, project]) {
      await toggle.click();
      await page.locator('.ws-project-row[data-project-id="' + target.id + '"]').click();
      await page.waitForFunction(id => currentProjectId === id, target.id);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'project folder closes navigation');
      assert(await page.locator('#homeSearch').evaluate(el => el === document.activeElement), 'selected project focuses visible search');
      assert(await page.locator('.workspace-sidebar-scrim').isHidden());
    }
    assert.equal(await page.locator('.ws-card').count(), 3, 'main project is restored for subsequent checks');
    await page.setViewportSize({width:1440, height:1000});
  });

  await check('quick actions create classic and smart canvases with correct project and persistent titles', async () => {
    for (const kind of ['classic', 'smart']) {
      const trigger = page.locator('[data-workspace-create="' + kind + '"]');
      await trigger.click();
      const dialog = page.locator('#homeCreateDialog');
      await dialog.waitFor();
      assert(await dialog.locator('[data-kind="' + kind + '"]').evaluate(el => el.classList.contains('active')));
      await dialog.locator('.ws-create-input').fill('快速创建验收 · ' + kind);
      const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/canvases' && value.request().method() === 'POST');
      await dialog.locator('.ws-create-confirm').click();
      const created = (await (await response).json()).canvas;
      assert.equal(created.kind, kind);
      assert.equal(created.project, project.id);
      await page.locator('.ws-card[data-canvas-id="' + created.id + '"]').waitFor();
      assert.equal((await api('/api/canvases/' + created.id)).canvas.title, '快速创建验收 · ' + kind);
      // Remove only this newly created fixture so design screenshots keep three covers.
      await api('/api/canvases/' + created.id, 'DELETE');
      await readyHome(project.id);
    }
  });

  await check('hero create modal is reachable on mobile and Escape restores its trigger', async () => {
    await page.setViewportSize({width:320, height:1000});
    await page.locator('#newCanvasBtn').click();
    const dialog = page.locator('#homeCreateDialog');
    await dialog.waitFor();
    await noOverflow(page, 'mobile create dialog');
    await reachable(dialog.locator('.ws-create-input'), 'create title', 32);
    await reachable(dialog.locator('.ws-create-confirm'), 'confirm creation', 32);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert(await page.locator('#newCanvasBtn').evaluate(el => el === document.activeElement));
  });

  await check('light, milk and dark themes remain readable; reduced motion disables ambient animation', async () => {
    await page.setViewportSize({width:1440, height:1000});
    const backgrounds = {};
    for (const theme of ['light', 'milk', 'dark']) {
      await page.evaluate(value => {
        localStorage.removeItem('deepwhite_canvas_material');
        localStorage.setItem('studio_theme', value === 'dark' ? 'dark' : 'light');
        if (value === 'milk') localStorage.setItem('deepwhite_canvas_material', 'milk');
      }, theme);
      await page.reload(); await page.waitForFunction(() => window.StudioWorkspace?.ready);
      await page.waitForFunction(() => document.querySelectorAll('.home-canvas-cover img').length === 3 &&
        [...document.querySelectorAll('.home-canvas-cover img')].every(image => image.complete && image.naturalWidth > 0));
      await page.evaluate(async () => {
        await Promise.all([...document.querySelectorAll('.home-canvas-cover img')].map(image => image.decode()));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const actual = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('.workspace-create-hero'));
        return {background:style.backgroundColor, foreground:style.color, milk:document.documentElement.classList.contains('studio-milk')};
      });
      backgrounds[theme] = actual.background;
      assert.notEqual(actual.background, actual.foreground, theme + ' foreground remains distinct');
      if (theme === 'milk') assert(actual.milk, 'milk material persists');
      await noOverflow(page, theme + ' theme');
      await page.screenshot({path:path.join(evidence, 'home-' + theme + '.png')});
    }
    assert.notEqual(backgrounds.light, backgrounds.dark, 'explicit light and dark materials differ');
    const animations = await page.locator('.workspace-create-hero, .workspace-quickstart button, .ws-card').evaluateAll(items =>
      items.flatMap(el => [el, ...el.querySelectorAll('*')]).flatMap(el => ['', '::before', '::after'].map(pseudo => {
        const style = getComputedStyle(el, pseudo || null);
        return {name:style.animationName, duration:style.animationDuration};
      })).filter(style => style.name !== 'none' && style.duration.split(',').some(value => parseFloat(value) > 0.001)));
    assert.deepEqual(animations, [], 'reduced motion suppresses decorative animations');
  });

  await check('navigation opens local assets and public gallery configuration without invented actions', async () => {
    await page.locator('.workspace-nav').getByRole('button', {name:'本地资产', exact:true}).click();
    await page.waitForURL('**/static/studio-assets.html?project=' + project.id);
    await page.locator('#assetList').waitFor({state:'attached'});
    await page.waitForFunction(() => !document.getElementById('projectLabel').textContent.includes('正在读取'));
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({width, height:1000});
      await noOverflow(page, 'local assets ' + width);
    }
    await page.screenshot({path:path.join(evidence, 'local-assets.png')});
    await readyHome(project.id);
    await page.locator('.workspace-nav').getByRole('button', {name:'公共画廊', exact:true}).click();
    const dialog = page.locator('#workspaceGalleryDialog');
    await dialog.waitFor();
    await dialog.locator('input:not([disabled])').waitFor();
    assert.equal(await dialog.locator('#workspaceGalleryURL').inputValue(), '');
    assert(await dialog.locator('a[href="/gallery-import"]').isVisible());
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
  });

  await check('API settings opens its real embedded page and remains inside every viewport', async () => {
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({width, height:1000});
      await page.locator('#studioSettingsButton').click();
      const dialog = page.locator('#studioSettingsDialog');
      await dialog.waitFor();
      const frame = page.frameLocator('#studioSettingsDialog iframe');
      await frame.locator('#closeSettings').waitFor();
      await page.waitForFunction(() => {
        const view = document.querySelector('#studioSettingsDialog iframe')?.contentWindow;
        return view?.StudioSettingsV2?.ready &&
          [...view.document.querySelectorAll('link[rel="stylesheet"]')].every(link => !!link.sheet);
      });
      await noOverflow(page, 'settings overlay ' + width);
      const actual = await frame.locator('body').evaluate(() => ({width:innerWidth, document:document.documentElement.scrollWidth}));
      assert(actual.document <= actual.width + 1, 'settings iframe overflow at ' + width + ': ' + JSON.stringify(actual));
      await frame.locator('#closeSettings').click();
      await dialog.waitFor({state:'hidden'});
    }
  });

  await check('prompt-only cover shows a safe excerpt while preserving the complete saved prompt', async () => {
    const prompt = '<img src=x onerror="window.workspaceXss=1"> ' +
      '清晨山谷与薄雾，柔和自然光，镜头缓慢前进，保留树木与织物纹理。'.repeat(18) +
      '\n完整提示词结尾。';
    const browserWritesBefore = writes.length;
    // Fixture preparation through Node uses only this disposable runtime. It is
    // intentionally separate from the observed user-initiated browser mutations.
    await api('/api/canvases/' + records[0].id, 'PUT', {
      title:records[0].title,
      nodes:[{id:'prompt-only', type:'text', studioPrompt:prompt, x:80, y:80, width:320, height:180}],
      connections:[],
    });
    const saved = (await api('/api/canvases/' + records[0].id)).canvas;
    await readyHome(project.id);
    const card = page.locator('.ws-card[data-canvas-id="' + records[0].id + '"]');
    const excerpt = card.locator('.home-cover-excerpt');
    await excerpt.waitFor();
    assert.equal(await excerpt.textContent(), prompt.trim().slice(0, 180));
    assert((await excerpt.textContent()).length <= 180, 'display excerpt is bounded');
    assert.match(await excerpt.textContent(), /<img src=x/, 'HTML-like input stays visible as literal text');
    assert.equal(await card.locator('.home-canvas-cover img').count(), 0, 'prompt markup never creates an image element');
    assert.equal(await page.evaluate(() => window.workspaceXss), undefined);
    const reread = (await api('/api/canvases/' + records[0].id)).canvas;
    assert.equal(reread.nodes[0].studioPrompt, prompt, 'original full prompt remains saved');
    assert.equal(reread.updated_at, saved.updated_at, 'viewing the excerpt does not resave the canvas');
    assert.equal(writes.length, browserWritesBefore);
    await page.screenshot({path:path.join(evidence, 'prompt-only.png')});
  });

  await check('no browser exceptions, external traffic, generation or unintended writes', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(paid, []); assert.deepEqual(unexpectedWrites, []);
    assert.equal(writes.filter(value => value.path === '/api/canvases' && value.method === 'POST').length, 2, 'two explicit fixture creations');
    assert.equal(writes.filter(value => value.path === '/api/canvases/' + trashed.id + '/restore' && value.method === 'POST').length, 1, 'one explicit fixture restore');
    assert.equal(writes.length, 3, 'browser writes contain only the expected create and restore operations');
  });
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({passed:true, checks, errors, external, paid, writes, unexpectedWrites, synthetic:true}, null, 2));
  console.log(JSON.stringify({passed:checks.length, evidence}));
})().catch(async error => {
  console.error(error.stack); console.error(serverLog.slice(-1600)); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({path:path.join(evidence, 'failure.png')}).catch(() => {});
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({passed:false, checks, errors, external, paid, writes, unexpectedWrites, error:String(error)}, null, 2));
}).finally(async () => {
  await browser?.close();
  if (server) {
    server.kill();
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(4000)]);
  }
  const resolved = path.resolve(runtime), temporaryRoot = path.resolve(os.tmpdir());
  assert(path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith('dw-workspace-polish-'));
  fs.rmSync(resolved, {recursive:true, force:true});
});
