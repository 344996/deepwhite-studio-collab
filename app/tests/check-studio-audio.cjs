const { chromium } = require('data/local-path');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'data/local-path'});
 try{
  const page=await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<main class="workspace"><div class="studio-canvas-actions"></div><div id="nodes"></div></main>');
  await page.addStyleTag({content:'html,body{margin:0;min-height:100%;font:14px system-ui;background:#f1f5f9;color:#0f172a}.workspace{box-sizing:border-box;width:min(920px,calc(100vw - 40px));margin:24px auto;padding:18px;background:white;border:1px solid #cbd5e1;border-radius:16px}.studio-canvas-actions{position:fixed;left:20px;bottom:22px;z-index:45;display:flex;gap:8px}.studio-canvas-actions>.studio-audio-create-wrap{height:36px;padding:5px;background:#fff;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 3px 15px #0f172a15}.studio-audio-create{height:34px;padding:0 12px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#334155;font-size:12px;font-weight:600}.audio-card{box-sizing:border-box;width:min(440px,100%);min-width:0;padding:16px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;box-shadow:0 6px 24px #0f172a12}.audio-card h2{margin:0 0 12px;font-size:16px}.studio-audio-ui{min-width:0}.studio-audio-job{min-width:0}.studio-audio-result{min-width:0}.studio-audio-result audio{min-width:0}'});
  await page.addStyleTag({path:path.resolve(__dirname,'../static/studio-audio.css')});
  await page.evaluate(()=>{
   window.apiProviders=[{id:'dw',name:'DeepWhite',base_url:'https://api.deepwhiteai.com/v1'}];
   window.audioCaps={dw:{
    'qwen3-tts-flash':{kind:'audio',channel:'speech',supported:true,catalog_enabled:true,fields:{voice:{label:'音色 ID',type:'text',max_length:100}}},
    'qwen3-tts-instruct-flash':{kind:'audio',channel:'speech',supported:true,catalog_enabled:true,fields:{voice:{label:'音色 ID',type:'text',max_length:100},instructions:{label:'语气',type:'text',max_length:1000}}},
    'mureka-v9-bgm':{kind:'audio',channel:'music',supported:true,catalog_enabled:true,fields:{n:{label:'数量',values:[1,2,3],default:2},instrumental_id:{label:'伴奏模板',type:'text',max_length:120}}},
    'suno-sounds':{kind:'audio',channel:'sound',supported:true,catalog_enabled:true,fields:{}}
   }};
   window.audioNodes=[];
   window.uid=prefix=>prefix+'-'+Math.random().toString(36).slice(2,9);
   window.defaultPoint=()=>({x:20,y:40});window.setStatus=()=>{};window.pushUndo=()=>{};window.scheduleSave=()=>{};window.render=()=>{};
   window.addNode=node=>{audioNodes.push(node);return node;};
   window.StudioStageOne={
    actions:document.querySelector('.studio-canvas-actions'),states:{},
    api:async()=>({providers:audioCaps}),getProviders:()=>apiProviders,
    request:node=>({prompt:node.audioPrompt||''}),getJob:()=>null,run:node=>{node.ran=true;return Promise.resolve();}
   };
  });
  await page.addScriptTag({path:path.resolve(__dirname,'../static/studio-audio.js')});
  await page.waitForSelector('.studio-audio-create');
  await page.getByRole('button',{name:'添加音频'}).click();
  await page.getByRole('button',{name:'语音生成'}).click();
  const node=await page.evaluate(()=>audioNodes[0]);
  assert.equal(node.type,'audio');assert.equal(node.studioParams.channel,'speech');assert.equal(node.model,'qwen3-tts-flash');

  await page.evaluate(()=>{
   const node=audioNodes[0],ui=renderAudioBody(node);
   const voice=ui.querySelector('input');voice.value='warm';voice.dispatchEvent(new Event('input',{bubbles:true}));
   const channel=ui.querySelector('[data-channel]');channel.value='music';channel.dispatchEvent(new Event('change',{bubbles:true}));
  });
  const music=await page.evaluate(()=>audioNodes[0]);
  assert.equal(music.studioParams.channel,'music');assert.equal(music.model,'mureka-v9-bgm');
  assert.equal(Object.hasOwn(music.studioParams,'voice'),false,'speech-only voice settings must not cross into music');
  await page.evaluate(()=>{
   const ui=renderAudioBody(audioNodes[0]),channel=ui.querySelector('[data-channel]');channel.value='speech';channel.dispatchEvent(new Event('change',{bubbles:true}));
  });
  const speechAgain=await page.evaluate(()=>audioNodes[0]);
  assert.equal(speechAgain.studioParams.channel,'speech');assert.equal(speechAgain.model,'qwen3-tts-flash','each channel remembers its own last model');

  await page.evaluate(async()=>{
   audioCaps={dw:{...audioCaps.dw,'qwen3-tts-flash':{...audioCaps.dw['qwen3-tts-flash'],catalog_enabled:false}}};
   window.dispatchEvent(new Event('studio-providers-changed'));await new Promise(resolve=>setTimeout(resolve,30));
   const ui=renderAudioBody(audioNodes[0]);document.body.append(ui);
  });
  assert.equal(await page.evaluate(()=>audioNodes[0].model),'qwen3-tts-flash','inactive selection must be preserved after capabilities refresh');
  assert.match(await page.locator('.studio-audio-note').last().innerText(),/已停用；原设置已保留/);
  assert.equal(await page.locator('.studio-audio-run').last().isDisabled(),true);
  assert.deepEqual(errors,[]);
  const canvasSource=await fs.readFile(path.resolve(__dirname,'../static/js/canvas.js'),'utf8');
  const stageOneSource=await fs.readFile(path.resolve(__dirname,'../static/studio-stage-one.js'),'utf8');
  assert.match(stageOneSource,/function request\(n,id\)\{[^}]*prompt:sentPrompt\(n\)/s,'durable requests must snapshot the rendered final prompt');
  assert.match(stageOneSource,/function prompt\(n\)\{[^}]*:generatorSources\(n\)\.map\(s=>s\.prompt\)/s,'video prompts must use the composed upstream and node sources');
  const extract=(start,end)=>canvasSource.slice(canvasSource.indexOf(start),canvasSource.indexOf(end,canvasSource.indexOf(start)));
  const helpers=extract('function generatedImageRefs(node){','function mediaRefsFromNode(node){')+'\n'+extract('function mergeGeneratedOutputs(node, outputs, append=false){','function pendingById(out, id){');
  await page.evaluate(()=>{
   window.CANVAS_MEDIA_OUTPUT_TYPES=['audio'];window.outputUrlValue=item=>typeof item==='string'?item:item?.url||'';
   window.mediaKindForOutputItem=item=>item?.kind||'image';window.outputImageName=()=>'';
   window.syncConnectedOutputsFromGenerated=()=>{};
  });
  await page.addScriptTag({content:helpers});
  const reuse=await page.evaluate(()=>{const node={type:'audio',generatedOutputs:[]};mergeGeneratedOutputs(node,[{url:'/api/output/studio-audio.mp3',kind:'audio'}],true);return {outputs:node.generatedOutputs,refs:generatedImageRefs(node)};});
  assert.deepEqual(reuse.outputs,[{url:'/api/output/studio-audio.mp3',kind:'audio'}]);
  assert.deepEqual(reuse.refs,[{url:'/api/output/studio-audio.mp3',name:'audio-1',kind:'audio'}]);
  const screenshotDir=process.env.STUDIO_AUDIO_SCREENSHOT_DIR;
  if(screenshotDir){
   await fs.mkdir(screenshotDir,{recursive:true});
   await page.evaluate(()=>{
   const node=audioNodes[0];node.model='qwen3-tts-instruct-flash';node.studioParamsModel=node.model;
   node.studioParams={channel:'speech',voice:'warm',instructions:'温和、清晰'};node.audioPrompt='请在日出时轻声读出这句欢迎词。';
   node.studioAudioOutputs=[{url:'data:audio/wav;base64,UklGRg==',kind:'audio',name:'语音结果.wav'}];
   node.studioJobState='succeeded';node.studioJob='screenshot-job';
    document.querySelectorAll('.studio-audio-ui').forEach(element=>element.remove());
    const card=document.createElement('article');card.className='audio-card';const title=document.createElement('h2');title.textContent='语音生成';card.append(title,renderAudioBody(node));document.querySelector('#nodes').replaceChildren(card);
   });
   for(const [width,height] of [[1280,800],[1500,1050]]){
    await page.setViewportSize({width,height});await page.screenshot({path:path.join(screenshotDir,`studio-audio-${width}x${height}.png`),fullPage:true});
    const bounds=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,card:document.querySelector('.audio-card').getBoundingClientRect().toJSON(),media:document.querySelector('.studio-audio-result').getBoundingClientRect().toJSON(),audio:document.querySelector('audio').getBoundingClientRect().toJSON()}));
    assert.ok(bounds.scroll<=width,`horizontal page overflow at ${width}: ${bounds.scroll}`);
    assert.ok(bounds.card.right<=width+1,`audio card exceeds viewport at ${width}: ${bounds.card.right}`);
    assert.ok(bounds.audio.right<=bounds.card.right+1,`audio player exceeds card at ${width}`);
   }
  }
  assert.deepEqual(errors,[]);
  console.log('PASS offline audio creation/editing/channel isolation/inactive preservation, audio result reuse, and responsive overflow checks; no provider calls');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
