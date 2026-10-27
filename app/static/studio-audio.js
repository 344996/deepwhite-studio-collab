/* Dedicated speech, music and sound nodes for the classic canvas. */
(() => {
  const bridge=window.StudioStageOne;
  if(!bridge)return;
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-audio.css?v=3';document.head.append(css);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const CHANNELS={speech:'语音',music:'音乐',sound:'音效'};
  let capabilities={};
  let recent={};
  try{recent=JSON.parse(localStorage.getItem('studio.audio.recent.v1')||'{}')||{};}catch{}
  const apiProviders=()=>bridge.getProviders?.()||[];
  const providerName=id=>apiProviders().find(p=>p.id===id)?.name||id;
  const deepProviders=()=>apiProviders().filter(p=>{try{return new URL(p.base_url).hostname==='api.deepwhiteai.com';}catch{return false;}});
  const channelOf=node=>node.studioParams?.channel||'speech';
  const models=(providerId,channel,includeUnavailable=false)=>Object.entries(capabilities[providerId]||{}).filter(([,spec])=>spec.kind==='audio'&&spec.channel===channel&&spec.supported!==false&&(includeUnavailable||spec.catalog_enabled!==false)).map(([id,spec])=>({id,spec}));
  const providers=channel=>deepProviders().filter(p=>models(p.id,channel).length);
  const firstModel=(providerId,channel)=>models(providerId,channel)[0]?.id||'';
  function remember(channel,providerId,model){recent[channel]={provider_id:providerId,model};try{localStorage.setItem('studio.audio.recent.v1',JSON.stringify(recent));}catch{}}
  function defaults(spec){return Object.fromEntries(Object.entries(spec?.fields||{}).map(([key,field])=>[key,field.default??(field.type==='text'?'':'')]));}
  function setModel(node,providerId,model,channel){
    node.apiProvider=providerId;node.model=model;node.studioParams={...defaults(capabilities[providerId]?.[model]),channel};node.studioParamsModel=model;
  }
  // F09: a failed create always says why, in a notice that stays visible in every layout.
  function notice(message){
    window.setStatus?.(message);
    let el=document.getElementById('studioAudioNotice');
    if(!el){el=document.createElement('div');el.id='studioAudioNotice';el.className='studio-audio-notice';el.setAttribute('role','status');document.body.append(el);}
    el.textContent=message;el.hidden=false;clearTimeout(el._timer);el._timer=setTimeout(()=>{el.hidden=true;},6000);
  }
  function unavailable(channel){
    if(!deepProviders().length)return '没有可用的音频模型：音频生成目前只支持 DeepWhite API，请先在设置中添加并保存 DeepWhite 渠道。';
    return `没有可用的${CHANNELS[channel]||'配音、音乐或音效'}模型：请在模型管理中同步并启用对应模型（例如音效 suno-sounds），再添加音频节点。`;
  }
  // Without an explicit channel, start in the last used one that still has a model, else the first that has one.
  const firstChannel=()=>[...Object.keys(recent),...Object.keys(CHANNELS)].find(ch=>CHANNELS[ch]&&providers(ch).length)||'';
  function create(point,channel='',source=null){
    const selectedChannel=CHANNELS[channel]?channel:firstChannel();
    if(!selectedChannel||!providers(selectedChannel).length){notice(unavailable(channel));return null;}
    const available=providers(selectedChannel),saved=recent[selectedChannel];
    const pid=available.some(p=>p.id===saved?.provider_id)?saved.provider_id:available[0]?.id||'';
    const model=models(pid,selectedChannel).some(item=>item.id===saved?.model)?saved.model:firstModel(pid,selectedChannel);
    if(!model){notice(unavailable(selectedChannel));return null;}
    const p=point||window.defaultPoint?.(150,50)||{x:0,y:0};
    const node=window.addNode({id:window.uid('audio'),type:'audio',x:p.x,y:p.y,w:400,apiProvider:pid,model,studioTitle:CHANNELS[selectedChannel],studioParams:{...defaults(capabilities[pid][model]),channel:selectedChannel},studioParamsModel:model,audioPrompt:'',inputs:[],running:false});
    if(source)Object.assign(node,{apiProvider:source.provider_id,model:source.model,audioPrompt:source.prompt,studioParams:{...source.params},studioParamsModel:source.model});
    remember(selectedChannel,pid,model);
    return node;
  }
  window.studioAddAudioNode=create;
  window.StudioAudio={channelOf,modelsForChannel:models,fields:model=>Object.values(capabilities).map(p=>p[model]).find(Boolean)?.fields||{},create};
  const menu=document.createElement('div');menu.className='studio-audio-menu';menu.hidden=true;
  for(const [channel,label] of Object.entries(CHANNELS)){
    const button=document.createElement('button');button.type='button';button.textContent=label+'生成';
    button.onclick=()=>{menu.hidden=true;create(window.defaultPoint?.(150,50),channel);};menu.append(button);
  }
  const mountMenu=()=>{if(!bridge.actions||menu.dataset.mounted)return;menu.dataset.mounted='1';const wrap=document.createElement('div');wrap.className='studio-audio-create-wrap';const button=document.createElement('button');button.type='button';button.className='studio-audio-create';button.textContent='添加音频';button.setAttribute('aria-haspopup','true');wrap.append(button,menu);bridge.actions.append(wrap);button.onclick=e=>{e.stopPropagation();menu.hidden=!menu.hidden;};menu.addEventListener('pointerdown',e=>e.stopPropagation());document.addEventListener('pointerdown',e=>{if(!wrap.contains(e.target))menu.hidden=true;});};
  async function load(){try{capabilities=(await bridge.api('/api/studio/capabilities')).providers||{};mountMenu();if(window.canvas)window.render();}catch{}}
  window.addEventListener('studio-providers-changed',load);window.addEventListener('studio-stage-one-ready',load);load();

  function renderAudio(node){
    const ui=document.createElement('section');ui.className='studio-audio-ui';
    if(node.type!=='audio')return ui;
    const channel=channelOf(node);const availableProviders=providers(channel);const chosenProvider=node.apiProvider||availableProviders[0]?.id||'';
    const availableModels=models(chosenProvider,channel);const selectedModel=node.model||availableModels[0]?.id||'';
    const providerKnown=availableProviders.some(p=>p.id===chosenProvider);const modelKnown=availableModels.some(m=>m.id===selectedModel);
    const providerOptions=availableProviders.map(p=>`<option value="${esc(p.id)}">${esc(providerName(p.id))}</option>`);
    if(chosenProvider&&!providerKnown)providerOptions.unshift(`<option value="${esc(chosenProvider)}" disabled>${esc(providerName(chosenProvider))}（当前不可用，已保留）</option>`);
    const modelOptions=availableModels.map(m=>`<option value="${esc(m.id)}">${esc(m.spec.name||m.id)}</option>`);
    if(selectedModel&&!modelKnown)modelOptions.unshift(`<option value="${esc(selectedModel)}" disabled>${esc(selectedModel)}（当前不可用，已保留）</option>`);
    const spec=capabilities[node.apiProvider]?.[node.model];
    ui.innerHTML=`<label>生成频道<select data-channel aria-label="生成频道">${Object.entries(CHANNELS).map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select></label><label>API 平台<select data-provider aria-label="API 平台">${providerOptions.join('')||'<option value="" disabled>当前频道没有可用平台</option>'}</select></label><label>生成模型<select data-model aria-label="生成模型">${modelOptions.join('')||'<option value="" disabled>当前频道没有可用模型</option>'}</select></label><label class="studio-audio-prompt">${channel==='speech'?'要朗读的文本':channel==='sound'?'音效描述':'音乐描述'}<textarea data-prompt maxlength="5000" placeholder="${channel==='speech'?'输入要转换成语音的文字':'描述希望生成的声音'}"></textarea></label><div class="studio-audio-fields"></div><small class="studio-audio-note">${esc(spec?.catalog_enabled===false?'此平台或模型当前已停用；原设置已保留。':!spec?'此模型当前不可用；原设置已保留。':spec.note||'请确认模型参数与平台账单；生成会提交一次 API 任务。')}</small><button type="button" class="studio-audio-run">生成${CHANNELS[channel]}</button><div class="studio-audio-job" aria-live="polite"></div><details class="studio-audio-snapshot"><summary>查看请求快照与引用素材</summary><pre></pre></details>`;
    const channelSelect=ui.querySelector('[data-channel]');channelSelect.value=channel;
    // A channel without models cannot be chosen; it used to be selectable and then do nothing.
    for(const option of channelSelect.options)if(option.value!==channel&&!providers(option.value).length){option.disabled=true;option.textContent+='（无可用模型）';}
    const providerSelect=ui.querySelector('[data-provider]');providerSelect.value=node.apiProvider;
    const modelSelect=ui.querySelector('[data-model]');modelSelect.value=node.model;
    const prompt=ui.querySelector('[data-prompt]');prompt.value=node.audioPrompt||'';
    const runButton=ui.querySelector('.studio-audio-run');
    const updateRun=()=>{let sent='';try{sent=bridge.request(node,'audio-preview').prompt.trim();}catch{sent=prompt.value.trim();}const mureka=/^mureka-v[89]-bgm$/.test(node.model);const valid=mureka?Boolean(sent)!==Boolean(node.studioParams.instrumental_id):Boolean(sent);runButton.disabled=!providerKnown||!modelKnown||!spec||spec.catalog_enabled===false||spec.supported===false||!valid||!!node.running;};
    prompt.oninput=()=>{node.audioPrompt=prompt.value;window.scheduleSave();updateRun();};
    channelSelect.onchange=()=>{const ch=channelSelect.value,candidates=providers(ch),saved=recent[ch];const p=candidates.find(item=>item.id===saved?.provider_id)||candidates[0];if(!p)return;window.pushUndo();const model=models(p.id,ch).some(item=>item.id===saved?.model)?saved.model:firstModel(p.id,ch);setModel(node,p.id,model,ch);node.studioTitle=CHANNELS[ch];remember(ch,p.id,model);window.scheduleSave();window.render();};
    providerSelect.onchange=()=>{window.pushUndo();const model=firstModel(providerSelect.value,channel);setModel(node,providerSelect.value,model,channel);remember(channel,node.apiProvider,node.model);window.scheduleSave();window.render();};
    modelSelect.onchange=()=>{window.pushUndo();setModel(node,node.apiProvider,modelSelect.value,channel);remember(channel,node.apiProvider,node.model);window.scheduleSave();window.render();};
    const fieldBox=ui.querySelector('.studio-audio-fields');
    for(const [key,field] of Object.entries(spec?.fields||{})){
      const label=document.createElement('label');label.textContent=field.label;
      if(field.type==='text'){
        const input=document.createElement('input');input.type='text';input.maxLength=field.max_length||500;input.value=node.studioParams[key]||'';input.oninput=()=>{node.studioParams[key]=input.value;window.scheduleSave();updateRun();};label.append(input);
      }else{
        const select=document.createElement('select');for(const value of field.values||[])select.add(new Option(typeof value==='boolean'?(value?'开启':'关闭'):String(value),String(value)));
        select.value=String(node.studioParams[key]??field.default);select.onchange=()=>{node.studioParams[key]=field.values.find(value=>String(value)===select.value);window.scheduleSave();};label.append(select);
      }
      fieldBox.append(label);
    }
    const job=bridge.getJob(node.studioJob);const state=job?.status||node.studioJobState;const jobBox=ui.querySelector('.studio-audio-job');
    if(state){const status=document.createElement('p');status.textContent=bridge.states[state]||state;if(job?.error||node.studioJobError)status.textContent+=' · '+(job?.error||node.studioJobError);jobBox.append(status);if(job?.task_ids?.length){const id=document.createElement('small');id.textContent='任务编号：'+job.task_ids.join('、');jobBox.append(id);}}
    for(const output of node.studioAudioOutputs||[]){const result=document.createElement('div');result.className='studio-audio-result';const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';audio.src=output.url;const link=document.createElement('a');link.href=output.url;link.download=output.name||'audio';link.textContent='下载';result.append(audio,link);jobBox.append(result);}
    updateRun();
    runButton.onclick=()=>bridge.run(node);
    ui.querySelector('details').addEventListener('toggle',e=>{if(e.currentTarget.open){const latest=bridge.getJob(node.studioJob);e.currentTarget.querySelector('pre').textContent=JSON.stringify(latest?.request||{provider_id:node.apiProvider,model:node.model,kind:'audio',params:node.studioParams,references:[]},null,2);}});
    return ui;
  }
  window.renderAudioBody=renderAudio;
  window.runAudioNode=(id,opts={})=>{const node=nodes.find(item=>item.id===id);return node?bridge.run(node,opts):undefined;};
})();
