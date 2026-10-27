/* SAVE-01 (2026-10-26 review, R1): the smart prompt node's LLM instruction and system prompt are
   protected like its text. Real smart canvas page, temporary storage, an external writer via the API. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const prompt=(id,x,extra={})=>({id,type:'smart-prompt',title:'提示词',text:'雨夜',x,y:100,w:320,h:220,llmInstruction:'原指令',llmSystemPrompt:'原系统提示',...extra});
async function main(){
 const h=await start('smart-llm-conflict');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const page=await h.newPage();
  const server=async id=>(await h.api('/api/canvases/'+id)).canvas;
  const externalEdit=async(id,edit)=>{const c=await server(id);c.nodes=edit(c.nodes)||c.nodes;await h.api('/api/canvases/'+id,'PUT',{title:c.title,icon:c.icon,nodes:c.nodes,connections:c.connections,viewport:c.viewport,logs:c.logs||[],settings:c.settings||{},base_updated_at:c.updated_at,client_id:'external-window'});};
  const local=(field,value,id='p1')=>page.evaluate(([f,v,id])=>{nodes.find(n=>n.id===id)[f]=v;clearTimeout(saveTimer);saveTimer=null;},[field,value,id]);
  const settle=async()=>{await page.evaluate(()=>saveCanvas());await delay(1500);};
  const bar=page.locator('#studioSmartConflict');

  for(const [field,label] of [['llmInstruction','指令'],['llmSystemPrompt','系统提示']]){
   await check(field+': same-field conflict asks, keeps the draft, and saves the chosen local side',async()=>{
    const c=await h.smartCanvas('LLM '+field,[prompt('p1',80)]);await h.openSmart(page,c.id);
    await local(field,'本地'+label);
    await externalEdit(c.id,list=>{list.find(n=>n.id==='p1')[field]='外部'+label;});
    await delay(600);await settle();
    assert.equal(await page.evaluate(f=>nodes.find(n=>n.id==='p1')[f],field),'本地'+label,'local text was overwritten');
    assert.equal((await server(c.id)).nodes.find(n=>n.id==='p1')[field],'外部'+label,'saved over the other side without asking');
    await bar.waitFor({timeout:3000});
    assert.match(await bar.innerText(),new RegExp(label),'notice does not name the field');
    await bar.getByRole('button',{name:'保留我的修改'}).click();await delay(1200);
    assert.equal((await server(c.id)).nodes.find(n=>n.id==='p1')[field],'本地'+label);
    await page.reload();await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioSave);
    assert.equal(await page.evaluate(f=>nodes.find(n=>n.id==='p1')[f],field),'本地'+label,'lost after reopen');
   });
   await check(field+': choosing the external version applies it',async()=>{
    const c=await h.smartCanvas('LLM ext '+field,[prompt('p1',80)]);await h.openSmart(page,c.id);
    await local(field,'本地版本');
    await externalEdit(c.id,list=>{list.find(n=>n.id==='p1')[field]='外部版本';});
    await delay(600);await settle();
    await bar.getByRole('button',{name:'采用外部版本'}).click({timeout:3000});await delay(1200);
    assert.equal(await page.evaluate(f=>nodes.find(n=>n.id==='p1')[f],field),'外部版本');
    assert.equal((await server(c.id)).nodes.find(n=>n.id==='p1')[field],'外部版本');
   });
  }
  await check('a local LLM instruction and a remote title edit both survive',async()=>{
   const c=await h.smartCanvas('LLM merge',[prompt('p1',80),prompt('p2',480)]);await h.openSmart(page,c.id);
   await local('llmInstruction','本地指令');
   await externalEdit(c.id,list=>{list.find(n=>n.id==='p2').title='外部标题';});
   await delay(600);await settle();
   const s=await server(c.id);
   assert.equal(s.nodes.find(n=>n.id==='p1').llmInstruction,'本地指令');assert.equal(s.nodes.find(n=>n.id==='p2').title,'外部标题');
  });
  await check('a remote delete does not silently drop an unsaved LLM instruction',async()=>{
   const c=await h.smartCanvas('LLM delete',[prompt('p1',80),prompt('p2',480)]);await h.openSmart(page,c.id);
   await local('llmInstruction','删除前写的指令','p2');
   await externalEdit(c.id,list=>list.filter(n=>n.id!=='p2'));
   await delay(600);await settle();
   const kept=await page.evaluate(()=>nodes.find(n=>n.id==='p2')?.llmInstruction);
   assert.equal(kept,'删除前写的指令','the node and its unsaved instruction were removed without asking');
   await bar.waitFor({timeout:3000});
   assert.match(await bar.innerText(),/外部已删除/);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
