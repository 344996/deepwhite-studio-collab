/* Real browser -> local backend -> generated MCP bridge.
 * All Codex and canvas data lives in a new temporary directory. The fixture
 * disables upstream API traffic; it does not mock the MCP setup endpoints.
 */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const python=process.env.PYTHON_EXECUTABLE||path.resolve(root,'../.venv/Scripts/python.exe');
const output=path.resolve(process.env.CUSTOMER_SETUP_LIVE_OUTPUT||path.join(root,'test-output/mcp-customer-live'));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-customer-live-'));
const runtime=path.join(temporary,'本地 数据');
const codexHome=path.join(temporary,'用户 配置 (离线)');
const configFile=path.join(codexHome,'config.toml');
const original=Buffer.from('# Synthetic customer configuration; no credentials.\nmodel = "fixture-model"\nsandbox_mode = "read-only"\n\n[mcp_servers.keep-me]\ncommand = "fixture-only"\nargs = ["--unchanged"]\n# Preserve this customer comment.\n','utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
let browser,child,serverError='',serverOutput='';
const checks=[],mutations=[],pageErrors=[],externalRequests=[];
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function availablePort(){
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function awaitHealth(base){
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw Error(`Isolated server exited (${child.exitCode}): ${serverError.slice(-3000)}`);
    try{const response=await fetch(base+'/api/studio/health');if(response.ok)return await response.json();}catch{}
    await sleep(400);
  }
  throw Error('Isolated server did not become ready: '+serverError.slice(-3000));
}
function parseConfig(){
  return JSON.parse(execFileSync(python,['-I','-B','-c','import json,tomllib,sys;from pathlib import Path;print(json.dumps(tomllib.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))))',configFile],{encoding:'utf8',windowsHide:true}));
}
(async()=>{
  assert(codexHome.startsWith(temporary+path.sep));
  assert(runtime.startsWith(temporary+path.sep));
  fs.mkdirSync(codexHome,{recursive:true});
  fs.mkdirSync(runtime,{recursive:true});
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(configFile,original);
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  const env={...process.env,CODEX_HOME:codexHome,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'};
  delete env.DEEPWHITE_INSTALL_ROOT;
  child=spawn(python,['-B',path.join(root,'tests/catalog-browser-server.py')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>{serverOutput=(serverOutput+data.toString('utf8')).slice(-10000);});
  child.stderr.on('data',data=>{serverError=(serverError+data.toString('utf8')).slice(-10000);});
  child.on('error',error=>{serverError+=error.message;});
  const health=await awaitHealth(base);
  assert.equal(health.ready,true);
  const statusBefore=await(await fetch(base+'/api/studio/control/codex')).json();
  assert.equal(statusBefore.state,'missing');
  assert.equal(path.resolve(statusBefore.config_path),path.resolve(configFile));
  assert.equal(statusBefore.portable,false);
  assert.equal(hash(fs.readFileSync(configFile)),hash(original),'reading status must not change the config');
  checks.push('独立端口和临时 CODEX_HOME / 画布数据目录；真实后端状态读取不改动配置');

  browser=await chromium.launch({...process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{channel:'msedge'},headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050}});
  await context.route('**/*',route=>{
    const url=route.request().url();
    if(url.startsWith(base+'/'))return route.continue();
    externalRequests.push(new URL(url).origin);return route.abort();
  });
  const page=await context.newPage();
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('request',request=>{
    if(!['GET','HEAD','OPTIONS'].includes(request.method()))mutations.push({method:request.method(),path:new URL(request.url()).pathname});
  });
  await page.goto(base+'/settings');
  await page.locator('[data-tab=control]').click();
  await page.waitForFunction(()=>document.getElementById('controlCodexBadge').textContent==='尚未配置');
  assert.equal(await page.locator('#controlEnabled').isChecked(),false);
  assert.equal(await page.locator('#controlInstallCodex').isDisabled(),true);
  assert.equal(await page.locator('#controlClientConfig').isHidden(),true);
  assert.equal(hash(fs.readFileSync(configFile)),hash(original));
  await page.locator('#controlEnabled').check();
  await page.waitForFunction(()=>!document.getElementById('controlInstallCodex').disabled);
  assert.equal(hash(fs.readFileSync(configFile)),hash(original),'enabling MCP alone must not install');
  await page.screenshot({path:path.join(output,'actual-settings-first-run.png'),fullPage:true});
  checks.push('实际设置页面按需读取；未启用时禁止安装，启用访问不会自动写入 Codex 配置');

  const installedResponse=page.waitForResponse(response=>response.url()===base+'/api/studio/control/codex'&&response.request().method()==='POST');
  await page.locator('#controlInstallCodex').click();
  const response=await installedResponse,installed=await response.json();
  assert.equal(response.status(),200,JSON.stringify(installed));
  assert.equal(installed.state,'installed');
  assert.equal(installed.changed,true);
  await page.getByText('已配置',{exact:true}).waitFor();
  const actual=parseConfig(),originalParsed={model:'fixture-model',sandbox_mode:'read-only',mcp_servers:{'keep-me':{command:'fixture-only',args:['--unchanged']}}};
  assert.equal(actual.model,originalParsed.model);
  assert.equal(actual.sandbox_mode,originalParsed.sandbox_mode);
  assert.deepEqual(actual.mcp_servers['keep-me'],originalParsed.mcp_servers['keep-me']);
  assert(fs.readFileSync(configFile,'utf8').includes('# Preserve this customer comment.'));
  assert(fs.readFileSync(configFile,'utf8').includes('# Synthetic customer configuration; no credentials.'));
  const bridge=actual.mcp_servers['deepwhite-studio'];
  assert.equal(path.resolve(bridge.command),path.resolve(python));
  assert(bridge.args.includes(base));
  assert.equal(path.resolve(bridge.env.DEEPWHITE_STUDIO_RUNTIME_DIR),path.resolve(runtime));
  assert(fs.readdirSync(path.join(codexHome,'deepwhite-backups')).some(name=>name.endsWith('.toml')));
  checks.push('浏览器真实 Origin / JSON 请求成功安装；保留模型、其他 MCP 与注释，创建备份，路径与端口来自本次独立安装');

  const diagnosticResponse=page.waitForResponse(response=>response.url()===base+'/api/studio/control/diagnostics'&&response.request().method()==='POST');
  await page.locator('#controlCheck').click();
  const diagnostics=await(await diagnosticResponse).json();
  assert.equal(diagnostics.ok,true,JSON.stringify(diagnostics));
  await page.getByText('本机检查通过',{exact:true}).waitFor();
  assert.match(await page.locator('#controlSetupResult').innerText(),/能列出画布后，才表示 Codex 接入成功/);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(output,'actual-settings-connected.png'),fullPage:true});
  checks.push('真实后端启动 MCP 桥接进程并完成本机只读检查；界面仍要求客户在 Codex 发送提示词确认');

  await page.locator('#controlAdvanced>summary').click();
  assert.equal(await page.locator('#controlCodexPath').innerText(),installed.config_path);
  assert.equal(await page.locator('#controlUndoCodex').isDisabled(),false);
  page.once('dialog',dialog=>dialog.accept());
  const undoResponse=page.waitForResponse(response=>response.url()===base+'/api/studio/control/codex'&&response.request().method()==='POST');
  await page.locator('#controlUndoCodex').click();
  const undone=await(await undoResponse).json();
  assert.equal(undone.state,'missing');
  assert.equal(undone.changed,true);
  await page.getByText('尚未配置',{exact:true}).waitFor();
  assert.equal(hash(fs.readFileSync(configFile)),hash(original),'undo must restore original bytes when otherwise unchanged');
  assert.deepEqual(parseConfig(),originalParsed);
  checks.push('通过界面撤回上次配置，真实配置文件逐字节恢复，其他 MCP 和用户设置保留');
  assert.deepEqual(pageErrors,[]);
  assert(mutations.every(item=>['/api/studio/control/settings','/api/studio/control/codex','/api/studio/control/diagnostics'].includes(item.path)),JSON.stringify(mutations));
  assert.equal(mutations.filter(item=>item.path==='/api/studio/control/codex').length,2);
  const report={passed:true,version:health.version,checks,page_errors:pageErrors,setup_writes:2,external_requests_blocked:[...new Set(externalRequests)],original_config_hash:hash(original),restored_config_hash:hash(fs.readFileSync(configFile)),diagnostic_checks:diagnostics.checks?.map(({step,ok,code})=>({step,ok,code})),scope:'实际设置页面与真实本机配置接口、MCP 桥接进程；临时 CODEX_HOME 与数据目录，第三方生成请求禁用。未改动用户真实配置，未启动真实 Codex 会话。',screenshots:['actual-settings-first-run.png','actual-settings-connected.png']};
  fs.writeFileSync(path.join(output,'live-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();
  if(child&&child.exitCode===null){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)]);}
});
