(() => {
  const $=id=>document.getElementById(id), kinds={chat:'文本',image:'图片',video:'视频',audio:'音频'};
  let providers=[],catalogs={},preview={},current,loading=false,dirty=false,storageDirty=false,defaults={},formRevision=0;
  const fresh=()=>({id:'deepwhite',name:'DeepWhite API',base_url:'https://api.deepwhiteai.com/v1',protocol:'openai',image_request_mode:'openai',enabled:true,primary:true});
  async function api(url,method='GET',body){
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    let data;try{data=await response.json();}catch{throw Error('本地服务返回异常，请稍后重试。');}
    if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'设置未能保存，请检查填写内容。');return data;
  }
  function broadcast(message={type:'providers-changed',updated_at:Date.now()}){if(parent!==window)parent.postMessage(message,location.origin);if(message.type==='providers-changed'){const c=new BroadcastChannel('studio-api');c.postMessage(message);c.close();}}
  function notice(id,text,error=false){$(id).hidden=false;$(id).textContent=text;$(id).dataset.error=error;}
  const managed=()=>current?.id?.startsWith('deepwhite-account-');
  function protectManaged(){if(managed())for(const id of ['providerName','baseUrl','apiKey','showKey','clearKey','enabled','primary','imageMode','saveProvider'])$(id).disabled=true;}
  function lock(value){loading=value;$('apiForm').querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=value);if(!value){$('clearKey').disabled=!current?.has_key;protectManaged();renderModels();}}
  function render(){
    $('providerSelect').replaceChildren();providers.filter(p=>p.protocol==='openai'&&(p.has_key||p.id===current.id||p.primary)).forEach(p=>$('providerSelect').add(new Option(p.name+(p.primary?' · 默认':''),p.id)));
    $('providerSelect').value=current.id;$('providerName').value=current.name;$('baseUrl').value=current.base_url;
    $('apiKey').value='';$('apiKey').type='password';$('showKey').textContent='显示';$('showKey').setAttribute('aria-pressed','false');
    $('apiKey').placeholder=managed()?'由登录账户自动管理':current.has_key?'已保存；留空保留原密钥':'粘贴 API Key';$('keyState').textContent=managed()?(current.has_key?'官方账户已连接 · 授权仅在本次会话使用':'请登录账户以恢复官方生成授权'):current.has_key?'密钥已保存（不会回显完整密钥）':'尚未保存密钥';
    $('clearKey').checked=false;$('clearKey').disabled=!current.has_key;$('enabled').checked=current.enabled!==false;$('primary').checked=!!current.primary;$('imageMode').value=current.image_request_mode||'openai';dirty=false;renderModels();
    for(const id of ['providerName','baseUrl','apiKey','showKey','enabled','primary','imageMode','saveProvider'])$(id).disabled=loading;protectManaged();
    window.dispatchEvent(new CustomEvent('studio-provider-selected'));
  }
  function formPayload(){
    if(!$('apiForm').reportValidity())throw Error('请填写平台名称和有效的 API 地址。');
    if($('clearKey').checked&&$('apiKey').value.trim())throw Error('请取消清除旧密钥后再保存新密钥。');
    return {id:current.id,name:$('providerName').value.trim(),base_url:$('baseUrl').value.trim(),protocol:'openai',image_request_mode:$('imageMode').value,enabled:$('enabled').checked,primary:$('primary').checked,api_key:$('apiKey').value.trim()||undefined,clear_key:$('clearKey').checked};
  }
  function accept(provider){providers=providers.filter(p=>p.id!==provider.id).map(p=>provider.primary?{...p,primary:false}:p);providers.unshift(provider);current=provider;}
  const entries=()=>catalogs[current?.id]?.models?.length?catalogs[current.id].models:current?.base_url?.includes('api.deepwhiteai.com')?(preview.models||[]):[];
  function visible(){const q=$('modelSearch').value.toLowerCase(),kind=$('modelFilter').value;return entries().filter(m=>kinds[m.kind]&&($('showRemoved').checked||!m.removed)&&(!kind||m.kind===kind)&&`${m.name} ${m.vendor}`.toLowerCase().includes(q));}
  function renderModels(){
    $('modelRows').replaceChildren();const all=entries().filter(m=>kinds[m.kind]);$('modelCount').textContent=all.some(m=>m.preview)?'模型示例 · 尚未连接':`${all.filter(m=>m.enabled&&!m.removed&&m.available).length} 个已启用 / ${all.length} 个模型`;
    for(const model of visible()){
      const row=document.createElement('div');row.className='model-row';row.dataset.modelId=model.id;
      const label=document.createElement('label');label.className='check';const check=document.createElement('input');check.type='checkbox';check.checked=model.enabled&&!model.removed;check.disabled=loading||model.removed||!model.available;check.setAttribute('aria-label',`启用 ${model.name}`);check.onchange=()=>preferences([{id:model.id,enabled:check.checked,removed:false}]);
      const name=document.createElement('span');name.textContent=model.name;const detail=document.createElement('small');detail.textContent=`${kinds[model.kind]} · ${model.vendor} · ${model.preview?'登录或连接 API 后自动配置':model.available?(model.capabilities||[]).join(' / '):'上游暂不可用'}`;
      const text=document.createElement('span');text.className='model-description';text.append(name,detail);label.append(check,text);
      const remove=document.createElement('button');remove.type='button';remove.textContent=model.preview?'未连接':model.removed?'恢复':'移除';remove.disabled=loading||!!model.preview;remove.setAttribute('aria-label',`${remove.textContent} ${model.name}`);remove.onclick=()=>preferences([{id:model.id,enabled:model.removed?true:model.enabled,removed:!model.removed}]);row.append(label,remove);$('modelRows').append(row);
    }
    if(!visible().length)$('modelRows').textContent=all.length?'没有匹配的模型。':'保存有效的 API 连接后，会自动读取并配置模型。';
  }
  async function preferences(changes){if(loading||!changes.length)return;try{lock(true);const data=await api(`/api/studio/model-catalog/${encodeURIComponent(current.id)}`,'PATCH',{models:changes});catalogs[current.id]={...catalogs[current.id],models:data.models};accept(data.provider);notice('pickerResult','已保存，画布模型列表已更新。');broadcast();}catch(e){notice('pickerResult',e.message,true);}finally{lock(false);}}
  $('modelSearch').oninput=renderModels;$('modelFilter').onchange=renderModels;$('showRemoved').onchange=renderModels;
  $('enableVisible').onclick=()=>preferences(visible().filter(m=>m.available&&!m.removed).map(m=>({id:m.id,enabled:true,removed:false})));
  $('disableVisible').onclick=()=>preferences(visible().filter(m=>!m.removed&&!m.preview).map(m=>({id:m.id,enabled:false,removed:false})));
  $('testConnection').onclick=async()=>{if(loading)return;try{const p=formPayload();if(p.clear_key)throw Error('已选择清除密钥，请先取消再测试。');lock(true);notice('apiResult','正在检查连接…');const data=await api('/api/studio/settings/test','POST',{base_url:p.base_url,api_key:p.api_key||'',provider_id:p.id});notice('apiResult',data.message);window.dispatchEvent(new CustomEvent('studio-provider-probed'));}catch(e){notice('apiResult',e.message,true);}finally{lock(false);}};
  $('fetchModels').onclick=async()=>{if(loading)return;if(managed()){await reconnect();return;}try{const p=formPayload();if(p.clear_key)throw Error('请取消清除密钥后再同步模型。');lock(true);notice('apiResult','正在同步并自动整理模型…');const data=await api('/api/studio/settings/sync-models','POST',p);catalogs[p.id]={base_url:p.base_url,models:data.models};accept(data.provider);render();notice('apiResult',data.message);$('saveState').textContent='模型和连接设置已自动保存。';broadcast();}catch(e){notice('apiResult',e.message,true);}finally{lock(false);}};
  $('apiForm').onsubmit=async event=>{event.preventDefault();if(loading||managed())return;try{const p=formPayload();lock(true);$('saveState').textContent='正在保存并自动同步模型…';const data=await api('/api/studio/settings/provider','PUT',p);if(data.models)catalogs[p.id]={base_url:p.base_url,models:data.models};accept(data.provider);render();$('saveState').textContent='连接设置已保存。'+(data.sync?.status==='ready'?'模型已自动配置。':data.sync?.message||'');if(data.sync?.status==='retryable')notice('apiResult','模型同步未完成：'+data.sync.message+' 点击「同步模型」可重试。',true);broadcast();}catch(e){$('saveState').textContent=e.message;}finally{lock(false);}};
  $('showKey').onclick=()=>{const show=$('apiKey').type==='password';$('apiKey').type=show?'text':'password';$('showKey').textContent=show?'隐藏':'显示';$('showKey').setAttribute('aria-pressed',String(show));};
  $('apiForm').addEventListener('input',event=>{formRevision++;if(event.target.id!=='providerSelect'&&!event.target.closest('#modelManager')){dirty=true;$('saveState').textContent='有未保存的连接设置';}});
  $('providerSelect').onchange=()=>{if(dirty&&!confirm('连接设置还未保存，放弃修改并切换平台？')){$('providerSelect').value=current.id;return;}current=providers.find(p=>p.id===$('providerSelect').value);render();$('saveState').textContent='';};
  $('addProvider').onclick=()=>{if(dirty&&!confirm('连接设置还未保存，放弃修改并添加平台？'))return;current={...fresh(),id:`studio-${crypto.randomUUID().slice(0,8)}`,name:'新 API 平台',base_url:'',primary:false};providers.push(current);render();dirty=true;};
  document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));$('apiPanel').hidden=button.dataset.tab!=='api';$('generalPanel').hidden=button.dataset.tab!=='general';});
  $('theme').value=window.StudioTheme.get();$('theme').onchange=()=>{window.StudioTheme.set($('theme').value);broadcast({type:'studio-theme',theme:$('theme').value});};
  const storageFields={upload:'storageUpload',generated:'storageGenerated',local:'storageLocal'};
  $('storageForm').oninput=()=>storageDirty=true;$('defaultStorage').onclick=()=>{for(const[key,id]of Object.entries(storageFields))$(id).value=defaults[key]||'';storageDirty=true;$('storageState').textContent='已填入默认值，点击保存目录生效。';};
  $('storageForm').onsubmit=async event=>{event.preventDefault();$('saveStorage').disabled=true;try{await api('/api/storage-settings','PATCH',Object.fromEntries(Object.entries(storageFields).map(([key,id])=>[key,$(id).value.trim()])));storageDirty=false;$('storageState').textContent='目录已保存；已有文件未移动。';}catch(e){$('storageState').textContent=e.message;}finally{$('saveStorage').disabled=false;}};
  window.studioCanClose=()=>!loading&&(!(dirty||storageDirty)||confirm('有未保存的连接设置，放弃修改并返回画布？'));
  window.StudioSettingsFormState=()=>({dirty,loading,storageDirty});
  $('closeSettings').onclick=()=>{if(parent!==window)parent.postMessage({type:'studio-settings-close'},location.origin);else if(window.studioCanClose())location.href='/';};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();$('closeSettings').click();}});
  window.addEventListener('beforeunload',e=>{if(dirty||storageDirty||loading){e.preventDefault();e.returnValue='';}});
  const accountCard=document.createElement('section');accountCard.className='settings-feature-card';accountCard.id='settingsAccountConnection';accountCard.setAttribute('aria-live','polite');$('apiForm').before(accountCard);
  async function refreshAccountCard(){let account;try{account=await api('/api/studio/account');}catch{}accountCard.replaceChildren();const title=document.createElement('h2');title.textContent=account?'已登录 · '+account.username:'登录后自动连接官方 API';const detail=document.createElement('p');detail.textContent=account?.generation?.message||'使用 API 网站的同一账户登录，自动准备此账户的生成授权和模型。也可以在下方添加自己的 API 平台。';const action=document.createElement('button');action.type='button';action.textContent=account?'重新连接 / 刷新模型':'登录 / 注册';action.onclick=account?reconnect:()=>{if(parent!==window&&parent.StudioAccount)parent.StudioAccount.open();else{location.href='/?studio-account=1';}};accountCard.append(title,detail,action);}
  async function loadProviders(preferred,{background=false}={}){const revision=formRevision,selected=current?.id;const[data,catalog]=await Promise.all([api('/api/providers'),api('/api/studio/model-catalog')]);if(background&&(dirty||storageDirty||loading||revision!==formRevision||selected!==current?.id))return;providers=data.providers;catalogs=catalog.providers;preview=catalog.preview||{};current=providers.find(p=>p.id===preferred)||providers.find(p=>p.id.startsWith('deepwhite-account-')&&p.has_key)||providers.find(p=>p.protocol==='openai'&&p.base_url?.includes('api.deepwhiteai.com')&&!p.id.startsWith('deepwhite-account-'));if(!current){current=fresh();if(providers.some(p=>p.id===current.id))current.id+='-'+crypto.randomUUID().slice(0,8);providers.unshift(current);}render();}
  async function reconnect(){if(loading)return;lock(true);notice('apiResult','正在连接账户生成授权并同步模型…');try{const result=await api('/api/studio/account/provision','POST');await loadProviders(result.generation.provider_id);notice('apiResult',result.generation.message,result.generation.status!=='ready');broadcast();await refreshAccountCard();}catch(error){notice('apiResult',error.message,true);}finally{lock(false);}}
  try{const channel=new BroadcastChannel('studio-api');channel.onmessage=async()=>{await refreshAccountCard();if(!dirty&&!storageDirty&&!loading)await loadProviders(undefined,{background:true}).catch(()=>{});};}catch{}
  async function init(){
    try{await loadProviders();$('apiForm').inert=false;}catch(e){notice('loadError',e.message+' 刷新页面可重试。',true);$('apiForm').hidden=true;}
    await refreshAccountCard();
    try{const data=await api('/api/storage-settings');defaults=data.defaults;for(const[key,id]of Object.entries(storageFields))$(id).value=data.dirs[key];}catch(e){$('storageState').textContent=e.message;$('saveStorage').disabled=true;}
    try{const info=await api('/api/studio/health');$('version').textContent=`DeepWhite Studio · ${info.version}`;}catch{}
  }
  init();
})();
