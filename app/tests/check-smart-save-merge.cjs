/* SAVE-01: a 409 merge on the smart canvas must keep unsaved handwritten text and never report a silent success. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const prompt=(id,text,x)=>({id,type:'smart-prompt',title:'提示词',text,x,y:100,w:320,h:220});
async function main(){
 const h=await start('smart-save-merge');
 try{
  const page=await h.newPage();
  await page.addInitScript(()=>{window.__saveStates=[];addEventListener('studio-save-state',e=>window.__saveStates.push({ok:e.detail.ok,code:e.detail.code}));});
  const readServer=async id=>(await h.api('/api/canvases/'+id)).canvas;
  // External writers (another window or MCP) save with the current revision, exactly like the control API.
  const externalEdit=async(id,edit)=>{const c=await readServer(id);edit(c.nodes);await h.api('/api/canvases/'+id,'PUT',{title:c.title,icon:c.icon,nodes:c.nodes,connections:c.connections,viewport:c.viewport,logs:c.logs||[],settings:c.settings||{},base_updated_at:c.updated_at,client_id:'external-window'});};
  const typeLocal=text=>page.evaluate(t=>{const n=nodes.find(n=>n.id==='p1');n.text=t;clearTimeout(saveTimer);saveTimer=null;},text);
  const settle=async()=>{await page.evaluate(()=>saveCanvas());await delay(1500);};

  // A: different fields changed on each side; both survive the merge and the retry.
  const a=await h.smartCanvas('SAVE-01 A',[prompt('p1','original',80),prompt('p2','second',480)]);
  await h.openSmart(page,a.id);
  await typeLocal('UNSAVED USER TEXT');
  await externalEdit(a.id,list=>{list.find(n=>n.id==='p2').title='外部标题';});
  await delay(600);
  await settle();
  let server=await readServer(a.id);
  assert.equal(server.nodes.find(n=>n.id==='p1').text,'UNSAVED USER TEXT','handwritten text was replaced by the remote copy');
  assert.equal(server.nodes.find(n=>n.id==='p2').title,'外部标题','remote change was lost');
  assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='p1').text),'UNSAVED USER TEXT');
  await page.reload();await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioSave);
  assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='p1').text),'UNSAVED USER TEXT','text missing after reopen');
  console.log('PASS A unsaved text and a remote edit to another field both survive the 409 retry');

  // B: the same field changed on both sides; nothing is decided silently.
  const b=await h.smartCanvas('SAVE-01 B',[prompt('p1','original',80)]);
  await h.openSmart(page,b.id);
  await page.evaluate(()=>{window.__saveStates.length=0;});
  await typeLocal('本地手写');
  await externalEdit(b.id,list=>{list.find(n=>n.id==='p1').text='外部改写';});
  await delay(600);
  await settle();
  assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='p1').text),'本地手写','local text was discarded');
  server=await readServer(b.id);
  assert.equal(server.nodes.find(n=>n.id==='p1').text,'外部改写','a conflicting save overwrote the other side without asking');
  const states=await page.evaluate(()=>window.__saveStates);
  assert(!states.some(s=>s.ok),'reported saved while a field conflict was unresolved: '+JSON.stringify(states));
  assert(states.some(s=>s.code==='conflict'),'no conflict state was reported');
  const bar=page.locator('#studioSmartConflict');
  await bar.waitFor({timeout:3000});
  assert.match(await bar.innerText(),/提示词|text/,'conflict notice does not name the field');
  await bar.getByRole('button',{name:'保留我的修改'}).click();
  await delay(1200);
  server=await readServer(b.id);
  assert.equal(server.nodes.find(n=>n.id==='p1').text,'本地手写','keeping local did not save it');
  assert.equal(await page.locator('#studioSmartConflict').count(),0);
  console.log('PASS B same-field conflict keeps the draft, reports conflict, waits for a choice, then saves the chosen side');

  // C: choosing the remote side takes the external value and keeps editing safe.
  const c=await h.smartCanvas('SAVE-01 C',[prompt('p1','original',80)]);
  await h.openSmart(page,c.id);
  await typeLocal('本地版本');
  await externalEdit(c.id,list=>{list.find(n=>n.id==='p1').text='外部版本';});
  await delay(600);
  await settle();
  await page.locator('#studioSmartConflict').getByRole('button',{name:'采用外部版本'}).click();
  await delay(1200);
  assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='p1').text),'外部版本');
  assert.equal((await readServer(c.id)).nodes.find(n=>n.id==='p1').text,'外部版本');
  console.log('PASS C choosing the external version applies it');

  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }finally{await h.stop();}
}
main().catch(e=>{console.error(e);process.exit(1);});
