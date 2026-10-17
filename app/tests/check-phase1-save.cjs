'use strict';
// Run the real save functions with controlled network timing, without a browser/API.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'static/js/smart-canvas.js'),'utf8');
const saveCode=source.slice(source.indexOf('function scheduleSave(){'),source.indexOf('\nfunction imageMetaFromNode'));
const wrapper=fs.readFileSync(path.join(root,'static/studio-stage-one.js'),'utf8');
const wrapperCode=wrapper.slice(wrapper.indexOf('  const nativeSave=saveCanvas;'),wrapper.indexOf('  const saveStates='));
const declaration=source.slice(source.indexOf('let canvasSyncInFlight = false;'),source.indexOf('\n',source.indexOf('let canvasSyncInFlight = false;')));
function harness(wrapped=false){
  const calls=[],events=[],timers=new Map(),drafts=[],acks=[];let timer=0;
  const canvas={id:'a',updated_at:1,title:'A',nodes:[],connections:[]};
  const ctx={canvas,canvasId:'a',nodes:[{id:'node',text:'first',images:[]}],viewport:{x:0,y:0,scale:1},saveTimer:null,
    canvasDefaultSmartSettings:{},initialSmartSettings:{},smartClientId:'fixture',
    CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},
    window:{dispatchEvent:event=>events.push(event),StudioCanvasDrafts:{ack:(...args)=>acks.push(args),failed:()=>{}}},
    toast:()=>{},tr:x=>x,savePromptDraftForCurrent:()=>{},settingsForStorage:x=>x,
    mediaItemForStorage:x=>x,stripImageGenerationMeta:x=>x,
    studioSmartCaptureDraft:payload=>{const token={revision:drafts.length+1};drafts.push({token,payload});return token;},
    canvasForStorage:()=>JSON.parse(JSON.stringify({...ctx.canvas,nodes:ctx.nodes})),
    applyMergedServerCanvas:remote=>{ctx.canvas.updated_at=remote.updated_at;},
    setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),
    fetch:(url,options)=>new Promise(resolve=>{calls.push({url,body:JSON.parse(options.body),resolve});})};
  vm.createContext(ctx);
  // Include only declarations needed by this isolated save module.
  const extra=source.match(/^let smartQueuedSave =.*$|^const smartSaveRevisions =.*$/gm)||[];
  vm.runInContext(declaration+'\n'+extra.join('\n')+'\n'+saveCode,ctx);
  if(wrapped)vm.runInContext(wrapperCode,ctx);
  const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  return {ctx,calls,events,acks,drafts,async timers(){const batch=[...timers.values()];timers.clear();for(const fn of batch)fn();await tick();},tick,
    respond(index,status=200){const item=calls[index];item.resolve({ok:status===200,status,json:async()=>status===200?{canvas:{...item.body,id:item.url.split('/').pop(),updated_at:index+2}}:{detail:{canvas:{id:'a',updated_at:8,nodes:[]}}}});}};
}
async function latestEdits(wrapped){
  const h=harness(wrapped),{ctx}=h;
  ctx.scheduleSave();await h.timers();assert.equal(h.calls.length,1);
  ctx.nodes[0].text='last edit';ctx.scheduleSave();await h.timers();
  h.respond(0);await h.tick();await h.timers();await h.tick();
  const first=h.events.find(e=>e.type==='studio-save-state'&&e.detail.ok);
  assert.equal(first?.detail.pending,true,'old save must report newer edits still pending');
  assert.equal(h.calls.length,2,'latest edit must receive a follow-up save');
  assert.equal(h.calls[1].body.nodes[0].text,'last edit');
  h.respond(1);await h.tick();await h.timers();
  assert.equal(h.events.filter(e=>e.type==='studio-save-state').at(-1).detail.pending,false);
  assert.equal(h.calls.length,2,'queue and native retry must not duplicate saves');
}
async function failedRetry(){
  const h=harness();const saving=h.ctx.saveCanvas();h.respond(0,500);assert.equal((await saving).ok,false);
  await h.timers();assert.equal(h.calls.length,1,'failure must wait for a new edit or explicit retry');
  h.ctx.nodes[0].text='retry retained';const retry=h.ctx.saveCanvas();h.respond(1);assert.equal((await retry).ok,true);
  assert.equal(h.calls[1].body.nodes[0].text,'retry retained');
}
async function switchCanvas(){
  const h=harness(),saving=h.ctx.saveCanvas();
  h.ctx.canvas={id:'b',updated_at:70,title:'B'};h.ctx.canvasId='b';h.ctx.nodes=[{id:'node',text:'B draft',images:[]}];
  h.ctx.scheduleSave();await h.timers();h.respond(0);assert.equal((await saving).code,'target-changed');
  await h.timers();assert.equal(h.ctx.canvas.updated_at,70);assert.equal(h.calls[1].url,'/api/canvases/b');
  h.respond(1);await h.tick();assert.equal(h.ctx.nodes[0].text,'B draft');
}
async function conflictDraft(){
  const h=harness();h.ctx.nodes[0].promptDraftText='local handwriting';const saving=h.ctx.saveCanvas();
  h.respond(0,409);assert.equal((await saving).code,'conflict');assert.equal(h.ctx.nodes[0].promptDraftText,'local handwriting');
  await h.timers();assert.equal(h.calls[1].body.base_updated_at,8);h.respond(1);await h.tick();
}
async function browserRegression(){
  const {spawn}=require('node:child_process'),net=require('node:net');
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
  const runtimeRoot=path.resolve(root,'../.test-runtime');fs.mkdirSync(runtimeRoot,{recursive:true});
  const runtime=fs.mkdtempSync(path.join(runtimeRoot,'phase1-save-'));
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const base='http://127.0.0.1:'+port,delay=ms=>new Promise(r=>setTimeout(r,ms));let processLog='',browser,child;
  const held=[],errors=[],external=[];let mode='normal';
  const api=async(url,method='GET',body)=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(response.ok,await response.clone().text());return response.json();};
  const until=async predicate=>{for(let i=0;i<150;i++){if(await predicate())return;await delay(40);}throw Error('Timed out waiting for fixture');};
  try{
    child=spawn(process.env.PYTHON_EXECUTABLE||'python',['-B',path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:String(port),DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
    child.stdout.on('data',data=>processLog+=data);child.stderr.on('data',data=>processLog+=data);
    await until(async()=>{try{await api('/api/studio/health');return true;}catch{return false;}});
    const owner=(await api('/api/projects','POST',{name:'Navigation owner'})).project;
    const saved=(await api('/api/canvases','POST',{title:'Phase 1 save',kind:'smart',project:owner.id})).canvas;
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==base){external.push(url.origin);return route.abort();}
      if(request.method()==='PUT'&&url.pathname==='/api/canvases/'+saved.id){
        if(mode==='fail')return route.fulfill({status:507,json:{detail:'Isolated save failure'}});
        if(mode==='hold'){held.push(route);return;}
      }
      if(request.method()==='POST'&&/generations|canvas-(image|video|llm)|\/mj\//.test(url.pathname))throw Error('Unexpected generation request');
      return route.continue();
    });
    await page.goto(base+'/static/smart-canvas.html?id='+saved.id);await page.waitForFunction(()=>canvas?.id&&window.StudioSave&&document.getElementById('smartV2SaveStatus'));
    await delay(600);await page.evaluate(()=>saveCanvas());
    mode='hold';await page.evaluate(()=>{const node=createPromptNode(100,100);node.id='phase1-save-node';node.text='first edit';scheduleSave();});
    await until(()=>held.length===1);
    await page.evaluate(()=>{nodes.find(n=>n.id==='phase1-save-node').text='last edit';scheduleSave();});await delay(550);
    await held[0].fulfill({response:await held[0].fetch()});await until(()=>held.length===2);
    assert.notEqual(await page.locator('#smartV2SaveStatus').innerText(),'已保存','full UI must not label old response as latest saved');
    assert.equal((await api('/api/canvases/'+saved.id)).canvas.nodes.find(n=>n.id==='phase1-save-node').text,'first edit');
    await held[1].fulfill({response:await held[1].fetch()});mode='normal';
    await page.waitForFunction(()=>document.getElementById('smartV2SaveStatus').textContent==='已保存');
    assert.equal((await api('/api/canvases/'+saved.id)).canvas.nodes.find(n=>n.id==='phase1-save-node').text,'last edit');
    mode='fail';const failure=await page.evaluate(async()=>{nodes.find(n=>n.id==='phase1-save-node').text='retry text';scheduleSave();return saveCanvas();});assert.equal(failure.ok,false);
    assert.equal(await page.locator('#smartV2SaveStatus').innerText(),'保存失败，请重试');
    mode='normal';await page.evaluate(()=>saveCanvas());assert.equal((await api('/api/canvases/'+saved.id)).canvas.nodes.find(n=>n.id==='phase1-save-node').text,'retry text');
    console.log('PASS browser: assembled smart page delayed saves, truthful status and failure retry');
    const heldBeforeBack=held.length;
    mode='hold';await page.evaluate(()=>{nodes.find(n=>n.id==='phase1-save-node').text='return first';scheduleSave();});
    await until(()=>held.length===heldBeforeBack+1);
    await page.evaluate(()=>{nodes.find(n=>n.id==='phase1-save-node').text='return pending';scheduleSave();});await delay(550);
    await page.locator('.smart-back').click();assert(new URL(page.url()).pathname.endsWith('smart-canvas.html'),'return must wait for queued saves');
    await held[heldBeforeBack].fulfill({response:await held[heldBeforeBack].fetch()});await until(()=>held.length===heldBeforeBack+2);
    assert(new URL(page.url()).pathname.endsWith('smart-canvas.html'),'older successful response must not allow navigation');
    await page.evaluate(()=>{nodes.find(n=>n.id==='phase1-save-node').text='edited after return click';scheduleSave();});
    await held[heldBeforeBack+1].fulfill({response:await held[heldBeforeBack+1].fetch()});await until(()=>held.length===heldBeforeBack+3);
    await held[heldBeforeBack+2].fulfill({response:await held[heldBeforeBack+2].fetch()});mode='normal';
    await page.waitForFunction(()=>!document.querySelector('.smart-back').disabled);
    assert(new URL(page.url()).pathname.endsWith('smart-canvas.html'),'edits made while returning must keep the editor open');
    assert((await page.locator('#toast').innerText()).includes('再次点击'),'remaining on the editor must explain how to return');
    assert.equal((await api('/api/canvases/'+saved.id)).canvas.nodes.find(n=>n.id==='phase1-save-node').text,'edited after return click');
    await page.locator('.smart-back').click();await page.waitForURL('**/canvas-list.html?project='+owner.id);
    await page.goto(base+'/static/smart-canvas.html?id='+saved.id);await page.waitForFunction(()=>canvas?.id&&window.StudioSave);
    mode='fail';await page.evaluate(()=>{nodes.find(n=>n.id==='phase1-save-node').text='failed return draft';scheduleSave();});await page.locator('.smart-back').click();
    await page.waitForFunction(()=>document.getElementById('smartV2SaveStatus').textContent==='保存失败，请重试'&&!document.querySelector('.smart-back').disabled);
    assert(new URL(page.url()).pathname.endsWith('smart-canvas.html'));assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='phase1-save-node').text),'failed return draft');
    mode='normal';await page.locator('.smart-back').click();await page.waitForURL('**/canvas-list.html?project='+owner.id);
    assert.equal((await api('/api/canvases/'+saved.id)).canvas.nodes.find(n=>n.id==='phase1-save-node').text,'failed return draft');
    console.log('PASS browser: real back click waits for saves, keeps new edits and failed saves on-page, and preserves project on retry');
    await api('/api/projects','POST',{name:'Retained project'});await api('/api/projects','POST',{name:'Newest project'});
    const index=path.join(runtime,'data/projects.json'),damage=Buffer.from('{broken phase1 fixture');fs.writeFileSync(index,damage);
    await page.goto(base+'/');await page.locator('#projectIndexError').waitFor();assert(await page.locator('#projectIndexError').innerText().then(t=>t.includes('恢复上一版')));
    assert.deepEqual(fs.readFileSync(index),damage,'viewing damage must not overwrite the index');
    page.once('dialog',dialog=>dialog.accept());await page.locator('#projectIndexError button').click();await page.waitForFunction(()=>!document.getElementById('projectIndexError'));
    assert((await api('/api/projects')).projects.some(p=>p.name==='Retained project'));
    const preserved=fs.readdirSync(path.dirname(index)).filter(name=>name.startsWith('projects.json.corrupt-'));assert.equal(preserved.length,1);assert.deepEqual(fs.readFileSync(path.join(path.dirname(index),preserved[0])),damage);
    await page.reload();assert.equal(await page.locator('#projectIndexError').count(),0);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS browser: corrupt index stays intact, visible explicit restore preserves damaged file');
  }catch(error){console.error(processLog.slice(-2000));throw error;}
  finally{for(const route of held){try{await route.abort();}catch{}}await browser?.close();if(child){child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,5000);});}console.log('Browser fixture retained at '+runtime);}
}
(async()=>{const failures=[];const checks=[['native latest edits',()=>latestEdits(false)],['wrapped latest edits',()=>latestEdits(true)],['failure and retry',failedRetry],['switch canvas',switchCanvas],['conflict draft',conflictDraft]];if(process.argv.includes('--browser'))checks.push(['browser integration',browserRegression]);for(const [name,test] of checks){try{await test();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name+': '+error.stack);}}if(failures.length)process.exitCode=1;})();
