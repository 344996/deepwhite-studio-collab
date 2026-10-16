/* Stage two: image processing presets and local video frame capture. */
(() => {
  if(document.querySelector('.smart-back'))return;
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-media-tools.css?v=2';document.head.append(css);
  const stop=el=>{for(const type of ['pointerdown','mousedown','click','dblclick','keydown','wheel'])el.addEventListener(type,e=>e.stopPropagation());return el;};
  const dialog=stop(document.createElement('dialog'));dialog.className='studio-media-tools';document.body.append(dialog);
  let cleanup=()=>{},epoch=0;
  dialog.addEventListener('close',()=>{epoch++;cleanup();cleanup=()=>{};});
  function open(title){
    if(dialog.open)dialog.close();epoch++;
    dialog.replaceChildren();const head=document.createElement('header'),name=document.createElement('strong'),close=document.createElement('button');name.textContent=title;close.textContent='×';close.setAttribute('aria-label','关闭素材处理');close.onclick=()=>dialog.close();head.append(name,close);
    const body=document.createElement('div');body.className='studio-media-tool-body';dialog.append(head,body);dialog.showModal();return body;
  }
  function message(body,text){const p=document.createElement('p');p.textContent=text;body.append(p);return p;}
  async function json(url,body){const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();if(!r.ok)throw Error(data.detail||'请求失败');return data;}
  function placement(node){const rect=estimatedNodeRect(node);return {x:rect.x+rect.w+70,y:rect.y};}
  async function character(node,ref){
    const body=open('标准人设图'),token=epoch;
    const preview=document.createElement('img');preview.className='studio-character-reference';preview.src=canvasDisplayMediaUrl(ref.url);preview.alt='人物参考图';body.append(preview);
    message(body,'生成一张 4:3 灰底（#8C8C8C）三宫格设定图：45° 头颈特写、头部留空的正面全身、包含头部的完整背面全身。保留原图，结果保存到新的处理分支。');
    const example=document.createElement('figure');example.innerHTML='<img src="/static/examples/standard-character.png" alt="标准人设图效果案例" style="display:block;max-height:240px;max-width:100%;margin:auto;border-radius:8px"><figcaption style="text-align:center;font-size:12px">效果案例 · 仅作构图参考，不作为生成素材</figcaption>';body.append(example);
    const status=message(body,'正在读取可用模型…');status.setAttribute('role','status');
    try{
      const [catalog,caps,response]=await Promise.all([json('/api/studio/model-catalog'),json('/api/studio/capabilities'),fetch('/static/prompts/standard-character.txt')]);
      if(!response.ok)throw Error('人设图提示词读取失败');const prompt=await response.text();if(token!==epoch)return;
      const choices=[];
      for(const [pid,saved] of Object.entries(catalog.providers||{})){
        const provider=apiProviders.find(p=>p.id===pid);if(!provider||provider.enabled===false||!provider.has_key)continue;
        try{if(new URL(provider.base_url).hostname!=='api.deepwhiteai.com')continue;}catch{continue;}
        for(const m of saved.models||[]){
          const s=caps.providers?.[pid]?.[m.id];
          if(m.kind!=='image'||m.enabled===false||m.removed||m.available===false||!s?.supported||s.max_images<1||!s.fields.ratio?.values.includes('4:3'))continue;
          // Explicitly supported G/GPT image families, never substitute another vendor.

          choices.push({pid,model:m.id,name:provider.name+' · '+m.name,spec:s});
        }
      }
      if(!choices.length){status.textContent='没有已启用且支持参考图与 4:3 比例的图片模型，请到设置 / API 启用。';return;}
      const select=document.createElement('select');select.setAttribute('aria-label','人设图模型');choices.forEach((m,i)=>select.add(new Option(m.name+(/deepwhiteai-image-g|gpt/i.test(m.model)?'（推荐）':''),String(i))));
      const preferred=choices.findIndex(c=>c.model==='deepwhiteai-image-g-v2.5-sunburst');
      if(preferred>=0)select.value=String(preferred);else{select.insertBefore(new Option('高品质版未启用，请手动选择其他型号',''),select.firstChild);select.value='';}
      body.append(select);

      const quote=message(body,'正在估算费用…'),create=document.createElement('button');create.className='studio-media-primary';create.textContent='生成标准人设图';body.append(create);status.textContent=preferred>=0?'输出：1 张 · 4:3 · 1K':'默认高品质版未启用，请到 API 设置启用，或手动选择其他型号。';
      let quoteSerial=0;
      const params=choice=>Object.fromEntries(Object.entries(choice.spec.fields).map(([key,value])=>[key,key==='ratio'?'4:3':value.default]));
      async function estimate(){const serial=++quoteSerial;create.disabled=select.value==='';if(create.disabled){quote.textContent='请选择型号后查看估价。';return;}const c=choices[Number(select.value)];quote.textContent='正在估算费用…';try{const q=await json('/api/studio/quote',{provider_id:c.pid,model:c.model,kind:'image',count:1,image_count:1,params:params(c)});if(token===epoch&&serial===quoteSerial)quote.textContent=q.label+'；'+(q.note||'最终以账单为准');}catch{if(token===epoch&&serial===quoteSerial)quote.textContent='估价暂不可用，最终费用以实际账单为准。';}}
      select.onchange=estimate;estimate();
      create.onclick=()=>{
        if(select.value==='')return;
        if(!nodes.includes(node)){status.textContent='原素材节点已移除，请重新选择。';return;}
        create.disabled=true;const c=choices[Number(select.value)];pushUndo();const n=addGeneratorNode(placement(node));
        n.apiProvider=c.pid;n.model=c.model;n.count=1;n.studioTitle='标准人设图';n.studioPrompt=prompt;n.studioParams=params(c);n.studioParamsModel=c.model;
        // Pin this one image, rather than passing every image in an output collection.
        n.studioRefs=[{url:ref.url,name:ref.name||'人物参考图',kind:'image'}];n.studioProcessing={type:'standard-character',sourceNode:node.id,sourceUrl:ref.url};
        render();scheduleSave();dialog.close();Promise.resolve(runGenerator(n.id)).catch(e=>setStatus(e.message||'人设图生成失败'));
      };
    }catch(e){if(token===epoch)status.textContent=e.message;}
  }
  function keyframes(node,ref){
    const body=open('截取关键帧'),token=epoch;
    message(body,'播放或拖动进度条定位画面，点击「添加当前时间点」。最多选择 20 帧，保存为一个图片结果节点；不消耗 API 额度。');
    const video=document.createElement('video');video.controls=true;video.preload='auto';video.crossOrigin='anonymous';video.setAttribute('aria-label','关键帧视频预览');body.append(video);
    const status=message(body,'正在加载视频…');status.setAttribute('role','status');
    const time=document.createElement('input');time.type='number';time.min='0';time.step='0.001';time.value='0';time.setAttribute('aria-label','定位时间（秒）');
    const locate=document.createElement('button');locate.textContent='定位到此时间';
    const add=document.createElement('button');add.textContent='添加当前时间点';add.disabled=true;
    const row=document.createElement('div');row.className='studio-media-row';row.append(time,locate,add);body.append(row);
    const list=document.createElement('div');list.className='studio-frame-times';body.append(list);
    const save=document.createElement('button');save.textContent='保存关键帧到画布';save.className='studio-media-primary';save.disabled=true;body.append(save);
    let times=[],busy=false;
    cleanup=()=>{video.pause();video.removeAttribute('src');video.load();};
    const valid=t=>Number.isFinite(t)&&t>=0&&Number.isFinite(video.duration)&&t<video.duration;
    function redraw(){list.replaceChildren();for(const t of times){const b=document.createElement('button');b.textContent=t.toFixed(3)+' 秒 ×';b.setAttribute('aria-label','移除 '+t.toFixed(3)+' 秒');b.disabled=busy;b.onclick=()=>{times=times.filter(x=>x!==t);redraw();};list.append(b);}save.disabled=busy||!times.length;}
    video.onloadeddata=()=>{if(token!==epoch)return;if(!Number.isFinite(video.duration)||video.duration<=0){status.textContent='视频没有可用的时长信息，请使用保存完整的 MP4 / WebM 文件。';add.disabled=true;return;}add.disabled=busy;time.max=String(Math.max(0,video.duration-.001));status.textContent=`时长 ${video.duration.toFixed(3)} 秒 · ${video.videoWidth} × ${video.videoHeight}`;};
    video.onerror=()=>{status.textContent='视频无法读取或浏览器不支持此格式，请下载后上传 MP4 / WebM 再试。';add.disabled=true;save.disabled=true;};
    locate.onclick=()=>{const t=Number(time.value);if(time.value===''||!valid(t)){status.textContent='请输入视频时长范围内的时间。';return;}video.pause();video.currentTime=t;status.textContent=`已定位到 ${t.toFixed(3)} 秒，可添加当前时间点。`;};
    add.onclick=()=>{if(busy||!valid(video.currentTime))return;const t=Math.round(video.currentTime*1000)/1000;if(times.includes(t))return;if(times.length>=20){status.textContent='一次最多保存 20 帧。';return;}times.push(t);times.sort((a,b)=>a-b);redraw();};
    function seek(t){return new Promise((resolve,reject)=>{
      if(Math.abs(video.currentTime-t)<.0001&&video.readyState>=2){resolve();return;}
      const timer=setTimeout(()=>done(Error('定位画面超时，请重试。')),15000);
      const ended=()=>done();const fail=()=>done(Error('读取视频画面失败。'));
      function done(error){clearTimeout(timer);video.removeEventListener('seeked',ended);video.removeEventListener('error',fail);error?reject(error):resolve();}
      video.addEventListener('seeked',ended);video.addEventListener('error',fail);video.currentTime=t;
    });}
    save.onclick=async()=>{
      if(busy||!times.length)return;busy=true;add.disabled=locate.disabled=true;video.pause();video.controls=false;time.disabled=true;redraw();const chosen=[...times];
      try{
        const form=new FormData(),surface=document.createElement('canvas');surface.width=video.videoWidth;surface.height=video.videoHeight;
        if(!surface.width||!surface.height)throw Error('视频画面尚未加载。');
        for(let i=0;i<chosen.length;i++){
          status.textContent=`正在截取 ${i+1} / ${chosen.length}…`;await seek(chosen[i]);if(token!==epoch)return;
          surface.getContext('2d').drawImage(video,0,0);const blob=await new Promise((resolve,reject)=>surface.toBlob(b=>b?resolve(b):reject(Error('画面保存失败。')),'image/png'));
          form.append('files',blob,`frame-${chosen[i].toFixed(3)}s.png`);
        }
        const r=await fetch('/api/ai/upload',{method:'POST',body:form});const data=await r.json();if(!r.ok)throw Error(data.detail||'关键帧保存失败');if(token!==epoch)return;
        if(!nodes.includes(node))throw Error('原视频节点已移除，请重新选择。');
        if(data.files?.length!==chosen.length)throw Error('保存的图片数量不完整，请重试。');
        pushUndo();const p=placement(node),out=addNode({id:uid('frames'),type:'output',x:p.x,y:p.y,images:data.files.map((f,i)=>({...f,kind:'image',sourceTime:chosen[i]})),studioTitle:'视频关键帧',studioProcessing:{type:'keyframes',sourceNode:node.id,sourceUrl:ref.url,times:chosen}});
        render();scheduleSave();dialog.close();setStatus(`已保存 ${out.images.length} 张关键帧`);
      }catch(e){if(token===epoch)status.textContent=e.name==='SecurityError'?'此远程视频不允许截帧，请下载后上传到画布再试。':e.message;}
      finally{busy=false;if(token===epoch){add.disabled=locate.disabled=time.disabled=false;video.controls=true;redraw();}}
    };
    video.src=canvasDisplayMediaUrl(ref.url,ref.name||'');
  }
  function toolbar(node,ref){
    const bar=stop(document.createElement('div'));bar.className='studio-media-actions';
    if(ref.kind==='video'){const b=document.createElement('button');b.textContent='截取关键帧';b.onclick=()=>keyframes(node,ref);bar.append(b);}
    return bar;
  }
  // One screen-space toolbar for the selected image, independent of node zoom.
  const imageBar=stop(document.createElement('div'));imageBar.className='studio-image-toolbar';imageBar.setAttribute('role','toolbar');imageBar.setAttribute('aria-label','图片处理工具');imageBar.hidden=true;document.body.append(imageBar);
  let activeImage=null,frame=0,imagePress=null;
  function liveImage(){
    if(!activeImage)return null;const node=nodes.find(n=>n.id===activeImage.id);if(!node)return null;
    if(node.type==='image'&&node.url===activeImage.url)return {node,ref:{url:node.url,name:node.name,kind:mediaKindForNode(node)}};
    const item=(node.images||[]).find(item=>outputUrlValue(item)===activeImage.url);
    return item?{node,ref:{url:outputUrlValue(item),name:item.name,kind:mediaKindForOutputItem(item)}}:null;
  }
  function hideImageTools(){activeImage=null;imageBar.hidden=true;cancelAnimationFrame(frame);document.querySelectorAll('.studio-selected-image').forEach(el=>el.classList.remove('studio-selected-image'));}
  function placeImageTools(){
    const item=liveImage();if(!item||selected.size!==1||!selected.has(item.node.id)){hideImageTools();return;}
    const root=document.querySelector(`#nodes [data-id="${CSS.escape(item.node.id)}"]`);
    const img=[...(root?.querySelectorAll('img[data-url]')||[])].find(img=>img.dataset.url===item.ref.url);
    if(!img){hideImageTools();return;}
    document.querySelectorAll('.studio-selected-image').forEach(el=>{if(el!==img)el.classList.remove('studio-selected-image');});img.classList.add('studio-selected-image');
    const r=img.getBoundingClientRect();
    imageBar.hidden=!!document.querySelector('dialog[open],#imageEditModal.open,#outputLightbox.open')||r.bottom<75||r.top>innerHeight||r.right<0||r.left>innerWidth;
    if(!imageBar.hidden){const w=imageBar.offsetWidth,h=imageBar.offsetHeight;imageBar.style.left=Math.max(12,Math.min(innerWidth-w-12,r.left+r.width/2-w/2))+'px';imageBar.style.top=Math.max(78,Math.min(innerHeight-h-12,r.top-h-12))+'px';}
    frame=requestAnimationFrame(placeImageTools);
  }
  function selectImage(node,ref){
    document.activeElement?.blur?.();selected.clear();selected.add(node.id);refreshSelectionVisuals();activeImage={id:node.id,url:ref.url};cancelAnimationFrame(frame);placeImageTools();
  }
  function editSelected(mode){
    const item=liveImage();if(!item)return;
    let node=item.node;
    // Native editor edits image nodes. Materialize just this output as a copy;
    // original generated collection remains intact and the operation is undoable.
    if(node.type!=='image'){pushUndo();const p=placement(node);createImageCardFromUrl(item.ref.url,p,item.ref.name||'图片编辑');node=nodes[nodes.length-1];selectImage(node,item.ref);}
    openImageEditor(node.id,mode);
  }
  const actions=[
    ['标准人设图','user-round',()=>{const i=liveImage();if(i)character(i.node,i.ref);}],
    ['人物处理','shirt',()=>{const i=liveImage();if(i)StudioAssetTools.open('person',i.node,i.ref);}],
    ['场景视角','camera',()=>{const i=liveImage();if(i)StudioAssetTools.open('scene',i.node,i.ref);}],
    ['涂改与修改','paintbrush',()=>{const i=liveImage();if(i)StudioAssetTools.open('edit',i.node,i.ref);}],
    ['双图对比','columns-2',()=>{const i=liveImage();if(i)StudioAssetTools.compare(i.node,i.ref);}],
    ['裁剪','crop',()=>editSelected('crop')],['宫格裁剪','grid-2x2',()=>editSelected('grid')],
    ['标注','pencil',()=>editSelected('brush')],['调整尺寸','scaling',()=>editSelected('resize')],
    ['下载','download',()=>{const i=liveImage();if(i)downloadUrl(i.ref.url,outputDownloadName(i.ref.url)).catch(e=>setStatus(e.message));}],
    ['查看大图','maximize-2',()=>{const i=liveImage();if(i){document.activeElement?.blur?.();openOutputLightbox(i.ref.url,i.node);}}]
  ];
  for(const [label,icon,action] of actions){const b=document.createElement('button');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.innerHTML=`<i data-lucide="${icon}"></i><span>${label}</span>`;b.onclick=action;imageBar.append(b);}refreshIcons();
  function imageTarget(target){
    const img=target.closest?.('#nodes .image-preview-wrap img,#nodes .output-img-wrap img');if(!img)return null;
    const node=nodes.find(n=>n.id===img.closest('[data-id]')?.dataset.id);if(!node)return null;
    const url=img.dataset.url||node.url,item=node.type==='image'?{url,kind:mediaKindForNode(node),name:node.name}:(node.images||[]).find(x=>outputUrlValue(x)===url);
    if(!item||mediaKindForOutputItem(item)!=='image'||img.dataset.dragging||img.closest('.output-img-wrap')?.dataset.dragging)return null;
    return {node,ref:{url,name:item.name,kind:'image'}};
  }
  document.addEventListener('pointerdown',e=>{
    if(e.target.closest?.('.studio-image-toolbar,.studio-media-tools,#imageEditModal,#outputLightbox'))return;
    const item=imageTarget(e.target);imagePress=item?{item,x:e.clientX,y:e.clientY}:null;
    if(!item&&!e.target.closest?.('#nodes .node'))hideImageTools();
  },true);
  document.addEventListener('mousedown',e=>{if(e.button===0&&e.detail>=2&&imageTarget(e.target)){e.preventDefault();e.stopImmediatePropagation();}},true);
  document.addEventListener('click',e=>{
    // Native selection may resize/rebuild the image between mouse down/up.
    // Retain the pressed image only for a stationary click in the same node.
    const pressed=imagePress;imagePress=null;
    if(pressed&&Math.hypot(e.clientX-pressed.x,e.clientY-pressed.y)>5)return;
    const i=imageTarget(e.target)||(pressed&&e.target.closest?.('[data-id]')?.dataset.id===pressed.item.node.id?pressed.item:null);
    if(!i||e.button!==0)return;e.preventDefault();e.stopImmediatePropagation();
    if(e.ctrlKey||e.metaKey){selected.has(i.node.id)?selected.delete(i.node.id):selected.add(i.node.id);refreshSelectionVisuals();hideImageTools();return;}
    selectImage(i.node,i.ref);
  },true);
  document.addEventListener('dblclick',e=>{const i=imageTarget(e.target);if(!i)return;e.preventDefault();e.stopImmediatePropagation();selectImage(i.node,i.ref);openOutputLightbox(i.ref.url,i.node);},true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('dialog[open],#imageEditModal.open,#outputLightbox.open'))hideImageTools();});
  imageBar.addEventListener('keydown',e=>{if(e.key==='Escape'){if(document.querySelector('#outputLightbox.open'))closeOutputLightbox();else if(document.querySelector('#imageEditModal.open'))closeImageEditor();else hideImageTools();}});
  const draw=renderNode;
  renderNode=node=>{
    const el=draw(node);
    if(node.type==='image'&&node.url&&mediaKindForNode(node)==='video')el.querySelector('.node-body')?.prepend(toolbar(node,{url:node.url,name:node.name,kind:'video'}));
    if(node.type==='output')el.querySelectorAll('.output-img-wrap').forEach(tile=>{const ref=(node.images||[]).find(item=>outputUrlValue(item)===tile.dataset.outputUrl);if(ref&&mediaKindForOutputItem(ref)==='video')tile.append(toolbar(node,{url:outputUrlValue(ref),name:ref.name,kind:'video'}));});
    return el;
  };
})();
