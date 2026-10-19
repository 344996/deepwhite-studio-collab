'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-update-ui-'));
const output=path.join(root,'test-output/updates');fs.mkdirSync(output,{recursive:true});
const checks=[],errors=[],external=[];let server,browser,log='';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base='http://127.0.0.1:'+port;
  server=spawn(process.env.PYTHON_EXECUTABLE||'python',['-B','studio_server.py'],{cwd:root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',DEEPWHITE_INSTALL_ROOT:'',DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port)}});
  server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
  for(let i=0;i<250;i++){try{if((await fetch(base+'/api/studio/health')).ok)break;}catch{}await wait(100);if(i===249)throw Error(log);}
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(base+'/updates');await page.locator('#status').getByText(/源码运行版/).waitFor();assert(await page.locator('#check').isDisabled());checks.push('Actual source server reports source mode and disables program replacement');
  const compatibility=await(await fetch(base+'/api/check-update')).json();assert.equal(compatibility.latest_version,null);assert.equal(compatibility.phase,'source');checks.push('Legacy update check no longer falsely claims latest release');
  let state={managed:true,phase:'available',current_version:'0.10.2-studio.16',latest_version:'0.10.2-studio.17',notes:'<img src=x onerror=alert(1)> Synthetic release',can_install:false,can_rollback:false},calls=[];
  await page.route('**/api/studio/updates/**',async route=>{
    const action=new URL(route.request().url()).pathname.split('/').pop();
    if(action==='status')return route.fulfill({json:state});
    calls.push({action,body:route.request().postDataJSON()});
    if(action==='download')state={...state,phase:'ready',can_install:true};
    if(action==='install')state={...state,phase:route.request().postDataJSON().action==='rollback'?'rolled_back':'installed',current_version:route.request().postDataJSON().action==='rollback'?'0.10.2-studio.16':'0.10.2-studio.17',can_install:false,can_rollback:true};
    return route.fulfill({json:{accepted:true}});
  });
  await page.reload();await page.locator('#download').waitFor();assert.equal(await page.locator('#notes img').count(),0);checks.push('Signed release notes are displayed as text, not HTML');
  await page.locator('#download').click();await page.locator('#install').waitFor();assert.equal(calls[0].action,'download');checks.push('Download ready state unlocks installation');
  await page.locator('#install').click();assert(await page.locator('#confirmAction').isDisabled());await page.locator('#confirm button[value=cancel]').click();assert(!calls.some(c=>c.action==='install'));checks.push('Installation requires explicit saved-and-closed confirmation; cancelling sends nothing');
  await page.locator('#install').click();await page.locator('#saved').check();await page.locator('#confirmAction').click();await page.locator('#status').getByText('更新完成。可以重新打开画布。',{exact:true}).waitFor();
  assert.deepEqual(calls.find(c=>c.action==='install').body,{action:'install',saved_and_closed:true});checks.push('Confirmed install returns successful new-version status');
  await page.locator('#rollback').click();await page.locator('#saved').check();await page.locator('#confirmAction').click();await page.locator('#status').getByText(/已回退到可用版本/).waitFor();checks.push('Manual rollback uses a separate confirmation and action');
  state={...state,phase:'download_failed',can_rollback:false,error:'Fixture network failure'};await page.reload();await page.locator('#error').getByText('Fixture network failure',{exact:true}).waitFor();assert(await page.locator('#download').isVisible());checks.push('Failure reason is visible and download can retry');
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,'updates-mobile.png'),fullPage:true});checks.push('Update page fits narrow screens and supports reduced motion');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
})().catch(e=>{console.error(e);process.exitCode=1;errors.push(String(e));}).finally(async()=>{await browser?.close();server?.kill();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({checks,errors,external},null,2));fs.writeFileSync(path.join(output,'server.log'),log);console.log(JSON.stringify({checks,errors,external}));});
