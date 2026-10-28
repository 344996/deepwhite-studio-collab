/* U10 (handover 2026-10-26): no way to create a smart canvas from the home page; an old one says it
   is retired and can be copied to a classic canvas from its own page, leaving the original intact.
   Real pages and temporary storage; nothing is generated. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('smart-retire');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const old=await h.smartCanvas('旧版七码头',[{id:'p',type:'smart-prompt',title:'剧本',text:'林夏走进修表铺',x:80,y:80,w:320,h:220},
   {id:'img',type:'smart-image',title:'人物',x:480,y:80,images:[]}]);
  const home=await h.newPage();
  await home.goto(h.base+'/static/canvas-list.html');await home.waitForLoadState('networkidle');await delay(600);
  await check('the home create dialog only offers a classic canvas',async()=>{
   await home.locator('#newCanvasBtn').click();await delay(400);
   const kinds=await home.locator('.ws-create-toggle-btn').evaluateAll(b=>b.map(x=>x.dataset.kind));
   assert.deepEqual(kinds,['classic']);
   await home.keyboard.press('Escape');
  });
  await check('an old smart canvas is labelled as legacy on the home page',async()=>{
   assert(await home.getByText(/旧版智能/).count()>0,'no legacy label');
  });
  const page=await h.newPage();await h.openSmart(page,old.id);
  const bar=page.locator('#studioSmartRetire');
  await check('the old canvas explains it is retired and stays usable',async()=>{
   await bar.waitFor();assert.match(await bar.innerText(),/已停止新建/);
   assert.equal(await page.evaluate(()=>nodes.length),2);
  });
  await check('migrating makes a classic copy and leaves the original unchanged',async()=>{
   // What the page itself saved is the original; migration must not change it any further.
   await page.evaluate(()=>saveCanvas());await delay(800);const saved=JSON.stringify((await h.api('/api/canvases/'+old.id)).canvas.nodes);
   await bar.getByRole('button',{name:'迁移到经典画布'}).click();
   await page.locator('#studioSmartRetire .studio-smart-retire-open').waitFor({timeout:8000});
   const href=await page.locator('#studioSmartRetire .studio-smart-retire-open').getAttribute('href');
   const copyId=new URL(href,h.base).searchParams.get('id');
   const copy=(await h.api('/api/canvases/'+copyId)).canvas;
   assert.equal(copy.kind,'classic');assert.deepEqual(copy.nodes.map(n=>n.type).sort(),['generator','prompt']);
   assert.equal(copy.nodes.find(n=>n.id==='p').text,'林夏走进修表铺');
   assert.equal(JSON.stringify((await h.api('/api/canvases/'+old.id)).canvas.nodes),saved,'the original changed');
   const classic=await h.newPage();await classic.goto(h.base+href);
   await classic.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&nodes.length===2);
  });
  await check('the notice can be folded away',async()=>{
   await bar.getByRole('button',{name:'收起提示'}).click();await delay(100);
   assert.equal(await bar.locator('[data-migrate]').isVisible(),false);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
