/* First-stage classic canvas experience. Original canvas gestures/storage remain native. */
(() => {
  const smart=!!document.querySelector('.smart-back');
  // Serialize autosave and explicit save. Concurrent writes used the same base revision,
  // causing a conflict/merge during copy→delete→undo followed by refresh.
  const nativeSave=saveCanvas;let saveQueue=Promise.resolve();
  saveCanvas=function(...args){
    clearTimeout(saveTimer);saveTimer=null;
    const origin=typeof canvas!=='undefined'?canvas:null;
    saveQueue=saveQueue.catch(()=>{}).then(()=>canvas===origin&&origin
      ?nativeSave.apply(this,args):{ok:false,canvasId:origin?.id||'',code:'target-changed',error:'画布已切换，保存已取消。'});
    return saveQueue;
  };
  const saveStates=new Map();
  window.addEventListener('studio-save-state',e=>{
    const state=e.detail;saveStates.set(state.canvasId,Object.freeze({...state,canvas:undefined}));
    if(state.canvasId!==canvas?.id)return;
    let notice=document.getElementById('studioSaveNotice');
    if(state.ok){notice?.remove();return;}
    if(state.code==='target-changed')return;
    if(!notice){
      notice=document.createElement('div');notice.id='studioSaveNotice';notice.setAttribute('role','alert');
      notice.style.cssText='position:fixed;left:50%;top:118px;transform:translateX(-50%);z-index:100001;max-width:min(720px,calc(100vw - 32px));box-sizing:border-box;overflow-wrap:anywhere;padding:12px 16px;border:1px solid #bd914e;border-radius:10px;background:var(--panel,#26332e);color:var(--text,#f0ebdb);display:flex;gap:12px;align-items:center';
      const text=document.createElement('span'),retry=document.createElement('button');text.style.minWidth='0';retry.style.flexShrink='0';retry.type='button';retry.textContent='重试保存';
      retry.onclick=()=>{if(canvas?.id===notice.dataset.canvasId)saveCanvas();};notice.append(text,retry);document.body.append(notice);
    }
    notice.dataset.canvasId=state.canvasId;notice.firstChild.textContent=state.error||'保存未完成，手写内容仍保留。';
  });
  // Array paths let each batch slot keep its own receipt without sharing a
  // mutable node-wide task pointer. Read only stored own properties.
  const savedField=(value,path)=>{
    for(const part of Array.isArray(path)?path:[path]){
      if(!value||typeof value!=='object'||!Object.hasOwn(value,part))return undefined;
      value=value[part];
    }
    return value;
  };
  window.StudioSave=Object.freeze({
    getState:id=>saveStates.get(id||canvas?.id)||null,
    async ensureCurrent({canvasId:id,nodeId,jobId,request:expectedRequest,requestField='studioJob',snapshotField='studioSubmission'}={}){
      const origin=canvas,node=nodes.find(n=>n.id===nodeId),expectedSnapshot=node&&JSON.stringify(savedField(node,snapshotField));
      const current=()=>canvas===origin&&String(canvas?.id)===String(id)&&(!nodeId||nodes.find(n=>n.id===nodeId)===node)&&(!jobId||savedField(node,requestField)===jobId);
      const fail=message=>{const error=Error(message);error.code='verification';window.dispatchEvent(new CustomEvent('studio-save-state',{detail:{ok:false,canvasId:id,code:error.code,error:message}}));throw error;};
      if(!origin||!current()||(nodeId&&!node))throw Error('画布或节点已改变，任务未提交。');
      const result=await saveCanvas();
      if(!result?.ok){const error=Error(result?.error||'保存未确认，任务未提交。');error.code=result?.code||'save-failed';throw error;}
      if(!current())throw Error('画布或节点已改变，任务未提交。');
      let response;try{response=await fetch('/api/canvases/'+encodeURIComponent(id));}catch{fail('保存核对网络中断，任务未提交。');}
      if(!response.ok)fail('无法核实保存结果，任务未提交。');
      let data;try{data=await response.json();}catch{fail('保存核对响应无效，任务未提交。');}
      const stored=data.canvas?.nodes?.find(n=>n.id===nodeId);
      if(!current()||data.canvas?.id!==id||(nodeId&&!stored)||
        (jobId&&(!expectedSnapshot||savedField(stored,requestField)!==jobId||JSON.stringify(savedField(stored,snapshotField))!==expectedSnapshot||
          (expectedRequest&&JSON.stringify(savedField(stored,snapshotField)?.request)!==JSON.stringify(expectedRequest)))))
        fail('原项目输入或任务快照未保存，任务未提交。');
      return {ok:true,canvasId:id,node:stored,updatedAt:data.canvas.updated_at};
    }
  });
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-stage-one.css?v=8';document.head.append(css);
  // Expose the original layout actions; keep its connections, group movement and undo logic.
  const actions=document.createElement('div');actions.className='studio-canvas-actions';document.body.append(actions);
  for(const event of ['pointerdown','mousedown','dblclick','wheel'])actions.addEventListener(event,e=>e.stopPropagation());
  const originalArrange=document.getElementById(smart?'smartArrangeBtn':'canvasArrangeBtn');
  if(originalArrange){originalArrange.classList.add('studio-arrange-button');originalArrange.title='选中多个节点后整理；选中一个节点时整理其相连分支';actions.append(originalArrange);}
  const allArrange=document.createElement('button');allArrange.type='button';allArrange.textContent='整理全部';allArrange.setAttribute('aria-label','整理全部节点');actions.append(allArrange);
  allArrange.onclick=()=>{
    if(typeof canvas==='undefined'||!canvas)return;
    const ids=nodes.map(n=>n.id);
    if(ids.length<2)return;
    pushUndo();const moved=smart?arrangeSmartIdsByConnections(ids):arrangeIdsByConnections(ids);
    if(moved){render();scheduleSave();}
  };
  function arrangeState(){
    const ready=typeof nodes!=='undefined'&&typeof canvas!=='undefined'&&canvas;
    if(originalArrange)originalArrange.disabled=!ready||!(smart?selectedNodeIds().length:selected.size);
    allArrange.disabled=!ready||nodes.length<2;
  }
  const originalRender=render;render=function(...args){const result=originalRender.apply(this,args);arrangeState();return result;};arrangeState();
  // Selection can change without rendering (marquee/click), so only update button state.
  document.addEventListener('mouseup',()=>queueMicrotask(arrangeState));document.addEventListener('keyup',()=>queueMicrotask(arrangeState));
  if(smart)return; // Smart canvas uses the shared server adapter; the main workspace is classic.
  // Native dragging prevents default focus changes: release an old text editor
  // when the user explicitly returns to a node's selection/drag surface.
  const nativeStartDrag=startNodeDrag;
  startNodeDrag=function(...args){document.activeElement?.blur?.();return nativeStartDrag.apply(this,args);};
  document.addEventListener('keydown',e=>{
    if(!['Delete','Backspace'].includes(e.key)||e.isComposing||e.ctrlKey||e.metaKey||e.altKey)return;
    if(e.target.closest?.('input,textarea,select,[contenteditable="true"],dialog,[role="dialog"],#outputLightbox,#studioModelPicker')||document.querySelector('dialog[open],#outputLightbox.open,.modal.open')){e.stopImmediatePropagation();return;}
    if(!canvas||!selected.size)return;
    e.preventDefault();e.stopImmediatePropagation();deleteSelectedNodes();
  },true);
  // Keep all results in their original output node; reuse the native gallery.
  const gallery=document.getElementById('outputLightbox');
  const galleryNav=document.createElement('div');galleryNav.className='studio-gallery-nav';
  const previous=document.createElement('button'),next=document.createElement('button'),position=document.createElement('span');
  previous.type=next.type='button';previous.textContent='‹';next.textContent='›';previous.setAttribute('aria-label','上一张图片');next.setAttribute('aria-label','下一张图片');
  galleryNav.append(previous,position,next);gallery.append(galleryNav);
  function galleryState(){
    const out=nodes.find(n=>n.id===currentOutputLightboxOutId),items=outputLightboxItems(out);
    const index=items.findIndex(item=>item.url===currentOutputLightboxUrl);
    galleryNav.hidden=!gallery.classList.contains('open')||items.length<2||index<0;
    position.textContent=`${index+1} / ${items.length}`;
  }
  previous.onclick=e=>{e.stopPropagation();navigateOutputLightbox(-1);};next.onclick=e=>{e.stopPropagation();navigateOutputLightbox(1);};
  const nativeOpenGallery=openOutputLightbox;openOutputLightbox=function(...args){const result=nativeOpenGallery.apply(this,args);galleryState();return result;};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const states={queued:'等待提交',running:'生成中',succeeded:'已完成',failed:'生成失败',paused:'等待继续查询',uncertain:'提交结果待核实'};
  let capabilities={};const jobs=new Map(),polling=new Map();
  const kind=n=>n.type==='llm'?'chat':n.type==='video'?'video':n.type==='audio'?'audio':'image';
  const provider=n=>n.type==='llm'?n.llmProvider:n.apiProvider;
  const isDeep=n=>{try{return new URL(apiProviders.find(p=>p.id===provider(n))?.base_url).hostname==='api.deepwhiteai.com';}catch{return false;}};
  const supported=n=>['generator','video','llm','audio'].includes(n.type)&&n.model!=='midjourney-imagine'&&(isDeep(n)||provider(n)==='dreamina-cli'||(n.type==='generator'&&provider(n)==='deepwhite-local-comfy'));
  const canvasId=()=>canvas?.id||new URLSearchParams(location.search).get('id')||'';
  async function api(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok){const e=Error(typeof data.detail==='string'?data.detail:'输入格式有误，请检查参数。');e.status=r.status;throw e;}return data;}
  const stop=el=>{for(const name of ['pointerdown','mousedown','dblclick','keydown','wheel'])el.addEventListener(name,e=>e.stopPropagation());return el;};
  function changed(){scheduleSave();render();}
  function spec(n){return capabilities[provider(n)]?.[n.model];}
  function values(n){
    const s=spec(n);if(!s)return n.studioParams||{};
    if(n.studioParamsModel!==n.model){n.studioParams={};n.studioParamsModel=n.model;}
    for(const [key,f] of Object.entries(s.fields)){if(f.values&&!f.values.includes(n.studioParams[key])&&!(key==='main_model'&&n.studioParams[key]))n.studioParams[key]=f.default;}
    for(const key of Object.keys(n.studioParams))if(!s.fields[key]&&!(n.type==='audio'&&key==='channel'))delete n.studioParams[key];
    return n.studioParams;
  }
  const originalSources=generatorSources;
  generatorSources=n=>{
    const excluded=n.studioExcludedRefs||[];
    const result=originalSources(n).map(s=>({...s,refs:(s.refs||[]).filter(r=>!excluded.includes(r.url))}));
    if(n.studioRefs?.length)result.push({id:n.id+':references',type:'image',label:'节点参考素材',refs:n.studioRefs,prompt:''});
    return result;
  };
  function refs(n){
    let result=n.type==='llm'?[...llmInputImages(n).map(url=>({url,kind:'image'})),...(n.studioRefs||[])]:generatorSources(n).flatMap(s=>s.refs||[]);
    const seen=new Set();result=result.filter(r=>r.url&&!seen.has(r.url)&&(seen.add(r.url),true)&&!(n.studioExcludedRefs||[]).includes(r.url)).map(r=>({...r,kind:r.kind||mediaKindForRef(r)||'image',role:n.studioRefRoles?.[r.url]||r.role||''}));
    const order=n.studioRefOrder||[];result.sort((a,b)=>(order.indexOf(a.url)<0?999:order.indexOf(a.url))-(order.indexOf(b.url)<0?999:order.indexOf(b.url)));
    // REF-01: each reference keeps the number it first got ("参考N"), so moving it changes its
    // send position but not its name; the prompt is converted to positions when it is sent.
    if(n.type!=='llm'){
      n.studioRefNumbers??={};
      for(const r of result){
        if(!n.studioRefNumbers[r.url])n.studioRefNumbers[r.url]=Math.max(0,...Object.values(n.studioRefNumbers))+1;
        r.label='参考'+n.studioRefNumbers[r.url];
      }
    }
    if(n.type==='video'&&/seedance/i.test(n.model||'')){
      n.studioRefLabels??={};
      for(const r of result){
        const prefix={image:'图片',video:'视频',audio:'音频'}[r.kind];if(!prefix)continue;
        if(!n.studioRefLabels[r.url]){
          const used=Object.values(n.studioRefLabels);const highest=Math.max(0,...used.filter(x=>x.startsWith('@'+prefix)).map(x=>Number(x.slice(prefix.length+1))||0));
          n.studioRefLabels[r.url]=r.mention&&!used.includes(r.mention)?r.mention:'@'+prefix+(highest+1);
        }
        r.mention=n.studioRefLabels[r.url];
      }
    }
    return result;
  }
  const mentionMode=n=>n.type==='video'&&/seedance/i.test(n.model||'')&&!n.useFrameRoles;
  function sentPrompt(n){
    const text=prompt(n);
    if(!mentionMode(n)){
      if(n.type==='llm')return text;
      const position={};refs(n).forEach((r,i)=>{position[r.label]='参考'+(i+1);});
      // A number that belonged to a removed reference must not fall through to whatever is now
      // at that position; numbers never given out (e.g. 参考1990) stay plain text.
      const given=new Set(Object.values(n.studioRefNumbers||{}).map(String));
      return text.replace(/参考\s*(\d+)/g,(all,k)=>position['参考'+k]||(given.has(k)?all+'（素材缺失）':all));
    }
    const count={image:0,video:0,audio:0},map={};for(const r of refs(n)){count[r.kind]++;map[r.mention]='@'+{image:'Image',video:'Video',audio:'Audio'}[r.kind]+' '+count[r.kind];}
    return text.replace(/@(图片|视频|音频)\s*(\d+)/g,(all,t,i)=>map['@'+t+i]||all+'（素材缺失）');
  }
  function prompt(n){return n.type==='llm'?[n.userInput,llmInputText(n)].filter(Boolean).join('\n\n'):n.type==='audio'?[n.audioPrompt,...generatorSources(n).map(s=>s.prompt)].filter(Boolean).join('\n\n'):generatorSources(n).map(s=>s.prompt).filter(Boolean).join('\n\n');}
  function system(n){return [n.studioTextMode==='rewrite'?'根据用户要求改写所提供的文本，保持原意与事实；直接输出改写结果。':'',n.systemPrompt].filter(Boolean).join('\n');}
  function settled(job){
    if(!job||!['succeeded','failed'].includes(job.status))return '';
    if(job.request?.provider_id==='deepwhite-local-comfy')return '本地运行 · 不扣 API 额度';
    if(job.request?.provider_id==='dreamina-cli')return '即梦账号积分结算 · 具体消耗以即梦任务结果为准';
    const usage=(job.children||[]).map(c=>c.usage);
    if(!usage.length||usage.some(u=>typeof u?.amount!=='number'||!u.currency)||new Set(usage.map(u=>u.currency)).size!==1)return '实际费用待对账 · 平台未返回金额（不是 0 元）';
    return '实际费用：'+(usage[0].currency==='CNY'?'¥':usage[0].currency+' ')+usage.reduce((sum,u)=>sum+u.amount,0).toFixed(3);
  }
  function request(n,id){return {request_id:id,canvas_id:canvasId(),node_id:n.id,provider_id:provider(n),model:n.model,kind:kind(n),prompt:sentPrompt(n),system_prompt:system(n),skill_ids:[],params:{...values(n)},references:refs(n),count:n.type==='generator'?Math.max(1,Math.min(8,Number(n.count||1))):1,multimodal:n.type==='video'?n.multimodal!==false:true,frame_mode:!!n.useFrameRoles};}
  window.studioGenerationQuote=n=>{
    if(!supported(n))return null;
    const r=request(n,'quote-only');return {provider_id:r.provider_id,model:r.model,kind:r.kind,count:r.count,params:{...r.params,aspect_ratio:r.params.ratio,size:r.params.ratio},image_count:r.references.filter(r=>r.kind==='image').length,video_count:r.references.filter(r=>r.kind==='video').length,audio_count:r.references.filter(r=>r.kind==='audio').length,multimodal:r.multimodal,frame_mode:r.frame_mode};
  };
  async function upload(n,files,replace=''){
    const list=Array.from(files).filter(f=>/^(image|video|audio)\//.test(f.type));if(!list.length)return;
    try{
      const form=new FormData();for(const f of list)form.append('files',f);
      const response=await fetch('/api/ai/upload',{method:'POST',body:form});if(!response.ok)throw Error('素材上传失败，请重新选择文件。');
      const data=await response.json();pushUndo();
      if(replace&&data.files[0]){
        // REF-01: the new file takes over the old one's number, @ label, role and place.
        const next=data.files[0].url,order=refs(n).map(r=>r.url);
        for(const map of [n.studioRefLabels,n.studioRefNumbers,n.studioRefRoles])if(map&&map[replace]!==undefined){map[next]=map[replace];delete map[replace];}
        n.studioRefOrder=order.includes(replace)?order.map(u=>u===replace?next:u):order;
        n.studioRefs=(n.studioRefs||[]).filter(r=>r.url!==replace);n.studioExcludedRefs=[...(n.studioExcludedRefs||[]),replace];
      }
      n.studioRefs=[...(n.studioRefs||[]),...data.files];changed();
    }catch(e){setStatus(e.message);}
  }
  function choose(n,replace=''){const el=document.createElement('input');el.type='file';el.accept=n.type==='video'?'image/*,video/*,audio/*':'image/*';el.multiple=!replace;el.onchange=()=>upload(n,el.files,replace);el.click();}
  const mentionMenu=document.createElement('div');mentionMenu.id='studioMentionMenu';mentionMenu.setAttribute('popover','manual');mentionMenu.setAttribute('role','listbox');mentionMenu.setAttribute('aria-label','引用参考素材');document.body.append(mentionMenu);
  let mentionTarget=null,mentionOptions=[],mentionIndex=0;
  function closeMentions(){mentionMenu.hidePopover();if(mentionTarget?.input){mentionTarget.input.setAttribute('aria-expanded','false');mentionTarget.input.removeAttribute('aria-activedescendant');}mentionTarget=null;}
  function insertMention(n,label,range=null){
    const input=document.querySelector(`[data-id="${CSS.escape(n.id)}"] .studio-prompt-input`);if(!input)return;
    const start=range?.start??(document.activeElement===input?input.selectionStart:input.value.length),end=range?.end??start;
    pushUndo();input.focus();input.setRangeText(label+' ',start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));closeMentions();
  }
  function pickMention(){if(mentionTarget&&mentionOptions[mentionIndex])insertMention(mentionTarget.node,mentionOptions[mentionIndex].mention,mentionTarget);}
  function highlightMention(){mentionMenu.querySelectorAll('[role="option"]').forEach((el,i)=>el.setAttribute('aria-selected',String(i===mentionIndex)));if(mentionOptions.length)mentionTarget?.input.setAttribute('aria-activedescendant','studioMentionOption'+mentionIndex);}
  function updateMentions(n,input){
    if(input.isComposing||!mentionMode(n)){closeMentions();return;}
    const before=input.value.slice(0,input.selectionStart),match=/@([^@\s]*)$/.exec(before);
    if(!match){closeMentions();return;}
    const query=match[1].toLowerCase();mentionOptions=refs(n).filter(r=>(r.mention+' '+(r.name||'')).toLowerCase().includes(query));mentionIndex=0;
    mentionTarget={node:n,input,start:input.selectionStart-match[0].length,end:input.selectionStart};mentionMenu.replaceChildren();
    if(!mentionOptions.length){const p=document.createElement('p');p.textContent=refs(n).length?'没有匹配的素材，请换个名称。':'先上传或连接参考素材，再输入 @ 选择。';mentionMenu.append(p);}
    mentionOptions.forEach((r,index)=>{
      const option=document.createElement('button');option.type='button';option.id='studioMentionOption'+index;option.setAttribute('role','option');
      option.innerHTML=`${r.kind==='image'?`<img src="${esc(r.url)}" alt="">`:'<span class="studio-mention-icon">'+(r.kind==='video'?'视频':'音频')+'</span>'}<span><strong>${esc(r.mention)}</strong><small>${esc(r.name||'参考素材')}</small></span>`;
      option.onpointerdown=e=>e.preventDefault();option.onclick=e=>{e.stopPropagation();mentionIndex=index;pickMention();};mentionMenu.append(option);
    });
    highlightMention();mentionMenu.showPopover();input.setAttribute('aria-expanded','true');
    const r=input.getBoundingClientRect(),width=Math.min(360,innerWidth-24);mentionMenu.style.width=width+'px';mentionMenu.style.left=Math.max(12,Math.min(innerWidth-width-12,r.left))+'px';
    const h=mentionMenu.offsetHeight;mentionMenu.style.top=Math.max(12,r.bottom+h+8<innerHeight?r.bottom+6:r.top-h-6)+'px';
  }
  document.addEventListener('pointerdown',e=>{if(mentionTarget&&!mentionMenu.contains(e.target)&&e.target!==mentionTarget.input)closeMentions();},true);
  document.addEventListener('wheel',e=>{if(mentionTarget&&!mentionMenu.contains(e.target))closeMentions();},true);
  // U09: length is checked when generating (withLength), never shown as a permanent line.
  function submissionError(n,text=prompt(n),sent=sentPrompt(n),withLength=true){
    const s=spec(n);if(!s)return '模型参数尚未读取，请稍后重试。';
    if(s.supported===false)return s.note||'当前模型尚不支持生成。';
    if(!mentionMode(n)&&n.type!=='llm'){
      const missing=[...new Set([...sent.matchAll(/(参考\s*\d+)（素材缺失）/g)].map(m=>m[1]))];
      if(missing.length)return `提示词中的${missing.join('、')}对应素材已移除，请撤销、重新关联素材或改写提示词后再生成。`;
    }
    if(mentionMode(n)){
      if(sent.includes('（素材缺失）'))return '有 @ 引用的素材已移除，请重新关联素材。';
      const counts={Image:0,Video:0,Audio:0};for(const r of refs(n))counts[{image:'Image',video:'Video',audio:'Audio'}[r.kind]]++;
      for(const match of sent.matchAll(/@(Image|Video|Audio)\s*(\d+)/gi)){
        const type=match[1][0].toUpperCase()+match[1].slice(1).toLowerCase();
        if(Number(match[2])<1||Number(match[2])>counts[type])return match[0]+' 没有对应素材，请重新关联素材。';
      }
    }
    const length=Array.from(String(text||'').trim()).length;
    if(!withLength)return '';
    if(!length&&s.prompt_min>0)return '请先填写提示词。';
    if(length<s.prompt_min)return `至少需要 ${s.prompt_min} 字，当前 ${length} 字；请补充描述。`;
    return length>s.prompt_max?`当前 ${length} 字，超过此模型上限 ${s.prompt_max} 字；请删减后再生成，已输入的内容会保留。`:'';
  }
  function promptGuidance(n,wrap){
    const input=wrap.querySelector('.studio-prompt-input'),button=wrap.querySelector('.gen-btn'),s=spec(n);if(!input||!s)return;
    const count=document.createElement('small');count.className='studio-prompt-count';count.setAttribute('aria-live','polite');input.after(count);
    const validate=()=>{const error=submissionError(n,undefined,undefined,false)||n.studioInputError||'',invalid=!!error;
      count.textContent=error;count.hidden=!invalid;
      // The compact composer hides ordinary hints; errors must remain visible.
      count.style.setProperty('display',invalid?'block':'none','important');count.classList.toggle('studio-prompt-invalid',invalid);
      if(invalid)input.setAttribute('aria-invalid','true');else input.removeAttribute('aria-invalid');
      if(button){button.disabled=!!n.running||s.supported===false||invalid;button.title=s.supported===false?s.note:invalid?count.textContent:'';}
    };
    input.addEventListener('input',()=>{delete n.studioInputError;validate();});validate();
    if(!mentionMode(n))return;
    const hint=document.createElement('small');hint.className='studio-mention-hint';hint.textContent='输入 @ 选择图片、视频或音频，也可点击下方素材标记插入。调整素材顺序后关联保持不变。';count.after(hint);
    input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls','studioMentionMenu');input.setAttribute('aria-expanded','false');
    let composing=false;
    input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',()=>{composing=false;updateMentions(n,input);});
    input.addEventListener('input',()=>{if(!composing)updateMentions(n,input);});input.addEventListener('click',()=>updateMentions(n,input));
    input.addEventListener('keydown',e=>{
      if(composing||e.isComposing||mentionTarget?.input!==input)return;
      if(e.key==='Escape'){e.preventDefault();closeMentions();}
      else if(['ArrowDown','ArrowUp'].includes(e.key)&&mentionOptions.length){e.preventDefault();mentionIndex=(mentionIndex+(e.key==='ArrowDown'?1:-1)+mentionOptions.length)%mentionOptions.length;highlightMention();}
      else if(e.key==='Enter'&&mentionOptions.length){e.preventDefault();pickMention();}
    });
  }
  function panel(n,wrap){
    const box=stop(document.createElement('section'));box.className='studio-basics';
    const s=spec(n),params=values(n),items=refs(n);
    box.innerHTML=`<div class="studio-ref-head"><strong>参考素材${items.length?' · '+items.length:''}</strong><button type="button" data-add-ref>上传参考素材</button></div><small>支持拖入或粘贴；也可以连接已有素材节点。${mentionMode(n)?'提示词里的 @图片N 标记绑定对应素材；删除标记不会移除连线提供的素材。':'提示词里写“参考N”指缩略图上的编号；调整顺序后发送时会自动换成实际位置。'}</small><div class="studio-ref-list"></div><div class="studio-basic-params"></div><small class="studio-contract-note">${esc(s?.note||'正在读取模型参数…')}</small><details class="studio-sent"><summary>查看实际发送的提示词与素材</summary><pre></pre></details><div class="studio-job-state" aria-live="polite"></div>`;
    box.querySelector('[data-add-ref]').onclick=()=>choose(n);
    const list=box.querySelector('.studio-ref-list');
    items.forEach((r,index)=>{
      const row=document.createElement('div');row.className='studio-ref-item';
      row.innerHTML=`${r.kind==='image'?`<img src="${esc(r.url)}" alt="${esc(r.label||'参考图 '+(index+1))}">`:`<span>${r.kind==='video'?'视频':'音频'}</span>`}<span class="studio-ref-name">${r.label&&!mentionMode(n)?`<b class="studio-ref-label">${esc(r.label)}</b> `:''}${esc(r.name||r.label||'参考素材 '+(index+1))}</span>${n.type==='video'&&r.kind==='image'?`<select aria-label="参考素材 ${index+1} 用途"><option value="">参考图</option><option value="first_frame">首帧</option><option value="last_frame">尾帧</option></select>`:''}<button title="前移" ${index===0?'disabled':''} data-up>↑</button><button title="后移" ${index===items.length-1?'disabled':''} data-down>↓</button><button data-replace>替换</button><button title="移除参考素材" data-remove>×</button>`;
      if(mentionMode(n)){
        const mention=document.createElement('button');mention.type='button';mention.className='studio-ref-mention';mention.textContent=r.mention;mention.title='点击在提示词中引用此素材';mention.setAttribute('aria-label','引用 '+r.mention);
        mention.onclick=()=>insertMention(n,r.mention);row.querySelector('.studio-ref-name').before(mention);
      }
      row.querySelector('select')?.addEventListener('change',e=>{pushUndo();n.studioRefRoles??={};n.studioRefRoles[r.url]=e.target.value;n.useFrameRoles=Object.values(n.studioRefRoles).some(Boolean);if(n.useFrameRoles){n.multimodal=false;n.studioReferenceChoice=true;}changed();});
      if(row.querySelector('select'))row.querySelector('select').value=r.role||'';
      function move(delta){pushUndo();const urls=items.map(r=>r.url);[urls[index],urls[index+delta]]=[urls[index+delta],urls[index]];n.studioRefOrder=urls;changed();}
      row.querySelector('[data-up]').onclick=()=>move(-1);row.querySelector('[data-down]').onclick=()=>move(1);
      row.querySelector('[data-remove]').onclick=()=>{pushUndo();n.studioRefs=(n.studioRefs||[]).filter(x=>x.url!==r.url);n.studioExcludedRefs=[...(n.studioExcludedRefs||[]),r.url];delete n.studioRefRoles?.[r.url];changed();};
      row.querySelector('[data-replace]').onclick=()=>choose(n,r.url);list.append(row);
    });
    const fields=box.querySelector('.studio-basic-params');
    for(const [key,f] of Object.entries(s?.fields||{})){
      const label=document.createElement('label');label.textContent=f.label;
      const select=document.createElement('select');select.dataset.studioParam=key;select.setAttribute('aria-label',f.label);
      f.values.forEach((v,i)=>select.add(new Option(typeof v==='boolean'?(v?'开启':'关闭'):v==='adaptive'?'自适应':String(v),String(i))));select.value=String(f.values.indexOf(params[key]));
      if(key==='main_model'&&!f.values.includes(params[key])){
        const message=s.models_verified===false?'启动引擎后检测；保留工作流模型':f.values.length?String(params[key])+'（未找到，请重新选择）':'未找到兼容模型，请检查安装';
        const unavailable=new Option(message,'-1');unavailable.disabled=true;select.add(unavailable);select.value='-1';select.disabled=!f.values.length;
      }
      select.onchange=()=>{pushUndo();n.studioParams[key]=f.values[Number(select.value)];scheduleSave();};label.append(select);fields.append(label);
    }
    if(n.type==='generator'){
      const label=document.createElement('label');label.className='studio-count-inline';label.title='生成张数';const count=document.createElement('select');count.setAttribute('aria-label','生成张数');for(let i=1;i<=8;i++)count.add(new Option(i+' 张',String(i)));count.value=String(n.count||1);count.onchange=()=>{pushUndo();n.count=Number(count.value);scheduleSave();};label.append(count);box.append(label);
    }
    if(n.type==='video'){
      const label=document.createElement('label');label.textContent='参考方式';const mode=document.createElement('select');mode.setAttribute('aria-label','参考方式');mode.add(new Option('全能参考（无素材时自动文生视频）','multi'));mode.add(new Option('首尾帧','frames'));mode.value=n.useFrameRoles?'frames':'multi';mode.onchange=()=>{pushUndo();n.useFrameRoles=mode.value==='frames';n.multimodal=!n.useFrameRoles;n.studioReferenceChoice=true;if(!n.useFrameRoles)n.studioRefRoles={};changed();};label.append(mode);fields.append(label);
    }
    const details=box.querySelector('details');details.addEventListener('toggle',()=>{if(details.open)details.querySelector('pre').textContent=[system(n),sentPrompt(n),'参考素材：',...refs(n).map((r,i)=>`${r.mention||i+1}. ${r.name||r.kind}${r.role?' · '+r.role:''}`)].filter(Boolean).join('\n\n');});
    if(n.type==='generator'){
      const trigger=document.createElement('button');trigger.type='button';trigger.className='studio-image-settings';trigger.setAttribute('aria-label','图片生成设置');trigger.setAttribute('aria-expanded','false');
      const popup=stop(document.createElement('div'));popup.className='studio-image-settings-popup';popup.setAttribute('popover','auto');popup.setAttribute('aria-label','图片生成参数');
      const head=document.createElement('header');const title=document.createElement('strong');title.textContent='生成设置';const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','关闭图片设置');close.onclick=()=>popup.hidePopover();head.append(title,close);
      fields.before(trigger);popup.append(head,fields,box.querySelector('.studio-contract-note'),details);box.append(popup);
      const summary=()=>{trigger.textContent='设置 · '+[params.ratio,params.resolution_type||params.resolution,params.steps?params.steps+' 步':''].filter(Boolean).join(' / ')+' ▾';};summary();
      fields.addEventListener('change',summary);
      for(const key of ['ratio','resolution','resolution_type','background','optimize_prompt']){
        const select=fields.querySelector(`[data-studio-param="${key}"]`);if(!select)continue;
        const choices=document.createElement('div');choices.className='studio-param-choices'+(key==='ratio'?' studio-ratio-choices':'');choices.setAttribute('role','group');choices.setAttribute('aria-label',select.getAttribute('aria-label'));
        const update=()=>{for(const button of choices.children)button.setAttribute('aria-pressed',String(button.dataset.value===select.value));};
        for(const option of select.options){const b=document.createElement('button');b.type='button';b.dataset.value=option.value;b.textContent=option.textContent;
          if(key==='ratio'&&/^\d+:\d+$/.test(option.textContent)){const [w,h]=option.textContent.split(':').map(Number);const icon=document.createElement('i');icon.style.width=Math.round(22*w/Math.max(w,h))+'px';icon.style.height=Math.round(22*h/Math.max(w,h))+'px';b.prepend(icon);}
          b.onclick=()=>{select.value=b.dataset.value;select.dispatchEvent(new Event('change',{bubbles:true}));update();};choices.append(b);}
        select.hidden=true;select.after(choices);select.addEventListener('change',update);update();
      }
      trigger.onclick=()=>{if(popup.matches(':popover-open')){popup.hidePopover();return;}popup.showPopover();const r=trigger.getBoundingClientRect();popup.style.left=Math.max(8,Math.min(r.left,innerWidth-popup.offsetWidth-8))+'px';popup.style.top=Math.max(8,r.top>popup.offsetHeight+12?r.top-popup.offsetHeight-8:Math.min(r.bottom+8,innerHeight-popup.offsetHeight-8))+'px';};
      popup.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(popup.matches(':popover-open'))));
      popup.addEventListener('keydown',e=>{if(e.key==='Escape'){popup.hidePopover();trigger.focus();}});
      box.classList.add('studio-compact-image');
    }
    const job=jobs.get(n.studioJob);const status=box.querySelector('.studio-job-state');
    const state=n.studioHistoryRestored?(n.studioJobState||'uncertain'):(job?.status||n.studioJobState);
    const stateError=n.studioHistoryRestored?n.studioJobError:(job?.error||n.studioJobError);
    if(state){
      const p=document.createElement('p');p.textContent=(states[state]||state)+(stateError?' · '+stateError:'');status.append(p);
      if(job?.diagnosis){const help=document.createElement('p');help.className='studio-prompt-invalid';help.textContent=job.diagnosis;status.append(help);}
      if(job?.task_ids?.length){const small=document.createElement('small');small.textContent='任务编号：'+job.task_ids.join('、');status.append(small);}
      if(settled(job)){const bill=document.createElement('small');bill.textContent=settled(job);status.append(bill);}
      const child=job?.children?.find(c=>['running','submitting','queued'].includes(c.status));
      const progress=Number(child?.progress);
      if(['running','queued'].includes(state)&&provider(n)==='deepwhite-local-comfy'){
        const small=document.createElement('small');small.textContent=child?.stage||'等待本地引擎 / 排队';
        const bar=document.createElement('progress');bar.className='studio-generation-progress';bar.max=100;bar.setAttribute('aria-label','本地工作流运行进度');
        if(child?.progress!=null&&Number.isFinite(progress)){bar.value=Math.max(0,Math.min(100,progress));small.textContent+=' · '+Math.round(bar.value)+'%（当前采样阶段）';}status.append(small,bar);
      }else if(state==='running'&&progress>0){const small=document.createElement('small');small.textContent='平台进度：'+Math.min(100,progress)+'%';status.append(small);}
      if(state==='paused'||(!job&&n.studioJob&&!['succeeded','failed','uncertain'].includes(state))){const b=document.createElement('button');b.textContent='继续查询';b.onclick=()=>resume(n);status.append(b);}
      if(state==='failed'){const b=document.createElement('button');b.textContent='重新生成';b.onclick=()=>run(n);status.append(b);}
    }
    if(s?.supported===false){for(const b of wrap.querySelectorAll('.gen-btn,.llm-run')){b.disabled=true;b.title=s.note;}}
    wrap.querySelector('.gen-run-row')?.before(box);if(!box.parentElement)wrap.append(box);
  }
  function extend(renderBody){return n=>{
    const wrap=renderBody(n);
    for(const selector of ['.provider-select','.video-provider']){
      const sel=wrap.querySelector(selector);if(sel){const change=sel.onchange;sel.onchange=e=>{change?.(e);render();scheduleSave();};}
    }
    if(!supported(n))return wrap;
    for(const row of wrap.querySelectorAll('.gen-settings-row'))if(!row.querySelector('.model-select,.video-model'))row.classList.add('studio-replaced-setting');
    wrap.querySelector('.video-input-head')?.classList.add('studio-replaced-setting');
    if(n.type==='generator')wrap.querySelector('.input-list')?.previousElementSibling?.classList.add('studio-replaced-setting');
    wrap.querySelectorAll('.prompt-list,.input-list').forEach(el=>el.classList.add('studio-replaced-setting'));
    const generate=wrap.querySelector('.gen-btn');if(generate)generate.textContent=n.running?'生成中…':n.type==='video'?'生成视频':'生成图片';
    panel(n,wrap);
    promptGuidance(n,wrap);
    if(n.type==='generator'){
      const row=wrap.querySelector('.gen-run-row'),model=wrap.querySelector('.model-select'),providerSelect=wrap.querySelector('.provider-select'),settings=wrap.querySelector('.studio-image-settings'),popup=wrap.querySelector('.studio-image-settings-popup');
      if(row&&model&&settings&&popup){
        row.classList.add('studio-image-footer');
        const modelBox=document.createElement('div');modelBox.className='studio-footer-model';modelBox.append(model);row.prepend(modelBox,settings);
        const count=wrap.querySelector('.studio-count-inline');if(count)row.insertBefore(count,generate);
        if(providerSelect){providerSelect.hidden=true;popup.append(providerSelect);}
        generate.setAttribute('aria-label',n.running?'正在生成图片':'生成图片');generate.title=n.running?'正在生成图片':'生成图片';generate.textContent=n.running?'…':'↑';
        wrap.classList.add('studio-image-composer');
      }
    }
    for(const selector of ['.model-select','.video-model','.llm-model']){
      const sel=wrap.querySelector(selector);if(sel){const change=sel.onchange;sel.onchange=e=>{change?.(e);render();scheduleSave();};}
    }
    return wrap;
  };}
  renderGeneratorBody=extend(renderGeneratorBody);renderVideoBody=extend(renderVideoBody);
  const llmBody=renderLLMBody;
  renderLLMBody=n=>{
    const wrap=llmBody(n);if(!supported(n))return wrap;
    wrap.querySelectorAll('.llm-pane-label').forEach((label,i)=>label.textContent=i===0?'提示词':'生成结果');
    const systemButton=wrap.querySelector('.llm-sys-toggle');if(systemButton)systemButton.textContent='系统指令';
    const generate=wrap.querySelector('.llm-run');if(generate)generate.textContent=n.running?'生成中…':n.mode==='chat'?'发送':'生成文本';
    const mode=stop(document.createElement('label'));mode.className='studio-text-mode';mode.textContent='文本任务 ';
    const select=document.createElement('select');select.setAttribute('aria-label','文本任务');[['generate','生成文本'],['rewrite','改写文本'],['custom','自定义要求']].forEach(([v,l])=>select.add(new Option(l,v)));select.value=n.studioTextMode||'generate';select.onchange=()=>{n.studioTextMode=select.value;scheduleSave();};mode.append(select);wrap.prepend(mode);
    const input=wrap.querySelector('.llm-input-output');if(input){input.readOnly=false;input.value=n.userInput||'';input.placeholder='填写需求；连接的文本会作为补充内容一起发送。';input.setAttribute('aria-label','文本提示词');input.oninput=()=>{n.userInput=input.value;scheduleSave();};}
    wrap.addEventListener('input',()=>scheduleSave());panel(n,wrap);
    if(n.outputText){const use=document.createElement('button');use.type='button';use.textContent='将结果放入文本节点';use.onclick=()=>{pushUndo();addNode({id:uid('prompt'),type:'prompt',x:n.x+(n.w||440)+60,y:n.y,text:n.outputText});changed();};wrap.append(use);}
    return wrap;
  };
  // An async response belongs to its original canvas, node object and task selection.
  // A failed or rejected submission still selects its own UUID. An empty task
  // pointer must not let automatic recovery attach an unrelated older job.
  const generationTarget=(n,id=n.studioJob)=>Object.freeze({canvasId:String(canvasId()),nodeId:n.id,node:n,jobId:id||'',expectedJob:n.studioJob||n.studioSubmission?.id||'',submissionId:n.studioSubmission?.id||''});
  const currentTarget=t=>String(canvasId())===t.canvasId&&nodes.find(n=>n.id===t.nodeId)===t.node&&(t.node.studioJob||t.node.studioSubmission?.id||'')===t.expectedJob&&(t.node.studioSubmission?.id||'')===t.submissionId;
  const matchingReceipt=(t,job)=>job.id===t.jobId&&String(job.request?.canvas_id)===t.canvasId&&job.request?.node_id===t.nodeId;
  function rememberJob(job){const previous=jobs.get(job.id);if(!previous||Number(job.updated_at||0)>=Number(previous.updated_at||0))jobs.set(job.id,job);}
  function apply(n,job,target=generationTarget(n,job.id)){
    if(!matchingReceipt(target,job)||(target.expectedJob&&target.expectedJob!==target.jobId))return false;
    const previous=jobs.get(job.id),changedState=!previous||previous.status!==job.status||previous.error!==job.error||JSON.stringify(previous.children)!==JSON.stringify(job.children);
    rememberJob(job); // Keep stale receipts in the task ledger without touching the visible canvas.
    if(jobs.get(job.id)!==job)return apply(n,jobs.get(job.id),target);
    if(!currentTarget(target)||n!==target.node||n.studioHistoryRestored)return false;
    const durableChanged=n.studioJob!==job.id||n.studioJobState!==job.status||(n.studioJobError||'')!==(job.error||'')||(job.text&&n.outputText!==job.text);
    // MCP writes results on the server. A viewer must not compete with that writer.
    if(n.studioControlJob===job.id){if(changedState)refreshNodes([n.id]);return true;}
    n.studioJob=job.id;n.studioJobState=job.status;n.studioJobError=job.error;n.running=['queued','running'].includes(job.status);
    n.studioAccepted??=[];const outputs=job.outputs.filter(o=>!n.studioAccepted.includes(o.url));
    if(outputs.length&&n.type==='audio'){
      n.studioAudioOutputs??=[];n.studioAudioOutputs.push(...outputs);n.studioAccepted.push(...outputs.map(o=>o.url));
      mergeGeneratedOutputs(n,outputs,true);
    }else if(outputs.length){
      const run=runSnapshot(n,job.request.prompt,job.request.references);run.request={task_id:job.task_ids.join(','),request_id:job.id,provider_id:job.request.provider_id,model:job.resolved_model,params:job.request.params};
      const out=outputForNode(n);appendOutputImages(out,outputs,null,[{run,runMs:Math.round((job.updated_at-job.created_at)*1000)}]);mergeGeneratedOutputs(n,outputs,true);addGenerationLog({run,outputs});n.studioAccepted.push(...outputs.map(o=>o.url));
    }
    if(job.text)n.outputText=job.text;
    if(job.status==='succeeded'){n.runStatus='done';n.runError='';}else if(job.status==='failed'){n.runStatus='failed';n.runError=job.error;}
    if(durableChanged||outputs.length)scheduleSave();
    if(changedState||outputs.length)refreshNodes([n.id,...outputNodesForSource(n.id).map(o=>o.id)]);
    return true;
  }
  async function track(n,id){
    const target=generationTarget(n,id),existing=polling.get(id);
    if(n.studioHistoryRestored||!currentTarget(target)||(n.studioJob||'')!==id)return;
    if(existing&&existing.target.node===n&&existing.target.canvasId===target.canvasId)return existing.promise;
    const entry={target,promise:null};polling.set(id,entry);
    entry.promise=(async()=>{try{
      while(currentTarget(target)){
        const job=await api('/api/studio/generations/'+encodeURIComponent(id));
        if(!apply(n,job,target)){if(currentTarget(target))throw Error('任务响应与原请求不匹配，请查看任务记录。');return;}
        const latest=jobs.get(id);if(['succeeded','failed','paused','uncertain'].includes(latest.status))return latest;
        await new Promise(r=>setTimeout(r,2000));
      }
    }catch(e){if(currentTarget(target)){n.running=false;n.studioJobState='paused';n.studioJobError=e.message+'；可继续查询已有任务。';scheduleSave();render();}}finally{if(polling.get(id)===entry)polling.delete(id);}})();
    return entry.promise;
  }
  async function resume(n){const id=n.studioJob,target=generationTarget(n,id);if(!id||!currentTarget(target))return;try{const j=await api('/api/studio/generations/'+encodeURIComponent(id)+'/resume',{});if(currentTarget(target)&&matchingReceipt(target,j))delete n.studioHistoryRestored;if(!apply(n,j,target)){if(currentTarget(target))throw Error('任务响应与原请求不匹配，请查看任务记录。');return;}return await track(n,id);}catch(e){
    if(!currentTarget(target))return;
    if(e.status===404){n.studioJob='';n.studioJobState='failed';n.studioJobError='服务器没有收到这次任务，可以点击重新生成。';n.running=false;changed();}
    else setStatus(e.message);
  }}
  async function run(n,opts={}){
    if(!currentTarget(generationTarget(n)))return;
    if(n.studioSavingSubmission||n.running&&!opts.cascade)return;
    if(n.studioJob&&['paused','queued','running'].includes(n.studioJobState))return resume(n);
    if(n.studioJobState==='uncertain'&&!confirm(provider(n)==='deepwhite-local-comfy'?'请先查看本地生成队列。确定要重新生成吗？':provider(n)==='dreamina-cli'?'请先核对即梦账号中的上次任务。确定仍要重新生成吗？本次可能消耗即梦积分。': '请先在 API 网站核对上次任务。确定仍要重新生成吗？本次会产生新的调用费用。'))return;
    const invalid=submissionError(n);if(invalid){n.studioInputError=invalid;n.runError=invalid;render();if(opts.cascade)throw Error(invalid);return;}
    delete n.studioInputError;
    const id=crypto.randomUUID(),body=JSON.parse(JSON.stringify(request(n,id)));
    delete n.studioHistoryRestored;
    n.studioJob=id;n.studioSubmission={id,request:JSON.parse(JSON.stringify(body)),submitted:false};n.studioSavingSubmission=id;n.studioJobState='queued';n.studioJobError='';n.running=true;render();
    const target=generationTarget(n,id);
    let posted=false;
    try{await window.StudioSave.ensureCurrent({canvasId:target.canvasId,nodeId:target.nodeId,jobId:id,request:body});
      if(!currentTarget(target))throw Error('画布或节点已改变，任务未提交。');
      posted=true;if(n.studioSavingSubmission===id)delete n.studioSavingSubmission;n.studioSubmission.submitted=true;
      const job=await api('/api/studio/generations',body);if(!apply(n,job,target)){if(currentTarget(target))throw Error('任务响应与原请求不匹配，请查看任务记录。');if(opts.cascade)throw Error('画布或节点任务已改变，请在任务记录查看本次结果。');return;}const done=await track(n,id);if(opts.cascade&&(!currentTarget(target)||done?.status!=='succeeded'))throw Error(done?.error||'生成尚未完成，或画布任务已改变');return done;}
    catch(e){
      if(!currentTarget(target)){if(opts.cascade)throw e;return;}
      n.running=false;n.studioJobState=!posted||e.status&&e.status<500?'failed':'paused';n.studioJobError=(posted?'':'任务未提交：')+e.message;
      // If response was lost, keep the UUID so the next action only queries this submission.
      if(!posted||e.status&&e.status<500)n.studioJob='';scheduleSave();render();if(opts.cascade)throw e;
    }finally{if(n.studioSavingSubmission===id)delete n.studioSavingSubmission;}
  }
  for(const name of ['runGenerator','runVideoNode','runLLMNode']){const original=window[name];window[name]=(id,opts={})=>{const n=nodes.find(n=>n.id===id);return n&&supported(n)?run(n,opts):original(id,opts);};}
  const nativeChat=callCanvasLLM;
  callCanvasLLM=async(n,message,messages=[],options={})=>{
    if(!supported(n))return nativeChat(n,message,messages,options);
    if(!currentTarget(generationTarget(n)))throw Error('画布或节点已改变，文本任务未提交。');
    if(n.studioSavingSubmission)throw Error('正在保存本次文本任务，请稍后重试。');
    const invalid=submissionError(n,message,message);if(invalid){n.studioInputError=invalid;render();throw Error(invalid);}
    delete n.studioInputError;
    const id=crypto.randomUUID(),body=JSON.parse(JSON.stringify({...request(n,id),prompt:message,messages}));
    delete n.studioHistoryRestored;
    n.studioJob=id;n.studioSubmission={id,request:JSON.parse(JSON.stringify(body)),submitted:false};n.studioSavingSubmission=id;n.studioJobState='queued';
    const target=generationTarget(n,id);
    let posted=false;
    try{await window.StudioSave.ensureCurrent({canvasId:target.canvasId,nodeId:target.nodeId,jobId:id,request:body});
      if(!currentTarget(target))throw Error('画布或节点已改变，文本任务未提交。');
      posted=true;if(n.studioSavingSubmission===id)delete n.studioSavingSubmission;n.studioSubmission.submitted=true;
      if(!apply(n,await api('/api/studio/generations',body),target))throw Error('画布或节点任务已改变，或响应与原请求不匹配；请查看任务记录。');const job=await track(n,id);if(!currentTarget(target)||job?.status!=='succeeded')throw Error(job?.error||'生成尚未完成，或画布任务已改变');return job.text;}
    catch(e){if(currentTarget(target)){n.running=false;n.studioJobState=!posted||e.status&&e.status<500?'failed':'paused';n.studioJobError=(posted?'':'任务未提交：')+e.message;if(!posted)n.studioJob='';scheduleSave();}throw e;}finally{if(n.studioSavingSubmission===id)delete n.studioSavingSubmission;}
  };
  const draw=renderNode;
  renderNode=n=>{
    if(n.type==='generator'&&supported(n))n.w=Math.max(Number(n.w)||0,640);
    const el=draw(n);const label={generator:'图片',video:'视频',llm:'文本',audio:'音频',output:'生成结果',prompt:'文本素材'}[n.type];
    if(n.studioTitle||label)el.querySelector('.node-title').textContent=n.studioTitle||label;
    const title=el.querySelector('.node-title');if(title){title.title='双击重命名';title.ondblclick=e=>{e.stopPropagation();const name=window.prompt('节点名称',n.studioTitle||title.textContent);if(name?.trim()){pushUndo();n.studioTitle=name.trim().slice(0,80);changed();}};}
    if(supported(n)){
      el.classList.add('studio-stage-node');el.style.height='auto';el.classList.remove('sized');
      el.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();e.stopPropagation();}});
      el.addEventListener('drop',e=>{if(e.dataTransfer?.files.length){e.preventDefault();e.stopPropagation();upload(n,e.dataTransfer.files);}});
      el.addEventListener('paste',e=>{if(e.clipboardData?.files.length){e.preventDefault();e.stopPropagation();upload(n,e.clipboardData.files);}});
    }
    return el;
  };
  const history=document.createElement('dialog');history.className='studio-history studio-history-v3';history.setAttribute('aria-label','生成记录');document.body.append(history);
  let historyRequest=0;
  history.addEventListener('close',()=>{historyRequest++;window.StudioHistoryView.pauseMedia(history);});
  const historyButton=document.createElement('button');historyButton.className='studio-history-button';historyButton.textContent='生成记录';historyButton.type='button';actions.append(historyButton);
  function historyError(card,message){
    let error=card.querySelector(':scope > .studio-history-error');
    if(!error){error=document.createElement('p');error.className='studio-history-error';error.setAttribute('role','alert');card.append(error);}
    error.textContent=message;return error;
  }
  function filterHistory(){
    window.StudioHistoryView.filter(history);
  }
  function readableHistoryError(message){
    return window.StudioHistoryView.readableError(message);
  }
  async function refreshHistory(){
    let head=history.querySelector('header'),body=history.querySelector('.studio-history-body');
    if(!history.open||!head||!body){
      history.replaceChildren();body=document.createElement('div');history.append(body);
      head=window.StudioHistoryView.mount(history,body,{close:()=>history.close(),refresh:refreshHistory});
      window.StudioHistoryView.loading(body);if(!history.open)history.showModal();
    }
    const request=++historyRequest,origin=canvasId(),reload=history.querySelector('[data-history-refresh]');
    reload.disabled=true;reload.textContent='读取中…';body.setAttribute('aria-busy','true');
    try{const data=await api('/api/studio/generations?canvas_id='+encodeURIComponent(origin));
      if(request!==historyRequest||!history.open||origin!==canvasId())return false;
      window.StudioHistoryView.clear(history);
      data.items=Array.isArray(data.items)?data.items:[];const taskIds=new Set(data.items.flatMap(j=>j.task_ids||[])),urls=new Set(data.items.flatMap(j=>j.outputs||[]).map(o=>o.url));
      for(const log of canvas?.logs||[]){
        const outs=(log.outputs||[]).map(o=>typeof o==='string'?{url:o,kind:mediaKindForRef(o)}:o);
        if(log.request?.task_id&&taskIds.has(log.request.task_id)||outs.length&&outs.every(o=>urls.has(o.url)))continue;
        data.items.push({id:log.id,source:'legacy',created_at:(log.createdAt||0)/1000,status:log.status==='success'?'succeeded':log.status,resolved_model:log.model,
          request:{provider_id:log.request?.provider_id||'',model:log.request?.model||log.model,kind:log.request?.kind||log.kind||outs[0]?.kind||'image',prompt:log.prompt||'',params:log.request||{},references:log.refs||[]},task_ids:log.request?.task_id?[log.request.task_id]:[],outputs:outs,text:'',children:[],error:log.error||''});
      }
      data.items.sort((a,b)=>b.created_at-a.created_at);

      for(const job of data.items){
        const name=apiProviders.find(p=>p.id===job.request.provider_id)?.model_names?.[job.request.model]||job.resolved_model||job.request.model||'未记录模型';
        const mj=job.source==='mj',archivePending=mj&&['pending','failed'].includes(job.media_status);
        const stateLabel=mj&&job.remote_status==='succeeded'&&archivePending?(job.media_status==='failed'?'远端已完成 · 保存失败':'远端已完成 · 等待保存'):states[job.status]||({modal:'等待选区确认'})[job.status]||job.status;
        const card=document.createElement('article');card.dataset.jobId=job.id;card.dataset.status=job.status;card.innerHTML=`<strong>${esc(name)}</strong><small>${esc(stateLabel)} · ${new Date(job.created_at*1000).toLocaleString()}</small><p>${esc(job.request.prompt)}</p><details><summary>参数和任务编号</summary><pre>${esc(JSON.stringify({模型:job.resolved_model,参数:job.request.params,参考素材:job.request.references,任务编号:job.task_ids,历史编号:mj?job.id:undefined,远端状态:job.remote_status,媒体状态:job.media_status,用量:(job.children||[]).map(c=>c.usage).filter(Boolean)},null,2))}</pre></details>`;
        if(mj&&job.remote_status){
          const remote=document.createElement('p');remote.className='studio-history-remote';
          const remoteLabel={pending:'远端处理中',succeeded:'远端已完成',failed:'远端生成失败',modal:'等待选区确认',uncertain:'提交结果待核实'}[job.remote_status]||job.remote_status;
          const mediaLabel={pending:'等待保存',completed:'结果已保存',failed:'保存失败',not_required:job.remote_status==='succeeded'?'本次无须媒体保存':'尚未产生可保存媒体'}[job.media_status]||job.media_status||'';
          remote.textContent=remoteLabel+(mediaLabel?' · '+mediaLabel:'');card.append(remote);
        }
        if(archivePending){const note=document.createElement('p');note.className='studio-history-recovery-note';note.textContent='结果尚未保存到本地。恢复只查询原任务或重试保存已有结果，不会重新生成。';card.append(note);}
        if(mj&&job.status==='uncertain'){const note=document.createElement('p');note.className='studio-history-recovery-note';note.textContent='请先核对平台任务记录；核实前不要再次提交。此记录不会自动恢复或重新生成。';card.append(note);}
        if(job.error){const error=historyError(card,readableHistoryError(job.error));error.title=job.error;}
        if(settled(job)){const bill=document.createElement('p');bill.className='studio-history-bill';bill.textContent=settled(job);card.append(bill);}
        for(const output of archivePending?[]:job.outputs){const row=document.createElement('div');row.className='studio-history-output';const media=document.createElement(output.kind==='video'?'video':output.kind==='audio'?'audio':'img');window.StudioHistoryView.prepareMedia(media,output.url);if(media.tagName==='VIDEO'||media.tagName==='AUDIO')media.controls=true;else media.alt='生成结果';const a=document.createElement('a');a.href=output.url;a.download=output.name||'';a.textContent='下载';const use=document.createElement('button');use.textContent='放入画布';use.onclick=()=>{pushUndo();createImageCardFromUrl(output.url,defaultPoint(),output.name);if(nodes.at(-1)?.url===output.url&&['image','video','audio'].includes(output.kind))nodes.at(-1).mediaKind=output.kind;changed();history.close();};row.append(media,a,use);card.append(row);}
        if(job.text){const text=document.createElement('pre');text.textContent=job.text;card.append(text);const copy=document.createElement('button');copy.textContent='复制文本';copy.onclick=()=>copyTextToClipboard(job.text);const save=document.createElement('button');save.textContent='下载文本';save.onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([job.text],{type:'text/plain;charset=utf-8'}));a.download='DeepWhite-文本.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};card.append(copy,save);}
        const restore=document.createElement('button');restore.textContent='复用这次设置';restore.onclick=()=>{pushUndo();const p=defaultPoint(),r=job.request;const n=job.source==='mj'&&r.model!=='midjourney-imagine'?studioAddMj(p):r.kind==='chat'?addLLMNode(p):r.kind==='video'?addVideoNode(p):r.kind==='audio'&&window.studioAddAudioNode?studioAddAudioNode(p,r.params.channel):addGeneratorNode(p);n.apiProvider=r.provider_id;n.llmProvider=r.provider_id;n.model=r.model;n.studioTitle=r.kind==='audio'?'音频':n.studioTitle;n.audioPrompt=r.kind==='audio'?r.prompt:n.audioPrompt;n.studioPrompt=r.input_prompt||r.prompt;n.userInput=r.prompt;n.systemPrompt=r.system_prompt;n.studioRefs=r.references;n.studioParams={...r.params};n.studioParamsModel=r.model;n.multimodal=r.multimodal;n.useFrameRoles=r.frame_mode;n.count=r.count;if(job.source==='mj'){n.studioMjAction=r.model.replace('midjourney-','');n.studioMjParams={...r.params};}changed();history.close();};if(job.source!=='legacy')card.append(restore);
        if(['queued','running','paused'].includes(job.status)||mj&&job.status==='failed'){
          const query=document.createElement('button');const label=mj&&archivePending?'重试保存结果':mj&&job.status==='failed'?'核对原任务':'继续查询';query.textContent=label;
          query.onclick=async()=>{
            if(query.disabled)return;query.disabled=true;query.textContent=mj&&archivePending?'正在恢复保存…':'正在查询…';
            try{
              if(mj){await api('/api/studio/mj/history/'+encodeURIComponent(job.id)+'/resume',{});await refreshHistory();return;}
              const n=nodes.find(n=>n.id===job.request.node_id);if(n){n.studioJob=job.id;await resume(n);await refreshHistory();}else{await api('/api/studio/generations/'+job.id+'/resume',{});query.textContent='已恢复查询，稍后查看记录';}
            }catch(e){historyError(card,e.message||'查询失败，请稍后重试原任务。');}
            finally{query.disabled=false;if(query.textContent==='正在查询…'||query.textContent==='正在恢复保存…')query.textContent=label;}
          };card.append(query);
        }
        if(job.diagnosis){const p=document.createElement('p');p.className='studio-history-recovery-note';p.textContent=job.diagnosis;card.append(p);}
        window.StudioHistoryView.decorate(card,{name,kind:job.request.kind||'image',status:job.status,stateLabel,createdAt:job.created_at,prompt:job.request.prompt,taskIds:job.task_ids,text:job.text,outputs:job.outputs},history);
        body.append(card);
      }
      window.StudioHistoryView.empty(history);filterHistory();
      return true;
    }catch(e){if(request!==historyRequest||!history.open)return false;if(body.querySelector('article'))historyError(body,e.message);else window.StudioHistoryView.loadError(body,e.message,refreshHistory);return false;}
    finally{if(request===historyRequest){reload.disabled=false;reload.textContent='刷新';body.setAttribute('aria-busy','false');}}
  }
  historyButton.onclick=refreshHistory;
  async function load(){try{capabilities=(await api('/api/studio/capabilities')).providers;if(typeof canvas!=='undefined'&&canvas)render();}catch(e){setStatus('模型参数读取失败，请刷新页面。');}}
  load();window.addEventListener('studio-providers-changed',load);window.addEventListener('studio-comfy-ready',load);
  window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='providers-changed')load();});
  let recovered='';setInterval(async()=>{
    if(typeof canvas==='undefined'||!canvas||recovered===canvasId())return;const origin=canvasId();recovered=origin;
    const targets=new Map(nodes.filter(n=>!n.studioHistoryRestored).map(n=>[n.id,generationTarget(n)]));
    try{const data=await api('/api/studio/generations?canvas_id='+encodeURIComponent(origin));const restored=new Set();
      for(const job of data.items){rememberJob(job);if(job.source==='mj'||String(canvasId())!==String(origin))continue;const initial=targets.get(job.request.node_id);if(!initial||restored.has(initial.nodeId)||!currentTarget(initial)||(initial.expectedJob&&initial.expectedJob!==job.id))continue;
        const target=Object.freeze({...initial,jobId:job.id});if(apply(initial.node,job,target)){restored.add(initial.nodeId);if(['queued','running'].includes(job.status))track(initial.node,job.id);}
      }
    }catch{if(canvasId()===origin&&recovered===origin)recovered='';}
  },1500);
  window.StudioStageOne={api,request,run,track,apply,changed,actions,canvasId,states,references:refs,submissionError,getProviders:()=>apiProviders,getCapabilities:()=>capabilities,getJob:id=>jobs.get(id),isSupported:supported};
  window.dispatchEvent(new Event('studio-stage-one-ready'));
})();
