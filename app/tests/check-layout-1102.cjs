/* Layout of 2026-11-02: home sizes and working entry points, floating canvas controls, title-and-frame nodes.
   Real mouse clicks on the real pages with an offline catalogue; nothing is generated. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const box=async(page,selector)=>{const b=await page.locator(selector).first().boundingBox();assert(b,selector+' is not on screen');return b;};
async function main(){
 const h=await start('layout-1102');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  await h.api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'Offline',base_url:'https://api.deepwhiteai.com/v1',api_key:'offline-layout',enabled:true,primary:true});
  const existing=(await h.api('/api/canvases','POST',{title:'已有画布',kind:'classic'})).canvas;
  const page=await h.newPage();await page.setViewportSize({width:1440,height:960});
  const home=async()=>{await page.goto(h.base+'/');await page.locator('.workspace-tools button').first().waitFor();await delay(400);};
  const opened=async()=>{await page.waitForURL(/canvas\.html/);await page.waitForFunction(()=>window.StudioLayout1102&&typeof canvas!=='undefined'&&canvas&&!new URL(location.href).searchParams.has('starter'));await delay(400);};
  await home();
  await check('home sizes follow the reviewed layout at 1440 wide',async()=>{
   assert.equal((await box(page,'.ws-sidebar')).width,240);
   const nav=await box(page,'.workspace-nav button');assert.equal(Math.round(nav.height),32);
   const card=await box(page,'#newCanvasBtn');assert.deepEqual([Math.round(card.x),Math.round(card.width),Math.round(card.height)],[280,1120,160]);
   const plus=await box(page,'.home-new-plus');assert.deepEqual([Math.round(plus.width),Math.round(plus.height)],[88,52]);
   const tile=await box(page,'.workspace-tool-tile');assert.deepEqual([Math.round(tile.width),Math.round(tile.height)],[98,56]);
   assert.equal(await page.locator('.workspace-hero-art').count(),0,'the old hero is gone');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  });
  await check('the brand sits at the top of the sidebar; project folders and trash stay reachable',async()=>{
   assert.equal(await page.locator('.ws-sidebar .studio-brand-bar').count(),1);
   await page.locator('.ws-project-row').first().waitFor();assert.equal(await page.locator('.workspace-nav-foot #trashEntry').count(),1);
   await page.locator('#trashEntry').click();await page.locator('#trashPanel.active').waitFor();await page.locator('#trashClose').click();
  });
  await check('canvas tabs filter the real list',async()=>{
   await page.locator('.home-canvas-tabs [data-tab="pinned"]').click();await delay(100);
   assert.equal(await page.locator('.ws-board-world .ws-card:visible').count(),0);
   await page.locator('.home-canvas-tabs [data-tab="recent"]').click();await delay(100);
   assert.equal(await page.locator('.ws-board-world .ws-card:visible').count(),1);
   await page.locator('.home-canvas-tabs [data-tab="all"]').click();await delay(100);
   assert.match(await page.locator('.ws-board-world .ws-card:visible').first().innerText(),/已有画布/);
  });
  await check('"新建画布创作" still opens the native create dialog',async()=>{
   await page.locator('#newCanvasBtn').click();await page.locator('#homeCreateDialog').waitFor();await page.keyboard.press('Escape');await delay(150);
  });
  await check('"设置" entries open the right settings page',async()=>{
   await page.locator('.workspace-tools button',{hasText:'外接智能体'}).click();
   const frame=page.frameLocator('#studioSettingsDialog iframe');await frame.locator('#controlPanel').waitFor();
   await frame.locator('#closeSettings').click();await delay(200);
  });
  for(const [label,type] of [['图片生成','generator'],['视频生成','video'],['音频生成','audio'],['文本生成','llm']]){
   await check(`"${label}" opens a new canvas holding one selected ${type} node`,async()=>{
    await home();await page.locator('.workspace-tools button',{hasText:label}).click();await opened();
    const state=await page.evaluate(()=>({types:nodes.map(n=>n.type),selected:[...selected].length,title:canvas.title}));
    assert.deepEqual(state.types,[type]);assert.equal(state.selected,1);assert.equal(state.title,label);
    assert.equal(new URL(page.url()).searchParams.has('starter'),false,'a reload could repeat the starter');
   });
  }
  await check('"常用流程" builds its connected nodes once, and a reload does not add more',async()=>{
   await home();await page.locator('.workspace-flows button',{hasText:'分镜与场景'}).click();await opened();
   const shape=()=>page.evaluate(()=>({types:nodes.map(n=>n.type).sort(),links:connections.length}));
   const first=await shape();assert.deepEqual(first,{types:['generator','generator','generator','prompt'],links:3});
   await page.evaluate(async()=>await saveCanvas());await page.reload();await page.waitForFunction(()=>window.StudioLayout1102&&typeof canvas!=='undefined'&&canvas&&nodes.length>0);await delay(400);
   assert.deepEqual(await shape(),first);
  });
  await check('a starter never fills a canvas that already has work',async()=>{
   await h.api('/api/canvases/'+existing.id,'PUT',{title:'已有画布',icon:'layers',nodes:[{id:'keep',type:'prompt',x:0,y:0,text:'保留'}],connections:[],viewport:{x:0,y:0,scale:1},logs:[],settings:{},base_updated_at:(await h.api('/api/canvases/'+existing.id)).canvas.updated_at,client_id:'fixture'});
   await page.goto(h.base+'/static/canvas.html?id='+existing.id+'&starter=storyboard');await opened();
   assert.deepEqual(await page.evaluate(()=>nodes.map(n=>n.id)),['keep']);
  });
  await check('canvas controls float over a full-height board',async()=>{
   const board=await box(page,'#board');assert.deepEqual([board.y,board.height],[0,960]);
   const left=await box(page,'.topbar');assert(left.x===16&&left.y===16&&left.width<500,JSON.stringify(left));
   const right=await box(page,'.workspace-canvas-tools');assert(Math.abs(right.x+right.width-1424)<=1&&right.y===16,JSON.stringify(right));
   const rail=await box(page,'#workspaceCanvasRail');assert(Math.abs(rail.x+rail.width/2-720)<=1&&Math.abs(rail.y+rail.height-944)<=1,JSON.stringify(rail));
  });
  await check('the main tool bar holds add, history, tools, assets and shortcuts, and they work',async()=>{
   const rail=page.locator('#workspaceCanvasRail');
   assert.deepEqual((await rail.locator('button').evaluateAll(items=>items.map(i=>i.getAttribute('aria-label')))).slice(0,4),['添加','历史','选择 · V','移动 · H']);
   await page.locator('#workspaceHistory').click();await page.locator('.studio-history').waitFor({state:'visible'});await page.locator('.studio-history header .studio-history-close').click();
   await page.locator('#workspaceShortcuts').click();await page.locator('.v2-small-dialog[open],dialog[open]').first().waitFor();await page.keyboard.press('Escape');await delay(150);
   await page.locator('#studioV2Add').click();await page.locator('#createMenu.open').waitFor();await page.keyboard.press('Escape');
  });
  await check('the map opens on request',async()=>{
   assert.equal(await page.locator('#minimap').isVisible(),false);
   await page.getByRole('button',{name:'显示或隐藏导航地图',exact:true}).click();assert.equal(await page.locator('#minimap').isVisible(),true);
   const nav=await box(page,'.v2-navigation'),map=await box(page,'#minimap');assert(map.y+map.height<=nav.y,'the map overlaps the zoom controls');
   await page.getByRole('button',{name:'显示或隐藏导航地图',exact:true}).click();assert.equal(await page.locator('#minimap').isVisible(),false);
  });
  await check('manual save moved under "更多工具" and still saves',async()=>{
   await page.locator('#workspaceMoreTools summary').click();await page.locator('#workspaceSave').click();
   await page.waitForFunction(()=>/已保存/.test(document.getElementById('studioV2SaveState')?.textContent||''));
  });
  await check('a node is a small title and a frame, with its composer below once selected',async()=>{
   await page.evaluate(()=>{nodes=[];connections=[];selected.clear();const n=addGeneratorNode({x:300,y:200});n.id='shape';render();});await delay(300);
   await page.mouse.click(1000,800);await delay(200);
   const node=page.locator('.node[data-id="shape"]');
   assert.equal(await node.evaluate(el=>getComputedStyle(el,'::before').display==='none'||getComputedStyle(el,'::before').content==='none'),true,'a panel still paints behind the node');
   assert.equal(await page.locator('.node[data-id="shape"] .node-head button').first().evaluate(b=>getComputedStyle(b).opacity),'0','the close button should wait for the pointer');
   assert.equal(await node.locator('.studio-node-composer').isVisible(),false);
   assert.equal(await node.locator('.studio-preview-reference').innerText(),'图生图');
   const head=await node.locator('.node-title').boundingBox();await page.mouse.click(head.x+head.width/2,head.y+head.height/2);await delay(300);
   const media=await node.locator('.studio-node-media').boundingBox(),composer=await node.locator('.studio-node-composer').boundingBox();
   assert(composer&&composer.y>=media.y+media.height,'the composer is not below the frame');
   assert(composer.width<media.width,'the composer should be slightly narrower than the frame');
   assert.equal(Math.round(media.width/media.height*100),178,'the frame is 16:9');
   const ports=await node.locator(':scope>.port').evaluateAll(list=>list.map(p=>{const b=p.getBoundingClientRect();return b.y+b.height/2}));
   for(const y of ports)assert(Math.abs(y-(media.y+media.height/2))<4,'the handles sit at the middle of the frame');
   const refChip=await node.locator('.studio-input-icon').boundingBox(),addChip=await node.locator('.studio-creative-add button').first().boundingBox();
   assert(Math.abs(refChip.y-addChip.y)<3&&refChip.x<addChip.x,'the reference chip leads the chip row');
   const settings=await node.locator('.studio-image-settings').innerText();assert(!settings.includes('设置'),settings);
   const footer=await node.locator('.studio-image-footer').evaluate(el=>{const r=el.getBoundingClientRect();return [...el.children].filter(k=>k.offsetWidth).every(k=>{const b=k.getBoundingClientRect();return b.right<=r.right+1&&k.scrollWidth<=k.clientWidth+1})});
   assert(footer,'every footer item fits, including the price');
   const area=node.locator('.studio-prompt-input'),expand=node.locator('.studio-prompt-expand'),small=(await area.boundingBox()).height;
   await expand.click();await delay(100);assert((await area.boundingBox()).height>small*2,'expanding grows the prompt');assert.equal(await expand.getAttribute('aria-pressed'),'true');
   await expand.click();await delay(100);assert.equal(Math.round((await area.boundingBox()).height),Math.round(small));
   await node.locator('.studio-preview-reference').click();await page.locator('.node[data-id="shape"] .studio-input-popover').waitFor({state:'visible'});await page.keyboard.press('Escape');
  });
  await check('the selection bar can delete, and stays clear of the node',async()=>{
   const size=page.viewportSize();
   for(const height of [size.height,620]){
    await page.setViewportSize({width:size.width,height});await page.locator('.node[data-id="shape"] .node-title').click();await delay(300);
    const bar=await box(page,'#studioV2Selection'),composer=await box(page,'.node.selected .studio-node-composer');
    assert(bar.x+bar.width<=composer.x||composer.x+composer.width<=bar.x||bar.y+bar.height<=composer.y||composer.y+composer.height<=bar.y,'the selection bar covers the composer at height '+height);
   }
   await page.setViewportSize(size);await delay(200);
   const before=await page.evaluate(()=>nodes.length);
   await page.locator('#workspaceDeleteNodes').click();await delay(200);
   assert.equal(await page.evaluate(()=>nodes.length),before-1);
   await page.keyboard.press('Control+z');await page.waitForFunction(n=>nodes.length===n,before);
  });
  await check('light and milk themes keep readable controls and neutral dark stays the default',async()=>{
   assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--dw-bg').trim()),'#141414');
   await page.locator('#workspaceMoreTools summary').click();await page.selectOption('#studioCanvasTheme','milk');await delay(300);
   assert.notEqual(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--dw-bg').trim()),'#141414');
   assert.notEqual(await page.locator('.workspace-canvas-tools').evaluate(el=>getComputedStyle(el).backgroundColor),await page.locator('.workspace-canvas-tools').evaluate(el=>getComputedStyle(el).color));
   await page.selectOption('#studioCanvasTheme','graphite');await delay(200);await page.keyboard.press('Escape');
  });
  await check('both pages fit a phone width',async()=>{
   await page.setViewportSize({width:390,height:800});await delay(300);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'canvas overflows');
   await home();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'home overflows');
   assert.equal(await page.locator('#newCanvasBtn').isVisible(),true);
   await page.setViewportSize({width:1440,height:960});
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
