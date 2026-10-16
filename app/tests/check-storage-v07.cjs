const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const base='http://127.0.0.1:3873',browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 const fixture=await(await page.request.get(base+'/test/storage-fixture')).json();
 const original=await(await page.request.get(base+fixture.asset_url)).body();
 await page.goto(base+'/settings');
 await page.locator('[data-tab=general]').click();
 await page.locator('#studioStorageProject option').first().waitFor({state:'attached'});
 await page.locator('#studioStorageDefault').fill(fixture.default_root);
 await page.locator('#studioStorageSaveDefault').click();
 await page.getByText('默认位置已保存，已有项目未移动。',{exact:true}).waitFor();
 await page.locator('#studioStorageProject').selectOption('default');
 await page.locator('#studioStoragePath').fill(fixture.destination);
 await page.locator('#studioStorageApply').click();
 await page.getByText('项目保存位置已更新，原文件保留。',{exact:true}).waitFor();
 const current=await(await page.request.get(base+'/api/studio/storage')).json();
 assert.equal(current.projects.find(p=>p.project_id==='default').path,fixture.destination);
 assert.deepEqual(await(await page.request.get(base+fixture.asset_url)).body(),original);
 await page.reload();await page.locator('[data-tab=general]').click();
 await page.waitForFunction(p=>document.querySelector('#studioStoragePath')?.value===p,fixture.destination);
 fs.mkdirSync('test-output/channels-storage-v0.7',{recursive:true});
 await page.screenshot({path:'test-output/channels-storage-v0.7/storage.png'});
 await page.goto(base+'/static/studio-assets.html?project_id=default');
 await page.getByText('项目保存位置',{exact:true}).click();
 await page.waitForFunction(p=>document.querySelector('#studioStoragePath')?.value===p,fixture.destination);
 assert.deepEqual(errors,[]);
 console.log('PASS default location/project migration/stable asset URL/reload/asset settings; no model requests');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
