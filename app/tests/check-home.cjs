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
 await p.goto(base+'/?project='+project.id);await p.waitForSelector('.ws-card');
 await p.getByLabel('搜索画布',{exact:true}).fill('Qwen');assert.equal(await p.locator('.ws-card:visible').count(),1);
 const card=p.locator('.ws-card').first();assert(await card.locator('.ws-card-title').isVisible());
 await card.locator('.ws-card-menu').click();console.log(await p.locator('.ws-card-pop').innerText());
 await p.locator('[data-act=rename]').click();await p.locator('.ws-card-title-input').fill('Qwen 改名');await p.locator('.ws-card-title-input').press('Enter');await p.waitForFunction(()=>document.querySelector('.ws-card-title')?.textContent==='Qwen 改名');
 await p.locator('#studioSettingsButton').click();assert(await p.locator('#studioSettingsDialog').isVisible());await p.evaluate(()=>document.getElementById('studioSettingsDialog').close());
 /* the in-app Skill library lost its entry before 79b939e; U11 keeps Skills off the page */assert.equal(await p.getByRole('button',{name:'Skill 库',exact:true}).count(),0);/* home v2: the account entry opens the same login form */await p.locator('#studioAccountButton').click();assert(await p.getByPlaceholder('API 网站用户名或邮箱').isVisible());assert(!(await p.getByPlaceholder('两步验证码').isVisible()));await p.locator('dialog[open]').getByRole('button',{name:'关闭',exact:true}).click();await p.getByLabel('搜索画布',{exact:true}).fill('');await p.locator('#newCanvasBtn').click();await p.locator('.ws-create-input').fill('新建验收');await p.locator('.ws-create-confirm').click();await p.locator('.ws-card-title').filter({hasText:'新建验收'}).click();await p.waitForURL('**/static/canvas.html**');/* the new canvas opens with no library dialog left over; the in-app skill picker on text nodes went with the Skill library */await p.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&document.querySelector('.dw-library')===null);await pause(300);await p.evaluate(()=>{addLLMNode({x:200,y:100});render();});assert.equal(await p.getByLabel('使用技能').count(),0);
 await p.goto(base+'/?project='+project.id);await p.waitForSelector('.ws-card');await p.locator('#trashEntry').click();assert(await p.locator('#trashPanel').isVisible());await p.locator('#trashClose').click();assert.deepEqual(errors,[]);console.log('PASS homepage search, create/open canvas, card menu, settings and trash');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child)child.kill();});
