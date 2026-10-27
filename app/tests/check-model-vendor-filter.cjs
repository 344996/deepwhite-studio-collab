/* U05 (handover 2026-10-26): the model manager filters by type × vendor × keyword, and bulk
   enable/disable touches only the filtered models, saying how many. Offline catalogue. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('model-vendor-filter');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  await h.api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'Offline fixture',base_url:'https://api.deepwhiteai.com/v1',api_key:'offline-vendor',enabled:true,primary:true});
  const page=await h.newPage();
  await page.goto(h.base+'/static/studio-settings.html');
  await page.locator('[data-tab="models"]').click();await page.locator('#modelRows .model-row').first().waitFor();
  const rows=()=>page.locator('#modelRows .model-row small').allInnerTexts();
  const vendor=page.locator('#modelVendor');
  let picked='';
  await check('a vendor filter lists the catalogue vendors',async()=>{
   const options=await vendor.locator('option').allInnerTexts();
   assert.equal(options[0],'全部厂商');assert(options.length>2,'only '+options.length+' vendor options');
   picked=options.find(o=>o!=='全部厂商'&&o!=='未分类');
  });
  await check('choosing a vendor shows only its models, combined with type',async()=>{
   await vendor.selectOption(picked);await delay(150);
   const shown=await rows();assert(shown.length>0);assert(shown.every(t=>t.includes(picked)),JSON.stringify(shown.slice(0,3)));
   await page.locator('#modelFilter').selectOption('image');await delay(150);
   assert((await rows()).every(t=>t.startsWith('图片')&&t.includes(picked)));
  });
  await check('bulk disable names the count and leaves hidden models alone',async()=>{
   const shown=(await rows()).length;
   assert.equal(await page.locator('#disableVisible').innerText(),`停用当前筛选（${shown}）`);
   const before=(await h.api('/api/studio/model-catalog')).providers.deepwhite.models;
   await page.locator('#disableVisible').click();await delay(800);
   const after=(await h.api('/api/studio/model-catalog')).providers.deepwhite.models;
   const changed=after.filter(m=>before.find(b=>b.id===m.id)?.enabled!==m.enabled);
   assert.equal(changed.length,shown,'disabled '+changed.length+' instead of '+shown);
   assert(changed.every(m=>m.kind==='image'),'a model outside the filter changed');
  });
  await check('an empty result disables the bulk buttons',async()=>{
   await page.locator('#modelSearch').fill('不存在的模型名');await delay(150);
   assert.equal(await page.locator('#enableVisible').isDisabled(),true);
   assert.match(await page.locator('#modelRows').innerText(),/没有匹配/);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
