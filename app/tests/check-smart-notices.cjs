'use strict';
// Existing Smart notices on an isolated fixture service. All generation is mocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path');
const app=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-smart-notices-runtime-')),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dw-smart-notices-evidence-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 let server,browser,page,log='';const groups=[],errors=[],external=[],forbidden=[],requests=[],measurements=[],reads=[],ledger=new Map();
 const pass=name=>{groups.push(name);console.log('PASS '+name);};
 try{
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const base=`http://127.0.0.1:${port}`;
  const api=async(p,method='GET',body)=>{const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json();};
  server=spawn(path.join(app,'python/python.exe'),[path.join(app,'tests/catalog-browser-server.py')],{cwd:app,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
  let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await delay(150);}}assert(ready,log);
  await api('/api/studio/settings/sync-models','POST',{id:'offline-notices',name:'离线提示验收',base_url:'https://offline.invalid/v1',api_key:'offline-fixture-not-a-key',enabled:true,primary:true});
  const project=(await api('/api/projects','POST',{name:'Smart提示隔离验收'})).project;
  const canvas=(await api('/api/canvases','POST',{title:'提示层验收',kind:'smart',project:project.id})).canvas;
  await api(`/api/canvases/${canvas.id}`,'PUT',{base_updated_at:canvas.updated_at,nodes:[{id:'notice-script',type:'smart-prompt',x:250,y:150,w:600,h:400,text:'用户手写保持原样。',llmEnabled:true,llmProvider:'offline-notices',llmModel:'gpt-4o-mini',llmInstruction:'扩写文字',llmSystemEnabled:false}],connections:[],viewport:{x:10,y:70,scale:1}});
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||'data/local-path'});
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());if(u.origin!==base){external.push(req.url());return route.abort();}
   if(u.pathname==='/api/canvas-native-tasks/capabilities')return route.fulfill({json:{version:1,kinds:['llm','video'],get_dispatches:false,video_resume:['query_upstream','archive_result']}});
   if(req.method()==='POST'&&u.pathname==='/api/canvas-llm-tasks'){
    const body=req.postDataJSON();requests.push(body);assert(body.request_id&&body.canvas_id&&body.node_id&&body.output_node_id&&body.output_slot_id);
    const record={task_id:'notice-task-'+requests.length,request_id:body.request_id,canvas_id:body.canvas_id,node_id:body.node_id,output_node_id:body.output_node_id,output_slot_id:body.output_slot_id,status:'failed',error:'离线模拟：供应商连接失败，请核实原文字任务，当前反馈不表示重新生成。',result:null,processing:false,retryable:false,queryable:false,recovery_status:'verification_required',recovery_action:null,remote_status:'failed',media_status:'not_applicable'};
    ledger.set(body.request_id,record);ledger.set(record.task_id,record);
    // A lost POST receipt must be recovered through the original UUID, never resubmitted.
    return route.fulfill({status:503,json:{detail:'Mock lost receipt'}});
   }
   if(req.method()==='GET'&&u.pathname.startsWith('/api/canvas-llm-tasks/')){const key=decodeURIComponent(u.pathname.slice('/api/canvas-llm-tasks/'.length).replace(/^by-request\//,''));reads.push({key,byRequest:u.pathname.includes('/by-request/')});const record=ledger.get(key);return route.fulfill({status:record?200:404,json:record||{detail:'Mock original request not found'}});}
   if(req.method()==='POST'&&/\/api\/(?:canvas-(?:image|video|audio|llm|comfy)|online-image|studio\/(?:generations|mj|runninghub)|midjourney|runninghub|jimeng|ms\/generate|angle\/generate)/.test(u.pathname)){forbidden.push(u.pathname);return route.fulfill({status:503,json:{detail:'Notice tests prohibit real generation'}});}return route.continue();
  });
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR: '+e.message);});page.on('dialog',d=>d.dismiss());
  await page.goto(base+`/static/smart-canvas.html?id=${canvas.id}&project=${project.id}`);await page.waitForFunction(()=>window.StudioSmartV2&&nodes.length===1);await delay(300);
  const notice=page.locator('#toast');
  fs.writeFileSync(path.join(artifacts,'input-computed.json'),JSON.stringify(await page.locator('.prompt-node-llm select,.prompt-node-llm textarea').evaluateAll(elements=>elements.map(e=>{const s=getComputedStyle(e);return {className:e.className,disabled:e.disabled,color:s.color,background:s.backgroundColor,opacity:s.opacity,font:s.fontSize,parentBackground:getComputedStyle(e.closest('.image-node')).backgroundColor};})),null,2));
  const measure=()=>page.evaluate(()=>{const n=document.getElementById('toast'),s=getComputedStyle(n),r=n.getBoundingClientRect(),h=document.querySelector('.sv2-header').getBoundingClientRect(),under=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,headerBottom:h.bottom,opacity:+s.opacity,z:+s.zIndex,font:+parseFloat(s.fontSize),background:s.backgroundColor,color:s.color,wrap:s.overflowWrap,pointerEvents:s.pointerEvents,transition:s.transitionDuration,role:n.getAttribute('role'),live:n.getAttribute('aria-live'),atomic:n.getAttribute('aria-atomic'),label:n.dataset.noticeLabel,hitNotice:!!under?.closest('#toast'),viewport:{w:innerWidth,h:innerHeight}};});
  const check=async()=>{const m=await measure();assert(m.top>=m.headerBottom+12);assert(m.left>=24&&m.right<=m.viewport.w-24);assert(m.bottom<m.viewport.h-24);assert(m.width<=480.1);assert.equal(m.opacity,1);assert.equal(m.pointerEvents,'none');assert.equal(m.hitNotice,false);assert(m.z>64&&m.z<85,'above header, below native/V2 modal and picker layers');assert.equal(m.role,'status');assert.equal(m.live,'polite');assert.equal(m.atomic,'true');assert(m.label.length>0,'textual notice label, independent of color');assert.equal(m.wrap,'anywhere');assert(m.font>=13);measurements.push(m);return m;};
  const contrast=(a,b)=>{const lum=s=>{const c=s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return c[0]*.2126+c[1]*.7152+c[2]*.0722;};const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  const inputChecks=[];
  async function checkInput(){const fields=await page.locator('.prompt-node-llm select,.prompt-node-llm textarea').evaluateAll(els=>els.map(e=>{const s=getComputedStyle(e);return {className:e.className,disabled:e.disabled,color:s.color,background:s.backgroundColor,font:parseFloat(s.fontSize),opacity:s.opacity};}));assert(fields.length>=3);for(const f of fields){assert(!f.disabled);assert.equal(f.opacity,'1');assert(f.background.startsWith('rgb('),'opaque shared palette field');assert(contrast(f.color,f.background)>=4.5,'readable enabled field '+JSON.stringify(f));assert(f.font>=12);}inputChecks.push(fields);const layout=await page.evaluate(()=>{const input=document.querySelector('.prompt-node-text'),list=document.querySelector('.studio-native-task-list'),r=input.getBoundingClientRect(),l=list.getBoundingClientRect();return {inputWidth:r.width,nodeWidth:input.closest('.image-node').getBoundingClientRect().width,intersect:Math.max(0,Math.min(r.right,l.right)-Math.max(r.left,l.left))*Math.max(0,Math.min(r.bottom,l.bottom)-Math.max(r.top,l.top))};});assert.equal(layout.intersect,0,'receipts do not overlap handwritten text');assert(layout.inputWidth>layout.nodeWidth*.85,'receipt does not horizontally squeeze text');}
  for(const size of [{width:1280,height:800},{width:1500,height:900}]){
   await page.setViewportSize(size);await delay(200);
   for(const theme of ['graphite','milk','light','dark']){
    await page.evaluate(value=>{StudioTheme.set(value==='dark'?'dark':'light');const material=['graphite','milk'].includes(value)?value:null;if(material)localStorage.setItem('deepwhite_canvas_material',material);else localStorage.removeItem('deepwhite_canvas_material');window.dispatchEvent(new StorageEvent('storage',{key:'deepwhite_canvas_material',newValue:material}));},theme);
    await page.locator('.prompt-node-run').click();await page.waitForFunction(()=>document.getElementById('toast').classList.contains('show')&&document.getElementById('toast').textContent.includes('供应商连接失败'));await delay(220);
    await check();await checkInput();await page.screenshot({path:path.join(artifacts,`failure-${theme}-${size.width}.png`)});pass(`real mocked failure is visible ${theme} ${size.width}`);
    const long='长反馈：保留原任务信息与用户输入。'+('unbroken-reference-'.repeat(24));
    await page.evaluate(text=>toast(text),long);await delay(220);const m=await check();assert(m.height>70,'long unbroken reference wraps');assert.equal(await notice.textContent(),long);pass(`long feedback wraps ${theme} ${size.width}`);
   }
  }
  assert.equal(requests.length,8,'one mocked LLM error for each theme/window, no retries');
  assert.equal(reads.filter(r=>r.byRequest).length,8);assert.equal(new Set(requests.map(r=>r.request_id)).size,8);
  const beforeQuery=requests.length;await page.locator('[data-native-action=query]').first().click();await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('供应商连接失败'));assert.equal(requests.length,beforeQuery);assert(reads.some(r=>!r.byRequest),'explicit original task query is GET only');
  await page.evaluate(()=>{StudioTheme.set('light');localStorage.setItem('deepwhite_canvas_material','graphite');window.dispatchEvent(new StorageEvent('storage',{key:'deepwhite_canvas_material',newValue:'graphite'}));});
  // The native default expanded prompt is 316 x 360, not a tall demo fixture.
  const current=(await api('/api/canvases/'+canvas.id)).canvas;current.nodes[0].w=316;current.nodes[0].h=360;
  await api('/api/canvases/'+canvas.id,'PUT',{...current,base_updated_at:current.updated_at});await page.reload();await page.waitForFunction(()=>window.StudioNativeTasks&&nodes[0]?.w===316&&nodes[0]?.h===360);await delay(250);
  for(const size of [{width:1280,height:800},{width:1500,height:900}]){
   await page.setViewportSize(size);await delay(150);await checkInput();
   const card=page.locator('.prompt-node-card');
   const list=page.locator('.prompt-node-card>.studio-native-task-list');await list.locator('summary').click();await list.evaluate(e=>e.scrollTop=0);const listBox=await list.boundingBox(),viewBefore=await page.evaluate(()=>({...viewport}));await page.mouse.move(listBox.x+12,listBox.y+18);await page.mouse.wheel(0,180);await delay(220);assert((await list.evaluate(e=>e.scrollTop))>0,'real wheel scrolls default-node task history');assert.deepEqual(await page.evaluate(()=>({...viewport})),viewBefore,'task history wheel never zooms/pans canvas');await list.locator('summary').click();
   for(const control of [page.locator('.prompt-node-run'),page.locator('[data-native-action=query]').first()]){await control.scrollIntoViewIfNeeded();assert(await control.evaluate(e=>{const r=e.getBoundingClientRect(),p=e.closest('.prompt-node-card').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}),'default-size task/run action remains actually hittable within node');}
   await page.screenshot({path:path.join(artifacts,'default-smart-query-'+size.width+'.png')});await list.evaluate(e=>e.scrollTop=0);await card.evaluate(e=>e.scrollTop=0);assert((await page.locator('.prompt-node-text').boundingBox()).height>=72);await page.screenshot({path:path.join(artifacts,`default-smart-task-${size.width}.png`)});pass(`default expanded Smart prompt ${size.width}: full-width text and reachable run/query`);
  }
  // Presentation alone must not replace the active input, steal focus or alter selection.
  await page.locator('.prompt-llm-toggle').click();const input=page.locator('.prompt-node-text');await input.fill('用户的新稿保持与提示独立。');await input.focus();
  await input.evaluate(e=>{e.setSelectionRange(2,7);window.noticeInput=e;});const before=await page.evaluate(()=>({text:nodes[0].text,selectedId}));
  await page.evaluate(()=>toast('提示：当前用户新稿不受通知影响。'));await delay(220);await check();assert(await page.evaluate(()=>document.activeElement===window.noticeInput&&document.querySelector('.prompt-node-text')===window.noticeInput&&window.noticeInput.selectionStart===2&&window.noticeInput.selectionEnd===7));assert.deepEqual(await page.evaluate(()=>({text:nodes[0].text,selectedId})),before);pass('notice preserves input object, focus, selection and handwritten text');
  await page.locator('#smartV2Search').click();await page.locator('#smartV2SearchDialog').waitFor({state:'visible'});await page.evaluate(()=>toast('提示：通知不会盖住正在操作的弹窗。'));await delay(220);
  assert(await page.locator('#smartV2SearchInput').evaluate(e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===e;}));await page.locator('#smartV2SearchInput').fill('提示');assert.equal(await page.locator('#smartV2SearchInput').inputValue(),'提示');await page.keyboard.press('Escape');await page.locator('#smartV2SearchDialog').waitFor({state:'hidden'});pass('real modal input remains hittable and Escape closes it');
  await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>toast('提示：减少动效时仍清晰可见。'));await check();assert.equal(await notice.evaluate(e=>parseFloat(getComputedStyle(e).transitionDuration)),0);await page.screenshot({path:path.join(artifacts,'reduced-motion-1500.png')});pass('reduced motion disables notice transition');
  await page.waitForFunction(()=>!document.getElementById('toast').classList.contains('show'));assert.equal(await notice.evaluate(e=>+getComputedStyle(e).opacity),0);pass('native bounded dismissal timer retained');
  // Saved mock receipts exercise real result buttons and dialogs in both engines.
  const videoBytes=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=320;c.height=180;const ctx=c.getContext('2d');ctx.fillStyle='#2a3029';ctx.fillRect(0,0,320,180);const stream=c.captureStream(8),rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];rec.ondataavailable=e=>chunks.push(e.data);const stopped=new Promise(r=>rec.onstop=r);rec.start();await new Promise(r=>setTimeout(r,400));rec.stop();await stopped;stream.getTracks().forEach(t=>t.stop());return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];});
  fs.writeFileSync(path.join(runtime,'output/notice-fixture.webm'),Buffer.from(videoBytes));
  const videoUrl='/output/notice-fixture.webm';
  for(const kind of ['smart','classic'])for(const media of ['llm','video']){
   const c=(await api('/api/canvases','POST',{title:`任务卡视觉 ${kind} ${media}`,kind,project:project.id})).canvas;
   const id='saved-result',requestId=`fixture-${kind}-${media}`,request={request_id:requestId,canvas_id:c.id,node_id:id,output_node_id:id,output_slot_id:requestId,provider_id:'offline-notices',model:'fixture'};
   const attempt={id:requestId,native:true,kind:media,canvasId:c.id,nodeId:id,outputId:id,pendingId:requestId,status:'succeeded',taskId:'saved-'+requestId,createdAt:Date.now(),applied:true,retryable:false,result:media==='llm'?{text:'已保存的模拟文字结果。\n结果仅用于界面验收，不来自模型服务。'}:{videos:[videoUrl]},snapshot:{request,run:{},meta:{mode:kind==='smart'?'smart-text':'node',textBaseline:'用户手写独立保留。'}}};
   const n={id,x:150,y:130,w:520,h:520,studioLegacyAttempts:{[requestId]:attempt},studioHistoryRestored:true};
   if(kind==='smart'&&media==='llm')Object.assign(n,{type:'smart-prompt',text:'用户手写独立保留。',llmEnabled:false});
   if(kind==='smart'&&media==='video')Object.assign(n,{x:60,y:80,type:'smart-image',images:[{url:videoUrl,kind:'video',natural_w:320,natural_h:180}],runSettings:{engine:'api',apiKind:'video',provider_id:'offline-notices',videoModel:'veo3-fast',count:1}});
   if(kind==='classic'&&media==='llm')Object.assign(n,{type:'llm',userInput:'用户手写独立保留。',outputText:'当前节点文字。',mode:'node',llmProvider:'offline-notices',model:'gpt-4o-mini'});
   if(kind==='classic'&&media==='video')Object.assign(n,{type:'video',apiProvider:'offline-notices',model:'veo3-fast',duration:5,aspectRatio:'16:9'});
   await api('/api/canvases/'+c.id,'PUT',{base_updated_at:c.updated_at,nodes:[n],connections:[],viewport:{x:40,y:30,scale:1}});
   await page.goto(base+`/static/${kind==='smart'?'smart-canvas':'canvas'}.html?id=${c.id}&project=${project.id}`);await page.waitForFunction(id=>canvas?.id===id&&window.StudioNativeTasks,c.id);await delay(300);
   if(kind==='smart'&&media==='video'){await page.locator('#smartV2Search').click();await page.locator('.sv2-search-result[data-node-id="saved-result"]').click();await page.evaluate(()=>{viewport={x:0,y:0,scale:1};applyViewport();});await delay(200);}
   for(const size of [{width:1280,height:800},{width:1500,height:900}]){
        await page.setViewportSize(size);await delay(150);
    if(kind==='smart'&&media==='video')assert(await page.locator('.sv2-screen-menu').evaluate(e=>{const r=e.getBoundingClientRect(),n=e.closest('.image-node').getBoundingClientRect(),h=document.querySelector('.sv2-header').getBoundingClientRect();return r.top>=h.bottom+12&&Math.max(0,Math.min(r.right,n.right)-Math.max(r.left,n.left))*Math.max(0,Math.min(r.bottom,n.bottom)-Math.max(r.top,n.top))===0;}),'corner node task actions are not covered by toolbar clamped below header');
    const view=page.locator('[data-native-action=view]').first();
    if(kind==='smart'&&media==='video'){
     const body=page.locator('.image-node[data-id="saved-result"]>.node-body');
     const bodyBox=await body.boundingBox();await page.mouse.move(bodyBox.x+bodyBox.width*.65,bodyBox.y+bodyBox.height*.5);await page.mouse.wheel(0,-600);await delay(100);
     const before=await body.evaluate(e=>({top:e.scrollTop,viewport:{...viewport}}));
     await page.mouse.wheel(0,420);await delay(150);
     const after=await body.evaluate(e=>({top:e.scrollTop,viewport:{...viewport}}));
     console.log('Corner media scroll '+size.width+' '+JSON.stringify({before,after}));
     assert(after.top>before.top,'real wheel scrolls receipt media body');assert.deepEqual(after.viewport,before.viewport,'receipt media scrolling does not zoom or pan canvas');
     const geometry=await view.evaluate(e=>{const rect=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};};const r=e.getBoundingClientRect();return {kind:'corner-video-task',viewport:{width:innerWidth,height:innerHeight},node:rect(e.closest('.image-node')),tasklist:rect(e.closest('.studio-native-task-list')),composer:rect(document.getElementById('composer')),menu:rect(document.querySelector('.sv2-screen-menu')),minimap:rect(document.querySelector('.smart-minimap')),button:rect(e),hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};});
     measurements.push({...geometry,scroll:{before,after}});assert(geometry.hit,'corner video result button is hittable before native scrolling or retry');
     await page.screenshot({path:path.join(artifacts,`corner-smart-task-${size.width}.png`)});
    }
    await view.click();const dialog=page.locator('.studio-native-result-dialog[open]');await dialog.waitFor({state:'visible'});
    const bounds=await dialog.evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight};});assert(bounds.left>=24&&bounds.right<=bounds.w-24&&bounds.top>=24&&bounds.bottom<=bounds.h-24);
    const close=dialog.locator('[data-result-close]');assert(await close.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}),'result close is hittable');
    if(media==='llm'){assert((await dialog.locator('textarea').inputValue()).includes('已保存的模拟文字结果'));assert(await dialog.locator('textarea').evaluate(e=>e.readOnly));}
    else{await dialog.locator('video').evaluate(e=>e.readyState>=1||new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local fixture video metadata timeout')),5000);e.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve();},{once:true});e.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Local fixture video failed'));},{once:true});}));assert(await dialog.locator('video').evaluate(e=>{const r=e.getBoundingClientRect(),d=e.closest('dialog').getBoundingClientRect();return e.controls&&e.videoWidth===320&&r.left>=d.left&&r.right<=d.right&&r.height<=innerHeight*.45+1;}));assert.equal(await dialog.locator('a').getAttribute('href'),videoUrl);await dialog.locator('summary').click();assert((await dialog.locator('textarea').inputValue()).includes(videoUrl));}
    await page.screenshot({path:path.join(artifacts,`result-${kind}-${media}-${size.width}.png`)});await dialog.locator('[data-result-copy]').focus();await page.keyboard.press('Tab');assert(await dialog.evaluate(e=>e.contains(document.activeElement)),'keyboard focus remains in modal');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>nodes[0].studioLegacyAttempts[Object.keys(nodes[0].studioLegacyAttempts)[0]].status),'succeeded');
    pass(`saved ${media} result dialog ${kind} ${size.width}: bounds, media/text, hit and keyboard`);
   }
  }
  assert.equal(requests.length,8,'opening saved results never generates again');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(forbidden,[]);pass('no page errors, external requests or nonmocked generation');
  fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify({passed:true,groups,measurements,inputChecks,mockedRequests:requests.length,reads,errors,external,forbidden},null,2));console.log(`${groups.length} groups passed; screenshots ${artifacts}`);
 }catch(error){if(page)await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(artifacts,'server.log'),log);fs.writeFileSync(path.join(artifacts,'failure-details.json'),JSON.stringify({errors,external,forbidden,groups,measurements},null,2));console.error('Evidence '+artifacts);throw error;}
 finally{await browser?.close();if(server?.exitCode===null)await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('isolated notice server did not exit')),8000);server.once('close',()=>{clearTimeout(timeout);resolve();});server.kill();});const resolved=path.resolve(runtime);assert.equal(path.dirname(resolved).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert(path.basename(resolved).startsWith('dw-smart-notices-runtime-'));assert.notEqual(resolved.toLowerCase(),path.resolve(artifacts).toLowerCase());fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});console.log('CLEANUP isolated browser/server exited; runtime removed');}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
