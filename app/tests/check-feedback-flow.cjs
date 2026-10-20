'use strict';
// Real localhost canvas and gallery; gallery identity upstream is an offline fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),galleryRoot=path.resolve(process.env.GALLERY_SOURCE||path.join(root,'../../gallery'));
const output=path.resolve(process.env.FEEDBACK_EVIDENCE_DIR||path.join(root,'test-output/feedback-flow'));
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-feedback-flow-')),processes=[],logs=[],results=[],errors=[];
let browser,canvasURL,galleryURL;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(resolve=>{const server=net.createServer().listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
async function api(base,url,method='GET',body){const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(response.ok,await response.clone().text());return response.json();}
async function start(cwd,args,env){
  const child=spawn(process.env.PYTHON_EXECUTABLE||'python',['-B',...args],{cwd,windowsHide:true,env:{...process.env,...env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
  processes.push(child);child.stdout.on('data',d=>logs.push(String(d)));child.stderr.on('data',d=>logs.push(String(d)));
  return child;
}
async function ready(base,url){for(let i=0;i<120;i++){try{await api(base,url);return;}catch{}await wait(150);}throw Error('Server did not start:\n'+logs.join(''));}
async function check(name,fn){await fn();results.push({name,passed:true});console.log('PASS '+name);}
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const c=await freePort(),g=await freePort();canvasURL='http://127.0.0.1:'+c;galleryURL='http://127.0.0.1:'+g;
  await start(root,['studio_server.py'],{DEEPWHITE_STUDIO_RUNTIME_DIR:path.join(runtime,'canvas'),DEEPWHITE_STUDIO_PORT:String(c)});
  await start(galleryRoot,['-m','tests.browser_server'],{GALLERY_TEST_DATA:path.join(runtime,'gallery'),GALLERY_PUBLIC_URL:galleryURL,GALLERY_CANVAS_URL:canvasURL});
  await Promise.all([ready(canvasURL,'/api/studio/health'),ready(galleryURL,'/api/gallery/health')]);
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',route=>[canvasURL,galleryURL].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(canvasURL+'/settings');
  await page.getByRole('tab',{name:'意见反馈',exact:true}).click();
  const frame=page.frameLocator('iframe[src^="/static/studio-feedback.html"]');
  await check('Settings feedback iframe preserves an offline draft and reports unsent status',async()=>{
    await frame.locator('[name=title]').fill('交互测试反馈');
    await frame.locator('[name=description]').fill('拖动节点后应保留位置，这是一条隔离测试反馈。');
    await frame.getByRole('button',{name:'仅保存到本机',exact:true}).click();
    await frame.locator('.feedback-record').filter({hasText:'本机待发送'}).waitFor();
    const rows=await api(canvasURL,'/api/studio/feedback');assert.equal(rows.items.length,1);assert.equal(rows.items[0].sent,false);
  });
  let feedbackId;
  await check('Explicit send delivers one feedback record; retries do not duplicate it',async()=>{
    await api(canvasURL,'/api/studio/gallery','PUT',{url:galleryURL});
    await frame.locator('.feedback-record button').click();
    await frame.locator('.feedback-record .badge').filter({hasText:'已收到'}).waitFor();
    const rows=await api(canvasURL,'/api/studio/feedback');feedbackId=rows.items[0].id;
    await api(canvasURL,'/api/studio/feedback/'+feedbackId+'/send','POST');
    assert.equal((await api(canvasURL,'/api/studio/feedback')).items.length,1);
  });
  const admin=await context.newPage();admin.on('pageerror',error=>errors.push(error.message));
  await check('Gallery moderator can find feedback, reply, and view handling history',async()=>{
    await admin.goto(galleryURL+'/');await admin.locator('#loginButton').click();
    await admin.locator('#loginForm [name=username]').fill('moderator');await admin.locator('#loginForm [name=password]').fill('fixture');
    await admin.locator('#loginForm button[type=submit]').click();await admin.locator('#feedbackInboxLink').waitFor({state:'visible'});
    await admin.locator('#feedbackInboxLink').click();await admin.locator('.feedback-card').waitFor();
    assert.equal(await admin.locator('.feedback-card').count(),1);
    await admin.getByRole('button',{name:'查看与处理'}).click();await admin.locator('#handle [name=status]').selectOption('done');
    await admin.locator('#handle [name=reply]').fill('已验证节点保存流程，新版本可以测试。');
    await admin.getByRole('button',{name:'保存处理结果'}).click();await admin.locator('#detail').waitFor({state:'hidden'});
    await admin.getByRole('button',{name:'查看与处理'}).click();await admin.getByRole('button',{name:'查看处理记录'}).click();
    await admin.locator('#history').filter({hasText:'已解决'}).waitFor();await admin.screenshot({path:path.join(output,'gallery-feedback-admin.png'),fullPage:true});
  });
  await check('Canvas reads the moderator reply and retains it after page reload',async()=>{
    await frame.getByRole('button',{name:'查询处理结果'}).click();
    await frame.locator('blockquote').filter({hasText:'已验证节点保存流程'}).waitFor();
    await page.reload();await page.getByRole('tab',{name:'意见反馈',exact:true}).click();
    await frame.locator('.feedback-record .badge').filter({hasText:'已解决'}).waitFor();
    assert.equal((await api(canvasURL,'/api/studio/feedback')).items[0].remote.status,'done');
    await page.screenshot({path:path.join(output,'canvas-feedback.png'),fullPage:true});
  });
  await check('Feedback form fits a narrow viewport without horizontal overflow',async()=>{
    await page.setViewportSize({width:390,height:850});await page.goto(canvasURL+'/static/studio-feedback.html');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
    await page.screenshot({path:path.join(output,'feedback-mobile.png'),fullPage:true});
  });
  assert.deepEqual(errors,[]);
})().catch(error=>{console.error(error);results.push({name:'failure',passed:false,error:String(error)});process.exitCode=1;})
.finally(async()=>{if(browser)await browser.close();for(const child of processes)child.kill();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({results,errors,paid_generation:false,runtime},null,2));fs.writeFileSync(path.join(output,'servers.log'),logs.join(''));});
