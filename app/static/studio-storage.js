/* Project destinations are server-owned; the browser never reads arbitrary local files. */
(() => {
  'use strict';
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-storage.css?v=0.7.0-channels-storage.2';document.head.append(css);
  let state=null,busy=false;
  const panel=document.createElement('section');panel.className='studio-storage-panel';panel.id='studioProjectStorage';
  panel.innerHTML=`<header><div><h2>本地项目存储</h2><p>生成结果自动保存到项目目录，删除画布节点不会删除文件。</p></div></header>
    <label>新项目默认保存位置<div class="studio-storage-path"><input id="studioStorageDefault" type="text" spellcheck="false" placeholder="填写本机绝对路径，例如 D:\\DeepWhite项目"><button type="button" data-pick="studioStorageDefault">选择文件夹</button></div></label>
    <div class="studio-storage-actions"><button type="button" id="studioStorageSaveDefault">保存默认位置</button><small>已有项目保持原位置。</small></div>
    <hr><label>当前项目<select id="studioStorageProject"></select></label>
    <label>项目保存目录<div class="studio-storage-path"><input id="studioStoragePath" type="text" spellcheck="false"><button type="button" data-pick="studioStoragePath">选择文件夹</button></div></label>
    <p id="studioStorageCurrent"></p>
    <div class="studio-storage-actions"><button type="button" id="studioStorageApply">保存 / 迁移到此目录</button><button type="button" id="studioStorageOpen">打开当前目录</button><button type="button" id="studioStorageRefresh">刷新</button></div>
    <p class="studio-storage-help">更换位置会复制并校验项目素材，成功后切换引用。原文件保留；请留出足够磁盘空间，并等待正在运行的任务结束。</p>
    <p id="studioStorageNotice" role="status" aria-live="polite"></p>`;
  const general=document.getElementById('generalPanel');
  if(general){const legacy=document.getElementById('storageForm');(legacy?.closest('details')||legacy)?.before(panel);if(!panel.isConnected)general.append(panel);}
  else if(document.getElementById('assetList')){const details=document.createElement('details');details.className='studio-storage-disclosure';const title=document.createElement('summary');title.textContent='项目保存位置';details.append(title,panel);document.querySelector('.toolbar').after(details);details.addEventListener('toggle',()=>{if(details.open&&!state)load();});}
  else return;
  const $=id=>panel.querySelector('#'+id),project=()=>$('studioStorageProject').value;
  function notice(message,error=false){$('studioStorageNotice').textContent=message;$('studioStorageNotice').dataset.error=String(error);}
  async function api(path,method='GET',body){const r=await fetch('/api/studio/storage'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});let d;try{d=await r.json();}catch{throw Error('存储服务暂时无法读取，请刷新重试。');}if(!r.ok)throw Error(typeof d.detail==='string'?d.detail:'保存设置失败，请检查路径与权限。');return d;}
  async function action(fn){if(busy)return false;busy=true;panel.querySelectorAll('button,input,select').forEach(x=>x.disabled=true);try{await fn();return true;}catch(e){notice(e.message,true);return false;}finally{busy=false;panel.querySelectorAll('button,input,select').forEach(x=>x.disabled=false);if(!project())$('studioStorageApply').disabled=$('studioStorageOpen').disabled=true;}}
  function renderProject(){const p=state?.projects.find(x=>x.project_id===project());$('studioStoragePath').value=p?.path||'';$('studioStorageCurrent').textContent=p?`当前：${p.path} · ${p.managed_versions||0} 个素材版本`:'尚无可设置的项目';}
  async function load(){const previous=project()||new URLSearchParams(location.search).get('project_id');state=await api('');$('studioStorageDefault').value=state.default_root||'';$('studioStorageProject').replaceChildren();for(const p of state.projects||[])$('studioStorageProject').add(new Option(p.name||p.project_id,p.project_id));if(state.projects.some(p=>p.project_id===previous))$('studioStorageProject').value=previous;renderProject();}
  $('studioStorageProject').onchange=renderProject;
  $('studioStorageSaveDefault').onclick=()=>action(async()=>{await api('','PUT',{default_root:$('studioStorageDefault').value.trim()});await load();notice('默认位置已保存，已有项目未移动。');});
  $('studioStorageApply').onclick=()=>action(async()=>{const path=$('studioStoragePath').value.trim();if(!path)throw Error('请先填写项目保存目录。');notice('正在复制并校验素材，请保持窗口打开…');await api('/projects/'+encodeURIComponent(project()),'PUT',{path,migrate:true});await load();notice('项目保存位置已更新，原文件保留。');});
  $('studioStorageOpen').onclick=()=>action(async()=>{await api('/projects/'+encodeURIComponent(project())+'/open','POST',{});notice('已打开当前项目目录。');});
  $('studioStorageRefresh').onclick=()=>action(async()=>{await load();notice('已刷新保存位置。');});
  panel.querySelectorAll('[data-pick]').forEach(button=>button.onclick=async()=>{
    if(busy||button.disabled)return;
    const input=$(button.dataset.pick),previous=input.value,targetProject=project();
    button.disabled=true;notice('正在打开系统文件夹选择窗口…');
    try{
      const data=await api('/pick-folder','POST',{path:previous.trim()});
      if(!data.path){input.value=previous;notice('已取消选择，保存位置未更改。');return;}
      input.value=data.path;
      if(input.id==='studioStorageDefault'){
        if(!await action(async()=>{await api('','PUT',{default_root:data.path});await load();notice('已选择并保存新项目默认位置。已有项目未移动。');}))input.value=previous;
        return;
      }
      const selected=state?.projects.find(x=>x.project_id===targetProject);
      if((selected?.managed_versions||0)>0&&!window.confirm(`此项目已有 ${selected.managed_versions} 个素材版本。要复制并校验这些素材到新目录吗？迁移成功后原文件会完整保留。`)){
        input.value=previous;notice('已取消更改，原保存位置未变。');return;
      }
      if(!await action(async()=>{
        if((selected?.managed_versions||0)>0)notice(`正在迁移 ${selected.managed_versions} 个素材版本。请等待复制和校验完成；原文件会保留。`);
        else notice('正在保存项目目录…');
        await api('/projects/'+encodeURIComponent(targetProject),'PUT',{path:data.path,migrate:true});
        await load();notice((selected?.managed_versions||0)>0?'素材迁移完成，新目录已生效，原文件保留。':'项目目录已保存。');
      }))input.value=previous;
    }catch(e){input.value=previous;notice(e.message,true);}
    finally{button.disabled=false;}
  });
  action(load);
})();
