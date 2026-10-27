/* Use saved, configured providers for the three MVP node model selectors. */
(() => {
  const smart = !!document.querySelector('.smart-back');
  let stored = {}, previewCatalog = null;
  const dreaminaId='dreamina-cli';
  let dreaminaStatus=null;
  const getDreamina = async () => { try { const r=await fetch('/api/studio/dreamina/status'); if(r.ok) dreaminaStatus=await r.json(); } catch {} };
  const getCatalog = async () => { try { const r=await fetch('/api/studio/model-catalog'); if(r.ok){const data=await r.json();stored=data.providers;previewCatalog=data.preview||null;} } catch {} };
  const originalLoad = loadConfig;
  function syncDreaminaProvider(){
    if(!dreaminaStatus)return;
    apiProviders=Array.isArray(apiProviders)?apiProviders.filter(p=>p.id!==dreaminaId):[];
    const models=(dreaminaStatus.models||[]).filter(m=>m.enabled!==false);
    const entries=dreaminaStatus.models||[];
    const provider={id:dreaminaId,name:'即梦账号',protocol:'jimeng',enabled:dreaminaStatus.enabled!==false&&!smart,has_key:false,primary:false,
      image_models:dreaminaStatus.enabled!==false&&!smart?models.filter(m=>m.kind==='image').map(m=>m.id):[],
      video_models:dreaminaStatus.enabled!==false&&!smart?models.filter(m=>m.kind==='video').map(m=>m.id):[],
      model_names:Object.fromEntries(entries.map(m=>[m.id,m.name||m.id]))};
    apiProviders.push(provider);
    stored[dreaminaId]={models:entries.map(m=>({...m,series:m.series||(/seedance/i.test(m.name||m.id)?'Seedance':'Dreamina 图像'),vendor:'即梦账号',capabilities:[m.kind==='video'?'即梦视频':'即梦图片']}))};
  }
  const refreshDreaminaPickers=()=>{syncDreaminaProvider();if(typeof render==='function')render();decorate();};
  loadConfig = async function(...args) { const result=await Promise.all([originalLoad.apply(this,args),getCatalog(),getDreamina()]);refreshDreaminaPickers();return result[0]; };
  Promise.all([getCatalog(),getDreamina()]).then(refreshDreaminaPickers);
  const catalogue = (kind, excluded = []) => (apiProviders || [])
    .filter(p => p.enabled !== false && !excluded.includes(p.id)
      && (p.has_key || p.primary || ['codex','gemini-cli','jimeng','local-comfy'].includes(p.protocol))
      && (p[`${kind}_models`] || []).length)
    .slice().sort((a,b) => Number(!!b.primary) - Number(!!a.primary));
  const empty = '<option value="" disabled selected>请在「设置 / API」添加并保存模型</option>';
  chatApiProviders = () => catalogue('chat');
  videoApiProviders = () => catalogue('video', smart ? ['volcengine'] : ['modelscope']);
  if (smart) imageProviders = () => catalogue('image', ['modelscope','volcengine']);
  else imageApiProviders = () => catalogue('image', ['modelscope']);

  const chatProviders = chatProviderOptions;
  chatProviderOptions = (...args) => chatApiProviders().length ? chatProviders(...args) : empty;
  const chatModels = chatModelOptions;
  chatModelOptions = (...args) => chatApiProviders().length ? chatModels(...args) : empty;
  if (!smart) {
    const videoProviders = videoProviderOptions;
    videoProviderOptions = (...args) => videoApiProviders().length ? videoProviders(...args) : empty;
  }

  const findEntry=(provider,id)=>stored[provider]?.models?.find(m=>m.id===id||Object.values(m.variants||{}).includes(id));
  const canonical=(provider,id)=>findEntry(provider,id)?.id||id;
  const label=(provider,id)=>findEntry(provider,id)?.name||apiProviders.find(p=>p.id===provider)?.model_names?.[id]||id;
  function brand(entry={}){
    const id=String(entry.id||'').toLowerCase(),vendor=String(entry.vendor||'').toLowerCase();
    const rules=[[/midjourney/,'midjourney'],[/seedance|seedream|doubao/,'bytedance'],[/image-nb|banana|gemini|veo/,'google'],[/claude/,'anthropic'],[/deepseek/,'deepseek'],[/qwen|(?:^|-)wan(?:-|$)/,'alibaba'],[/gpt|sora|chatgpt/,'openai'],[/grok|image-gk/,'xai'],[/minimax|hailuo/,'minimax'],[/glm/,'zhipu'],[/kling/,'kling'],[/vidu/,'vidu'],[/suno/,'suno'],[/llama/,'meta'],[/mistral/,'mistral'],[/flux/,'bfl']];
    return rules.find(([re])=>re.test(id))?.[1]||[['openai','openai'],['google','google'],['anthropic','anthropic'],['字节','bytedance'],['bytedance','bytedance'],['阿里','alibaba'],['alibaba','alibaba'],['智谱','zhipu'],['minimax','minimax']].find(([text])=>vendor.includes(text))?.[1]||'';
  }
  function modelIcon(entry){
    const icon=document.createElement('span');icon.className='studio-model-icon';const name=brand(entry);
    if(name){const img=document.createElement('img');img.src='/static/vendor-icons/'+name+'.svg';img.alt=name;img.width=20;img.height=20;icon.append(img);icon.title=entry.vendor&&entry.vendor!=='API'?entry.vendor:name;}
    else{icon.textContent='AI';icon.title='厂商未确认';}
    return icon;
  }
  function optionLabels(html,provider){
    const select=document.createElement('select');select.innerHTML=html;
    for(const option of select.options)if(option.value)option.textContent=label(provider,option.value);
    return select.innerHTML;
  }
  const channelDefaultsKey='studio:model-channel-defaults:v1';
  const readChannelDefaults=()=>{try{const value=JSON.parse(localStorage.getItem(channelDefaultsKey)||'{}');return value&&typeof value==='object'?value:{}}catch{return {}}};
  const rememberChannel=(kind,provider)=>{if(!provider)return;const defaults=readChannelDefaults();defaults[kind]=provider;try{localStorage.setItem(channelDefaultsKey,JSON.stringify(defaults))}catch{}};
  function wrapNewNodeDefaults(name,kind){
    const original=window[name];if(typeof original!=='function')return;
    window[name]=function(...args){const node=original.apply(this,args);if(!node)return node;
      const providerId=readChannelDefaults()[kind],provider=catalogue(kind).find(p=>p.id===providerId);
      if(!provider)return node;
      const models=provider[`${kind}_models`]||[];if(!models.length)return node;
      if(kind==='chat'){node.llmProvider=provider.id;node.model=models[0];if(provider.id==='modelscope')node.llmMsModel=node.model;}
      else{node.apiProvider=provider.id;node.model=models[0];if(kind==='image'&&typeof defaultApiImageResolution==='function')node.resolution=defaultApiImageResolution(node.model);}
      if(typeof render==='function')render();if(typeof scheduleSave==='function')scheduleSave();return node;
    };
  }
  if(!smart){wrapNewNodeDefaults('addLLMNode','chat');wrapNewNodeDefaults('addGeneratorNode','image');wrapNewNodeDefaults('addVideoNode','video');}
  const originalChat=chatModelOptions;
  chatModelOptions=(model,provider)=>optionLabels(originalChat(canonical(provider,model),provider),provider);
  if(!smart){
    const originalImage=imageModelOptions, originalVideo=videoModelOptions;
    imageModelOptions=(model,provider)=>{
      if(provider===dreaminaId){const ids=apiProviders.find(p=>p.id===dreaminaId)?.image_models||[];const chosen=resolveImageModel(model);const all=[...new Set([chosen,...ids].filter(Boolean))];return all.length?all.map(id=>`<option value="${escapeHtml(id)}" ${id===chosen?'selected':''}>${escapeHtml(label(dreaminaId,id))}</option>`).join(''):'<option value="" disabled selected>即梦图片模型不可用</option>';}
      return optionLabels(originalImage(canonical(provider,model),provider),provider);
    };
    videoModelOptions=(model,provider)=>{
      if(provider===dreaminaId){const ids=apiProviders.find(p=>p.id===dreaminaId)?.video_models||[];const chosen=model||ids[0]||'';const all=[...new Set([chosen,...ids].filter(Boolean))];return all.length?all.map(id=>`<option value="${escapeHtml(id)}" ${id===chosen?'selected':''}>${escapeHtml(label(dreaminaId,id))}</option>`).join(''):'<option value="" disabled selected>即梦视频模型不可用</option>';}
      return optionLabels(originalVideo(canonical(provider,model),provider),provider);
    };
    for(const name of ['sanitizeImageNodeProviderModel','sanitizeVideoNodeProviderModel']){
      const original=window[name];window[name]=node=>{
        if(node?.apiProvider===dreaminaId)return node;
        const kind=name==='sanitizeImageNodeProviderModel'?'image':'video';
        const provider=apiProviders.find(p=>p.id===node?.apiProvider);
        if(node?.apiProvider&&(!provider||provider.enabled===false||!(provider[`${kind}_models`]||[]).length))return node;
        if(node?.apiProvider)node.model=canonical(node.apiProvider,node.model);return original(node);
      };
    }
    for(const [name,kind] of [['resolveChatProviderId','chat'],['resolveImageProviderId','image'],['resolveVideoProviderId','video']]){
      const original=window[name];if(typeof original!=='function')continue;
      window[name]=id=>{const provider=apiProviders.find(p=>p.id===id);if(id&&(!provider||provider.enabled===false||!(provider[`${kind}_models`]||[]).length))return id;return original(id);};
    }
    const originalImageProviders=imageApiProviders;
    imageApiProviders=(selectedId)=>{const result=originalImageProviders();if(selectedId===dreaminaId&&!result.some(p=>p.id===dreaminaId)){const p=apiProviders.find(p=>p.id===dreaminaId);if(p)result.push(p);}return result;};
    const originalVideoProviders=videoApiProviders;
    videoApiProviders=(selectedId)=>{const result=originalVideoProviders();if(selectedId===dreaminaId&&!result.some(p=>p.id===dreaminaId)){const p=apiProviders.find(p=>p.id===dreaminaId);if(p)result.push(p);}return result;};
    const originalProviderOptions=providerOptions;
    providerOptions=(selectedId)=>{let html=originalProviderOptions(selectedId);if(selectedId===dreaminaId&&!html.includes(`value="${dreaminaId}"`)){const p=apiProviders.find(p=>p.id===dreaminaId);if(p)html=`<option value="${dreaminaId}" selected>即梦账号 · 需授权</option>${html}`;}return html;};
    const originalVideoProviderOptions=videoProviderOptions;
    videoProviderOptions=(selectedId)=>{let html=originalVideoProviderOptions(selectedId);if(selectedId===dreaminaId&&!html.includes(`value="${dreaminaId}"`)){const p=apiProviders.find(p=>p.id===dreaminaId);if(p)html=`<option value="${dreaminaId}" selected>即梦账号 · 需授权</option>${html}`;}return html;};
  } else {
    for(const [name,kind] of [['renderModelControl','image'],['renderVideoModelControl','video']]){
      const original=window[name];window[name]=function(...args){
        const root=document.createElement('div');root.innerHTML=original.apply(this,args);
        const provider=kind==='image'?settings.provider_id:settings.videoProvider;
        const model=kind==='image'?settings.model:settings.videoModel;
        root.querySelector('.smart-control')?.classList.add('studio-smart-model');
        const sub=root.querySelector('.smart-pill .sub');if(sub)sub.textContent=provider===dreaminaId?'即梦账号 · '+(label(provider,model)||'选择模型'):label(provider,model)||'选择模型';
        root.querySelectorAll('[data-smart-value] span').forEach(span=>span.textContent=label(provider,span.parentElement.dataset.smartValue));
        return root.innerHTML;
      };
    }
  }
  const panel=document.createElement('div');panel.id='studioModelPicker';panel.setAttribute('popover','auto');panel.setAttribute('aria-label','选择模型');document.body.append(panel);
  let anchor=null,selectedSource=null,pickerOwner=null;
  const currentCanvas=()=>typeof canvas==='undefined'?null:canvas;
  const composerOwner=()=>smart&&typeof activeComposerNode==='function'?activeComposerNode():null;
  function captureOwner(button,select=null,key=''){
    const origin=currentCanvas(),id=select?.closest('[data-id]')?.dataset.id;
    const node=id?(nodes||[]).find(n=>n.id===id):key?composerOwner():null;
    return {canvas:origin,canvasId:origin?.id,node,nodeId:id||node?.id||'',select,sourceClass:select&&['model-select','llm-model','video-model','prompt-llm-model'].find(name=>select.classList.contains(name)),key,control:key?button.closest('.studio-smart-model'):null};
  }
  function ownsPicker(owner){
    return Boolean(owner&&owner.canvas&&currentCanvas()===owner.canvas&&currentCanvas().id===owner.canvasId
      &&(!owner.nodeId||Boolean(owner.node)&&(nodes||[]).find(n=>n.id===owner.nodeId)===owner.node)
      &&(!owner.key||composerOwner()===owner.node));
  }
  function liveSource(owner=pickerOwner){
    if(!ownsPicker(owner))return null;
    if(owner.select?.isConnected)return owner.select;
    return owner.nodeId&&owner.sourceClass?document.querySelector(`[data-id="${CSS.escape(owner.nodeId)}"] select.${owner.sourceClass}`):null;
  }
  function liveControl(owner=pickerOwner){
    if(!ownsPicker(owner)||!owner.key)return null;
    if(owner.control?.isConnected)return owner.control;
    return [...(document.getElementById('dynamicParams')||document).querySelectorAll('.studio-smart-model')].find(control=>control.querySelector(`[data-smart-param="${owner.key}"]`))||null;
  }
  function liveTrigger(owner=pickerOwner){
    const trigger=owner?.key?liveControl(owner)?.querySelector('.smart-pill'):liveSource(owner)?.nextElementSibling;
    return trigger&&(owner.key||trigger.classList.contains('studio-model-trigger'))?trigger:null;
  }
  function closePicker(owner=pickerOwner){
    if(owner!==pickerOwner)return;
    if(panel.matches(':popover-open'))panel.hidePopover();anchor?.setAttribute('aria-expanded','false');liveTrigger(owner)?.setAttribute('aria-expanded','false');
    pickerOwner=null;selectedSource=null;anchor=null;panel.replaceChildren();
  }
  function checkPicker(){
    if(!pickerOwner||!panel.matches(':popover-open'))return;
    if(!ownsPicker(pickerOwner)){closePicker();return;}
    if(pickerOwner.key){const control=liveControl();if(control)pickerOwner.control=control;else closePicker();}
    else{const source=liveSource();if(source){pickerOwner.select=selectedSource=source;}else closePicker();}
    if(pickerOwner){const trigger=liveTrigger();if(trigger&&trigger!==anchor){anchor?.setAttribute('aria-expanded','false');anchor=trigger;}anchor?.setAttribute('aria-expanded','true');}
  }
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-model-picker.css?v=4';document.head.append(css);
  const names={chat:'文本模型',image:'图片模型',video:'视频模型'};
  // U04: "常用" per kind, keyed by channel + model and kept on the server.
  let favorites={};
  fetch('/api/studio/model-favorites').then(r=>r.ok?r.json():{}).then(v=>{favorites=v||{};}).catch(()=>{});
  const saveFavorites=kind=>fetch('/api/studio/model-favorites/'+kind,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys:favorites[kind]||[]})}).catch(()=>{});
  function openPicker(button,items,current,choose,kind,owner){
    if(!ownsPicker(owner))return;
    pickerOwner=owner;selectedSource=owner.select;anchor=button;panel.replaceChildren();
    const title=document.createElement('strong');title.textContent=names[kind]||'选择模型';
    const hint=document.createElement('small');hint.textContent=kind==='chat'?'先选调用渠道，再选语言模型':'先选调用渠道，再选模型；节点参数会随模型更新';
    const search=document.createElement('input');search.placeholder='搜索模型或厂商';search.setAttribute('aria-label','搜索画布模型');
    const vendor=document.createElement('select');vendor.setAttribute('aria-label','筛选厂商');vendor.add(new Option('全部厂商',''));
    [...new Set(items.map(m=>m.vendor).filter(Boolean))].sort().forEach(v=>vendor.add(new Option(v,v)));
    const filters=document.createElement('div');filters.className='studio-picker-filters';filters.append(search,vendor);
    let chosenProvider=!smart&&liveSource(owner)?providerFor(liveSource(owner)):null;
    const classicPicker=!smart&&chosenProvider!==null;
    if(chosenProvider!==null){
      items=catalogue(kind).flatMap(p=>(p[kind+'_models']||[]).map(id=>({...findEntry(p.id,id),id,provider_id:p.id,provider_name:p.name||p.id,name:label(p.id,id),vendor:findEntry(p.id,id)?.vendor||p.name||'API',series:p.protocol==='local-comfy'?'本地 ComfyUI':findEntry(p.id,id)?.series||'其他系列'})));
      vendor.replaceChildren(new Option('全部厂商',''));[...new Set(items.map(m=>m.vendor))].sort().forEach(v=>vendor.add(new Option(v,v)));
    }

    const list=document.createElement('div');list.className='studio-picker-list';list.setAttribute('role','listbox');
    const categories=document.createElement('div');categories.className='studio-picker-series';categories.setAttribute('aria-label','模型系列');
    const columns=document.createElement('div');columns.className='studio-picker-columns';columns.append(categories,list);columns.hidden=classicPicker;
    let selectedSeries=items.find(m=>m.id===current)?.series||items[0]?.series||'其他系列';
    const unavailable=document.createElement('div');unavailable.className='studio-picker-unavailable';unavailable.setAttribute('role','status');
    const channel=document.createElement('select');channel.className='studio-channel-select';channel.setAttribute('aria-label','选择调用渠道');channel.dataset.testid='studio-channel-select';
    const enabledChannels=catalogue(kind);
    enabledChannels.forEach(p=>channel.add(new Option(p.name||p.id,p.id)));
    const currentProvider=apiProviders.find(p=>p.id===chosenProvider);
    if(chosenProvider&&!enabledChannels.some(p=>p.id===chosenProvider)){
      const savedName=currentProvider?.name||chosenProvider;const savedOption=new Option(`${savedName}（不可用，保留当前选择）`,chosenProvider);savedOption.dataset.unavailable='true';channel.add(savedOption);channel.value=chosenProvider;
      unavailable.textContent=`当前节点保存的渠道“${savedName}”${currentProvider?'已停用或没有可用模型':'已不存在'}。不会自动切换；请在设置恢复渠道，或手动选择其他渠道。`;
    }else if(enabledChannels.some(p=>p.id===chosenProvider))channel.value=chosenProvider;
    else if(enabledChannels.length){channel.value=enabledChannels[0].id;}
    const channelRow=document.createElement('label');channelRow.className='studio-picker-channel-row';const channelTitle=document.createElement('span');channelTitle.textContent='调用渠道';channelRow.append(channelTitle,channel);channelRow.hidden=!classicPicker;unavailable.hidden=!classicPicker;
    const manage=document.createElement('button');manage.type='button';manage.className='studio-picker-manage';manage.textContent='管理已启用模型';manage.onclick=()=>{panel.hidePopover();document.getElementById('studioSettingsButton')?.click();};
    const favKey=m=>m.provider_id+'|'+m.id,favs=new Set(favorites[kind]||[]);
    // Open on 常用 when there are some; otherwise show everything with a tip.
    let scope=favs.size?'fav':'all';
    const scopes=document.createElement('div');scopes.className='studio-picker-scope';scopes.setAttribute('role','group');scopes.setAttribute('aria-label','模型范围');
    for(const [value,text] of [['fav','常用'],['all','全部模型']]){const b=document.createElement('button');b.type='button';b.dataset.scope=value;b.textContent=text;b.onclick=()=>{scope=value;renderItems();};scopes.append(b);}
    const tip=document.createElement('small');tip.className='studio-picker-tip';
    function renderItems(){
      list.replaceChildren();categories.replaceChildren();scopes.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scope===scope)));tip.textContent=favs.size?'':'还没有常用模型：点模型右侧的 ☆ 加入常用，下次打开会直接显示。';tip.hidden=!tip.textContent;unavailable.hidden=!classicPicker||!unavailable.textContent||channel.value!==chosenProvider;
      const selectedChannel=channel.value;
      const matches=items.filter(m=>(scope==='fav'?favs.has(favKey(m)):(!classicPicker||m.provider_id===selectedChannel))&&(!vendor.value||vendor.value===m.vendor)&&`${m.name} ${m.vendor}`.toLowerCase().includes(search.value.toLowerCase()));
      const groups=[...new Set(matches.map(m=>m.series||'其他系列'))];if(!groups.includes(selectedSeries))selectedSeries=groups[0];
      const flat=classicPicker||scope==='fav';categories.hidden=flat;
      if(!flat)for(const group of groups){const option=document.createElement('button');option.type='button';option.className='studio-series-option';option.dataset.series=group;option.setAttribute('aria-pressed',String(selectedSeries===group));option.textContent=group+' ›';option.onclick=()=>{selectedSeries=group;renderItems();};categories.append(option);}
      const filtered=flat?matches:matches.filter(m=>(m.series||'其他系列')===selectedSeries);
      for(const item of filtered){
        const row=document.createElement('button');row.type='button';row.className='studio-picker-option';row.dataset.model=item.id;row.setAttribute('role','option');row.setAttribute('aria-selected',String(item.id===current));
        const icon=modelIcon(item);
        const text=document.createElement('span');const modelName=document.createElement('b');modelName.textContent=item.name;const sub=document.createElement('small');sub.textContent=[item.provider_name,...(item.capabilities||[])].filter(Boolean).join(' · ');text.append(modelName,sub);
        const selected=item.id===current&&(!classicPicker||item.provider_id===chosenProvider);
        const tick=document.createElement('span');tick.textContent=selected?'✓':'›';row.setAttribute('aria-selected',String(selected));row.append(icon,text,tick);
        row.onclick=event=>{
          event.stopPropagation();
          if(pickerOwner!==owner||!panel.matches(':popover-open')||!ownsPicker(owner)){if(pickerOwner===owner)closePicker(owner);return;}
          closePicker(owner);const applied=choose(item.id,item.provider_id,owner);
          if(applied!==false&&ownsPicker(owner))rememberChannel(kind,item.provider_id);
          if(ownsPicker(owner)){const trigger=liveTrigger(owner);trigger?.setAttribute('aria-expanded','false');trigger?.focus({preventScroll:true});}
        };
        const key=favKey(item),star=document.createElement('button');star.type='button';star.className='studio-picker-star';
        star.setAttribute('aria-pressed',String(favs.has(key)));star.setAttribute('aria-label',(favs.has(key)?'移出常用：':'加入常用：')+item.name);star.textContent=favs.has(key)?'★':'☆';
        star.onclick=event=>{event.stopPropagation();favs.has(key)?favs.delete(key):favs.add(key);favorites[kind]=[...favs];saveFavorites(kind);renderItems();};
        const wrap=document.createElement('div');wrap.className='studio-picker-row';wrap.append(row,star);list.append(wrap);
      }
      // A favourite whose model is disabled or gone stays visible and says so.
      if(scope==='fav')for(const key of favs)if(!items.some(m=>favKey(m)===key)){const gone=document.createElement('div');gone.className='studio-picker-row studio-picker-gone';gone.textContent=key.split('|').slice(1).join('|')+'（已停用或当前不可用）';list.append(gone);}
      if(!filtered.length&&!(scope==='fav'&&favs.size)){const empty=document.createElement('p');empty.textContent=scope==='fav'?'还没有常用模型。切到“全部模型”，点 ☆ 加入常用。':items.length?(classicPicker?'当前渠道没有匹配的模型':'没有匹配的模型'):'尚无已启用模型，请到设置同步模型。';list.append(empty);}
    }
    if(!classicPicker)hint.textContent=kind==='chat'?'选择要使用的语言模型':'根据参考素材自动匹配生成方式';
    search.oninput=renderItems;vendor.onchange=renderItems;channel.onchange=renderItems;panel.append(title,hint,channelRow,unavailable,scopes,tip,filters,classicPicker?list:columns,manage);renderItems();
    const examples=(previewCatalog?.models||[]).filter(model=>model.kind===kind);
    if(examples.length&&previewCatalog.connected===false){
      const preview=document.createElement('details');preview.className='studio-picker-preview';preview.open=!items.some(item=>item.provider_id!=='deepwhite-local-comfy');
      const summary=document.createElement('summary');summary.textContent='官方模型预览 · 登录后自动配置';preview.append(summary);
      const note=document.createElement('p');note.textContent='以下是模型示例，尚未连接，不能生成。登录后会显示你账户实际可用的型号。';preview.append(note);
      for(const model of examples){const row=document.createElement('div');row.className='studio-picker-preview-row';const name=document.createElement('span');name.textContent=model.name||model.id;const state=document.createElement('small');state.textContent='未连接';row.append(name,state);preview.append(row);}
      const connect=document.createElement('button');connect.type='button';connect.textContent='登录 / 连接官方 API';connect.onclick=()=>{closePicker();(document.getElementById('studioAccountButton')||document.getElementById('studioSettingsButton'))?.click();};preview.append(connect);panel.append(preview);
    }
    panel.showPopover();button.setAttribute('aria-expanded','true');
    const r=button.getBoundingClientRect(),w=panel.offsetWidth,h=panel.offsetHeight;
    panel.style.left=`${Math.max(8,Math.min(r.left,innerWidth-w-8))}px`;panel.style.top=`${Math.max(8,r.top>h+10?r.top-h-6:Math.min(r.bottom+6,innerHeight-h-8))}px`;search.focus();
  }
  panel.addEventListener('toggle',e=>{if(e.newState==='closed'&&!panel.matches(':popover-open'))closePicker();});
  for(const type of ['pointerdown','mousedown','dblclick','wheel','keydown'])panel.addEventListener(type,e=>{
    if(type==='keydown'&&e.key==='Escape'){e.preventDefault();const previous=liveTrigger()||anchor;closePicker();if(previous?.isConnected)previous.focus({preventScroll:true});}
    if(type==='keydown'&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const rows=[...panel.querySelectorAll('.studio-picker-option')];const index=rows.indexOf(document.activeElement),next=e.key==='ArrowDown'?index+1:index-1;rows[(next+rows.length)%rows.length]?.focus();}
    e.stopPropagation();
  });
  function providerFor(select,byId){const node=select.closest('[data-id]');const data=byId?byId.get(node?.dataset.id):(nodes||[]).find(n=>n.id===node?.dataset.id);return data?.llmProvider||data?.apiProvider||select.parentElement.querySelector('.provider-select,.llm-provider-select,.video-provider,.prompt-llm-provider')?.value||'';}
  function decorate(roots=null){
    const byId=new Map((nodes||[]).map(node=>[node.id,node]));
    const find=selector=>roots?[...new Set(roots.flatMap(root=>[...(root.matches(selector)?[root]:[]),...root.querySelectorAll(selector)]))]:[...document.querySelectorAll(selector)];
    if(!smart)find('#nodes .node[data-id]').forEach(root=>{
      const node=byId.get(root.dataset.id),head=root.querySelector('.node-head'),title=head?.querySelector('.node-title');
      if(!node||!title)return;
      const id=node.studioKind==='mj'?'midjourney-'+(node.studioMjAction||'imagine'):node.model;
      if(!id)return;
      const entry=findEntry(node.llmProvider||node.apiProvider,id)||{id},stamp=brand(entry)||'unknown';
      let icon=head.querySelector('.studio-node-brand');
      if(icon?.dataset.brand===stamp)return;
      icon?.remove();icon=modelIcon(entry);icon.classList.add('studio-node-brand');icon.dataset.brand=stamp;title.before(icon);
    });
    const selector=smart?'select.prompt-llm-model':'select.model-select,select.llm-model,select.video-model';
    find(selector).forEach(select=>{
      if(!smart){const providerSelect=select.parentElement?.querySelector('.llm-provider-select,.provider-select,.video-provider');providerSelect?.classList.add('studio-provider-native');}
      let button=select.nextElementSibling;
      if(!button?.classList.contains('studio-model-trigger')){
        button=document.createElement('button');button.type='button';button.className='studio-model-trigger';button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');select.classList.add('studio-model-native');select.tabIndex=-1;select.after(button);
        button.onclick=e=>{e.stopPropagation();const provider=providerFor(select),kind=select.matches('.llm-model,.prompt-llm-model')?'chat':select.matches('.video-model')?'video':'image';
          const items=[...select.options].filter(o=>o.value&&!o.disabled).map(o=>({...findEntry(provider,o.value),id:o.value,name:label(provider,o.value),vendor:findEntry(provider,o.value)?.vendor||apiProviders.find(p=>p.id===provider)?.name||'API'}));
          const owner=captureOwner(button,select);
          openPicker(button,items,select.value,(id,pid,owner)=>{
            if(!ownsPicker(owner))return false;
            const previous=liveSource(owner);
            if(!previous)return false;
            if(previous.value!==id||pid&&pid!==provider)pushUndo();
            if(pid&&pid!==provider){const root=liveSource(owner)?.closest('[data-id]'),field=root?.querySelector(kind==='chat'?'.llm-provider-select':kind==='video'?'.video-provider':'.provider-select');if(field){field.value=pid;field.dispatchEvent(new Event('change',{bubbles:true}));}}
            const target=liveSource(owner);if(!target)return false;
            target.value=id;target.dispatchEvent(new Event('change',{bubbles:true}));decorate();return true;
          },kind,owner);
        };
        button.onmousedown=e=>e.stopPropagation();
      }
      const providerId=providerFor(select,byId),provider=apiProviders.find(p=>p.id===providerId),modelValue=select.value;
      const node=byId.get(select.closest('[data-id]')?.dataset.id),savedModel=node?.model||modelValue;
      const value=select.selectedOptions[0]?.textContent||savedModel||'选择模型',entry=findEntry(providerId,savedModel)||{id:savedModel,vendor:provider?.name};
      const unavailable=providerId&&(!provider||provider.enabled===false||!(provider[`${select.matches('.llm-model,.prompt-llm-model')?'chat':select.matches('.video-model')?'video':'image'}_models`]||[]).length);
      const display=unavailable?`渠道不可用：${provider?.name||providerId} · ${value}`:`${provider?.name?provider.name+' · ':''}${value}`;
      const stamp=JSON.stringify([display,brand(entry)]);if(button.dataset.brandStamp!==stamp){button.dataset.brandStamp=stamp;button.replaceChildren(modelIcon(entry),document.createTextNode(display+' ▾'));}button.title=display;
    });
  }
  // Original controls retain their change handlers; the visible picker is a product-level view.
  let scheduled=false,pendingSmartDecoration=false;const pendingRoots=new Set(),modelFields='select.model-select,select.llm-model,select.video-model,select.provider-select,select.llm-provider-select,select.video-provider,.node-head,.node-title,.studio-model-trigger,.studio-node-brand';
  const nodeRoot=document.getElementById('nodes')||document.getElementById('shell');
  const modelObserver=new MutationObserver(records=>{
    if(smart&&records.some(record=>nodeRoot.contains(record.target)))pendingSmartDecoration=true;
    if(!smart)for(const record of records){
      const element=record.target.nodeType===1?record.target:record.target.parentElement;
      const related=element?.closest(modelFields)||[...record.addedNodes,...record.removedNodes].some(item=>item.nodeType===1&&(item.matches(modelFields)||item.querySelector(modelFields)));
      if(related){const card=element?.closest('.node[data-id]');if(card?.isConnected)pendingRoots.add(card);for(const item of record.addedNodes)if(item.nodeType===1){if(item.matches('.node[data-id]'))pendingRoots.add(item);else for(const card of item.querySelectorAll('.node[data-id]'))pendingRoots.add(card);}}
    }
    const invalid=pickerOwner&&(!ownsPicker(pickerOwner)||pickerOwner.select&&!pickerOwner.select.isConnected||pickerOwner.key&&!pickerOwner.control?.isConnected);
    if(!smart&&!pendingRoots.size&&!invalid)return;
    if(!scheduled){scheduled=true;queueMicrotask(()=>{
      scheduled=false;const roots=[...pendingRoots].filter(root=>root.isConnected);pendingRoots.clear();
      if(smart&&pendingSmartDecoration){pendingSmartDecoration=false;decorate();}else if(!smart&&roots.length)decorate(roots);
      checkPicker();
    });}
  });
  modelObserver.observe(nodeRoot,{childList:true,subtree:true});
  if(smart){const controls=document.getElementById('dynamicParams');if(controls&&!nodeRoot.contains(controls))modelObserver.observe(controls,{childList:true,subtree:true});}
  document.addEventListener('click',event=>{
    if(!smart)return;
    const pill=event.target.closest('.smart-control .smart-pill');if(!pill)return;
    if(!pill.parentElement.classList.contains('studio-smart-model'))return;
    const modelButtons=[...pill.parentElement.querySelectorAll('[data-smart-param="model"],[data-smart-param="videoModel"]')];
    event.preventDefault();event.stopImmediatePropagation();
    const key=modelButtons[0]?.dataset.smartParam||(settings.apiKind==='video'?'videoModel':'model'),kind=key==='videoModel'?'video':'image',provider=kind==='video'?settings.videoProvider:settings.provider_id;
    const owner=captureOwner(pill,null,key);
    openPicker(pill,modelButtons.map(b=>({...findEntry(provider,b.dataset.smartValue),id:b.dataset.smartValue,name:label(provider,b.dataset.smartValue),vendor:findEntry(provider,b.dataset.smartValue)?.vendor||'API'})),settings[key],(id,pid,owner)=>{
      const control=liveControl(owner),target=control&&[...control.querySelectorAll(`[data-smart-param="${key}"]`)].find(button=>button.dataset.smartValue===id);
      if(!target||!ownsPicker(owner))return false;target.click();return true;
    },kind,owner);
  },true);
  window.addEventListener('message',event=>{if(event.origin===location.origin&&(event.data?.type==='providers-changed'||event.data?.type==='dreamina-changed')){if(panel.matches(':popover-open'))panel.hidePopover();Promise.all([getCatalog(),getDreamina()]).then(refreshDreaminaPickers);}});
  try{const channel=new BroadcastChannel('studio-dreamina');channel.onmessage=()=>Promise.all([getCatalog(),getDreamina()]).then(refreshDreaminaPickers);}catch{}
  decorate();
})();
