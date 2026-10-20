/* Media-first nodes use the existing editor controls and task owners. */
(() => {
  'use strict';
  if (window.StudioNodeComposer) return;
  const css=document.createElement('link'); css.rel='stylesheet'; css.href='/static/studio-node-composer.css'; document.head.append(css);
  document.documentElement.classList.add('studio-node-composers');
  // Text now edits in the node itself. Match the former inspector's one undo
  // snapshot per edit session without recording focus-only visits.
  const textSessions=new WeakSet();
  document.addEventListener('input',event=>{
    const input=event.target;
    if(!input.matches?.('.prompt-editor textarea,.prompt-node-text'))return;
    const node=nodes.find(item=>item.id===input.closest('[data-id]')?.dataset.id);
    if(!node||input.value===node.text||textSessions.has(input))return;
    pushUndo();textSessions.add(input);
  },true);
  document.addEventListener('blur',event=>textSessions.delete(event.target),true);
  const element=(tag,cls,text)=>{const item=document.createElement(tag);if(cls)item.className=cls;if(text)item.textContent=text;return item;};
  const isolate=item=>{for(const type of ['pointerdown','mousedown','dblclick','wheel','keydown'])item.addEventListener(type,event=>event.stopPropagation());return item;};
  function previewDialog(output) {
    const dialog=element('dialog','studio-media-preview-dialog');dialog.setAttribute('aria-label','生成结果预览');
    const close=element('button','','关闭预览');close.type='button';close.onclick=()=>dialog.close();
    const media=element(output.kind==='video'?'video':output.kind==='audio'?'audio':'img');
    media.src=output.url;if(media.tagName==='IMG')media.alt='生成结果';else {media.controls=true;media.preload='metadata';}
    const download=element('a','','下载原文件');download.href=output.url;download.download=output.name||'';
    const footer=element('footer');footer.append(download,close);dialog.append(media,footer);
    dialog.onclose=()=>{media.pause?.();dialog.remove();};document.body.append(dialog);dialog.showModal();close.focus();
  }
  function smartHistory() {
    const panel=document.querySelector('#smartLogModal .log-panel'),list=document.getElementById('smartLogList');
    if(!panel||!list)return;
    panel.classList.add('studio-smart-history');
    const title=panel.querySelector('.log-title');title.textContent='生成记录';title.removeAttribute('data-i18n');
    const filters=element('div','studio-smart-history-filters');
    filters.innerHTML='<input type="search" aria-label="搜索生成记录" placeholder="搜索提示词或模型"><select aria-label="筛选生成状态"><option value="">全部状态</option><option value="success">已完成</option><option value="failed">生成失败</option></select><select aria-label="筛选生成类型"><option value="">全部类型</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option><option value="chat">文本</option></select><select aria-label="筛选生成时间"><option value="0">全部时间</option><option value="1">最近 24 小时</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option></select>';
    list.before(filters);
    const apply=()=>{
      const q=filters.querySelector('input').value.trim().toLowerCase(),[status,kind,period]=[...filters.querySelectorAll('select')].map(item=>item.value);let count=0;
      for(const item of list.querySelectorAll('.log-item')){item.hidden=Boolean(q&&!item.dataset.search.includes(q)||status&&item.dataset.status!==status||kind&&item.dataset.kind!==kind||Number(period)&&Number(item.dataset.created)<Date.now()-Number(period)*86400000);if(!item.hidden)count++;}
      title.textContent='生成记录 · '+count+' 条';
    };
    filters.addEventListener('input',apply);filters.addEventListener('change',apply);
    const native=renderSmartCanvasLog;
    renderSmartCanvasLog=function(...args){
      const result=native.apply(this,args);
      [...list.querySelectorAll('.log-item')].forEach((card,index)=>{
        const log=canvas.logs[index],outputs=(log.outputs||[]).map(smartLogOutputItem).filter(item=>item?.url);
        card.dataset.search=[log.model,log.prompt,log.request?.task_id].join(' ').toLowerCase();card.dataset.status=log.status;card.dataset.created=log.createdAt||0;card.dataset.kind=outputs[0]?.kind||(outputs[0]?.url&&outputUrlLooksVideo(outputs[0].url)?'video':'image');
        const thumbs=card.querySelector('.log-thumbs');card.prepend(thumbs);
        if(!outputs.length)thumbs.append(element('span','studio-smart-history-empty',log.status==='failed'?'本次生成未产生结果':'文本 / 任务记录'));
        for(const thumb of thumbs.querySelectorAll('[data-url]'))thumb.onclick=event=>{event.stopPropagation();previewDialog({url:thumb.dataset.url,kind:thumb.dataset.kind||'image'});};
        const actions=element('div','studio-smart-history-actions');
        if(log.prompt){const reuse=element('button','','复用提示词');reuse.type='button';reuse.onclick=()=>{const point=screenToWorld({clientX:innerWidth/2,clientY:innerHeight/2});const node=createPromptNode(point.x,point.y);node.text=log.prompt;node.title='历史提示词';render();scheduleSave();closeSmartCanvasLog();};actions.append(reuse);}
        if(outputs[0]){const output=outputs[0],download=element('a','','下载');download.href=output.url;download.download=output.name||'';actions.append(download);
          const use=element('button','','放入画布');use.type='button';use.onclick=()=>{const point=screenToWorld({clientX:innerWidth/2,clientY:innerHeight/2});createNode(point.x,point.y,[output]);closeSmartCanvasLog();};actions.append(use);}
        const details=element('details'),summary=element('summary','','参数与任务详情'),pre=element('pre','',JSON.stringify(log.request||{},null,2));details.append(summary,pre);
        card.append(details,actions);
      });
      apply();return result;
    };
  }
  if (document.documentElement.classList.contains('studio-v2-smart')) {
    // The smart engine already keeps media and its active composer linked. Match
    // hierarchy while retaining its input/contenteditable and provider contracts.
    const prompt=document.getElementById('promptInput');
    if(prompt)prompt.setAttribute('aria-label','节点提示词');
    const setSetting=setDynamicSetting;
    setDynamicSetting=function(key,value){
      if(activeSettingsSubject()&&String(settings[key]??'')!==String(value??''))pushUndo();
      return setSetting.apply(this,arguments);
    };
    smartHistory();window.StudioNodeComposer=Object.freeze({ready:true,preview:previewDialog});return;
  }
  const draw=renderNode;
  renderNode=node=>{
    const eligible=['generator','video'].includes(node.type);
    if(eligible)node.w=Math.max(Number(node.w)||0,600);
    const card=draw(node);
    if(!eligible)return card;
    const body=card.querySelector('.node-body'), composer=body?.querySelector('.generator-body,.video-body')||body?.firstElementChild;
    if(!body||!composer)return card;
    card.classList.add('studio-media-composer-node');composer.classList.add('studio-node-composer');
    const stage=element('section','studio-node-media');stage.setAttribute('aria-label',node.type==='video'?'视频预览':'图片预览');
    const outputs=[...(node.generatedOutputs||[]),...outputNodesForSource(node.id).flatMap(output=>output.images||[])].map(item=>{
      const url=typeof item==='string'?item:item.url||item.src;return {...(typeof item==='object'?item:{}),url,kind:(typeof item==='object'&&item.kind)||(node.type==='video'?'video':'image')};
    }).filter(item=>item.url);
    const seen=new Set(), unique=outputs.filter(item=>!seen.has(item.url)&&(seen.add(item.url),true));
    const last=unique.at(-1);
    if(last) {
      const media=element(last.kind==='video'?'video':'img');media.src=last.url;
      if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';isolate(media);}else{media.alt='最近生成结果';media.loading='lazy';}
      stage.append(media);
      const open=element('button','studio-preview-open','查看结果'+(unique.length>1?' · '+unique.length+' 项':''));
      open.type='button';open.setAttribute('aria-label','放大预览生成结果');isolate(open);open.onclick=()=>previewDialog(last);stage.append(open);
    } else {
      const icon=element('span','studio-media-placeholder-icon');icon.setAttribute('aria-hidden','true');
      icon.innerHTML=node.type==='video'?'<svg viewBox="0 0 64 64"><rect x="8" y="12" width="48" height="40" rx="7"/><path d="m27 23 15 9-15 9z"/></svg>':'<svg viewBox="0 0 64 64"><rect x="8" y="10" width="48" height="44" rx="7"/><circle cx="23" cy="24" r="4"/><path d="m9 46 16-15 10 10 9-8 12 13"/></svg>';
      stage.append(icon,element('strong','',node.type==='video'?'视频创作':'图片创作'),element('p','','在下方描述想法，或连接参考素材'));
      const reference=element('button','studio-preview-reference','＋ 关联参考素材');reference.type='button';isolate(reference);
      reference.onclick=()=>{const action=card.querySelector('[data-add-ref],.studio-input-icon');if(action)action.click();else card.querySelector('.studio-prompt-input')?.focus();};stage.append(reference);
    }
    if(node.running||['queued','running','paused','failed','uncertain'].includes(node.studioJobState)){
      const state=node.studioJobState||'running';
      const label={queued:'排队中',running:'生成中',paused:'等待继续查询',failed:'生成未完成',uncertain:'提交结果待核实'}[state]||state;
      const badge=element('span','studio-media-task-badge',label);badge.dataset.state=state;badge.setAttribute('role','status');stage.append(badge);
    }
    body.prepend(stage);
    const promptWrap=card.querySelector('.studio-node-prompt'), refs=card.querySelector('.studio-reference-strip');
    // Move controls, never clone: native changes continue to target the same node.
    if(promptWrap&&refs)promptWrap.prepend(refs);
    const prompt=card.querySelector('.studio-prompt-input');
    if(prompt){prompt.rows=3;prompt.placeholder=node.type==='video'?'描述画面、动作和镜头运动；连接图片可作为参考…':'描述画面，或连接参考图片后输入修改要求…';}
    const run=card.querySelector('.gen-btn');
    if(run){run.setAttribute('aria-label',node.type==='video'?'生成视频':'生成图片');run.title=node.type==='video'?'生成视频':'生成图片';}
    return card;
  };
  window.StudioNodeComposer=Object.freeze({ready:true,preview:previewDialog});
  if(typeof canvas!=='undefined'&&canvas)render();
})();
