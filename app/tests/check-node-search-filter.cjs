/* UX04 (handover 2026-10-26, section 8): find nodes by name and by type, then locate the choice.
   Real classic canvas page and temporary storage; nothing is generated. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('node-search-filter');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const created=(await h.api('/api/canvases','POST',{title:'search filter',kind:'classic'})).canvas;
  const nodes=[{id:'p',type:'prompt',x:0,y:0,text:'雨夜站台 剧本'},{id:'g',type:'generator',x:600,y:0,studioTitle:'雨夜 人物图'},
   {id:'v',type:'video',x:1200,y:0,studioTitle:'雨夜 视频'},{id:'far',type:'video',x:9000,y:7000,studioTitle:'远处的雨夜镜头'}];
  await h.api('/api/canvases/'+created.id,'PUT',{title:'search filter',icon:'layers',nodes,connections:[],viewport:{x:0,y:0,scale:1},logs:[],settings:{},base_updated_at:created.updated_at,client_id:'fixture'});
  const page=await h.newPage();
  await page.goto(h.base+'/static/canvas.html?id='+created.id);
  await page.waitForFunction(()=>window.StudioCanvasV2?.ready&&nodes.length===4);await delay(600);
  const results=()=>page.locator('.v2-search-dialog .v2-search-result strong').allInnerTexts();
  await page.keyboard.press('Control+k');await page.locator('.v2-search-dialog input[type="search"]').fill('雨夜');await delay(200);
  await check('name search lists every match',async()=>{assert.equal((await results()).length,4);});
  await check('a type filter narrows the matches to that type',async()=>{
   const filter=page.locator('.v2-search-dialog select[aria-label="按类型筛选"]');
   assert.equal(await filter.count(),1,'no type filter in the search dialog');
   await filter.selectOption('video');await delay(150);
   assert.deepEqual((await results()).sort(),['远处的雨夜镜头','雨夜 视频'].sort());
   await filter.selectOption('prompt');await delay(150);
   assert.equal((await results()).length,1);
  });
  await check('choosing a far result selects it and brings it on screen',async()=>{
   await page.locator('.v2-search-dialog select[aria-label="按类型筛选"]').selectOption('video');await delay(150);
   await page.locator('.v2-search-dialog .v2-search-result',{hasText:'远处的雨夜镜头'}).click();await delay(900);
   const r=await page.evaluate(()=>{const b=document.querySelector('.node[data-id="far"]').getBoundingClientRect();return {selected:[...selected],inView:b.right>0&&b.left<innerWidth&&b.bottom>0&&b.top<innerHeight};});
   assert.deepEqual(r.selected,['far']);assert(r.inView,'the chosen node is off screen');
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
