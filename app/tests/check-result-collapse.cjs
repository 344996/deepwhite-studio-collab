/* U03 (handover 2026-10-26), with UI-NEW-01/02: image, video, text and audio nodes show only their result,
   name and live status, before and after generating; the editor opens for the one selected node. Real mouse clicks only, real classic page, offline
   catalogue; nothing is generated. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const RESULT=[{url:'/static/design-review/assets/scene-v1.png',kind:'image'}];
async function main(){
 const h=await start('result-collapse');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  await h.api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'Offline fixture',base_url:'https://api.deepwhiteai.com/v1',api_key:'offline-u03',enabled:true,primary:true});
  const created=(await h.api('/api/canvases','POST',{title:'u03',kind:'classic'})).canvas;
  fs.mkdirSync(path.join(h.runtime,'output'),{recursive:true});fs.copyFileSync(path.join(__dirname,'fixtures','native-fixture.webm'),path.join(h.runtime,'output','u03-result.webm'));
  const gen=(id,x,y,extra={})=>({id,type:'generator',x,y,apiProvider:'deepwhite',model:'deepwhiteai-image-g-v2.5-lowprice',studioPrompt:'雨夜 '+id,...extra});
  const nodes=[gen('g1',0,0,{generatedOutputs:RESULT}),gen('g2',700,0,{generatedOutputs:RESULT}),
   gen('g3',0,900),{id:'out',type:'output',x:1400,y:0,images:[]},
   gen('g4',2100,0,{generatedOutputs:RESULT,studioJobState:'failed',studioJobError:'余额不足，本次未扣费'}),
   gen('m1',2100,900,{model:'midjourney-imagine',generatedOutputs:RESULT,studioMjStatus:'uncertain',studioMjTask:'task_fixture_1'}),
   {id:'v1',type:'video',x:1400,y:700,studioPrompt:'镜头推进',generatedOutputs:[{url:'/output/u03-result.webm',kind:'video'}]},
   {id:'l1',type:'llm',x:0,y:1600,userInput:'写一段旁白',outputText:'雨夜的站台，灯光很暖。'},{id:'a1',type:'audio',x:700,y:1600,studioPrompt:'雨声'}];
  await h.api('/api/canvases/'+created.id,'PUT',{title:'u03',icon:'layers',nodes,connections:[{id:'c1',from:'g1',to:'out'}],viewport:{x:525,y:-128,scale:.55},logs:[],settings:{},base_updated_at:created.updated_at,client_id:'fixture'});
  const page=await h.newPage();await page.setViewportSize({width:1280,height:800});
  await page.goto(h.base+'/static/canvas.html?id='+created.id);
  await page.waitForFunction(()=>window.StudioResultCollapse&&document.querySelector('.node[data-id="g1"] .studio-node-media img'));await delay(1200);
  const editor=id=>page.locator(`.node[data-id="${id}"] .studio-prompt-input`);
  const clickHead=async id=>{const b=await page.locator(`.node[data-id="${id}"] .node-title`).boundingBox();await page.mouse.click(b.x+b.width/2,b.y+b.height/2);await delay(250);};
  // A point where the empty canvas itself is on top (not a card, toolbar or minimap).
  const blank=async()=>{const p=await page.evaluate(()=>{for(const fy of [.85,.7,.5,.3])for(const fx of [.6,.4,.8,.2]){const x=innerWidth*fx,y=innerHeight*fy;if([board,world,nodesEl,linksEl].includes(document.elementFromPoint(x,y)))return {x,y};}return null;});assert(p,'no empty canvas point');await page.mouse.click(p.x,p.y);await delay(250);};
  await check('nodes start collapsed, with or without a result',async()=>{
   assert.equal(await editor('g1').isVisible(),false);assert.equal(await editor('g2').isVisible(),false);
   assert.equal(await page.locator('.node[data-id="g1"] .studio-node-media img').isVisible(),true);
   assert.equal(await page.locator('.node[data-id="g1"] .node-title').isVisible(),true);
   assert.equal(await editor('g3').isVisible(),false,'a node without a result kept its editor open');
   assert.equal(await page.locator('.node[data-id="g3"] .node-title').isVisible(),true);
   // Nothing is left below a finished or untouched node: no status line, no empty bar.
   assert.equal(await page.locator('.node[data-id="g1"] .studio-node-composer').isVisible(),false);
   assert.equal(await page.locator('.node[data-id="g3"] .studio-node-composer').isVisible(),false);
  });
  await check('a task that needs the user keeps its node open (failed, unconfirmed MJ)',async()=>{
   for(const id of ['g4','m1'])assert.equal(await page.locator(`.node[data-id="${id}"]`).evaluate(c=>c.classList.contains('studio-collapsed')),false,id+' was folded');
   assert.match(await page.locator('.node[data-id="g4"] .studio-job-state').innerText(),/余额不足/);
   await blank();assert.equal(await page.locator('.node[data-id="m1"]').evaluate(c=>c.classList.contains('studio-collapsed')),false,'clicking away folded an unconfirmed task');
  });
  await check('clicking a node opens its editor; clicking another closes the first',async()=>{
   await clickHead('g1');assert.equal(await editor('g1').isVisible(),true);
   await clickHead('g2');assert.equal(await editor('g2').isVisible(),true);assert.equal(await editor('g1').isVisible(),false);
  });
  await check('typing is kept when the node collapses',async()=>{
   await editor('g2').click();await page.keyboard.press('Control+End');await page.keyboard.type(' 加暖光');await blank();
   assert.equal(await editor('g2').isVisible(),false,'editor still open after leaving the node');
   assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='g2').studioPrompt),'雨夜 g2 加暖光');
  });
  await check('multi-selection keeps every editor closed',async()=>{
   await clickHead('g1');await page.keyboard.down('Control');await clickHead('g2');await page.keyboard.up('Control');
   assert.equal(await page.evaluate(()=>selected.size),2);
   assert.equal(await editor('g1').isVisible(),false);assert.equal(await editor('g2').isVisible(),false);
  });
  await check('the connection follows the output port after collapsing and expanding',async()=>{
   await blank();await clickHead('g1');await blank();await delay(300);
   const drift=await page.evaluate(()=>{const path=document.querySelector('#links path.link');const m=path.getAttribute('d').match(/^M\s*([-\d.]+)\s+([-\d.]+)/);const p=portPoint('g1','out');return Math.hypot(+m[1]-p.x,+m[2]-p.y);});
   assert(drift<=1.5,'connection starts '+drift.toFixed(1)+'px from the port');
  });
  await check('undo keeps the editor you are working in open',async()=>{
   await blank();await clickHead('g1');assert.equal(await editor('g1').isVisible(),true);
   await page.evaluate(()=>pushUndo());await page.keyboard.press('Control+z');await delay(300);
   assert.equal(await page.evaluate(()=>selected.size),0,'undo should clear the selection as before');
   assert.equal(await editor('g1').isVisible(),true,'undo folded the open editor');
   await blank();assert.equal(await editor('g1').isVisible(),false,'clicking the empty canvas should fold it');
  });
  await check('playing a collapsed video does not open its parameters',async()=>{
   const video=page.locator('.node[data-id="v1"] .studio-node-media video');await video.scrollIntoViewIfNeeded();
   await page.waitForFunction(()=>document.querySelector('.node[data-id="v1"]')?.classList.contains('studio-collapsed'));
   const b=await video.boundingBox();assert(b,'video not visible');
   await page.mouse.click(b.x+b.width/2,b.y+b.height/2);await delay(300);
   assert.equal(await page.locator('.node[data-id="v1"]').evaluate(c=>c.classList.contains('studio-collapsed')),true,'watching the result opened the editor');
   await page.evaluate(()=>{const v=document.querySelector('.node[data-id="v1"] video');v.pause();});
  });
  await check('UI-NEW-02: at 1280×800 and viewport 525/−128 a real click selects every visible card',async()=>{
   await blank();
   for(const id of ['g1','g2','g3','out']){
    // Only points where the card is really on top: fixed app bars legitimately cover the canvas.
    const point=await page.evaluate(id=>{const head=document.querySelector(`.node[data-id="${id}"] .node-head`);if(!head)return null;const r=head.getBoundingClientRect();
     for(const fx of [.5,.3,.7,.15,.85])for(const fy of [.5,.25,.75]){const x=r.left+r.width*fx,y=r.top+r.height*fy;if(x<0||y<0||x>innerWidth||y>innerHeight)continue;
      const hit=document.elementFromPoint(x,y);if(hit?.closest('.node')?.dataset.id===id&&!hit.closest('button,input,textarea,select'))return {x,y};}return null;},id);
    if(!point)continue;const {x,y}=point;
    await page.mouse.click(x,y);await delay(200);
    assert.deepEqual(await page.evaluate(()=>[...selected]),[id],'click at '+x.toFixed(0)+','+y.toFixed(0)+' did not select '+id);
   }
  });
  await check('a running task keeps its status line while collapsed, and its editor stays closed',async()=>{
   await blank();
   await page.evaluate(()=>{const n=nodes.find(n=>n.id==='g3');n.running=true;n.studioJobState='running';StudioResultCollapse.refresh();});
   assert.equal(await page.locator('.node[data-id="g3"] .studio-node-composer').isVisible(),true,'the status area was hidden while running');
   assert.equal(await editor('g3').isVisible(),false);
   await page.evaluate(()=>{const n=nodes.find(n=>n.id==='g3');n.running=false;n.studioJobState='succeeded';StudioResultCollapse.refresh();});
   assert.equal(await page.locator('.node[data-id="g3"] .studio-node-composer').isVisible(),false,'a finished status stayed below the node');
  });
  await check('text and audio nodes follow the same rule; the generated text stays readable',async()=>{
   await page.getByRole('button',{name:'适应全部节点 · Shift+1',exact:true}).click();await delay(400);await blank();
   const text=page.locator('.node[data-id="l1"]'),audio=page.locator('.node[data-id="a1"]');
   assert.equal(await text.locator('.llm-input-output').isVisible(),false);assert.equal(await audio.locator('.studio-audio-prompt').isVisible(),false);
   assert.match(await text.locator('.llm-result-output').innerText(),/雨夜的站台/);
   await clickHead('l1');assert.equal(await text.locator('.llm-input-output').isVisible(),true,'clicking the text node did not open it');
   await clickHead('a1');assert.equal(await audio.locator('.studio-audio-prompt').isVisible(),true,'clicking the audio node did not open it');
   assert.equal(await text.locator('.llm-input-output').isVisible(),false,'the text node stayed open after picking another');
  });
  await check('a node just added from the menu opens at once',async()=>{
   await blank();const p=await page.evaluate(()=>{for(const fy of [.85,.7,.5,.3])for(const fx of [.6,.4,.8,.2]){const x=innerWidth*fx,y=innerHeight*fy;if([board,world,nodesEl,linksEl].includes(document.elementFromPoint(x,y)))return {x,y};}return null;});
   await page.mouse.dblclick(p.x,p.y);await page.locator('#createMenu.open [data-studio-add="image"]').click();await delay(300);
   assert.equal(await page.locator('.node.selected .studio-prompt-input').isVisible(),true);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
