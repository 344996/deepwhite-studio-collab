/* U11 (handover 2026-10-26) and CLIENT-03 in the real settings page: real service, temporary user
   profile, no real client files. Five agent cards, no Skills, and "verified" only after the agent's
   own read-only call reaches the studio. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dw-client-home-'));
 for(const folder of ['.claude','.codex','.workbuddy','Roaming'])fs.mkdirSync(path.join(home,folder),{recursive:true});
 fs.writeFileSync(path.join(home,'.workbuddy/mcp.json'),Buffer.from('{"model": "\xff\xfe\x80 broken"}','latin1'));
 Object.assign(process.env,{USERPROFILE:home,HOME:home,APPDATA:path.join(home,'Roaming'),LOCALAPPDATA:path.join(home,'Local'),
  CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:'',HERMES_HOME:''});
 const h=await start('client-cards');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const page=await h.newPage();
  await page.goto(h.base+'/static/studio-settings.html');
  await page.locator('[data-tab="control"]').click();
  await page.locator('.client-card[data-client="claude_code"]').waitFor();
  const card=id=>page.locator(`.client-card[data-client="${id}"]`);
  await check('exactly the five agents, and no Skills anywhere on the page',async()=>{
   assert.deepEqual(await page.locator('.client-card').evaluateAll(cards=>cards.map(c=>c.dataset.client)),['codex','claude_code','workbuddy','doubao','deepseek_harness']);
   assert.equal(await page.locator('#controlStepCodex').getByText(/Skill/).count(),0,'Skills are still shown');
   assert.match(await card('deepseek_harness').innerText(),/不支持自动检测/);
  });
  await check('a broken client file stays on its own card',async()=>{
   assert.match(await card('workbuddy').innerText(),/JSON/);assert.match(await card('claude_code').innerText(),/一键连接/);
  });
  let code='';
  await check('one-click connect writes the config and says it still needs verifying',async()=>{
   await card('claude_code').getByRole('button',{name:'一键连接'}).click();
   await page.waitForFunction(()=>/待验证/.test(document.querySelector('.client-card[data-client="claude_code"]')?.innerText||''));
   assert(fs.existsSync(path.join(home,'.claude.json')));
   await page.context().grantPermissions(['clipboard-read','clipboard-write']);
   await card('claude_code').getByRole('button',{name:'复制验证命令'}).click();await delay(200);
   const command=await page.evaluate(()=>navigator.clipboard.readText());
   code=(command.match(/DW-[0-9A-F]{6}/)||[''])[0];
   assert(code,'no code in the copied command: '+command);assert.match(command,/只读取/);assert.doesNotMatch(command,/sk-|Bearer|api[_-]?key/i);
  });
  await check('only the agent call with that code turns the card verified',async()=>{
   const token=JSON.parse(fs.readFileSync(path.join(h.runtime,'data','studio_control.json'),'utf8')).token;
   const r=await fetch(h.base+'/api/studio/control/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({name:'verify_client',arguments:{code}})});
   assert.equal(r.status,200,await r.text());
   await page.waitForFunction(()=>/已验证/.test(document.querySelector('.client-card[data-client="claude_code"]')?.innerText||''),null,{timeout:10000});
   assert.doesNotMatch(await card('codex').innerText(),/已验证/);
  });
  await check('cards fit a phone-width screen',async()=>{
   await page.setViewportSize({width:375,height:812});await delay(200);
   const overflow=await page.evaluate(()=>[...document.querySelectorAll('.client-card')].filter(c=>c.scrollWidth>c.clientWidth+1).map(c=>c.dataset.client));
   assert.deepEqual(overflow,[]);
  });
  assert.deepEqual(h.errors,[]);
 }finally{await h.stop();fs.rmSync(home,{recursive:true,force:true});}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
