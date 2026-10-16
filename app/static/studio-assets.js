(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const projectId = params.get('project_id') || params.get('project') || '';
  const embedded = params.get('embed') === '1' && window.parent !== window;
  const $ = id => document.getElementById(id);
  const state = {status:'all', q:'', items:[], allItems:[], allItemsReady:false, busy:false, confirming:null};
  const labels = {candidate:'候选', confirmed:'正式', archived:'已归档'};
  const kindLabels = {image:'图片',video:'视频',audio:'音频',text:'文本',file:'文件',character:'人物',scene:'场景',prop:'道具',other:'其他'};
  const list = $('assetList'), notice = $('notice');
  if (!projectId) {
    $('projectLabel').textContent = '未指定项目';
    showNotice('缺少项目编号。请从项目画布打开资产面板。', true);
    list.innerHTML = '';
    emptyState('无法载入项目资产', '当前页面没有项目编号，因此不会读取或写入任何资产。');
  } else {
    $('projectLabel').textContent = `项目 ${projectId}`;
    $('openCanvasBtn').href = `/static/canvas-list.html?project=${encodeURIComponent(projectId)}`;
    loadItems();
  }
  if (embedded) $('openCanvasBtn').hidden = true;
  $('closeBtn').addEventListener('click', closePanel);
  document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog')?.close()));
  $('searchInput').addEventListener('input', debounce(() => {state.q = $('searchInput').value.trim(); loadItems();}, 220));
  document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
    state.status = button.dataset.status;
    document.querySelectorAll('.filter').forEach(tab => {const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active));});
    loadItems();
  }));
  $('importBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', importFiles);
  $('repairBtn').addEventListener('click', repairFiles);
  $('registerBtn').addEventListener('click', registerUrl);
  $('confirmForm').addEventListener('submit', confirmCandidate);
  window.addEventListener('keydown', event => {if(event.key === 'Escape' && embedded) closePanel();});
  window.addEventListener('message', event => {
    if (!embedded || event.origin !== location.origin || event.source !== window.parent) return;
    const data = event.data;
    if (data?.type === 'studio-assets:result') {
      showNotice(data.ok ? '已加入当前画布。' : (data.message || '无法加入画布。'), !data.ok);
    }
  });

  async function request(url, options={}) {
    const response = await fetch(url, options);
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.detail || data.error || data.message || `请求失败（${response.status}）`);
    return data;
  }
  function apiPath(status=state.status, q=state.q) {
    const query = new URLSearchParams({project_id:projectId});
    if (status !== 'all') query.set('status', status);
    if (q) query.set('q', q);
    return `/api/studio/assets?${query}`;
  }
  async function loadItems() {
    if (!projectId || state.busy) return;
    list.classList.add('busy');
    try {
      const result = await request(apiPath());
      state.items = Array.isArray(result.items) ? result.items.filter(item => item.project_id === projectId) : [];
      if (state.status === 'all' && !state.q) {state.allItems=state.items;state.allItemsReady=true;}
      render();
    } catch(error) {
      showNotice(`读取项目资产失败：${error.message}`, true);
      if (!state.items.length) emptyState('暂时无法读取资产', '请检查服务连接后重试。已有文件不会因此改变。');
    } finally { list.classList.remove('busy'); }
  }
  function render() {
    clearNotice();
    list.replaceChildren();
    $('countLabel').textContent = `${state.items.length} 项`;
    if (!state.items.length) {
      const copy = state.status === 'candidate' ? ['还没有候选素材','导入图片、视频或音频后，素材会作为候选保存在项目中。']
        : state.status === 'confirmed' ? ['还没有正式资产','确认候选素材后，它会出现在这里，并保留版本和来源。']
        : state.status === 'archived' ? ['没有已归档素材','已归档的正式资产版本会显示在这里。']
        : ['项目资产还是空的','导入文件或登记一个素材链接，开始整理项目资产。'];
      emptyState(copy[0], copy[1]); return;
    }
    state.items.forEach(item => list.append(makeCard(item)));
  }
  function makeCard(item) {
    const card = document.createElement('article'); card.className = 'asset-card';
    const thumb = document.createElement('div'); thumb.className = 'thumb'; thumb.title = '预览素材'; thumb.addEventListener('click', () => preview(item));
    const mediaUrl = safeMediaUrl(item.url);
    if (mediaUrl && !item.missing && item.kind === 'image') {const image = document.createElement('img'); image.src = mediaUrl; image.alt = item.name || '资产预览'; image.loading = 'lazy'; image.onerror = () => {image.remove(); fileMark(thumb,item.kind);}; thumb.append(image);}
    else if (mediaUrl && !item.missing && item.kind === 'video') {const video = document.createElement('video'); video.src = mediaUrl; video.muted = true; video.preload = 'metadata'; thumb.append(video);}
    else fileMark(thumb, item.kind);
    const status = document.createElement('span'); status.className = 'status-pill'; status.textContent = labels[item.status] || item.status || '素材'; thumb.append(status);
    if (item.missing) {const missing = document.createElement('span'); missing.className = 'missing-mark'; missing.textContent = '文件缺失'; thumb.append(missing);}
    const content = document.createElement('div'); content.className = 'card-content';
    const nameRow = document.createElement('div'); nameRow.className = 'name-row';
    const name = document.createElement('div'); name.className = 'asset-name'; name.textContent = item.name || '未命名素材'; nameRow.append(name);
    const kind = document.createElement('span'); kind.className = 'kind-label'; kind.textContent = kindLabels[item.category] || kindLabels[item.kind] || item.category || '素材'; nameRow.append(kind); content.append(nameRow);
    const meta = document.createElement('div'); meta.className = 'meta-line';
    const date = document.createElement('span'); date.textContent = formatDate(item.created_at); meta.append(date);
    const source = document.createElement('span'); source.textContent = formatSource(item.source, item.source_url); source.title = sourceDetail(item.source, item.source_url); meta.append(source); content.append(meta);
    const actions = document.createElement('div'); actions.className = 'card-actions';
    const previewBtn = action('预览', 'preview'); previewBtn.addEventListener('click', () => preview(item)); actions.append(previewBtn);
    if (item.status === 'candidate') {const confirmBtn = action('确认', 'accent'); confirmBtn.addEventListener('click', () => openConfirm(item)); actions.append(confirmBtn);}
    if (item.asset_id) {const versions = action(`版本${countVersions(item) > 1 ? ` · ${countVersions(item)}` : ''}`, ''); versions.addEventListener('click', () => showVersions(item)); actions.append(versions);}
    if (!item.missing) {const folder = action('文件夹',''); folder.addEventListener('click', () => openFolder(item)); actions.append(folder);}
    if (item.status === 'confirmed') {const archive = action('归档','danger'); archive.addEventListener('click', () => archiveItem(item)); actions.append(archive);}
    const add = action(embedded ? '加入画布' : '打开画布', '');
    if (embedded) add.addEventListener('click', () => addToCanvas(item));
    else add.addEventListener('click', () => window.open(`/static/canvas-list.html?project=${encodeURIComponent(projectId)}`, '_blank', 'noopener'));
    actions.append(add); content.append(actions); card.append(thumb, content); return card;
  }
  function fileMark(host, kind) {const mark = document.createElement('span'); mark.className='file-mark'; mark.textContent = ({image:'▧',video:'▷',audio:'♫',text:'¶'})[kind] || '◇'; host.append(mark);}
  function action(text, style) {const button = document.createElement('button'); button.type='button'; button.className=`small-button ${style || ''}`; button.textContent=text; return button;}
  function emptyState(title, body) {
    list.replaceChildren(); const wrap=document.createElement('div'); wrap.className='empty'; const icon=document.createElement('div'); icon.className='empty-icon'; icon.textContent='◇';
    const heading=document.createElement('h2'); heading.textContent=title; const desc=document.createElement('p'); desc.textContent=body; wrap.append(icon,heading,desc);
    if(projectId && state.status !== 'confirmed') {const button=document.createElement('button'); button.type='button'; button.className='button primary'; button.textContent='导入文件'; button.addEventListener('click',()=> $('fileInput').click()); wrap.append(button);}
    list.append(wrap);
  }
  async function importFiles(event) {
    const files = [...(event.target.files || [])]; event.target.value=''; if (!files.length) return;
    state.busy=true; list.classList.add('busy');
    let succeeded=0; const failures=[];
    for (const file of files) {
      const form = new FormData(); form.append('file', file); form.append('project_id', projectId);
      try {await request('/api/studio/assets/import', {method:'POST',body:form}); succeeded++;}
      catch(error) {failures.push(`${file.name}：${error.message}`);}
    }
    state.busy=false; list.classList.remove('busy'); await refreshItems();
    if (failures.length) showNotice(`${succeeded ? `已导入 ${succeeded} 项。` : ''}${failures.slice(0,3).join('；')}${failures.length>3?`；另有 ${failures.length-3} 项失败`:''}`, true);
    else showNotice(`已导入 ${succeeded} 项，作为候选素材保存在项目中。`);
  }
  async function registerUrl() {
    const url = window.prompt('粘贴可访问的素材链接'); if (!url) return;
    let parsed; try {parsed=new URL(url);} catch (_) {showNotice('链接格式无效。', true);return;}
    if (!['http:','https:'].includes(parsed.protocol)) {showNotice('仅支持 http 或 https 链接。',true);return;}
    const name = window.prompt('素材名称', decodeURIComponent(parsed.pathname.split('/').pop() || '链接素材')) || '';
    try {await request('/api/studio/assets/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,name,project_id:projectId,source:'link'})}); await refreshItems(); showNotice('链接已登记为候选素材。');}
    catch(error) {showNotice(`登记失败：${error.message}`,true);}
  }
  async function openConfirm(item) {
    state.confirming=item; $('confirmName').value=item.name || '';
    $('confirmSubtitle').textContent=`确认“${item.name || '未命名素材'}”并保留来源文件`;
    const select=$('confirmAsset'); select.replaceChildren(); const fresh=document.createElement('option');fresh.value='';fresh.textContent='新建资产';select.append(fresh);
    let items; try {items=await getAllItems(true);} catch(error) {showNotice(`读取正式资产列表失败：${error.message}`,true);return;}
    const seen=new Set(); items.filter(row=>row.status==='confirmed' && row.asset_id).forEach(row=>{
      if(seen.has(row.asset_id)) return; seen.add(row.asset_id); const option=document.createElement('option');option.value=row.asset_id;option.textContent=`${row.name || '未命名资产'} · ${row.asset_id}`;select.append(option);
    });
    $('confirmDialog').showModal();
  }
  async function confirmCandidate(event) {
    event.preventDefault(); const item=state.confirming; if(!item) return;
    const body={name:$('confirmName').value.trim(),category:$('confirmCategory').value}; const assetId=$('confirmAsset').value; if(assetId) body.asset_id=assetId;
    if(!body.name) {showNotice('请填写资产名称。',true);return;}
    const submit=$('confirmSubmit'); submit.disabled=true;
    try {await request(`/api/studio/assets/${encodeURIComponent(item.version_id)}/confirm`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});$('confirmDialog').close();state.confirming=null;await refreshItems();showNotice(assetId?'已将素材添加为现有资产的新版本。':'已确认并建立正式资产。');}
    catch(error) {showNotice(`确认失败：${error.message}`,true);}
    finally {submit.disabled=false;}
  }
  async function archiveItem(item) {
    if(!window.confirm(`归档“${item.name || '未命名素材'}”？此操作会保留项目文件。`)) return;
    try {await request(`/api/studio/assets/${encodeURIComponent(item.version_id)}/archive`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await refreshItems();showNotice('素材已归档，文件仍保留在项目中。');}
    catch(error) {showNotice(`归档失败：${error.message}`,true);}
  }
  async function openFolder(item) {
    try {await request(`/api/studio/assets/${encodeURIComponent(item.version_id)}/open-folder`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});showNotice('已请求打开该素材所在文件夹。');}
    catch(error) {showNotice(`无法打开文件夹：${error.message}`,true);}
  }
  async function repairFiles() {
    const button=$('repairBtn'); button.disabled=true; button.textContent='正在检查…';
    try {const result=await request('/api/studio/assets/repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:projectId})});await refreshItems();const items=Array.isArray(result.items)?result.items:[];const missing=items.filter(item=>item.missing).length;const changed=Number(result.changed || 0);showNotice(`检查完成：更新 ${changed} 条记录，缺失 ${missing} 项。`);}
    catch(error) {showNotice(`文件检查失败：${error.message}`,true);}
    finally {button.disabled=false;button.textContent='检查文件';}
  }
  function preview(item) {
    $('previewTitle').textContent=item.name || '素材预览'; $('previewMeta').textContent=[kindLabels[item.kind] || item.kind,formatDate(item.created_at),item.sha256 ? `SHA-256 ${item.sha256.slice(0,12)}…` : ''].filter(Boolean).join(' · ');
    const body=$('previewBody');body.replaceChildren(); const url=safeMediaUrl(item.url);
    if(item.missing || !url) {const message=document.createElement('p');message.className='preview-text';message.textContent=item.missing?'此素材文件缺失，可使用“检查文件”尝试修复。':'没有可预览的文件地址。';body.append(message);$('previewOpen').hidden=true;}
    else {$('previewOpen').hidden=false;$('previewOpen').href=url;
      if(item.kind==='image') {const image=document.createElement('img');image.src=url;image.alt=item.name || '';body.append(image);}
      else if(item.kind==='video') {const video=document.createElement('video');video.src=url;video.controls=true;video.autoplay=false;body.append(video);}
      else if(item.kind==='audio') {const audio=document.createElement('audio');audio.src=url;audio.controls=true;body.append(audio);}
      else {const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';link.className='preview-text';link.textContent='打开素材文件';body.append(link);}
    }
    showDialog($('previewDialog'));
  }
  async function showVersions(item) {
    let items; try {items=await getAllItems(true);} catch(error) {showNotice(`读取资产版本失败：${error.message}`,true);return;}
    const versions=items.filter(row=>row.asset_id===item.asset_id).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    const body=$('previewBody');body.replaceChildren();const wrap=document.createElement('div');wrap.className='preview-text';
    const title=document.createElement('div');title.textContent=`${item.name || '正式资产'} · ${versions.length} 个版本`;title.style.cssText='font-weight:700;margin-bottom:12px';wrap.append(title);
    versions.forEach((row,index)=>{const line=document.createElement('div');line.style.cssText='padding:9px 0;border-top:1px solid #2c2d2f;display:flex;justify-content:space-between;gap:10px';const label=document.createElement('span');label.textContent=`${index===0?'当前/最近版本':'版本'} · ${row.name || '未命名'} · ${formatDate(row.created_at)}`;const status=document.createElement('span');status.textContent=labels[row.status] || row.status;line.append(label,status);line.addEventListener('click',()=>preview(row));line.style.cursor='pointer';wrap.append(line);});body.append(wrap);$('previewTitle').textContent='资产版本';$('previewMeta').textContent=`资产 ${item.asset_id}`;$('previewOpen').hidden=true;showDialog($('previewDialog'));
  }
  function countVersions(item) {return state.allItemsReady ? state.allItems.filter(row=>row.asset_id===item.asset_id).length : 0;}
  function addToCanvas(item) {
    if(!item.url || item.missing) {showNotice('这个素材暂时没有可用文件，无法加入画布。',true);return;}
    window.parent.postMessage({type:'studio-assets:add-to-canvas',project_id:projectId,item:{version_id:item.version_id,asset_id:item.asset_id || null,project_id:item.project_id,name:item.name || '项目资产',kind:item.kind,url:item.url}},location.origin);
  }
  function closePanel() {if(embedded) window.parent.postMessage({type:'studio-assets:close'},location.origin);else history.length>1?history.back():location.assign(`/static/canvas-list.html?project=${encodeURIComponent(projectId)}`);}
  function safeMediaUrl(value) {
    if(!value) return '';
    try {const url=new URL(value,location.origin);if(url.origin!==location.origin && !['http:','https:'].includes(url.protocol)) return '';return url.href;} catch (_) {return '';}
  }
  function formatDate(value) {if(!value) return '日期未知';const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});}
  async function getAllItems(force=false) {
    if(state.allItemsReady && !force) return state.allItems;
    const query=new URLSearchParams({project_id:projectId});
    const result=await request(`/api/studio/assets?${query}`);
    state.allItems=Array.isArray(result.items)?result.items.filter(item=>item.project_id===projectId):[];
    state.allItemsReady=true;
    return state.allItems;
  }
  async function refreshItems() {state.allItemsReady=false;return loadItems();}
  function formatSource(source, sourceUrl) {
    if(!source) return sourceUrl ? '外部链接' : '项目文件';
    if(typeof source==='string') return ({generated:'生成结果',import:'导入文件',imported:'导入文件',derived:'派生版本',link:'外部链接',upload:'上传文件'})[source] || source;
    if(typeof source!=='object') return String(source);
    const type=source.type || source.source || '项目素材';
    const typeLabel=({generated:'生成结果',generation:'生成结果',import:'导入文件',imported:'导入文件',derived:'派生版本',link:'外部链接',upload:'上传文件'})[type] || type;
    return source.model ? `${typeLabel} · ${source.model}` : typeLabel;
  }
  function sourceDetail(source, sourceUrl) {
    if(!source || typeof source!=='object') return typeof source==='string' ? source : (sourceUrl || '项目文件');
    return [formatSource(source,sourceUrl),source.job_id ? `任务 ${source.job_id}` : '',source.url || ''].filter(Boolean).join(' · ');
  }
  function showDialog(dialog) {if(!dialog.open) dialog.showModal();}
  function showNotice(message,error=false) {notice.textContent=message;notice.classList.toggle('error',error);notice.hidden=false;}
  function clearNotice() {notice.hidden=true;notice.textContent='';notice.classList.remove('error');}
  function debounce(fn,ms) {let timer;return()=>{clearTimeout(timer);timer=setTimeout(fn,ms);};}
})();
