/* Studio V2 presentation for the native smart engine. No generation or storage override. */
(() => {
  'use strict';
  if (!document.querySelector('#world #composer') || window.StudioSmartV2) return;
  const root=document.documentElement;root.classList.add('studio-v2','studio-v2-smart');
  // Preserve the native notice text/timer; presentation never takes focus or clicks.
  const notice=document.getElementById('toast');
  if(notice){notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');notice.setAttribute('aria-atomic','true');notice.dataset.noticeLabel=window.StudioI18n?.lang()==='en'?'Notice':'提示';}
  for(const href of ['/static/studio-v2-theme.css','/static/studio-smart-v2.css']){if(!document.querySelector(`link[href^="${href}"]`)){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);}}
  function material(){let value='',explicit=false;try{value=localStorage.getItem('deepwhite_canvas_material')||'';explicit=localStorage.getItem('studio_theme')!==null||localStorage.getItem('canvas_theme')!==null;}catch{}root.classList.toggle('studio-graphite',value==='graphite'||(!value&&!explicit));root.classList.toggle('studio-milk',value==='milk');}
  material();window.addEventListener('storage',material);window.addEventListener('studio-theme-change',material);
  // Keep native edit history while preserving live task owners and receipts.
  // Task receipts and edits outside pushUndo also invalidate stale redo frames.
  const redoStack=[];let historyCanvas=canvas,historyChanging=false,historySignature='';
  const historyTransient=new Set(['_dom','_ltxEditor','_activeLoopCtx','_cascadeIdx','_cascadeFailed','_runMetaTargetId','_selectAfterRunId','studioSavingSubmission']);
  const signature=()=>JSON.stringify({nodes:nodes.map(node=>Object.fromEntries(Object.entries(node).filter(([key])=>!historyTransient.has(key)))),connections:canvas?.connections||[]});
  const modalActive=()=>!!document.querySelector('dialog[open],#imageEditModal.open,#smartLogModal.open,#smartShortcutModal.open,#smartWorkflowTransferModal.open,.workspace-inspector[data-modal=true]');
  let workspaceMode='select',workspaceSpace=false,workspaceCut=false,additiveSelection=null;
  function setMode(value){workspaceMode=value==='hand'?'hand':'select';shell.classList.toggle('workspace-hand',workspaceMode==='hand'||workspaceSpace);window.StudioCanvasWorkspace?.sync();}
  shell.addEventListener('mousedown',event=>{
    if(event.button!==0||modalActive()||isEditableTarget(event.target)||event.target.closest('button,.node-port,.composer,.resize-handle,.smart-minimap,.asset-panel,.workflow-transfer-panel'))return;
    const blank=event.target===shell||event.target===world||event.target.matches?.('svg.connection-layer');
    if(workspaceCut){
      event.preventDefault();event.stopImmediatePropagation();closeCreateMenu();didPan=false;
      connectionEraseState={started:false,count:0,indices:new Set(),lastX:event.clientX,lastY:event.clientY,trail:[]};
      shell.classList.add('connection-erasing');updateConnectionEraseTrail(event);eraseConnectionsAtPoint(event);
    }else if(workspaceMode==='hand'||workspaceSpace){
      event.preventDefault();event.stopImmediatePropagation();closeCreateMenu();didPan=false;
      panState={button:0,startX:event.clientX,startY:event.clientY,ox:viewport.x,oy:viewport.y};shell.classList.add('panning');
    }else if(blank){
      event.preventDefault();event.stopImmediatePropagation();closeCreateMenu();didPan=false;
      additiveSelection=event.shiftKey?selectedNodeIds():null;
      selectionState={startScreen:{x:event.clientX,y:event.clientY},startWorld:screenToWorld(event)};updateSelectionBox(event);
    }
  },true);
  const nativeFinishSelection=finishSelection;
  finishSelection=function(...args){
    const keep=additiveSelection;additiveSelection=null;const result=nativeFinishSelection.apply(this,args);
    if(keep){selectedIds=[...new Set([...keep,...selectedNodeIds()])].filter(id=>nodes.some(node=>node.id===id));selectedId=selectedIds.length===1?selectedIds[0]:'';render();}
    return result;
  };
  const nativeSelectionUi=syncSelectionUi;
  syncSelectionUi=function(...args){const result=nativeSelectionUi.apply(this,args);window.StudioCanvasWorkspace?.sync();return result;};
  document.addEventListener('keydown',event=>{
    if(event.isComposing||isEditableTarget(event.target)||modalActive())return;
    const key=event.key.toLowerCase();let action;
    if((event.ctrlKey||event.metaKey)&&key==='k')action=openSearch;
    else if(!event.ctrlKey&&!event.metaKey&&!event.altKey){
      if(key==='v')action=()=>setMode('select');else if(key==='h')action=()=>setMode('hand');
      else if(key==='x')action=()=>{workspaceCut=true;shell.classList.add('workspace-cut');};
      else if(event.code==='Space')action=()=>{workspaceSpace=true;setMode(workspaceMode);};
      else if(event.shiftKey&&event.code==='Digit1')action=()=>fit();
      else if(key==='f')action=()=>{const node=selectedNode();if(node)fit(node);};
      else if(key==='escape'&&portDragState)action=()=>{portDragState=null;discardPendingUndo();shell.classList.remove('port-dragging');clearPortDragVisual();};
    }
    if(action){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)action();}
  },true);
  const releaseCutter=event=>{workspaceCut=false;shell.classList.remove('workspace-cut');if(connectionEraseState)window.onmouseup(event);};
  document.addEventListener('keyup',event=>{if(event.code==='Space'){workspaceSpace=false;setMode(workspaceMode);}if(event.key.toLowerCase()==='x')releaseCutter(event);},true);
  window.addEventListener('blur',event=>{workspaceSpace=false;additiveSelection=null;releaseCutter(event);setMode(workspaceMode);if(portDragState){portDragState=null;discardPendingUndo();shell.classList.remove('port-dragging');clearPortDragVisual();}});
  function checkHistory(){if(historyChanging)return;if(historyCanvas!==canvas){historyCanvas=canvas;undoStack.length=0;redoStack.length=0;historySignature='';return;}if(!redoStack.length)return;const next=signature();if(next!==historySignature){redoStack.length=0;historySignature='';}}
  historySignature=signature();
  const nativePushUndo=pushUndo;pushUndo=function(...args){checkHistory();if(!undoSuppressed&&canvas)redoStack.length=0;return nativePushUndo.apply(this,args);};
  const nativeCommitUndo=commitPendingUndo;commitPendingUndo=function(...args){checkHistory();if(pendingUndoSnapshot)redoStack.length=0;return nativeCommitUndo.apply(this,args);};
  const nativeUndo=performUndo;performUndo=function(...args){
    if(modalActive())return;checkHistory();if(!undoStack.length)return nativeUndo.apply(this,args);
    const current=snapshotForUndo();historyChanging=true;
    try{const result=nativeUndo.apply(this,args);if(result!==false){redoStack.push(current);if(redoStack.length>UNDO_LIMIT)redoStack.shift();}return result;}
    finally{historyChanging=false;historySignature=signature();}
  };
  function redo(){
    checkHistory();if(!redoStack.length){toast('没有可重做的操作');return;}
    const snapshot=redoStack[redoStack.length-1],current=snapshotForUndo();historyChanging=true;undoSuppressed=true;
    try{
      const restored=studioRestoreHistorySnapshot(snapshot);
      if(!restored.ok){toast(restored.reason||'无法重做此操作，当前画布已保留');return;}
      redoStack.pop();undoStack.push(current);if(undoStack.length>UNDO_LIMIT)undoStack.shift();
      const present=new Set(nodes.map(node=>node.id));
      selectedId=present.has(snapshot.selectedId)?snapshot.selectedId:'';
      selectedIds=(snapshot.selectedIds||[]).filter(id=>present.has(id));
      selectedImage=present.has(snapshot.selectedImage?.nodeId)?snapshot.selectedImage:{nodeId:'',index:-1};
      activeComposerSubject=null;lastComposerNodeId='';render();scheduleSave();
    }finally{undoSuppressed=false;historyChanging=false;historySignature=signature();}
  }
  const nativeScheduleSave=scheduleSave;scheduleSave=function(...args){checkHistory();return nativeScheduleSave.apply(this,args);};
  document.addEventListener('input',()=>queueMicrotask(checkHistory));document.addEventListener('change',()=>queueMicrotask(checkHistory));
  document.addEventListener('keydown',e=>{const key=String(e.key||'').toLowerCase();if(!(e.ctrlKey||e.metaKey)||!(key==='y'||(key==='z'&&e.shiftKey)))return;if(isEditableTarget(e.target)||modalActive())return;e.preventDefault();e.stopImmediatePropagation();redo();},true);
  window.addEventListener('studio-draft-restored',e=>{if(e.detail?.canvasId&&e.detail.canvasId!==canvas?.id)return;undoStack.length=0;redoStack.length=0;pendingUndoSnapshot=null;historyCanvas=canvas;historySignature=signature();});
  const el=(tag,cls)=>{const element=document.createElement(tag);element.className=cls;return element;};
  const button=(id,label,icon,action)=>{const b=el('button','sv2-button');b.type='button';b.id=id;b.title=label;b.setAttribute('aria-label',label);b.innerHTML=`<i data-lucide="${icon}" aria-hidden="true"></i><span>${label}</span>`;b.addEventListener('click',action);return b;};
  // Keep a world layer for the map. Previously every pointer/wheel event replaced
  // all map nodes, forcing layout of the 500-node test scene before projection.
  const mapEntries=new Map(),mapDirty=new Set();let mapCanvas=null,mapList=null,mapStructure=true,mapLayer=null,mapBounds=null,mapBoundsDirty=true,mapFrame=0,mapFrames=0,mapRectReads=0;
  const mapSizes={width:146,height:100,viewWidth:innerWidth,viewHeight:innerHeight};
  const queueMap=()=>{if(!mapFrame&&canvas)mapFrame=requestAnimationFrame(()=>{mapFrame=0;renderMinimap();});};
  const mapResize=new ResizeObserver(records=>{for(const record of records)mapDirty.add(record.target.dataset.id);queueMap();});
  new ResizeObserver(records=>{for(const record of records){if(record.target===shell){mapSizes.viewWidth=record.contentRect.width;mapSizes.viewHeight=record.contentRect.height;}else{mapSizes.width=record.contentRect.width;mapSizes.height=record.contentRect.height;}}queueMap();}).observe(shell);
  const mapBoxResize=new ResizeObserver(records=>{for(const record of records){mapSizes.width=record.contentRect.width;mapSizes.height=record.contentRect.height;}queueMap();});
  if(minimapContent)mapBoxResize.observe(minimapContent);
  function syncMapStructure(){
    const cards=new Map([...world.querySelectorAll(':scope>.image-node')].map(card=>[card.dataset.id,card])),live=new Set();
    for(const node of nodes){if(node.id===SMART_LOG_PREVIEW_NODE_ID)continue;live.add(node.id);const card=cards.get(node.id);let entry=mapEntries.get(node.id);
      if(!entry){const dot=el('div','minimap-node');dot.dataset.nodeId=node.id;dot.style.cssText='position:absolute;box-sizing:border-box;border-radius:calc(2 * var(--sv2-map-pixel));';mapLayer.append(dot);entry={node,dot};mapEntries.set(node.id,entry);}
      if(entry.card!==card){if(entry.card)mapResize.unobserve(entry.card);entry.card=card;if(card)mapResize.observe(card);}
      entry.node=node;mapDirty.add(node.id);
    }
    for(const [id,entry]of mapEntries){if(live.has(id))continue;if(entry.card)mapResize.unobserve(entry.card);entry.dot.remove();mapEntries.delete(id);mapDirty.delete(id);}
    mapList=nodes;mapStructure=false;mapBoundsDirty=true;
  }
  renderMinimap=function(){
    if(!minimapContent||!canvas)return;mapFrames++;
    if(mapCanvas!==canvas||!mapLayer?.isConnected){
      mapCanvas=canvas;mapResize.disconnect();mapEntries.clear();mapDirty.clear();mapStructure=true;mapBounds=null;
      mapLayer=el('div','sv2-minimap-world');mapLayer.style.cssText='position:absolute;left:0;top:0;width:1px;height:1px;transform-origin:0 0;pointer-events:none;';
      minimapViewport=el('div','smart-minimap-viewport');minimapViewport.id='minimapViewport';minimapContent.replaceChildren(mapLayer,minimapViewport);
    }
    if(mapStructure||mapList!==nodes)syncMapStructure();
    for(const [id,entry]of mapEntries)if(entry.x!==entry.node.x||entry.y!==entry.node.y)mapDirty.add(id);
    if(resizeState?.id)mapDirty.add(resizeState.id);
    for(const id of mapDirty){const entry=mapEntries.get(id);if(!entry)continue;const rect=nodeRect(entry.node);mapRectReads++;
      if(entry.x!==rect.x||entry.y!==rect.y||entry.width!==rect.width||entry.height!==rect.height){Object.assign(entry,rect);mapBoundsDirty=true;
        Object.assign(entry.dot.style,{left:rect.x+'px',top:rect.y+'px',width:`max(${rect.width}px, calc(4 * var(--sv2-map-pixel)))`,height:`max(${rect.height}px, calc(4 * var(--sv2-map-pixel)))`});}
    }
    mapDirty.clear();
    if(mapBoundsDirty){let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;for(const entry of mapEntries.values()){left=Math.min(left,entry.x);top=Math.min(top,entry.y);right=Math.max(right,entry.x+entry.width);bottom=Math.max(bottom,entry.y+entry.height);}mapBounds=Number.isFinite(left)?{left,top,right,bottom}:null;mapBoundsDirty=false;}
    smartArrangeBtn?.classList.toggle('visible',selectedNodeIds().length>0);
    const view={x:-viewport.x/viewport.scale,y:-viewport.y/viewport.scale,width:mapSizes.viewWidth/viewport.scale,height:mapSizes.viewHeight/viewport.scale};
    const minX=Math.min(mapBounds?.left??view.x,view.x,-200),minY=Math.min(mapBounds?.top??view.y,view.y,-200),maxX=Math.max(mapBounds?.right??view.x+view.width,view.x+view.width+200),maxY=Math.max(mapBounds?.bottom??view.y+view.height,view.y+view.height+200);
    const width=mapSizes.width||146,height=mapSizes.height||100,scale=Math.min(width/Math.max(1,maxX-minX),height/Math.max(1,maxY-minY)),offsetX=(width-(maxX-minX)*scale)/2,offsetY=(height-(maxY-minY)*scale)/2;
    smartMinimapState={minX,minY,scale,offsetX,offsetY,width,height};mapLayer.style.transform=`translate(${offsetX-minX*scale}px,${offsetY-minY*scale}px) scale(${scale})`;mapLayer.style.setProperty('--sv2-map-pixel',1/scale+'px');
    Object.assign(minimapViewport.style,{left:offsetX+(view.x-minX)*scale+'px',top:offsetY+(view.y-minY)*scale+'px',width:Math.max(4,view.width*scale)+'px',height:Math.max(4,view.height*scale)+'px'});
  };
  const header=el('header','sv2-header'),identity=el('div','sv2-identity'),heading=el('div','sv2-heading'),right=el('div','sv2-header-tools');
  const back=document.querySelector('.smart-back'),title=document.querySelector('#smartTitle');if(back)identity.append(back);
  heading.innerHTML='<span class="sv2-eyebrow">深白片场 / 智能画布</span>';if(title)heading.append(title);identity.append(heading);
  const status=el('span','sv2-save-status');status.id='smartV2SaveStatus';status.textContent='自动保存';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const save=button('smartV2Save','保存','save',async()=>{save.disabled=true;status.textContent='正在保存…';try{const result=await saveCanvas();if(result?.code==='busy')status.textContent='保存进行中';}catch{status.dataset.state='error';status.textContent='保存失败，请重试';}finally{save.disabled=false;}});
  right.append(status,save,button('smartV2Search','查找节点','search',openSearch));const settingsButton=document.querySelector('#studioSettingsButton');if(settingsButton)right.append(settingsButton);header.append(identity,right);document.body.append(header);
  const rail=el('nav','sv2-rail');rail.setAttribute('aria-label','画布工具');
  const add=button('smartV2Add','添加节点','plus',()=>{const r=add.getBoundingClientRect();openCreateMenu({clientX:r.right+12,clientY:r.top});});rail.append(add);
  const advanced=el('details','sv2-advanced');advanced.innerHTML='<summary title="更多节点"><i data-lucide="boxes" aria-hidden="true"></i><span>更多节点</span></summary>';
  const advancedPanel=el('div','sv2-advanced-panel');for(const [type,label,icon] of [['group','分组','group'],['loop','循环','repeat'],['minimax','MiniMax 编辑器','clapperboard']])advancedPanel.append(button('smartV2Add-'+type,label,icon,()=>{createMenuPoint=viewportCenter();createNodeFromMenu(type);advanced.open=false;}));advanced.append(advancedPanel);rail.append(advanced);
  for(const id of ['assetToggle','smartWorkflowToggle']){const control=document.getElementById(id);if(control)rail.append(control);}document.body.append(rail);
  const bottom=el('nav','sv2-bottom');bottom.setAttribute('aria-label','整理与任务');const arrange=document.querySelector('.studio-canvas-actions');if(arrange)bottom.append(arrange);
  for(const id of ['smartLogToggle','smartShortcutToggle']){const control=document.getElementById(id);if(control)bottom.append(control);}document.body.append(bottom);
  const view=el('nav','sv2-view');view.setAttribute('aria-label','画布视图');
  view.append(button('smartV2Fit','适合画布','scan',()=>fit()),button('smartV2ZoomOut','缩小','minus',()=>zoomBy(1/1.15)));
  const zoom=button('smartV2Zoom','100%','',()=>setZoom(1));view.append(zoom,button('smartV2ZoomIn','放大','plus',()=>zoomBy(1.15)));document.body.append(view);
  const empty=el('section','sv2-empty');empty.id='smartV2Empty';empty.hidden=true;empty.innerHTML='<div class="sv2-empty-symbol"><i data-lucide="workflow" aria-hidden="true"></i></div><small>YOUR NEXT SCENE</small><h1>让灵感在画布上展开。</h1><p>添加提示词、导入参考图，再把它们连接成你的创作流程。</p>';empty.append(button('smartV2EmptyAdd','添加第一个节点','plus',()=>add.click()));document.body.append(empty);
  const search=el('dialog','sv2-search');search.id='smartV2SearchDialog';search.innerHTML='<div class="sv2-dialog-head"><div><small>CANVAS SEARCH</small><h2>查找节点</h2></div><button type="button" aria-label="关闭查找">×</button></div><input id="smartV2SearchInput" type="search" placeholder="输入标题、提示词或模型…" aria-label="查找节点"><div id="smartV2SearchResults"></div>';
  search.querySelector('button').onclick=()=>search.close();search.addEventListener('click',e=>{const r=search.getBoundingClientRect();if(e.target===search&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))search.close();});document.body.append(search);
  search.querySelector('input').addEventListener('input',renderSearch);search.addEventListener('close',()=>document.getElementById('smartV2Search').focus());
  search.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();search.close();}});
  function openSearch(){renderSearch();search.showModal();search.querySelector('input').focus();}
  function renderSearch(){const query=search.querySelector('input').value.trim().toLowerCase(),list=search.querySelector('#smartV2SearchResults');list.replaceChildren();
    const found=nodes.filter(n=>[n.title,n.text,n.promptDraftText,n.runSettings?.model,n.runSettings?.videoModel].filter(Boolean).join(' ').toLowerCase().includes(query));
    for(const n of found){const b=el('button','sv2-search-result');b.type='button';b.dataset.nodeId=n.id;const name=el('strong','');name.textContent=n.title|| (n.type==='smart-prompt'?'提示词':'图片节点');const kind=el('span','');kind.textContent=n.type==='smart-prompt'?'提示词':n.type==='smart-group'?'分组':n.type==='smart-loop'?'循环':n.type==='smart-minimax'?'MiniMax':n.runSettings?.apiKind==='video'?'视频':'图片';b.append(name,kind);b.onclick=()=>{savePromptDraftForCurrent();selectedId=n.id;selectedIds=[];selectedImage={nodeId:'',index:-1};render();search.close();centerNode(n);};list.append(b);}
    if(!found.length){const p=el('p','sv2-search-empty');p.textContent='没有找到节点，试试其他关键词。';list.append(p);}
  }
  function setZoom(scale){const center=viewportCenter(),next=Math.max(0.06,Math.min(2,scale));viewport.scale=next;viewport.x=innerWidth/2-center.x*next;viewport.y=innerHeight/2-center.y*next;applyViewport();scheduleSave();}
  function zoomBy(factor){setZoom(viewport.scale*factor);}
  function centerNode(node){const rect=nodeRect(node);viewport.x=innerWidth/2-(rect.x+rect.width/2)*viewport.scale;viewport.y=innerHeight*.38-(rect.y+rect.height/2)*viewport.scale;applyViewport();scheduleSave();}
  // These overlays keep their original DOM/handlers. Only their screen geometry changes.
  const editor=document.getElementById('composer'),editorCard=editor.querySelector('.composer-card');
  const owner=el('div','sv2-editor-owner');owner.innerHTML='<span></span>';const locate=button('smartV2LocateEditor','定位正在编辑的节点','locate-fixed',()=>{const node=activeComposerNode();if(node)centerNode(node);});const closeEditor=button('smartV2CloseEditor','收起编辑器并取消选中','x',()=>{clearSelection();render();scheduleSave();});owner.append(locate,closeEditor);editor.querySelector('.composer-head').append(owner);
  let overlayRaf=0,activeMenu=null,fitDock=null,fittingView=false,ownerNode=null,ownerOrdinal=0;
  const clamp=(value,min,max)=>Math.max(min,Math.min(value,Math.max(min,max)));
  const style=(element,key,value)=>{if(element.style[key]!==value)element.style[key]=value;};
  const variable=(element,key,value)=>{if(element.style.getPropertyValue(key)!==value)element.style.setProperty(key,value);};
  function safeArea(){
    const bounds=shell.getBoundingClientRect(),head=header.getBoundingClientRect(),railRect=rail.getBoundingClientRect();
    let right=bounds.right-20;const assets=document.getElementById('assetPanel');
    if(assets?.classList.contains('open'))right=Math.min(right,assets.offsetLeft-14,assets.getBoundingClientRect().left-14);
    const inspector=document.getElementById('workspaceInspector');if(inspector&&!inspector.hidden&&innerWidth>900)right=Math.min(right,inspector.getBoundingClientRect().left-14);
    return {left:Math.max(bounds.left+20,railRect.right+14),top:Math.max(bounds.top+14,head.bottom+14),right,bottom:Math.min(bounds.bottom-20,bottom.getBoundingClientRect().top-14,view.getBoundingClientRect().top-14)};
  }
  function projectRect(node){
    const r=nodeRect(node),shellRect=shell.getBoundingClientRect(),s=viewport.scale;
    const rect={left:shellRect.left+viewport.x+r.x*s,top:shellRect.top+viewport.y+r.y*s,right:shellRect.left+viewport.x+(r.x+r.width)*s,bottom:shellRect.top+viewport.y+(r.y+r.height)*s};
    // New receipts occupy edit space beyond the media-only native layout size.
    const task=world.querySelector(`.image-node[data-id="${CSS.escape(node.id)}"] .studio-native-task-list`);
    if(task){const t=task.getBoundingClientRect();rect.left=Math.min(rect.left,t.left);rect.top=Math.min(rect.top,t.top);rect.right=Math.max(rect.right,t.right);rect.bottom=Math.max(rect.bottom,t.bottom);}
    return rect;
  }
  function minimapRect(){return document.querySelector('.smart-minimap')?.getBoundingClientRect();}
  const intersect=(r,a)=>a?Math.max(0,Math.min(r.right,a.right)-Math.max(r.left,a.left))*Math.max(0,Math.min(r.bottom,a.bottom)-Math.max(r.top,a.top)):0;
  function avoidMinimap(x,y,width,height,safe){const map=minimapRect();if(intersect({left:x,top:y,right:x+width,bottom:y+height},map)>0)y=clamp(map.top-height-12,safe.top,safe.bottom-height);return y;}
  function fitEditorPosition(safe,width,height){const left=clamp(fitDock.x,safe.left,safe.right-width),top=avoidMinimap(left,clamp(fitDock.y,safe.top,safe.bottom-height),width,height,safe);return {left,top,right:left+width,bottom:top+height};}
  function placeInWorld(element,x,y,node){const bounds=shell.getBoundingClientRect(),s=viewport.scale;style(element,'left',`${(x-bounds.left-viewport.x)/s-(node?.x||0)}px`);style(element,'top',`${(y-bounds.top-viewport.y)/s-(node?.y||0)}px`);}
  function syncOverlayScale(){const value=String(1/viewport.scale);variable(editor,'--sv2-overlay-inverse',value);if(activeMenu)variable(activeMenu,'--sv2-overlay-inverse',value);}
  const overlayObserver=new ResizeObserver(()=>requestOverlayLayout());overlayObserver.observe(editor);
  function requestOverlayLayout(){if(!overlayRaf)overlayRaf=requestAnimationFrame(()=>{overlayRaf=0;layoutOverlays();});}
  function menuPosition(anchor,safe,width,height,avoid=null){
    const center=(anchor.left+anchor.right-width)/2,map=minimapRect();
    const positions=[[center,anchor.top-height-12],[anchor.right+12,Math.max(anchor.top,safe.top)],[anchor.left-width-12,Math.max(anchor.top,safe.top)],[center,anchor.bottom+12]];
    positions.push([safe.left,safe.top],[safe.right-width,safe.top],[safe.left,safe.bottom-height],[safe.right-width,safe.bottom-height]);
    if(map)positions.push([map.left-width-12,anchor.top],[center,map.top-height-12]);
    if(avoid)positions.push([avoid.left,avoid.bottom+12],[avoid.left,avoid.top-height-12],[avoid.right+12,avoid.top],[avoid.left-width-12,avoid.top]);
    return positions.map(([x,y],index)=>{const left=clamp(x,safe.left,safe.right-width),top=clamp(y,safe.top,safe.bottom-height),rect={left,top,right:left+width,bottom:top+height};return {...rect,cost:(intersect(rect,anchor)+intersect(rect,avoid)+intersect(rect,map))*1e6+Math.abs(left-x)+Math.abs(top-y)+index};}).sort((a,b)=>a.cost-b.cost)[0];
  }
  function updateMenu(node,anchor,safe){
    const next=selectedNodeIds().length===1?world.querySelector(`.image-node[data-id="${CSS.escape(node.id)}"]>.smart-node-floating-menu`):null;
    if(next!==activeMenu){if(activeMenu){overlayObserver.unobserve(activeMenu);activeMenu.classList.remove('sv2-screen-menu');for(const property of ['left','top','maxWidth'])activeMenu.style[property]='';}activeMenu=next;if(next){next.classList.add('sv2-screen-menu');overlayObserver.observe(next);}}
    if(!activeMenu)return null;variable(activeMenu,'--sv2-overlay-inverse',String(1/viewport.scale));
    style(activeMenu,'maxWidth',`${Math.max(120,safe.right-safe.left)}px`);
    const width=activeMenu.offsetWidth,height=activeMenu.offsetHeight;
    let reserved=null;
    if(fitDock?.nodeId===node.id&&editor.classList.contains('open'))reserved=fitEditorPosition(safe,editor.offsetWidth,editor.offsetHeight);
    const placed=menuPosition(anchor,safe,width,height,reserved);
    placeInWorld(activeMenu,placed.left,placed.top,node);return placed;
  }
  function sizeEditor(safe){
    const width=Math.min(540,Math.max(280,safe.right-safe.left));style(editor,'width',`${width}px`);
    const gap=parseFloat(getComputedStyle(editorCard).rowGap)||0,padding=parseFloat(getComputedStyle(editorCard).paddingTop)+parseFloat(getComputedStyle(editorCard).paddingBottom);
    const rows=['.composer-head','#inputThumbsRow','#inputPromptPreview','.composer-actions'].map(selector=>editorCard.querySelector(selector));
    const fixed=padding+gap*5+rows.reduce((sum,row)=>sum+(row?.offsetHeight||0),0);
    const menuReserve=activeMenu?(activeMenu.offsetHeight+12):0;
    const available=Math.max(140,safe.bottom-safe.top-fixed-menuReserve),params=document.getElementById('dynamicParams'),natural=params.scrollHeight;
    const promptBudget=Math.max(60,Math.min(Number(settings.promptH)||124,available-Math.min(natural,140)));
    variable(editor,'--sv2-prompt-max-h',`${promptBudget}px`);variable(editor,'--sv2-params-max-h',`${Math.max(60,available-promptBudget)}px`);
    return {width,height:editor.offsetHeight};
  }
  function placePopup(popup,anchor,preferAbove=false){
    const safe=safeArea(),base=editor.getBoundingClientRect(),effective=base.width/editor.offsetWidth||1;
    style(popup,'maxWidth',`${Math.max(120,safe.right-safe.left)/effective}px`);style(popup,'maxHeight',`${Math.max(80,safe.bottom-safe.top)/effective}px`);
    const width=popup.offsetWidth*effective,height=popup.offsetHeight*effective;
    const above=anchor.top-height-6,below=anchor.bottom+6;
    const top=preferAbove?(above>=safe.top?above:below):(below+height<=safe.bottom?below:above);
    const x=clamp(anchor.left,safe.left,safe.right-width),y=avoidMinimap(x,clamp(top,safe.top,safe.bottom-height),width,height,safe);
    style(popup,'left',`${(x-base.left)/effective}px`);style(popup,'top',`${(y-base.top)/effective}px`);
  }
  function layoutPopups(){
    if(!editor.classList.contains('open'))return;
    editor.querySelectorAll('.smart-control:hover,.smart-control:focus-within,.smart-control.pinned,.smart-control.interacting').forEach(control=>{const popup=control.querySelector('.smart-popover');if(popup)placePopup(popup,control.getBoundingClientRect(),true);});
    if(mentionPicker.classList.contains('open'))positionMentionPickerAtCaret();
  }
  positionMentionPickerAtCaret=function(){
    if(!editor.classList.contains('open'))return;
    let anchor=mentionAnchorEl?.getBoundingClientRect();
    if(!anchor){const selection=getSelection();if(selection?.rangeCount&&promptInput.contains(selection.anchorNode)){const range=selection.getRangeAt(0);anchor=range.getClientRects()[0]||range.getBoundingClientRect();}if(!anchor?.height)anchor=promptInput.getBoundingClientRect();}
    placePopup(mentionPicker,anchor);
  };
  function layoutOverlays(){
    syncOverlayScale();const node=selectedNode();if(!node){if(activeMenu){overlayObserver.unobserve(activeMenu);activeMenu.classList.remove('sv2-screen-menu');activeMenu=null;}return;}
    const safe=safeArea(),anchor=projectRect(node),menu=updateMenu(node,anchor,safe);
    if(!editor.classList.contains('open'))return;
    if(fitDock&&fitDock.nodeId!==node.id)fitDock=null;
    if(ownerNode!==node){ownerNode=node;ownerOrdinal=nodes.indexOf(node)+1;}
    const label=node.title||`${({'smart-image':'图片节点','smart-loop':'循环','smart-group':'分组'}[node.type]||'节点')} ${ownerOrdinal}`,ownerLabel=owner.querySelector('span');
    if(ownerLabel.textContent!==label)ownerLabel.textContent=label;if(owner.dataset.nodeId!==node.id)owner.dataset.nodeId=node.id;
    const ownerTitle=`正在编辑：${label}`;if(owner.title!==ownerTitle)owner.title=ownerTitle;
    const {width,height}=sizeEditor(safe),center=(anchor.left+anchor.right-width)/2;
    const candidates=[[center,anchor.bottom+14],[anchor.right+14,anchor.top],[anchor.left-width-14,anchor.top],[center,anchor.top-height-14]];
    if(menu)candidates.push([menu.left,menu.bottom+12],[menu.right+12,menu.top],[menu.left-width-12,menu.top]);
    if(fitDock?.nodeId===node.id){const dock=fitEditorPosition(safe,width,height);candidates.unshift([dock.left,dock.top]);}
    const map=minimapRect();if(map)candidates.push([map.left-width-12,anchor.top],[center,map.top-height-12]);
    const ranked=candidates.map(([x,y],index)=>{const left=clamp(x,safe.left,safe.right-width),top=clamp(y,safe.top,safe.bottom-height),rect={left,top,right:left+width,bottom:top+height};return {...rect,cost:Math.abs(left-x)+Math.abs(top-y)+intersect(rect,anchor)*2+(intersect(rect,anchor)>0?1e10:0)+(menu&&intersect(rect,menu)>0?1e9:0)+(intersect(rect,map)>0?1e12:0)+index};}).sort((a,b)=>a.cost-b.cost);
    const chosen=ranked[0];
    if(menu&&intersect(chosen,menu)>0){
      const moved=menuPosition(anchor,safe,menu.right-menu.left,menu.bottom-menu.top,chosen);
      placeInWorld(activeMenu,moved.left,moved.top,node);
    }
    placeInWorld(editor,chosen.left,chosen.top);const docked=String(anchor.right<safe.left||anchor.left>safe.right||anchor.bottom<safe.top||anchor.top>safe.bottom);if(editor.dataset.docked!==docked)editor.dataset.docked=docked;layoutPopups();
  }
  positionComposerForNode=function(node){if(fitDock&&(fitDock.nodeId!==node?.id||dragState))fitDock=null;requestOverlayLayout();};
  new MutationObserver(requestOverlayLayout).observe(editor,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  editor.addEventListener('pointerover',requestOverlayLayout);editor.addEventListener('focusin',requestOverlayLayout);editor.addEventListener('scroll',requestOverlayLayout,true);
  window.addEventListener('resize',()=>{fitDock=null;requestOverlayLayout();});
  const assetPanel=document.getElementById('assetPanel');if(assetPanel){new MutationObserver(requestOverlayLayout).observe(assetPanel,{attributes:true,attributeFilter:['class']});assetPanel.addEventListener('transitionend',requestOverlayLayout);}
  function fit(target){if(!nodes.length){fitAllNodesViewport();return;}const collection=target?.id?[target]:nodes.filter(n=>!n.groupId),rects=collection.map(nodeRect);if(!rects.length)return;
    const left=Math.min(...rects.map(r=>r.x)),top=Math.min(...rects.map(r=>r.y)),right=Math.max(...rects.map(r=>r.x+r.width)),end=Math.max(...rects.map(r=>r.y+r.height));
    const safe=safeArea(),active=selectedNode();let available={...safe};fitDock=null;
    if(active&&editor.classList.contains('open')){const size=sizeEditor(safe);if(safe.right-safe.left-size.width-24>=260){available.right-=size.width+24;fitDock={nodeId:active.id,x:available.right+24,y:safe.top+(safe.bottom-safe.top-size.height)/2};}else if(safe.bottom-safe.top-size.height-24>=120){available.bottom-=size.height+24;fitDock={nodeId:active.id,x:safe.left+(safe.right-safe.left-size.width)/2,y:available.bottom+24};}}
    const scale=Math.max(.06,Math.min(1,(available.right-available.left-40)/Math.max(1,right-left),(available.bottom-available.top-40)/Math.max(1,end-top))),bounds=shell.getBoundingClientRect();
    viewport.scale=scale;viewport.x=(available.left+available.right)/2-bounds.left-(left+right)/2*scale;viewport.y=(available.top+available.bottom)/2-bounds.top-(top+end)/2*scale;fittingView=true;try{applyViewport();}finally{fittingView=false;}scheduleSave();requestOverlayLayout();
  }
  function sync(){empty.hidden=nodes.length>0;zoom.querySelector('span').textContent=Math.round(viewport.scale*100)+'%';if(search.open)renderSearch();window.StudioCanvasWorkspace?.sync();}
  const nativeRender=render;render=function(...args){checkHistory();mapStructure=true;const result=nativeRender.apply(this,args);if(!historyChanging&&redoStack.length)checkHistory();sync();requestOverlayLayout();return result;};
  const nativeViewport=applyViewport;applyViewport=function(...args){if(!fittingView)fitDock=null;const result=nativeViewport.apply(this,args);syncOverlayScale();sync();requestOverlayLayout();return result;};
  window.addEventListener('studio-save-pending',e=>{if(e.detail?.canvasId!==canvas?.id)return;status.dataset.state='saving';status.textContent='修改待保存';});
  window.addEventListener('studio-save-state',e=>{if(e.detail?.canvasId!==canvas?.id)return;const data=e.detail,pending=data.pending||data.code==='busy';status.dataset.state=pending?'saving':data.ok?'saved':'error';status.textContent=pending?'最新修改保存中':data.ok?'已保存':'保存失败，请重试';});
  window.StudioSmartV2={fit,sync,setMode,get mode(){return workspaceMode;},get minimapMetrics(){return {frames:mapFrames,rectReads:mapRectReads,cachedNodes:mapEntries.size};}};sync();syncOverlayScale();requestOverlayLayout();refreshIcons();
})();
