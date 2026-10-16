/* One visible node catalogue for both original canvas engines. Existing data stays intact. */
(() => {
  const smart = location.pathname.endsWith('/smart-canvas.html');
  const menu = document.getElementById('createMenu');
  if (!menu) return;
  const catalogue = Object.freeze([
    {id:'text',label:'文本',icon:'type'},
    {id:'image',label:'图片',icon:'image'},
    {id:'video',label:'视频',icon:'video'},
    {id:'mj',label:'MJ 工具',icon:'wand-sparkles'},
    {id:'audio',label:'音频',icon:'audio-lines',pending:smart},
    {id:'upload',label:'上传',icon:'upload',resource:true},
    {id:'works',label:'从作品导入',icon:'folder-open',resource:true},
  ]);
  const esc = value => String(value || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button = (item, css='studio-add-item') => `<button type="button" class="${css}" data-studio-add="${item.id}" ${item.pending?'disabled title="音频节点目前仅支持普通画布"':''}><i data-lucide="${item.icon}"></i><span>${item.label}</span>${item.pending?'<small>普通画布</small>':''}</button>`;
  menu.classList.add('studio-create-menu');
  menu.setAttribute('aria-label','添加节点');
  menu.innerHTML = '<div class="studio-menu-label">添加节点</div>' + catalogue.filter(i=>!i.resource).map(i=>button(i)).join('')
    + '<div class="studio-menu-divider"></div><div class="studio-menu-label">添加资源</div>' + catalogue.filter(i=>i.resource).map(i=>button(i)).join('');

  function insertionPoint() { return smart ? {...(createMenuPoint || viewportCenter())} : {...(menuPoint || defaultPoint())}; }
  function report(message) { if(smart)toast(message);else setStatus(message); }
  function clampMenu(element, clientX, clientY) {
    const width=element.offsetWidth||210, height=element.offsetHeight||320;
    element.style.left=`${Math.max(10,Math.min(clientX+6,innerWidth-width-10))}px`;
    element.style.top=`${Math.max(10,Math.min(clientY+6,innerHeight-height-10))}px`;
  }
  // Both engines resolve this function at event time for double click and context click.
  const originalOpen = openCreateMenu;
  openCreateMenu = function(...args) {
    originalOpen.apply(this,args);
    const x=smart?args[0].clientX:args[0], y=smart?args[0].clientY:args[1];
    clampMenu(menu,x,y);
  };

  async function chooseUpload(point, groupId='') {
    const input=document.createElement('input');
    input.type='file';input.accept='image/*,video/*,audio/*,.txt,text/plain';input.multiple=true;
    input.onchange=async()=>{
      if(!input.files?.length)return;
      try {
        const files=[...input.files],textFiles=files.filter(isTextFile),mediaFiles=files.filter(file=>!isTextFile(file));
        if(smart) await handleFiles(input.files,groupId,{forceNew:true,point});
        else {
          if(mediaFiles.length){pushUndo();await uploadMediaFiles(mediaFiles,point);}
          for(let index=0;index<textFiles.length;index++)await importTextFile(textFiles[index],{x:point.x+index*36,y:point.y+index*36});
        }
      } catch(error) {report(error.message||'上传失败，请重试。');}
    };
    input.click();
  }

  const worksDialog=document.createElement('dialog');
  worksDialog.className='studio-works-dialog';
  worksDialog.innerHTML='<header><div><strong>从作品导入</strong><p>选择已有画布中的图片、视频或音频</p></div><button type="button" aria-label="关闭作品导入">×</button></header><div class="studio-works-body"></div>';
  document.body.append(worksDialog);
  worksDialog.querySelector('header button').onclick=()=>worksDialog.close();
  async function importWorks(point,groupId='') {
    const body=worksDialog.querySelector('.studio-works-body');
    body.textContent='正在读取作品…';worksDialog.showModal();
    try {
      const response=await fetch('/api/canvas-assets');
      if(!response.ok)throw Error('读取作品失败，请稍后重试。');
      const data=await response.json();
      const items=(data.items||[]).filter(item=>['image','video','audio'].includes(item.kind)&&item.url);
      if(!items.length){body.textContent='暂无可导入的作品。上传素材或生成作品后，可在这里再次使用。';return;}
      body.innerHTML=items.map((item,index)=>`<button type="button" class="studio-work-item" data-work-index="${index}"><i data-lucide="${item.kind==='audio'?'audio-lines':item.kind}"></i><span><strong>${esc(item.name)}</strong><small>${esc(item.canvas_title)}</small></span><i data-lucide="plus"></i></button>`).join('');
      body.querySelectorAll('[data-work-index]').forEach(btn=>btn.onclick=()=>{
        const item=items[Number(btn.dataset.workIndex)];pushUndo();
        if(smart)appendImagesToSmartNode([{url:item.url,name:item.name,kind:item.kind}],groupId,{forceNew:true,point});
        else createImageCardFromUrl(item.url,point,item.name);
        worksDialog.close();
      });
      refreshIcons();
    }catch(error){body.textContent=error.message||'读取作品失败。';}
  }

  function add(kind,point,groupId='') {
    if(kind==='audio'){
      if(typeof window.studioAddAudioNode!=='function'){report('此画布当前没有可用的音频节点。');return;}
      pushUndo();const node=window.studioAddAudioNode(point);
      if(node){node.studioKind='audio';selected.clear();selected.add(node.id);render();scheduleSave();}
      return node;
    }
    if(kind==='upload'){chooseUpload(point,groupId);return;}
    if(kind==='works'){importWorks(point,groupId);return;}
    if(kind==='mj'){pushUndo();return window.studioAddMj(point);}
    if(smart){
      savePromptDraftForCurrent();
      const node=kind==='text'?createPromptNode(point.x-158,point.y-95,{select:false}):createNode(point.x-158,point.y-95,[],{select:false});
      node.title=catalogue.find(i=>i.id===kind).label;
      node.studioKind=kind;
      if(kind==='text')node.llmEnabled=true;
      else node.runSettings={...smartSettingsForNode(null),engine:'api',apiKind:kind,count:1};
      if(groupId){const group=nodes.find(n=>n.id===groupId);if(group)addNodeToSmartGroup(group,node);}
      selectedId=node.id;selectedIds=[];selectedImage={nodeId:'',index:-1};render();scheduleSave();
      return node;
    }
    pushUndo();
    const node=kind==='text'?addLLMNode(point):kind==='image'?addGeneratorNode(point):addVideoNode(point);
    if(node){node.studioKind=kind;selected.clear();selected.add(node.id);render();scheduleSave();}
    return node;
  }
  function onAdd(event) {
    const target=event.target.closest('[data-studio-add]');
    if(!target||target.disabled)return;
    event.preventDefault();event.stopPropagation();
    const point=event.currentTarget===menu?insertionPoint():(smart?viewportCenter():defaultPoint());
    const groupId=smart&&event.currentTarget===menu?createMenuGroupId:'';
    closeCreateMenu();add(target.dataset.studioAdd,point,groupId);
  }
  menu.addEventListener('click',onAdd);

  if(!smart){
    board.addEventListener('dblclick',event=>{
      if(!canvas||event.ctrlKey||event.metaKey||isRKeyDown)return;
      if(![board,world,nodesEl,linksEl].includes(event.target))return;
      event.preventDefault();event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      openCreateMenu(event.clientX,event.clientY);
    });
    const toolbar=document.querySelector('#quickToolbar .toolbar-items');
    if(toolbar){
      const grouping=toolbar.querySelector('[onclick="groupSelectedImages()"]');
      toolbar.replaceChildren();
      toolbar.innerHTML='<button type="button" class="tool-btn studio-process-tool" data-canvas-tool="compare" title="对比画布中的两张图片"><i data-lucide="columns-2"></i><span>双图对比</span></button><button type="button" class="tool-btn studio-process-tool" data-canvas-tool="frames" title="从选中的视频节点截取关键帧"><i data-lucide="film"></i><span>视频帧</span></button><button type="button" class="tool-btn studio-process-tool" data-canvas-tool="edit" title="处理选中的图片"><i data-lucide="paintbrush"></i><span>图片处理</span></button>';
      if(grouping)toolbar.append(grouping);
      toolbar.addEventListener('click',event=>{
        const action=event.target.closest('[data-canvas-tool]')?.dataset.canvasTool;
        if(!action)return;
        event.preventDefault();event.stopPropagation();
        if(action==='compare'){window.openCanvasComparePanel?.();return;}
        const target=[...selected].map(id=>nodes.find(n=>n.id===id)).find(n=>n?.type==='image'&&n.url);
        if(!target){report('请先选择适用的图片或视频节点。');return;}
        const card=document.querySelector(`#nodes [data-id="${CSS.escape(target.id)}"]`);
        selected.clear();selected.add(target.id);refreshSelectionVisuals();
        if(action==='frames'){
          const frame=card?.querySelector('.studio-media-actions button');
          if(mediaKindForNode(target)!=='video'||!frame){report('请先选择一个可读取的视频节点。');return;}
          frame.click();return;
        }
        const image=card?.querySelector('.image-preview-wrap img');
        image?.click();
        requestAnimationFrame(()=>document.querySelector('.studio-image-toolbar button[title="涂改与修改"]')?.click());
      });
      installCanvasComparePanel();
      const dock=document.getElementById('quickToolbar');dock?.classList.add('studio-tools-dock');
      if(typeof applyQuickToolbarState==='function'){quickToolbarExpanded=true;applyQuickToolbarState();}
      const flow=document.createElement('button');flow.type='button';flow.className='tool-btn studio-flow-toggle';flow.innerHTML='<i data-lucide="move-right"></i><span>方向流动</span>';flow.title='切换连线方向动画';
      const enabled=localStorage.getItem('studio_canvas_link_flow')==='1';document.documentElement.classList.toggle('studio-link-flow',enabled);flow.classList.toggle('active',enabled);flow.setAttribute('aria-pressed',String(enabled));
      flow.onclick=()=>{const next=!document.documentElement.classList.contains('studio-link-flow');document.documentElement.classList.toggle('studio-link-flow',next);flow.classList.toggle('active',next);flow.setAttribute('aria-pressed',String(next));localStorage.setItem('studio_canvas_link_flow',next?'1':'0');};
      document.querySelector('#quickToolbar .toolbar-items')?.append(flow);
    }
    // Link menus show only compatible inputs/outputs from the same catalogue.
    const labels={image:['上传','upload'],prompt:['文本','type'],llm:['文本','type'],generator:['图片','image'],video:['视频','video'],midjourney:['MJ 工具','wand-sparkles']};
    const filterOptions=options=>{
      const seen=new Set();
      return options.filter(option=>{
        const label=labels[option.type]?.[0];if(!label||seen.has(label))return false;seen.add(label);return true;
      }).map(option=>({...option,label:labels[option.type][0],icon:labels[option.type][1]}));
    };
    const originalOptions=linkCreateOptions;
    linkCreateOptions=function(state){return filterOptions(originalOptions(state));};
    const originalGeneratorMenu=openGeneratorNodeMenu;
    openGeneratorNodeMenu=function(...args){
      const result=originalGeneratorMenu.apply(this,args);
      for(const id of ['nodeInputMenu','nodeOutputMenu']){
        const panel=document.getElementById(id), seen=new Set();
        panel.querySelectorAll('[data-link-create]').forEach(btn=>{
          const type=btn.dataset.linkCreate, label=labels[type]?.[0];
          if(!label||seen.has(label)){btn.remove();return;}
          seen.add(label);btn.title=label;const span=btn.querySelector('span');if(span)span.textContent=label;
        });
        if(!panel.querySelector('[data-link-create]'))panel.classList.remove('open');
      }
      refreshIcons();return result;
    };
    const originalLinkMenu=openLinkCreateMenu;
    openLinkCreateMenu=function(...args){const result=originalLinkMenu.apply(this,args);if(result)clampMenu(document.getElementById('linkCreateMenu'),args[2],args[3]);return result;};
  }

  function isTextFile(file){return /\.txt$/i.test(file?.name||'')||String(file?.type||'').toLowerCase()==='text/plain';}
  async function importTextFile(file,point){
    const limit=2*1024*1024;
    if(file.size>limit)throw Error(`「${file.name}」超过 2 MB，暂不支持导入。请拆分后再试。`);
    const bytes=await file.arrayBuffer();let text,encoding='UTF-8';
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{
      try{text=new TextDecoder('gb18030',{fatal:true}).decode(bytes);encoding='GB18030';}
      catch{throw Error(`「${file.name}」编码无法识别，请另存为 UTF-8 或 GB18030 后重试。`);}
    }
    text=text.replace(/^\uFEFF/,'');pushUndo();
    const node=addPromptNode(point);node.text=text;node.title=file.name.replace(/\.txt$/i,'')||file.name;node.studioTitle=node.title;
    selected.clear();selected.add(node.id);render();scheduleSave();
    if(encoding!=='UTF-8')report(`已按 ${encoding} 导入「${file.name}」，可直接编辑文本。`);
    return node;
  }
  window.importCanvasTextFiles=async(files,point)=>{
    if(smart)return [];
    const created=[];
    for(let index=0;index<(files||[]).length;index++)created.push(await importTextFile(files[index],{x:point.x+index*36,y:point.y+index*36}));
    return created;
  };

  function installCanvasComparePanel(){
    if(smart||document.getElementById('studioCanvasCompare'))return;
    const panel=document.createElement('section');panel.id='studioCanvasCompare';panel.className='studio-canvas-compare';panel.hidden=true;panel.setAttribute('aria-label','双图对比');
    panel.innerHTML='<header><strong>双图对比</strong><button type="button" data-compare-close aria-label="关闭">×</button></header><div class="studio-canvas-compare-picks"><label>图片 A<select data-compare-a></select></label><label>图片 B<select data-compare-b></select></label></div><div class="studio-canvas-compare-stage"><img data-compare-before alt="图片 A"><div class="studio-canvas-compare-after"><img data-compare-after alt="图片 B"></div><div class="studio-canvas-compare-divider"></div></div><label class="studio-canvas-compare-range">分界位置<input type="range" min="0" max="100" value="50"></label><p data-compare-empty>请选择两张图片开始对比。</p>';
    document.body.append(panel);
    const a=panel.querySelector('[data-compare-a]'),b=panel.querySelector('[data-compare-b]'),stage=panel.querySelector('.studio-canvas-compare-stage'),after=panel.querySelector('.studio-canvas-compare-after'),divider=panel.querySelector('.studio-canvas-compare-divider'),range=panel.querySelector('input[type="range"]'),empty=panel.querySelector('[data-compare-empty]');
    function refs(){const result=[];for(const node of nodes||[]){if(node.type==='image'&&node.url&&mediaKindForNode(node)==='image')result.push({url:node.url,name:node.name||'图片',id:node.id});if(node.type==='output')for(const item of node.images||[]){const url=outputUrlValue(item);if(url&&mediaKindForOutputItem(item)==='image')result.push({url,name:item.name||node.studioTitle||'生成图片',id:node.id});}}return result;}
    function refresh(preselect){const list=refs(),fill=(select,current)=>{select.replaceChildren(new Option('选择画布图片',''));list.forEach((item,i)=>select.add(new Option(item.name,String(i))));select.value=current>=0&&current<list.length?String(current):'';};let firstIndex=a.value===''?-1:Number(a.value),secondIndex=b.value===''?-1:Number(b.value);if(preselect){const url=typeof preselect==='string'?preselect:preselect.url;const found=list.findIndex(item=>item.url===url);if(found>=0)firstIndex=found;}if(firstIndex<0&&selected.size){const chosen=[...selected].map(id=>nodes.find(n=>n.id===id)).filter(n=>n?.type==='image'&&n.url&&mediaKindForNode(n)==='image').map(n=>list.findIndex(item=>item.url===n.url)).filter(index=>index>=0);if(chosen.length){firstIndex=chosen[0];if(chosen.length>1)secondIndex=chosen[1];}}fill(a,firstIndex);fill(b,secondIndex);const update=()=>{const first=a.value===''?null:list[Number(a.value)],second=b.value===''?null:list[Number(b.value)];panel.querySelector('[data-compare-before]').src=first?.url||'';panel.querySelector('[data-compare-after]').src=second?.url||'';empty.hidden=Boolean(first&&second);stage.hidden=!(first&&second);range.disabled=!(first&&second);};a.onchange=b.onchange=update;update();}
    function show(preselect){panel.hidden=false;panel.classList.add('open');refresh(preselect);}
    panel.querySelector('[data-compare-close]').onclick=()=>{panel.hidden=true;panel.classList.remove('open');};range.oninput=()=>{after.style.clipPath=`inset(0 ${100-Number(range.value)}% 0 0)`;divider.style.left=`${range.value}%`;};range.oninput();
    window.openCanvasComparePanel=show;
  }
  refreshIcons();
})();
