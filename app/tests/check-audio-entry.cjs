/* F09 (handover 2026-10-26): "添加 → 音频" works for every model setup and never fails silently.
   Real classic canvas page; the provider list and capability catalogue are fixtures, nothing is generated. */
'use strict';
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const DW={id:'dw',name:'DeepWhite',base_url:'https://api.deepwhiteai.com/v1',enabled:true,has_key:true};
const MODELS={
 speech:{'qwen3-tts-flash':{kind:'audio',channel:'speech',supported:true,catalog_enabled:true,prompt_min:1,prompt_max:5000,fields:{}}},
 music:{'suno-generation':{kind:'audio',channel:'music',supported:true,catalog_enabled:true,prompt_min:1,prompt_max:5000,fields:{}}},
 sound:{'suno-sounds':{kind:'audio',channel:'sound',supported:true,catalog_enabled:true,prompt_min:1,prompt_max:2000,fields:{}}},
};
async function main(){
 const h=await start('audio-entry');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const created=(await h.api('/api/canvases','POST',{title:'audio entry',kind:'classic'})).canvas;
  const page=await h.newPage();
  let catalogue={};
  await page.route('**/api/studio/capabilities',route=>route.fulfill({json:{providers:catalogue}}));
  await page.goto(h.base+'/static/canvas.html?id='+created.id);
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioAudio);await delay(800);
  // Each setup: replace the provider list and catalogue, then use the real add menu.
  const setup=async(providers,models)=>{
   catalogue=Object.keys(models).length?{dw:models}:{};
   await page.evaluate(list=>{StudioStageOne.getProviders=()=>list;try{localStorage.removeItem('studio.audio.recent.v1');}catch{}window.dispatchEvent(new Event('studio-providers-changed'));},providers);
   await delay(600);
  };
  const addAudio=async()=>{
   const before=await page.evaluate(()=>nodes.filter(n=>n.type==='audio').map(n=>n.id));
   // The bottom toolbar's "＋ 添加", the entry users actually use.
   await page.locator('#workspaceCanvasRail button',{hasText:'添加'}).first().click();await delay(300);
   await page.locator('[data-studio-add="audio"]:visible').first().click();await delay(500);
   return page.evaluate(ids=>{const n=nodes.find(x=>x.type==='audio'&&!ids.includes(x.id));const notice=document.getElementById('studioAudioNotice');
    return {node:n?{channel:n.studioParams?.channel,model:n.model}:null,notice:notice&&!notice.hidden?notice.textContent:''};},before);
  };
  for(const channel of ['speech','music','sound']){
   await check(`only ${channel} models: the menu creates a ${channel} node`,async()=>{
    await setup([DW],MODELS[channel]);const r=await addAudio();
    assert(r.node,'no node was created; notice: '+r.notice);
    assert.equal(r.node.channel,channel);assert.equal(r.node.model,Object.keys(MODELS[channel])[0]);
   });
  }
  await check('the node offers only channels that have models',async()=>{
   await setup([DW],MODELS.sound);const r=await addAudio();assert(r.node);
   const options=await page.evaluate(()=>{const n=nodes.filter(x=>x.type==='audio').at(-1);return [...document.querySelectorAll(`.node[data-id="${n.id}"] [data-channel] option`)].map(o=>({value:o.value,disabled:o.disabled,text:o.textContent}));});
   assert.deepEqual(options.filter(o=>!o.disabled).map(o=>o.value),['sound'],JSON.stringify(options));
   assert(options.filter(o=>o.disabled).every(o=>/无可用模型/.test(o.text)));
  });
  await check('no audio model: no node, and a visible reason',async()=>{
   await setup([DW],{});const r=await addAudio();
   assert.equal(r.node,null);assert.match(r.notice,/没有可用的/);assert.match(r.notice,/模型管理|启用/);
  });
  await check('no DeepWhite channel: the reason says audio needs DeepWhite',async()=>{
   await setup([],{});const r=await addAudio();
   assert.equal(r.node,null);assert.match(r.notice,/DeepWhite/);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
