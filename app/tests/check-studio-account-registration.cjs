const { chromium } = require('data/local-path');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
 const browser = await chromium.launch({headless:true,executablePath:'data/local-path'});
 try {
  const page=await browser.newPage(),errors=[];let registration=null,verificationRequested=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<div id="quickToolbar"><div class="toolbar-fixed"></div></div><div class="home-wallet"><strong></strong><p></p><button id="homeApi"></button></div>'});
   if(url.pathname==='/api/studio/account')return route.fulfill({status:401,json:{detail:'请登录'}});
   if(url.pathname==='/api/studio/channel-balances')return route.fulfill({json:{items:[]}});
   if(url.pathname==='/api/studio/account/capabilities')return route.fulfill({json:{registration_available:true,register_enabled:true,password_register_enabled:true,email_verification:true,turnstile_check:false,user_agreement_enabled:true,privacy_policy_enabled:true}});
   if(url.pathname==='/api/studio/account/verification'){verificationRequested=url.searchParams.get('email')==='person@example.test';return route.fulfill({json:{ok:true,retry_after:60,message:'验证码已发送，请查收邮件。'}})}
   if(url.pathname==='/api/studio/account/register'){registration=route.request().postDataJSON();return route.fulfill({json:{ok:true,message:'账号已创建，请使用新账号登录。'}})}
   return route.fulfill({status:404,json:{detail:'unexpected local request'}});
  });
  await page.goto('http://studio.test/');
  await page.addScriptTag({path:path.resolve('app/static/studio-account-skills.js')});
  await page.getByRole('button',{name:'登录 / 账户'}).click();
  await page.getByRole('button',{name:'创建 API 账户'}).click();
  await page.locator('[name=confirm_password]').waitFor();
  await page.locator('[name=username]').fill('sample_user');
  await page.locator('[name=password]').fill('password123');
  await page.locator('[name=confirm_password]').fill('password123');
  await page.locator('[name=email]').fill('person@example.test');
  await page.getByRole('button',{name:'发送验证码'}).click();
  assert.equal(verificationRequested,true);
  await page.locator('[name=verification_code]').fill('123456');
  await page.locator('[name=agree_terms]').check();await page.locator('[name=agree_privacy]').check();
  await page.getByRole('button',{name:'创建账户',exact:true}).click();
  await page.locator('[name=confirm_password]').waitFor({state:'detached',timeout:5000});
  assert.match(await page.locator('.dw-library').innerText(),/账号已创建/);
  assert.equal(await page.locator('.dw-library form button[type=submit]').innerText(),'登录');
  assert.equal(registration.username,'sample_user');assert.equal(registration.verification_code,'123456');
  assert.equal(registration.agree_terms,true);assert.equal(registration.agree_privacy,true);assert.deepEqual(errors,[]);
  console.log('PASS mocked account registration form, email verification request, agreements and success-to-login transition; no upstream calls');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
