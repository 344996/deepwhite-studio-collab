(() => {
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-node-polish.css?v=3';document.head.append(css);
  const draw=renderNode;
  renderNode=node=>{
    const root=draw(node);
    root.querySelectorAll('.studio-image-footer .gen-cascade-btn').forEach(button=>{
      const label=button.textContent.trim();button.title=label+'（运行整条工作流）';button.setAttribute('aria-label',label);
      const icon=document.createElement('span');icon.className='studio-cascade-icon';icon.textContent='▷';icon.setAttribute('aria-hidden','true');button.prepend(icon);
    });
    for(const port of root.querySelectorAll(':scope > .port')){
      port.classList.add('studio-magnetic-port');port.setAttribute('aria-label',port.classList.contains('in')?'连接输入':'连接输出');
      port.addEventListener('mousemove',e=>{
        if(tempLink)return;
        const r=port.getBoundingClientRect(),scale=r.width/44,dx=e.clientX-r.left-r.width/2,dy=e.clientY-r.top-r.height/2;
        const active=Math.hypot(dx,dy)<=42*scale;
        port.style.setProperty('--port-x',(active?dx/scale:0)+'px');port.style.setProperty('--port-y',(active?dy/scale:0)+'px');
      });
      port.addEventListener('mouseleave',()=>{port.style.setProperty('--port-x','0px');port.style.setProperty('--port-y','0px');});
    }
    if(!['generator','video','midjourney'].includes(node.type))return root;
    const basic=root.querySelector('.studio-basics'),list=basic?.querySelector('.studio-ref-list')||root.querySelector('.input-list,.mj-input-list');
    if(!list)return root;
    const popup=document.createElement('div');popup.className='studio-input-popover';popup.setAttribute('popover','auto');popup.setAttribute('aria-label','输入素材');
    popup.innerHTML='<header><strong>输入素材</strong><button type="button" aria-label="关闭输入素材">×</button></header>';popup.querySelector('button').onclick=()=>popup.hidePopover();
    const button=document.createElement('button');button.type='button';button.className='studio-input-icon';button.setAttribute('aria-label','查看输入素材');button.title='查看输入素材';button.setAttribute('aria-expanded','false');
    button.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 6-6 4 4 3-3 4 5"/></svg><span></span>';
    if(basic){const head=basic.querySelector('.studio-ref-head');if(head)popup.append(head);const hint=basic.querySelector(':scope > small');if(hint)popup.append(hint);}
    else {const label=list.previousElementSibling;if(label&&!label.matches('textarea,label,.studio-node-prompt,.prompt-list'))label.hidden=true;}
    const strip=document.createElement('div');strip.className='studio-reference-strip';list.before(strip);strip.append(button);popup.append(list);root.append(popup);
    root.studioRefreshReferences=()=>{
      strip.querySelectorAll('.studio-reference-thumb').forEach(e=>e.remove());
      const seen=new Set(),excluded=node.studioExcludedRefs||[];
      const refs=generatorSources(node).flatMap(s=>s.refs||[]).filter(r=>r.url&&!excluded.includes(r.url)&&!seen.has(r.url)&&(seen.add(r.url),true));
      popup.querySelector('.studio-linked-previews')?.remove();
      const previews=document.createElement('div');previews.className='studio-linked-previews';
      refs.forEach((r,i)=>{
        const item=document.createElement('button');item.type='button';item.className='studio-reference-thumb';item.title=r.name||'参考素材 '+(i+1);
        if((r.kind||'image')==='image'){const img=document.createElement('img');img.src=r.url;img.alt='参考图 '+(i+1);item.append(img);}else item.textContent=r.kind==='video'?'视频':'音频';
        const label=document.createElement('span');label.textContent='参考'+(i+1);item.append(label);
        item.onmousedown=e=>e.stopPropagation();item.onclick=e=>{e.stopPropagation();button.click();};strip.insertBefore(item,button);
        if(!Array.from(list.querySelectorAll('img')).some(img=>img.getAttribute('src')===r.url)){const preview=item.cloneNode(true);preview.title=r.name||'参考素材 '+(i+1);previews.append(preview);}
      });
      if(previews.childElementCount)popup.append(previews);
      button.querySelector('span').textContent=refs.length||'';
    };
    root.studioRefreshReferences();
    const count=()=>{root.studioRefreshReferences();};count();new MutationObserver(count).observe(list,{childList:true,subtree:true});
    for(const event of ['pointerdown','mousedown','dblclick','keydown','wheel']){popup.addEventListener(event,e=>e.stopPropagation());button.addEventListener(event,e=>e.stopPropagation());}
    button.onclick=()=>{if(popup.matches(':popover-open'))return popup.hidePopover();popup.showPopover();const r=button.getBoundingClientRect();popup.style.left=Math.max(8,Math.min(r.left,innerWidth-popup.offsetWidth-8))+'px';popup.style.top=Math.max(8,Math.min(r.bottom+8,innerHeight-popup.offsetHeight-8))+'px';};
    popup.addEventListener('toggle',()=>button.setAttribute('aria-expanded',String(popup.matches(':popover-open'))));
    popup.addEventListener('keydown',e=>{if(e.key==='Escape'){popup.hidePopover();button.focus();}});
    return root;
  };
  const refreshInputs=refreshGeneratorInputViews;
  refreshGeneratorInputViews=function(...args){const result=refreshInputs.apply(this,args);document.querySelectorAll('#nodes .node').forEach(el=>el.studioRefreshReferences?.());return result;};
})();
