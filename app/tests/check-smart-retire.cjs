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
  const bar=page.locator('#studioSmartRetire'),badge=page.locator('.studio-smart-retire-badge');
  const openPanel=async()=>{if(!(await bar.evaluate(b=>b.matches(':popover-open'))))await badge.click();await bar.waitFor();};
  await check('the old canvas says it is retired, in the title line, and stays usable',async()=>{
   await badge.waitFor();assert.match(await badge.innerText(),/已停止新建/);
   assert(await badge.evaluate(b=>Boolean(b.closest('.sv2-header'))),'the badge is not in the header');
   await openPanel();assert.match(await bar.innerText(),/已停止新建/);assert.equal(await badge.getAttribute('aria-expanded'),'true');
   await bar.getByRole('button',{name:'收起提示'}).click();await bar.waitFor({state:'hidden'});
   assert.equal(await page.evaluate(()=>nodes.length),2);
  });
  await check('the notice never covers the canvas or the page controls',async()=>{
   for(const [width,height] of [[1440,900],[1024,700],[768,900],[320,700]]){
    await page.setViewportSize({width,height});await delay(400);
    const report=await page.evaluate(()=>{const box=document.querySelector('.studio-smart-retire-badge').getBoundingClientRect(),header=document.querySelector('.sv2-header').getBoundingClientRect();
     const hits=[...document.querySelectorAll('button,summary,a[href],input,select,[role=button]')].filter(el=>!el.matches('.studio-smart-retire-badge')&&!el.closest('#studioSmartRetire,#world,.smart-node,.node')&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')
      .filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.left<box.right&&r.right>box.left&&r.top<box.bottom&&r.bottom>box.top;})
      .map(el=>(el.className||el.tagName)+':'+(el.getAttribute('aria-label')||el.textContent.trim().slice(0,10)));
     return {hits,inHeader:box.top>=header.top&&box.bottom<=header.bottom&&box.right<=innerWidth,height:header.height,panelOpen:document.getElementById('studioSmartRetire').matches(':popover-open')};});
    assert.deepEqual(report.hits,[],`${width}x${height} badge covers ${JSON.stringify(report.hits)}`);
    assert(report.inHeader,`${width}x${height} badge is outside the header`);assert.equal(report.panelOpen,false,'the panel opened by itself');
   }
   await page.setViewportSize({width:1500,height:1000});await delay(300);
  });
  await check('a save that did not go through stops the migration',async()=>{
   const before=(await h.api('/api/canvases')).canvases?.length;let migrations=0;
   page.on('request',r=>{if(r.url().includes('/migrate-classic'))migrations++;});
   await page.evaluate(()=>{window.__realSave=saveCanvas;window.saveCanvas=async()=>({ok:false,code:'conflict',error:'外部修改与未保存内容冲突（模拟）'});});
   await openPanel();await bar.getByRole('button',{name:'迁移到经典画布'}).click();
   await page.waitForFunction(()=>/还没保存好/.test(document.querySelector('#studioSmartRetire [data-result]')?.textContent||''));
   assert.match(await bar.innerText(),/冲突（模拟）/);assert.equal(migrations,0,'migration ran on an unsaved canvas');
   if(before!==undefined)assert.equal((await h.api('/api/canvases')).canvases.length,before);
   await page.evaluate(()=>{window.saveCanvas=window.__realSave;});
  });
  await check('migrating makes a classic copy and leaves the original unchanged',async()=>{
   // What the page itself saved is the original; migration must not change it any further.
   await page.evaluate(()=>saveCanvas());await delay(800);const saved=JSON.stringify((await h.api('/api/canvases/'+old.id)).canvas.nodes);
   await openPanel();await bar.getByRole('button',{name:'迁移到经典画布'}).click();
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
  await check('clicking the canvas closes the panel',async()=>{
   await openPanel();await page.mouse.click(700,500);await bar.waitFor({state:'hidden'});
   assert.equal(await badge.getAttribute('aria-expanded'),'false');
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
