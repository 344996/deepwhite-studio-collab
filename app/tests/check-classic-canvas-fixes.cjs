/* LINK-01, UI-01, UI-02, REF-01 on the real classic canvas page with real temporary storage; no generation. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const PERSON='/static/design-review/assets/character-v1.png',SCENE='/static/design-review/assets/scene-v1.png';
async function main(){
 const h=await start('classic-canvas-fixes');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const created=(await h.api('/api/canvases','POST',{title:'classic fixes',kind:'classic'})).canvas;
  const nodes=[
   {id:'llm1',type:'llm',x:80,y:80,w:420,userInput:'写一段雨夜站台的描述'},
   {id:'img1',type:'generator',x:640,y:80},
   {id:'person',type:'image',x:80,y:620,url:PERSON,name:'人物'},
   {id:'scene',type:'image',x:80,y:900,url:SCENE,name:'场景'},
   {id:'p1',type:'prompt',x:420,y:620,text:'让参考1中的人物站在参考2的场景里'},
   {id:'gen',type:'generator',x:820,y:700}];
  const connections=[{id:'c1',from:'llm1',to:'img1'},{id:'c2',from:'person',to:'gen'},{id:'c3',from:'scene',to:'gen'},{id:'c4',from:'p1',to:'gen'}];
  await h.api('/api/canvases/'+created.id,'PUT',{title:created.title,icon:'layers',nodes,connections,viewport:{x:0,y:0,scale:1},logs:[],settings:{},base_updated_at:created.updated_at,client_id:'fixture'});
  const page=await h.newPage();
  await page.goto(h.base+'/static/canvas.html?id='+created.id);
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioStageOne);
  await delay(1500);

  // 09: every drawn connection starts at its live output port, after async price insertion and zoom.
  const linkDrift=()=>page.evaluate(()=>connections.map(c=>{
   const path=[...document.querySelectorAll('#links path.link')].find(p=>p.getAttribute('d'));
   const paths=[...document.querySelectorAll('#links path.link')].map(p=>p.getAttribute('d').match(/^M\s*([-\d.]+)\s+([-\d.]+)/)).filter(Boolean).map(m=>({x:+m[1],y:+m[2]}));
   const live=portPoint(c.from,'out');
   return Math.min(...paths.map(p=>Math.hypot(p.x-live.x,p.y-live.y)));
  }).reduce((a,b)=>Math.max(a,b),0));
  await check('09 connections follow the output port after the price area appears',async()=>{
   assert(await page.locator('.node[data-id="llm1"] .studio-price').count(),'price area never appeared');
   const n=await page.evaluate(()=>document.querySelectorAll('#links path.link').length);assert(n>=4,'only '+n+' connections drawn');const drift=await linkDrift();assert(drift<=1.5,'connection start is '+drift.toFixed(1)+'px away from the port');
  });
  for(const mode of ['chat','node']){
   await check('09 connections follow the port after switching to '+mode+' mode',async()=>{
    await page.locator(`.node[data-id="llm1"] .llm-mode [data-mode="${mode}"]`).click();await delay(1000);
    const drift=await linkDrift();assert(drift<=1.5,'after '+mode+' mode the connection is '+drift.toFixed(1)+'px away');
   });
  }
  await check('09 connections follow the port after zooming',async()=>{
   const box=await page.locator('#board').boundingBox();
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.keyboard.down('Control');
   for(let i=0;i<3;i++){await page.mouse.wheel(0,-120);await delay(60);}
   await page.keyboard.up('Control');await delay(700);
   const drift=await linkDrift();assert(drift<=1.5,'after zoom the connection is '+drift.toFixed(1)+'px away');
  });

  // 11: the classic "素材" button opens a visible, usable panel, also when empty.
  await check('11 the 素材 button shows the asset panel with an empty state, closes and reopens',async()=>{
   const button=page.locator('#workspaceCanvasRail button',{hasText:'素材'});
   await button.click();await delay(400);
   const panel=page.locator('#canvasAssetPanel');
   const shown=await panel.evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>100&&r.height>100;});
   assert(shown,'panel is open but not visible');
   assert(await page.locator('#canvasAssetPanel .canvas-asset-empty').isVisible(),'empty library has no visible empty state');
   await page.locator('#canvasAssetCloseBtn').click();await delay(300);
   assert(!(await panel.evaluate(e=>e.classList.contains('open'))));
   await button.click();await delay(300);
   assert(await panel.evaluate(e=>e.classList.contains('open')&&e.getBoundingClientRect().width>100));
   await page.locator('#canvasAssetCloseBtn').click();await delay(200);
  });

  // 10: the crop window keeps focus, blocks the background and returns focus on close.
  await check('10 crop dialog traps Tab, blocks the background and restores focus',async()=>{
   const add=page.locator('#workspaceCanvasRail button',{hasText:'添加'});
   await add.focus();
   await page.evaluate(()=>openImageEditor('scene','crop'));await delay(600);
   for(let i=0;i<14;i++){
    await page.keyboard.press('Tab');
    const inside=await page.evaluate(()=>!!document.activeElement?.closest('#imageEditModal .image-edit-panel'));
    assert(inside,'Tab '+(i+1)+' left the crop dialog for '+await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,80)));
   }
   const r=await add.boundingBox();await page.mouse.click(r.x+r.width/2,r.y+r.height/2);await delay(300);
   const menuOpen=await page.evaluate(()=>[...document.querySelectorAll('#createMenu,.studio-add-menu,[data-add-menu]')].some(m=>m.offsetParent&&getComputedStyle(m).visibility!=='hidden'&&m.classList.contains('open')||m.matches(':popover-open')));
   assert(!menuOpen,'the background 添加 button still opened its menu');
   if(await page.evaluate(()=>document.getElementById('imageEditModal').classList.contains('open')))await page.keyboard.press('Escape');
   await delay(300);
   assert(!(await page.evaluate(()=>document.getElementById('imageEditModal').classList.contains('open'))),'dialog did not close');
   assert(await page.evaluate(()=>document.activeElement?.textContent?.includes('添加')),'focus did not return to the opener: '+await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,80)));
  });

  // 26: thumbnails, material panel, prompt numbering and the request share one identity and order.
  const state=()=>page.evaluate(()=>{
   const n=nodes.find(x=>x.id==='gen'),root=document.querySelector('.node[data-id="gen"]');root?.studioRefreshReferences?.();
   const strip=[...root.querySelectorAll('.studio-reference-thumb')].map(t=>({src:new URL(t.querySelector('img')?.src||'',location.href).pathname,label:t.querySelector('span')?.textContent}));
   const request=StudioStageOne.request(n,'check-only');
   return {strip,refs:request.references.map(r=>new URL(r.url,location.href).pathname),prompt:request.prompt};
  });
  await check('26 before reordering, thumbnails and request agree',async()=>{
   const s=await state();
   assert.deepEqual(s.strip.map(t=>t.src),[PERSON,SCENE]);assert.deepEqual(s.refs,[PERSON,SCENE]);
   assert.deepEqual(s.strip.map(t=>t.label),['参考1','参考2']);
   assert.equal(s.prompt,'让参考1中的人物站在参考2的场景里');
  });
  await check('26 after moving the scene first, every place agrees on which image is which',async()=>{
   // The same change the panel's move-down button makes on the first reference.
   await page.evaluate(()=>{const n=nodes.find(x=>x.id==='gen');const urls=StudioStageOne.request(n,'x').references.map(r=>r.url);
    n.studioRefOrder=[urls[1],urls[0]];refreshGeneratorInputViews?.();});
   await delay(300);
   const s=await state();
   assert.deepEqual(s.refs,[SCENE,PERSON],'request order');
   assert.deepEqual(s.strip.map(t=>t.src),[SCENE,PERSON],'thumbnail order '+JSON.stringify(s.strip));
   assert.deepEqual(s.strip.map(t=>t.label),['参考2','参考1'],'thumbnail labels must keep each image\'s identity');
   assert.equal(s.prompt,'让参考2中的人物站在参考1的场景里','the sent prompt must still point at the person: '+s.prompt);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
