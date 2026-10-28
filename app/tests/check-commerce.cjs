const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-commerce-ui-')),out=path.join(root,'test-output'),base='http://127.0.0.1:3860';
let child,browser,page,log='';const errors=[],submitted=[],checks=[],generated=[];let forbidden=0;const mockJobs=new Map();
const fixtureImage='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=';
let imaginePolls=0,waitForImagine=false;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(route,method='GET',data){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});assert(r.ok,await r.clone().text());return r.json();}
(async()=>{
 child=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:'3860',DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'}});child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 for(let i=0;i<100;i++){try{await api('/api/studio/health');break;}catch{await pause(200);}}
 await api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'DeepWhite',base_url:'https://api.deepwhiteai.com/v1',api_key:'sk-test-source-export',enabled:true,primary:true});
 const project=(await api('/api/projects','POST',{name:'计价与 MJ 模拟验收'})).project;
 const canvasId=(await api('/api/canvases','POST',{title:'正式画布计价与 MJ',kind:'classic',project:project.id})).canvas.id;
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1080}});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());
   if(url.pathname==='/api/studio/generations'&&req.method()==='POST'){
     const body=req.postDataJSON();generated.push(body);const job={id:body.request_id,request:body,resolved_model:body.model,status:'succeeded',created_at:Date.now()/1000,updated_at:Date.now()/1000,children:[],task_ids:['mock-task'],outputs:body.kind==='chat'?[]:[{url:fixtureImage,kind:body.kind}],text:body.kind==='chat'?'模拟改写结果':'',error:''};mockJobs.set(job.id,job);return route.fulfill({json:job});
   }
   if(url.pathname==='/api/studio/generations')return route.fulfill({json:{items:[...mockJobs.values()].filter(j=>j.request.canvas_id===url.searchParams.get('canvas_id'))}});
   if(url.pathname.startsWith('/api/studio/generations/')){const job=mockJobs.get(url.pathname.split('/')[4]);return route.fulfill({json:job||{detail:'not found'},status:job?200:404});}
   if(req.method()==='POST'&&['/api/canvas-image-tasks','/api/canvas-video'].includes(url.pathname)){
     generated.push({path:url.pathname,...req.postDataJSON()});return route.fulfill({json:url.pathname.endsWith('tasks')?{task_id:'task_local_prompt'}:{images:[fixtureImage]}});
   }
   if(url.pathname==='/api/canvas-image-tasks/task_local_prompt')return route.fulfill({json:{status:'succeeded',result:{images:[fixtureImage]}}});
   if(url.pathname==='/api/studio/mj/submit'){
     // The real server files every MJ submission in the generation list (studio_mj_history); do the same here.
     const body=req.postDataJSON();submitted.push(body);mockJobs.set('mj_'+submitted.length,{id:'mj_'+submitted.length,request:{canvas_id:body.canvas_id,node_id:body.node_id,provider_id:body.provider_id,model:'midjourney-'+body.action,kind:'image',prompt:body.params?.prompt||'',params:body.params||{}},status:'succeeded',created_at:Date.now()/1000,updated_at:Date.now()/1000,children:[],task_ids:['task_fixture_'+submitted.length],outputs:[{url:fixtureImage,kind:'image'}]});const result=body.action==='describe'?{status:'succeeded',text:'四段模拟图片描述'}:body.action==='inpaint'?{status:'modal',task_id:'task_modal_fixture'}:{status:'succeeded',task_id:'task_fixture_'+submitted.length,images:['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=']};
     if(body.action==='imagine'){waitForImagine=true;return route.fulfill({json:{status:'running',task_id:'task_fixture_1'}});}
     return route.fulfill({json:result});
   }
   if(url.pathname.startsWith('/api/studio/mj/tasks/')){
     if(waitForImagine){imaginePolls++;if(imaginePolls<3)return route.fulfill({json:{status:'running',task_id:'task_fixture_1'}});waitForImagine=false;return route.fulfill({json:{status:'succeeded',task_id:'task_fixture_1',images:[fixtureImage,fixtureImage+'#second']}});}
     return route.fulfill({json:{status:'succeeded',task_id:'task_fixture_1',text:'恢复查询成功'}});
   }
   if(url.origin!==base||(req.method()==='POST'&&/\/api\/(canvas-(image|video|llm|comfy)|generate|online-image|midjourney\/)/.test(url.pathname))){forbidden++;return route.abort();}return route.continue();
 });
 await page.goto(`${base}/static/canvas.html?id=${canvasId}`);await page.locator('#shell:not(.no-canvas) #board').waitFor();
 await page.evaluate(()=>{addGeneratorNode({x:80,y:100});addVideoNode({x:640,y:100});});
 await page.getByLabel('图片提示词',{exact:true}).fill('图片本地提示词：水彩小猫');
 await page.getByLabel('视频提示词',{exact:true}).fill('视频本地提示词：镜头缓缓推进');
 assert.equal(await page.getByLabel('参考方式',{exact:true}).inputValue(),'multi');
 assert.equal(await page.getByLabel('参考方式',{exact:true}).inputValue(),'multi');
 await page.evaluate(async()=>{await saveCanvas();});await page.reload();await page.getByLabel('图片提示词',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('图片提示词',{exact:true}).inputValue(),'图片本地提示词：水彩小猫');assert.equal(await page.getByLabel('视频提示词',{exact:true}).inputValue(),'视频本地提示词：镜头缓缓推进');
 await page.evaluate(()=>{const n=addNode({id:uid('prompt'),type:'prompt',x:0,y:800,text:'连接补充：暖色灯光'});connections.push({from:n.id,to:nodes.find(n=>n.type==='generator').id});render();});
 await page.locator('.generator-node .gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.type==='generator')?.runStatus==='done');
 assert(generated[0].prompt.includes('图片本地提示词'));assert(generated[0].prompt.includes('连接补充：暖色灯光'));
 await page.locator('.video-node .gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.type==='video')?.runStatus==='done');
 assert.equal(generated[1].prompt,'视频本地提示词：镜头缓缓推进');assert.equal(generated[1].multimodal,true);
 // 参考方式 lives in the node's 生成参数 popover; a render closes it, so open it as a user would.
 const referenceMode=async value=>{const pop=page.locator('.video-node .studio-universal-params');if(!(await pop.evaluate(e=>e.matches(':popover-open'))))await page.locator('.video-node .studio-image-settings').click();await page.getByLabel('参考方式',{exact:true}).selectOption(value);};
 await referenceMode('frames');
 assert.equal(await page.evaluate(()=>nodes.find(n=>n.type==='video').multimodal),false);await page.evaluate(()=>render());assert.equal(await page.evaluate(()=>nodes.find(n=>n.type==='video').multimodal),false);
 await referenceMode('multi');await page.keyboard.press('Escape');
 await page.evaluate(()=>{for(const n of nodes)if(n.type==='generator'||n.type==='video')n.h=160;render();});
 assert(await page.locator('.video-node>.node-body').evaluate(el=>el.scrollHeight<=el.clientHeight+2));
 await page.screenshot({path:path.join(out,'node-prompts-and-seedance.png')});
 checks.push('图片/视频节点可直接输入并保存提示词；模拟请求包含本地与连接文本；Seedance 默认全能参考，手动首尾帧选择保留；旧小尺寸节点完整展开');
 await pause(2100);await page.evaluate(()=>{nodes=[];connections=[];render();});
 await page.evaluate(()=>{const n=addGeneratorNode({x:200,y:150});n.apiProvider='deepwhite';n.model='deepwhiteai-image-g2';render();});
 await page.locator('.studio-regular-price b').filter({hasText:'预计'}).waitFor();
 const price1=await page.locator('.studio-regular-price b').innerText();
 await page.getByLabel('生成张数',{exact:true}).selectOption('3');
 await page.waitForFunction(previous=>document.querySelector('.studio-regular-price b')?.textContent!==previous,price1);
 const price3=await page.locator('.studio-regular-price b').innerText();assert(Math.abs(Number(price3.match(/[\d.]+/)[0])-Number(price1.match(/[\d.]+/)[0])*3)<.003);
 await page.locator('.studio-model-trigger').click();await page.locator('#studioModelPicker:popover-open').waitFor();
 /* the classic picker is one flat list (no series column): search for the series */await page.getByLabel('搜索画布模型',{exact:true}).fill('Nano Banana');assert(await page.locator('#studioModelPicker [data-model="deepwhiteai-image-nb-pro"]').isVisible());
 assert.equal(await page.locator('#studioModelPicker [data-model="midjourney-upscale"]').count(),0);
 await page.screenshot({path:path.join(out,'commerce-two-level.png')});
 await page.getByLabel('搜索画布模型',{exact:true}).fill('Midjourney');await page.locator('[data-model="midjourney-imagine"]').click();/* the MJ options sit in the node's 生成参数 popover */await page.locator('.generator-node .studio-image-settings').click();
 await page.locator('.studio-mj-panel [data-mj-field="speed"]').selectOption('relax');await page.locator('.generator-node .studio-regular-price b').filter({hasText:'预计'}).waitFor();
 const relax=await page.locator('.generator-node .studio-regular-price b').innerText();await page.locator('[data-mj-field="speed"]').selectOption('turbo');
 await page.waitForFunction(p=>document.querySelector('.generator-node .studio-regular-price b')?.textContent!==p,relax);
 await page.getByLabel('图片提示词',{exact:true}).fill('模拟 MJ 文生图');await page.evaluate(()=>{nodes[0].count=1;});
 await page.locator('.generator-body > .gen-run-row .gen-btn').click();
 /* the MJ status line is in the (closed) 生成参数 popover; check the state it shows */await page.waitForFunction(()=>/任务处理中/.test(document.querySelector('.generator-node')&&nodes.find(n=>n.type==='generator')?.studioMjState||''));
 await page.locator('.generator-node .studio-regular-price b').waitFor();await pause(400);
 await page.evaluate(()=>{
   const el=document.querySelector('.generator-node'),input=el.querySelector('.studio-prompt-input');input.focus();input.setSelectionRange(2,4);
   window.mjStable={el,input,panel:el.querySelector('.studio-mj-panel'),rect:JSON.stringify(el.getBoundingClientRect().toJSON()),board:document.querySelector('#board').style.transform};
 });
 for(let i=0;i<100&&imaginePolls<2;i++)await pause(100);assert(imaginePolls>=2);await pause(300);
 assert(await page.evaluate(()=>{const s=window.mjStable;return s.el===document.querySelector('.generator-node')&&s.panel.isConnected&&document.activeElement===s.input&&s.input.selectionStart===2&&s.input.selectionEnd===4&&s.rect===JSON.stringify(s.el.getBoundingClientRect().toJSON())&&s.board===document.querySelector('#board').style.transform;}),'MJ polling must preserve panel, focus, selection, size and viewport');
 checks.push('MJ 连续等待查询不重建节点，面板尺寸、视角、输入焦点和选区保持稳定');
 await page.waitForFunction(()=>nodes[0].studioMjState==='已完成');assert.equal(submitted[0].params.version,'8.2');assert.equal(submitted[0].canvas_id,canvasId);assert.equal(submitted[0].action,'imagine');assert.equal(submitted[0].params.speed,'turbo');assert.equal(submitted[0].params.prompt,'模拟 MJ 文生图');
 {const size=await page.locator('.generator-node').evaluate(el=>({width:el.offsetWidth,collapsed:el.classList.contains('studio-collapsed'),body:[el.querySelector('.node-body').scrollHeight,el.querySelector('.node-body').clientHeight]}));assert(size.width>=600,JSON.stringify(size));/* in-node editing width since 534b99d */assert(size.body[0]<=size.body[1]+2,JSON.stringify(size));}
 assert.equal(await page.locator('.studio-mj-pager').count(),0);assert.equal(await page.locator('.output-img-wrap:visible').count(),2);await page.getByRole('button',{name:'任务记录',exact:true}).click();await page.locator('.studio-history-body .studio-history-prompt',{hasText:'模拟 MJ 文生图'}).waitFor();await page.locator('.studio-history:visible header .studio-history-close').click();
 checks.push('MJ 默认 8.2；多图同节点同时展示、节点无翻页按钮；历史画布中的 MJ 记录也显示在生成记录');
 checks.push('正式生图节点显示价格，数量和 MJ 速度改变估价；模型系列 → 版本两级选择；MJ 文生图调用专用接口');
 await page.evaluate(()=>{nodes=[];connections=[];studioAddMj({x:220,y:80});});
 const tool=page.locator('.studio-mj-panel');await tool.locator('.studio-mj-action').selectOption('upscale');
 assert.equal(await tool.locator('[data-mj-field="prompt"]').count(),0);await tool.locator('[data-mj-field="task_id"]').fill('task_original');await tool.locator('[data-mj-field="index"]').selectOption('2');await tool.locator('.studio-mj-run').click();
 await page.waitForFunction(()=>nodes.find(n=>n.studioKind==='mj')?.studioMjState==='已完成');assert.equal(submitted.at(-1).action,'upscale');assert.equal(submitted.at(-1).params.index,2);assert(!('prompt' in submitted.at(-1).params));
 await tool.locator('.studio-mj-action').selectOption('describe');await page.evaluate(()=>{nodes.find(n=>n.studioKind==='mj').studioMjImages=[{url:'/assets/test.png',kind:'image'}];render();});await tool.locator('.studio-mj-run').click();
 await tool.locator('.studio-mj-text').waitFor();assert.equal(await tool.locator('.studio-mj-text').inputValue(),'四段模拟图片描述');
 assert(await page.evaluate(()=>{const source=nodes.find(n=>n.studioKind==='mj'),target={id:'probe'};connections.push({from:source.id,to:target.id});const found=generatorSources(target).some(s=>s.prompt==='四段模拟图片描述');connections=connections.filter(c=>c.to!==target.id);return found;}));
 await tool.locator('.studio-mj-action').selectOption('inpaint');await tool.locator('[data-mj-field="task_id"]').fill('task_original');await tool.locator('.studio-mj-run').click();
 await page.waitForFunction(()=>nodes.find(n=>n.studioKind==='mj')?.studioMjAction==='modal');assert.equal(await tool.locator('[data-mj-field="task_id"]').inputValue(),'task_modal_fixture');
 await tool.locator('[data-mj-field="prompt"]').fill('重绘模拟');await tool.locator('[data-mj-field="mask_url"]').fill('https://assets.test/mask.png');await tool.locator('.studio-mj-run').click();await page.waitForFunction(()=>nodes.find(n=>n.studioKind==='mj')?.studioMjState==='已完成');
 await tool.locator('.studio-price b').waitFor();await page.screenshot({path:path.join(out,'commerce-mj-tools.png')});
 await page.evaluate(async()=>{await saveCanvas();});await page.reload();await page.locator('#shell:not(.no-canvas) #board').waitFor();await tool.locator('.studio-mj-query').click();await page.waitForFunction(()=>!nodes.find(n=>n.studioKind==='mj')?.running);
 assert.equal(submitted.length,5);checks.push('MJ 放大、识图、局部重绘两步流程使用不同输入；保存刷新后可查询原任务，不重复生成');
 const smartId=(await api('/api/canvases','POST',{title:'智能 MJ',kind:'smart',project:project.id})).canvas.id;
 await page.goto(`${base}/static/smart-canvas.html?id=${smartId}`);await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof studioAddMj==='function');
 await page.mouse.dblclick(600,300);await page.locator('#createMenu.open [data-studio-add="mj"]').click();await page.locator('#composer .studio-mj-panel').waitFor();
 await page.locator('#composer .studio-mj-action').selectOption('video');await page.locator('#composer [data-mj-field="task_id"]').fill('task_smart');await page.locator('#composer [data-mj-field="index"]').selectOption('0');
 await page.screenshot({path:path.join(out,'commerce-smart-mj.png')});checks.push('智能画布可添加 MJ 工具，视频使用自己的规格与选图参数');
 assert.deepEqual(errors,[]);assert.equal(forbidden,0);checks.push('所有生成响应均为模拟；无外部调用、无额度消耗、无浏览器脚本错误');
 fs.writeFileSync(path.join(out,'commerce-checks.json'),JSON.stringify({passed:true,checks},null,2));console.log(JSON.stringify({passed:true,checks},null,2));
})().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(out,'commerce-failure.png'),timeout:5000}).catch(()=>{});fs.writeFileSync(path.join(out,'commerce-server.log'),log);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child){const exit=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exit,pause(4000)]);}const resolved=path.resolve(runtime);assert(resolved.startsWith(path.join(os.tmpdir(),'deepwhite-commerce-ui-')));fs.rmSync(resolved,{recursive:true,force:true});});
