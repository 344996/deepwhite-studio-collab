/* UI-NEW-03 (2026-10-26 review): quantify wheel-zoom anchor drift with real mouse input.
   Records screen-pixel drift of the world point under the cursor, per step after the frame settles,
   and accumulated over a long in/out sequence, at three DPR-independent cursor positions. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('zoom-anchor');
 const report={};let failed=0;
 try{
  const created=(await h.api('/api/canvases','POST',{title:'zoom anchor',kind:'classic'})).canvas;
  await h.api('/api/canvases/'+created.id,'PUT',{title:'zoom anchor',icon:'layers',nodes:[{id:'p1',type:'prompt',x:0,y:0,text:'锚点'},{id:'p2',type:'prompt',x:900,y:600,text:'参照'}],connections:[],viewport:{x:525,y:-128,scale:1},logs:[],settings:{},base_updated_at:created.updated_at,client_id:'fixture'});
  const page=await h.newPage();await page.setViewportSize({width:1280,height:800});
  await page.goto(h.base+'/static/canvas.html?id='+created.id);
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id);await delay(1200);
  const world=(x,y)=>page.evaluate(([x,y])=>{const r=board.getBoundingClientRect();return {x:(x-r.left-viewport.x)/viewport.scale,y:(y-r.top-viewport.y)/viewport.scale,scale:viewport.scale};},[x,y]);
  const screenOf=(p)=>page.evaluate(p=>{const r=board.getBoundingClientRect();return {x:r.left+viewport.x+p.x*viewport.scale,y:r.top+viewport.y+p.y*viewport.scale};},p);
  // Rendered position of node p1's corner: an ideal zoom about the cursor keeps
  // corner = cursor + (corner0 - cursor) * scale / scale0. Measured on the DOM, not on the math.
  const corner=()=>page.evaluate(()=>{const r=document.querySelector('.node[data-id="p1"]').getBoundingClientRect();return {x:r.left,y:r.top,scale:viewport.scale};});
  for(const [name,x,y,delta,count] of [['center',640,400,120,8],['near-left-edge',40,300,120,8],['lower-right',1180,700,120,8],['trackpad-pinch',700,350,3,50]]){
   await page.mouse.move(x,y);const c0=await corner();let worst=0;const scales=[];
   const steps=[...Array(count).fill(-delta),...Array(count*2).fill(delta),...Array(count).fill(-delta)];
   await page.keyboard.down('Control');
   for(const dy of steps){
    await page.mouse.wheel(0,dy);
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const c=await corner(),k=c.scale/c0.scale;scales.push(c.scale);
    worst=Math.max(worst,Math.hypot(c.x-(x+(c0.x-x)*k),c.y-(y+(c0.y-y)*k)));
   }
   await page.keyboard.up('Control');await delay(300);
   const c=await corner(),k=c.scale/c0.scale;
   report[name]={worstStepPx:+worst.toFixed(3),settledPx:+Math.hypot(c.x-(x+(c0.x-x)*k),c.y-(y+(c0.y-y)*k)).toFixed(3),
     minScale:+Math.min(...scales).toFixed(4),maxScale:+Math.max(...scales).toFixed(4),finalScale:+c.scale.toFixed(4),steps:steps.length};
  }
  const transform=await page.evaluate(()=>getComputedStyle(document.getElementById('world')).transform);
  console.log(JSON.stringify({report,transform},null,1));
  for(const [name,r] of Object.entries(report)){
   try{assert(r.worstStepPx<=0.5&&r.settledPx<=0.5,'drift above half a pixel');console.log('PASS '+name+' anchor stays within 0.5px over '+r.steps+' wheel steps');}
   catch(e){failed++;console.log('FAIL '+name+': '+JSON.stringify(r));}
  }
  assert.deepEqual(h.errors,[]);
 }finally{await h.stop();}
 if(failed)process.exit(1);
}
main().catch(e=>{console.error(e);process.exit(1);});
