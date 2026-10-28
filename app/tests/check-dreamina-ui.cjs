const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const base='http://127.0.0.1:3873',browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],calls=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
  let cfg={enabled:false,cli_path:'C:\\tools\\dreamina.exe',models:{'dreamina-image-5.0':true}};
  let status={available:true,enabled:false,authenticated:false,account:null,credit:null,error:null,models:[
   {id:'dreamina-image-5.0',name:'即梦图像 5.0',series:'即梦图像',kind:'image',enabled:true,modes:['text2image'],versions:['5.0']},
   {id:'dreamina-video-seedance-2.5',name:'Seedance 2.5',series:'Seedance',kind:'video',enabled:false,modes:['text2video'],versions:['seedance2.5']}
  ]};
  await page.route('**/api/studio/dreamina/**',async route=>{
   const url=new URL(route.request().url()),method=route.request().method();calls.push(`${method} ${url.pathname}`);
   if(url.pathname.endsWith('/status'))return route.fulfill({json:status});
   if(url.pathname.endsWith('/config')&&method==='GET')return route.fulfill({json:cfg});
   if(url.pathname.endsWith('/config')&&method==='PUT'){cfg=route.request().postDataJSON();status={...status,enabled:cfg.enabled,models:status.models.map(m=>({...m,enabled:cfg.models[m.id]??m.enabled}))};return route.fulfill({json:cfg});}
   if(url.pathname.endsWith('/login'))return route.fulfill({json:{login_id:'mock-login',verification_uri:'https://example.invalid/authorize',user_code:'MOCK-1234',expires_in:600}});
   if(url.pathname.endsWith('/login-check'))return route.fulfill({json:{authenticated:false,complete:false,message:'等待演示授权'}});
   return route.fulfill({status:404,json:{detail:'not found'}});
  });
  await page.goto(base+'/settings');
  await page.getByRole('tab',{name:'即梦账号',exact:true}).click();
  await page.getByLabel('即梦程序路径').waitFor();
  await page.getByText('Seedance 2.5',{exact:true}).waitFor();
  assert.match(await page.locator('#dreaminaCredit').innerText(),/积分状态待连接/);
  await page.getByLabel('启用即梦通道').check();
  await page.waitForFunction(()=>document.querySelector('#dreaminaStatus span:last-child')?.textContent==='未授权');
  assert.equal(cfg.enabled,true);
  const seedance=page.getByRole('checkbox',{name:'启用即梦模型 Seedance 2.5'});
  await seedance.check();
  assert.equal(cfg.models['dreamina-video-seedance-2.5'],true);
  await page.getByRole('button',{name:'开始授权登录'}).click();
  await page.getByText('MOCK-1234',{exact:true}).waitFor();
  await page.getByRole('button',{name:'取消本次授权'}).click();
  assert(calls.some(x=>x==='PUT /api/studio/dreamina/config'));
  assert(calls.some(x=>x==='POST /api/studio/dreamina/login'));
  assert.deepEqual(errors,[]);
  console.log('PASS Dreamina settings tab/status/model enable/login UI; all provider traffic mocked locally');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
