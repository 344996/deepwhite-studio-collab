const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
 const browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {})});
 try {
  const page=await browser.newPage(),errors=[];let registration=null,verificationRequested=false,login=null,loginFails=false,loggedIn=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<div id="quickToolbar"><div class="toolbar-fixed"></div></div><div class="home-wallet"><strong></strong><p></p><button id="homeApi"></button></div>'});
   if(url.pathname==='/api/studio/account/login'){login=route.request().postDataJSON();if(loginFails)return route.fulfill({status:400,json:{detail:'网站暂时拒绝登录。'}});loggedIn=true;return route.fulfill({json:{ok:true,two_factor:false,generation:{status:'ready'}}})}
   if(url.pathname==='/api/studio/account')return loggedIn?route.fulfill({json:{username:'sample_user',balance:1,symbol:'¥',generation:{status:'ready',message:'官方 API 和模型已自动配置，可以回到画布生成。'}}}):route.fulfill({status:401,json:{detail:'请登录'}});
   if(url.pathname==='/api/studio/channel-balances')return route.fulfill({json:{items:[]}});
   if(url.pathname==='/api/studio/account/capabilities')return route.fulfill({json:{registration_available:true,register_enabled:true,password_register_enabled:true,email_verification:true,turnstile_check:false,user_agreement_enabled:true,privacy_policy_enabled:true}});
   if(url.pathname==='/api/studio/account/verification'){verificationRequested=url.searchParams.get('email')==='person@example.test';return route.fulfill({json:{ok:true,retry_after:60,message:'验证码已发送，请查收邮件。'}})}
   if(url.pathname==='/api/studio/account/register'){registration=route.request().postDataJSON();return route.fulfill({json:{ok:true,message:'账号已创建，请使用新账号登录。'}})}
   return route.fulfill({status:404,json:{detail:'unexpected local request'}});
  });
  await page.goto('http://studio.test/');
  await page.addScriptTag({path:path.join(__dirname,'..','static','studio-account-skills.js')});
  await page.getByRole('button',{name:'登录 / 注册'}).click();
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
  // U01: a new account logs in and configures the official API by itself, with nothing to retype.
  await page.locator('[data-generation-status=ready]').waitFor({timeout:5000});
  assert.match(await page.locator('.dw-library').innerText(),/官方 API 已连接/);
  assert.deepEqual(login,{username:registration.username,password:registration.password});
  assert.equal(registration.username,'sample_user');assert.equal(registration.verification_code,'123456');
  assert.equal(registration.agree_terms,true);assert.equal(registration.agree_privacy,true);
  // If that login is refused the account still exists: the login form says so and keeps the username.
  loggedIn=false;loginFails=true;await page.goto('http://studio.test/');await page.addScriptTag({path:path.join(__dirname,'..','static','studio-account-skills.js')});
  await page.getByRole('button',{name:'登录 / 注册'}).click();await page.getByRole('button',{name:'创建 API 账户'}).click();
  await page.locator('[name=username]').fill('second_user');await page.locator('[name=password]').fill('LocalFixture123');await page.locator('[name=confirm_password]').fill('LocalFixture123');
  await page.locator('[name=email]').fill('person@example.test');await page.locator('[name=verification_code]').fill('123456');
  await page.locator('[name=agree_terms]').check();await page.locator('[name=agree_privacy]').check();
  await page.getByRole('button',{name:'创建账户',exact:true}).click();
  await page.locator('[name=confirm_password]').waitFor({state:'detached',timeout:5000});
  assert.match(await page.locator('.dw-library').innerText(),/账号已创建，但自动登录没有完成：网站暂时拒绝登录/);
  assert.equal(await page.locator('.dw-library form [name=username]').inputValue(),'second_user');assert.equal(await page.locator('.dw-library form [name=password]').inputValue(),'');
  assert.deepEqual(errors,[]);
  console.log('PASS mocked account registration form, email verification request, agreements, automatic login and setup after creation, and the fallback when that login is refused; no upstream calls');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
