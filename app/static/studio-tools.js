/* Real canvas price evidence and action-specific MJ tools. Core canvas storage/links stay native. */
(() => {
  const smart=!!document.querySelector('.smart-back');
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let catalogs={}, specs={};
  async function api(url,body){
    const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    let data;try{data=await r.json();}catch{throw Object.assign(Error('MJ 响应无法读取，请查询原任务或核对平台记录，勿重复生成。'),{status:r.status});}
    if(!r.ok)throw Object.assign(Error(typeof data.detail==='string'?data.detail:'请求失败，请查询原任务或核对平台记录。'),{status:r.status});return data;
  }
  async function load(){
    const results=await Promise.allSettled([api('/api/studio/model-catalog').then(d=>d.providers),api('/api/studio/mj/actions')]);
    if(results[0].status==='fulfilled')catalogs=results[0].value;
    if(results[1].status==='fulfilled')specs=results[1].value;
    if(!smart&&typeof canvas!=='undefined'&&canvas)render();
    schedule();
  }
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-tools.css?v=1';document.head.append(css);
  const enabled=(provider,action)=>catalogs[provider]?.models?.some(m=>m.id==='midjourney-'+action&&m.enabled!==false&&!m.removed&&m.available!==false);
  const providers=()=>apiProviders.filter(p=>p.enabled!==false&&p.has_key&&catalogs[p.id]?.models?.some(m=>m.id.startsWith('midjourney-')&&m.enabled!==false&&!m.removed));
  const actions=provider=>Object.keys(specs).filter(a=>a!=='imagine'&&enabled(provider,a));
  const references=node=>smart?directImageInputsFor(node).flatMap(n=>n.images||[]):orderedSources(node,generatorSources(node)).flatMap(s=>s.refs||[]);
  function mjParams(node,action){
    const fields=specs[action]?.fields||[],params={};
    const values=node.studioMjParams||{};
    for(const key of fields){if(values[key]!==undefined&&values[key]!=='')params[key]=values[key];}
    if(fields.includes('task_id')&&!params.task_id){
      const upstream=smart?inputNodesFor(node):connections.filter(c=>c.to===node.id&&c.studioRole!=='agent-workflow').map(c=>nodes.find(n=>n.id===c.from)).filter(Boolean);
      const source=upstream.find(n=>(n.studioMjRequest?.provider_id||n.apiProvider)===node.apiProvider&&(n.studioMjTask||n.lastTaskId));
      if(source)params.task_id=source.studioMjTask||source.lastTaskId;
    }
    if(fields.includes('image_urls')){
      params.image_urls=[...(node.studioMjImages||[]),...references(node).filter(r=>['image',undefined].includes(r.kind)&&r.role!=='mask')].map(r=>r.url).filter(Boolean);
      if(!params.image_urls.length||(action==='video'&&params.task_id))delete params.image_urls;
    }
    if(fields.includes('prompt')){
      const inherited=smart?inputNodesFor(node).map(n=>n.text||n.prompt||'').join('\n'):orderedSources(node,generatorSources(node)).map(s=>s.prompt||'').join('\n');
      params.prompt=(action==='imagine'&&node.studioPrompt!==undefined)?inherited.trim():(values.prompt||inherited.trim());
    }
    if(fields.includes('speed'))params.speed=params.speed||'relax';
    if(action==='imagine'){params.version=params.version||'8.2';params.size=params.size||'1:1';}
    return params;
  }
  const mjCount=node=>{const count=Number(node.count||1);return Number.isFinite(count)?Math.max(1,Math.min(8,Math.floor(count))):1;};
  window.StudioMidjourney={params:mjParams,count:mjCount,summary:node=>{const p=mjParams(node,'imagine');return [p.size,'MJ '+p.version,{relax:'Relax',fast:'Fast',turbo:'Turbo'}[p.speed]||p.speed,mjCount(node)+' 次'].join(' / ');}};
  const labels={prompt:'提示词',task_id:'来源任务编号',index:'选择原结果中的图片',custom_id:'任务按钮编号（可选）',speed:'速度',version:'版本',size:'比例',dimensions:'融合比例',zoom_ratio:'扩展倍数',direction:'平移方向',mask_url:'遮罩图片地址',video_type:'视频规格',animate_mode:'动画方式',motion:'运动幅度',batch_size:'视频数量',end_url:'尾帧图片地址',stylize:'风格化',chaos:'多样性',weird:'奇异度',niji:'动漫模式'};
  const choices={speed:[['relax','Relax'],['fast','Fast'],['turbo','Turbo']],version:['8.2','8.1','7','6.1','5.2','5.1'],size:['1:1','3:4','4:3','9:16','16:9','21:9'],dimensions:[['SQUARE','1:1'],['PORTRAIT','2:3'],['LANDSCAPE','3:2']],zoom_ratio:[1.5,2],direction:[['left','向左'],['right','向右'],['up','向上'],['down','向下']],video_type:[['vid_1.1_i2v_480','480p'],['vid_1.1_i2v_720','720p'],['vid_1.1_i2v_start_end_480','首尾帧 480p'],['vid_1.1_i2v_start_end_720','首尾帧 720p']],animate_mode:[['manual','手动'],['auto','自动']],motion:[['low','低'],['high','高']],batch_size:[1,2,4]};
  const numbers=new Set(['index','zoom_ratio','batch_size','stylize','chaos','weird']);
  function fieldsHtml(node,action){
    const params=mjParams(node,action),fields=specs[action]?.fields||[];
    return fields.filter(k=>k!=='image_urls'&&k!=='niji'&&!(action==='imagine'&&node.type==='generator'&&k==='prompt')).map(key=>{
      const options=key==='index'?[[1,'第 1 张'],[2,'第 2 张'],[3,'第 3 张'],[4,'第 4 张']].map(([n,label])=>[action==='video'?n-1:n,label]):choices[key];
      const value=params[key]??'';
      const control=options?`<select data-mj-field="${key}"><option value="">${key==='index'?'未选择':'使用默认'}</option>${options.map(o=>{const [v,l]=Array.isArray(o)?o:[o,o];return `<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(l)}</option>`;}).join('')}</select>`:
        key==='prompt'?`<textarea data-mj-field="prompt" placeholder="可填写，或连接文本节点">${esc(node.studioMjParams?.prompt||'')}</textarea>`:
        `<input data-mj-field="${key}" type="${numbers.has(key)?'number':'text'}" value="${esc(value)}" placeholder="${key==='task_id'?'连接 MJ 结果，或粘贴任务编号':''}">`;
      return `<label class="studio-mj-field"><span>${labels[key]}${specs[action].required.includes(key)?' *':''}</span>${control}</label>`;
    }).join('');
  }
  function makePanel(node,imagine=false){
    const wrap=document.createElement('div');wrap.className='studio-mj-panel';
    const list=providers();
    if(!node.apiProvider)node.apiProvider=list[0]?.id||'';
    let action=imagine?'imagine':node.studioMjAction||actions(node.apiProvider)[0]||'blend';
    if(!imagine)node.studioMjAction=action;
    const state=node.studioMjState;
    const taskChoices=nodes.filter(n=>n.id!==node.id&&(n.studioMjRequest?.provider_id||n.apiProvider)===node.apiProvider&&(n.studioMjTask||n.lastTaskId));
    wrap.innerHTML=`${imagine?'':`<div class="studio-mj-row"><label>API 平台<select class="studio-mj-provider">${list.map(p=>`<option value="${esc(p.id)}" ${node.apiProvider===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>MJ 功能<select class="studio-mj-action">${actions(node.apiProvider).map(a=>`<option value="${a}" ${action===a?'selected':''}>${esc(specs[a].label)}</option>`).join('')}</select></label></div>`}
      <p class="studio-mj-help">${imagine?'MJ 返回四宫格；放大、变体等在「MJ 工具」中操作。':specs[action]?.result==='text'?'输出文字描述，可作为后续提示词。':action==='inpaint'?'先准备局部重绘任务，完成后进入提交遮罩步骤。':action==='modal'?'PNG 透明区域重绘、白色区域保留；使用准备步骤返回的任务编号。':'通过连接素材、上传图片或选择来源任务执行此操作。'}</p>
      ${specs[action]?.fields.includes('task_id')?`<label class="studio-mj-field"><span>使用画布内的 MJ 任务</span><select class="studio-mj-source"><option value="">手动填写 / 保留当前</option>${taskChoices.map(n=>`<option value="${esc(n.studioMjTask||n.lastTaskId)}">${esc(n.title||n.studioMjAction||'MJ 文生图')} · ${esc((n.studioMjTask||n.lastTaskId).slice(-10))}</option>`).join('')}</select></label>`:''}
      <div class="studio-mj-fields">${fieldsHtml(node,action)}</div>
      ${specs[action]?.fields.includes('image_urls')?`<div class="studio-mj-assets"><span>参考图片：${(mjParams(node,action).image_urls||[]).length} 张</span><button type="button" class="studio-mj-upload">上传图片</button><button type="button" class="studio-mj-clear">清除上传</button></div>`:''}
      ${specs[action]?.fields.includes('mask_url')?'<button type="button" class="studio-mj-mask">上传 PNG 遮罩</button>':''}
      <div class="studio-price" role="status">正在读取估价…</div>
      ${imagine?'':`<button type="button" class="gen-btn studio-mj-run" ${node.running||!enabled(node.apiProvider,action)?'disabled':''}>${node.running?'处理中…':'执行'+esc(specs[action]?.label||'操作')}</button>`}
      ${node.studioMjTask?`<div class="studio-mj-task">任务：${esc(node.studioMjTask)}</div>`:''}${node.studioMjTask||node.studioMjHistory?'<button type="button" class="studio-mj-query">查询已有任务（不重新生成）</button>':''}
      ${state?`<p class="studio-mj-state">${esc(state)}</p>`:''}${node.studioMjText?`<textarea class="studio-mj-text" readonly>${esc(node.studioMjText)}</textarea><button type="button" class="studio-mj-text-node">添加为文本节点</button>`:''}`;
    for(const event of ['pointerdown','mousedown','dblclick','wheel'])wrap.addEventListener(event,e=>e.stopPropagation());
    wrap.querySelectorAll('[data-mj-field]').forEach(input=>input.oninput=()=>{node.studioMjParams??={};node.studioMjParams[input.dataset.mjField]=numbers.has(input.dataset.mjField)&&input.value!==''?Number(input.value):input.value;scheduleSave();schedule();});
    wrap.querySelector('.studio-mj-provider')?.addEventListener('change',e=>{node.apiProvider=e.target.value;node.studioMjAction=actions(node.apiProvider)[0];node.studioMjParams={};rerender();});
    wrap.querySelector('.studio-mj-action')?.addEventListener('change',e=>{node.studioMjAction=e.target.value;rerender();});
    wrap.querySelector('.studio-mj-source')?.addEventListener('change',e=>{if(e.target.value){node.studioMjParams??={};node.studioMjParams.task_id=e.target.value;rerender();}});
    async function upload(mask){
      const input=document.createElement('input');input.type='file';input.accept=mask?'image/png':'image/*';input.multiple=!mask;
      input.onchange=async()=>{if(!input.files.length)return;try{const form=new FormData();for(const file of input.files)form.append('files',file);const r=await fetch('/api/ai/upload',{method:'POST',body:form});if(!r.ok)throw Error('上传失败');const result=await r.json();if(mask){node.studioMjParams??={};node.studioMjParams.mask_url=result.files[0]?.url||'';}else node.studioMjImages=[...(node.studioMjImages||[]),...result.files];rerender();}catch(e){node.studioMjState=e.message;rerender();}};input.click();
    }
    wrap.querySelector('.studio-mj-upload')?.addEventListener('click',()=>upload(false));
    wrap.querySelector('.studio-mj-mask')?.addEventListener('click',()=>upload(true));
    wrap.querySelector('.studio-mj-clear')?.addEventListener('click',()=>{node.studioMjImages=[];rerender();});
    wrap.querySelector('.studio-mj-run')?.addEventListener('click',()=>run(node,action));
    wrap.querySelector('.studio-mj-query')?.addEventListener('click',()=>resume(node));
    wrap.querySelector('.studio-mj-text-node')?.addEventListener('click',()=>{pushUndo();if(smart){const n=createPromptNode(node.x+400,node.y,{select:false});n.text=node.studioMjText;}else addNode({id:uid('prompt'),type:'prompt',x:node.x+450,y:node.y,text:node.studioMjText});rerender();});
    const quote=wrap.querySelector('.studio-price');quote._studioRequest=()=>({provider_id:node.apiProvider,model:'midjourney-'+action,kind:action==='video'?'video':'image',params:mjParams(node,action),image_count:(mjParams(node,action).image_urls||[]).length,count:action==='imagine'?mjCount(node):1});
    return wrap;
  }
  function rerender(){render();scheduleSave();schedule();}
  async function accept(node,result,context){
    node.studioMjStatus=result.status;node.studioMjRemoteStatus=result.remote_status||result.status;node.studioMjMediaStatus=result.media_status||'';
    if(result.status==='failed'||result.status==='paused'||result.status==='uncertain')throw Object.assign(Error(result.error||'MJ 任务待核对，请查询原任务。'),{mjStatus:result.status});
    if(result.status==='modal'){
      node.studioMjAction='modal';node.studioMjParams??={};node.studioMjParams.task_id=node.studioMjTask;node.studioMjState='选区准备完成：请填写提示词并上传遮罩，再执行重绘。';return true;
    }
    if(result.status!=='succeeded')return false;
    if(!result.images?.length&&!result.videos?.length&&!result.text)throw Error('任务已完成但没有返回可用结果，请在 API 网站核对任务。');
    if(node.studioMjCompleted===(node.studioMjTask||node.studioMjHistory)&&(node.studioMjTask||node.studioMjHistory)){node.studioMjState='已完成';return true;}
    const outputs=[...(result.images||[]).map(url=>({url,kind:'image'})),...(result.videos||[]).map(url=>({url,kind:'video'}))];
    node.studioMjText=result.text||'';node.studioMjState='已完成';node.studioMjCompleted=node.studioMjTask||node.studioMjHistory;node.studioMjUsage=result.usage||null;
    if(smart){node.images=[...(node.images||[]),...outputs];}
    else if(outputs.length){const out=outputForNode(node,460);const runInfo=runSnapshot(node,context.params?.prompt||'',[]);runInfo.request={task_id:node.studioMjTask,provider_id:context.provider_id,model:'midjourney-'+context.action,params:{...context.params}};appendOutputImages(out,outputs,null,[{runMs:0,run:runInfo}]);mergeGeneratedOutputs(node,outputs,true);addGenerationLog({run:runInfo,outputs,runMs:0});}
    return true;
  }
  const polling=new Set();
  const taskContext=node=>node.studioMjRequest||{provider_id:node.apiProvider,action:node.studioMjAction||'imagine',params:mjParams(node,node.studioMjAction||'imagine')};
  async function query(node,context){return node.studioMjTask?api(`/api/studio/mj/tasks/${encodeURIComponent(node.studioMjTask)}?provider_id=${encodeURIComponent(context.provider_id)}`):api(`/api/studio/mj/history/${encodeURIComponent(node.studioMjHistory)}/resume`,{});}
  async function persistAttempt(node,context){
    const attempt=uid('mj-attempt');node.studioMjAttempt=attempt;
    try{
      if(!context.canvas_id)throw Error('画布尚未保存');
      await saveCanvas();
      // Native saveCanvas handles errors internally. Read back this exact attempt
      // before permitting the paid POST, including when a save conflicts or is in flight.
      const saved=await api('/api/canvases/'+encodeURIComponent(context.canvas_id));
      const stored=saved.canvas?.nodes?.find(n=>n.id===node.id);
      if(!nodes.includes(node)||stored?.studioMjAttempt!==attempt||stored.studioMjStatus!=='submitting'||stored.studioMjTask||stored.studioMjHistory||JSON.stringify(stored.studioMjRequest)!==JSON.stringify(context))throw Error('任务状态尚未保存');
    }catch{throw Object.assign(Error('MJ 任务未提交：画布保存失败或存在冲突。请先保存画布再生成。'),{mjStatus:'failed'});}
  }
  async function track(node,result,context=taskContext(node)){
    const task=node.studioMjTask,history=node.studioMjHistory;
    let displayedTask='';
    for(let i=0;i<450;i++){
      if(!nodes.includes(node)||node.studioMjTask!==task||node.studioMjHistory!==history)return false;
      if(await accept(node,result,context))return true;
      const state='任务处理中，可以稍后查询；请勿重复提交。';
      // Polling is not a canvas change. Rebuilding nodes here removes the MJ
      // panel until its decorator runs, changing height and stealing input focus.
      if(node.studioMjState!==state||displayedTask!==task){
        node.studioMjState=state;displayedTask=task;rerender();
      }
      await new Promise(r=>setTimeout(r,4000));
      if(!nodes.includes(node))return;
      result=await query(node,context);
    }
    throw Error('任务尚未完成，稍后点击“查询已有任务”继续查看。');
  }
  async function run(node,action){
    if(!node||node.running||polling.has(node.id))return;
    if(['pending','paused','submitting'].includes(node.studioMjStatus)&&(node.studioMjTask||node.studioMjHistory))return resume(node);
    if(['uncertain','submitting'].includes(node.studioMjStatus)){node.studioMjStatus='uncertain';node.studioMjState='提交结果待核对，请先查看平台记录，勿重复提交。';rerender();return;}
    const context=JSON.parse(JSON.stringify({provider_id:node.apiProvider,action,params:mjParams(node,action),canvas_id:canvas?.id||'',node_id:node.id}));
    delete node.studioHistoryRestored;
    const count=action==='imagine'?mjCount(node):1;let received=false;
    polling.add(node.id);node.running=true;node.studioMjState='正在提交…';node.studioMjAction=action;rerender();
    try{
      for(let i=0;i<count;i++){
        received=false;
        // Each paid attempt has its own receipt. A reload during submission must
        // never query the previous successful task or submit the new attempt again.
        if(node.studioMjTask||node.studioMjHistory){
          node.studioMjPastTasks??=[];node.studioMjPastTasks.push({task_id:node.studioMjTask,history_id:node.studioMjHistory,request:node.studioMjRequest,status:node.studioMjStatus});
        }
        node.studioMjRequest=JSON.parse(JSON.stringify(context));node.studioMjTask='';node.lastTaskId='';node.studioMjHistory='';node.studioMjCompleted='';node.studioMjStatus='submitting';node.studioMjState='正在提交…';
        rerender();await persistAttempt(node,context);
        const result=await api('/api/studio/mj/submit',context);received=true;
        if(!nodes.includes(node))return;
        node.studioMjRequest=JSON.parse(JSON.stringify(context));node.studioMjTask=result.task_id||'';node.lastTaskId=result.task_id||'';node.studioMjHistory=result.history_id||'';node.studioMjCompleted='';scheduleSave();if(!await track(node,result,context))return;
      }
      node.runStatus='done';node.runError='';
    }catch(e){failure(node,e,received);}
    finally{node.running=false;polling.delete(node.id);rerender();}
  }
  function failure(node,e,received=true){
    node.studioMjStatus=e.mjStatus||(received?'paused':e.status>=400&&e.status<500?'failed':'uncertain');
    node.studioMjState=e.message+(node.studioMjStatus==='uncertain'?'；提交结果待核对，请先查看平台记录，勿重复提交。':node.studioMjStatus==='paused'?'；请继续查询原任务，勿重复生成。':'');
    node.runError=node.studioMjState;node.runStatus=node.studioMjStatus==='failed'?'failed':node.studioMjStatus;
  }
  async function resume(node){
    if(polling.has(node.id)||(!node.studioMjTask&&!node.studioMjHistory))return;
    const context=taskContext(node);polling.add(node.id);node.running=true;rerender();
    try{if(await track(node,await query(node,context),context)){node.runStatus='done';node.runError='';}}
    catch(e){failure(node,e);}finally{node.running=false;polling.delete(node.id);rerender();}
  }
  window.studioAddMj=point=>{
    const node=smart?createNode(point.x,point.y,[],{select:false}):addNode({id:uid('mj'),type:'midjourney',x:point.x,y:point.y,inputs:[]});
    node.studioKind='mj';node.title='MJ 工具';node.apiProvider=providers()[0]?.id||'';node.studioMjAction=actions(node.apiProvider)[0]||'blend';
    if(smart){selectedId=node.id;selectedIds=[];selectedImage={nodeId:'',index:-1};}else{selected.clear();selected.add(node.id);}rerender();return node;
  };
  if(!smart){
    renderMidjourneyBody=node=>makePanel(node);
    runMidjourneyNode=(id)=>run(nodes.find(n=>n.id===id),nodes.find(n=>n.id===id)?.studioMjAction||'blend');
    const originalRun=runGenerator;
    runGenerator=(id,opts)=>{const node=nodes.find(n=>n.id===id);return node?.model==='midjourney-imagine'?run(node,'imagine'):originalRun(id,opts);};
    const originalSources=generatorSources,originalRefs=generatedImageRefs,originalMerge=mergeGeneratedOutputs;
    generatorSources=node=>{
      const result=originalSources(node);
      for(const c of connections.filter(c=>c.to===node.id&&c.studioRole!=='agent-workflow')){
        const n=nodes.find(n=>n.id===c.from);if(n?.studioMjText)result.push({id:n.id+':mj-text',type:'prompt',label:'MJ 图片描述',prompt:n.studioMjText,refs:[]});
      }
      return result;
    };
    generatedImageRefs=node=>node?.studioKind==='mj'?(node.generatedOutputs||[]).map((item,index)=>({url:outputUrlValue(item),kind:mediaKindForOutputItem(item),index})):originalRefs(node);
    mergeGeneratedOutputs=(node,outputs,append=false)=>{
      if(node?.studioKind!=='mj')return originalMerge(node,outputs,append);
      node.generatedOutputs=append?[...(node.generatedOutputs||[]),...outputs]:outputs;
      syncConnectedOutputsFromGenerated(node,outputs);
    };
  }else{
    document.getElementById('runBtn').addEventListener('click',e=>{const node=activeSettingsSubject();if(node?.studioKind==='mj'){e.preventDefault();e.stopImmediatePropagation();run(node,node.studioMjAction||'blend');}},true);
  }
  const quoteCache=new Map();
  async function updateQuote(el,body){
    const key=JSON.stringify(body);if(el.dataset.quoteKey===key&&Date.now()-Number(el.dataset.quoteTime||0)<60000)return;el.dataset.quoteKey=key;el.dataset.quoteTime=Date.now();el.textContent='正在读取估价…';
    if(!body.provider_id||!body.model){el.textContent='请先选择 API 平台和模型';return;}
    try{
      let cached=quoteCache.get(key);if(!cached||Date.now()-cached.time>60000){cached={time:Date.now(),promise:api('/api/studio/quote',body)};quoteCache.set(key,cached);}
      const result=await cached.promise;if(!el.isConnected||el.dataset.quoteKey!==key)return;
      el.replaceChildren();const value=document.createElement('b');value.textContent=result.label;const note=document.createElement('small');note.textContent=result.note;el.append(value,note);el.title=result.note;
    }catch{quoteCache.delete(key);if(el.dataset.quoteKey===key)el.textContent='估价暂不可用，以实际账单为准';}
  }
  function regularQuote(node,kind,config=node){
    const stageQuote=window.studioGenerationQuote?.(node);if(stageQuote)return stageQuote;
    const refs=references(node),imageCount=refs.filter(r=>r.kind==='image'||(!r.kind&&/\.(png|jpe?g|webp)(?:\?|$)/i.test(r.url||''))).length;
    return {provider_id:kind==='chat'?node.llmProvider:smart?(kind==='video'?config.videoProvider:config.provider_id):node.apiProvider,model:smart?(kind==='video'?config.videoModel:config.model):node.model,kind,count:kind==='image'?Math.max(1,Math.min(8,Number(config.count||1))):1,image_count:imageCount,
      video_count:refs.filter(r=>r.kind==='video').length,audio_count:refs.filter(r=>r.kind==='audio').length,multimodal:kind==='video'?!!(smart?config.videoMultimodal:node.multimodal):null,
      params:{resolution:kind==='video'?(config.videoResolution??config.resolution):(config.resolution||'auto'),quality:config.quality||'auto',duration:config.videoDuration??config.duration??5,aspect_ratio:kind==='video'?(config.videoAspect||config.aspectRatio||'16:9'):(typeof API_RATIO_VALUES!=='undefined'?API_RATIO_VALUES[config.ratio]:config.ratio)||'',generate_audio:!!(smart?config.videoGenerateAudio:config.generateAudio),speed:'relax'}};
  }
  function decorate(){

    if(smart){
      const node=activeSettingsSubject(),composer=document.getElementById('composer');if(!node||!composer)return;
      const tool=node.studioKind==='mj';composer.classList.toggle('studio-mj-composer',tool);
      let panel=composer.querySelector('.studio-mj-panel');
      if(tool){const stamp=JSON.stringify([node.id,node.studioMjAction,node.apiProvider,node.running,node.studioMjState]);if(panel?.dataset.stamp!==stamp){panel?.remove();panel=makePanel(node);panel.dataset.stamp=stamp;composer.querySelector('.composer-card').append(panel);}}
      else{panel?.remove();let price=composer.querySelector('.studio-composer-price');if(!price){price=document.createElement('div');price.className='studio-price studio-composer-price';composer.querySelector('.composer-actions').prepend(price);}updateQuote(price,regularQuote(node,settings.apiKind==='video'?'video':'image',settings));}
    }else{
      document.querySelectorAll('#nodes [data-id]').forEach(root=>{
        const node=nodes.find(n=>n.id===root.dataset.id);if(!node||!['generator','video','llm'].includes(node.type))return;
        const host=root.querySelector('.gen-run-row')||root.querySelector('.llm-body');if(!host)return;
        const mj=node.type==='generator'&&node.model==='midjourney-imagine';let panel=root.querySelector('.studio-mj-panel');
        root.classList.toggle('studio-mj-imagine',mj);
        if(mj){if(!panel){panel=makePanel(node,true);const popup=root.querySelector('.studio-universal-params');if(popup){popup.append(panel);const price=panel.querySelector('.studio-price');if(price){price.classList.add('studio-regular-price');host.querySelector('.gen-btn').before(price);}}else host.before(panel);}if(!host.classList.contains('studio-image-footer'))root.querySelectorAll('.studio-regular-price').forEach(e=>e.remove());}
        else{panel?.remove();let el=root.querySelector('.studio-regular-price');if(!el){el=document.createElement('div');el.className='studio-price studio-regular-price';if(host.classList.contains('studio-image-footer'))host.querySelector('.gen-btn').before(el);else host.before(el);}updateQuote(el,regularQuote(node,node.type==='video'?'video':node.type==='llm'?'chat':'image'));}
      });
    }
    document.querySelectorAll('.studio-price').forEach(el=>{if(el._studioRequest)updateQuote(el,el._studioRequest());});
  }
  let timer;function schedule(){clearTimeout(timer);timer=setTimeout(decorate,180);}
  new MutationObserver(schedule).observe(document.getElementById('shell'),{childList:true,subtree:true});
  for(const event of ['change','input','click'])document.addEventListener(event,schedule);
  window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='providers-changed')load().catch(()=>{});});
  setInterval(()=>{if(!document.hidden)schedule();},15000);
  schedule();load().catch(()=>{});
})();
