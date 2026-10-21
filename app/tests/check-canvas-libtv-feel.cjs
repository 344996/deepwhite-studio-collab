/* LibTV-measured canvas feel: real wheel/keyboard input in a browser, temporary data, no generation. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require(process.env.PLAYWRIGHT_MODULE));}
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-libtv-feel-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),checks=[];let child,browser,base;
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});s.on('error',reject);});
async function api(url,method='GET',body){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json();}
async function main(){
  const port=await freePort();base=`http://127.0.0.1:${port}`;
  child=spawn(process.env.PYTHON_EXECUTABLE||path.join(root,'python/python.exe'),['-B',path.join(root,'studio_server.py')],
    {cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:String(port),DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'}});
  for(let i=0;i<100;i++){try{await api('/api/studio/health');break;}catch{await delay(200);}}
  const created=await api('/api/canvases','POST',{title:'LibTV feel',kind:'classic'}),id=(created.canvas||created).id;
  const launch=process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE,headless:true}:{channel:'msedge',headless:true};
  browser=await chromium.launch(launch);const page=await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/static/canvas.html?id=${id}`);await page.waitForFunction(id=>typeof canvas!=='undefined'&&canvas?.id===id&&document.getElementById('studioV2Wheel'),id);
  // A node hides the centred empty-state card, which deliberately swallows wheel input.
  await page.evaluate(()=>{nodes.push({id:'feel-seed',type:'prompt',x:60,y:60,w:320,text:'seed'});render();viewport.x=0;viewport.y=0;viewport.scale=1;applyViewport();});
  await page.waitForFunction(()=>!document.querySelector('.v2-board-empty')||getComputedStyle(document.querySelector('.v2-board-empty')).display==='none'||document.querySelector('.v2-board-empty').hidden);
  const view=()=>page.evaluate(()=>({x:viewport.x,y:viewport.y,s:viewport.scale}));
  const board=await page.locator('.board').boundingBox(),cx=board.x+board.width*.7,cy=board.y+board.height*.55;
  await page.mouse.move(cx,cy);
  // Default LibTV mode: wheel / two-finger scroll pans, scale unchanged.
  let before=await view();await page.mouse.wheel(0,120);await delay(80);let after=await view();
  assert.equal(after.s,before.s,'plain wheel keeps zoom');assert(Math.abs((before.y-after.y)-120)<1,'plain wheel pans vertically');
  before=after;await page.mouse.wheel(90,0);await delay(80);after=await view();assert(Math.abs((before.x-after.x)-90)<1,'horizontal wheel pans horizontally');
  checks.push('wheel and horizontal scroll pan without zooming');
  // Ctrl + wheel zooms around the pointer, clamped to LibTV's 0.1–8.
  const anchor=await page.evaluate(p=>screenToWorld(p.x,p.y),{x:cx,y:cy});
  await page.keyboard.down('Control');await page.mouse.wheel(0,-120);await page.keyboard.up('Control');await delay(80);
  after=await view();assert(after.s>before.s,'Ctrl+wheel zooms in');
  const kept=await page.evaluate(p=>screenToWorld(p.x,p.y),{x:cx,y:cy});assert(Math.abs(kept.x-anchor.x)<.5&&Math.abs(kept.y-anchor.y)<.5,'zoom stays anchored to the pointer');
  await page.keyboard.down('Control');for(let i=0;i<60;i++)await page.mouse.wheel(0,-240);await page.keyboard.up('Control');await delay(80);
  assert(Math.abs((await view()).s-8)<1e-6,'zoom stops at 800%');
  await page.keyboard.down('Control');for(let i=0;i<80;i++)await page.mouse.wheel(0,300);await page.keyboard.up('Control');await delay(80);
  assert(Math.abs((await view()).s-.1)<1e-6,'zoom stops at 10%');
  checks.push('Ctrl+wheel zoom is pointer-anchored and clamped to 10%–800%');
  // Keyboard: browser page zoom is intercepted; Ctrl+= / Ctrl+- / Ctrl+0 drive the canvas.
  await page.evaluate(()=>{viewport.scale=1;applyViewport();});await page.locator('.board').click({position:{x:40,y:board.height-140}});
  await page.keyboard.press('Control+Equal');await delay(400);assert(Math.abs((await view()).s-1.2)<.01,'Ctrl+= zooms in 1.2×');
  await page.keyboard.press('Control+Minus');await delay(400);assert(Math.abs((await view()).s-1)<.01,'Ctrl+- zooms out');
  await page.evaluate(()=>{nodes.push({id:'feel-a',type:'prompt',x:2000,y:1500,w:320,text:'a'});render();viewport.x=0;viewport.y=0;applyViewport();});
  await page.keyboard.press('Control+Digit0');await delay(400);const fitted=await view();assert(fitted.x!==0||fitted.y!==0,'Ctrl+0 fits all nodes');
  checks.push('Ctrl+= / Ctrl+- / Ctrl+0 adjust the canvas instead of the browser');
  // Tab opens the add-node menu only when the canvas has focus.
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Tab');
  assert(await page.evaluate(()=>{const m=document.getElementById('createMenu');return m&&getComputedStyle(m).display!=='none'&&m.getBoundingClientRect().width>0;}),'Tab opens the add-node menu');
  await page.keyboard.press('Escape');checks.push('Tab opens the add-node menu from the canvas');
  // Mouse users can switch the wheel back to zoom; the choice persists.
  await page.locator('#studioV2Wheel').click();before=await view();await page.mouse.move(cx,cy);await page.mouse.wheel(0,-120);await delay(80);
  assert((await view()).s>before.s,'wheel zooms after switching mode');
  assert.equal(await page.evaluate(()=>localStorage.getItem('studio.canvas.wheel')),'zoom');
  await page.reload();await page.waitForFunction(()=>document.getElementById('studioV2Wheel'));
  assert.equal(await page.locator('#studioV2Wheel').getAttribute('aria-pressed'),'true','wheel mode survives reload');
  checks.push('wheel mode toggle zooms, persists and survives reload');
  // Dock: bottom-centred creation tools with ≥44px targets.
  await page.locator('#workspaceCanvasRail').waitFor({state:'visible'});await delay(300);
  const rail=await page.locator('#workspaceCanvasRail').boundingBox();
  assert(Math.abs(rail.x+rail.width/2-640)<4,'dock is horizontally centred');assert(rail.y+rail.height>700&&rail.y+rail.height<=790,'dock sits at the bottom');
  for(const item of await page.locator('#workspaceCanvasRail>button').all()){const box=await item.boundingBox();assert(box.width>=44&&box.height>=44);}
  checks.push('creation dock is bottom-centred with 44px targets');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks},null,2));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();if(child){child.kill();await delay(500);}fs.rmSync(runtime,{recursive:true,force:true});});
