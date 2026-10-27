/* U09 (handover 2026-10-26): no permanent "提示词 N 字 · 要求 …" line. Length problems are reported
   when generating, in place, and the text is never cut. Real classic canvas, offline catalogue. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('prompt-hint');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  await h.api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'Offline fixture',base_url:'https://api.deepwhiteai.com/v1',api_key:'offline-prompt-test',enabled:true,primary:true});
  const created=(await h.api('/api/canvases','POST',{title:'prompt hint',kind:'classic'})).canvas;
  const nodes=[{id:'g',type:'generator',x:80,y:80,apiProvider:'deepwhite',model:'deepwhiteai-image-g-v2.5-lowprice',studioPrompt:''}];
  await h.api('/api/canvases/'+created.id,'PUT',{title:'prompt hint',icon:'layers',nodes,connections:[],viewport:{x:0,y:0,scale:1},logs:[],settings:{},base_updated_at:created.updated_at,client_id:'fixture'});
  const page=await h.newPage();const posts=[];
  page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(studio\/generations|canvas-|online-image)/.test(r.url()))posts.push(r.url());});
  await page.goto(h.base+'/static/canvas.html?id='+created.id);
  await page.waitForFunction(()=>window.StudioStageOne&&document.querySelector('.node[data-id="g"] .studio-prompt-input'));await delay(800);
  const hint=()=>page.evaluate(()=>{const el=document.querySelector('.node[data-id="g"] .studio-prompt-count');return el&&getComputedStyle(el).display!=='none'&&!el.hidden?el.textContent:'';});
  const button=page.locator('.node[data-id="g"] .gen-btn');
  await check('an empty prompt shows no permanent length line and the button stays usable',async()=>{
   assert.equal(await hint(),'');assert.equal(await button.isDisabled(),false);
  });
  await check('generating with an empty prompt explains it in place and sends nothing',async()=>{
   await button.click();await delay(400);
   assert.match(await hint(),/请先填写提示词/);assert.equal(posts.length,0);
  });
  await check('typing clears the message',async()=>{
   await page.locator('.node[data-id="g"] .studio-prompt-input').fill('雨夜的老城修表铺');await delay(200);
   assert.equal(await hint(),'');
  });
  await check('an over-long prompt is reported on generate and kept in full',async()=>{
   const max=await page.evaluate(()=>StudioStageOne.getCapabilities()?.deepwhite?.['deepwhiteai-image-g-v2.5-lowprice']?.prompt_max||5000);
   const text='雨'.repeat(max+5);
   await page.locator('.node[data-id="g"] .studio-prompt-input').fill(text);await delay(200);
   assert.equal(await hint(),'','over-long text showed a permanent line before generating');
   await button.click();await delay(400);
   assert.match(await hint(),new RegExp(`${max+5} 字.*上限 ${max} 字`));assert.equal(posts.length,0);
   assert.equal((await page.locator('.node[data-id="g"] .studio-prompt-input').inputValue()).length,max+5,'the text was cut');
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
