const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-local-ui-')),base='http://127.0.0.1:3861';
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,browser;const errors=[],submitted=[];let job;
async function api(url,body){const r=await fetch(base+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert(r.ok,await r.clone().text());return r.json();}
(async()=>{
 child=spawn(path.join(root,'python/python.exe'),[path.join(root,'studio_server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:'3861',DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'},stdio:'ignore'});
 for(let i=0;i<100;i++){try{await api('/api/studio/health');break;}catch{await pause(200);}}
 const project=(await api('/api/projects',{name:'本地工作流测试'})).project,c=(await api('/api/canvases',{title:'Qwen',kind:'classic',project:project.id})).canvas;
 browser=await chromium.launch({channel:'msedge',headless:true});const p=await browser.newPage({viewport:{width:1500,height:1100}});p.on('pageerror',e=>errors.push(e.message));

 await p.route('**/api/studio/local-engine**',r=>r.fulfill({json:{state:'stopped',owned:false,message:'未开启',settings:{auto_start:false}}}));
 await p.goto(base+'/static/canvas.html?id='+c.id);await p.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id);await pause(400);
 await p.evaluate(()=>{nodes=[];connections=[];viewport={x:0,y:0,scale:0.85};applyViewport();addNode({id:'snap-source',type:'prompt',x:60,y:160,w:300,h:200,text:'参考提示词'});const n=addGeneratorNode({x:570,y:160});n.id='snap-target';render();});

 // The canvas theme select sits in the 更多工具 panel of the workspace layout.
 const more=p.locator('#workspaceMoreTools');await more.waitFor({state:'attached'});if(!(await more.evaluate(d=>d.open)))await more.locator('summary').click();
 const choose=p.getByLabel('画布主题',{exact:true});
 await choose.selectOption('light');const light=await p.locator('#nodes .node').first().evaluate(e=>getComputedStyle(e).backgroundImage);
 await p.evaluate(()=>saveCanvas());await choose.selectOption('milk');assert(await p.locator('html').evaluate(e=>e.classList.contains('studio-milk')));
 await p.reload();await p.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id);assert.equal(await choose.inputValue(),'milk');
 assert(await p.locator('html').evaluate(e=>e.classList.contains('studio-milk')));
 await more.waitFor({state:'attached'});if(!(await more.evaluate(d=>d.open)))await more.locator('summary').click();
 await choose.selectOption('dark');assert(await p.locator('html').evaluate(e=>e.classList.contains('theme-dark')&&!e.classList.contains('studio-milk')));
 await choose.selectOption('light');assert.equal(await p.locator('#nodes .node').first().evaluate(e=>getComputedStyle(e).backgroundImage),light);
 await choose.selectOption('milk');
 await p.evaluate(()=>{const target=nodes.find(n=>n.id==='snap-target');const source=addGeneratorNode({x:20,y:550});connections.push({from:source.id,to:target.id});render();});
 const cascade=p.locator('.studio-image-footer .gen-cascade-btn').first();await cascade.waitFor();const size=await cascade.boundingBox();assert(size.width<50&&size.height<50);assert.equal(await cascade.evaluate(e=>getComputedStyle(e).whiteSpace),'nowrap');
 await p.screenshot({path:path.join(root,'test-output/milk-theme-live.png')});await choose.selectOption('graphite');assert(await p.locator('html').evaluate(e=>e.classList.contains('studio-graphite')&&!e.classList.contains('studio-milk')));
 await p.reload();await p.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id);assert.equal(await choose.inputValue(),'graphite');
 await more.waitFor({state:'attached'});if(!(await more.evaluate(d=>d.open)))await more.locator('summary').click();
 await choose.selectOption('milk');assert(await p.locator('html').evaluate(e=>e.classList.contains('studio-milk')&&!e.classList.contains('studio-graphite')));
 await choose.selectOption('dark');assert(await p.locator('html').evaluate(e=>e.classList.contains('theme-dark')&&!e.classList.contains('studio-graphite')));
 assert.deepEqual(errors,[]);console.log('PASS: four themes, material persistence, light/dark restoration');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child)child.kill();});
