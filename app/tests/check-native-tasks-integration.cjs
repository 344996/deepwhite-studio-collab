'use strict';
// Real canvas + real task routes/ledger, with fail-closed in-process upstream HTTP.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-native-integration-'));
const artifacts=path.join(os.tmpdir(),'deepwhite-native-tasks-integration'),videoFile=path.join(runtime,'fixture.webm');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let browser,server,page,base,port,log='';const errors=[],external=[],forbidden=[],checks=[];
async function api(url,method='GET',body){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json();}
async function startServer(){
  server=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/native-tasks-browser-server.py')],{cwd:root,windowsHide:true,
    env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),NATIVE_FIXTURE_VIDEO:videoFile,PYTHONUTF8:'1'}});
  server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
  for(let i=0;i<140;i++){try{await api('/api/studio/health');return;}catch{}if(server.exitCode!==null)throw Error(log.slice(-5000));await delay(150);}throw Error('Fixture startup timeout: '+log.slice(-2500));
}
async function stopServer(){if(!server||server.exitCode!==null)return;const child=server;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Exact fixture server did not stop')),8000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill();});}
async function until(read,accept,label){for(let i=0;i<160;i++){const value=await read();if(accept(value))return value;await delay(100);}throw Error('Timeout: '+label);}
async function open(c){await page.goto(base+'/static/'+(c.kind==='smart'?'smart-canvas.html':'canvas.html')+'?id='+c.id);await page.waitForFunction(id=>canvas?.id===id&&window.StudioSave&&window.StudioNativeTasks,c.id);await delay(250);}
async function attempts(id){return page.evaluate(id=>Object.values(nodes.find(n=>n.id===id)?.studioLegacyAttempts||{}),id);}
async function newest(id,accept){return until(async()=>(await attempts(id)).at(-1),a=>a&&accept(a),'attempt for '+id);}
async function persisted(c,nodeId,predicate){return until(async()=>(await api('/api/canvases/'+c.id)).canvas.nodes.find(n=>n.id===nodeId),predicate,'saved '+nodeId);}
async function canvasFixture(kind,title,nodes,connections=[]){const c=(await api('/api/canvases','POST',{title,kind})).canvas;await api('/api/canvases/'+c.id,'PUT',{...c,nodes,connections,viewport:{x:30,y:30,scale:.8},base_updated_at:c.updated_at});return c;}
function videoPosts(state){return state.requests.filter(r=>r.method==='POST'&&r.host==='native-fixture.invalid'&&r.path.includes('video'));}
async function makeVideo(){const p=await browser.newPage();try{const bytes=await p.evaluate(async()=>{
  // Headless capture only emits frames for an attached canvas whose pixels change.
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;document.body.append(canvas);const context=canvas.getContext('2d');let frame=0;
  context.fillStyle='#2b4440';context.fillRect(0,0,320,180);const stream=canvas.captureStream(12),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
  recorder.ondataavailable=e=>chunks.push(e.data);const stopped=new Promise(r=>recorder.onstop=r),tick=setInterval(()=>{context.fillStyle=frame++%2?'#2b4440':'#3c5550';context.fillRect(0,0,320,180);},60);
  recorder.start(200);await new Promise(r=>setTimeout(r,1200));recorder.stop();clearInterval(tick);await stopped;stream.getTracks().forEach(t=>t.stop());canvas.remove();return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
});assert(bytes.length>1000,'fixture video recording is empty ('+bytes.length+' bytes)');fs.writeFileSync(videoFile,Buffer.from(bytes));}finally{await p.close();}}
async function queryTaskButton(){
  // Only an actual visible task action is allowed; no direct helper invocation.
  const buttons=page.locator('[data-native-action="resume"]');
  for(let i=0;i<await buttons.count();i++)if(await buttons.nth(i).isVisible()){await buttons.nth(i).click();return;}
  throw Error('No visible original-task recovery action');
}
async function main(){
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));port=socket.address().port;await new Promise(r=>socket.close(r));base='http://127.0.0.1:'+port;
  fs.mkdirSync(artifacts,{recursive:true});
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||'data/local-path'});
    await makeVideo();await startServer();
    const capability=await api('/api/canvas-native-tasks/capabilities');assert.equal(capability.version,1);assert(capability.kinds.includes('llm')&&capability.kinds.includes('video'));
    await api('/api/studio/settings/sync-models','POST',{id:'native-fixture',name:'隔离自有 API',base_url:'https://native-fixture.invalid/v1',api_key:'offline-native-fixture',enabled:true,primary:true});
    const catalog=(await api('/api/studio/model-catalog')).providers['native-fixture'].models,active=m=>m.enabled!==false&&!m.removed&&m.available!==false;
    const chat=catalog.find(m=>m.kind==='chat'&&active(m)&&/gpt-4o/i.test(m.id))||catalog.find(m=>m.kind==='chat'&&active(m));
    const video=catalog.find(m=>m.kind==='video'&&active(m)&&m.id==='deepwhiteai-video-v31-fast'&&(m.variants.t2v||m.variants.auto));assert(chat&&video,'Fixture catalogue must contain real text and t2v aliases');
    const context=await browser.newContext({viewport:{width:1500,height:900},reducedMotion:'reduce'});page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',dialog=>{errors.push('Unexpected dialog: '+dialog.message());dialog.dismiss();});
    await page.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==base){external.push(url.origin);return route.abort();}
      if(!['GET','HEAD','OPTIONS'].includes(req.method())&&!((req.method()==='PUT'&&/^\/api\/canvases\/[^/]+$/.test(url.pathname))||(req.method()==='POST'&&(/^\/api\/canvas-(llm|video)-tasks(?:\/[^/]+\/resume)?$/.test(url.pathname)||/^\/api\/canvases\/[^/]+\/touch$/.test(url.pathname)||['/api/studio/quote','/api/canvas-assets/check'].includes(url.pathname))))){forbidden.push(req.method()+' '+url.pathname);return route.abort();}return route.continue();});

    const classic=await canvasFixture('classic','原生任务集成 · 经典',[{id:'text',type:'llm',x:130,y:100,w:430,llmProvider:'native-fixture',model:chat.id,userInput:'经典原生输入。',outputText:'旧输出保持',mode:'node',legacyMeta:{fixture:'keep'}}]);
    await open(classic);await page.locator('[data-id="text"] .llm-run').click();const first=await newest('text',a=>a.status==='succeeded');
    assert.equal(first.kind,'llm');assert.equal(first.snapshot.request.message,'经典原生输入。');
    await persisted(classic,'text',n=>n.outputText==='离线生成结果：经典原生输入。');await page.reload();await page.waitForFunction(()=>nodes.some(n=>n.id==='text'&&n.outputText==='离线生成结果：经典原生输入。'));
    const state1=await api('/api/fixture/native-state'),chatPosts=state1.requests.filter(r=>r.path.endsWith('/chat/completions'));
    assert.equal(chatPosts.length,1);assert.equal(chatPosts[0].saved_attempt?.id,first.id,'server upstream POST must follow the original saved attempt');
    assert.equal(chatPosts[0].saved_attempt.snapshot.request.message,'经典原生输入。');
    checks.push('classic custom-channel LLM uses actual durable route, saved input precedes upstream POST, result survives refresh with one submit');

    const smart=await canvasFixture('smart','原生任务集成 · 智能',[{id:'script',type:'smart-prompt',x:140,y:120,w:360,h:600,text:'智能原稿。',llmEnabled:true,llmProvider:'native-fixture',llmModel:chat.id,llmInstruction:'将原稿扩写。',legacyMeta:{fixture:'keep'}}]);
    await api('/api/fixture/native-state','POST',{chat_wait:true});await open(smart);await page.locator('[data-id="script"] .prompt-node-run').click();
    await until(()=>api('/api/fixture/native-state'),s=>s.requests.filter(r=>r.path.endsWith('/chat/completions')).length===2,'held smart upstream started');
    await page.locator('[data-id="script"] .prompt-llm-toggle').click();const input=page.locator('[data-id="script"] .prompt-node-text');assert(!await input.evaluate(e=>e.readOnly));await input.fill('生成期间重新手写的新稿。');
    await api('/api/fixture/native-state','POST',{chat_wait:false});const smartAttempt=await newest('script',a=>a.status==='succeeded');assert(smartAttempt.result.text.startsWith('离线生成结果：'));
    assert.equal(await input.inputValue(),'生成期间重新手写的新稿。');assert(await page.getByRole('button',{name:'生成结果',exact:true}).isVisible(),'preserved result must have a user-visible entry');
    await persisted(smart,'script',n=>n.text==='生成期间重新手写的新稿。'&&Object.values(n.studioLegacyAttempts||{}).some(a=>a.id===smartAttempt.id&&a.result?.text));
    await page.reload();await page.waitForFunction(()=>nodes.some(n=>n.id==='script'&&n.text==='生成期间重新手写的新稿。'));
    assert.equal((await api('/api/fixture/native-state')).requests.filter(r=>r.path.endsWith('/chat/completions')).length,2);
    checks.push('Smart actual toggle/edit keeps the new draft and durable old result, both survive refresh without resubmission');

    const clip=await canvasFixture('classic','原生视频 · 重启恢复',[{id:'prompt',type:'prompt',x:80,y:90,w:280,h:180,text:'隔离视频任务。'},{id:'video',type:'video',x:420,y:90,w:440,apiProvider:'native-fixture',model:video.id,duration:5,aspectRatio:'16:9',legacyMeta:{fixture:'keep'}}],[{id:'input',from:'prompt',to:'video'}]);
    await api('/api/fixture/native-state','POST',{pause_queries:true,archive_failures:1});await open(clip);
    await page.locator('[data-id="video"] .gen-btn').first().click();
    const attempt=await newest('video',a=>a.taskId&&a.status==='running');
    await until(()=>api('/api/canvas-video-tasks/'+attempt.taskId),task=>Boolean(task.upstream_task_id),'remote receipt persisted before polling');
    await persisted(clip,'video',n=>Object.values(n.studioLegacyAttempts||{}).some(a=>a.id===attempt.id&&a.taskId===attempt.taskId));
    assert.equal(videoPosts(await api('/api/fixture/native-state')).length,1);
    await stopServer();await startServer();await api('/api/fixture/native-state','POST',{pause_queries:false});
    const before=await api('/api/fixture/native-state');for(let i=0;i<3;i++)await api('/api/canvas-video-tasks/'+attempt.taskId);
    assert.equal((await api('/api/fixture/native-state')).requests.length,before.requests.length,'ledger GET after restart never dispatches or polls an upstream');
    await open(clip);await page.getByRole('button',{name:'适应全部节点 · Shift+1',exact:true}).click();await delay(200);await queryTaskButton();
    await until(()=>api('/api/canvas-video-tasks/'+attempt.taskId),t=>t.recovery_action==='archive_result'&&!t.processing,'remote completion survives archive failure');
    const archiveBefore=await api('/api/fixture/native-state');assert.equal(videoPosts(archiveBefore).length,1);
    const archiveButton=page.getByRole('button',{name:'重试保存结果',exact:true});await archiveButton.waitFor({state:'visible'});
    await until(()=>archiveButton.isEnabled(),Boolean,'archive retry button ready');
    await page.screenshot({path:path.join(artifacts,'archive-recovery-1500.png')});await archiveButton.click();
    const complete=await until(()=>api('/api/canvas-video-tasks/'+attempt.taskId),t=>t.status==='succeeded','cached result archive recovery');
    assert(complete.result.videos.every(url=>url.startsWith('/output/')||url.startsWith('/assets/')));
    const finalState=await api('/api/fixture/native-state');assert.equal(videoPosts(finalState).length,1);
    assert.equal(finalState.requests.filter(r=>r.method==='GET'&&r.host==='native-fixture.invalid').length,archiveBefore.requests.filter(r=>r.method==='GET'&&r.host==='native-fixture.invalid').length,'archive retry must use cached result');
    await until(()=>page.evaluate(()=>nodes.filter(n=>n.type==='output').flatMap(n=>n.images||[])),items=>items.some(item=>complete.result.videos.includes(item.url)),'original output slot receives result');
    await persisted(clip,'video',n=>Object.values(n.studioLegacyAttempts||{}).some(a=>a.id===attempt.id&&a.status==='succeeded'));
    checks.push('video survives real fixture process restart, read-only GET does not resume, explicit recovery queries old ID and retries only cached archive with one generation');
    const player=await page.locator('video').first();await player.evaluate(e=>e.load());await until(()=>player.evaluate(e=>({ready:e.readyState,width:e.videoWidth})),v=>v.ready>=1&&v.width===320,'archived video actually decodes');
    checks.push('archived output is local, saved under the original project, and decodes as 320px WebM');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(forbidden,[]);
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks,browser:browser.version(),upstream:finalState.requests,errors,external,forbidden},null,2));console.log(JSON.stringify({passed:true,checks,artifacts},null,2));
  }catch(error){
    fs.writeFileSync(path.join(artifacts,'server-failure.log'),log);
    if(page){await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});const diagnostic=await page.evaluate(()=>({nodes,errors:[]})).catch(()=>({}));fs.writeFileSync(path.join(artifacts,'failure-state.json'),JSON.stringify({diagnostic,upstream:await api('/api/fixture/native-state').catch(()=>({})),errors,external,forbidden},null,2));}
    throw error;
  }
  finally{await browser?.close();await stopServer();assert.equal(path.dirname(path.resolve(runtime)).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert(path.basename(runtime).startsWith('dw-native-integration-'));fs.rmSync(runtime,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);console.error(log.slice(-3500));process.exitCode=1;});
