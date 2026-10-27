/* REF-01 (2026-10-26 review): delete, undo, replace and old data keep every "参考N" on the intended file.
   Real classic canvas page and temporary storage; nothing is generated. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const PERSON='/static/design-review/assets/character-v1.png',SCENE='/static/design-review/assets/scene-v1.png';
const TEXT='让参考1中的人物站在参考2的场景里';
async function main(){
 const h=await start('ref-identity');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 const canvasWith=async(title,gen)=>{
  const created=(await h.api('/api/canvases','POST',{title,kind:'classic'})).canvas;
  const nodes=[{id:'person',type:'image',x:80,y:80,url:PERSON,name:'人物'},{id:'scene',type:'image',x:80,y:380,url:SCENE,name:'场景'},
   {id:'p1',type:'prompt',x:420,y:80,text:TEXT},{id:'gen',type:'generator',x:820,y:120,...gen}];
  await h.api('/api/canvases/'+created.id,'PUT',{title,icon:'layers',nodes,connections:[{id:'c1',from:'person',to:'gen'},{id:'c2',from:'scene',to:'gen'},{id:'c3',from:'p1',to:'gen'}],viewport:{x:0,y:0,scale:1},logs:[],settings:{},base_updated_at:created.updated_at,client_id:'fixture'});
  return created.id;
 };
 const open=async(page,id)=>{
  await page.goto(h.base+'/static/canvas.html?id='+id);
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioStageOne);await delay(1200);
 };
 const state=page=>page.evaluate(()=>{
  const n=nodes.find(x=>x.id==='gen'),r=StudioStageOne.request(n,'check-only');
  return {refs:r.references.map(x=>new URL(x.url,location.href).pathname),labels:r.references.map(x=>x.label),prompt:r.prompt,error:StudioStageOne.submissionError(n)};
 });
 const clickRow=(page,src,action)=>page.evaluate(([src,action])=>{
  const row=[...document.querySelectorAll('.node[data-id="gen"] .studio-ref-list > *')].find(el=>new URL(el.querySelector('img')?.src||'',location.href).pathname===src);
  if(!row)throw Error('reference row not found for '+src);row.querySelector(action).click();
 },[src,action]);
 try{
  const page=await h.newPage();await open(page,await canvasWith('ref identity',{}));
  await check('baseline: 参考1 is the person and 参考2 the scene',async()=>{
   const s=await state(page);assert.deepEqual(s.refs,[PERSON,SCENE]);assert.deepEqual(s.labels,['参考1','参考2']);assert.equal(s.prompt,TEXT);assert.equal(s.error,'');
  });
  await check('deleting the person blocks sending instead of pointing 参考1 at the scene',async()=>{
   await clickRow(page,PERSON,'[data-remove]');await delay(400);
   const s=await state(page);
   assert.deepEqual(s.refs,[SCENE]);assert.deepEqual(s.labels,['参考2']);
   assert(!/参考1中的人物站在参考1/.test(s.prompt),'both phrases now name the scene: '+s.prompt);
   assert.match(s.error,/参考1/,'no blocking error: '+JSON.stringify(s));
   assert(await page.evaluate(()=>document.querySelector('.node[data-id="gen"] .gen-btn')?.disabled),'generate button stays enabled');
  });
  await check('undo restores the person and its number',async()=>{
   await page.evaluate(()=>performUndo());await delay(500);
   const s=await state(page);assert.deepEqual(s.refs,[PERSON,SCENE]);assert.deepEqual(s.labels,['参考1','参考2']);assert.equal(s.error,'');assert.equal(s.prompt,TEXT);
  });
  await check('replacing the person inherits 参考1 and its place',async()=>{
   const png=fs.readFileSync(path.join(__dirname,'../static/design-review/assets/character-v1.png'));
   const chooser=page.waitForEvent('filechooser');await clickRow(page,PERSON,'[data-replace]');
   await (await chooser).setFiles({name:'new-person.png',mimeType:'image/png',buffer:png});
   await page.waitForFunction(p=>StudioStageOne.request(nodes.find(x=>x.id==='gen'),'x').references[0]?.url!==p,PERSON,{timeout:8000}).catch(()=>{});
   const s=await state(page);
   assert.notEqual(s.refs[0],PERSON,'person was not replaced: '+JSON.stringify(s.refs));assert.equal(s.refs[1],SCENE);
   assert.deepEqual(s.labels,['参考1','参考2'],'labels after replace');assert.equal(s.prompt,TEXT);assert.equal(s.error,'');
  });
  await check('after saving and reopening, the replaced reference is still 参考1',async()=>{
   const before=await state(page);
   await page.evaluate(()=>saveCanvas());await delay(800);await page.reload();
   await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioStageOne);await delay(1200);
   const s=await state(page);assert.deepEqual(s.refs,before.refs);assert.deepEqual(s.labels,['参考1','参考2']);assert.equal(s.prompt,TEXT);
  });
  // Old canvases saved before stable numbers: "参考N" meant the Nth reference in the order shown then.
  const old=await h.newPage();await open(old,await canvasWith('old order',{studioRefOrder:[SCENE,PERSON]}));
  await check('old data keeps its saved meaning and survives a later reorder',async()=>{
   let s=await state(old);assert.deepEqual(s.refs,[SCENE,PERSON]);assert.deepEqual(s.labels,['参考1','参考2']);assert.equal(s.prompt,TEXT);
   await old.evaluate(([a,b])=>{const n=nodes.find(x=>x.id==='gen');n.studioRefOrder=[a,b];refreshGeneratorInputViews?.();},[PERSON,SCENE]);await delay(300);
   s=await state(old);assert.deepEqual(s.refs,[PERSON,SCENE]);assert.deepEqual(s.labels,['参考2','参考1']);
   assert.equal(s.prompt,'让参考2中的人物站在参考1的场景里','after reorder the text must still name the scene first: '+s.prompt);
  });
  await check('plain text such as 图1 is not treated as a bound reference',async()=>{
   await old.evaluate(()=>{const p=nodes.find(x=>x.id==='p1');p.text='参考1的场景，图1风格';});
   const s=await state(old);assert.equal(s.prompt,'参考2的场景，图1风格');assert.equal(s.error,'');
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
