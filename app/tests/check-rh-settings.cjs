/* U07 (handover 2026-10-26): RunningHub settings live in Settings and the canvas reads them.
   Real settings and classic canvas pages; the RH upstream is a local fake, nothing is submitted. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('rh-settings',{server:'tests/rh-ledger-browser-server.py'});
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const page=await h.newPage();
  await page.goto(h.base+'/static/studio-settings.html');
  await check('Settings has a RunningHub tab with keys, defaults and a connection check',async()=>{
   await page.locator('[data-tab="runninghub"]').click();await delay(300);
   assert.equal(await page.locator('#runninghubPanel').isVisible(),true);assert.equal(await page.locator('#apiPanel').isVisible(),false);
   for(const id of ['#rhKey','#rhWalletKey','#rhInstance','#rhTest'])assert.equal(await page.locator(id).count(),1,id);
  });
  await check('LibTV is listed honestly as not connected',async()=>{
   await page.locator('[data-tab="libtv"]').click();await delay(200);
   assert.match(await page.locator('#libtvPanel').innerText(),/未接入/);assert.equal(await page.locator('#runninghubPanel').isVisible(),false);
   await page.locator('[data-tab="runninghub"]').click();await delay(200);
  });
  await check('saving stores the key without showing it again and keeps the defaults',async()=>{
   await page.locator('#rhKey').fill('rh-settings-test-key');
   await page.locator('#runninghubPanel [name="rhPayment"][value="wallet"]').check();await page.locator('#rhInstance').selectOption('plus');
   await page.locator('#runninghubPanel button[type="submit"]').click();await page.waitForFunction(()=>/已保存/.test(document.getElementById('rhResult').textContent));
   assert.equal(await page.locator('#rhKey').inputValue(),'');assert.match(await page.locator('#rhKeyState').innerText(),/已保存/);
   assert.doesNotMatch(await page.content(),/rh-settings-test-key/);
  });
  await check('the connection check reports each stage without submitting',async()=>{
   await page.locator('#rhTest').click();
   await page.waitForFunction(()=>document.querySelectorAll('#rhStages li').length===4,null,{timeout:10000});
   // Each saved key is checked on its own; an unsaved wallet key is listed as not checked.
   assert.deepEqual(await page.locator('#rhStages li span').allInnerTexts(),['会员积分 Key · 服务可达','会员积分 Key · 密钥鉴权','会员积分 Key · 模型目录可读','钱包 Key']);
   assert.match(await page.locator('#rhStages li').last().innerText(),/未保存/);
  });
  await check('a new RH node on the canvas uses the defaults; an existing one keeps its own',async()=>{
   const created=(await h.api('/api/canvases','POST',{title:'rh defaults',kind:'classic'})).canvas;
   await h.api('/api/canvases/'+created.id,'PUT',{title:'rh defaults',icon:'layers',nodes:[{id:'old',type:'rh',x:0,y:0,rhMode:'app',rhPayment:'free',instanceType:'',rhParams:{},inputs:[]}],connections:[],viewport:{x:0,y:0,scale:1},logs:[],settings:{},base_updated_at:created.updated_at,client_id:'fixture'});
   // Canvas and Settings share one browser profile, as in the app, so Settings' broadcast can reach it.
   const shared=await h.browser.newContext({viewport:{width:1500,height:1000}});
   await shared.route('**/*',route=>new URL(route.request().url()).origin===h.base?route.fallback():(h.external.push(route.request().url()),route.abort()));
   const canvas=await shared.newPage(),settings=await shared.newPage();
   for(const p of [canvas,settings])p.on('pageerror',e=>h.errors.push(e.message));
   await canvas.goto(h.base+'/static/canvas.html?id='+created.id);
   await canvas.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof addRhNode==='function');await delay(800);
   const made=await canvas.evaluate(()=>{const n=addRhNode({x:600,y:0});return {payment:n.rhPayment,instance:n.instanceType,old:nodes.find(x=>x.id==='old')};});
   assert.deepEqual([made.payment,made.instance],['wallet','plus']);assert.deepEqual([made.old.rhPayment,made.old.instanceType],['free','']);
   // Changing the defaults in Settings reaches the canvas that is already open.
   await settings.goto(h.base+'/static/studio-settings.html');await settings.locator('[data-tab="runninghub"]').click();await settings.locator('#rhInstance').waitFor();await delay(300);
   await settings.locator('#runninghubPanel [name="rhPayment"][value="free"]').check();await settings.locator('#rhInstance').selectOption('');
   await settings.locator('#runninghubPanel button[type="submit"]').click();await settings.waitForFunction(()=>/已保存/.test(document.getElementById('rhResult').textContent));await delay(600);
   const later=await canvas.evaluate(()=>{const n=addRhNode({x:1200,y:0});return [n.rhPayment,n.instanceType];});
   assert.deepEqual(later,['free',''],'an open canvas kept the old defaults');
   await shared.close();
  });
  await check('choosing wallet without a wallet key is flagged when saving',async()=>{
   await page.locator('#runninghubPanel [name="rhPayment"][value="wallet"]').check();
   await page.locator('#runninghubPanel button[type="submit"]').click();await page.waitForFunction(()=>/还没有保存钱包 Key/.test(document.getElementById('rhResult').textContent));
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
