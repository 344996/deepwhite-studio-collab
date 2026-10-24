/* SAVE-02: a node or connection deleted on one side must not come back when the other side saves. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const prompt=(id,text,x)=>({id,type:'smart-prompt',title:'提示词 '+id,text,x,y:100,w:320,h:220});
const edge=(from,to)=>({from,to,kind:'flow'});
async function main(){
 const h=await start('smart-remote-delete');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e));}};
 try{
  const page=await h.newPage();
  await page.addInitScript(()=>{window.__saveStates=[];addEventListener('studio-save-state',e=>window.__saveStates.push({ok:e.detail.ok,code:e.detail.code}));});
  const readServer=async id=>(await h.api('/api/canvases/'+id)).canvas;
  // Another window or MCP saves with the current revision, like the control API does.
  const externalEdit=async(id,edit)=>{const c=await readServer(id);edit(c);await h.api('/api/canvases/'+id,'PUT',{title:c.title,icon:c.icon,nodes:c.nodes,connections:c.connections,viewport:c.viewport,logs:c.logs||[],settings:c.settings||{},base_updated_at:c.updated_at,client_id:'external-window'});};
  const settle=async()=>{await page.evaluate(()=>saveCanvas());await delay(1500);};
  const ids=c=>c.nodes.map(n=>n.id).sort();
  const reopen=async()=>{await page.reload();await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioSave);await delay(300);};

  // A: the report's case. The other side deletes p2 and its connection; this page edits p3 only.
  const a=await h.smartCanvas('SAVE-02 A',[prompt('p1','一',80),prompt('p2','二',480),prompt('p3','三',880)],[edge('p1','p2')]);
  await h.openSmart(page,a.id);
  await page.evaluate(()=>{nodes.find(n=>n.id==='p3').text='本页改了三';clearTimeout(saveTimer);saveTimer=null;});
  await externalEdit(a.id,c=>{c.nodes=c.nodes.filter(n=>n.id!=='p2');c.connections=[];});
  await delay(600);await settle();
  let server=await readServer(a.id);
  await check('A remote node delete is not revived by a stale page',()=>assert.deepEqual(ids(server),['p1','p3'],'saved '+JSON.stringify(ids(server))));
  await check('A remote connection delete is not revived',()=>assert.equal(server.connections.length,0,JSON.stringify(server.connections)));
  await check('A this page\'s edit to another node is kept',async()=>assert.equal(server.nodes.find(n=>n.id==='p3')?.text,'本页改了三',
   JSON.stringify({server:server.nodes.find(n=>n.id==='p3')?.text,page:await page.evaluate(()=>({text:nodes.find(n=>n.id==='p3')?.text,states:window.__saveStates}))})));
  await reopen();
  await check('A reopened canvas matches',async()=>assert.deepEqual(await page.evaluate(()=>nodes.map(n=>n.id).sort()),['p1','p3']));

  // B: this page deletes a connection while the other side edits something else.
  const b=await h.smartCanvas('SAVE-02 B',[prompt('q1','一',80),prompt('q2','二',480)],[edge('q1','q2')]);
  await h.openSmart(page,b.id);
  await page.evaluate(()=>{disconnectConnections([0]);clearTimeout(saveTimer);saveTimer=null;});
  await externalEdit(b.id,c=>{c.nodes.find(n=>n.id==='q1').title='外部标题';});
  await delay(600);await settle();
  server=await readServer(b.id);
  await check('B a connection deleted on this page is not revived by the merge',()=>assert.equal(server.connections.length,0,JSON.stringify(server.connections)));
  await check('B the other side\'s edit is kept',()=>assert.equal(server.nodes.find(n=>n.id==='q1')?.title,'外部标题'));

  // C: real conflicts: this page deletes r1 the other side edited; the other side deletes r2 this page edited.
  const c=await h.smartCanvas('SAVE-02 C',[prompt('r1','一',80),prompt('r2','二',480)]);
  await h.openSmart(page,c.id);
  await page.evaluate(()=>{window.__saveStates.length=0;deleteNode('r1');nodes.find(n=>n.id==='r2').text='本页改了二';clearTimeout(saveTimer);saveTimer=null;});
  await externalEdit(c.id,cv=>{cv.nodes.find(n=>n.id==='r1').text='外部改了一';cv.nodes=cv.nodes.filter(n=>n.id!=='r2');});
  await delay(600);await settle();
  server=await readServer(c.id);
  await check('C conflicting deletes are reported and nothing is decided silently',async()=>{
   assert.deepEqual(ids(server),['r1'],'server changed before a choice: '+JSON.stringify(ids(server)));
   const states=await page.evaluate(()=>window.__saveStates);
   assert(!states.some(s=>s.ok),'reported saved during a conflict: '+JSON.stringify(states));
   const bar=page.locator('#studioSmartConflict');await bar.waitFor({timeout:3000});
   assert.match(await bar.innerText(),/删除/);
  });
  await check('C keeping this page\'s version applies both of its decisions',async()=>{
   await page.locator('#studioSmartConflict').getByRole('button',{name:'保留我的修改'}).click();await delay(1200);
   const after=await readServer(c.id);
   assert.deepEqual(ids(after),['r2']);assert.equal(after.nodes.find(n=>n.id==='r2').text,'本页改了二');
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
