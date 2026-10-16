/* Browser-only editing drafts. This module never submits or resumes generation. */
(() => {
  'use strict';
  const DB='deepwhite-studio-canvas-drafts',STORE='drafts',SCHEMA=1,writerId=crypto.randomUUID();
  const memory=new Map(),dismissed=new Set();let bridge=null,dbPromise=null,queue=Promise.resolve(),rows=[],bar,dialog,busy=false,writeTimer=null;
  const pendingKeys=new Set(),copies=new Map(),storageErrors=new Map(),serverFailures=new Map();
  const secret=new Set(['apikey','accesskey','secretkey','authorization','password','secret','accesstoken','refreshtoken','authtoken','bearertoken','token','cookie']);
  const task=new Set(['studioHistoryRestored','studioMjAttempt','studioMjTask','studioMjHistory','studioMjRequest','studioMjStatus','studioMjState','studioMjRemoteStatus','studioMjMediaStatus','studioMjCompleted','studioMjPastTasks','studioMjUsage','lastTaskStatus','mjModalTaskId','studioLegacyAttempts','studioLegacyUnknown','studioJob','studioControlJob','studioSubmission','studioJobState','studioJobError','studioSavingSubmission','studioAccepted',
    'studioWorkflowRequestId','studioWorkflowSubmission','studioWorkflowTaskId','studioWorkflowTaskStatus','studioWorkflowAppliedTask','studioWorkflowError',
    'studioRhRequest','studioRhSnapshot','studioRhRemote','studioRhStatus','studioRhApplied','studioRhModelRun','studioRhModelLogged','_pending','pendingTasks','jimengPending',
    'lastTaskId','lastHistoryId','recoverTaskId','runStatus','runError','running','pending','queued','querying','runStartedAt','runFinishedAt','runElapsedMs','runTimerHidden',
    '_cascadeIdx','_cascadeFailed','_activeLoopCtx','_runMetaTargetId','_selectAfterRunId','_dom','_ltxEditor','timelinePlaying','task_id','taskId','history_id','historyId','request_id','requestId','submit_id','submitId','prompt_id']);
  const bindings=new Set(['studioMjAttempt','studioMjTask','studioMjHistory','studioMjRequest','studioMjPastTasks','studioLegacyAttempts','studioLegacyUnknown','studioJob','studioControlJob','studioSubmission','studioWorkflowRequestId','studioWorkflowSubmission','studioWorkflowTaskId','studioRhRequest','studioRhRemote','_pending','pendingTasks','jimengPending','lastTaskId','lastHistoryId','recoverTaskId']);
  const bound=n=>[...bindings].some(k=>n[k]&&(!Array.isArray(n[k])||n[k].length));
  const resultKeys=['generatedOutputs','studioAudioOutputs','outputText'];
  const clone=x=>JSON.parse(JSON.stringify(x));
  function clean(value){
    if(Array.isArray(value))return value.map(clean);
    if(!value||typeof value!=='object')return value;
    const out={};for(const [key,v] of Object.entries(value)){
      const normalized=key.toLowerCase().replace(/[_-]/g,'');
      if(secret.has(normalized)||key==='__proto__'||key==='constructor'||key==='prototype')continue;
      out[key]=clean(v);
    }return out;
  }
  function editing(data){
    const out=clean({title:data?.title||'',icon:data?.icon||'',nodes:Array.isArray(data?.nodes)?data.nodes:[],connections:Array.isArray(data?.connections)?data.connections:[],viewport:data?.viewport||{x:0,y:0,scale:1},...(data?.settings?{settings:data.settings}:{})});
    out.nodes=out.nodes.map(node=>{const copy={...node};for(const key of task)delete copy[key];delete copy.run;return copy;});
    return out;
  }
  function canonical(value){
    if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  function valid(row){return row?.schema===SCHEMA&&typeof row.canvasId==='string'&&typeof row.writerId==='string'&&row.key===JSON.stringify([row.canvasId,row.writerId])&&Number.isSafeInteger(row.revision)&&row.revision>0&&Number.isFinite(row.baseRevision)&&Array.isArray(row.payload?.nodes)&&Array.isArray(row.payload?.connections);}
  function database(){
    if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
      let request;try{request=indexedDB.open(DB,SCHEMA);}catch(e){reject(e);return;}
      request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'key'});};
      request.onerror=()=>reject(request.error||Error('浏览器存储不可用'));request.onblocked=()=>reject(Error('浏览器草稿存储被其他页面阻塞'));
      request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
    });return dbPromise;
  }
  async function transaction(mode,work){
    const db=await database();return new Promise((resolve,reject)=>{
      let tx;try{tx=db.transaction(STORE,mode);work(tx.objectStore(STORE),tx);}catch(e){try{tx?.abort();}catch{}reject(e);return;}
      tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||Error('浏览器草稿写入未完成'));
    });
  }
  function enqueue(work,canvasIds=[bridge?.canvasId]){const job=queue.catch(()=>{}).then(work);queue=job.catch(e=>{for(const id of canvasIds)storageErrors.set(id,'浏览器草稿未写入：'+(e?.name==='QuotaExceededError'?'存储空间不足':e?.message||'存储不可用')+'。当前内容仍可导出。');render();});return job;}
  async function scan(){
    let all=[];await transaction('readonly',store=>{const request=store.getAll();request.onsuccess=()=>{all=request.result||[];};});
    rows=all.filter(valid);return rows;
  }
  function currentRows(){return bridge?rows.filter(r=>r.canvasId===bridge.canvasId&&r.kind===bridge.kind&&!dismissed.has(r.key+':'+r.revision)).sort((a,b)=>b.savedAt-a.savedAt):[];}
  function candidates(){return currentRows().filter(r=>r.writerId!==writerId);}
  function capture({canvasId,kind,baseRevision,payload}={}){
    if(!canvasId||!payload)return null;
    try{
      const key=JSON.stringify([String(canvasId),writerId]),previous=memory.get(key),data=editing(payload);
      const row={schema:SCHEMA,key,canvasId:String(canvasId),writerId,kind:kind||'classic',revision:(previous?.revision||0)+1,baseRevision:Number(baseRevision||0),
        baseContent:bridge?.canvasId===String(canvasId)?bridge.baseContent:'',savedAt:Date.now(),payload:data,dirty:true,persisted:false,recoveredFrom:previous?.recoveredFrom||null};
      memory.set(key,row);render();
      pendingKeys.add(key);clearTimeout(writeTimer);writeTimer=setTimeout(flushPending,80);
      return {canvasId:row.canvasId,writerId,revision:row.revision,key};
    }catch(e){storageErrors.set(String(canvasId),'浏览器草稿无法序列化，当前编辑仍保留在画布中；请导出当前画布。');render();return null;}
  }
  function flushPending(){
    clearTimeout(writeTimer);writeTimer=null;if(!pendingKeys.size)return queue;
    const batch=[...pendingKeys].map(key=>clone(memory.get(key))).filter(Boolean);pendingKeys.clear();
    enqueue(async()=>{
      await transaction('readwrite',store=>{for(const row of batch)store.put(row);});
      for(const row of batch){const latest=memory.get(row.key);if(latest?.revision===row.revision)latest.persisted=true;rows=rows.filter(r=>r.key!==row.key);rows.push(row);}
      for(const row of batch)storageErrors.delete(row.canvasId);render();
    },batch.map(r=>r.canvasId)).catch(()=>{});return queue;
  }
  function ack(token,saved){
    if(!token)return Promise.resolve();flushPending();serverFailures.delete(token.canvasId);const entry=memory.get(token.key),recovered=entry?.revision===token.revision?entry.recoveredFrom:null;
    if(saved&&bridge?.canvasId===token.canvasId){
      bridge.baseContent=canonical(editing(saved));bridge.revision=Number(saved.updated_at||0);
      const latest=memory.get(token.key);if(latest&&latest.revision>token.revision){latest.baseContent=bridge.baseContent;latest.baseRevision=bridge.revision;}
    }
    return enqueue(async()=>{
      await transaction('readwrite',store=>{
        const latest=memory.get(token.key);if(latest&&latest.revision>token.revision){const check=store.get(token.key);check.onsuccess=()=>{if(check.result?.revision===latest.revision)store.put(clone(latest));};}
        const remove=(key,revision)=>{const request=store.get(key);request.onsuccess=()=>{const row=request.result;if(valid(row)&&row.revision===revision)store.delete(key);};};
        remove(token.key,token.revision);if(recovered)remove(recovered.key,recovered.revision);
      });
      const latest=memory.get(token.key);if(latest?.revision===token.revision){latest.dirty=false;latest.recoveredFrom=null;}
      await scan();render();
    },[token.canvasId]).catch(()=>{});
  }
  async function loaded(info){
    bridge={...info,baseContent:canonical(editing(info.baseline||{}))};
    try{await flushPending();await scan();render();}catch(e){storageErrors.set(info.canvasId,'浏览器草稿存储不可用，当前内容仍可导出。');render();}
  }
  function owns(target,origin){return bridge===target&&target.getCurrent()===origin&&String(origin?.id)===target.canvasId;}
  function compatible(row,target,server){
    const revision=Number(server.updated_at||0),known=[Number(row.baseRevision),Number(target.revision)];
    const touchCompatible=Number(row.baseRevision)===Number(target.beforeTouchRevision)&&row.baseContent===target.baseContent;
    return row.baseContent&&row.baseContent===canonical(editing(server))&&(revision===Number(row.baseRevision)||(touchCompatible&&known.includes(revision)));
  }
  function preserveServer(data,server){
    const payload=editing(data),latest=new Map((server.nodes||[]).map(n=>[n.id,n]));
    payload.nodes=payload.nodes.map(n=>{
      const old=latest.get(n.id);if(!old)return n;
      const copy={...n};for(const key of task)if(Object.hasOwn(old,key))copy[key]=clone(old[key]);
      for(const key of resultKeys)if(Object.hasOwn(old,key))copy[key]=clone(old[key]);
      if((old.type==='output'||bound(old))&&Array.isArray(old.images))copy.images=clone(old.images);
      return copy;
    });
    const ids=new Set(payload.nodes.map(n=>n.id));
    for(const n of server.nodes||[])if(!ids.has(n.id)&&(bound(n)||(n.type==='output'&&n.images?.length)))payload.nodes.push(clone(n));
    const allIds=new Set(payload.nodes.map(n=>n.id));
    payload.connections=payload.connections.filter(c=>allIds.has(c.from)&&allIds.has(c.to));
    for(const c of server.connections||[])if(allIds.has(c.from)&&allIds.has(c.to)&&(!ids.has(c.from)||!ids.has(c.to))&&!payload.connections.some(e=>e.from===c.from&&e.to===c.to))payload.connections.push(clone(c));
    return payload;
  }
  async function draftFetch(url,options={}){
    const controller=new AbortController();let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},20000);
    try{
      const response=await fetch(url,{...options,signal:controller.signal}),body=await response.json();
      return {ok:response.ok,status:response.status,json:async()=>body};
    }catch(e){if(timedOut)throw Error('等待超时，服务端结果尚未确认；草稿仍保留。');throw Error('网络请求未确认，草稿仍保留；请先核对服务器状态。');}
    finally{clearTimeout(timer);}
  }
  async function restore(row){
    const target=bridge,origin=target?.getCurrent();if(!target||!owns(target,origin))throw Error('当前画布已改变，未恢复。');
    const response=await draftFetch('/api/canvases/'+encodeURIComponent(target.canvasId));if(!response.ok)throw Error('无法核实服务端版本，未恢复；可导出或恢复为副本。');
    const server=(await response.json()).canvas;
    if(!owns(target,origin)||server?.id!==target.canvasId)throw Error('核实期间画布已改变，未恢复。');
    if(!compatible(row,target,server))throw Error('服务端已有新版本；请保留服务器，或将这份草稿恢复为副本。');
    const payload=preserveServer(row.payload,server);
    target.apply(payload,server);
    const own=memory.get(JSON.stringify([target.canvasId,writerId]));if(own)own.recoveredFrom={key:row.key,revision:row.revision};
    dismissed.add(row.key+':'+row.revision);dialog?.close();render();
  }
  function copyMessage(row,created,text){
    const message=dialog.querySelector('[data-draft-message]');message.textContent=text;
    const link=document.createElement('a');link.textContent='打开已建立的副本';link.href='/static/'+(row.kind==='smart'?'smart-canvas.html':'canvas.html')+'?id='+encodeURIComponent(created.id);link.href+='&project='+encodeURIComponent(created.project||bridge?.project||'default');link.dataset.draftCopy=created.id;message.dataset.draftTone=copies.get(row.key+':'+row.revision)?.saved?'success':'error';message.append(' ',link);
  }
  async function copy(row){
    const target=bridge,origin=target?.getCurrent();if(!target||!owns(target,origin))throw Error('当前画布已改变，未建立副本。');
    const data=editing(row.payload),key=row.key+':'+row.revision;let entry=copies.get(key);
    if(entry?.saved){copyMessage(row,entry.canvas,'这份草稿的副本已经保存；原服务端画布和原草稿仍保留。');return;}
    if(!entry){
      const response=await draftFetch('/api/canvases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:(data.title||'画布')+' · 浏览器草稿副本',icon:data.icon||'🧩',kind:row.kind,project:target.project})});
      if(!response.ok)throw Error('建立副本失败，原草稿仍保留。');
      const created=(await response.json()).canvas;if(!created?.id)throw Error('服务器未确认副本编号，原草稿仍保留。');
      entry={canvas:created,saved:false};copies.set(key,entry);
    }
    const created=entry.canvas;
    try{
      const response=await draftFetch('/api/canvases/'+encodeURIComponent(created.id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,title:created.title,logs:[],base_updated_at:created.updated_at||0,client_id:writerId})});
      if(!response.ok)throw Error('副本内容尚未保存。');
      const body=await response.json();if(body.canvas?.id!==created.id)throw Error('未确认副本保存。');
      entry.canvas=body.canvas;entry.saved=true;copyMessage(row,created,'副本已保存，原服务端画布和原草稿均保留。');
    }catch(e){copyMessage(row,created,'副本已建立但内容尚未确认；原草稿仍保留。可以重试保存同一副本或导出。');}
  }
  function download(row){
    const blob=new Blob([JSON.stringify({schema:SCHEMA,canvasId:row.canvasId,kind:row.kind,baseRevision:row.baseRevision,savedAt:row.savedAt,payload:editing(row.payload)},null,2)],{type:'application/json'});
    const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='deepwhite-canvas-draft-'+row.canvasId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }
  function currentExport(){
    const own=bridge&&memory.get(JSON.stringify([bridge.canvasId,writerId]));if(own)return own;
    if(!bridge)return null;return {canvasId:bridge.canvasId,kind:bridge.kind,baseRevision:bridge.revision,savedAt:Date.now(),payload:editing(bridge.getPayload())};
  }
  function ui(){
    if(bar||!document.body)return;
    bar=document.createElement('aside');bar.id='studioDraftNotice';bar.hidden=true;bar.setAttribute('role','status');
    const text=document.createElement('span'),view=document.createElement('button'),exportButton=document.createElement('button');
    text.dataset.draftStatus='';view.type=exportButton.type='button';view.textContent='查看草稿';view.onclick=open;exportButton.textContent='导出当前';exportButton.onclick=()=>{const row=currentExport();if(row)download(row);};bar.append(text,view,exportButton);document.body.append(bar);
    dialog=document.createElement('dialog');dialog.id='studioDraftDialog';dialog.innerHTML='<header><strong>浏览器草稿</strong><button type="button" data-draft-close>关闭</button></header><p>仅恢复编辑内容，不提交生成。其他标签页的副本独立保留。</p><label>选择草稿<select aria-label="选择浏览器草稿" data-draft-choice></select></label><p data-draft-info></p><p role="alert" data-draft-message></p><footer><button type="button" data-draft-restore>恢复到当前画布</button><button type="button" data-draft-copy>恢复为副本</button><button type="button" data-draft-export>导出本地副本</button><button type="button" data-draft-keep>保留服务器</button></footer>';
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(!busy)dialog.close();}},true);
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    dialog.querySelector('[data-draft-close]').onclick=()=>{if(!busy)dialog.close();};dialog.querySelector('[data-draft-choice]').onchange=updateDialog;
    const selected=()=>rows.find(r=>r.key===dialog.querySelector('[data-draft-choice]').value)||currentExport();
    const act=async(fn)=>{if(busy)return;busy=true;dialog.querySelector('[data-draft-message]').dataset.draftTone='pending';dialog.querySelector('[data-draft-message]').textContent=fn===restore?'正在核实服务器版本，请稍候…':'正在保存独立副本，请稍候…';updateDialog();try{await fn(selected());}catch(e){dialog.querySelector('[data-draft-message]').dataset.draftTone='error';dialog.querySelector('[data-draft-message]').textContent=e.message;}finally{busy=false;updateDialog();}};
    dialog.querySelector('[data-draft-restore]').onclick=()=>act(restore);dialog.querySelector('button[data-draft-copy]').onclick=()=>act(copy);dialog.querySelector('[data-draft-export]').onclick=()=>{const row=selected();if(row)download(row);};
    dialog.querySelector('[data-draft-keep]').onclick=()=>{if(busy)return;for(const row of candidates())dismissed.add(row.key+':'+row.revision);dialog.close();render();};
    const backdrop=e=>{const r=dialog.getBoundingClientRect();return e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};
    let outside=false;dialog.addEventListener('pointerdown',e=>{outside=backdrop(e);});dialog.addEventListener('pointerup',e=>{if(!busy&&outside&&backdrop(e))dialog.close();outside=false;});document.body.append(dialog);
  }
  function updateDialog(){
    if(!dialog)return;dialog.setAttribute('aria-busy',String(busy));dialog.querySelector('[data-draft-close]').disabled=busy;dialog.querySelector('[data-draft-keep]').disabled=busy;dialog.querySelector('[data-draft-choice]').disabled=busy;const value=dialog.querySelector('[data-draft-choice]').value,row=rows.find(r=>r.key===value)||currentExport();
    dialog.querySelector('[data-draft-info]').textContent=row?'草稿时间：'+new Date(row.savedAt).toLocaleString()+'。恢复前会核实服务端版本；有新版本时可恢复为独立副本。':'没有可恢复的本地副本。';
    for(const name of ['restore','copy','export'])dialog.querySelector('button[data-draft-'+name+']').disabled=busy||!row;
    const copied=row&&copies.get(row.key+':'+row.revision),button=dialog.querySelector('button[data-draft-copy]');button.disabled=busy||!row||Boolean(copied?.saved);button.textContent=copied?.saved?'副本已保存':copied?'重试保存副本':'恢复为副本';
  }
  function render(){
    ui();if(!bar)return;const error=storageErrors.get(bridge?.canvasId)||'',serverFailure=serverFailures.get(bridge?.canvasId)||'';const own=bridge&&memory.get(JSON.stringify([bridge.canvasId,writerId])),count=candidates().length;
    bar.hidden=!(error||count||serverFailure);bar.classList.toggle('draft-error',Boolean(error));bar.setAttribute('role',error?'alert':'status');
    bar.querySelector('[data-draft-status]').textContent=error||count?'':own?.persisted?'浏览器草稿已写入，等待服务器确认。':'浏览器草稿正在写入；尚未确认。';
    if(error)bar.querySelector('[data-draft-status]').textContent=error;else if(serverFailure)bar.querySelector('[data-draft-status]').textContent=serverFailure+(own?.persisted?' 浏览器草稿已写入。':' 浏览器草稿正在写入，尚未确认。');else if(count)bar.querySelector('[data-draft-status]').textContent='发现 '+count+' 份未确认的浏览器草稿。';
    bar.querySelector('button').disabled=!bridge;bar.querySelectorAll('button')[1].disabled=!bridge;
  }
  async function open(){
    ui();try{await flushPending();await scan();}catch{}const choice=dialog.querySelector('[data-draft-choice]');choice.replaceChildren();
    const available=currentRows();for(const row of available){const option=document.createElement('option');option.value=row.key;option.textContent=new Date(row.savedAt).toLocaleString()+(row.writerId===writerId?' · 当前页面':' · 上次或其他页面');choice.append(option);}
    dialog.querySelector('[data-draft-message]').textContent='';updateDialog();if(!dialog.open)dialog.showModal();
  }
  window.addEventListener('pagehide',()=>{if(bridge&&memory.get(JSON.stringify([bridge.canvasId,writerId]))?.dirty)capture({canvasId:bridge.canvasId,kind:bridge.kind,baseRevision:bridge.getRevision?.()??bridge.revision,payload:bridge.getPayload()});flushPending();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&bridge&&memory.get(JSON.stringify([bridge.canvasId,writerId]))?.dirty)capture({canvasId:bridge.canvasId,kind:bridge.kind,baseRevision:bridge.getRevision?.()??bridge.revision,payload:bridge.getPayload()});flushPending();});
  window.StudioCanvasDrafts=Object.freeze({capture,ack,loaded,open,failed:(message,canvasId=bridge?.canvasId)=>{serverFailures.set(String(canvasId),message||'服务器保存未确认。');render();},flush:flushPending,exportCurrent:()=>{const row=currentExport();if(row)download(row);}});
})();
