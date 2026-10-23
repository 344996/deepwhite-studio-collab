/* GROUP-01: copying a smart group must copy its members; the copy is independent of the original. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const prompt=(id,text,x,y)=>({id,type:'smart-prompt',title:'提示词 '+id,text,x,y,w:320,h:220});
async function main(){
 const h=await start('smart-group-copy');
 try{
  const page=await h.newPage();
  const c=await h.smartCanvas('GROUP-01',[prompt('p1','第一段',80,98),prompt('p2','第二段',80,354)]);
  await h.openSmart(page,c.id);
  // Same steps as the report: Ctrl+G on two prompts, select only the group, Ctrl+C / Ctrl+V, drag the copy.
  await page.mouse.click(1200,850);
  await page.evaluate(()=>{selectedId='';selectedIds=['p1','p2'];render();});
  await page.keyboard.press('Control+g');
  const groupId=await page.evaluate(()=>nodes.find(n=>n.type==='smart-group')?.id);
  assert(groupId,'Ctrl+G did not create a group');
  const before=await page.evaluate(()=>Object.fromEntries(nodes.map(n=>[n.id,{x:n.x,y:n.y,text:n.text}])));
  await page.evaluate(id=>{selectedId=id;selectedIds=[];render();},groupId);
  await page.keyboard.press('Control+c');
  await page.mouse.move(900,300);
  await page.keyboard.press('Control+v');
  await delay(200);
  const pasted=await page.evaluate(id=>{const groups=nodes.filter(n=>n.type==='smart-group');const copy=groups.find(g=>g.id!==id);return copy&&{id:copy.id,items:copy.items.slice()};},groupId);
  assert(pasted,'paste did not create a group copy');
  const original=await page.evaluate(id=>nodes.find(n=>n.id===id).items.slice(),groupId);
  assert.equal(pasted.items.length,original.length,'copy lost members: '+JSON.stringify(pasted.items));
  assert(pasted.items.every(id=>!original.includes(id)),'copy still shares the original members: '+JSON.stringify(pasted.items));
  const members=await page.evaluate(ids=>ids.map(id=>nodes.find(n=>n.id===id)).map(n=>n&&{id:n.id,text:n.text,x:n.x,y:n.y}),pasted.items);
  assert(members.every(Boolean),'copy references members that do not exist');
  assert.deepEqual(members.map(m=>m.text).sort(),['第一段','第二段']);

  const box=await page.locator(`.image-node[data-id="${pasted.id}"]`).boundingBox();
  await page.mouse.move(box.x+60,box.y+14);await page.mouse.down();
  for(let i=1;i<=10;i++)await page.mouse.move(box.x+60+i*12,box.y+14+i*6);
  await page.mouse.up();await delay(200);
  const afterDrag=await page.evaluate(()=>Object.fromEntries(nodes.map(n=>[n.id,{x:n.x,y:n.y,text:n.text}])));
  for(const id of ['p1','p2',groupId])assert.deepEqual({x:afterDrag[id].x,y:afterDrag[id].y},{x:before[id].x,y:before[id].y},'dragging the copy moved original '+id);
  assert(members.some(m=>afterDrag[m.id].x!==m.x||afterDrag[m.id].y!==m.y),'copy members did not follow the copied group');

  // Edit and delete inside the copy only.
  await page.evaluate(id=>{nodes.find(n=>n.id===id).text='副本改写';scheduleSave();},pasted.items[0]);
  assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='p1').text),'第一段');
  await page.evaluate(id=>deleteNode(id),pasted.items[1]);
  assert.deepEqual(await page.evaluate(id=>nodes.find(n=>n.id===id).items.slice(),groupId),original,'deleting a copy member changed the original group');
  assert(await page.evaluate(()=>nodes.some(n=>n.id==='p1')&&nodes.some(n=>n.id==='p2')));
  await page.evaluate(()=>performUndo());
  assert(await page.evaluate(id=>nodes.some(n=>n.id===id),pasted.items[1]),'undo did not restore the deleted copy member');
  assert.equal(await page.evaluate(id=>nodes.find(n=>n.id===id).text,pasted.items[0]),'副本改写','undo reverted more than the delete');

  await page.evaluate(()=>saveCanvas());await delay(800);
  const saved=(await h.api('/api/canvases/'+c.id)).canvas;
  const savedOriginal=saved.nodes.find(n=>n.id===groupId),savedCopy=saved.nodes.find(n=>n.id===pasted.id);
  assert.deepEqual(savedOriginal.items,original);
  assert(savedCopy.items.every(id=>!original.includes(id)));
  assert.equal(saved.nodes.find(n=>n.id==='p1').text,'第一段');
  console.log('PASS copied smart group owns new members; moving, editing, deleting and undo leave the original untouched');
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }finally{await h.stop();}
}
main().catch(e=>{console.error(e);process.exit(1);});
