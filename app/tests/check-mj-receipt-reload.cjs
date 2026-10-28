/* F01 (handover 2026-10-26): reloading around a paid MJ submit never loses the task or pays twice.
   Real classic canvas page and temporary storage; the MJ upstream is a local fake that counts POSTs. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('mj-receipt-reload',{server:'tests/mj-browser-server.py'});
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 const upstream=()=>{const file=path.join(h.runtime,'fake-mj-upstream.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{posts:[],queries:[]};};
 const makeCanvas=async title=>{
  const created=(await h.api('/api/canvases','POST',{title,kind:'classic'})).canvas;
  const nodes=[{id:'p1',type:'prompt',x:80,y:80,text:'雨夜站台'},{id:'g1',type:'generator',x:520,y:80,model:'midjourney-imagine',apiProvider:'mjfake'}];
  await h.api('/api/canvases/'+created.id,'PUT',{title,icon:'layers',nodes,connections:[{id:'c1',from:'p1',to:'g1'}],viewport:{x:0,y:0,scale:1},logs:[],settings:{},base_updated_at:created.updated_at,client_id:'fixture'});
  return created.id;
 };
 const open=async(page,id)=>{
  await page.goto(h.base+'/static/canvas.html?id='+id);
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioMidjourney&&StudioMidjourney.params(nodes.find(n=>n.id==='g1'),'imagine').prompt);
 };
 const stored=async id=>(await h.api('/api/canvases/'+id)).canvas.nodes.find(n=>n.id==='g1');
 const live=page=>page.evaluate(()=>{const n=nodes.find(x=>x.id==='g1');return {task:n.studioMjTask||'',history:n.studioMjHistory||'',status:n.studioMjStatus||'',state:n.studioMjState||'',query:!!document.querySelector('.node[data-id="g1"] .studio-mj-query')};});
 const waitFor=async(page,fn,arg)=>{try{await page.waitForFunction(fn,arg,{timeout:8000});}catch{}};
 try{
  const page=await h.newPage();
  const first=await makeCanvas('mj receipt');
  await open(page,first);

  await check('reload ~5ms after the receipt keeps the task and its query entry',async()=>{
   await page.route('**/api/studio/mj/submit',async route=>{const response=await route.fetch();await route.fulfill({response});setTimeout(()=>page.reload().catch(()=>{}),5);});
   await page.evaluate(()=>{runGenerator('g1');});
   for(let i=0;i<50&&!upstream().posts.length;i++)await delay(100);
   await delay(1200);await page.unroute('**/api/studio/mj/submit');
   await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioMidjourney);
   // The panel is redrawn by a 180ms decorate pass after each render.
   await waitFor(page,()=>nodes.find(n=>n.id==='g1')?.studioMjTask&&document.querySelector('.node[data-id="g1"] .studio-mj-query'));
   const n=await live(page);
   assert.equal(upstream().posts.length,1,'paid POSTs');
   assert.equal(n.task,'mj-fake-1','task after reload: '+JSON.stringify(n));
   assert(n.query,'no "查询已有任务" entry after reload '+JSON.stringify(n));
   for(let i=0;i<30&&(await stored(first)).studioMjTask!=='mj-fake-1';i++)await delay(200);
   assert.equal((await stored(first)).studioMjTask,'mj-fake-1','the server copy never received the task');
  });
  await check('running again after the reload queries the original task, not a new POST',async()=>{
   await page.evaluate(()=>{runGenerator('g1');});await delay(1500);
   assert.equal(upstream().posts.length,1);
   assert(upstream().queries.includes('mj-fake-1'),'original task was not queried');
  });
  await check('the task survives a service restart and is queried, not resubmitted',async()=>{
   await page.close();await h.restart();
   const again=await h.newPage();await open(again,first);
   const n=await live(again);assert.equal(n.task,'mj-fake-1');
   await again.evaluate(()=>{runGenerator('g1');});await delay(1500);
   assert.equal(upstream().posts.length,1);
   await again.close();
  });

  const second=await makeCanvas('mj before submit');
  const page2=await h.newPage();await open(page2,second);
  await check('reload before the POST leaves the server untouched and says the attempt was not sent',async()=>{
   await page2.route('**/api/studio/mj/submit',async route=>{page2.reload().catch(()=>{});await route.abort().catch(()=>{});});
   await page2.evaluate(()=>{runGenerator('g1');});
   await delay(2000);await page2.unroute('**/api/studio/mj/submit');
   await page2.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioMidjourney);
   await waitFor(page2,()=>{const n=nodes.find(x=>x.id==='g1');return n&&n.studioMjStatus&&n.studioMjStatus!=='submitting';});
   const n=await live(page2);
   assert.equal(upstream().posts.length,1,'no new paid POST');
   assert.equal(n.status,'failed','status after reload: '+JSON.stringify(n));
   assert.match(n.state,/未发出/);
  });
  await check('an attempt that never reached the server can be generated again once',async()=>{
   await page2.evaluate(()=>{runGenerator('g1');});
   for(let i=0;i<30&&upstream().posts.length<2;i++)await delay(100);
   await waitFor(page2,()=>nodes.find(n=>n.id==='g1')?.studioMjTask);
   assert.equal(upstream().posts.length,2);
   assert.equal((await live(page2)).task,'mj-fake-2');
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
