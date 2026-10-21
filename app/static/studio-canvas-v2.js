/* Reviewed Studio V2 presentation and spatial controls on the existing classic engine.
   Existing model, media, save and generation handlers remain the owners of their data. */
(() => {
  'use strict';
  if(!document.getElementById('board') || document.querySelector('.smart-back'))return;
  const root=document.documentElement;
  const style=(href)=>{const el=document.createElement('link');el.rel='stylesheet';el.href=href;document.head.append(el);};
  style('/static/studio-v2-theme.css');style('/static/studio-canvas-v2.css');
  root.classList.add('studio-v2','studio-v2-canvas');
  // Native input-list rendering calls this once for each generator. Lucide's
  // default document scan replaces even already-rendered SVGs, so one edited
  // prompt used to recreate every canvas icon dozens of times. Keep the same
  // synchronous initializer, but give it only new placeholders or renamed SVGs.
  // Leave attributes and DOM listeners on unchanged icons intact.
  let iconBatchDepth=0,iconRefreshPending=false;
  refreshIcons=function(){
    if(iconBatchDepth){iconRefreshPending=true;return;}
    if(!window.lucide)return;
    const pending={querySelectorAll(selector){
      return Array.from(document.querySelectorAll(selector)).filter(item=>{
        const name=item.getAttribute(selector==='[icon-name]'?'icon-name':'data-lucide');
        return item.localName!=='svg'||!item.classList.contains('lucide-'+name);
      });
    }};
    lucide.createIcons({root:pending});
  };
  const refreshInputViews=refreshGeneratorInputViews;
  refreshGeneratorInputViews=function(...args){
    iconBatchDepth++;
    try{return refreshInputViews.apply(this,args);}finally{
      iconBatchDepth--;
      if(!iconBatchDepth&&iconRefreshPending){iconRefreshPending=false;refreshIcons();}
    }
  };
  // These values paint only the board background. Inheriting a changed value into
  // thousands of card descendants forces a full style recalculation on every pan.
  if(window.CSS?.registerProperty){for(const [name,initialValue]of [['--v2-grid-step','24px'],['--v2-grid-x','0px'],['--v2-grid-y','0px']]){
    try{CSS.registerProperty({name,syntax:'<length>',inherits:false,initialValue});}catch(error){if(error.name!=='InvalidModificationError')console.warn('[studio-v2] Grid property registration unavailable');}
  }}
  const icon=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const el=(tag,className,text)=>{const item=document.createElement(tag);if(className)item.className=className;if(text)item.textContent=text;return item;};
  const stop=element=>{for(const name of ['pointerdown','mousedown','dblclick','wheel'])element.addEventListener(name,e=>e.stopPropagation());return element;};
  const button=(label,name,action)=>{const b=el('button','v2-icon-button');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.innerHTML=icon(name);b.onclick=action;return b;};
  const editable=target=>Boolean(target?.closest?.('input,textarea,select,[contenteditable="true"],dialog,[role="dialog"],[popover]:popover-open'));
  const escapeCloses=d=>d.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing){e.preventDefault();e.stopPropagation();d.close();}},true);
  const activeDialog=()=>document.querySelector('dialog[open],.modal.open,#outputLightbox.open,#imageEditModal.open,[popover]:popover-open');
  let mode='select',space=false,knifeHeld=false,animation=0,animationOrigin=null;
  // Viewport feel measured from LibTV's canvas (React Flow): zoom 10%–800%,
  // two-finger scroll / wheel pans, Ctrl or ⌘ + wheel and pinch zoom.
  const ZOOM_MIN=.1,ZOOM_MAX=8,clampZoom=value=>Math.max(ZOOM_MIN,Math.min(ZOOM_MAX,value));
  const WHEEL_KEY='studio.canvas.wheel';
  let wheelMode='pan';try{wheelMode=localStorage.getItem(WHEEL_KEY)==='zoom'?'zoom':'pan';}catch{}
  let wheelButton=null;
  const reduced=()=>matchMedia('(prefers-reduced-motion:reduce)').matches;
  const title=node=>node.studioTitle||node.title||node.name||({generator:'图片生成',video:'视频生成',audio:'音频生成',llm:'文本生成',prompt:'文本',image:'素材',output:'生成结果',group:'分组',rh:'RunningHub',comfy:'ComfyUI'}[node.type]||node.type);
  let status,zoomLabel,selectButton,handButton,selectionActions,selectionCount,empty;
  function update(){
    if(!canvas)return;
    if(zoomLabel)zoomLabel.textContent=Math.round(viewport.scale*100)+'%';
    if(empty)empty.hidden=nodes.length>0;
    if(selectionActions){selectionActions.hidden=selected.size===0;selectionCount.textContent=`${selected.size} 项已选`;
      selectionActions.querySelector('[data-ungroup]').disabled=![...selected].some(id=>nodes.find(n=>n.id===id)?.studioSpatialGroup);
    }
    selectButton?.setAttribute('aria-pressed',String(mode==='select'));handButton?.setAttribute('aria-pressed',String(mode==='hand'));
    board.classList.toggle('v2-hand',mode==='hand'||space);
    board.style.setProperty('--v2-grid-step',(24*viewport.scale)+'px');
    board.style.setProperty('--v2-grid-x',viewport.x+'px');board.style.setProperty('--v2-grid-y',viewport.y+'px');
    window.StudioCanvasWorkspace?.sync();
  }
  const nativeViewport=applyViewport;
  applyViewport=function(...args){const result=nativeViewport.apply(this,args);update();return result;};
  const nativeRender=render;
  render=function(...args){const result=nativeRender.apply(this,args);update();return result;};
  const nativeSelection=refreshSelectionVisuals;
  refreshSelectionVisuals=function(...args){const result=nativeSelection.apply(this,args);update();return result;};
  // World transforms do not change card geometry. Measure changed cards together,
  // then project one cached world layer instead of reading every card on each pan.
  const mapEntries=new Map(),mapDirty=new Set();let mapOrigin=null,mapStructure=true,mapBounds=null,mapBoundsDirty=true,mapLayer=null,mapEmpty=null;
  let mapMeasurements=0,mapFrames=0;
  const queueMap=()=>{if(canvas)scheduleMinimapRender();};
  const mapViewSize={w:innerWidth,h:innerHeight},mapContentSize={w:172,h:110};
  const mapContainers=new ResizeObserver(records=>{
    for(const record of records){
      const style=getComputedStyle(record.target),px=name=>parseFloat(style[name])||0;
      const box=Array.isArray(record.borderBoxSize)?record.borderBoxSize[0]:record.borderBoxSize;
      if(record.target===board){
        mapViewSize.w=box?.inlineSize??record.contentRect.width+px('paddingLeft')+px('paddingRight')+px('borderLeftWidth')+px('borderRightWidth');
        mapViewSize.h=box?.blockSize??record.contentRect.height+px('paddingTop')+px('paddingBottom')+px('borderTopWidth')+px('borderBottomWidth');
      }else{
        mapContentSize.w=Math.round(record.contentRect.width+px('paddingLeft')+px('paddingRight'));
        mapContentSize.h=Math.round(record.contentRect.height+px('paddingTop')+px('paddingBottom'));
      }
    }
    queueMap();
  });
  for(const container of [board,minimapContent])if(container){try{mapContainers.observe(container,{box:'border-box'});}catch{mapContainers.observe(container);}}
  const cardFor=target=>target?.nodeType===1?target.closest('.node[data-id]'):target?.parentElement?.closest('.node[data-id]');
  const mapResize=new ResizeObserver(records=>{
    for(const record of records){
      const entry=mapEntries.get(record.target.dataset.id);if(entry?.card!==record.target)continue;
      const box=Array.isArray(record.borderBoxSize)?record.borderBoxSize[0]:record.borderBoxSize;
      // ResizeObserver has already performed layout. Consume its border box instead
      // of forcing layout again from the next animation-frame map renderer.
      let w=box?.inlineSize,h=box?.blockSize;
      if(!Number.isFinite(w)||!Number.isFinite(h)){
        const style=getComputedStyle(record.target),px=name=>parseFloat(style[name])||0;
        w=record.contentRect.width+px('paddingLeft')+px('paddingRight')+px('borderLeftWidth')+px('borderRightWidth');
        h=record.contentRect.height+px('paddingTop')+px('paddingBottom')+px('borderTopWidth')+px('borderBottomWidth');
      }
      entry.measuredWidth=Math.round(w);entry.measuredHeight=Math.round(h);mapMeasurements++;mapDirty.add(entry.node.id);
    }
    if(mapStructure||mapDirty.size)queueMap();
  });
  const mapMutations=new MutationObserver(records=>{
    for(const record of records){
      if(record.type==='childList'&&record.target===nodesEl){mapStructure=true;continue;}
      // Content changes are measured by ResizeObserver. Position and selection
      // changes need only node coordinates and classes, never a DOM size read.
      if(record.type==='attributes'){
        const card=cardFor(record.target);if(card===record.target&&nodesEl.contains(card))mapDirty.add(card.dataset.id);
      }
    }
    if(mapStructure||mapDirty.size)queueMap();
  });
  mapMutations.observe(nodesEl,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class']});
  function resetMap(){
    mapResize.disconnect();mapEntries.clear();mapDirty.clear();mapBounds=null;mapBoundsDirty=true;mapStructure=true;mapOrigin=canvas;
    mapLayer=el('div','v2-minimap-world');Object.assign(mapLayer.style,{position:'absolute',left:'0',top:'0',width:'1px',height:'1px',transformOrigin:'0 0',pointerEvents:'none'});
    minimapViewport=el('div','minimap-viewport');minimapViewport.id='minimapViewport';mapEmpty=el('div','minimap-empty','EMPTY');
    minimapContent.replaceChildren(mapLayer,mapEmpty,minimapViewport);
  }
  function syncMapStructure(){
    const cards=new Map([...nodesEl.querySelectorAll('.node[data-id]')].map(card=>[card.dataset.id,card])),live=new Set();
    for(const node of nodes){
      live.add(node.id);const card=cards.get(node.id),prior=mapEntries.get(node.id);
      if(prior&&prior.node===node&&prior.card===card)continue;
      if(prior?.card)mapResize.unobserve(prior.card);
      const dot=prior?.dot||el('div','minimap-node');dot.dataset.nodeId=node.id;
      Object.assign(dot.style,{boxSizing:'border-box',borderWidth:'var(--map-pixel)',borderRadius:'calc(3 * var(--map-pixel))'});
      if(!dot.isConnected)mapLayer.append(dot);
      mapEntries.set(node.id,{node,card,dot});mapDirty.add(node.id);
      if(card){try{mapResize.observe(card,{box:'border-box'});}catch{mapResize.observe(card);}}
    }
    for(const [id,entry]of mapEntries){if(live.has(id))continue;if(entry.card)mapResize.unobserve(entry.card);entry.dot.remove();mapEntries.delete(id);mapDirty.delete(id);mapBoundsDirty=true;}
    mapStructure=false;mapEmpty.hidden=mapEntries.size>0;
  }
  function measureMapChanges(){
    // Sizes come from the layout observer; dragging and selecting read only data.
    const measured=[];
    for(const id of mapDirty){const entry=mapEntries.get(id);if(!entry)continue;const size=defaultNodeSize(entry.node.type);
      measured.push({entry,x:Number(entry.node.x)||0,y:Number(entry.node.y)||0,w:entry.measuredWidth??entry.node.w??size.w??260,h:entry.measuredHeight??entry.node.h??size.h??160});
    }
    mapDirty.clear();
    for(const {entry,x,y,w,h}of measured){
      if(entry.x!==x||entry.y!==y||entry.w!==w||entry.h!==h){Object.assign(entry,{x,y,w,h});mapBoundsDirty=true;
        Object.assign(entry.dot.style,{left:x+'px',top:y+'px',width:`max(${w}px, var(--map-min-size))`,height:`max(${h}px, var(--map-min-size))`});
      }
      entry.dot.classList.toggle('selected',selected.has(entry.node.id));
    }
    if(mapBoundsDirty){
      let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
      for(const entry of mapEntries.values()){if(entry.w===undefined)continue;x=Math.min(x,entry.x);y=Math.min(y,entry.y);right=Math.max(right,entry.x+entry.w);bottom=Math.max(bottom,entry.y+entry.h);}
      mapBounds=Number.isFinite(x)?{x,y,right,bottom}:null;mapBoundsDirty=false;
    }
  }
  renderMinimap=function(){
    if(!minimapContent||!canvas)return;mapFrames++;if(mapOrigin!==canvas||!mapLayer?.isConnected)resetMap();
    if(mapStructure)syncMapStructure();if(mapDirty.size||mapBoundsDirty)measureMapChanges();
    canvasArrangeBtn?.classList.toggle('visible',selected.size>0);
    const view={x:-viewport.x/viewport.scale,y:-viewport.y/viewport.scale,w:mapViewSize.w/viewport.scale,h:mapViewSize.h/viewport.scale},x=Math.min(mapBounds?.x??view.x,view.x),y=Math.min(mapBounds?.y??view.y,view.y),right=Math.max(mapBounds?.right??view.x+view.w,view.x+view.w),bottom=Math.max(mapBounds?.bottom??view.y+view.h,view.y+view.h);
    const pad=Math.max(240,Math.max(right-x,bottom-y)*.08),bounds={x:x-pad,y:y-pad,w:Math.max(1,right-x+pad*2),h:Math.max(1,bottom-y+pad*2)};
    const cw=mapContentSize.w||172,ch=mapContentSize.h||110,scale=Math.min(cw/bounds.w,ch/bounds.h),ox=(cw-bounds.w*scale)/2,oy=(ch-bounds.h*scale)/2;
    minimapState={bounds,scale,ox,oy,cw,ch};mapLayer.style.transform=`translate(${ox-bounds.x*scale}px,${oy-bounds.y*scale}px) scale(${scale})`;
    mapLayer.style.setProperty('--map-pixel',1/scale+'px');mapLayer.style.setProperty('--map-min-size',3/scale+'px');
    Object.assign(minimapViewport.style,{left:ox+(view.x-bounds.x)*scale+'px',top:oy+(view.y-bounds.y)*scale+'px',width:Math.max(8,view.w*scale)+'px',height:Math.max(8,view.h*scale)+'px'});
  };
  function cancelAnimation(){
    const saveInterrupted=Boolean(animation)&&animationOrigin===canvas;
    cancelAnimationFrame(animation);animation=0;animationOrigin=null;
    if(saveInterrupted)scheduleViewportSave();
  }
  function moveView(next){
    cancelAnimation();const origin=canvas,start={...viewport},began=performance.now();
    const apply=t=>{viewport.x=start.x+(next.x-start.x)*t;viewport.y=start.y+(next.y-start.y)*t;viewport.scale=start.scale+(next.scale-start.scale)*t;applyViewport();renderSelectionHub();};
    if(reduced()){apply(1);scheduleViewportSave();return;}
    const frame=now=>{if(canvas!==origin){animation=0;animationOrigin=null;return;}const t=Math.min(1,(now-began)/220);apply(1-Math.pow(1-t,3));if(t<1)animation=requestAnimationFrame(frame);else{animation=0;animationOrigin=null;scheduleViewportSave();}};
    animationOrigin=origin;
    animation=requestAnimationFrame(frame);
  }
  function zoom(factor){if(!canvas)return;const r=board.getBoundingClientRect(),point=screenToWorld(r.left+r.width/2,r.top+r.height/2),scale=clampZoom(viewport.scale*factor);moveView({scale,x:r.width/2-point.x*scale,y:r.height/2-point.y*scale});}
  function focus(ids,fit=true){
    const list=nodes.filter(n=>ids.includes(n.id));if(!list.length)return;
    const box=nodeBounds(list.map(n=>n.id)),r=board.getBoundingClientRect();
    const map=document.getElementById('minimap'),mapTop=map&&!map.hidden?map.getBoundingClientRect().top-r.top:r.height-70;
    const top=105,bottom=Math.max(top+100,Math.min(r.height-85,mapTop-18)),height=bottom-top;
    const inspector=document.getElementById('workspaceInspector'),right=inspector&&!inspector.hidden&&innerWidth>900?Math.min(r.width,inspector.getBoundingClientRect().left-r.left-16):r.width;
    const scale=fit?Math.max(ZOOM_MIN,Math.min(1,(right-160)/(box.w+100),height/(box.h+60))):viewport.scale;
    moveView({scale,x:right/2+40-(box.x+box.w/2)*scale,y:top+height/2-(box.y+box.h/2)*scale});
  }
  const nativeNode=renderNode;
  renderNode=function(node){
    // Retain explicit widths. Older presentation layers force all new cards to
    // 640px; give newly created cards a compact natural width without migration.
    const originalWidth=node.w;
    const card=nativeNode.apply(this,arguments);card.classList.add('v2-node');
    if(['generator','video','audio'].includes(node.type)){
      const width=Number(originalWidth)||440;node.w=Math.max(360,width);card.style.width=node.w+'px';
      const modules=card.querySelector('.studio-creative-modules'),prompt=card.querySelector('.studio-node-prompt'),footer=card.querySelector('.studio-image-footer');
      if(modules&&prompt){modules.classList.add('v2-prompt-modules');prompt.before(modules);}
      const add=modules?.querySelector('.studio-creative-add');if(add&&footer){add.classList.add('v2-module-actions');footer.before(add);}
    }
    card.querySelector('.node-title')?.setAttribute('title',title(node));
    if(node.studioSpatialGroup){
      card.classList.add('v2-spatial-group');card.querySelector('.node-title').textContent=title(node);
      card.querySelector('.node-head').onmousedown=e=>{if(e.button===0&&!isNodeControl(e.target)){e.stopPropagation();if(e.detail<2)startNodeDrag(e,node);}};
      card.querySelector('.node-head').ondblclick=e=>{e.preventDefault();e.stopPropagation();rename(node);};
    }
    return card;
  };
  function rename(node){
    const origin=canvas,d=el('dialog','v2-small-dialog'),heading=el('h2','', '分组名称'),input=el('input');input.value=title(node);input.maxLength=80;input.setAttribute('aria-label','分组名称');
    const actions=el('footer'),cancel=el('button','','取消'),save=el('button','v2-primary','保存');cancel.onclick=()=>d.close();
    const commit=()=>{if(canvas!==origin||!nodes.includes(node)){d.close();return;}if(!input.value.trim())return;pushUndo();node.studioTitle=input.value.trim();render();scheduleSave();d.close();};save.onclick=commit;input.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();commit();}};
    actions.append(cancel,save);d.append(heading,input,actions);d.setAttribute('aria-label','修改分组名称');escapeCloses(d);d.onclose=()=>d.remove();document.body.append(d);d.showModal();input.select();
  }
  function group(){
    const members=nodes.filter(n=>selected.has(n.id)&&!n.studioSpatialGroup);if(members.length<2){setStatus('请至少选择两个节点再分组');return;}
    if(nodes.some(n=>n.studioSpatialGroup&&n.items?.some(id=>members.some(m=>m.id===id)))){setStatus('请先解组，再重新分组');return;}
    pushUndo();const bounds=nodeBounds(members.map(n=>n.id));
    const group={id:uid('grp'),type:'group',studioSpatialGroup:true,studioTitle:'创作分组',x:bounds.x-24,y:bounds.y-60,w:bounds.w+48,h:bounds.h+86,items:members.map(n=>n.id)};
    nodes.push(group);selected.clear();selected.add(group.id);render();scheduleSave();
  }
  function ungroup(){
    const groups=nodes.filter(n=>selected.has(n.id)&&n.studioSpatialGroup);if(!groups.length)return;
    pushUndo();const ids=new Set(groups.map(n=>n.id));nodes=nodes.filter(n=>!ids.has(n.id));connections=connections.filter(c=>!ids.has(c.from)&&!ids.has(c.to));selected.clear();groups.flatMap(n=>n.items||[]).forEach(id=>{if(nodes.some(n=>n.id===id))selected.add(id);});render();scheduleSave();
  }
  // A selected spatial frame copies all of its members, with native ID remapping.
  const nativeCopy=copySelectedNodes;
  copySelectedNodes=function(...args){
    const prior=[...selected],seen=new Set(prior);
    const include=id=>{const node=nodes.find(n=>n.id===id);if(!node||!['group','promptGroup'].includes(node.type))return;for(const child of node.items||[]){if(seen.has(child))continue;seen.add(child);include(child);}};
    prior.forEach(include);selected.clear();seen.forEach(id=>selected.add(id));
    try{return nativeCopy.apply(this,args);}finally{selected.clear();prior.forEach(id=>selected.add(id));}
  };
  function duplicate(){
    if(!selected.size)return;document.activeElement?.blur?.();const prior={...lastMouseBoard};copySelectedNodes();
    const copies=Array.isArray(clipboard)?clipboard:clipboard?.nodes;if(!copies?.length)return;
    // Native paste anchors the centers of node origins, not their rendered bounds.
    const xs=copies.map(n=>n.x),ys=copies.map(n=>n.y);
    lastMouseBoard={x:(Math.min(...xs)+Math.max(...xs))/2+40,y:(Math.min(...ys)+Math.max(...ys))/2+40};
    try{pasteNodes();}finally{lastMouseBoard=prior;}
  }
  const nativePushUndo=pushUndo,nativeUndo=performUndo;let historyCanvas=null,redoStates=[],redoBaseline='';
  window.addEventListener('studio-draft-restored',event=>{if(event.detail?.canvasId===canvas?.id){historyCanvas=canvas;redoStates=[];redoBaseline='';}});
  const snapshot=()=>studioHistorySnapshot();
  // Task receipts also invalidate an old redo branch even though the shared
  // editing snapshot deliberately leaves live execution under its current owner.
  const historySignature=()=>JSON.stringify({nodes:serializableCanvasNodes(),connections});
  function historyTarget(){if(historyCanvas!==canvas){historyCanvas=canvas;redoStates=[];redoBaseline='';undoStack.length=0;}}
  pushUndo=function(...args){historyTarget();redoStates=[];redoBaseline='';return nativePushUndo.apply(this,args);};
  performUndo=function(...args){
    historyTarget();if(redoStates.length&&historySignature()!==redoBaseline)redoStates=[];
    const current=canvas&&undoStack.length?snapshot():null;
    const result=nativeUndo.apply(this,args);
    if(result!==false&&current){redoStates.push(current);if(redoStates.length>UNDO_MAX)redoStates.shift();}
    redoBaseline=historySignature();return result;
  };
  function redo(){
    historyTarget();if(!canvas||!redoStates.length)return;
    // Model/text edits and async receipts can arrive without pushUndo. They create
    // a new history branch and must never be overwritten by an older redo state.
    if(historySignature()!==redoBaseline){redoStates=[];redoBaseline='';setStatus('内容已更新，已保留当前编辑');return;}
    const current=snapshot(),saved=redoStates.at(-1),result=studioRestoreHistorySnapshot(saved);
    if(!result.ok){setStatus(result.reason||'当前任务仍在运行，暂时无法重做');return;}
    redoStates.pop();undoStack.push(current);if(undoStack.length>UNDO_MAX)undoStack.shift();selected.clear();render();scheduleSave();redoBaseline=historySignature();
  }

  function setWheelMode(value){
    wheelMode=value==='zoom'?'zoom':'pan';try{localStorage.setItem(WHEEL_KEY,wheelMode);}catch{}
    if(wheelButton){wheelButton.setAttribute('aria-pressed',String(wheelMode==='zoom'));wheelButton.title=wheelMode==='pan'?'滚轮：平移画布（Ctrl/⌘ + 滚轮缩放）· 点击改为滚轮缩放':'滚轮：缩放画布 · 点击改为滚轮平移';wheelButton.setAttribute('aria-label',wheelButton.title);}
  }
  function connectSelected(){
    // LibTV Ctrl/⌘ + L: link two selected nodes in whichever direction the canvas allows.
    const ids=[...selected];if(ids.length!==2)return;
    const [a,b]=ids,pair=canConnect(a,b)?[a,b]:canConnect(b,a)?[b,a]:null;
    if(!pair||connections.some(c=>c.from===pair[0]&&c.to===pair[1]))return;
    pushUndo();connections.push({id:uid('c'),from:pair[0],to:pair[1]});
    syncLatestGeneratedOutputToConnection(pair[0],pair[1]);syncGeneratorInputs();scheduleSave();render();
  }
  function generateSelected(){
    // Same entry as the node's own generate button; never batches several nodes.
    if(selected.size!==1)return;const id=[...selected][0],node=nodes.find(n=>n.id===id);
    if(node&&canvasRunTypes().includes(node.type))runCanvasGenerate(id);
  }
  function addMenu(anchor){const r=anchor?.getBoundingClientRect();openCreateMenu(r?r.right+10:innerWidth/2,r?r.top:innerHeight/2);menuPoint=defaultPoint(-180,-100);}  function search(){
    if(!canvas)return;const origin=canvas,d=el('dialog','v2-search-dialog'),h=el('header'),heading=el('strong','','查找节点'),close=button('关闭查找','x',()=>d.close()),input=el('input'),list=el('div','v2-search-results');
    input.type='search';input.placeholder='搜索名称、提示词或模型';input.setAttribute('aria-label','搜索画布节点');h.append(heading,close);d.append(h,input,list);d.setAttribute('aria-label','查找画布节点');
    const draw=()=>{list.replaceChildren();const q=input.value.trim().toLowerCase(),items=nodes.filter(n=>[title(n),n.studioPrompt,n.text,n.model].join(' ').toLowerCase().includes(q));
      if(!items.length)list.append(el('p','','没有找到匹配节点'));
      for(const n of items.slice(0,100)){const b=el('button','v2-search-result'),label=el('strong','',title(n)),meta=el('small','',n.model||n.type);b.type='button';b.append(label,meta);b.onclick=()=>{if(canvas!==origin||!nodes.includes(n)){d.close();return;}selected.clear();selected.add(n.id);refreshSelectionVisuals();focus([n.id],false);d.close();const card=nodesEl.querySelector(`[data-id="${CSS.escape(n.id)}"]`);card?.classList.add('v2-located');setTimeout(()=>card?.classList.remove('v2-located'),800);};list.append(b);}
    };
    input.oninput=draw;escapeCloses(d);d.onclose=()=>d.remove();document.body.append(d);d.showModal();draw();input.focus();
  }
  function help(){
    const d=el('dialog','v2-help-dialog');d.setAttribute('aria-label','画布快捷键');const head=el('header'),title=el('strong','','更顺手地创作');head.append(title,button('关闭快捷键','x',()=>d.close()));d.append(head);
    const rows=[['空白处拖动','框选节点'],['Shift + 框选','追加选择'],['空格 / 鼠标中键 + 拖动','平移画布'],
      [wheelMode==='pan'?'滚轮 / 双指滑动':'Shift + 滚轮 / 双指横向滑动','平移画布'],[wheelMode==='pan'?'Ctrl 或 ⌘ + 滚轮 / 双指捏合':'滚轮 / Ctrl 或 ⌘ + 滚轮 / 捏合','以指针为中心缩放（10%–800%）'],
      ['Ctrl + = / Ctrl + - / Ctrl + 0','放大 / 缩小 / 适应全部'],['V / H','选择 / 移动工具'],['双击空白处 / Tab','新建节点'],['Ctrl + L','连接两个选中节点'],
      ['Ctrl + Enter','生成选中的单个节点'],['Ctrl + K / Ctrl + F','查找节点'],['F / Shift + 1','定位选中 / 适应全部'],['Ctrl + D','复制选中节点'],['Ctrl + G / Ctrl + Shift + G','创作分组 / 解组'],['Ctrl + Z / Ctrl + Shift + Z','撤销 / 重做'],['Delete / Backspace','删除选中节点'],['按住 X 拖动','断开经过的连线']];
    const list=el('dl');for(const [key,label]of rows)list.append(el('dt','',key),el('dd','',label));d.append(list,el('p','v2-help-note','输入文字时保留编辑快捷键。选择节点和连线不会提交生成。'));escapeCloses(d);d.onclose=()=>d.remove();document.body.append(d);d.showModal();
  }
  function initialize(){
    const top=document.querySelector('.topbar'),nav=document.querySelector('.canvas-nav'),rail=document.querySelector('#quickToolbar .toolbar-items'),fixed=document.querySelector('#quickToolbar .toolbar-fixed');if(!top||!nav||!rail)return;
    const brand=el('button','v2-brand');brand.type='button';brand.setAttribute('aria-label','返回项目');brand.innerHTML='<img class="v2-brand-symbol" src="/static/studio-mark.svg" alt=""><span>深白片场<small>DEEPWHITE STUDIO</small></span>';brand.onclick=()=>document.getElementById('backToManagerBtn').click();top.prepend(brand);
    status=el('span','v2-save-state','本地画布');status.id='studioV2SaveState';status.setAttribute('role','status');nav.append(status);
    const searchButton=button('查找节点 · Ctrl+K','search',search);searchButton.id='studioV2Search';fixed?.prepend(searchButton);
    const add=button('添加节点','plus',()=>addMenu(add));add.classList.add('v2-add-tool');add.id='studioV2Add';
    selectButton=button('选择工具 · V','mouse-pointer-2',()=>{mode='select';update();});selectButton.id='studioV2Select';
    handButton=button('移动工具 · H','hand',()=>{mode='hand';update();});handButton.id='studioV2Hand';
    const division=el('div','v2-rail-divider');rail.prepend(add,selectButton,handButton,division);
    rail.querySelectorAll('button').forEach(b=>{
      if(!b.getAttribute('aria-label'))b.setAttribute('aria-label',b.textContent.trim()||b.title);
      if(!b.title)b.title=b.getAttribute('aria-label');
      if(b.dataset.canvasTool==='runninghub'&&!b.querySelector('svg,i'))b.innerHTML=icon('workflow')+'<span>RH 工作流</span>';
      if(b.getAttribute('onclick')==='groupSelectedImages()'){b.onclick=group;b.title='将选中节点组成创作分组';}
    });
    const bottom=stop(el('div','v2-navigation'));
    const zoomOut=button('缩小画布','minus',()=>zoom(1/1.2)),zoomIn=button('放大画布','plus',()=>zoom(1.2));
    zoomLabel=el('button','v2-zoom-label','100%');zoomLabel.id='studioV2Zoom';zoomLabel.type='button';zoomLabel.title='还原到 100%';zoomLabel.onclick=()=>zoom(1/viewport.scale);
    const fit=button('适应全部节点 · Shift+1','maximize',()=>focus(nodes.map(n=>n.id))),map=button('显示或隐藏导航地图','map',()=>{const m=document.getElementById('minimap');m.hidden=!m.hidden;map.setAttribute('aria-pressed',String(!m.hidden));});map.setAttribute('aria-pressed','true');
    wheelButton=button('滚轮模式','mouse',()=>setWheelMode(wheelMode==='pan'?'zoom':'pan'));wheelButton.id='studioV2Wheel';setWheelMode(wheelMode);
    bottom.append(zoomOut,zoomLabel,zoomIn,el('span','v2-separator'),fit,map,wheelButton,button('快捷键帮助','keyboard',help));document.body.append(bottom);
    selectionActions=stop(el('div','v2-selection-actions'));selectionActions.id='studioV2Selection';selectionActions.hidden=true;selectionCount=el('span','v2-selection-count');
    const ungroupButton=button('解组','ungroup',ungroup);ungroupButton.dataset.ungroup='';selectionActions.append(selectionCount,button('定位选中节点','focus',()=>focus([...selected])),button('复制选中节点','copy-plus',duplicate),button('创作分组','group',group),ungroupButton);document.body.append(selectionActions);
    empty=stop(el('section','v2-board-empty'));empty.innerHTML='<span class="v2-empty-mark">✦</span><h1>让想法，在这里展开</h1><p>放入一段文字、一张图片，或从第一个生成节点开始。</p>';
    const create=el('button','v2-primary','添加第一个节点');create.type='button';create.onclick=()=>addMenu(create);empty.append(create);document.body.append(empty);
    window.addEventListener('studio-save-state',e=>{if(e.detail.canvasId!==canvas?.id)return;status.textContent=e.detail.ok?'已保存':'保存未完成';status.classList.toggle('failed',!e.detail.ok);status.title=e.detail.ok?'已保存到当前项目':e.detail.error||'请重试保存';});
    // Let delayed engine/account controls retain their existing mount targets.
    refreshIcons();if(canvas)render();update();
    window.StudioCanvasV2=Object.freeze({search,help,focus,group,ungroup,duplicate,ready:true,get minimapMetrics(){return Object.freeze({frames:mapFrames,measurements:mapMeasurements,cachedNodes:mapEntries.size});}});
  }
  // Adapt the old Shift-based cutter to X; Shift is now reserved for selection.
  const nativeKnifeMode=setKnifeMode;
  setKnifeMode=function(active){
    // Native hover calls this for every mousemove. An already inactive cutter
    // must not rebuild all SVG links and their delete controls on every event.
    if(!active&&!knifeActive&&!knifePoint&&!knifeTrail.length&&!knifeChanged&&!knifeNeedsRender&&!document.body.classList.contains('canvas-knife'))return;
    return nativeKnifeMode(active);
  };
  const nativeKnifeStart=startKnifeDrag,nativeKnifeMove=continueKnifeDrag;
  const knifeEvent=e=>({button:e.button,altKey:e.altKey,target:e.target,clientX:e.clientX,clientY:e.clientY,shiftKey:true,
    preventDefault:()=>e.preventDefault(),stopPropagation:()=>e.stopPropagation(),stopImmediatePropagation:()=>e.stopImmediatePropagation()});
  startKnifeDrag=e=>knifeHeld&&!activeDialog()&&!editable(e.target)?nativeKnifeStart(knifeEvent(e)):false;
  continueKnifeDrag=e=>{if(!knifeHeld){if(knifeActive)endDrag(e);return;}return nativeKnifeMove(knifeEvent(e));};
  board.addEventListener('mousemove',e=>{
    if(!knifeHeld||!canvas||activeDialog()||editable(e.target)||dragNode||dragBoard||resizeNode||tempLink)return;
    lastMouseBoard=screenToWorld(e.clientX,e.clientY);setKnifeMode(true);if(knifeActive)continueKnifeDrag(e);
    e.stopImmediatePropagation();
  },true);
  let additive=null;
  finishSelection=function(){
    const keep=additive;additive=null;if(!selectDrag)return;
    const rect=selectionBox.getBoundingClientRect();selectionBox.style.display='none';selected.clear();
    nodesEl.querySelectorAll('.node').forEach(card=>{const r=card.getBoundingClientRect();if(r.left<rect.right&&r.right>rect.left&&r.top<rect.bottom&&r.bottom>rect.top)selected.add(card.dataset.id);});
    if(keep){const live=new Set(nodes.map(node=>node.id));for(const id of keep)if(live.has(id))selected.add(id);}
    selectDrag=null;document.body.classList.remove('canvas-selecting');window.onmousemove=null;window.onmouseup=null;
    // Selection changes classes, links and controls; preserve editor/media DOM and
    // in-flight task bindings instead of rebuilding every card after a marquee.
    refreshSelectionVisuals();
  };
  board.addEventListener('mousedown',e=>{
    if(!canvas||activeDialog()||e.button!==0||editable(e.target))return;
    if(knifeHeld&&startKnifeDrag(e)){cancelAnimation();return;}
    const blank=[board,world,nodesEl,linksEl].includes(e.target);
    if((space||mode==='hand')&&!e.target.closest('button,.port,.resize-handle,.minimap')){cancelAnimation();e.stopImmediatePropagation();startBoardPan(e);return;}
    if(blank&&!knifeActive){cancelAnimation();e.stopImmediatePropagation();closeCreateMenu();additive=e.shiftKey?new Set(selected):null;startSelection(e);}
  },true);
  board.addEventListener('wheel',cancelAnimation,{capture:true,passive:true});
  // Stop a programmatic view animation before native controls capture coordinates.
  // Inputs retain their focus/selection and every native pointer handler still runs.
  for(const type of ['pointerdown','mousedown'])window.addEventListener(type,e=>{
    if(board.contains(e.target)||document.getElementById('minimap')?.contains(e.target))cancelAnimation();
  },true);
  const scrollableControl=target=>{
    if(editable(target)||target?.closest?.('audio,video'))return true;
    for(let element=target?.nodeType===1?target:target?.parentElement;element&&element!==board;element=element.parentElement){
      const style=getComputedStyle(element);
      if(/auto|scroll/.test(style.overflowY)&&element.scrollHeight>element.clientHeight+1
        ||/auto|scroll/.test(style.overflowX)&&element.scrollWidth>element.clientWidth+1)return true;
    }
    return false;
  };
  board.onwheel=e=>{
    if(!canvas||activeDialog()||scrollableControl(e.target))return;
    // WheelEvent does not reliably identify the physical input device. The
    // default follows LibTV (scroll pans, Ctrl/⌘ or pinch zooms); mouse users
    // can switch back to wheel zoom from the navigation bar.
    const unit=e.deltaMode===1?16:e.deltaMode===2?Math.max(1,board.clientHeight):1;
    const dx=e.deltaX*unit,dy=e.deltaY*unit;
    if(!Number.isFinite(dx)||!Number.isFinite(dy)||(!dx&&!dy))return;
    e.preventDefault();cancelAnimation();
    if(!e.ctrlKey&&!e.metaKey&&(e.shiftKey||dx||wheelMode==='pan')){
      if(e.shiftKey&&!dx){viewport.x-=dy;}else{viewport.x-=dx;viewport.y-=dy;}
    }else{
      if(!dy)return;
      const point=screenToWorld(e.clientX,e.clientY),rect=board.getBoundingClientRect();
      const factor=Math.exp(Math.max(-4,Math.min(4,-dy*.002)));
      viewport.scale=clampZoom(viewport.scale*factor);
      viewport.x=e.clientX-rect.left-point.x*viewport.scale;viewport.y=e.clientY-rect.top-point.y*viewport.scale;
    }
    applyViewport();renderSelectionHub();scheduleViewportSave();
  };

  window.addEventListener('keydown',e=>{
    if(!canvas||e.isComposing)return;const typing=editable(e.target)||activeDialog(),key=e.key.toLowerCase();
    if(typing){if((e.ctrlKey||e.metaKey)&&key==='g')e.stopImmediatePropagation();return;}
    // Space/Enter belong to a focused control; only the canvas surface pans.
    if(['Enter',' '].includes(e.key)&&e.target.closest?.('button,summary,a[href],[role="button"],[role="link"],audio,video'))return;
    if(e.code==='Space'){e.preventDefault();e.stopImmediatePropagation();space=true;update();return;}
    // Shift adds to selection; the old wire-cutting gesture is retained on X.
    if(e.key==='Shift'&&!e.altKey){e.stopImmediatePropagation();setKnifeMode(false);return;}
    if(key==='x'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();e.stopImmediatePropagation();knifeHeld=true;setKnifeMode(true);return;}
    let action=null;
    if(e.ctrlKey||e.metaKey){if(key==='k'||key==='f')action=search;else if(key==='d')action=duplicate;
      else if(key==='0')action=()=>focus(nodes.map(n=>n.id));else if(key==='='||key==='+')action=()=>zoom(1.2);else if(key==='-')action=()=>zoom(1/1.2);
      else if(key==='l')action=connectSelected;else if(key==='enter')action=generateSelected;else if(key==='g')action=e.shiftKey?ungroup:group;else if(key==='z'&&e.shiftKey)action=redo;else if(key==='y')action=redo;}
    else if(!e.altKey){if(key==='v')action=()=>{mode='select';update();};else if(key==='h')action=()=>{mode='hand';update();};else if(key==='f')action=()=>focus([...selected]);else if(e.shiftKey&&e.code==='Digit1')action=()=>focus(nodes.map(n=>n.id));else if(key==='?')action=help;else if(e.key==='Tab'&&!e.shiftKey&&(document.activeElement===document.body||board.contains(document.activeElement)))action=()=>addMenu(null);}
    if(action){e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)action();}
  },true);
  window.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;update();}if(e.key.toLowerCase()==='x'){knifeHeld=false;if(knifeActive)endDrag(e);setKnifeMode(false);}},true);
  window.addEventListener('blur',()=>{space=false;knifeHeld=false;additive=null;if(knifeActive)endDrag();setKnifeMode(false);cancelAnimation();update();});
  window.addEventListener('resize',()=>{cancelAnimation();update();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})();
