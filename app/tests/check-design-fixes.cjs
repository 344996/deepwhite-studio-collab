/* UX-01, UX-02, UX-03, REF-02 on the real classic and smart canvas pages; no generation. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const PERSON='/static/design-review/assets/character-v1.png';
async function main(){
 const h=await start('design-fixes');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const classic=(await h.api('/api/canvases','POST',{title:'design classic',kind:'classic'})).canvas;
  await h.api('/api/canvases/'+classic.id,'PUT',{title:'design classic',icon:'layers',nodes:[{id:'p1',type:'prompt',x:200,y:200,text:'雨夜的站台'}],connections:[],viewport:{x:0,y:0,scale:1},logs:[],settings:{},base_updated_at:classic.updated_at,client_id:'f'});
  const smart=await h.smartCanvas('design smart',[
   {id:'tp',type:'smart-prompt',title:'提示词',text:'雨夜的站台',x:200,y:200,w:320,h:220},
   {id:'src',type:'smart-image',title:'人物',x:200,y:600,images:[{url:PERSON,name:'人物'}]},
   {id:'gen',type:'smart-image',title:'生成',x:700,y:600,images:[],inputNodeIds:['src']}],[{from:'src',to:'gen',kind:'input'}]);
  const page=await h.newPage();
  const openClassic=async()=>{await page.goto(h.base+'/static/canvas.html?id='+classic.id);await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioStageOne);await delay(600);};
  const view=()=>page.evaluate(()=>({x:viewport.x,y:viewport.y,scale:viewport.scale}));
  const zoomBy=async(steps,dir)=>{const box=await page.locator('#board,#shell').first().boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.keyboard.down('Control');for(let i=0;i<steps;i++){await page.mouse.wheel(0,dir*240);await delay(15);}await page.keyboard.up('Control');await delay(200);};

  for(const [label,open,field] of [['classic',openClassic,'.node[data-id="p1"] textarea'],['smart',()=>h.openSmart(page,smart.id),'.image-node[data-id="tp"] .prompt-node-text']]){
   await open();
   // UX-02: one zoom range on both canvases.
   await check(`22 ${label} canvas zooms within 10%–800%`,async()=>{
    await zoomBy(60,1);const min=(await view()).scale;
    await zoomBy(90,-1);const max=(await view()).scale;
    assert(Math.abs(min-0.1)<0.002,'min '+min);assert(Math.abs(max-8)<0.01,'max '+max);
   });
   // UX-01: at 20% the edited text becomes readable and the view comes back afterwards.
   await check(`20 ${label} focus set by the page itself does not move the view`,async()=>{
    await page.evaluate(()=>{viewport.scale=0.2;viewport.x=60;viewport.y=40;applyViewport();});await delay(200);
    const before=await view();await page.locator(field).focus();await delay(500);const after=await view();
    assert(Math.abs(after.scale-before.scale)<1e-6,'programmatic focus zoomed to '+after.scale);
    await page.evaluate(()=>document.activeElement?.blur());await delay(200);
   });
   await check(`20 ${label} text stays readable while editing at 20% and the view returns`,async()=>{
    await page.evaluate(()=>{viewport.scale=0.2;viewport.x=60;viewport.y=40;applyViewport();});await delay(200);
    const before=await view();
    await page.locator(field).click();await delay(500);
    const px=await page.locator(field).evaluate(el=>parseFloat(getComputedStyle(el).fontSize)*el.getBoundingClientRect().height/el.offsetHeight);
    assert(px>=12,'on-screen text is '+px.toFixed(1)+'px while editing');
    await page.keyboard.press('Control+End');await page.keyboard.type('，灯光');
    assert((await page.locator(field).inputValue()).endsWith('，灯光'),'typing did not reach the field');
    await page.keyboard.press('Escape');await delay(500);
    const after=await view();
    assert(Math.abs(after.scale-before.scale)<1e-3&&Math.abs(after.x-before.x)<1&&Math.abs(after.y-before.y)<1,'view not restored: '+JSON.stringify({before,after}));
   });
  }

  // UX-03: menus 140ms, windows 180ms, none with reduced motion.
  const motion=sel=>page.evaluate(sel=>{const el=document.querySelector(sel);if(!el)return null;const s=getComputedStyle(el);return {name:s.animationName,duration:s.animationDuration,transition:s.transitionDuration};},sel);
  await openClassic();
  await check('23 settings window and popover menus share one motion rule',async()=>{
   await page.locator('#studioSettingsButton').click();await delay(60);
   const dialog=await motion('#studioSettingsDialog');
   assert.equal(dialog?.name,'studio-window-in',JSON.stringify(dialog));assert.equal(dialog.duration,'0.18s');
   await page.keyboard.press('Escape');await delay(300);
   await page.evaluate(()=>{const p=document.createElement('div');p.id='motionProbe';p.setAttribute('popover','auto');p.textContent='x';document.body.append(p);p.showPopover();});
   const pop=await motion('#motionProbe');assert.equal(pop?.name,'studio-menu-in',JSON.stringify(pop));assert.equal(pop.duration,'0.14s');
   await page.evaluate(()=>document.getElementById('motionProbe').remove());
  });
  await h.openSmart(page,smart.id);
  await check('23 smart popovers use the menu duration',async()=>{
   const pop=await motion('.smart-popover');assert(pop,'no smart popover');assert.equal(pop.transition.split(',')[0].trim(),'0.14s',JSON.stringify(pop));
  });
  await page.emulateMedia({reducedMotion:'reduce'});
  await check('23 reduced motion turns layer motion off',async()=>{
   const pop=await motion('.smart-popover');assert.equal(pop.transition.split(',')[0].trim(),'0s',JSON.stringify(pop));
   await page.evaluate(()=>{const p=document.createElement('div');p.id='motionProbe';p.setAttribute('popover','auto');document.body.append(p);p.showPopover();});
   const probe=await motion('#motionProbe');assert.equal(probe.name,'none',JSON.stringify(probe));
  });
  await page.emulateMedia({reducedMotion:'no-preference'});

  // REF-02: bound token, plain @ text and inputs still sent through a connection are told apart.
  const semantics=()=>page.evaluate(async()=>{StudioRefSemantics?.update();await new Promise(r=>setTimeout(r,50));const el=document.getElementById('smartRefSemantics');
   const sent=buildPromptRequest(activeComposerNode(),null,false).refs.length;return {text:el?.hidden?'':el?.textContent||'',bound:+(el?.dataset.bound||0),plain:+(el?.dataset.plain||0),upstream:+(el?.dataset.upstream||0),sent};});
  await check('27 a token from the list is shown as bound',async()=>{
   await page.evaluate(()=>{selectedId='gen';selectedIds=[];render();});await delay(300);
   await page.evaluate(src=>{promptInput.innerHTML='让 '+mentionTokenHtml({url:src,name:'人物',nodeId:'src',imageIndex:0})+' 站在 @场景 前';promptInput.dispatchEvent(new Event('input'));},PERSON);
   const s=await semantics();
   assert.equal(s.bound,1,JSON.stringify(s));assert.equal(s.plain,1,JSON.stringify(s));assert.match(s.text,/已绑定 1/);assert.match(s.text,/纯文本 @ 1/);
   assert.match(s.text,new RegExp('本次共发送 '+s.sent+' 个'));
  });
  await check('27 deleting the token shows the connected input is still sent',async()=>{
   await page.evaluate(()=>{promptInput.innerHTML='让 @人物 站在 @场景 前';promptInput.dispatchEvent(new Event('input'));});
   const s=await semantics();
   assert.equal(s.bound,0,JSON.stringify(s));assert.equal(s.plain,2,JSON.stringify(s));assert.equal(s.upstream,1,JSON.stringify(s));
   assert.equal(s.sent,1,'request preview disagrees with the line');assert.match(s.text,/仍随连线发送 1/);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
