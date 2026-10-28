/* U01 (handover 2026-10-26): logged in but without generation authorisation must be obvious and
   fixable from Settings, not hidden behind "请先填写 API Key". The account API is mocked in the
   browser; no login, token or generation happens. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('account-authorization');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const page=await h.newPage();
  let state={status:'action_required',message:'账户已登录，官方 API 尚未完成配置。点击重新连接可重试。',retryable:true},provisions=0,succeed=false;
  await page.route('**/api/studio/account',route=>route.fulfill({json:{username:'tester',generation:state}}));
  await page.route('**/api/studio/account/provision',route=>{provisions++;if(succeed)state={status:'ready',message:'已连接官方 API，可以直接生成。',provider_id:'deepwhite-account-1'};
   return route.fulfill({status:succeed?200:409,json:succeed?{generation:state}:{detail:'令牌接口拒绝了请求（模拟）'}});});
  await page.goto(h.base+'/static/studio-settings.html');
  const card=page.locator('#settingsAccountConnection');
  await check('a missing authorisation is shown as a warning with a fix',async()=>{
   await page.waitForFunction(()=>/授权未完成/.test(document.getElementById('settingsAccountConnection')?.innerText||''),null,{timeout:8000});
   assert.equal(await card.getAttribute('data-tone'),'warn');
   assert.equal(await card.getByRole('button',{name:'重新授权'}).count(),1);
  });
  await check('Settings tries the authorisation once by itself, and says why it failed',async()=>{
   await delay(800);assert.equal(provisions,1);
   assert.match(await card.innerText(),/令牌接口拒绝了请求/,await card.evaluate(c=>c.innerHTML+' :: '+[...c.children].map(x=>x.tagName+':'+getComputedStyle(x).display).join(',')));
  });
  await check('a successful retry says no API Key is needed',async()=>{
   succeed=true;await card.getByRole('button',{name:'重新授权'}).click();
   await page.waitForFunction(()=>/无需填写 API Key/.test(document.getElementById('settingsAccountConnection')?.innerText||''),null,{timeout:8000});
   assert.notEqual(await card.getAttribute('data-tone'),'warn');
  });
  await check('reloading does not retry again in the same session once it worked',async()=>{
   const before=provisions;await page.reload();await delay(1200);assert.equal(provisions,before);
  });
  assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
