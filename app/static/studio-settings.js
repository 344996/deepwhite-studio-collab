(() => {
  const $=id=>document.getElementById(id), kinds={chat:'文本',image:'图片',video:'视频',audio:'音频'};
  let providers=[],catalogs={},current,loading=false,dirty=false,storageDirty=false,defaults={};
  const fresh=()=>({id:'deepwhite',name:'DeepWhite API',base_url:'https://api.deepwhiteai.com/v1',protocol:'openai',image_request_mode:'openai',enabled:true,primary:true});
  async function api(url,method='GET',body){
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    let data;try{data=await response.json();}catch{throw Error('本地服务返回异常，请稍后重试。');}
    if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'设置未能保存，请检查填写内容。');return data;
  }
  function broadcast(message={type:'providers-changed',updated_at:Date.now()}){if(parent!==window)parent.postMessage(message,location.origin);if(message.type==='providers-changed'){const c=new BroadcastChannel('studio-api');c.postMessage(message);c.close();}}
  function notice(id,text,error=false){$(id).hidden=false;$(id).textContent=text;$(id).dataset.error=error;}
  function lock(value){loading=value;$('apiForm').querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=value);if(!value){$('clearKey').disabled=!current?.has_key;renderModels();}}
  function render(){
    $('providerSelect').replaceChildren();providers.filter(p=>p.protocol==='openai'&&(p.has_key||p.id===current.id||p.primary)).forEach(p=>$('providerSelect').add(new Option(p.name+(p.primary?' · 默认':''),p.id)));
    $('providerSelect').value=current.id;$('providerName').value=current.name;$('baseUrl').value=current.base_url;
    $('apiKey').value='';$('apiKey').type='password';$('showKey').textContent='显示';$('showKey').setAttribute('aria-pressed','false');
    $('apiKey').placeholder=current.has_key?'已保存；留空保留原密钥':'粘贴 API Key';$('keyState').textContent=current.has_key?'密钥已保存（不会回显完整密钥）':'尚未保存密钥';
    $('clearKey').checked=false;$('clearKey').disabled=!current.has_key;$('enabled').checked=current.enabled!==false;$('primary').checked=!!current.primary;$('imageMode').value=current.image_request_mode||'openai';dirty=false;renderModels();
    window.dispatchEvent(new CustomEvent('studio-provider-selected'));
  }
  function formPayload(){
    if(!$('apiForm').reportValidity())throw Error('请填写平台名称和有效的 API 地址。');
    if($('clearKey').checked&&$('apiKey').value.trim())throw Error('请取消清除旧密钥后再保存新密钥。');
    return {id:current.id,name:$('providerName').value.trim(),base_url:$('baseUrl').value.trim(),protocol:'openai',image_request_mode:$('imageMode').value,enabled:$('enabled').checked,primary:$('primary').checked,api_key:$('apiKey').value.trim()||undefined,clear_key:$('clearKey').checked};
  }
  function accept(provider){providers=providers.filter(p=>p.id!==provider.id).map(p=>provider.primary?{...p,primary:false}:p);providers.unshift(provider);current=provider;}
  const entries=()=>catalogs[current?.id]?.models||[];
  function visible(){const q=$('modelSearch').value.toLowerCase(),kind=$('modelFilter').value;return entries().filter(m=>kinds[m.kind]&&($('showRemoved').checked||!m.removed)&&(!kind||m.kind===kind)&&`${m.name} ${m.vendor}`.toLowerCase().includes(q));}
  function renderModels(){
    $('modelRows').replaceChildren();const all=entries().filter(m=>kinds[m.kind]);$('modelCount').textContent=`${all.filter(m=>m.enabled&&!m.removed&&m.available).length} 个已启用 / ${all.length} 个模型`;
    for(const model of visible()){
      const row=document.createElement('div');row.className='model-row';row.dataset.modelId=model.id;
      const label=document.createElement('label');label.className='check';const check=document.createElement('input');check.type='checkbox';check.checked=model.enabled&&!model.removed;check.disabled=loading||model.removed||!model.available;check.setAttribute('aria-label',`启用 ${model.name}`);check.onchange=()=>preferences([{id:model.id,enabled:check.checked,removed:false}]);
      const name=document.createElement('span');name.textContent=model.name;const detail=document.createElement('small');detail.textContent=`${kinds[model.kind]} · ${model.vendor} · ${model.available?(model.capabilities||[]).join(' / '):'上游暂不可用'}`;
      const text=document.createElement('span');text.className='model-description';text.append(name,detail);label.append(check,text);
      const remove=document.createElement('button');remove.type='button';remove.textContent=model.removed?'恢复':'移除';remove.disabled=loading;remove.setAttribute('aria-label',`${remove.textContent} ${model.name}`);remove.onclick=()=>preferences([{id:model.id,enabled:model.removed?true:model.enabled,removed:!model.removed}]);row.append(label,remove);$('modelRows').append(row);
    }
    if(!visible().length)$('modelRows').textContent=all.length?'没有匹配的模型。':'尚未同步模型，点击上方「同步模型」即可自动添加。';
  }
  async function preferences(changes){if(loading||!changes.length)return;try{lock(true);const data=await api(`/api/studio/model-catalog/${encodeURIComponent(current.id)}`,'PATCH',{models:changes});catalogs[current.id]={...catalogs[current.id],models:data.models};accept(data.provider);notice('pickerResult','已保存，画布模型列表已更新。');broadcast();}catch(e){notice('pickerResult',e.message,true);}finally{lock(false);}}
  $('modelSearch').oninput=renderModels;$('modelFilter').onchange=renderModels;$('showRemoved').onchange=renderModels;
  $('enableVisible').onclick=()=>preferences(visible().filter(m=>m.available&&!m.removed).map(m=>({id:m.id,enabled:true,removed:false})));
  $('disableVisible').onclick=()=>preferences(visible().filter(m=>!m.removed).map(m=>({id:m.id,enabled:false,removed:false})));
  $('testConnection').onclick=async()=>{if(loading)return;try{const p=formPayload();if(p.clear_key)throw Error('已选择清除密钥，请先取消再测试。');lock(true);notice('apiResult','正在检查连接…');const data=await api('/api/studio/settings/test','POST',{base_url:p.base_url,api_key:p.api_key||'',provider_id:p.id});notice('apiResult',data.message);window.dispatchEvent(new CustomEvent('studio-provider-probed'));}catch(e){notice('apiResult',e.message,true);}finally{lock(false);}};
  $('fetchModels').onclick=async()=>{if(loading)return;try{const p=formPayload();if(p.clear_key)throw Error('请取消清除密钥后再同步模型。');lock(true);notice('apiResult','正在同步并自动整理模型…');const data=await api('/api/studio/settings/sync-models','POST',p);catalogs[p.id]={base_url:p.base_url,models:data.models};accept(data.provider);render();notice('apiResult',data.message);$('saveState').textContent='模型和连接设置已自动保存。';broadcast();}catch(e){notice('apiResult',e.message,true);}finally{lock(false);}};
  $('apiForm').onsubmit=async event=>{event.preventDefault();if(loading)return;try{const p=formPayload();lock(true);$('saveState').textContent='正在保存…';const data=await api('/api/studio/settings/provider','PUT',p);accept(data.provider);render();$('saveState').textContent='连接设置已保存。';broadcast();}catch(e){$('saveState').textContent=e.message;}finally{lock(false);}};
  $('showKey').onclick=()=>{const show=$('apiKey').type==='password';$('apiKey').type=show?'text':'password';$('showKey').textContent=show?'隐藏':'显示';$('showKey').setAttribute('aria-pressed',String(show));};
  $('apiForm').addEventListener('input',event=>{if(event.target.id!=='providerSelect'&&!event.target.closest('#modelManager')){dirty=true;$('saveState').textContent='有未保存的连接设置';}});
  $('providerSelect').onchange=()=>{if(dirty&&!confirm('连接设置还未保存，放弃修改并切换平台？')){$('providerSelect').value=current.id;return;}current=providers.find(p=>p.id===$('providerSelect').value);render();$('saveState').textContent='';};
  $('addProvider').onclick=()=>{if(dirty&&!confirm('连接设置还未保存，放弃修改并添加平台？'))return;current={...fresh(),id:`studio-${crypto.randomUUID().slice(0,8)}`,name:'新 API 平台',base_url:'',primary:false};providers.push(current);render();dirty=true;};
  document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));$('apiPanel').hidden=button.dataset.tab!=='api';$('generalPanel').hidden=button.dataset.tab!=='general';});
  $('theme').value=window.StudioTheme.get();$('theme').onchange=()=>{window.StudioTheme.set($('theme').value);broadcast({type:'studio-theme',theme:$('theme').value});};
  const storageFields={upload:'storageUpload',generated:'storageGenerated',local:'storageLocal'};
  $('storageForm').oninput=()=>storageDirty=true;$('defaultStorage').onclick=()=>{for(const[key,id]of Object.entries(storageFields))$(id).value=defaults[key]||'';storageDirty=true;$('storageState').textContent='已填入默认值，点击保存目录生效。';};
  $('storageForm').onsubmit=async event=>{event.preventDefault();$('saveStorage').disabled=true;try{await api('/api/storage-settings','PATCH',Object.fromEntries(Object.entries(storageFields).map(([key,id])=>[key,$(id).value.trim()])));storageDirty=false;$('storageState').textContent='目录已保存；已有文件未移动。';}catch(e){$('storageState').textContent=e.message;}finally{$('saveStorage').disabled=false;}};
  window.studioCanClose=()=>!loading&&(!(dirty||storageDirty)||confirm('有未保存的连接设置，放弃修改并返回画布？'));
  $('closeSettings').onclick=()=>{if(parent!==window)parent.postMessage({type:'studio-settings-close'},location.origin);else if(window.studioCanClose())location.href='/';};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();$('closeSettings').click();}});
  window.addEventListener('beforeunload',e=>{if(dirty||storageDirty||loading){e.preventDefault();e.returnValue='';}});
  async function init(){
    try{const[data,catalog]=await Promise.all([api('/api/providers'),api('/api/studio/model-catalog')]);providers=data.providers;catalogs=catalog.providers;current=providers.find(p=>p.protocol==='openai'&&p.base_url?.includes('api.deepwhiteai.com'));if(!current){current=fresh();if(providers.some(p=>p.id===current.id))current.id+='-'+crypto.randomUUID().slice(0,8);providers.unshift(current);}render();$('apiForm').inert=false;}catch(e){notice('loadError',e.message+' 刷新页面可重试。',true);$('apiForm').hidden=true;}
    try{const data=await api('/api/storage-settings');defaults=data.defaults;for(const[key,id]of Object.entries(storageFields))$(id).value=data.dirs[key];}catch(e){$('storageState').textContent=e.message;$('saveStorage').disabled=true;}
    try{const info=await api('/api/studio/health');$('version').textContent=`DeepWhite Studio · ${info.version}`;}catch{}
  }
  init();
})();
