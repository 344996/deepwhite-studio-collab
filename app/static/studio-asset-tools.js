/* API asset tools share existing capability, quote, generation and persistence paths. */
(() => {
  if(document.querySelector('.smart-back'))return;
  const style=document.createElement('link');style.rel='stylesheet';style.href='/static/studio-asset-tools.css?v=1';document.head.append(style);
  const presets=window.StudioAssetPresets;
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const stop=n=>{for(const t of ['pointerdown','mousedown','click','dblclick','keydown','wheel'])n.addEventListener(t,e=>e.stopPropagation());return n;};
  const dialog=stop(el('dialog',null,'studio-asset-dialog'));document.body.append(dialog);
  let revision=0;
  dialog.addEventListener('close',()=>revision++);
  async function json(url,data){const r=await fetch(url,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});const d=await r.json();if(!r.ok)throw Error(d.detail||'请求失败');return d;}
  function openShell(title){if(dialog.open)dialog.close();revision++;dialog.replaceChildren();const head=el('header'),h=el('strong',title),close=el('button','×');close.type='button';close.setAttribute('aria-label','关闭资产工具');close.onclick=()=>dialog.close();head.append(h,close);const body=el('div',null,'studio-asset-body');dialog.append(head,body);dialog.showModal();return body;}
  function field(label,control){const l=el('label',label,'studio-asset-field');control.setAttribute('aria-label',label);l.append(control);return l;}
  function image(url,name){const i=el('img');i.src=canvasDisplayMediaUrl(url,name||'');i.alt=name||'参考图片';return i;}
  function position(node){const r=estimatedNodeRect(node);return {x:r.x+r.w+70,y:r.y};}
  function pictureList(){const seen=new Set(),items=[];for(const n of nodes){const refs=n.type==='image'&&n.url?[{url:n.url,name:n.name,kind:mediaKindForNode(n)}]:n.images||[];for(const r of refs){const url=outputUrlValue(r);if(url&&!seen.has(url)&&mediaKindForOutputItem(r)==='image'){seen.add(url);items.push({url,name:r.name||n.studioTitle||'画布图片',kind:'image',nodeId:n.id});}}}return items;}
  async function choices(){const [catalog,caps]=await Promise.all([json('/api/studio/model-catalog'),json('/api/studio/capabilities')]);const list=[];
    for(const [pid,saved] of Object.entries(catalog.providers||{})){const p=apiProviders.find(p=>p.id===pid);if(!p||p.enabled===false||!p.has_key)continue;try{if(new URL(p.base_url).hostname!=='api.deepwhiteai.com')continue;}catch{continue;}
      for(const m of saved.models||[]){const spec=caps.providers?.[pid]?.[m.id];if(m.kind==='image'&&m.enabled!==false&&!m.removed&&m.available!==false&&spec?.supported&&spec.max_images>=1&&/^(deepwhiteai-image-g2(?:$|-)|deepwhiteai-image-g-v2(?:\.5)?-|deepwhiteai-image-nb-)/i.test(m.id))list.push({pid,model:m.id,name:m.name,series:m.series||(/image-nb-/.test(m.id)?'Nano Banana':'GPT 图片'),provider:p.name,spec});}}
    return list;
  }
  function modelFields(body,list,changed){const series=el('select'),model=el('select');for(const s of [...new Set(list.map(x=>x.series))])series.add(new Option(s,s));body.append(field('模型系列',series),field('具体型号',model));
    const preferred=list.find(x=>x.model==='deepwhiteai-image-g-v2.5-sunburst')||list[0];series.value=preferred.series;
    function fill(){model.replaceChildren();list.forEach((c,i)=>{if(c.series===series.value)model.add(new Option(`${c.provider} · ${c.name}`,String(i)));});}
    fill();model.value=String(list.indexOf(preferred));series.onchange=()=>{fill();changed();};model.onchange=changed;return ()=>list[Number(model.value)];
  }
  function sourceExists(node,ref){return nodes.includes(node)&&(node.type==='image'?node.url===ref.url:(node.images||[]).some(r=>outputUrlValue(r)===ref.url));}
  async function openTool(group,node,ref){
    const body=openShell(group==='person'?'人物资产处理':group==='scene'?'场景视角':'涂改与修改'),token=revision;
    const introduction=el('p','保留原图，处理结果生成到新的分支。调用前可以检查完整提示词和参考素材。','studio-asset-muted');body.append(introduction);
    const preview=image(ref.url,'原始参考图');preview.className='studio-asset-source';body.append(preview);
    const tools=presets.filter(p=>p.group===group),tool=el('select');tools.forEach(p=>tool.add(new Option(p.name,p.id)));body.append(field('处理功能',tool));
    const description=el('textarea');description.rows=3;description.placeholder=group==='scene'?'描述观察方向、关键陈设及需要保持的空间关系。':'描述要替换的服装、装备、物品或需要修改的内容。';body.append(field('处理要求',description));
    let extra=null,marked=null,busy=false,uploading=false,modelChoice=null,paramInputs={},quoteVersion=0;
    const referenceSelect=el('select');referenceSelect.add(new Option('不添加额外参考',''));const refs=pictureList().filter(r=>r.url!==ref.url);refs.forEach((r,i)=>referenceSelect.add(new Option(r.name,String(i))));
    const upload=el('input');upload.type='file';upload.accept='image/*';const clear=el('button','移除额外参考');clear.type='button';const extraPreview=el('div',null,'studio-asset-extra');body.append(field('从画布选择额外参考',referenceSelect),field('上传额外参考图',upload),extraPreview,clear);
    const state=el('p','正在读取已启用的 GPT / Nano Banana 图片模型…');state.setAttribute('role','status');body.append(state);
    const hasExtra=()=>extra?[{url:extra.url,name:extra.name||'额外参考',kind:'image'}]:[];
    const selectedPreset=()=>tools.find(p=>p.id===tool.value);
    let update=()=>{};
    function showExtra(){extraPreview.replaceChildren();if(extra)extraPreview.append(image(extra.url,extra.name));clear.disabled=!extra;update();}
    referenceSelect.onchange=()=>{extra=referenceSelect.value===''?null:refs[Number(referenceSelect.value)];upload.value='';showExtra();};clear.onclick=()=>{extra=null;referenceSelect.value='';upload.value='';showExtra();};
    upload.onchange=async()=>{const f=upload.files[0];if(!f)return;uploading=true;update();try{if(!f.type.startsWith('image/'))throw Error('请选择图片文件。');const form=new FormData();form.append('files',f);const r=await fetch('/api/ai/upload',{method:'POST',body:form});const d=await r.json();if(!r.ok||!d.files?.[0])throw Error(d.detail||'参考图上传失败');if(token!==revision)return;extra=d.files[0];referenceSelect.value='';showExtra();state.textContent='额外参考已上传。';}catch(e){if(token===revision)state.textContent=e.message;}finally{uploading=false;if(token===revision)update();}};
    let annotation=null;
    if(group==='edit'){
      const note=el('p','涂抹用于向模型说明修改位置，不是原生蒙版接口；模型仍可能改变区域外内容。','studio-asset-muted');body.append(note);
      annotation=await createAnnotation(body,preview,()=>{marked=null;update();},token);if(token!==revision)return;
    }
    const paramsBox=el('div',null,'studio-asset-params');const details=el('details'),summary=el('summary','查看实际发送的提示词'),prompt=el('pre');details.append(summary,prompt);body.append(paramsBox,details);
    const quote=el('p','请选择模型','studio-asset-quote'),run=el('button','生成处理结果','studio-asset-primary');run.disabled=true;body.append(quote,run);
    function parameters(){return Object.fromEntries(Object.entries(paramInputs).map(([k,c])=>[k,modelChoice().spec.fields[k].values[c.selectedIndex]]));}
    function buildPrompt(){const p=selectedPreset();let text=p.instruction+'\n\n用户要求：'+(description.value.trim()||'按所选功能处理。');text+='\n\n图1：原始素材。';if(annotation?.painted())text+='\n图2：与图1对齐的红色区域标注，仅说明修改位置。';if(extra)text+=`\n图${annotation?.painted()?3:2}：${p.reference}，只参考指定对象。`;return text;}
    function drawParams(){paramsBox.replaceChildren();paramInputs={};const spec=modelChoice().spec;for(const [key,f]of Object.entries(spec.fields)){const c=el('select');f.values.forEach(v=>c.add(new Option(String(v),String(v))));c.value=String(f.default);c.onchange=update;paramInputs[key]=c;paramsBox.append(field(f.label,c));}}
    const error=()=>{if(!sourceExists(node,ref))return '原始素材已变更或移除，请重新选择。';if(uploading)return '参考图正在上传…';if(!modelChoice)return '没有可用模型。';const count=1+Number(!!extra)+Number(!!annotation?.painted());if(count>modelChoice().spec.max_images)return '当前型号不支持这些参考图，请减少素材或切换型号。';if(!description.value.trim()&&!extra&&group!=='scene')return '请填写处理要求或添加替换参考图。';const length=buildPrompt().length;if(length>modelChoice().spec.prompt_max)return '处理要求过长，请缩短。';return '';};
    update=()=>{if(token!==revision)return;prompt.textContent=buildPrompt();const issue=error();run.disabled=busy||!!issue;if(issue){quote.textContent=issue;++quoteVersion;return;}const serial=++quoteVersion,c=modelChoice();quote.textContent='正在估算费用…';json('/api/studio/quote',{provider_id:c.pid,model:c.model,kind:'image',count:1,image_count:1+Number(!!extra)+Number(!!annotation?.painted()),params:parameters()}).then(q=>{if(token===revision&&serial===quoteVersion)quote.textContent=q.label+'；'+(q.note||'最终以账单为准');}).catch(()=>{if(token===revision&&serial===quoteVersion)quote.textContent='估价暂不可用，最终费用以实际账单为准。';});};
    description.oninput=update;tool.onchange=update;
    try{const list=await choices();if(token!==revision)return;if(!list.length){state.textContent='请在 API 设置中启用支持参考图的 GPT 或 Nano Banana 图片型号。';return;}const modelBox=el('div',null,'studio-asset-params');body.insertBefore(modelBox,paramsBox);modelChoice=modelFields(modelBox,list,()=>{drawParams();update();});drawParams();state.textContent=group==='scene'?'新视角看不到的区域由模型补全，请检查生成后的空间关系。':'默认保留身份与未指定修改的内容；效果以模型实际输出为准。';showExtra();update();}catch(e){if(token===revision)state.textContent=e.message;return;}
    run.onclick=async()=>{if(busy||error())return;busy=true;run.disabled=true;state.textContent='正在准备处理任务…';try{
      // Freeze the selected tool, options and prompt before asynchronous media preparation.
      const c=modelChoice(),p=selectedPreset(),params=parameters(),text=buildPrompt(),extras=hasExtra();
      if(annotation?.painted()){
        const blob=await annotation.blob();const form=new FormData();form.append('files',blob,'edit-region.png');const r=await fetch('/api/ai/upload',{method:'POST',body:form}),d=await r.json();if(!r.ok||!d.files?.[0])throw Error(d.detail||'标注保存失败');marked={...d.files[0],kind:'image',name:'修改位置标注'};
      }
      if(token!==revision)return;if(!sourceExists(node,ref))throw Error('原始素材已变更，请重新选择。');
      const references=[{url:ref.url,name:ref.name||'原始图片',kind:'image'},...(marked?[marked]:[]),...extras];
      pushUndo();const n=addGeneratorNode(position(node));Object.assign(n,{apiProvider:c.pid,model:c.model,count:1,studioTitle:p.name,studioPrompt:text,studioParams:params,studioParamsModel:c.model,studioRefs:references,studioProcessing:{type:p.id,version:p.version,sourceNode:node.id,sourceUrl:ref.url,referenceRoles:references.map((r,i)=>({url:r.url,role:i===0?'original':r===marked?'annotation':'replacement'}))}});render();scheduleSave();dialog.close();Promise.resolve(runGenerator(n.id)).catch(e=>setStatus(e.message||'处理失败'));
    }catch(e){if(token===revision)state.textContent=e.message;}finally{busy=false;if(token===revision)update();}};
  }
  async function createAnnotation(body,preview,changed,token){
    const box=el('div',null,'studio-annotation'),canvas=el('canvas');canvas.setAttribute('aria-label','涂抹修改区域');const reset=el('button','清除涂抹');reset.type='button';const size=el('input');size.type='range';size.min=8;size.max=100;size.value=35;box.append(canvas,field('画笔大小',size),reset);body.append(box);
    let original,painted=false,drawing=false;try{original=new Image();original.crossOrigin='anonymous';original.src=preview.src;await original.decode();if(token!==revision)return null;const scale=Math.min(1,1280/Math.max(original.naturalWidth,original.naturalHeight));canvas.width=Math.max(1,Math.round(original.naturalWidth*scale));canvas.height=Math.max(1,Math.round(original.naturalHeight*scale));}catch{box.replaceChildren(el('p','图片暂时无法涂抹，可先通过文字说明修改。'));return null;}
    const base=()=>{const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(original,0,0,canvas.width,canvas.height);};base();
    const point=e=>{const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height};};let previous;
    function stroke(p){const ctx=canvas.getContext('2d');ctx.strokeStyle='rgba(255,30,50,.65)';ctx.lineWidth=Number(size.value)*canvas.width/canvas.getBoundingClientRect().width;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(p.x+.01,p.y);ctx.stroke();previous=p;painted=true;}
    canvas.onpointerdown=e=>{e.preventDefault();drawing=true;previous=point(e);canvas.setPointerCapture(e.pointerId);stroke(previous);};canvas.onpointermove=e=>{if(drawing)stroke(point(e));};canvas.onpointerup=canvas.onpointercancel=()=>{drawing=false;changed();};reset.onclick=()=>{painted=false;base();changed();};
    return {painted:()=>painted,blob:()=>new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('标注导出失败')),'image/png'))};
  }
  function compareWidget(node){
    const cfg=node.studioCompare||(node.studioCompare={before:{},after:{},position:50}),refs=pictureList();
    if(!cfg.before||!cfg.after){cfg.before=cfg.before||{};cfg.after=cfg.after||{};cfg.position=cfg.position??50;}
    if(!cfg.before.url||!cfg.after.url){const box=stop(el('div',null,'studio-compare studio-compare-incomplete'));box.append(el('p','选择图片 A 和图片 B，在同一节点中滑动对比。'));for(const key of ['before','after']){const select=el('select');select.setAttribute('aria-label',key==='before'?'对比图片 A':'对比图片 B');select.add(new Option(key==='before'?'选择图片 A':'选择图片 B',''));refs.forEach((r,i)=>select.add(new Option(r.name,String(i))));const index=refs.findIndex(r=>r.url===cfg[key].url);select.value=index<0?'':String(index);select.onchange=()=>{if(select.value==='')return;pushUndo();const r=refs[Number(select.value)];cfg[key]={url:r.url,name:r.name};scheduleSave();render();};box.append(select);}return box;}
    const box=stop(el('div',null,'studio-compare')),stage=el('div',null,'studio-compare-stage'),before=image(cfg.before.url,'图片 A'),after=image(cfg.after.url,'图片 B'),clip=el('div',null,'studio-compare-clip'),line=el('div',null,'studio-compare-line');clip.append(after);stage.append(before,clip,line);const labels=el('div',null,'studio-compare-labels');labels.append(el('span','B · '+(cfg.after.name||'图片 B')),el('span','A · '+(cfg.before.name||'图片 A')));const range=el('input');range.type='range';range.min=0;range.max=100;range.value=cfg.position??50;range.setAttribute('aria-label','双图对比分界线');let recorded=false;
    const show=()=>{clip.style.clipPath=`inset(0 ${100-Number(range.value)}% 0 0)`;line.style.left=range.value+'%';};range.oninput=()=>{if(!recorded){pushUndo();recorded=true;}cfg.position=Number(range.value);show();};range.onchange=()=>{recorded=false;scheduleSave();};range.onblur=()=>{recorded=false;scheduleSave();};show();box.append(stage,labels,range,el('small','等比适配；不同尺寸图片不作像素对齐。'));
    before.onerror=after.onerror=()=>{box.querySelector('small').textContent='图片读取失败，请确认素材仍可访问。';};return box;
  }
  function selectedPictures(){const result=[];for(const id of selected){const node=nodes.find(n=>n.id===id);if(!node)continue;const refs=node.type==='image'&&node.url?[{url:node.url,name:node.name||'画布图片',kind:'image',nodeId:node.id}]:node.images||[];for(const ref of refs){const url=outputUrlValue(ref),isImage=node.type==='image'?mediaKindForNode(node)==='image':mediaKindForOutputItem(ref)==='image';if(url&&isImage){result.push({url,name:ref.name||node.studioTitle||'画布图片',kind:'image',nodeId:node.id});break;}}}return result;}
  function createCompare(before,after){
    const refs=pictureList();const find=ref=>ref&&refs.find(item=>item.url===ref.url);
    const a=find(before),b=find(after),anchorNodes=[a,b].filter(Boolean).map(ref=>nodes.find(n=>n.id===ref.nodeId)).filter(Boolean);
    let point=defaultPoint(-120,0);if(anchorNodes.length){const rects=anchorNodes.map(estimatedNodeRect);point={x:Math.max(...rects.map(r=>r.x+r.w))+70,y:Math.min(...rects.map(r=>r.y))};}
    const config={before:a?{url:a.url,name:a.name}: {},after:b?{url:b.url,name:b.name}: {},position:50};
    pushUndo();const node=addNode({id:uid('compare'),type:'output',x:point.x,y:point.y,images:[],studioTitle:'双图对比',studioCompare:config});
    if(node){selected.clear();selected.add(node.id);refreshSelectionVisuals();render();scheduleSave();}
    return node||null;
  }
  function compare(node,ref){const picks=selectedPictures(),first=ref||picks[0];return createCompare(first,picks.find(item=>item.url!==first?.url));}
  const draw=renderNode;renderNode=node=>{const root=draw(node);if(node.studioCompare){const body=root.querySelector('.node-body');body.replaceChildren(compareWidget(node));root.classList.add('studio-compare-node');const title=root.querySelector('.node-title');if(title)title.textContent=node.studioTitle||'双图对比';}return root;};
  const refresh=refreshOutputNodeContent;refreshOutputNodeContent=node=>node.studioCompare?false:refresh(node);
  window.StudioAssetTools={open:openTool,compare,createCompare,selectedPictures,addCompare(){const picks=selectedPictures();return createCompare(picks[0],picks.find(item=>item.url!==picks[0]?.url)||picks[1]);}};
})();
