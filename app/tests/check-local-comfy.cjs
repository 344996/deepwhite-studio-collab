const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-local-ui-')),base='http://127.0.0.1:3861';
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,browser;const errors=[],submitted=[];let job;
async function api(url,body){const r=await fetch(base+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert(r.ok,await r.clone().text());return r.json();}
(async()=>{
 child=spawn(path.join(root,'python/python.exe'),[path.join(root,'studio_server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:'3861',DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'},stdio:'ignore'});
 for(let i=0;i<100;i++){try{await api('/api/studio/health');break;}catch{await pause(200);}}
 const project=(await api('/api/projects',{name:'本地工作流测试'})).project,c=(await api('/api/canvases',{title:'Qwen',kind:'classic',project:project.id})).canvas;
 browser=await chromium.launch({channel:'msedge',headless:true});const p=await browser.newPage({viewport:{width:1500,height:1100}});p.on('pageerror',e=>errors.push(e.message));
 let engineStarts=0,engineRunning=false,engineOwned=true,refuseStop=false;
 let engineSettings={directory:'D:\\fixture',auto_start:true,start_with_app:false};
 await p.route('**/api/studio/local-engine**',r=>{
  const url=r.request().url();
  if(url.endsWith('/start')){engineStarts++;engineRunning=true;}
  if(url.endsWith('/stop')){if(refuseStop)return r.fulfill({status:409,json:{detail:'ComfyUI 有任务运行或排队，请完成后再关闭。'}});engineRunning=false;return r.fulfill({json:{stopped:true,message:'已关闭'}});}
  if(url.endsWith('/settings'))engineSettings=r.request().postDataJSON();
  return r.fulfill({json:{state:engineRunning?'ready':'stopped',owned:engineRunning&&engineOwned,message:engineRunning?'已连接':'本地引擎未启动',settings:engineSettings}});
 });
 await p.route('**/api/studio/generations**',route=>{
  const r=route.request();if(r.method()==='POST'){const body=r.postDataJSON();submitted.push(body);job={id:body.request_id,request:body,resolved_model:body.model,status:'succeeded',created_at:Date.now()/1000,children:[],task_ids:['mock-local'],outputs:[{url:'/static/studio-mark.svg',kind:'image'}],text:'',error:''};return route.fulfill({json:job});}
  return route.fulfill({json:r.url().endsWith('/'+job?.id)?job:{items:[]}});
 });
 await p.goto(base+'/static/canvas.html?id='+c.id);await p.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&apiProviders.some(x=>x.id==='deepwhite-local-comfy'));
 await p.locator('.studio-engine-toolbar').waitFor();assert.equal(engineStarts,0);
 await pause(300);await p.evaluate(()=>{addGeneratorNode({x:50,y:60});render();});
 await p.locator('.studio-model-trigger').first().click();await p.getByLabel('调用平台',{exact:true}).selectOption('deepwhite-local-comfy');await p.getByRole('option',{name:/Qwen Image 2.1/}).click();
 await p.waitForFunction(()=>!!document.querySelector('[data-studio-param="optimize_prompt"]'));
 await p.waitForFunction(()=>document.querySelector('.studio-engine-message')?.textContent==='已连接');assert.equal(engineStarts,1);
 await p.evaluate(()=>{apiProviders.push({id:'cloud-fixture',name:'测试 API',enabled:true,has_key:true,base_url:'https://api.deepwhiteai.com/v1',image_models:['deepwhiteai-image-g2'],chat_models:[],video_models:[]});render();});
 await p.locator('.studio-model-trigger').first().click();await p.getByLabel('调用平台',{exact:true}).selectOption('cloud-fixture');await p.locator('.studio-picker-option').first().click();assert.equal(await p.evaluate(()=>nodes.find(n=>n.type==='generator').apiProvider),'cloud-fixture');
 await p.locator('.studio-model-trigger').first().click();await p.getByLabel('调用平台',{exact:true}).selectOption('deepwhite-local-comfy');await p.screenshot({path:path.join(root,'test-output/platform-model-picker.png')});await p.getByRole('option',{name:/Qwen Image 2.1/}).click();assert.equal(await p.evaluate(()=>nodes.find(n=>n.type==='generator').apiProvider),'deepwhite-local-comfy');

 await p.getByRole('button',{name:'ComfyUI 设置',exact:true}).click();await p.locator('.studio-engine-dialog[open]').waitFor();assert.equal(await p.getByLabel('整合包根目录').inputValue(),'D:\\fixture');await p.getByRole('button',{name:'关闭 ComfyUI 设置',exact:true}).click();
 await p.getByRole('button',{name:'图片生成设置',exact:true}).click();
 const settings=p.locator('.studio-image-settings-popup:popover-open');await settings.waitFor();
 await settings.getByRole('button',{name:'4:3',exact:true}).click();await settings.getByLabel('采样步数',{exact:true}).selectOption('1');
 await settings.getByRole('button',{name:'关闭图片设置',exact:true}).click();assert((await p.getByRole('button',{name:'图片生成设置',exact:true}).innerText()).includes('4:3 / 30 步'));
 assert.equal(await p.locator('.model-select').first().inputValue(),'local-qwen-image-21-edit');
 assert(await p.locator('.studio-model-trigger').first().innerText().then(x=>x.includes('Qwen')));
 await p.locator('.studio-model-trigger').first().click();await p.getByRole('option',{name:/Qwen Image 2.1/}).click();
 await p.locator('.studio-prompt-input').fill('把外套改成蓝色');
 await p.evaluate(()=>{const n=nodes.find(n=>n.type==='generator');n.studioRefs=[{url:'/assets/local-test.png',kind:'image'}];render();});
 await p.locator('.gen-btn').first().click();await p.waitForFunction(()=>nodes.some(n=>n.studioJobState==='succeeded'));
 assert.equal(submitted.length,1);assert.equal(submitted[0].provider_id,'deepwhite-local-comfy');assert.equal(submitted[0].references.length,1);assert.equal(submitted[0].params.optimize_prompt,false);assert.equal(submitted[0].params.ratio,'4:3');assert.equal(submitted[0].params.steps,30);
 await p.evaluate(()=>saveCanvas());await p.reload();await p.waitForFunction(()=>typeof nodes!=='undefined'&&nodes.some(n=>n.apiProvider==='deepwhite-local-comfy'));
 assert.equal(await p.locator('.model-select').first().inputValue(),'local-qwen-image-21-edit');assert.deepEqual(errors,[]);
 const toolbar=p.locator('.studio-engine-toolbar');
 await toolbar.getByRole('button',{name:'关闭',exact:true}).waitFor();
 refuseStop=true;await toolbar.getByRole('button',{name:'关闭',exact:true}).click();await p.waitForFunction(()=>document.querySelector('.studio-engine-notice').textContent.includes('任务'));assert(engineRunning);
 refuseStop=false;await toolbar.getByRole('button',{name:'关闭',exact:true}).click();await p.waitForFunction(()=>document.querySelector('.studio-engine-summary').textContent.includes('未开启'));assert.equal(engineSettings.auto_start,false);assert.equal(engineSettings.start_with_app,false);
 await p.reload();await pause(3500);assert.equal(engineStarts,1);assert(!engineRunning);
 await toolbar.getByRole('button',{name:'开启',exact:true}).click();await p.waitForFunction(()=>document.querySelector('.studio-engine-summary').textContent.includes('运行中'));assert.equal(engineStarts,2);
 engineOwned=false;await pause(3500);assert(await toolbar.getByRole('button',{name:'关闭',exact:true}).isDisabled());assert((await toolbar.innerText()).includes('外部启动'));
 await p.evaluate(()=>{
 apiProviders.push({id:'layout-fixture',name:'布局测试',enabled:true,has_key:true,base_url:'https://example.test/v1',image_models:['deepwhiteai-image-gk-v2'],video_models:['seedance-2.0-fast'],chat_models:[]});
 const image=addGeneratorNode({x:50,y:650});image.id='layout-image';image.apiProvider='layout-fixture';image.model='deepwhiteai-image-gk-v2';
 const video=addVideoNode({x:750,y:650});video.id='layout-video';video.apiProvider='layout-fixture';video.model='seedance-2.0-fast';render();});
 for(const id of ['layout-image','layout-video']){const node=p.locator('[data-id="'+id+'"]');assert.equal(await node.locator('.studio-image-footer').count(),1);await node.getByRole('button',{name:'生成参数设置',exact:true}).click();assert(await node.locator('.studio-universal-params').isVisible());await node.getByRole('button',{name:'关闭生成设置',exact:true}).click();}
 await p.locator('.studio-image-footer .studio-regular-price').first().waitFor();
 const positions=await p.locator('.studio-image-footer').first().evaluate(el=>{const sels=['.studio-footer-model','.studio-image-settings','.studio-regular-price','.gen-btn'];return sels.map(s=>{const r=el.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y+r.height/2};});});await p.screenshot({path:path.join(root,'test-output/local-qwen-node.png')});assert(positions.every((r,i)=>i===0||r.x>positions[i-1].x));assert(Math.max(...positions.map(r=>r.y))-Math.min(...positions.map(r=>r.y))<5);
 await p.screenshot({path:path.join(root,'test-output/local-qwen-node.png')});console.log('PASS: local provider, two-level picker, parameters, submission, result and reload; no GPU calls');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child)child.kill();});
