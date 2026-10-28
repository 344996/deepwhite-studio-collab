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
 // Magnetic handle follows nearby pointer and returns when leaving.
 const source=p.locator('[data-id="snap-source"]'),port=source.locator('.port.out');
 await source.hover();const box=await port.boundingBox();
 await p.mouse.move(box.x+box.width/2+8,box.y+box.height/2+6);
 assert(Math.abs(parseFloat(await port.evaluate(e=>e.style.getPropertyValue('--port-x'))))>1);
 await p.mouse.move(20,20);assert.equal(await port.evaluate(e=>e.style.getPropertyValue('--port-x')),'0px');
 const input=p.locator('[data-id="snap-target"] .studio-input-icon');assert.equal(await input.count(),1);
 await input.click();assert.equal(await p.locator('.studio-input-popover:popover-open').count(),1);
 await p.getByRole('button',{name:'关闭输入素材',exact:true}).click();assert.equal(await p.locator('.studio-input-popover:popover-open').count(),0);
 async function drag(reverse=false){
  const a=await p.locator('[data-id="'+(reverse?'snap-target':'snap-source')+'"] .port.'+(reverse?'in':'out')).boundingBox();
  const b=await p.locator('[data-id="'+(reverse?'snap-source':'snap-target')+'"]').boundingBox();
  await p.mouse.move(a.x+a.width/2,a.y+a.height/2);await p.mouse.down();await p.mouse.move(b.x+b.width/2,b.y+65,{steps:8});
 }
 await drag();assert.equal(await p.locator('.studio-link-target').count(),1);assert.equal(await p.evaluate(()=>connections.length),0);await p.mouse.up();assert.equal(await p.evaluate(()=>connections.length),1);
 await drag();await p.mouse.up();assert.equal(await p.evaluate(()=>connections.length),1);
 await p.evaluate(()=>{connections=[];render();});await drag(true);await p.mouse.up();assert.deepEqual(await p.evaluate(()=>connections.map(c=>[c.from,c.to])),[['snap-source','snap-target']]);
 await p.evaluate(()=>{connections=[];render();});await drag();await p.keyboard.press('Escape');await p.mouse.up();assert.equal(await p.evaluate(()=>connections.length),0);assert.equal(await p.locator('.studio-link-target').count(),0);
 // Dropping on an incompatible card must not create nodes or edges.
 await p.evaluate(()=>addNode({id:'snap-invalid',type:'prompt',x:570,y:650,w:300,h:150,text:'不可接收'}));
 const a=await p.locator('[data-id="snap-source"] .port.out').boundingBox(),b=await p.locator('[data-id="snap-invalid"]').boundingBox();
 await p.mouse.move(a.x+a.width/2,a.y+a.height/2);await p.mouse.down();await p.mouse.move(b.x+b.width/2,b.y+50,{steps:8});assert.equal(await p.locator('.studio-link-invalid').count(),1);await p.mouse.up();assert.equal(await p.evaluate(()=>connections.length),0);assert.equal(await p.evaluate(()=>nodes.length),3);
 await p.evaluate(()=>{addNode({id:'ref-image',type:'image',url:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/%3E',name:'参考图',x:30,y:700});connections.push({from:'ref-image',to:'snap-target'});refreshGeneratorInputViews();});
 assert.equal(await p.locator('[data-id="snap-target"] .studio-reference-strip img').count(),1);
 await p.evaluate(()=>{connections=[];refreshGeneratorInputViews();});assert.equal(await p.locator('[data-id="snap-target"] .studio-reference-strip img').count(),0);
 const targetBox=await p.locator('[data-id="snap-target"]').boundingBox(),outBox=await p.locator('[data-id="snap-target"] .port.out').boundingBox();/* the visible + handle (port centre) sits outside the card */assert(outBox.x+outBox.width/2>targetBox.x+targetBox.width,JSON.stringify({targetBox,outBox}));
 assert.deepEqual(errors,[]);console.log('PASS: full-card snap preview, reverse linking, duplicate protection, Escape and invalid target at 85% zoom');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child)child.kill();});
