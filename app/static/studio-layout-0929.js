/* 0929 reviewed canvas layout, using native nodes, storage, settings and task history. */
(() => {
  'use strict';
  const nativeRenderNode=renderNode;
  renderNode=function(node){
    if(node.type==='audio')node.w=Math.max(Number(node.w)||0,480);
    const root=nativeRenderNode.apply(this,arguments);
    if(['generator','video','audio','llm'].includes(node.type)){
      root.classList.add('studio-0929-node');
      root.style.height='auto';
      root.classList.remove('sized');
      window.StudioContentLibrary?.renderCards(node,root.querySelector('.node-body')||root);
    }
    return root;
  };
  function initialize(){
    document.documentElement.classList.add('studio-layout-0929');
    const grid=document.getElementById('studioGridLayoutTools'),actions=document.querySelector('.studio-canvas-actions');
    if(!grid)return;
    // Keep the settings iframe and shared grid controls mounted with their original listeners.
    const corner=document.createElement('div');corner.id='studioCanvasCorner0929';corner.className='studio-canvas-corner-0929';document.body.append(corner);
    const settings=document.getElementById('studioSettingsButton');
    if(settings){settings.textContent='设置';settings.title='账号、API 与基础设置';corner.append(settings);}
    const gridSettings=document.getElementById('studioGridSettingsToggle');
    if(gridSettings){gridSettings.textContent='画布设置';corner.append(gridSettings);}
    const popover=document.getElementById('studioGridSettingsPopover');if(popover)corner.append(popover);
    const engineSettings=document.querySelector('.studio-engine-toolbar [data-settings]');
    if(engineSettings&&window.StudioCanvasSettings?.container){engineSettings.textContent='ComfyUI 设置';window.StudioCanvasSettings.container.append(engineSettings);}
    // The original outside-click handler is attached to grid. Keep controls inside it.
    corner.append(grid);if(settings)grid.append(settings);if(gridSettings)grid.append(gridSettings);if(popover)grid.append(popover);
    const arrange=document.createElement('div');arrange.className='studio-arrange-menu-0929';
    const toggle=document.createElement('button');toggle.type='button';toggle.id='studioArrangeToggle0929';toggle.textContent='整理';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls','studioArrangeOptions0929');
    const options=document.createElement('div');options.id='studioArrangeOptions0929';options.hidden=true;
    for(const [id,label] of [['studioGridArrangeSelected','整理选中'],['studioGridArrangeAll','整理全部']]){const button=document.getElementById(id);if(button){button.textContent=label;options.append(button);}}
    toggle.onclick=e=>{e.stopPropagation();options.hidden=!options.hidden;toggle.setAttribute('aria-expanded',String(!options.hidden));window.StudioGridLayout?.refresh();};
    options.addEventListener('click',e=>{if(e.target.closest('button')){options.hidden=true;toggle.setAttribute('aria-expanded','false');}},true);
    arrange.append(toggle,options);grid.prepend(arrange);
    document.addEventListener('click',e=>{if(!arrange.contains(e.target)){options.hidden=true;toggle.setAttribute('aria-expanded','false');}});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){options.hidden=true;toggle.setAttribute('aria-expanded','false');}});
    for(const event of ['pointerdown','mousedown','dblclick','wheel'])corner.addEventListener(event,e=>e.stopPropagation());
    const history=document.querySelector('.studio-history-button');
    if(history){history.textContent='任务记录';history.setAttribute('aria-label','任务记录');document.querySelector('#quickToolbar .toolbar-fixed')?.prepend(history);}
    if(actions)actions.classList.add('studio-0929-legacy-actions');
    // Existing workflow/media nodes remain mounted; only retired navigation entries are hidden.
    document.querySelectorAll('#canvasAssetToggle,#workflowTransferToggle,[data-open-workflows],#canvasLogToggle,[aria-label="项目资产"]').forEach(el=>{el.hidden=true;el.setAttribute('aria-hidden','true');});
    if(typeof canvas!=='undefined'&&canvas)render();
    window.StudioCanvas0929={refresh:()=>window.StudioGridLayout?.refresh()};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})();
