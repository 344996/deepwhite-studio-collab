/* CLIENT-01/03/04 in the real settings page: real service, temporary user profile, no real client files. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dw-client-home-'));
 for(const folder of ['.claude','.codex','Local/hermes','Roaming'])fs.mkdirSync(path.join(home,folder),{recursive:true});
 fs.writeFileSync(path.join(home,'Local/hermes/config.yaml'),Buffer.from('model: \xff\xfe\x80 broken\n','latin1'));
 Object.assign(process.env,{USERPROFILE:home,HOME:home,APPDATA:path.join(home,'Roaming'),LOCALAPPDATA:path.join(home,'Local'),
  CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:'',HERMES_HOME:''});
 const h=await start('client-cards');
 try{
  const page=await h.newPage();
  await page.goto(h.base+'/static/studio-settings.html');
  // Install through the settings page itself (the endpoint only accepts this page's origin).
  const installed=await page.evaluate(async()=>(await fetch('/api/studio/clients/claude_code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'install_skills'})})).json());
  assert(installed.message.includes(path.join(home,'.claude','skills')),installed.message);
  fs.unlinkSync(path.join(home,'.claude/skills/deepwhite-canvas/SKILL.md'));
  await page.reload();
  await page.locator('[data-tab="control"]').click();
  await page.locator('.client-card[data-client="claude_code"]').waitFor();
  const card=page.locator('.client-card[data-client="claude_code"]');
  assert.match(await card.innerText(),/文件缺失 · 需修复/);
  assert.match(await card.innerText(),new RegExp('Skills 位置：'+path.join(home,'.claude','skills').replace(/[\\^$.*+?()[\]{}|]/g,'\\$&')));
  assert.equal(await page.locator('.client-card').count(),6,'a broken client hid the others');
  assert.match(await page.locator('.client-card[data-client="hermes"]').innerText(),/UTF-8/);
  await card.getByRole('button',{name:'修复 Skills'}).click();
  await page.waitForFunction(()=>/最新 v/.test(document.querySelector('.client-card[data-client="claude_code"]')?.innerText||'')&&!/文件缺失/.test(document.querySelector('.client-card[data-client="claude_code"]').innerText));
  assert(fs.existsSync(path.join(home,'.claude/skills/deepwhite-canvas/SKILL.md')));
  console.log('PASS damaged Skill is shown with its target path and repaired from the card; a broken Hermes file stays on its own card');
  await page.setViewportSize({width:375,height:812});await delay(200);
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('.client-card')].filter(c=>c.scrollWidth>c.clientWidth+1).map(c=>c.dataset.client));
  assert.deepEqual(overflow,[],'cards overflow at phone width');
  console.log('PASS long paths wrap inside the cards at 375px');
  assert.deepEqual(h.errors,[]);
 }finally{await h.stop();fs.rmSync(home,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exit(1);});
