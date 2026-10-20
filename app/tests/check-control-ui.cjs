const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright');

const root=path.resolve(__dirname,'..');
const js=fs.readFileSync(path.join(root,'static/studio-control.js'),'utf8');
const html=`<!doctype html><html><body>
<nav><button data-tab="api" aria-selected="true">API</button><button data-tab="control" aria-selected="false">MCP</button><button data-tab="general" aria-selected="false">基础</button></nav>
<section id="apiPanel"></section><section id="generalPanel" hidden></section><section id="controlPanel" hidden>
<div id="controlLoadError" hidden></div><input id="controlEnabled" type="checkbox"><button id="controlConfirm"></button><button id="controlSession"></button><span id="controlSessionStatus"></span><button id="controlEndSession" hidden></button><pre id="controlClientConfig"></pre><button id="controlCopyConfig"></button><input id="controlAutoRefresh" type="checkbox"><button id="controlRefresh"></button><div id="controlPending"></div><div id="controlResult" hidden></div>
</section><script src="/static/studio-control.js"></script></body></html>`;
let state={enabled:true,generation_mode:'confirm',session_expires_at:null,remaining_runs:0,client_config:{mcpServers:{deepwhiteStudio:{url:'http://127.0.0.1:3874/mcp'}}},pending:[{id:'approval-fixture',canvas_id:'canvas-fixture',node_id:'node-fixture',title:'分镜概念图',prompt:'雨夜，旧车站，冷色电影光。',model:'image-fixture',provider_id:'provider-fixture',quote:null,status:'pending'},{id:'reject-fixture',canvas_id:'canvas-fixture',node_id:'node-reject',title:'角色草图',prompt:'一位旅人。',model:'image-fixture',provider_id:'provider-fixture',quote:{display:'约 ¥0.12'},status:'pending'},{id:'done-fixture',canvas_id:'canvas-fixture',node_id:'node-done',title:'已执行请求',prompt:'已结束。',model:'image-fixture',provider_id:'provider-fixture',quote:null,status:'approved'}]};
state.client_configs={codex_toml:'[mcp_servers.deepwhite-studio]\ncommand = "python"\nargs = ["bridge.py"]',claude_json:state.client_config};
state.check_command="& 'python' 'bridge.py' '--check' '--json'";
let diagnosticFails=true;
const calls=[];let browser,server;
const app=http.createServer((req,res)=>{
  if(req.url==='/settings'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
  if(req.url==='/static/studio-control.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(js);return;}
  res.writeHead(404);res.end();
});
(async()=>{
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext();const page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.route(`${base}/api/**`,async route=>{
    const req=route.request(),url=new URL(req.url()),body=req.postDataJSON?.();calls.push({method:req.method(),path:url.pathname,body});
    if(url.pathname==='/api/studio/control/settings'&&req.method()==='GET')return route.fulfill({json:state});
    if(url.pathname==='/api/studio/control/diagnostics'&&req.method()==='POST')return route.fulfill({json:{
      ok:!diagnosticFails,checks:[{step:'画布服务与安装',ok:!diagnosticFails,
        code:diagnosticFails?'connection_refused':'ok',message:diagnosticFails?'本机画布未监听此端口。':'',
        hint:diagnosticFails?'先在运行客户端的电脑启动画布。':''}],
      scope:'当前进程检查，不代表其他电脑的客户端环境。'}});
    if(url.pathname==='/api/studio/control/settings'&&req.method()==='PUT'){
      if(Object.hasOwn(body,'generation_mode'))state={...state,generation_mode:body.generation_mode,session_expires_at:body.generation_mode==='session'?Math.floor(Date.now()/1000)+600:null,remaining_runs:body.generation_mode==='session'?20:0};
      if(Object.hasOwn(body,'enabled'))state={...state,enabled:body.enabled};
      return route.fulfill({json:state});
    }
    if(url.pathname.startsWith('/api/studio/control/approvals/')&&req.method()==='POST'){
      const id=url.pathname.split('/').pop();state={...state,pending:state.pending.filter(item=>item.id!==id)};return route.fulfill({json:{status:body.action}});
    }
    return route.fulfill({status:404,json:{detail:'unexpected mock API request'}});
  });
  await page.goto(`${base}/settings`);
  assert.equal(await page.locator('#controlPanel').isHidden(),true);
  assert.equal(await page.locator('#controlAutoRefresh').isChecked(),false);
  await page.locator('[data-tab="control"]').click();
  await page.getByText('费用未知',{exact:true}).waitFor();
  assert.match(await page.locator('#controlClientConfig').innerText(),/mcp_servers\.deepwhite-studio/);
  await page.locator('#controlClientType').selectOption('claude_json');
  assert.match(await page.locator('#controlClientConfig').innerText(),/mcpServers/);
  await page.locator('#controlClientType').selectOption('codex_toml');
  await page.locator('#controlCheck').click();
  await page.getByText(/先在运行客户端的电脑启动画布/).waitFor();
  const downloaded=page.waitForEvent('download');
  await page.locator('#controlExportDiagnostics').click();
  const diagnosticFile=await downloaded;
  assert.equal(diagnosticFile.suggestedFilename(),'deepwhite-mcp-diagnostics.json');
  assert.equal(JSON.parse(fs.readFileSync(await diagnosticFile.path(),'utf8')).checks[0].code,'connection_refused');
  diagnosticFails=false;await page.locator('#controlCheck').click();
  await page.getByText('通过 · 画布服务与安装',{exact:true}).waitFor();
  assert.equal(await page.locator('.control-request').count(),2,'only pending items should render action cards');
  assert.equal(await page.getByText('费用参考：约 ¥0.12',{exact:true}).count(),1);
  const promptCard=page.locator('.control-request').filter({hasText:'分镜概念图'});
  await promptCard.getByRole('button',{name:'查看提示词'}).click();
  assert.equal(await promptCard.locator('pre').isVisible(),true);
  assert.match(await promptCard.locator('pre').innerText(),/雨夜/);
  await page.locator('#controlSession').click();
  await page.getByText(/剩余 20 次/).waitFor();
  await page.getByText(/到期/).waitFor();
  assert(calls.some(call=>call.method==='PUT'&&call.body?.generation_mode==='session'));
  await page.locator('#controlEnabled').uncheck();
  assert.equal(await page.locator('.control-request').filter({hasText:'分镜概念图'}).getByRole('button',{name:'批准并执行'}).isDisabled(),true);
  await page.locator('#controlEnabled').check();
  await page.locator('.control-request').filter({hasText:'角色草图'}).getByRole('button',{name:'拒绝'}).click();
  await page.getByText('角色草图',{exact:false}).waitFor({state:'detached'});
  await promptCard.getByRole('button',{name:'批准并执行'}).click();
  await page.getByText('当前没有待确认的生成请求。',{exact:true}).waitFor();
  assert(calls.some(call=>call.method==='POST'&&call.body?.action==='approve'));
  assert.equal(calls.filter(call=>call.method==='GET').length,3,'only the one-time load and post-decision refreshes should read');
  state={...state,generation_mode:'session',session_expires_at:Math.floor(Date.now()/1000)-1,remaining_runs:20};
  await page.locator('#controlRefresh').click();
  await page.getByText(/授权已结束或次数已用尽/).waitFor();
  assert.equal(await page.locator('#controlConfirm').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#controlEndSession').isHidden(),true);
  assert.deepEqual(errors,[]);
  assert(calls.every(call=>call.path.startsWith('/api/studio/control/')));
  assert(calls.some(call=>call.method==='POST'&&call.body?.action==='reject'));
  console.log(JSON.stringify({passed:true,checks:['MCP 面板按需读取，自动刷新默认关闭','Codex TOML 与 Claude JSON 可切换','连接检查显示分层错误与建议，修正后重试通过，下载诊断结果','Unix秒到期时间、次数耗尽授权会正确结束并回到逐次确认','客户端配置可读，提示词可展开，已知报价与未知费用分别展示，非待确认状态不显示操作卡','通道关闭时不能批准，批准和拒绝只命中模拟控制接口','浏览器无脚本错误']},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)server.close();app.close();});
