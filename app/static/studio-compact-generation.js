/* Compact presentation and parameter history: preserve native controls and handlers. */
(() => {
  let dreaminaStatus=null;
  const refreshDreaminaStatus=async()=>{try{const r=await fetch('/api/studio/dreamina/status');if(r.ok)dreaminaStatus=await r.json();}catch{}};
  refreshDreaminaStatus();
  window.addEventListener('studio-dreamina-state',e=>{dreaminaStatus=e.detail?.status||dreaminaStatus;document.querySelectorAll('#nodes [data-id]').forEach(root=>updateDreaminaInfo(root));});
  window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='dreamina-changed')refreshDreaminaStatus().then(()=>document.querySelectorAll('#nodes [data-id]').forEach(root=>updateDreaminaInfo(root)));});
  try{const channel=new BroadcastChannel('studio-dreamina');channel.onmessage=()=>refreshDreaminaStatus().then(()=>document.querySelectorAll('#nodes [data-id]').forEach(root=>updateDreaminaInfo(root)));}catch{}
  function selectedProvider(root,node){return node.apiProvider||root.querySelector('.provider-select,.video-provider')?.value||'';}
  function updateDreaminaInfo(root,node){
    node=node||((nodes||[]).find(item=>item.id===root.dataset.id));if(!node)return;
    const active=selectedProvider(root,node)==='dreamina-cli';let note=root.querySelector('.studio-dreamina-note');
    if(!active){note?.remove();return;}
    if(!note){note=document.createElement('div');note.className='studio-dreamina-note';note.setAttribute('role','status');root.querySelector('.gen-run-row')?.after(note);}
    const s=dreaminaStatus||window.StudioDreamina?.getStatus?.();
    if(!s){note.textContent='即梦账号 · 正在读取授权状态；模型选择会保留。';return;}
    if(!s.enabled){note.textContent='即梦通道已停用 · 此节点保留原模型，启用后可继续使用。';return;}
    if(s.available===false){note.textContent='即梦程序不可用 · 此节点保留原模型，不会转用默认 API。';return;}
    if(!s.authenticated){note.textContent='即梦账号未授权 · 此节点保留原模型，完成授权后可继续生成。';return;}
    note.textContent=`渠道：即梦账号 · 当前余额 ${s.credit===undefined||s.credit===null?'需查询':s.credit+' 即梦积分'} · 不显示 API 估价`;
  }
  // A single active popover owns viewport/content observers, regardless of node count.
  let activePopup=null,layoutFrame=0;
  const setStyle=(element,key,value)=>{if(element.style[key]!==value)element.style[key]=value;};
  const releasePopup=popup=>{
    if(activePopup?.popup!==popup)return;
    activePopup.resize?.disconnect();activePopup.mutations?.disconnect();
    activePopup=null;if(layoutFrame){cancelAnimationFrame(layoutFrame);layoutFrame=0;}
  };
  const positionPopup=()=>{
    const active=activePopup;if(!active)return;
    const {popup,trigger}=active;
    if(!popup.isConnected||!trigger.isConnected||!popup.matches(':popover-open')){releasePopup(popup);return;}
    setStyle(popup,'maxHeight',Math.max(0,innerHeight-16)+'px');
    setStyle(popup,'maxWidth',Math.max(0,innerWidth-16)+'px');
    const r=trigger.getBoundingClientRect(),width=popup.offsetWidth,height=popup.offsetHeight;
    const left=Math.max(8,Math.min(r.left,innerWidth-width-8));
    const desiredTop=r.top>=height+16?r.top-height-8:r.bottom+8;
    const top=Math.max(8,Math.min(desiredTop,innerHeight-height-8));
    setStyle(popup,'left',left+'px');setStyle(popup,'top',top+'px');
  };
  const requestLayout=()=>{if(activePopup&&!layoutFrame)layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;positionPopup();});};
  window.addEventListener('resize',requestLayout);
  const nodeHost=document.getElementById('nodes');
  if(nodeHost)new MutationObserver(()=>{
    if(activePopup&&!activePopup.popup.isConnected)releasePopup(activePopup.popup);
  }).observe(nodeHost,{childList:true,subtree:true});
  const managedPopups=new WeakSet();
  function managePopup(popup,trigger,{onOpen,onMutation,content}={}){
    if(!popup||!trigger||managedPopups.has(popup))return;
    managedPopups.add(popup);
    if(!popup.id)popup.id='studio-generator-params-'+String(trigger.closest('[data-id]')?.dataset.id||'');
    popup.setAttribute('role','dialog');trigger.setAttribute('aria-controls',popup.id);trigger.setAttribute('aria-haspopup','dialog');
    const close=focus=>{
      if(popup.matches(':popover-open'))popup.hidePopover();
      trigger.setAttribute('aria-expanded','false');releasePopup(popup);
      if(focus&&trigger.isConnected)trigger.focus();
    };
    const activate=()=>{
      if(!popup.isConnected||!trigger.isConnected||!popup.matches(':popover-open'))return;
      if(activePopup?.popup!==popup){
        if(activePopup)activePopup.popup.hidePopover();
        activePopup={popup,trigger};onOpen?.();
        if(typeof ResizeObserver!=='undefined'){
          activePopup.resize=new ResizeObserver(requestLayout);activePopup.resize.observe(popup);
        }
        activePopup.mutations=new MutationObserver(records=>{
          // Position writes on the popup itself are ours; only content changes need
          // another measurement. Hidden native rows also refresh their labels.
          if(records.some(record=>record.target!==popup)){onMutation?.();requestLayout();}
        });
        activePopup.mutations.observe(content||popup,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','style','disabled','open']});
      }
      trigger.setAttribute('aria-expanded','true');trigger.title=trigger.textContent;positionPopup();
    };
    // Register after existing onclick handlers. Enhanced controls keep their own
    // summaries, parameter mutations and Undo; only popover lifecycle is shared.
    trigger.addEventListener('click',activate);
    popup.querySelector('header button')?.addEventListener('click',()=>close(true));
    popup.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();close(true);}
    },true);
    popup.addEventListener('beforetoggle',event=>{
      if(event.newState==='closed'){trigger.setAttribute('aria-expanded','false');releasePopup(popup);}
    });
    popup.addEventListener('toggle',()=>{
      trigger.setAttribute('aria-expanded',String(popup.matches(':popover-open')));
      if(popup.matches(':popover-open'))activate();
    });
    popup.addEventListener('toggle',requestLayout,true); // Includes nested details.
    return {close,activate};
  }
  const original=renderNode;
  renderNode=node=>{
    const eligible=node.type==='video'||node.type==='generator';
    const root=original(node);
    if(!eligible)return root;
    if(root.querySelector('.studio-image-footer')){
      managePopup(root.querySelector('.studio-image-settings-popup'),root.querySelector('.studio-image-settings'));
      return root;
    }
    const row=root.querySelector('.gen-run-row'),model=root.querySelector('.model-select,.video-model'),run=row?.querySelector('.gen-btn');
    if(!row||!model||!run)return root;
    updateDreaminaInfo(root,node);
    if(!root.dataset.dreaminaGuard){
      root.dataset.dreaminaGuard='1';
      root.addEventListener('change',()=>updateDreaminaInfo(root,node),true);
      root.addEventListener('click',event=>{
        if(!event.target.closest('.gen-btn')||selectedProvider(root,node)!=='dreamina-cli')return;
        const s=dreaminaStatus||window.StudioDreamina?.getStatus?.();
        if(!s||!s.enabled||s.available===false||!s.authenticated){event.preventDefault();event.stopImmediatePropagation();updateDreaminaInfo(root,node);const info=root.querySelector('.studio-dreamina-note');if(info)info.textContent='即梦未就绪 · 请到设置 / 第三方平台完成配置和授权。此模型选择保持不变，没有切换到 API。';}
      },true);
    }
    const popup=document.createElement('div');popup.className='studio-image-settings-popup studio-universal-params';popup.setAttribute('popover','auto');popup.setAttribute('aria-label','生成参数');
    const head=document.createElement('header');head.innerHTML='<strong>生成设置</strong><button type="button" aria-label="关闭生成设置">×</button>';popup.append(head);
    const trigger=document.createElement('button');trigger.type='button';trigger.className='studio-image-settings';trigger.setAttribute('aria-label','生成参数设置');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-haspopup','dialog');
    popup.id='studio-native-params-'+String(node.id);trigger.setAttribute('aria-controls',popup.id);popup.setAttribute('role','dialog');
    const modelBox=document.createElement('div');modelBox.className='studio-footer-model';
    const modelTrigger=model.nextElementSibling?.classList.contains('studio-model-trigger')?model.nextElementSibling:null;
    modelBox.append(model);if(modelTrigger)modelBox.append(modelTrigger);
    const native=root.querySelector('.gen-settings');if(native)popup.append(native);
    const enhancedVideo=node.type==='video'&&Boolean(window.StudioStageOne?.isSupported?.(node));
    for(const toggle of native?.querySelectorAll('[data-video-toggle]')||[]){
      if(!toggle.closest('.studio-replaced-setting'))toggle.setAttribute('aria-pressed',String(Boolean(node[toggle.dataset.videoToggle])));
    }
    const platform=popup.querySelector('.provider-select,.video-provider');if(platform)platform.hidden=true;
    for(const el of root.querySelectorAll('.studio-basic-params,.studio-contract-note,.studio-sent'))popup.append(el);
    const fields=[];
    for(const [selector,title] of [['.resolution','分辨率'],['.ratio','比例'],['.quality-select','质量']]){
      const control=native?.querySelector(selector);if(!control)continue;
      const label=document.createElement('label');label.className='studio-native-param-field';
      const name=document.createElement('span');name.className='studio-native-param-label';name.textContent=title;
      control.setAttribute('aria-label',title);control.before(label);label.append(name,control);fields.push({label,control});
    }
    for(const option of native?.querySelectorAll('.quality-select option')||[]){
      const names={auto:'自动',low:'低',medium:'中',high:'高'};if(names[option.value])option.textContent=names[option.value];
    }
    for(const option of native?.querySelectorAll('.video-aspect option,.video-resolution option')||[]){
      const names={keep_ratio:'保持原比例',adaptive:'自适应','':'自动'};if(Object.hasOwn(names,option.value))option.textContent=names[option.value];
    }
    const syncFieldVisibility=()=>{for(const {label,control} of fields){const hidden=control.hidden||control.style.display==='none';if(label.hidden!==hidden)label.hidden=hidden;}};
    const optionText=selector=>native?.querySelector(selector)?.selectedOptions?.[0]?.textContent.trim()||'';
    const inputText=selector=>native?.querySelector(selector)?.value||'';
    const dimensions=(width,height,separator)=>width&&height?width+separator+height:'';
    const originalCanvas=canvas;
    const stillCurrent=()=>canvas===originalCanvas&&nodes.includes(node)&&root.isConnected;
    const summary=()=>{
      syncFieldVisibility();
      if(node.type==='generator'&&node.model==='midjourney-imagine'){
        const p=node.studioMjParams||{};
        trigger.textContent='设置 · '+(window.StudioMidjourney?.summary(node)||[p.size||'1:1','MJ '+(p.version||'8.2'),{relax:'Relax',fast:'Fast',turbo:'Turbo'}[p.speed||'relax'],(node.count||1)+' 次'].join(' / '))+' ▾';trigger.title=trigger.textContent;return;
      }
      let parts;
      if(enhancedVideo){
        const paramText=key=>popup.querySelector('.studio-basic-params [data-studio-param="'+key+'"]')?.selectedOptions?.[0]?.textContent.trim()||'';
        const duration=paramText('duration');
        parts=[paramText('ratio'),paramText('resolution_type')||paramText('resolution'),duration?duration+' 秒':''];
      }else if(node.type==='video'){
        parts=[optionText('.video-aspect'),optionText('.video-resolution'),(node.duration||5)+' 秒'];
      }else{
        const resolution=native?.querySelector('.resolution')?.value,ratio=native?.querySelector('.ratio')?.value;
        const customSize=dimensions(inputText('.custom-w-input'),inputText('.custom-h-input'),'×');
        const customRatio=dimensions(inputText('.custom-ratio-w-input'),inputText('.custom-ratio-h-input'),':');
        const sizeText=resolution==='custom'?(customSize||optionText('.resolution')):optionText('.resolution');
        const ratioText=ratio==='custom'?(customRatio||optionText('.ratio')):ratio==='source'?[optionText('.ratio'),customRatio].filter(Boolean).join(' '):optionText('.ratio');
        parts=[resolution==='custom'||resolution==='auto'?'':ratioText,sizeText,optionText('.quality-select'),(node.count||1)+' 张'];
      }
      trigger.textContent='设置 · '+parts.filter(Boolean).join(' / ')+' ▾';
      trigger.title=trigger.textContent;
    };
    const refresh=()=>{summary();requestLayout();};
    root.addEventListener('studio-native-params-updated',refresh);
    let refreshFrame=0;
    const afterNativeEvent=()=>{
      if(refreshFrame)return;
      refreshFrame=requestAnimationFrame(()=>{refreshFrame=0;if(stillCurrent())refresh();});
    };
    // A trusted event can flush microtasks between capture and target callbacks.
    // Defer the capture fallback to the next frame, after native mutation. Original
    // controls also have a target listener registered after their native handlers.
    const summaryControls=new Set([...root.querySelectorAll('input,select'),...popup.querySelectorAll('input,select')]);
    for(const event of ['input','change']){
      root.addEventListener(event,afterNativeEvent,true);
      for(const control of summaryControls)control.addEventListener(event,refresh);
    }
    root.addEventListener('click',event=>{if(event.target.closest('.gen-step-btn,.fit-size-btn'))afterNativeEvent();},true);
    // Only native fields reach this branch; stage-one's existing footer/history is
    // returned untouched above. Capture runs before native handlers change the node.
    const inputSessions=new WeakSet();
    const values=[['.resolution','resolution'],['.ratio','ratio'],['.quality-select','quality'],['.video-aspect','aspectRatio'],['.video-resolution','resolution'],['.custom-ratio-w-input','customRatioWidth'],['.custom-ratio-h-input','customRatioHeight'],['.custom-w-input','customWidth'],['.custom-h-input','customHeight'],['.gen-count-input','count'],['.video-duration','duration']];
    const isChange=control=>{
      const entry=values.find(([selector])=>control.matches(selector));if(!entry||control.disabled||control.closest('.studio-replaced-setting'))return false;
      let next=control.value,previous=node[entry[1]];
      if(entry[1]==='count'){next=Math.max(1,Math.min(8,Number(next)||1));previous=Number(previous||1);}
      else if(entry[1]==='duration'){next=Math.max(1,Math.min(60,Number(next||5)));previous=Number(previous||5);if(!Number.isFinite(next))return false;}
      return String(next)!==String(previous??'');
    };
    root.addEventListener('focusout',event=>inputSessions.delete(event.target),true);
    for(const event of ['input','change'])root.addEventListener(event,e=>{
      const control=e.target;if(!control?.matches||!isChange(control))return;
      if(control.matches('select')){if(event==='change')pushUndo();}
      else if(event==='input'&&!inputSessions.has(control)){pushUndo();inputSessions.add(control);}
    },true);
    root.addEventListener('click',e=>{
      const step=e.target.closest('.gen-step-btn');
      if(step&&!step.disabled){const before=Number(node.count||1),after=Math.max(1,Math.min(8,before+Number(step.dataset.step||0)));if(before!==after)pushUndo();}
      const toggle=e.target.closest('[data-video-toggle]');if(toggle&&!toggle.disabled&&!toggle.closest('.studio-replaced-setting'))pushUndo();
    },true);
    refresh();
    for(const event of ['pointerdown','mousedown','dblclick','wheel','keydown'])popup.addEventListener(event,e=>e.stopPropagation());
    const lifecycle=managePopup(popup,trigger,{onOpen:refresh,onMutation:summary,content:native});
    trigger.onclick=e=>{
      e.stopPropagation();if(popup.matches(':popover-open'))return lifecycle.close(false);
      popup.showPopover();lifecycle.activate();
    };
    row.classList.add('studio-image-footer');row.prepend(modelBox,trigger);root.append(popup);
    if(node.type==='generator'){const count=root.querySelector('.studio-count-inline,.gen-count-row');if(count){count.classList.add('studio-count-inline');const input=count.querySelector('.gen-count-input');if(input)input.setAttribute('aria-label','生成数量');row.insertBefore(count,run);}}
    const text=node.running?'正在生成':node.type==='video'?'生成视频':'生成图片';run.setAttribute('aria-label',text);run.title=text;run.textContent=node.running?'…':'↑';
    return root;
  };
  const style=document.createElement('style');style.textContent='.studio-universal-params .gen-settings{padding:0;border:0;background:transparent;box-shadow:none}.studio-universal-params .gen-settings-row{flex-wrap:wrap;gap:8px}.studio-universal-params .gen-settings-row:empty{display:none}.studio-universal-params [hidden]{display:none!important}.studio-universal-params .studio-basic-params{margin-top:10px}.studio-universal-params input{max-width:100%;box-sizing:border-box}.studio-universal-params .studio-mj-panel{min-width:0;width:auto;margin:0;padding:0}.studio-dreamina-note{margin:6px 0;padding:7px 9px;border-radius:7px;background:var(--dw-gold-soft,var(--panel));color:var(--dw-ink,var(--text));font-size:11px;line-height:1.5}.studio-picker-option[data-dreamina=true] .studio-model-icon{background:var(--dw-gold-soft,var(--panel));color:var(--dw-gold,var(--text))}';document.head.append(style);
})();
