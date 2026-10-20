/* Isolated browser verification: actual panel markup, mocked local APIs and clipboard.
 * This never opens or edits the user's Codex configuration and never calls generation APIs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.CONTROL_UI_OUTPUT || path.join(root, 'test-output/mcp-customer'));
const settings = fs.readFileSync(path.join(root, 'static/studio-settings.html'), 'utf8');
const section = '<section id="controlPanel" hidden>' +
  settings.split('<section id="controlPanel" hidden>')[1].split('<section id="comfyPanel"')[0];
assert(section.includes('controlInstallCodex'), 'exercise the current real settings panel');
const html = `<!doctype html><html lang="zh-CN" class="studio-v2 studio-v2-settings studio-graphite studio-settings-sidebar"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP customer setup test</title>
${['studio-settings.css','studio-control.css','studio-v2-theme.css','studio-settings-v2.css','studio-settings-navigation.css','studio-interactions.css'].map(file=>`<link rel="stylesheet" href="/static/${file}">`).join('')}
</head><body><div class="settings-top"><header><div><strong>深白片场 <span>设置</span></strong></div><button id="closeSettings">返回画布</button></header>
<nav aria-label="设置分类"><button data-tab="api" aria-selected="true">账户与 API</button><button data-tab="control" aria-selected="false">外接智能体 / MCP</button><button data-tab="general" aria-selected="false">基础设置</button></nav></div>
<main><section id="apiPanel"></section><section id="generalPanel" hidden></section>${section}</main>
<script src="/static/studio-control.js"></script><script src="/static/studio-interactions.js"></script></body></html>`;
const testPrompt = '请用 deepwhite-studio 列出我的画布，不修改或生成内容。';
let state = {
  enabled:false,generation_mode:'confirm',session_expires_at:null,remaining_runs:0,
  client_config:{mcpServers:{'deepwhite-studio':{command:'Z:\\客户 软件 & 测试\\DeepWhite\\python.exe',args:['bridge.py']}}},
  pending:[
    {id:'approval-fixture',title:'分镜概念图',prompt:'雨夜，旧车站，冷色电影光。',model:'image-fixture',provider_id:'provider-fixture',quote:null,status:'pending'},
    {id:'reject-fixture',title:'角色草图',prompt:'一位旅人。',model:'image-fixture',provider_id:'provider-fixture',quote:{display:'约 ¥0.12'},status:'pending'},
    {id:'done-fixture',title:'已执行请求',prompt:'已结束。',model:'image-fixture',quote:null,status:'approved'}
  ]
};
state.client_configs = {codex_toml:'[mcp_servers.deepwhite-studio]\ncommand = "Z:\\\\客户 软件 & 测试\\\\DeepWhite\\\\python.exe"\nargs = ["bridge.py"]',claude_json:state.client_config};
state.check_command = "& 'Z:\\客户 软件 & 测试\\DeepWhite\\python.exe' 'bridge.py' '--check' '--json'";
state.stable_launcher = true;
let codex = {state:'missing',revision:'initial',config_path:'C:\\Users\\客户\\.codex\\config.toml',message:'尚未配置深白连接。点击按钮即可自动配置。',can_install:true,can_undo:false,portable:true};
let diagnosticFails = true, failAction = null, failRead = false, acceptDialog = true, actionDelay = 0;
let browser;
const calls = [], dialogs = [], checks = [];
const app = http.createServer((req,res)=>{
  const pathname = new URL(req.url,'http://127.0.0.1').pathname;
  if (pathname === '/settings') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(html); return; }
  const match = /^\/static\/([a-z0-9-]+\.(?:js|css))$/.exec(pathname);
  if (match) {
    const file = path.join(root,'static',match[1]);
    if (fs.existsSync(file)) {
      res.writeHead(200,{'Content-Type':match[1].endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});
      res.end(fs.readFileSync(file)); return;
    }
  }
  res.writeHead(404); res.end();
});
const count = (method, endpoint) => calls.filter(call => call.method === method && call.path === endpoint).length;
const setupPosts = () => count('POST','/api/studio/control/codex');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  browser = await chromium.launch({...process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{channel:'msedge'},headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1050}});
  await context.addInitScript(()=>{
    window.__copiedText = '';
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copiedText=text;}}});
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{dialogs.push(dialog.message()); if(acceptDialog)await dialog.accept(); else await dialog.dismiss();});
  await page.route(`${base}/api/**`,async route=>{
    const req=route.request(), url=new URL(req.url()), body=req.postDataJSON();
    calls.push({method:req.method(),path:url.pathname,body});
    if(url.pathname==='/api/studio/control/settings'&&req.method()==='GET')return route.fulfill({json:state});
    if(url.pathname==='/api/studio/control/codex'){
      if(req.method()==='GET'){
        if(failRead)return route.fulfill({status:503,json:{detail:'配置状态暂时不可用，请稍后重试。'}});
        return route.fulfill({json:codex});
      }
      if(req.method()==='POST'){
        assert.equal(typeof body.expected_revision,'string');
        assert.equal(typeof body.replace_existing,'boolean');
        if(actionDelay)await pause(actionDelay);
        if(failAction){const failure=failAction;failAction=null;return route.fulfill({status:failure.status,json:{detail:failure.message}});}
        assert.equal(body.expected_revision,codex.revision,'use the most recently fetched revision');
        if(body.action==='install'){
          assert.equal(state.enabled,true,'install requires explicit MCP enablement');
          if(codex.state==='different')assert.equal(body.replace_existing,true,'replacement requires an explicit choice');
          codex={...codex,state:'installed',revision:codex.revision+'-installed',message:'深白连接已配置，原有配置已备份。请重启或重新连接 Codex。',can_install:true,can_undo:true};
        }else{
          assert.equal(body.action,'undo');
          codex={...codex,state:'missing',revision:codex.revision+'-undone',message:'已撤回上次配置，恢复配置前的内容。',can_install:true,can_undo:false};
        }
        return route.fulfill({json:{...codex,changed:true}});
      }
    }
    if(url.pathname==='/api/studio/control/diagnostics'&&req.method()==='POST')return route.fulfill({json:{
      ok:!diagnosticFails,checks:[{step:'画布服务与安装',ok:!diagnosticFails,code:diagnosticFails?'connection_refused':'ok',
        message:diagnosticFails?'本机画布未监听此端口。':'',hint:diagnosticFails?'先在运行客户端的电脑启动画布。':''}],
      scope:'这是画布进程的检查结果；请在 Codex 中确认能够发现并调用工具。'
    }});
    if(url.pathname==='/api/studio/control/settings'&&req.method()==='PUT'){
      if(Object.hasOwn(body,'generation_mode'))state={...state,generation_mode:body.generation_mode,session_expires_at:body.generation_mode==='session'?Math.floor(Date.now()/1000)+600:null,remaining_runs:body.generation_mode==='session'?20:0};
      if(Object.hasOwn(body,'enabled'))state={...state,enabled:body.enabled};
      return route.fulfill({json:state});
    }
    if(url.pathname.startsWith('/api/studio/control/approvals/')&&req.method()==='POST'){
      const id=url.pathname.split('/').pop();state={...state,pending:state.pending.filter(item=>item.id!==id)};
      return route.fulfill({json:{status:body.action}});
    }
    return route.fulfill({status:404,json:{detail:'unexpected mock API request'}});
  });

  await page.goto(`${base}/settings`);
  assert.equal(await page.locator('#controlPanel').isHidden(),true);
  assert.equal(calls.length,0,'opening unrelated settings must not read or write client configuration');
  await page.locator('[data-tab="control"]').click();
  await page.getByText('费用未知',{exact:true}).waitFor();
  await page.getByText('尚未配置深白连接。点击按钮即可自动配置。',{exact:true}).waitFor();
  assert.equal(count('GET','/api/studio/control/settings'),1);
  assert.equal(count('GET','/api/studio/control/codex'),1);
  assert.equal(setupPosts(),0,'opening setup only checks status');
  assert.equal(await page.locator('#controlAutoRefresh').isChecked(),false);
  assert.equal(await page.locator('#controlAdvanced').getAttribute('open'),null);
  assert.equal(await page.locator('#controlClientConfig').isHidden(),true);
  assert.equal(await page.locator('#controlInstallCodex').isDisabled(),true);
  assert.equal(await page.locator('#controlCheck').isDisabled(),true);
  assert(!((await page.locator('body').innerText()).includes('C:\\Users')||(await page.locator('body').innerText()).includes('Z:\\')),'primary flow shows no configuration paths');
  checks.push('首次打开仅读取状态；未启用时不能安装，主流程默认不显示路径或配置代码');

  await page.locator('#controlEnabled').focus(); await page.keyboard.press('Space');
  await page.getByText('已启用',{exact:true}).waitFor();
  assert.equal(setupPosts(),0,'enabling access does not silently install a client configuration');
  await page.screenshot({path:path.join(output,'desktop-codex-first-run.png'),fullPage:true});
  failAction={status:500,message:'无法写入配置，请检查目录权限后重试。'}; actionDelay=250;
  await page.locator('#controlInstallCodex').click();
  assert.equal(await page.locator('#controlInstallCodex').isDisabled(),true);
  await page.keyboard.press('Enter');
  await page.getByText('无法写入配置，请检查目录权限后重试。',{exact:true}).waitFor();
  await page.waitForFunction(()=>!document.getElementById('controlInstallCodex').disabled);
  assert.equal(setupPosts(),1,'busy setup must not issue duplicate writes');
  assert.equal(await page.locator('#controlSetupResult').getAttribute('role'),'alert');
  actionDelay=0;
  await page.locator('#controlInstallCodex').focus(); await page.keyboard.press('Enter');
  await page.getByText('已配置',{exact:true}).waitFor();
  assert.equal(setupPosts(),2);
  assert.equal(calls.filter(call=>call.path==='/api/studio/control/codex'&&call.method==='POST').at(-1).body.replace_existing,false);
  assert.equal(await page.locator('#controlInstallCodex').isDisabled(),true);
  assert.match(await page.locator('#controlInstallHelp').innerText(),/重启或重新连接 Codex/);
  await page.locator('#controlCopyPrompt').click();
  assert.equal(await page.evaluate(()=>window.__copiedText),testPrompt);
  assert.equal(await page.locator('#controlCheckStatus').innerText(),'尚未检查');
  checks.push('键盘启用与安装、重复提交保护、安装失败在步骤旁显示并可重试，成功后提示重连和只读测试');

  await page.locator('#controlCheck').click();
  await page.getByText(/先在运行客户端的电脑启动画布/).waitFor();
  assert.equal(await page.locator('#controlSetupResult').getAttribute('data-error'),'true');
  const summary=page.locator('#controlAdvanced>summary');
  await summary.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#controlClientConfig').isVisible(),true);
  assert.match(await page.locator('#controlClientConfig').innerText(),/mcp_servers\.deepwhite-studio/);
  assert.match(await page.locator('#controlInstallType').innerText(),/便携发行版/);
  assert.equal(await page.locator('#controlCodexPath').innerText(),codex.config_path);
  await page.locator('#controlClientType').selectOption('claude_json');
  assert.match(await page.locator('#controlClientConfig').innerText(),/mcpServers/);
  assert.match(await page.locator('#controlClientHelp').innerText(),/自动配置仅支持 Codex/);
  await page.locator('#controlClientType').selectOption('codex_toml');
  await page.locator('#controlCopyConfig').click();
  assert.match(await page.evaluate(()=>window.__copiedText),/mcp_servers\.deepwhite-studio/);
  await page.locator('#controlCopyCheck').click();
  assert.equal(await page.evaluate(()=>window.__copiedText),state.check_command);
  const downloaded=page.waitForEvent('download');
  await page.locator('#controlExportDiagnostics').click();
  const diagnosticFile=await downloaded;
  assert.equal(diagnosticFile.suggestedFilename(),'deepwhite-mcp-diagnostics.json');
  assert.equal(JSON.parse(fs.readFileSync(await diagnosticFile.path(),'utf8')).checks[0].code,'connection_refused');
  await summary.focus(); await page.keyboard.press('Space');
  assert.equal(await page.locator('#controlClientConfig').isHidden(),true);
  diagnosticFails=false; await page.locator('#controlCheck').click();
  await page.getByText('通过 · 画布服务与安装',{exact:true}).waitFor();
  assert.equal(await page.locator('#controlCheckStatus').innerText(),'本机检查通过');
  assert.match(await page.locator('#controlSetupResult').innerText(),/能列出画布后，才表示 Codex 接入成功/);
  checks.push('高级配置可用键盘展开，Codex 与其他客户端配置、复制及检查结果导出保留；本机检查不冒充 Codex 联调');

  codex={...codex,state:'different',revision:'external-change',message:'现有深白连接指向另一个安装位置。请确认是否更新。'};
  await page.locator('#controlRefreshCodex').click();
  await page.getByText('需要更新',{exact:true}).waitFor();
  let before=setupPosts(); acceptDialog=false;
  await page.locator('#controlInstallCodex').click();
  assert.equal(setupPosts(),before,'cancelled replacement must not write');
  assert.match(dialogs.at(-1),/已有另一份深白连接配置/);
  acceptDialog=true;
  await page.locator('#controlInstallCodex').click();
  await page.getByText('已配置',{exact:true}).waitFor();
  assert.equal(setupPosts(),before+1);
  assert.equal(calls.filter(call=>call.method==='POST'&&call.path==='/api/studio/control/codex').at(-1).body.replace_existing,true);
  assert.equal(await page.locator('#controlCheckStatus').innerText(),'尚未检查','configuration changes invalidate earlier diagnostics');
  await summary.click(); before=setupPosts(); acceptDialog=false;
  await page.locator('#controlUndoCodex').click();
  assert.equal(setupPosts(),before,'cancelled undo must not write');
  acceptDialog=true; await page.locator('#controlUndoCodex').click();
  await page.getByText('尚未配置',{exact:true}).waitFor();
  assert.equal(setupPosts(),before+1);
  assert.equal(await page.locator('#controlUndoCodex').isDisabled(),true);
  assert.match(dialogs.at(-1),/撤回上次/);
  checks.push('检测其他安装位置后必须确认替换，取消无写入；撤回单独确认且成功后重置检查状态');

  codex={...codex,state:'missing',revision:'stale-before-click',portable:false,can_install:true};
  await page.locator('#controlRefreshCodex').click();
  await page.waitForFunction(()=>!document.getElementById('controlInstallCodex').disabled);
  failAction={status:409,message:'配置文件已发生变化。请刷新状态后重新确认。'};
  codex={...codex,state:'different',revision:'fresh-after-conflict',message:'检测到另一份深白连接，请确认更新。'};
  before=setupPosts(); await page.locator('#controlInstallCodex').click();
  await page.getByText('配置文件已发生变化。请刷新状态后重新确认。',{exact:true}).waitFor();
  await page.getByText('需要更新',{exact:true}).waitFor();
  assert.equal(setupPosts(),before+1,'conflicts must not trigger a hidden automatic retry');
  await page.locator('#controlInstallCodex').click();
  await page.getByText('已配置',{exact:true}).waitFor();
  assert.equal(calls.filter(call=>call.method==='POST'&&call.path==='/api/studio/control/codex').at(-1).body.expected_revision,'fresh-after-conflict');
  assert.match(await page.locator('#controlInstallType').innerText(),/源码运行模式/);
  failRead=true; await page.locator('#controlRefreshCodex').click();
  await page.getByText('配置状态暂时不可用，请稍后重试。',{exact:true}).waitFor();
  assert.equal(await page.locator('#controlInstallCodex').isDisabled(),true);
  failRead=false;
  codex={...codex,state:'blocked',can_install:false,can_undo:false,message:'配置文件存在错误，请先修复后刷新。'};
  await page.locator('#controlRefreshCodex').click();
  await page.getByText('配置文件存在错误，请先修复后刷新。',{exact:true}).waitFor();
  assert.equal(await page.locator('#controlInstallCodex').isDisabled(),true);
  codex={...codex,state:'installed',can_install:true,can_undo:true,portable:true,message:'深白连接已配置。'};
  await page.locator('#controlRefreshCodex').click();
  await page.getByText('已配置',{exact:true}).waitFor();
  await summary.click();
  checks.push('文件并发修改会刷新状态并重新确认，禁止隐式覆盖；读取失败与损坏配置显示阻塞原因并可刷新恢复');

  assert.equal(await page.locator('.control-request').count(),2);
  assert.equal(await page.getByText('费用参考：约 ¥0.12',{exact:true}).count(),1);
  const promptCard=page.locator('.control-request').filter({hasText:'分镜概念图'});
  await promptCard.getByRole('button',{name:'查看提示词'}).click();
  assert.match(await promptCard.locator('pre').innerText(),/雨夜/);
  await page.locator('#controlSession').click();
  await page.getByText(/剩余 20 次/).waitFor();
  assert.match(await page.locator('#controlSessionStatus').innerText(),/到期/);
  await page.locator('#controlEnabled').uncheck();
  await page.getByText('未启用',{exact:true}).waitFor();
  assert.equal(await promptCard.getByRole('button',{name:'批准并执行'}).isDisabled(),true);
  assert.equal(await page.locator('#controlCheck').isDisabled(),true);
  assert.equal(await page.locator('#controlInstallCodex').isDisabled(),true);
  await page.locator('#controlEnabled').check();
  await page.locator('.control-request').filter({hasText:'角色草图'}).getByRole('button',{name:'拒绝'}).click();
  await page.getByText('角色草图',{exact:false}).waitFor({state:'detached'});
  await promptCard.getByRole('button',{name:'批准并执行'}).click();
  await page.getByText('当前没有待确认的生成请求。',{exact:true}).waitFor();
  state={...state,generation_mode:'session',session_expires_at:Math.floor(Date.now()/1000)-1,remaining_runs:20};
  await page.locator('#controlRefresh').click();
  await page.getByText(/授权已结束或次数已用尽/).waitFor();
  assert.equal(await page.locator('#controlConfirm').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#controlEndSession').isHidden(),true);
  checks.push('待确认生成、提示词、费用、开关禁用、批准与拒绝、过期授权回到逐次确认仍正常');

  const setupReads=count('GET','/api/studio/control/codex'), settingsReads=count('GET','/api/studio/control/settings');
  await page.locator('#controlAutoRefresh').check();
  await page.waitForTimeout(8300);
  await page.locator('#controlAutoRefresh').uncheck();
  assert(count('GET','/api/studio/control/settings')>settingsReads);
  assert.equal(count('GET','/api/studio/control/codex'),setupReads,'pending polling must not inspect or change client config');
  checks.push('自动刷新只轮询待确认请求，不轮询或修改 Codex 配置');

  await page.locator('#controlCheck').click();
  await page.getByText('本机检查通过',{exact:true}).waitFor();
  await page.locator('#controlCheck').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#controlCopyPrompt').evaluate(el=>el===document.activeElement),true);
  assert.notEqual(await page.locator('#controlCopyPrompt').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(output,'desktop-codex-setup.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'mobile page must not overflow');
  assert.equal(await page.locator('#controlClientConfig').isHidden(),true);
  await page.screenshot({path:path.join(output,'mobile-codex-setup.png'),fullPage:true});
  await page.setViewportSize({width:320,height:740});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'small mobile page must not overflow');
  await summary.click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'long paths must wrap in advanced mode');
  await summary.click();
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.control-step-number').first().evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
  await page.setViewportSize({width:1440,height:1050});
  await page.evaluate(()=>{document.documentElement.classList.replace('studio-graphite','studio-milk');window.scrollTo(0,0);});
  await page.screenshot({path:path.join(output,'desktop-codex-setup-light.png'),fullPage:true});
  checks.push('深浅主题、键盘焦点、折叠操作、390/320px 窄屏与减少动画设置正常');
  assert.deepEqual(errors,[]);
  assert(calls.every(call=>call.path.startsWith('/api/studio/control/')));
  assert(calls.some(call=>call.method==='POST'&&call.body?.action==='approve'));
  assert(calls.some(call=>call.method==='POST'&&call.body?.action==='reject'));
  const report={passed:true,checks,scope:'真实面板 HTML/CSS/JS；浏览器接口和剪贴板均为隔离模拟，不修改真实 Codex 配置，不调用真实生成。',browser_errors:errors,setup_posts:setupPosts(),screenshots:['desktop-codex-first-run.png','desktop-codex-setup.png','mobile-codex-setup.png','desktop-codex-setup-light.png']};
  fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();app.close();});
