/* UX03 (handover 2026-10-26, section 8): the workflow workbench has favourites that are listed
   first, can be shown alone and survive a reload. The library list is stubbed in the browser (a real
   ComfyUI is not needed); favourites are saved through the real server. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const ITEMS=[{id:'wf-a',name:'人物换背景',revision:1,updated_at:3,fields:[],outputs:[],state:'ready'},
 {id:'wf-b',name:'线稿上色',revision:2,updated_at:2,fields:[],outputs:[],state:'ready'},
 {id:'wf-c',name:'高清放大',revision:1,updated_at:1,fields:[],outputs:[],state:'ready'}];
async function main(){
 const h=await start('workflow-favorites');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const created=(await h.api('/api/canvases','POST',{title:'workflows',kind:'classic'})).canvas;
  const page=await h.newPage();
  await page.route(/\/api\/studio\/comfy\/workflows(\?.*)?$/,route=>route.fulfill({json:{items:ITEMS}}));
  const open=async()=>{await page.goto(h.base+'/static/canvas.html?id='+created.id);await page.waitForFunction(()=>window.StudioWorkflows);await delay(600);
   await page.evaluate(()=>StudioWorkflows.open());await page.locator('.sw-item').first().waitFor();};
  // Bundled RH workflows are listed too; look only at the stubbed ComfyUI ones.
  const names=async()=>(await page.locator('.sw-item').evaluateAll(b=>b.map(x=>[x.dataset.workflowId,x.querySelector('strong').textContent]))).filter(([id])=>id.startsWith('wf-')).map(([,n])=>n);
  await open();
  await check('starring moves a workflow to the top',async()=>{
   await page.locator('.sw-item-row:has(.sw-item[data-workflow-id="wf-c"])').locator('.sw-star').click();await delay(200);
   assert.equal((await names())[0],'高清放大');
   assert.equal(await page.locator('.sw-item-row:has(.sw-item[data-workflow-id="wf-c"])').locator('.sw-star').getAttribute('aria-pressed'),'true');
  });
  await check('"只看收藏" shows only favourites, with guidance when there are none',async()=>{
   await page.locator('[data-scope-filter]').selectOption('fav');await delay(150);
   assert.deepEqual(await names(),['高清放大']);
  });
  await check('favourites survive a reload',async()=>{
   await open();assert.equal((await names())[0],'高清放大');
   assert.deepEqual((await h.api('/api/studio/model-favorites')).workflow,['comfy|wf-c']);
  });
  await check('an empty favourites view explains how to add one',async()=>{
   await page.locator('.sw-item-row:has(.sw-item[data-workflow-id="wf-c"])').locator('.sw-star').click();await delay(200);
   await page.locator('[data-scope-filter]').selectOption('fav');await delay(150);
   assert.match(await page.locator('[data-list]').innerText(),/还没有收藏/);
  });
  await check('a favourite the server refused is undone and explained',async()=>{
   await page.locator('[data-scope-filter]').selectOption('all');await delay(150);
   await page.route('**/api/studio/model-favorites/workflow',route=>route.fulfill({status:500,json:{detail:'磁盘已满（模拟）'}}));
   const star=page.locator('.sw-item-row:has(.sw-item[data-workflow-id="wf-a"])').locator('.sw-star');
   await star.click();
   await page.waitForFunction(()=>/收藏没有保存/.test(document.querySelector('.sw-footer-status [role=status]')?.textContent||''));
   await page.waitForFunction(()=>document.querySelector('.sw-item-row:has(.sw-item[data-workflow-id="wf-a"]) .sw-star')?.getAttribute('aria-pressed')==='false');
   await page.unroute('**/api/studio/model-favorites/workflow');
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
