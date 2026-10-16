/* Disposable interaction study; this file is never loaded by the real canvas. */
(() => {
  const $ = (s, root=document) => root.querySelector(s);
  const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icons = () => window.lucide?.createIcons();
  const canvas = $('#previewCanvas'), container = $('#previewNodes'), menu = $('#addMenu');
  const types = {
    text:{name:'文本',icon:'type',placeholder:'描述你想生成、改写或整理的内容…',models:[['deepseek/deepseek-v4.1-flash','DeepSeek V4.1 Flash'],['qwen/qwen3.8-max','Qwen 3.8 Max']]},
    image:{name:'图片',icon:'image',placeholder:'描述画面主体、环境、风格和构图…',models:[['deepwhiteai-image-g-v2-lowprice','全能图片 V2 · 低价'],['deepwhiteai-image-g-v2.5-flare','全能图片 G2.5 · 极速'],['seedream-v5-pro','Seedream V5 Pro']]},
    video:{name:'视频',icon:'video',placeholder:'描述场景、人物动作和镜头运动…',models:[['seedance-2.0-fast','Seedance 2.0 · Fast'],['seedance-2.0-mini','Seedance 2.0 · Mini']]},
    audio:{name:'音频',icon:'audio-lines',placeholder:'输入配音文本或描述想生成的声音…',models:[['doubao-seed-audio-1.0','豆包 Seed Audio'],['qwen3-tts-flash','Qwen3 TTS Flash']]}
  };
  let nodes = [], selected = '', sequence = 0, menuPoint = null, snapshot = null, toastTimer;
  const objectUrls = new Set();
  function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),2500); }
  function dialog(title, body) { $('#dialogTitle').textContent=title; $('#dialogBody').textContent=body; $('#previewDialog').showModal(); }
  $('#closeDialog').onclick=()=>$('#previewDialog').close();
  function mode(n) { return n.kind==='image' ? (n.refs.length?'参考图生成':'文字生成图片') : n.kind==='video' ? (n.refs.length?'参考图生成视频':'文字生成视频') : n.kind==='audio' ? '声音生成' : '文字生成'; }
  function endpoint(n) { return n.model==='seedream-v5-pro' ? `${n.model}-${n.refs.length?'i2i':'t2i'}` : n.kind==='video' ? `${n.model}-${n.refs.length?'i2v':'t2v'}` : n.model; }
  function price(n) {
    if (!snapshot) return {label:'正在读取估价…',note:'公开价格快照'};
    if (n.kind==='text' || n.kind==='audio' || n.model.includes('v2.5')) return {label:'按实际用量计费',note:'当前参数暂无可靠预估'};
    const profile=snapshot.price_estimates?.[endpoint(n)];
    if (!profile || profile.status!=='ready' || !profile.entries?.length) return {label:'暂无可靠估价',note:'以实际任务账单为准'};
    const keyValue = k => ({resolution:n.resolution,'metadata.resolution':n.resolution,quality:n.quality,aspectRatio:n.ratio,aspect_ratio:n.ratio,'metadata.aspect_ratio':n.ratio,input_image_count:String(n.refs.length),seconds:n.duration,duration:n.duration,'metadata.generate_audio':'true',generate_audio:'true'}[k]);
    const features=profile.active_features||[];
    if (!features.length || features.some(k=>keyValue(k)==null)) return {label:'暂无可靠估价',note:'当前参数缺少可比样本'};
    const entries=profile.entries.filter(e=>features.every(k=>String(e.params?.[k]).toLowerCase()===String(keyValue(k)).toLowerCase()));
    if (!entries.length) return {label:'暂无可靠估价',note:'当前参数缺少可比样本'};
    const sorted=entries.slice().sort((a,b)=>a.price_cny-b.price_cny), total=sorted.reduce((sum,e)=>sum+Math.max(1,e.sample_count||1),0);
    let weight=0, median=sorted[0].price_cny;
    for(const entry of sorted){ weight+=Math.max(1,entry.sample_count||1); if(weight>=total/2){median=entry.price_cny;break;} }
    const low=Math.min(...entries.map(e=>e.low_cny??e.price_cny))*n.count, high=Math.max(...entries.map(e=>e.high_cny??e.price_cny))*n.count;
    const label=high-low>.005?`预计 ¥${low.toFixed(2)}–${high.toFixed(2)}`:`预计 ¥${(median*n.count).toFixed(2)}`;
    return {label,note:`历史估价 · ${snapshot.fetched_date} 快照`};
  }
  function options(n) {
    if (n.kind==='image') {
      const result=[['ratio','比例',['1:1','16:9','9:16','4:3','3:4']],['resolution','分辨率',n.model==='seedream-v5-pro'?['2k','4k']:['1k','2k','4k']]];
      if(n.model.includes('v2.5')) result.push(['quality','质量',['low','medium','high']]);
      if(n.model==='deepwhiteai-image-g-v2-lowprice') result.push(['count','生成数量',['1','2','4']]);
      return result;
    }
    if(n.kind==='video') return [['ratio','比例',['16:9','9:16','1:1']],['resolution','分辨率',['480p','720p','1080p']],['duration','时长（秒）',['4','5','8','10','15']]];
    if(n.kind==='audio') return n.model==='doubao-seed-audio-1.0' ? [['format','格式',['mp3','wav']],['speechRate','语速',['-20','0','20']]] : [['voice','音色',['Cherry','Serena','Ethan']]];
    return [['maxTokens','最大输出长度',['512','1024','2048']]];
  }
  function summary(n) { return n.kind==='image'?`${n.ratio} / ${n.resolution}`:n.kind==='video'?`${n.resolution} / ${n.duration}秒`:n.kind==='audio'?(n.model==='doubao-seed-audio-1.0'?n.format:n.voice):`${n.maxTokens} tokens`; }
  function media(n) {
    if(n.media) {
      if(n.kind==='image') return `<img src="${escape(n.media.url)}" alt="上传的图片">`;
      if(n.kind==='video') return `<video src="${escape(n.media.url)}" controls></video>`;
      if(n.kind==='audio') return `<audio src="${escape(n.media.url)}" controls></audio>`;
    }
    return `<div class="media-placeholder"><i data-lucide="${types[n.kind].icon}"></i><p>${n.kind==='text'?'文字结果显示在这里':`${types[n.kind].name}结果显示在这里`}</p></div>`;
  }
  function render() {
    container.innerHTML=nodes.map(n=>{
      const t=types[n.kind], quote=price(n);
      return `<section class="preview-node ${n.id===selected?'selected':''}" data-id="${n.id}" aria-label="${t.name}节点" ${n.position?`style="left:${n.position.x}px;top:${n.position.y}px"`:''}>
        <div class="node-title"><i data-lucide="${t.icon}"></i><strong>${t.name}</strong>${n.kind!=='text'?'<button class="upload-button" data-action="upload"><i data-lucide="upload"></i>上传</button>':''}<button class="node-remove" data-action="remove" title="删除预览节点" aria-label="删除预览节点"><i data-lucide="x"></i></button></div>
        <div class="media-surface"><button class="port port-left" data-action="port" aria-label="输入连接点">+</button>${media(n)}<button class="port port-right" data-action="port" aria-label="输出连接点">+</button></div>
        <div class="composer"><div class="reference-strip">${['image','video'].includes(n.kind)?'<button class="add-reference" data-action="reference" title="添加参考图" aria-label="添加参考图"><i data-lucide="plus"></i></button>':''}${n.refs.map((r,i)=>`<span class="ref-chip"><img class="ref-thumb" src="${escape(r.url)}" alt="参考图"><span>${escape(r.name)}</span><button data-action="remove-ref" data-index="${i}" aria-label="移除参考图">×</button></span>`).join('')}<span class="mode-label">${mode(n)}</span></div>
        <textarea class="prompt" aria-label="提示词" placeholder="${t.placeholder}">${escape(n.prompt)}</textarea>
        <div class="composer-toolbar"><select class="model-select" aria-label="选择模型">${t.models.map(([id,label])=>`<option value="${id}" ${id===n.model?'selected':''}>${label}</option>`).join('')}</select><div class="params"><button class="param-button" data-action="params" aria-expanded="${!!n.paramsOpen}">${summary(n)} <i data-lucide="chevron-down"></i></button><div class="param-popover" ${n.paramsOpen?'':'hidden'}>${options(n).map(([key,label,values])=>`<div class="section"><label>${label}</label><div class="segments">${values.map(v=>`<button data-key="${key}" data-value="${v}" class="${String(n[key])===v?'active':''}">${v}</button>`).join('')}</div></div>`).join('')}<p class="parameter-note">只显示当前模型适用的参数。<br>其他模型的完整参数将在接口核对后补齐。</p></div></div><span class="price" title="${escape(quote.note)}"><span>${quote.label}</span><small>${quote.note}</small></span><button class="generate" data-action="generate" aria-label="预览生成操作" title="预览生成操作，不调用 API"><i data-lucide="arrow-up"></i></button></div></div></section>`;
    }).join('');
    icons();
    container.querySelectorAll('.preview-node').forEach(element=>{
      const n=nodes.find(item=>item.id===element.dataset.id);
      const t=types[n.kind];
      element.addEventListener('pointerdown',event=>{if(selected!==n.id){selected=n.id;container.querySelectorAll('.preview-node').forEach(el=>el.classList.toggle('selected',el===element));} if(event.target.closest('.node-title')&&!event.target.closest('button')) startDrag(event,element,n);});
      $('.prompt',element).oninput=e=>{n.prompt=e.target.value;};
      $('.model-select',element).onchange=e=>{n.model=e.target.value;n.count=1;n.resolution=n.model==='seedream-v5-pro'?'2k':n.kind==='image'?'1k':'480p';render();};
      element.querySelectorAll('[data-key]').forEach(button=>button.onclick=()=>{n[button.dataset.key]=button.dataset.key==='count'?Number(button.dataset.value):button.dataset.value;render();});
      element.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>{
        const action=button.dataset.action;
        if(action==='params'){n.paramsOpen=!n.paramsOpen;render();}
        if(action==='remove'){releaseNode(n);nodes=nodes.filter(item=>item!==n);selected=nodes.at(-1)?.id||'';render();}
        if(action==='reference'||action==='upload') chooseFile(n,action==='reference');
        if(action==='remove-ref'){const r=n.refs.splice(Number(button.dataset.index),1)[0];releaseUrl(r.url);render();}
        if(action==='port')toast('连接点位置示意；正式画布继续使用原有连线功能。');
        if(action==='generate')dialog('生成前预览',`已选择「${t.models.find(([id])=>id===n.model)?.[1]}」，${mode(n)}，${summary(n)}。${price(n).label}。本次仅预览操作，没有发送 API 请求。生成结果的展示位置仍待确认。`);
      });
    });
  }
  function startDrag(event, element, n) {
    event.preventDefault();const rect=element.getBoundingClientRect(), bounds=canvas.getBoundingClientRect();
    const initial={x:rect.left-bounds.left+canvas.scrollLeft,y:rect.top-bounds.top+canvas.scrollTop,px:event.clientX,py:event.clientY};
    const move=e=>{n.position={x:Math.max(35,initial.x+e.clientX-initial.px),y:Math.max(20,initial.y+e.clientY-initial.py)};element.style.left=n.position.x+'px';element.style.top=n.position.y+'px';};
    const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop,{once:true});
  }
  function add(kind, point=null) {
    const n={id:`preview-${++sequence}`,kind,model:types[kind].models[0][0],prompt:'',refs:[],ratio:kind==='video'?'16:9':'1:1',resolution:kind==='video'?'480p':'1k',quality:'medium',duration:'5',format:'mp3',speechRate:'0',voice:'Cherry',maxTokens:'1024',count:1,position:point};
    nodes.push(n);selected=n.id;render();return n;
  }
  function releaseUrl(url) {URL.revokeObjectURL(url);objectUrls.delete(url);}
  function releaseNode(n) {n.refs.forEach(r=>releaseUrl(r.url));if(n.media)releaseUrl(n.media.url);}
  function acceptFile(n,file,reference=false) {
    if(reference&&!file.type.startsWith('image/'))return toast('这里请选择图片作为参考。');
    if(reference&&n.kind==='video'&&n.refs.length>=1)return toast('此交互稿先展示单图参考，首尾帧交互后续确认。');
    if(!reference&&!file.type.startsWith(n.kind+'/'))return toast(`请选择${types[n.kind].name}文件。`);
    const url=URL.createObjectURL(file);objectUrls.add(url);
    if(reference)n.refs.push({url,name:file.name});else{if(n.media)releaseUrl(n.media.url);n.media={url,name:file.name};}
    render();
  }
  function chooseFile(n,reference) {
    const input=document.createElement('input');input.type='file';input.accept=reference?'image/*':n.kind+'/*';input.onchange=()=>{if(input.files[0])acceptFile(n,input.files[0],reference);};input.click();
  }
  canvas.addEventListener('dblclick',e=>{if(e.target.closest('.preview-node,.type-rail,.review-note,button,a'))return;e.preventDefault();window.getSelection()?.removeAllRanges();const bounds=canvas.getBoundingClientRect();menuPoint={x:Math.max(35,e.clientX-bounds.left+canvas.scrollLeft-130),y:Math.max(20,e.clientY-bounds.top+canvas.scrollTop-20)};menu.hidden=false;menu.style.left=Math.max(8,Math.min(e.clientX,innerWidth-220))+'px';menu.style.top=Math.max(78,Math.min(e.clientY,innerHeight-345))+'px';});
  document.querySelectorAll('[data-add]').forEach(button=>button.onclick=()=>{const point=button.closest('#addMenu')?menuPoint:null;menu.hidden=true;add(button.dataset.add,point);});
  document.addEventListener('pointerdown',e=>{
    if(!e.target.closest('#addMenu'))menu.hidden=true;
    if(!e.target.closest('.params')){
      nodes.forEach(n=>n.paramsOpen=false);
      container.querySelectorAll('.param-popover').forEach(el=>el.hidden=true);
      container.querySelectorAll('.param-button').forEach(el=>el.setAttribute('aria-expanded','false'));
    }
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;nodes.forEach(n=>n.paramsOpen=false);render();}});
  $('#uploadResource').onclick=()=>{menu.hidden=true;$('#resourceFile').click();};
  $('#resourceFile').onchange=e=>{const file=e.target.files[0];if(!file)return;const kind=file.type.split('/')[0];if(!['image','video','audio'].includes(kind))return toast('请选择图片、视频或音频文件。');acceptFile(add(kind,menuPoint),file);e.target.value='';};
  $('#importWorks').onclick=()=>{menu.hidden=true;dialog('从作品导入','正式画布中将从已有生成结果里选择素材并导入。这个交互预览没有连接作品库。');};
  $('#resetPreview').onclick=()=>{nodes.forEach(releaseNode);nodes=[];add('image');};
  window.addEventListener('pagehide',()=>objectUrls.forEach(url=>URL.revokeObjectURL(url)));
  add('image');
  fetch('/static/studio-preview-prices.json').then(r=>{if(!r.ok)throw Error('price snapshot');return r.json();}).then(data=>{snapshot=data;render();}).catch(()=>{snapshot={};render();});
})();
