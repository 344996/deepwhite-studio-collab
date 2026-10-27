(() => {
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-runninghub.css';document.head.append(css);
  const inflight=new Set(),waiting=new Map();
  // U07: defaults from Settings → RunningHub apply to RH nodes created from now on only.
  let rhDefaults={default_payment:'free',default_instance:''};
  const loadRhDefaults=()=>fetch('/api/studio/settings/runninghub').then(r=>r.ok?r.json():null).then(v=>{if(v)rhDefaults=v;}).catch(()=>{});
  loadRhDefaults();window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='providers-changed')loadRhDefaults();});
  const addRhOld=addRhNode;
  addRhNode=point=>{const node=addRhOld(point);if(node){node.rhPayment=rhDefaults.default_payment==='wallet'?'wallet':'free';node.instanceType=rhDefaults.default_instance==='plus'?'plus':'';render();scheduleSave();}return node;};
  // Keep each saved node's imported definition stable when its library entry changes.
  const selectOld=applyRhEntrySelection,refOld=rhSelectedEntryRef;
  applyRhEntrySelection=(node,ref)=>{
    const key=runningHubEntryKey(ref.kind,ref.id);
    selectOld(node,ref);
    if(node.studioRhDefinition?.key!==key){
      const entry=ref.entry||runningHubEntries(ref.kind).find(e=>runningHubEntryId(e,ref.kind)===ref.id);
      if(entry)node.studioRhDefinition={key,kind:ref.kind,id:ref.id,entry:JSON.parse(JSON.stringify(entry))};
    }
  };
  rhSelectedEntryRef=node=>{
    const pinned=node?.studioRhDefinition;
    return pinned&&node.rhConfigKey===pinned.key?{kind:pinned.kind,id:pinned.id,entry:pinned.entry}:refOld(node);
  };
  const appConfigOld=currentRunningHubAppConfig,workflowEntryOld=currentRunningHubWorkflowEntry;
  currentRunningHubAppConfig=node=>node?.studioRhDefinition?.kind==='app'?node.studioRhDefinition.entry:appConfigOld(node);
  currentRunningHubWorkflowEntry=node=>node?.studioRhDefinition?.kind==='workflow'?node.studioRhDefinition.entry:workflowEntryOld(node);
  // Keep the saved/manual values and the media ordering identical in the editor
  // and the payload. In particular, zero is an order/value, not a missing value.
  const order=field=>field.imageOrder!==undefined&&field.imageOrder!==null&&String(field.imageOrder).trim()!==''&&Number.isFinite(Number(field.imageOrder))?Number(field.imageOrder):9999;
  const fieldsOld=rhActiveFields;
  rhActiveFields=node=>fieldsOld(node).sort((a,b)=>{
    const ak=rhFieldKind(a),bk=rhFieldKind(b);
    if(ak==='image'&&bk==='image')return order(a)-order(b)||String(a.nodeId??'').localeCompare(String(b.nodeId??''),undefined,{numeric:true})||String(a.fieldName??'').localeCompare(String(b.fieldName??''));
    return 0;
  });
  rhFieldIndexes=fields=>{
    const counters={image:0,video:0,audio:0},map={};
    [...(fields||[])].sort((a,b)=>{const ak=rhFieldKind(a),bk=rhFieldKind(b);return ak==='image'&&bk==='image'?order(a)-order(b):ak==='image'?-1:bk==='image'?1:0;}).forEach(field=>{
      const kind=rhFieldKind(field);if(kind in counters)map[rhParamKey(field.nodeId,field.fieldName)]=counters[kind]++;
    });return map;
  };
  const valueOld=rhFieldValue;
  const randomSeed=field=>rhRandomEnabled(field)&&/seed|种子/i.test([field.fieldName,field.label,field.note].join(' '));
  function seedInteger(raw,fallback,label){
    if(raw===undefined||raw===null||String(raw).trim()==='')return fallback;
    if(typeof raw==='number'&&!Number.isSafeInteger(raw))throw Error(label+'超出精确整数范围，请以字符串填写种子范围。');
    if(!/^[+-]?\d+$/.test(String(raw).trim()))throw Error(label+'必须为整数。');
    return BigInt(String(raw).trim());
  }
  function seedRange(field){
    const min=seedInteger(field.min,0n,'种子最小值'),max=seedInteger(field.max,4294967295n,'种子最大值'),step=seedInteger(field.step,1n,'种子步长');
    if(max<min)throw Error('种子最大值不能小于最小值。');
    if(step<=0n)throw Error('种子步长必须大于0。');
    return {min,max,step};
  }
  function freshSeed(field){
    const {min,max,step}=seedRange(field),span=(max-min)/step+1n;
    let rank=0n;
    if(span>1n){
      const bits=(span-1n).toString(2).length,words=new Uint32Array(Math.ceil(bits/32)),mask=(1n<<BigInt(bits))-1n;
      do{crypto.getRandomValues(words);rank=0n;for(const word of words)rank=(rank<<32n)|BigInt(word);rank&=mask;}while(rank>=span);
    }
    const value=min+rank*step;
    return value>=BigInt(Number.MIN_SAFE_INTEGER)&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):value.toString();
  }
  rhFieldValue=(node,field,media)=>{
    const kind=rhFieldKind(field),param=node.rhParams?.[rhParamKey(field.nodeId,field.fieldName)];
    if(randomSeed(field)&&rhRandomActive(node,rhParamKey(field.nodeId,field.fieldName))){
      const key=rhParamKey(field.nodeId,field.fieldName);node.rhRandomValues=node.rhRandomValues||{};
      // Invalid imported schemas remain editable; submission reports the error.
      try{if(node.rhRandomValues[key]===undefined)node.rhRandomValues[key]=freshSeed(field);return node.rhRandomValues[key];}
      catch{return param?.value??rhDefaultValue(field);}
    }
    if(['image','video','audio'].includes(kind)&&(param?.sourceFromUpstream??field.sourceFromUpstream)===false)return param?.value??rhDefaultValue(field);
    if(rhFieldRole(field)==='prompt'&&(param?.sourceFromUpstream??field.sourceFromUpstream)===false)return param?.value??rhDefaultValue(field);
    return valueOld(node,field,media);
  };
  function readable(detail,fallback){
    const value=typeof detail==='string'?detail:detail?.message||detail?.error||fallback;
    return String(value||fallback).replace(/https?:\/\/[^\s<>"']+/gi,'[链接已隐藏]').replace(/((?:api[-_]?key|authorization|access[-_]?token|token|secret)["']?\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s,;"']+/gi,'$1[已隐藏]').replace(/Bearer\s+[A-Za-z0-9._~-]+/gi,'Bearer [已隐藏]').slice(0,800);
  }
  async function api(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(readable(d.detail||d.error,'RH 请求失败'));return d;}
  rhUploadValueIfNeeded=async(value,node,kind='')=>{
    const text=String(value??'').trim();if(!text)return '';
    // Every site-relative path (outputs, uploads, asset versions) is a local file RH cannot read:
    // upload it, or fail. RH file names such as "api/x.png" have no leading slash.
    if(!/^https?:\/\//i.test(text)&&!text.startsWith('/'))return text;
    try{
      const data=await api('/api/runninghub/upload-asset',{url:text,useWallet:rhUseWallet(node),kind});
      if(!data.data?.fileName)throw Error('RH 未返回 fileName');
      return data.data.fileName;
    }catch(error){throw Error('素材上传失败：'+readable(error.message,'无法上传素材'));}
  };
  const present=value=>value!==undefined&&value!==null&&String(value).trim()!=='';
  // RH-NEW-01: a field the workbench set to "保留工作流原设置" is read-only and never sent, so the
  // workflow keeps its own value; an exposed field sends its current value, 0 and false included.
  const keeps=field=>!['image','video','audio'].includes(rhFieldKind(field))&&field.sourceFromUpstream===false;
  const keptRows=fields=>fields.map(f=>`<div class="rh-keep-original" data-rh-keep="${escapeHtml(rhParamKey(f.nodeId,f.fieldName))}"><b>${escapeHtml(f.label||f.fieldName)}</b><span>保留工作流原设置（只读，不发送）</span></div>`).join('');
  const promptFieldsOld=renderRhPromptFields,paramsOld=renderRhParams;
  renderRhPromptFields=(container,node,fields)=>{
    const kept=(fields||[]).filter(f=>keeps(f)&&rhFieldRole(f)==='prompt');
    promptFieldsOld(container,node,(fields||[]).filter(f=>!keeps(f)));
    if(container&&kept.length)container.insertAdjacentHTML('beforeend',keptRows(kept));
  };
  renderRhParams=(container,node,fields,media)=>{
    const kept=(fields||[]).filter(f=>keeps(f)&&rhFieldRole(f)!=='prompt');
    paramsOld(container,node,(fields||[]).filter(f=>!keeps(f)),media);
    if(container&&kept.length){container.querySelector('.rh-empty')?.remove();container.insertAdjacentHTML('beforeend',keptRows(kept));}
  };
  // What will be sent and where each value comes from, before paying; media are named, not uploaded.
  function effectiveParams(node){
    const media=rhMediaSources(node);
    return rhActiveFields(node).map(field=>{
      const key=rhParamKey(field.nodeId,field.fieldName),kind=rhFieldKind(field),param=node.rhParams?.[key],label=`${field.label||field.fieldName}（${field.nodeId}.${field.fieldName}）`;
      if(keeps(field))return `${label}：不发送，使用工作流里保存的值`;
      const value=rhFieldValue(node,field,media);
      const source=['image','video','audio'].includes(kind)?((param?.sourceFromUpstream??field.sourceFromUpstream)===false?'手动值':'连线素材，提交前上传')
        :randomSeed(field)&&rhRandomActive(node,key)?'随机种子':param?.value!==undefined?'画布中填写':rhFieldRole(field)==='prompt'&&media?.prompt?'连线文本':'工作流默认值';
      return `${label} = ${String(value)===''?'（空）':String(value)} · 来源：${source}`;
    }).join('\n');
  }
  window.rhEffectiveParams=effectiveParams;
  const bodyOld=renderRhBody;
  renderRhBody=node=>{
    const wrap=bodyOld(node);
    if(wrap instanceof Element&&rhActiveFields(node).length){
      const details=document.createElement('details');details.className='rh-effective';details.innerHTML='<summary>查看最终发送的参数</summary><pre></pre>';
      details.addEventListener('toggle',()=>{if(details.open)details.querySelector('pre').textContent=effectiveParams(node);});
      for(const event of ['pointerdown','mousedown','wheel'])details.addEventListener(event,e=>e.stopPropagation());
      wrap.append(details);
    }
    return wrap;
  };
  rhBuildNodeInfoList=async(node,media)=>{
    const result=[],fields=rhActiveFields(node),connected=media||rhMediaSources(node);
    // F07: an unreadable order or a partial mapping would send a sample file instead of the user's.
    for(const field of fields)if(['image','video','audio'].includes(rhFieldKind(field))&&order(field)===9999&&field.imageOrder!==undefined&&field.imageOrder!==null&&String(field.imageOrder).trim()!=='')
      throw Error(`RH 素材序号无效（${rhRequiredLabel(field)}：${field.imageOrder}），请改成数字，未提交。`);
    for(const kind of ['image','video','audio']){
      const wanted=fields.filter(f=>rhFieldKind(f)===kind&&(node.rhParams?.[rhParamKey(f.nodeId,f.fieldName)]?.sourceFromUpstream??f.sourceFromUpstream)!==false&&(rhCurrentKind(node)!=='workflow'||f.required===true)).length;
      const have=(connected?.[kind]||[]).filter(m=>m?.url).length;
      if(have&&have<wanted)throw Error(`已连接 ${have} 个${{image:'图片',video:'视频',audio:'音频'}[kind]}素材，但有 ${wanted} 个字段需要；缺少的字段会改用 RH 示例素材，已阻止提交。请补齐素材，或在字段设置里改为手动值。`);
    }
    for(const field of fields){
      if(keeps(field))continue;
      const kind=rhFieldKind(field);let value=rhFieldValue(node,field,media);
      if(randomSeed(field)&&rhRandomActive(node,rhParamKey(field.nodeId,field.fieldName)))seedRange(field);
      if(/seed|种子/i.test([field.fieldName,field.label].join(' '))&&typeof value==='number'&&!Number.isSafeInteger(value))throw Error('种子超出精确整数范围，请以字符串填写。');
      if(rhCurrentKind(node)==='workflow'&&kind==='image'&&field.required!==true&&!present(value))continue;
      if(['image','video','audio'].includes(kind))value=await rhUploadValueIfNeeded(value,node,kind);
      if(['number','slider'].includes(kind)&&present(value)){
        if(!Number.isFinite(Number(value)))throw Error('数值参数无效：'+rhRequiredLabel(field));
        // Preserve integer text beyond JS's exact range; RH accepts string values.
        if(!(typeof value==='string'&&/^[+-]?\d+$/.test(value.trim())&&!Number.isSafeInteger(Number(value))))value=Number(value);
      }
      result.push({nodeId:field.nodeId,fieldName:field.fieldName,fieldValue:value});
    }return result;
  };
  rhBuildWorkflowRequestExtras=async(node,media,nodeInfoList)=>{
    const config=node.studioRhPreparedConfig||await ensureRunningHubWorkflowConfigForNode(node);
    if(!config||(config.optionalImageMode||'prune-workflow')!=='prune-workflow')return {};
    const missing=[];
    for(const field of rhActiveFields(node)){
      if(rhFieldKind(field)!=='image')continue;
      const key=rhParamKey(field.nodeId,field.fieldName),value=nodeInfoList.find(item=>rhParamKey(item.nodeId,item.fieldName)===key)?.fieldValue;
      if(!present(value)){if(field.required===true)throw Error('工作流缺少必选图片：'+rhRequiredLabel(field));missing.push(field);}
    }
    if(!missing.length)return {};
    const workflow=rhPruneWorkflowForMissingFields(config.workflowJson||{},missing);
    return workflow?{workflow}:{};
  };
  const targetKey=(canvasId,node)=>JSON.stringify([String(canvasId),node.id]);
  function apply(node,job){
    if(node.studioHistoryRestored||!nodes.includes(node)||String(canvas?.id)!==String(job.request.canvas_id)||String(node.id)!==String(job.request.node_id)||(node.studioRhRequest&&node.studioRhRequest!==job.id))return;
    node.studioRhRequest=job.id;node.studioRhRemote=job.task_id;node.runError=job.error||'';
    node.running=['submitting','queued','running','archiving'].includes(job.status);
    node.runStatus=job.status==='succeeded'?'done':job.status==='failed'?'failed':node.running?'running':'idle';
    node.studioRhStatus=job.status;
    const outputSignature=job.id+':'+JSON.stringify((job.outputs||[]).map(outputUrlValue));
    if(job.status!=='archiving'&&job.outputs?.length&&node.studioRhApplied!==outputSignature){
      const output=outputForNode(node,500);appendOutputImagesWithoutDuplicates(output,job.outputs);mergeGeneratedOutputs(node,job.outputs,Boolean(node.studioRhModelRun?.appendGenerated));node.studioRhApplied=outputSignature;
    }
    if(job.request.kind==='model'&&job.status==='succeeded'&&node.studioRhModelLogged!==job.id){
      const run=node.studioRhModelRun?.run;if(run){run.request={backend:'runninghub',mode:'model',task_id:job.task_id};addGenerationLog({run,outputs:job.outputs,runMs:Math.max(0,nowMs()-Number(node.studioRhModelRun.startedAt||nowMs()))});}node.studioRhModelLogged=job.id;
    }
    render();scheduleSave();
    const key=targetKey(job.request.canvas_id,node);
    if(['queued','running','archiving','unknown'].includes(job.status)||(job.request.kind==='model'&&job.status==='uncertain'&&job.children?.length))waiting.set(key,{node,canvasId:String(job.request.canvas_id),requestId:job.id});else waiting.delete(key);
  }
  async function resume(node){
    const canvasId=String(canvas?.id||''),requestId=node.studioRhRequest,key=targetKey(canvasId,node);
    if(inflight.has(key)||!requestId)return;
    const current=()=>String(canvas?.id||'')===canvasId&&nodes.includes(node)&&node.studioRhRequest===requestId;
    inflight.add(key);
    try{const job=await api('/api/studio/runninghub/tasks/'+encodeURIComponent(requestId));if(current()&&job.id===requestId&&String(job.request?.canvas_id)===canvasId&&String(job.request?.node_id)===String(node.id)){delete node.studioHistoryRestored;apply(node,job);}}
    catch(e){if(current()){node.runError='任务查询失败：'+readable(e.message,'请稍后查询原任务');render();}}
    finally{inflight.delete(key);}
  }
  runRhNode=async(id,opts={})=>{
    const node=nodes.find(n=>n.id===id);if(!node)return;
    const originCanvasId=String(canvas?.id||'');
    const isCurrent=()=>String(canvas?.id||'')===originCanvasId&&nodes.includes(node);
    const ensureCurrent=()=>{if(!isCurrent())throw Error('画布已切换，本次 RH 提交已取消。');};
    const key=targetKey(originCanvasId,node);
    if(node.running||inflight.has(key))return;
    if(node.studioRhRequest&&!['succeeded','failed','not_submitted'].includes(node.studioRhStatus)){await resume(node);return;}
    let dispatched=false,requestId='',phase='参数准备';
    inflight.add(key);node.running=true;node.runError='';node.rhRandomValues={};render();
    try{
      ensureRhNodeSelection(node);const kind=rhCurrentKind(node);let payload;
      if(kind==='model'){
        const selected=rhSelectedEntryRef(node),model=selected?.id||node.rhModel||node.model||'';
        if(!model)throw Error('请先在 API 设置里添加 RunningHub 模型 API');
        node.rhModel=model;node.model=model;node.apiProvider='runninghub';
        const frozen=JSON.parse(JSON.stringify(node)),media=JSON.parse(JSON.stringify(rhMediaSources(node))),refs=imageRefsOnly(media.refs||[]),prompt=media.prompt||'';
        if(!prompt&&!refs.length)throw Error(tr('canvas.needPromptOrImage'));
        payload={prompt:prompt||'Edit the reference images.',provider_id:'runninghub',model,size:await generatorSizeForRun(frozen,refs),reference_images:refs.slice(0,CANVAS_REFERENCE_IMAGE_MAX),count:Math.max(1,Math.min(8,Number(frozen.count||1)))};
        const quality=normalizedImageQuality(frozen.quality);if(quality)payload.quality=quality;
        node.studioRhModelRun={run:runSnapshot(frozen,payload.prompt,refs),startedAt:nowMs(),appendGenerated:Boolean(opts.cascade)};
      }else{
        delete node.studioRhModelRun;
        if(!rhCurrentEntry(node))throw Error('请先导入并选择 RH 应用或工作流。');
        const frozen=JSON.parse(JSON.stringify(node)),media=JSON.parse(JSON.stringify(rhMediaSources(node)));
        if(kind==='workflow')frozen.studioRhPreparedConfig=JSON.parse(JSON.stringify(await ensureRunningHubWorkflowConfigForNode(frozen)||null));
        const nodeInfoList=await rhBuildNodeInfoList(frozen,media),extras=kind==='workflow'?await rhBuildWorkflowRequestExtras(frozen,media,nodeInfoList):{};
        for(const field of rhActiveFields(frozen)){
          const value=nodeInfoList.find(item=>String(item.nodeId)===String(field.nodeId)&&item.fieldName===field.fieldName)?.fieldValue;
          if(field.required===true&&(value===undefined||value===null||String(value).trim()===''))throw Error('请填写必填参数：'+(field.label||field.fieldName));
          if(['number','slider'].includes(rhFieldKind(field))&&value!==undefined&&value!==''&&!Number.isFinite(Number(value)))throw Error('数值参数无效：'+(field.label||field.fieldName));
        }
        payload=kind==='workflow'?{workflowId:frozen.workflowId,nodeInfoList,useWallet:rhUseWallet(frozen),instanceType:frozen.instanceType||'',...extras}:{webappId:frozen.webappId,nodeInfoList,useWallet:rhUseWallet(frozen),instanceType:frozen.instanceType||''};
      }
      ensureCurrent();
      const request={request_id:crypto.randomUUID(),canvas_id:originCanvasId,node_id:id,kind,payload};
      delete node.studioHistoryRestored;
      node.studioRhRequest=request.request_id;node.studioRhStatus='submitting';node.studioRhSnapshot=JSON.parse(JSON.stringify(request));
      requestId=request.request_id;phase='保存';
      if(!window.StudioSave?.ensureCurrent)throw Error('保存保护尚未就绪');
      await window.StudioSave.ensureCurrent({canvasId:originCanvasId,nodeId:id,jobId:requestId,requestField:'studioRhRequest',snapshotField:'studioRhSnapshot'});
      ensureCurrent();phase='提交';dispatched=true;apply(node,await api('/api/studio/runninghub/tasks',request));
      if(opts.cascade){
        phase='查询';
        for(let i=0;i<720&&['submitting','queued','running','archiving','unknown'].includes(node.studioRhStatus);i++){
          await new Promise(resolve=>setTimeout(resolve,2500));
          ensureCurrent();
          if(opts.cascadeTargetId)ensureCascadeActive(opts.cascadeTargetId);
          apply(node,await api('/api/studio/runninghub/tasks/'+node.studioRhRequest));
        }
        if(node.studioRhStatus!=='succeeded')throw Error(node.runError||'RH 任务尚未完成，请查询原任务。');
      }
    }catch(e){
      node.running=false;node.runError=(dispatched?'RH '+phase+'失败：':'未提交 · '+phase+'失败：')+readable(e.message,'请重试');
      if(!dispatched){if(requestId&&node.studioRhRequest===requestId){delete node.studioRhRequest;delete node.studioRhSnapshot;}node.studioRhStatus='not_submitted';}
      else if(!['succeeded','failed'].includes(node.studioRhStatus))node.studioRhStatus='uncertain';
      node.runStatus=node.studioRhStatus==='succeeded'?'done':'failed';
      if(isCurrent()){render();scheduleSave();}if(opts.cascade)throw e;
    }
    finally{inflight.delete(key);}
  };
  runRhModelNode=(node,opts={})=>node?runRhNode(node.id,opts):undefined;
  const renderOld=renderRhBody;
  renderRhBody=node=>{
    const body=renderOld(node);
    const entrySelect=body.querySelector('.rh-entry-select'),pinned=node.studioRhDefinition;
    if(entrySelect&&pinned&&node.rhConfigKey===pinned.key&&!Array.from(entrySelect.options).some(option=>option.value===pinned.key)){
      entrySelect.add(new Option((pinned.entry.title||pinned.entry.name||pinned.id)+'（已保存配置）',pinned.key));entrySelect.value=pinned.key;
    }
    if(node.studioRhRequest||node.runError){const row=document.createElement('div');row.className='studio-rh-status';const p=document.createElement('p');p.textContent=({not_submitted:'未提交',submitting:'提交中',queued:'排队中',running:'运行中',archiving:'结果转存中',succeeded:'已完成',failed:'失败',uncertain:'提交待核实，请先检查 RH 任务',unknown:'查询状态待核实'}[node.studioRhStatus]||'查询中')+(node.runError?' · '+node.runError:'');row.append(p);if(node.studioRhRequest&&node.studioRhStatus!=='not_submitted'){const retry=document.createElement('button');retry.type='button';retry.textContent='查询原任务';retry.onclick=e=>{e.stopPropagation();resume(node);};row.append(retry);}body.append(row);}
    return body;
  };
  async function open(){
    const dialog=document.createElement('dialog');dialog.className='studio-rh-manager';dialog.setAttribute('aria-label','RH 工作流库');
    const title=document.createElement('h2');title.textContent='RH 应用与工作流';const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>dialog.close();
    const note=document.createElement('p');note.textContent='通过你的 RH API 调用。参考闭源库暂跳过；下方显示当前已配置条目。';
    const type=document.createElement('select');type.setAttribute('aria-label','RH 导入类型');type.add(new Option('应用','app'));type.add(new Option('工作流','workflow'));
    const input=document.createElement('input');input.placeholder='粘贴应用/工作流链接或 ID';input.setAttribute('aria-label','RH 链接或 ID');
    const importButton=document.createElement('button');importButton.textContent='读取并添加';const status=document.createElement('p');status.setAttribute('role','status');
    const list=document.createElement('div');list.className='studio-rh-library';const search=document.createElement('input');search.type='search';search.placeholder='搜索已配置工作流';search.setAttribute('aria-label','搜索 RH 工作流');
    dialog.append(title,close,note,type,input,importButton,status,search,list);document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();let entries=[];
    function draw(){list.replaceChildren();for(const entry of entries.filter(e=>[e.title,e.id,e.note].join(' ').toLowerCase().includes(search.value.toLowerCase()))){const card=document.createElement('article'),name=document.createElement('strong'),desc=document.createElement('p'),add=document.createElement('button');name.textContent=entry.title;desc.textContent=entry.note||`${entry.kind==='app'?'应用':'工作流'} · ${entry.id}`;add.textContent='添加到画布';add.onclick=async()=>{await loadConfig();pushUndo();const node=addRhNode(defaultPoint());applyRhEntrySelection(node,{kind:entry.kind,id:entry.id});render();scheduleSave();dialog.close();};card.append(name,desc,add);list.append(card);}}
    async function refresh(){const data=await api('/api/studio/runninghub/catalog');entries=[...data.apps.map(e=>({...e,kind:'app'})),...data.workflows.map(e=>({...e,kind:'workflow'}))].filter(e=>!e.hidden&&e.enabled!==false);draw();status.textContent=`当前 ${entries.length} 项，非闭源参考库全量。`;}
    search.oninput=draw;importButton.onclick=async()=>{importButton.disabled=true;try{await api('/api/studio/runninghub/import',{source:input.value,kind:type.value});await refresh();await loadConfig();}catch(e){status.textContent=e.message;}finally{importButton.disabled=false;}};
    try{await refresh();}catch(e){status.textContent=e.message;}
  }
  const button=document.createElement('button');button.textContent='RH 工作流';button.className='tool-btn';button.dataset.canvasTool='runninghub';button.onclick=open;document.querySelector('#quickToolbar .toolbar-items')?.append(button);
  let recovered='';
  setInterval(async()=>{
    if(typeof canvas==='undefined'||!canvas?.id||document.hidden)return;
    if(recovered!==canvas.id){const current=canvas.id;try{const data=await api('/api/studio/runninghub/tasks?canvas_id='+encodeURIComponent(current));if(canvas.id!==current)return;for(const job of data.tasks){const node=nodes.find(n=>n.id===job.request.node_id);if(node&&!node.studioHistoryRestored&&(!node.studioRhRequest||node.studioRhRequest===job.id))apply(node,job);}recovered=current;}catch{}}
    for(const [key,target] of waiting){if(String(canvas.id)===target.canvasId&&nodes.includes(target.node)&&!target.node.studioHistoryRestored&&target.node.studioRhRequest===target.requestId)resume(target.node);else waiting.delete(key);}
  },4000);
  window.StudioRunningHub={open,resume};
})();
