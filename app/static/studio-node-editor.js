/* Node-local prompts and content-sized generation panels, built on the original canvas. */
(() => {
  const smart=!!document.querySelector('.smart-back');
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-node-editor.css?v=1';document.head.append(css);
  if(smart){
    // The native smart composer already owns and saves each node's prompt draft.
    const input=document.getElementById('promptInput');
    input?.setAttribute('aria-label','生成提示词');
    return;
  }
  function seedanceDefault(node){
    if(node.type!=='video'||!/seedance/i.test(node.model||'')||node.studioReferenceChoice)return;
    // Existing explicit first/last-frame choices remain meaningful.
    if(!node.useFrameRoles)node.multimodal=true;
  }
  const sources=generatorSources;
  const preview=renderPromptPreview;
  renderPromptPreview=(container,items)=>preview(container,items.filter(s=>!s.id?.endsWith(':local-prompt')));
  generatorSources=node=>{
    const result=sources(node);
    let local=null;
    if(['generator','video'].includes(node.type)&&String(node.studioPrompt||'').trim()){
      local={id:node.id+':local-prompt',type:'prompt',label:'节点提示词',prompt:node.studioPrompt.trim(),refs:[]};
    }
    if(['generator','video'].includes(node.type)){
      // The stage-one request reads generatorSources directly, so carry native input
      // ordering here instead of relying on render/run callers to order it later.
      const ids=(node.inputs||[]).filter(id=>id!==local?.id&&result.some(source=>source.id===id));
      result.forEach(source=>{if(!ids.includes(source.id))ids.push(source.id);});
      node.inputs=[...ids,...(local?[local.id]:[])];
      const ordered=ids.map(id=>result.find(source=>source.id===id)).filter(Boolean);
      if(local)ordered.push(local);
      return ordered;
    }
    return result;
  };
  const previewStates=new WeakMap();
  function orderedUpstreamSources(node){
    // Read the captured native sources: later style wrappers also decorate the
    // first upstream prompt, which is generation input rather than source text.
    const order=node.inputs||[];
    return sources(node).map((source,index)=>({source,index,rank:order.indexOf(source.id)}))
      .sort((a,b)=>(a.rank<0?order.length+a.index:a.rank)-(b.rank<0?order.length+b.index:b.rank))
      .map(entry=>entry.source).filter(source=>String(source.prompt??'').trim());
  }
  function upstreamLabel(source,index){
    const owner=nodes.find(node=>node.id===source.id||node.id===source.groupId)
      ||(source.type==='loopImage'?nodes.find(node=>node.type==='loop'&&source.id.startsWith(node.id+':image:')):null);
    const custom=owner&&(owner.studioTitle||owner.title||owner.name);
    if(String(custom||'').trim())return String(custom).trim();
    const kind={prompt:'提示词',llm:'LLM',loop:'循环',loopImage:'循环',groupPrompt:'分组文字',promptGroup:'提示词组'}[source.type]||'上游文字';
    return kind+' '+(index+1);
  }
  function renderComposerPreview(node,wrap){
    if(!['generator','video'].includes(node.type))return;
    const upstream=wrap.querySelector('.studio-upstream-preview');
    if(!upstream)return;
    const linked=orderedUpstreamSources(node),items=linked.map((source,index)=>({id:source.id,label:upstreamLabel(source,index),prompt:String(source.prompt)}));
    if(upstream.hidden!==!items.length)upstream.hidden=!items.length;
    const signature=JSON.stringify(items);
    if(previewStates.get(upstream)===signature)return;
    previewStates.set(upstream,signature);
    const list=upstream.querySelector('.studio-upstream-list'),count=upstream.querySelector('.studio-upstream-heading small');
    count.textContent=items.length+' 项';
    const scrollTop=list.scrollTop;list.replaceChildren();
    for(const source of items){
      const card=document.createElement('div');card.className='studio-upstream-item';
      const title=document.createElement('strong');title.textContent=source.label;
      const text=document.createElement('p');text.textContent=source.prompt;card.append(title,text);
      list.append(card);
    }
    list.scrollTop=scrollTop;
  }
  function promptEditor(node,wrap){
    // Remove only these two bodies' old duplicate preview; Comfy/MS/RH keep it.
    wrap.querySelectorAll('.prompt-list').forEach(list=>list.remove());
    if(node.studioPrompt===undefined)node.studioPrompt=node.studioMjParams?.prompt||'';
    const label=document.createElement('div');label.className='studio-node-prompt';
    const title=document.createElement('label');title.className='studio-prompt-title';title.textContent=node.type==='video'?'视频提示词':'图片提示词';
    const input=document.createElement('textarea');input.className='studio-prompt-input';input.rows=4;input.value=node.studioPrompt;
    input.id='studio-node-prompt-'+node.id;title.htmlFor=input.id;
    input.setAttribute('aria-label',title.textContent);input.placeholder=node.type==='video'?'描述画面、人物动作、镜头运动与声音…':'描述你想生成的画面、主体、风格与细节…';
    const hint=document.createElement('small');hint.textContent='可独立填写；有上游文字时，先引用上游，再追加此处提示词。';
    const upstream=document.createElement('div');upstream.className='studio-upstream-preview studio-upstream-prompt';upstream.setAttribute('aria-label','上游引用');
    const heading=document.createElement('div');heading.className='studio-upstream-heading';
    const headingTitle=document.createElement('span');headingTitle.textContent='上游文字';
    const count=document.createElement('small');heading.append(headingTitle,count);
    const list=document.createElement('div');list.className='studio-upstream-list';
    list.tabIndex=0;list.setAttribute('role','region');list.setAttribute('aria-label','上游文字列表');
    // Preserve native text selection/scrolling without selecting or dragging its node.
    for(const event of ['pointerdown','mousedown','click','dblclick','keydown'])list.addEventListener(event,e=>e.stopPropagation());
    list.addEventListener('wheel',event=>event.stopPropagation(),{passive:true});
    upstream.append(heading,list);
    // Merely visiting an editor must not add an empty undo step or discard redo.
    // Save the pre-edit value once, on the first actual change in this session.
    let recordedEdit=false;
    input.addEventListener('blur',()=>{recordedEdit=false;});
    input.addEventListener('input',()=>{
      if(input.value===node.studioPrompt)return;
      if(!recordedEdit){pushUndo();recordedEdit=true;}
      node.studioPrompt=input.value;scheduleSave();renderComposerPreview(node,wrap);
    });
    input.addEventListener('wheel',event=>event.stopPropagation(),{passive:true});
    for(const event of ['pointerdown','mousedown','click','dblclick','keydown'])input.addEventListener(event,e=>e.stopPropagation());
    label.append(title,input,hint,upstream);wrap.prepend(label);
    renderComposerPreview(node,wrap);
  }
  const refreshInputs=refreshGeneratorInputViews;
  refreshGeneratorInputViews=()=>{
    refreshInputs();
    nodes.filter(node=>['generator','video'].includes(node.type)).forEach(node=>{
      const wrap=nodesEl.querySelector(`.node[data-id="${CSS.escape(node.id)}"]`);
      if(wrap)renderComposerPreview(node,wrap);
    });
  };
  const renderImage=renderGeneratorBody;
  renderGeneratorBody=node=>{const wrap=renderImage(node);promptEditor(node,wrap);return wrap;};
  const renderVideo=renderVideoBody;
  renderVideoBody=node=>{
    sanitizeVideoNodeProviderModel(node);
    seedanceDefault(node);
    const wrap=renderVideo(node);promptEditor(node,wrap);
    for(const field of ['multimodal','useFrameRoles']){
      const button=wrap.querySelector(`[data-video-toggle="${field}"]`);
      if(!button)continue;
      if(field==='multimodal'){
        const dot=button.querySelector('.check-dot');button.replaceChildren();if(dot)button.append(dot);button.append('全能参考');
        button.title='图片、视频、音频作为参考素材；Seedance 默认使用此模式。';
      }
      const click=button.onclick;button.onclick=e=>{node.studioReferenceChoice=true;click(e);};
    }
    for(const selector of ['.video-model','.video-provider']){
      const select=wrap.querySelector(selector),change=select.onchange;
      select.onchange=e=>{change(e);seedanceDefault(node);render();};
    }
    return wrap;
  };
  const drawNode=renderNode;
  const output=outputForNode;
  outputForNode=(node,dx=460)=>{
    const existing=hasExplicitOutputConnection(node.id);
    const result=output(node,Math.max(dx,(node.w||defaultNodeSize(node.type).w)+60));
    if(result&&!existing){
      // Wider parameter panels must not be covered by their new result cards.
      const others=nodes.filter(n=>n!==result).map(estimatedNodeRect);
      for(let i=0;i<=others.length;i++){
        const overlap=others.find(r=>result.x<r.x+r.w+24&&result.x+460+24>r.x&&result.y<r.y+r.h+24&&result.y+300+24>r.y);
        if(!overlap)break;
        result.x=overlap.x+overlap.w+60;
      }
    }
    return result;
  };
  const watched=new Set();
  const observer=new ResizeObserver(()=>{
    for(const el of watched)if(!el.isConnected){observer.unobserve(el);watched.delete(el);}
    if(typeof renderLinks==='function')renderLinks();
  });
  renderNode=node=>{
    const supported=['generator','video','midjourney'].includes(node.type);
    if(supported){
      const large=node.type==='midjourney'||node.model==='midjourney-imagine';
      const target=large?620:node.type==='video'?560:480;
      const layout=large?'large':'standard';
      if(node.studioPanelLayout!==layout){node.w=Math.max(Number(node.w)||0,target);node.studioPanelLayout=layout;}
    }
    const el=drawNode(node);
    if(supported){
      el.classList.add('studio-expanded-node');el.classList.remove('sized');
      el.style.height='auto';el.style.minHeight=node.h?`${node.h}px`:'';
      observer.observe(el);watched.add(el);
    }
    return el;
  };
})();
