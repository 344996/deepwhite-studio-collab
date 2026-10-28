/* U04 (handover 2026-10-26): "常用" models in the picker, per kind, saved on the server, never
   changing existing nodes. Real classic canvas page and an offline catalogue; nothing is generated. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('model-favorites');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  await h.api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'Offline fixture',base_url:'https://api.deepwhiteai.com/v1',api_key:'offline-favorites',enabled:true,primary:true});
  const created=(await h.api('/api/canvases','POST',{title:'favorites',kind:'classic'})).canvas;
  const nodes=[{id:'g',type:'generator',x:80,y:80,apiProvider:'deepwhite',model:'deepwhiteai-image-g-v2.5-lowprice',studioPrompt:'雨夜'},
   {id:'v',type:'video',x:80,y:700,apiProvider:'deepwhite',studioPrompt:'雨夜'}];
  await h.api('/api/canvases/'+created.id,'PUT',{title:'favorites',icon:'layers',nodes,connections:[],viewport:{x:0,y:0,scale:.8},logs:[],settings:{},base_updated_at:created.updated_at,client_id:'fixture'});
  const page=await h.newPage();
  const open=async id=>{await page.goto(h.base+'/static/canvas.html?id='+created.id);await page.waitForFunction(()=>window.StudioStageOne&&document.querySelector('.node[data-id="g"] .studio-model-trigger'));await delay(900);
   await page.locator(`.node[data-id="${id}"] .studio-model-trigger`).first().click();await page.locator('#studioModelPicker').waitFor();};
  const pressed=()=>page.locator('#studioModelPicker .studio-picker-scope [aria-pressed="true"]').innerText();
  const rows=()=>page.locator('#studioModelPicker .studio-picker-option b').allInnerTexts();
  let chosen='';
  await check('with no favourites the picker shows everything and explains how to add one',async()=>{
   await open('g');assert.equal(await pressed(),'全部模型');
   assert.match(await page.locator('#studioModelPicker .studio-picker-tip').innerText(),/☆/);
   assert((await rows()).length>1,'no models listed');
  });
  await check('starring a model puts it in 常用 alone',async()=>{
   const star=page.locator('#studioModelPicker .studio-picker-star').nth(1);
   chosen=await page.locator('#studioModelPicker .studio-picker-option b').nth(1).innerText();
   await star.click();await delay(300);
   assert.equal(await star.getAttribute('aria-pressed'),'true');
   await page.locator('#studioModelPicker .studio-picker-scope button',{hasText:'常用'}).click();await delay(150);
   assert.deepEqual(await rows(),[chosen]);
  });
  await check('after reopening the page the picker opens on 常用 with that model',async()=>{
   await open('g');assert.equal(await pressed(),'常用');assert.deepEqual(await rows(),[chosen]);
  });
  await check('video favourites are separate from image favourites',async()=>{
   await page.keyboard.press('Escape');await page.locator(`.node[data-id="v"] .studio-model-trigger`).first().click();await page.locator('#studioModelPicker').waitFor();
   assert.equal(await pressed(),'全部模型');
  });
  await check('a favourite that is no longer available stays visible and says so',async()=>{
   const current=await h.api('/api/studio/model-favorites');
   await fetch(h.base+'/api/studio/model-favorites/image',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys:[...current.image,'deepwhite|retired-model']})});
   await open('g');
   assert.match(await page.locator('#studioModelPicker .studio-picker-gone').innerText(),/retired-model.*不可用/);
  });
  await check('favourites never change the model of an existing node',async()=>{
   assert.equal((await h.api('/api/canvases/'+created.id)).canvas.nodes.find(n=>n.id==='g').model,'deepwhiteai-image-g-v2.5-lowprice');
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
