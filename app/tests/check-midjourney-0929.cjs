'use strict';
// Real canvas/save/reload; every generation, price and MJ result is an offline fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path'));}
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-mj-0929-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const image='/static/studio-mark.svg';
async function main(){
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base=`http://127.0.0.1:${port}`,submitted=[],queries=[],quotes=[],errors=[],external=[];
  let child,browser,log='',mode='poll-error';
  const api=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json();};
  try{
    child=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:String(port),DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'}});
    child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
    let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await delay(200);}}assert(ready,log);
    await api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'Offline fixture',base_url:'https://api.deepwhiteai.com/v1',api_key:'mock-mj-browser-only',enabled:true,primary:true});
    const canvas=(await api('/api/canvases','POST',{title:'MJ 0929 isolated fixture',kind:'classic'})).canvas;
    const executablePath=process.env.CHROMIUM_EXECUTABLE||'data/local-path';
    browser=await chromium.launch({headless:true,executablePath});const page=await browser.newPage({viewport:{width:1500,height:1000}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==base){external.push(url.origin);return route.abort();}
      if(url.pathname==='/api/canvases/'+canvas.id&&request.method()==='PUT'&&['save-error','save-conflict'].includes(mode)){
        return route.fulfill({status:mode==='save-error'?500:409,json:{detail:{message:'fixture save failure'}}});
      }
      if(url.pathname==='/api/studio/quote'){
        const body=request.postDataJSON();quotes.push(body);return route.fulfill({json:{label:'模拟估价 '+(body.params.size||'')+' '+(body.params.speed||''),note:'离线示例'}});
      }
      if(url.pathname==='/api/studio/mj/submit'){
        const body=request.postDataJSON();submitted.push(body);
        if(mode==='submit-uncertain')return route.fulfill({status:502,json:{detail:'MJ 网络响应异常'}});
        if(body.node_id==='mj-batch'){
          const attempt=submitted.filter(s=>s.node_id==='mj-batch').length;
          if(attempt===1)return route.fulfill({json:{task_id:'task_batch_first',history_id:'mj_batch_first',status:'succeeded',images:[image]}});
          return route.fulfill({status:502,json:{detail:'MJ 网络响应异常'}});
        }
        const task='task_'+body.node_id;
        if(mode==='archive-error')return route.fulfill({json:{task_id:task,history_id:'mj_'+body.node_id,status:'paused',remote_status:'succeeded',media_status:'failed',images:[],error:'MJ 已完成，但结果保存失败。'}});
        if(mode==='direct-archive-error')return route.fulfill({json:{task_id:'',history_id:'mj_direct',status:'paused',remote_status:'succeeded',media_status:'failed',images:[],error:'MJ 已完成，但结果保存失败。'}});
        return route.fulfill({json:{task_id:task,history_id:'mj_'+body.node_id,status:'pending',remote_status:'pending',media_status:'not_required'}});
      }
      if(url.pathname.startsWith('/api/studio/mj/tasks/')){
        queries.push({method:request.method(),task:url.pathname.split('/').at(-1),provider:url.searchParams.get('provider_id')});
        if(mode==='poll-error')return route.fulfill({status:502,json:{detail:'MJ 网络响应异常'}});
        if(mode==='remote-failed')return route.fulfill({json:{task_id:queries.at(-1).task,status:'failed',remote_status:'failed',error:'离线任务失败'}});
        return route.fulfill({json:{task_id:queries.at(-1).task,status:'succeeded',remote_status:'succeeded',media_status:'completed',images:[image]}});
      }
      if(url.pathname==='/api/studio/mj/history/mj_direct/resume'){
        queries.push({method:request.method(),history:'mj_direct'});return route.fulfill({json:{task_id:'',history_id:'mj_direct',status:'succeeded',remote_status:'succeeded',media_status:'completed',images:[image]}});
      }
      if(url.pathname.startsWith('/api/studio/mj/attempts/')){
        // The submit above is faked here, so answer as the real server would for an attempt it
        // recorded (F01) whose upstream reply was lost: found, no task number, result uncertain.
        queries.push({method:request.method(),attempt:url.pathname.split('/').at(-1)});
        return route.fulfill({json:{found:true,history_id:'mj_batch_second',task_id:'',status:'uncertain',error:'MJ 网络响应异常',canvas_id:canvas.id,node_id:'mj-batch'}});
      }
      if(request.method()==='POST'&&/\/api\/(studio\/generations|canvas-(image|video|llm)|online-image|generate|midjourney\/)/.test(url.pathname))throw Error('Unexpected generation route '+url.pathname);
      return route.continue();
    });
    await page.goto(base+'/static/canvas.html?id='+canvas.id);await page.locator('#shell:not(.no-canvas) #board').waitFor();await page.waitForFunction(()=>typeof StudioMidjourney!=='undefined'&&typeof canvas!=='undefined'&&canvas?.id);await delay(500);
    await page.evaluate(()=>{
      nodes=[];connections=[];
      for(const [id,x,size] of [['mj-a',80,'1:1'],['mj-b',780,'3:4']]){const n=addGeneratorNode({x,y:80});n.id=id;n.apiProvider='deepwhite';n.model='midjourney-imagine';n.studioPrompt=id+' offline prompt';n.studioParams={ratio:'1:1',resolution:'1k'};n.studioMjParams={size};}
      render();
    });
    const nodeA=page.locator('[data-id="mj-a"]'),nodeB=page.locator('[data-id="mj-b"]');
    await nodeA.locator('.studio-mj-panel').waitFor({state:'attached'});await nodeB.locator('.studio-mj-panel').waitFor({state:'attached'});
    await nodeA.getByRole('button',{name:'生成参数设置',exact:true}).click();
    await nodeA.locator('[data-mj-field="size"]').selectOption('16:9');await nodeA.locator('[data-mj-field="speed"]').selectOption('turbo');await nodeA.locator('[data-mj-field="version"]').selectOption('6.1');
    await page.waitForFunction(()=>document.querySelector('[data-id="mj-a"] .studio-image-settings')?.textContent.includes('16:9 / MJ 6.1 / Turbo / 1 次'));
    assert((await nodeB.locator('.studio-image-settings').innerText()).includes('3:4'));assert(!(await nodeA.locator('.studio-image-settings').innerText()).includes('1k'));
    await page.waitForFunction(()=>document.querySelector('[data-id="mj-a"] .studio-regular-price b')?.textContent.includes('16:9 turbo'));
    const quote=quotes.findLast(q=>q.model==='midjourney-imagine'&&q.params.size==='16:9'&&q.params.speed==='turbo');assert(quote);assert.equal(quote.params.version,'6.1');
    await nodeA.locator('.studio-universal-params header button').click();
    await nodeA.locator('.gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-a').studioMjTask==='task_mj-a');
    assert.equal(submitted.length,1);assert.deepEqual(submitted[0].params,quote.params);assert.equal(submitted[0].node_id,'mj-a');
    // Editing settings or channel while waiting must not alter the original receipt or its queries.
    await page.evaluate(()=>{const n=nodes.find(n=>n.id==='mj-a');n.apiProvider='other-channel';n.studioMjParams.size='9:16';n.studioMjParams.speed='relax';render();});
    await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-a').studioMjStatus==='paused');
    assert.equal(queries.at(-1).provider,'deepwhite');assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='mj-b').studioMjTask||''),'');
    await page.evaluate(async()=>await saveCanvas());await page.reload();await nodeA.locator('.studio-mj-panel').waitFor({state:'attached'});
    assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='mj-a').studioMjTask),'task_mj-a');assert.equal(submitted.length,1);
    mode='success';await page.evaluate(()=>{const n=nodes.find(n=>n.id==='mj-a');n.runError='old failure';n.runStatus='failed';render();});
    // Clicking generation on a paused known task resumes it; it does not submit another charge.
    await nodeA.locator('.gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-a').runStatus==='done');
    assert.equal(submitted.length,1);assert.equal(queries.at(-1).provider,'deepwhite');assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='mj-a').runError),'');
    assert.equal(await page.evaluate(()=>canvas.logs.at(-1).request.params.size),'16:9');assert.equal(await page.evaluate(()=>canvas.logs.at(-1).request.provider_id),'deepwhite');
    const outputsBefore=await page.evaluate(()=>nodes.find(n=>n.id==='mj-a').generatedOutputs.length);
    await nodeA.getByRole('button',{name:'生成参数设置',exact:true}).click();await nodeA.getByRole('button',{name:'查询已有任务（不重新生成）',exact:true}).click();await page.waitForFunction(()=>!nodes.find(n=>n.id==='mj-a').running);
    assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='mj-a').generatedOutputs.length),outputsBefore);
    // Archive failure stops before importing raw media, and recovery uses the saved original task.
    mode='archive-error';await nodeB.locator('.gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-b').studioMjStatus==='paused');
    assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='mj-b').generatedOutputs?.length||0),0);assert.equal(submitted.length,2);
    mode='remote-failed';await nodeB.locator('.gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-b').studioMjStatus==='failed');
    assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='mj-b').runStatus),'failed');assert.equal(submitted.length,2);
    mode='success';await nodeB.getByRole('button',{name:'生成参数设置',exact:true}).click();await nodeB.getByRole('button',{name:'查询已有任务（不重新生成）',exact:true}).click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-b').runStatus==='done');assert.equal(submitted.length,2);
    // A lost submission response stays uncertain across reload and cannot silently submit again.
    await page.evaluate(()=>{const n=addGeneratorNode({x:80,y:500});n.id='mj-uncertain';n.model='midjourney-imagine';n.apiProvider='deepwhite';n.studioPrompt='offline uncertain';render();});
    const uncertain=page.locator('[data-id="mj-uncertain"]');await uncertain.locator('.studio-mj-panel').waitFor({state:'attached'});mode='submit-uncertain';await uncertain.locator('.gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-uncertain').studioMjStatus==='uncertain');
    assert.equal(submitted.length,3);await uncertain.locator('.gen-run-row .gen-btn').click();assert.equal(submitted.length,3);await page.evaluate(async()=>await saveCanvas());await page.reload();await uncertain.locator('.studio-mj-panel').waitFor({state:'attached'});await uncertain.locator('.gen-run-row .gen-btn').click();assert.equal(submitted.length,3);
    // Immediate media receipts with no remote ID recover using only the safe history route.
    await page.evaluate(()=>{nodes=[];connections=[];const n=addGeneratorNode({x:80,y:80});n.id='mj-direct';n.model='midjourney-imagine';n.apiProvider='deepwhite';n.studioPrompt='offline direct';render();});
    const direct=page.locator('[data-id="mj-direct"]');await direct.locator('.studio-mj-panel').waitFor({state:'attached'});mode='direct-archive-error';await direct.locator('.gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-direct').studioMjStatus==='paused');
    await direct.locator('.gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-direct').runStatus==='done');assert.equal(submitted.length,4);assert.deepEqual(queries.at(-1),{method:'POST',history:'mj_direct'});
    // A second child losing its response must never inherit the first child's success receipt.
    await page.evaluate(()=>{nodes=[];connections=[];const n=addGeneratorNode({x:80,y:80});n.id='mj-batch';n.model='midjourney-imagine';n.apiProvider='deepwhite';n.count=2;n.studioPrompt='offline batch';render();});
    const batch=page.locator('[data-id="mj-batch"]');await batch.locator('.studio-mj-panel').waitFor({state:'attached'});await batch.locator('.gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-batch').studioMjStatus==='uncertain');
    assert.equal(submitted.length,6);assert.equal(await page.evaluate(()=>nodes[0].studioMjTask),'');assert.equal(await page.evaluate(()=>nodes[0].studioMjHistory),'');assert.equal(await page.evaluate(()=>nodes[0].studioMjPastTasks[0].task_id),'task_batch_first');
    await batch.locator('.gen-run-row .gen-btn').click();assert.equal(submitted.length,6);
    // Reload after saving an in-flight attempt with no receipt must turn it uncertain, never POST.
    await page.evaluate(async()=>{nodes[0].studioMjStatus='submitting';await saveCanvas();});await page.reload();await batch.locator('.studio-mj-panel').waitFor({state:'attached'});await batch.locator('.gen-run-row .gen-btn').click();/* F01: the attempt is looked up on the server first (async), then marked uncertain */await page.waitForFunction(()=>nodes[0].studioMjStatus==='uncertain',null,{timeout:8000});assert.equal(submitted.length,6);
    for(const problem of ['save-error','save-conflict']){
      await page.evaluate(()=>{nodes=[];connections=[];const n=addGeneratorNode({x:80,y:80});n.id='mj-save';n.model='midjourney-imagine';n.apiProvider='deepwhite';n.studioPrompt='offline saving';render();});
      const saving=page.locator('[data-id="mj-save"]');await saving.locator('.studio-mj-panel').waitFor({state:'attached'});mode=problem;await saving.locator('.gen-run-row .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.id==='mj-save')?.studioMjStatus==='failed');
      assert.equal(submitted.length,6);assert((await page.evaluate(()=>nodes.find(n=>n.id==='mj-save').runError)).includes('未提交'));
      mode='success';await page.reload();await page.locator('#shell:not(.no-canvas) #board').waitFor();await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof StudioMidjourney!=='undefined');await delay(500);
    }
    await page.evaluate(()=>{nodes=[];connections=[];const n=addGeneratorNode({x:80,y:80});n.id='regular';n.model='deepwhiteai-image-nb-pro';n.studioParamsModel=n.model;n.studioParams={ratio:'4:3',resolution:'2k',resolution_type:'2k'};render();});
    const regularSummary=await page.locator('[data-id="regular"] .studio-image-settings').innerText();assert(regularSummary.includes('4:3 / 2k')&&!regularSummary.includes('MJ'),regularSummary);
    // The same submission read-back guard and original-channel recovery also serve the smart canvas.
    const smart=(await api('/api/canvases','POST',{title:'MJ smart isolated fixture',kind:'smart'})).canvas;
    await page.goto(base+'/static/smart-canvas.html?id='+smart.id);await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof studioAddMj==='function');await delay(500);
    await page.evaluate(()=>{const n=studioAddMj({x:100,y:100});window.mjSmartId=n.id;n.apiProvider='deepwhite';n.studioMjAction='blend';n.studioMjImages=[{url:'/assets/offline-a.png'},{url:'/assets/offline-b.png'}];render();});
    await page.locator('#composer .studio-mj-run').waitFor();mode='archive-error';await page.locator('#composer .studio-mj-run').click();await page.waitForFunction(()=>nodes.find(n=>n.id===window.mjSmartId)?.studioMjStatus==='paused');
    assert.equal(submitted.length,7);assert.equal(submitted.at(-1).canvas_id,smart.id);
    const persisted=(await api('/api/canvases/'+smart.id)).canvas.nodes.find(n=>n.id===submitted.at(-1).node_id);assert(persisted.studioMjAttempt);assert.equal(persisted.studioMjRequest.provider_id,'deepwhite');
    await page.evaluate(()=>{nodes.find(n=>n.id===window.mjSmartId).apiProvider='other-channel';render();});mode='success';await page.locator('#composer .studio-mj-query').click();await page.waitForFunction(()=>nodes.find(n=>n.id===window.mjSmartId)?.runStatus==='done');assert.equal(submitted.length,7);assert.equal(queries.at(-1).provider,'deepwhite');
    assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    console.log('PASS MJ 0929: effective summary/quote/request, node isolation, original-channel queries, save/reload, archive recovery, failed/uncertain states, no duplicate POST and ordinary summaries.');
  }finally{
    await browser?.close();if(child){child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,5000);});}
    const target=path.resolve(runtime),tempRoot=path.resolve(os.tmpdir());assert(target.startsWith(tempRoot+path.sep)&&path.basename(target).startsWith('dw-mj-0929-'));fs.rmSync(target,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
