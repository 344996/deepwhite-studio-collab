/* Authorized Fisher catalog: keep preset snapshots with nodes, independent of library updates. */
(() => {
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-content-library.css';document.head.append(css);
  const dialog=document.createElement('dialog');dialog.className='studio-content-library';dialog.setAttribute('aria-label','风格与内容库');document.body.append(dialog);
  let catalog=null,catalogPromise=null,target=null,session=0,inlineStatus=null;
  const drafts=new WeakMap(),emptyDraft={};
  const make=(tag,text)=>{const el=document.createElement(tag);if(text)el.textContent=text;return el;};
  const canvasKey=()=>typeof canvas==='undefined'?'':String(canvas?.id||'');
  const selectedNode=()=>nodes.find(n=>selected.has(n.id)&&['generator','video'].includes(n.type));
  const capture=node=>node?{node,id:node.id,canvasId:canvasKey()}:null;
  const selectedTarget=()=>target?(target.canvasId===canvasKey()&&nodes.find(n=>n.id===target.id)===target.node?target.node:null):selectedNode();
  const isMj=node=>node?.type==='generator'&&/^midjourney/.test(node.model||'');
  const message=text=>{if(dialog.open&&inlineStatus){inlineStatus.textContent=text;inlineStatus.hidden=false;}else setStatus(text);};
  function dismissible(modal){
    let beganOutside=false;
    const outside=e=>{const r=modal.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;};
    modal.addEventListener('pointerdown',e=>{beganOutside=outside(e);});
    modal.addEventListener('pointerup',e=>{if(beganOutside&&outside(e))modal.close();beganOutside=false;});
    modal.addEventListener('pointercancel',()=>{beganOutside=false;});
    modal.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing){e.preventDefault();e.stopPropagation();modal.close();}},true);
    modal.addEventListener('cancel',e=>{e.preventDefault();modal.close();});
  }
  dismissible(dialog);
  const draftFor=(node,kind)=>{
    const key=node||emptyDraft;
    if(!drafts.has(key))drafts.set(key,{});
    const store=drafts.get(key);
    return store[kind]??={search:'',category:'',page:0,entryId:null,mode:'style'};
  };
  const activePresets=node=>Object.values(node.studioCreative||{}).filter(p=>p.kind!=='mj'||p.mode==='vibe'||isMj(node));
  const baseSources=generatorSources;
  generatorSources=node=>{
    // Compose detached source objects: reading a preview/quote must never mutate an upstream node.
    const sources=baseSources(node).map(s=>({...s,refs:[...(s.refs||[])]})),presets=activePresets(node);
    if(!presets.length)return sources;
    const prefix=presets.map(p=>p.prefix||'').filter(Boolean).join('\n'),suffix=presets.map(p=>p.prompt||'').filter(Boolean).join('\n');
    let local=sources.find(s=>s.id===node.id+':local-prompt');
    if(!local){local={id:node.id+':local-prompt',type:'prompt',label:'节点提示词与风格',prompt:'',refs:[]};sources.push(local);node.inputs=[...(node.inputs||[]).filter(id=>id!==local.id),local.id];}
    const first=sources.find(s=>s.prompt)||local;
    if(prefix)first.prompt=[prefix,first.prompt].filter(Boolean).join('\n');
    local.prompt=[local.prompt,suffix].filter(Boolean).join('\n');
    return sources;
  };
  function apply(entry,mode,nodeId){
    if(nodeId!==undefined)target=capture(nodes.find(n=>n.id===nodeId))||{id:nodeId,node:null,canvasId:canvasKey()};
    else if(!dialog.open)target=null;
    let node=selectedTarget();
    if(target&&!node){message('原画布或节点已变化，请重新打开内容库。手写内容保持不变。');return false;}
    if(entry.kind==='mj'&&mode!=='vibe'&&!isMj(node)){message('当前模型不支持 MJ 代码或参数，不能应用此方式。请选择“仅氛围描述”；不会切换模型。');return false;}
    if(entry.kind==='mj'&&mode==='vibe'&&!entry.vibe?.trim()){message('此条目没有可用的氛围描述，不能应用到当前模型。');return false;}
    const draft=draftFor(node,entry.kind);draft.entryId=entry.id;draft.mode=mode;
    pushUndo();if(!node)node=addGeneratorNode(defaultPoint());
    let prompt=entry.prompt||'';
    if(entry.kind==='mj')prompt=mode==='full'?entry.prompt:mode==='vibe'?entry.vibe:[entry.vibe,mode==='parameters'?entry.parameters:entry.codes].filter(Boolean).join('\n');
    // Older releases stored an MJ preset in the style slot. Replace that one only.
    if(entry.kind==='mj'&&node.studioCreative?.style?.kind==='mj')delete node.studioCreative.style;
    if(entry.kind==='style'&&node.studioCreative?.style?.kind==='mj'&&!node.studioCreative.mj)node.studioCreative.mj={...node.studioCreative.style};
    node.studioCreative??={};node.studioCreative[entry.kind]={id:entry.id,name:entry.name,kind:entry.kind,prompt,prefix:entry.kind==='mj'&&mode==='vibe'?'':entry.prefix||'',source:catalog?.source,revision:catalog?.revision,mode};
    selected.clear();selected.add(node.id);render();scheduleSave();dialog.close();setStatus(`已应用 ${entry.name}，未提交生成`);return true;
  }
  async function open(initial='style',nodeId){
    const origin=nodeId===undefined?selectedNode():nodes.find(n=>n.id===nodeId&&['generator','video'].includes(n.type));
    target=capture(origin)||(nodeId===undefined?null:{id:nodeId,node:null,canvasId:canvasKey()});
    const current=++session;let kind=initial,draft=draftFor(origin,kind);dialog.replaceChildren();
    const head=make('header'),title=make('strong','风格与内容库'),close=make('button','关闭');close.onclick=()=>dialog.close();head.append(title,close);dialog.append(head);
    const note=make('p','风格与滤镜是原库的生成预设，以附加卡片保存；MJ 码保留原参数，只用于 Midjourney。手写提示词保持独立，应用不会立即生成。');dialog.append(note);
    const tools=make('div');tools.className='library-controls';const tabs=make('select');tabs.setAttribute('aria-label','内容类型');
    for(const [value,label] of [['style','风格'],['mj','MJ 码图'],['filter','滤镜']])tabs.add(new Option(label,value));tabs.value=kind;
    const category=make('select');category.setAttribute('aria-label','内容分类');const search=make('input');search.type='search';search.placeholder='搜索名称、描述或代码';search.setAttribute('aria-label','搜索内容库');
    const insert=make('select');insert.setAttribute('aria-label','MJ 应用方式');for(const [v,l] of [['style','氛围与风格代码'],['parameters','氛围与全部参数'],['full','完整示例提示词'],['vibe','仅氛围描述']])insert.add(new Option(l,v));
    const clear=make('button','移除此节点的预设');clear.onclick=()=>{const n=selectedTarget();if(!n){message('原画布或节点已变化，请重新打开内容库。');return;}pushUndo();delete n.studioCreative;render();scheduleSave();dialog.close();};
    tools.append(tabs,category,search,insert,clear);dialog.append(tools);
    const compatibility=make('div');compatibility.className='library-compatibility';compatibility.setAttribute('role','status');compatibility.hidden=true;
    const reason=make('p'),vibe=make('button','仅使用氛围描述');vibe.type='button';vibe.className='library-vibe-apply';compatibility.append(reason,vibe);
    inlineStatus=make('p');inlineStatus.className='library-inline-status';inlineStatus.setAttribute('role','alert');inlineStatus.hidden=true;
    const status=make('p','正在读取本地资源…'),grid=make('div'),pager=make('div');status.setAttribute('role','status');status.className='library-count';grid.className='library-grid';pager.className='library-controls';dialog.append(compatibility,inlineStatus,status,grid,pager);if(!dialog.open)dialog.showModal();
    try{if(!catalog){catalogPromise??=(async()=>{const response=await fetch('/static/fisher-library/catalog.json');if(!response.ok)throw Error('本地内容库读取失败');return response.json();})();catalog=await catalogPromise;}}
    catch(e){catalogPromise=null;if(current===session)status.textContent=e.message;return;}
    if(current!==session||!dialog.open)return;
    function restore(){
      draft=draftFor(origin,kind);search.value=draft.search;
      category.replaceChildren(new Option('全部分类',''));[...new Set(catalog.entries.filter(e=>e.kind===kind).map(e=>e.category))].sort().forEach(c=>category.add(new Option(c,c)));
      category.value=[...category.options].some(o=>o.value===draft.category)?draft.category:'';
      insert.value=draft.mode;
    }
    function compatible(){
      const unavailable=kind==='mj'&&!isMj(selectedTarget());
      for(const option of insert.options){option.disabled=unavailable&&option.value!=='vibe';option.textContent=({style:'氛围与风格代码',parameters:'氛围与全部参数',full:'完整示例提示词',vibe:'仅氛围描述'})[option.value]+(option.disabled?'（当前模型不支持 MJ 参数）':'');}
      if(unavailable&&insert.value!=='vibe'){insert.value='vibe';draft.mode='vibe';}
      compatibility.hidden=!unavailable;
      const entry=catalog.entries.find(e=>e.id===draft.entryId&&e.kind==='mj');
      reason.textContent='当前模型不支持 MJ 代码和参数。代码方式不可用，仅可添加氛围描述；不会切换模型或覆盖手写提示词。'+(entry?' 已选择：'+entry.name+'。':' 请先选择一张 MJ 卡片。');
      vibe.disabled=!entry?.vibe?.trim();vibe.onclick=()=>{if(entry)apply(entry,'vibe');};
    }
    function choose(entry){draft.entryId=entry.id;inlineStatus.hidden=true;grid.querySelectorAll('article').forEach(card=>card.classList.toggle('selected',card.dataset.libraryEntry===entry.id));compatible();}
    function draw(){
      insert.hidden=kind!=='mj';const q=search.value.trim().toLowerCase();const matches=catalog.entries.filter(e=>e.kind===kind&&(!category.value||e.category===category.value)&&[e.name,e.description,e.category,e.codes,e.vibe].join(' ').toLowerCase().includes(q));
      const pages=Math.max(1,Math.ceil(matches.length/24));draft.page=Math.min(draft.page,pages-1);status.textContent=`${matches.length} 项 · 第 ${draft.page+1} / ${pages} 页`;grid.replaceChildren();pager.replaceChildren();compatible();
      if(!matches.length)grid.append(make('p','没有匹配的内容，换个关键词或分类试试。'));
      for(const entry of matches.slice(draft.page*24,draft.page*24+24)){
        const card=make('article'),img=make('img');card.dataset.libraryEntry=entry.id;card.classList.toggle('selected',entry.id===draft.entryId);card.addEventListener('click',()=>choose(entry));img.loading='lazy';img.src=entry.thumbnail||entry.preview;img.alt=entry.name;
        const preview=make('button');preview.className='library-preview';preview.title='查看大图';preview.append(img);preview.onclick=()=>{choose(entry);const viewer=make('dialog'),picture=make('img'),done=make('button','关闭预览');viewer.className='studio-library-preview';viewer.setAttribute('aria-label',entry.name+' 预览');picture.src=entry.preview;picture.alt=entry.name;done.onclick=()=>viewer.close();viewer.append(picture,done);document.body.append(viewer);dismissible(viewer);viewer.onclose=()=>viewer.remove();viewer.showModal();};
        const name=make('strong',entry.name),description=make('p',entry.description||entry.vibe||entry.category),button=make('button',kind==='mj'&&!isMj(selectedTarget())?'应用氛围':'应用');button.disabled=kind==='mj'&&!isMj(selectedTarget())&&!entry.vibe?.trim();button.onclick=()=>{choose(entry);apply(entry,insert.value);};card.append(preview,name,description,button);grid.append(card);
      }
      for(const [label,delta] of [['上一页',-1],['下一页',1]]){const b=make('button',label);b.disabled=draft.page+delta<0||draft.page+delta>=pages;b.onclick=()=>{draft.page+=delta;draw();};pager.append(b);}
    }
    tabs.onchange=()=>{kind=tabs.value;restore();draw();};category.onchange=()=>{draft.category=category.value;draft.page=0;draw();};search.oninput=()=>{draft.search=search.value;draft.page=0;draw();};insert.onchange=()=>{draft.mode=insert.value;compatible();};restore();draw();
  }
  function remove(nodeId,key){const node=nodes.find(n=>n.id===nodeId);if(!node?.studioCreative?.[key])return false;pushUndo();delete node.studioCreative[key];render();scheduleSave();return true;}
  function renderCards(node,host){
    if(!host||host.querySelector('.studio-creative-modules')||!(node.type==='generator'||node.type==='video'&&Object.keys(node.studioCreative||{}).length))return;
    const section=make('section');section.className='studio-creative-modules';section.setAttribute('aria-label','图片附加模块');
    const title=make('strong','附加模块'),actions=make('div');actions.className='studio-creative-add';
    if(node.type==='generator')for(const [id,name] of [['style','风格'],['mj','MJ 码'],['filter','滤镜']]){const b=make('button','＋ '+name);b.type='button';b.dataset.contentKind=id;b.onclick=()=>open(id,node.id);actions.append(b);}
    const cards=make('div');cards.className='studio-creative-cards';
    for(const [key,preset] of Object.entries(node.studioCreative||{})){
      const card=make('article');card.className='studio-creative-card';card.dataset.creativeKey=key;
      const disabled=preset.kind==='mj'&&preset.mode!=='vibe'&&!isMj(node);
      const name=make('strong',preset.name||'已有预设'),tag=make('small',({style:'风格',filter:'滤镜 · 生成预设',mj:'MJ 码'}[preset.kind]||'附加模块')+(disabled?' · 当前模型不应用':''));
      const details=make('details'),summary=make('summary','查看内容'),text=make('pre',[preset.prefix,preset.prompt].filter(Boolean).join('\n'));details.append(summary,text);
      const close=make('button','×');close.type='button';close.setAttribute('aria-label','移除 '+(preset.name||'预设'));close.onclick=()=>remove(node.id,key);card.append(name,tag,close,details);cards.append(card);
    }
    if(!cards.childElementCount)cards.append(make('p','选用风格、MJ 码或滤镜；内容独立于手写提示词。'));
    section.append(title,actions,cards);for(const event of ['pointerdown','mousedown','click','dblclick','keydown','wheel'])section.addEventListener(event,e=>e.stopPropagation());
    const editor=host.querySelector('.studio-node-prompt');if(editor)editor.before(section);else host.prepend(section);
  }
  window.StudioContentLibrary={open,apply,remove,renderCards,activePresets,getCatalog:()=>catalog};
})();
