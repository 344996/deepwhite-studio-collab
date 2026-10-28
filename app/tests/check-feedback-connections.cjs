const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[],base='http://127.0.0.1:3874';
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
  const storage={default_root:'D:\\Old',projects:[{project_id:'default',name:'测试项目',path:'D:\\Old\\Project',managed_versions:1}]};
  let pick,mutations=0;
  await page.route('**/api/studio/storage**',async r=>{
   const path=new URL(r.request().url()).pathname,method=r.request().method();
   if(path.endsWith('/pick-folder')){pick=r;return;}
   if(method==='PUT'){mutations++;const b=r.request().postDataJSON();if(path.endsWith('/default'))storage.projects[0].path=b.path;else storage.default_root=b.default_root;}
   return r.fulfill({json:storage});
  });
  let cfg={enabled:true,cli_path:'C:\\mock\\dreamina.exe',models:{}},authenticated=false,login=0,cancelled=0,loggedOut=0;
  await page.route('**/api/studio/dreamina/**',async r=>{
   const path=new URL(r.request().url()).pathname,method=r.request().method();
   if(path.endsWith('/config')){if(method==='PUT')cfg=r.request().postDataJSON();return r.fulfill({json:cfg});}
   if(path.endsWith('/status'))return r.fulfill({json:{available:true,enabled:cfg.enabled,authenticated,account:authenticated?'模拟账号':null,credit:authenticated?88:null,models:[]}});
   if(path.endsWith('/login'))return r.fulfill({json:{login_id:'mock-'+(++login),user_code:'MOCK-'+login,expires_in:600,verification_uri:'https://example.invalid'}});
   if(path.endsWith('/login-check'))return r.fulfill({json:{complete:authenticated,authenticated}});
   if(path.endsWith('/login-cancel')){cancelled++;return r.fulfill({json:{cancelled:true}});}
   if(path.endsWith('/logout')){loggedOut++;authenticated=false;return r.fulfill({json:{message:'已退出模拟账号'}});}
   return r.fulfill({status:404,json:{detail:'unexpected mock request'}});
  });
  await page.goto(base+'/settings');await page.locator('[data-tab=storage]').click();
  await page.waitForFunction(()=>document.querySelector('#studioStorageDefault').value==='D:\\Old');
  await page.locator('[data-pick=studioStorageDefault]').click();
  while(!pick)await page.waitForTimeout(20);
  assert(await page.locator('#studioStorageDefault').isEnabled());
  await pick.fulfill({json:{path:null}});pick=null;
  await page.getByText('已取消选择，保存位置未更改。',{exact:true}).waitFor();assert.equal(mutations,0);
  await page.locator('[data-pick=studioStorageDefault]').click();while(!pick)await page.waitForTimeout(20);
  await pick.fulfill({json:{path:'D:\\New'}});pick=null;
  await page.getByText('已选择并保存新项目默认位置。已有项目未移动。',{exact:true}).waitFor();assert.equal(storage.default_root,'D:\\New');
  page.once('dialog',d=>d.dismiss());await page.locator('[data-pick=studioStoragePath]').click();while(!pick)await page.waitForTimeout(20);
  await pick.fulfill({json:{path:'D:\\Rejected'}});pick=null;await page.getByText('已取消更改，原保存位置未变。',{exact:true}).waitFor();assert.equal(mutations,1);
  page.once('dialog',d=>d.accept());await page.locator('[data-pick=studioStoragePath]').click();while(!pick)await page.waitForTimeout(20);
  await pick.fulfill({json:{path:'D:\\Moved'}});await page.getByText('素材迁移完成，新目录已生效，原文件保留。',{exact:true}).waitFor();assert.equal(storage.projects[0].path,'D:\\Moved');
  await page.locator('[data-tab=dreamina]').click();await page.locator('#dreaminaConnect').click();await page.getByText('MOCK-1',{exact:true}).waitFor();
  await page.getByRole('button',{name:'取消本次授权',exact:true}).click();await page.getByText('本次授权轮询已取消。',{exact:true}).waitFor();assert.equal(cancelled,1);
  authenticated=true;await page.locator('#dreaminaRefresh').click();await page.getByText('88 即梦积分',{exact:true}).waitFor();
  await page.locator('#dreaminaLogout').click();await page.getByText('已退出模拟账号',{exact:true}).waitFor();assert.equal(loggedOut,1);
  await page.locator('#dreaminaConnect').click();await page.getByText('MOCK-2',{exact:true}).waitFor();
  await page.getByRole('button',{name:'取消本次授权',exact:true}).click();
  assert.deepEqual(errors,[]);console.log('PASS directory pending/cancel/autosave/migration confirmation and Dreamina cancel/logout/reauthorize UI; all actions mocked');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
