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
    // Over another modal the close event (which removes a preview) can lag ~200ms; a quick reopen
    // must not leave the old one in the page.
    document.querySelectorAll('.studio-media-preview-dialog:not([open])').forEach(old=>old.remove());
    const dialog=element('dialog','studio-media-preview-dialog');dialog.setAttribute('aria-label','生成结果预览');
    const close=element('button','','关闭预览');close.type='button';close.onclick=()=>dialog.close();
    const media=element(output.kind==='video'?'video':output.kind==='audio'?'audio':'img');
    media.src=output.url;if(media.tagName==='IMG')media.alt='生成结果';else {media.controls=true;media.preload='metadata';}
    const download=element('a','','下载原文件');download.href=output.url;download.download=output.name||'';
    const footer=element('footer');footer.append(download,close);dialog.append(media,footer);
    dialog.onclose=()=>{media.pause?.();dialog.remove();};document.body.append(dialog);dialog.showModal();close.focus();
  }
  function smartHistory() {
    const modal=document.getElementById('smartLogModal'),panel=modal?.querySelector('.log-panel'),list=document.getElementById('smartLogList');
    if(!panel||!list)return;
    panel.classList.add('studio-smart-history');
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','生成记录');
    panel.querySelector('.log-head')?.remove();
    window.StudioHistoryView.mount(panel,list,{close:()=>closeSmartCanvasLog()});
    const labels={succeeded:'已完成',failed:'生成失败',running:'生成中',queued:'排队中',paused:'等待查询',uncertain:'结果待核实',modal:'等待选区确认'};
    renderSmartCanvasLog=function(){
      window.StudioHistoryView.clear(panel);
      for(const log of [...(canvas?.logs||[])].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))){
        const outputs=(log.outputs||[]).map(smartLogOutputItem).filter(item=>item?.url).map(item=>({...item,kind:item.kind||(outputUrlLooksVideo(item.url)?'video':'image')}));
        const status=log.status==='success'?'succeeded':log.status||'succeeded';
        const kind=log.kind||log.request?.kind||outputs[0]?.kind||(log.text?'chat':'image');
        const card=element('article','log-item');card.dataset.jobId=log.id||'';
        card.append(element('strong','',log.model||'未记录模型'),element('p','',log.prompt||''));
        const details=element('details'),summary=element('summary','','参数和任务编号'),pre=element('pre','',JSON.stringify({模型:log.model,参数:log.request||{},耗时毫秒:log.runMs,平台:log.platform},null,2));details.append(summary,pre);card.append(details);
        if(log.error){const error=element('p','studio-history-error',window.StudioHistoryView.readableError(log.error));error.title=log.error;card.append(error);}
        card.append(element('p','studio-history-bill','实际费用待对账 · 平台未返回金额'));
        for(const output of outputs){
          const row=element('div','studio-history-output'),media=element(output.kind==='video'?'video':output.kind==='audio'?'audio':'img');
          window.StudioHistoryView.prepareMedia(media,media.tagName==='IMG'?smartMediaPreviewUrl(output,768):displayMediaUrl(output),displayMediaUrl(output));if(media.tagName!=='IMG')media.controls=true;
          const download=element('a','','下载');download.href=output.url;download.download=output.name||'';
          const use=element('button','','放入画布');use.type='button';use.onclick=()=>{const point=screenToWorld({clientX:innerWidth/2,clientY:innerHeight/2});createNode(point.x,point.y,[output]);closeSmartCanvasLog();};
          row.append(media,download,use);card.append(row);
        }
        const text=typeof log.text==='string'?log.text:'';
        if(text){card.append(element('pre','',text));const copy=element('button','','复制文本');copy.type='button';copy.onclick=()=>copyTextToClipboard(text);card.append(copy);}
        if(log.prompt){const reuse=element('button','','复用提示词');reuse.type='button';reuse.onclick=()=>{const point=screenToWorld({clientX:innerWidth/2,clientY:innerHeight/2});const node=createPromptNode(point.x,point.y);node.text=log.prompt;node.title='历史提示词';render();scheduleSave();closeSmartCanvasLog();};card.append(reuse);}
        window.StudioHistoryView.decorate(card,{name:log.model||'未记录模型',kind:kind==='text'?'chat':kind,status,stateLabel:labels[status]||status,createdAt:(log.createdAt||0)/1000,prompt:log.prompt||'',taskIds:[log.request?.task_id||log.request?.taskId||log.request?.prompt_id||log.request?.promptId||''],outputs,text},panel);
        list.append(card);
      }
      window.StudioHistoryView.empty(panel);
    };
    let opener=null;
    new MutationObserver(()=>{
      if(modal.classList.contains('open')){opener=document.activeElement;panel.querySelector('[data-history-search]').focus();}
      else {window.StudioHistoryView.pauseMedia(panel);if(opener?.isConnected)opener.focus();opener=null;}
    }).observe(modal,{attributes:true,attributeFilter:['class']});
    panel.addEventListener('keydown',event=>{
      event.stopPropagation();
      if(event.key==='Escape'){event.preventDefault();closeSmartCanvasLog();}
      if(event.key==='Tab'){
        const items=[...panel.querySelectorAll('button:not(:disabled),input,select,a[href],summary')].filter(item=>item.getClientRects().length);
        if(!items.length)return;
        if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1).focus();}
        else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}
      }
    });
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
  // UI-NEW-01: in-node editing wants 600px, but widening a node saved narrower must not slide it
  // under its right-hand neighbour, where clicks would land on the wrong card.
  const height=n=>nodesEl?.querySelector(`[data-id="${CSS.escape(String(n.id))}"]`)?.offsetHeight||Number(n.h)||320;
  function roomyWidth(node,wanted){
    const current=Number(node.w)||0;if(current>=wanted)return current;
    const top=Number(node.y)||0,bottom=top+height(node);let room=wanted;
    for(const other of nodes){
      if(other===node||!(Number(other.x)>Number(node.x)))continue;
      const otherTop=Number(other.y)||0;if(otherTop>=bottom||otherTop+height(other)<=top)continue;
      room=Math.min(room,Number(other.x)-Number(node.x)-24);
    }
    return Math.max(current,room);
  }
  renderNode=node=>{
    const eligible=['generator','video'].includes(node.type);
    if(eligible)node.w=roomyWidth(node,600);
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
