/* Optional Dreamina CLI channel settings. All OAuth material stays in backend memory. */
(() => {
  const ENDPOINT='/api/studio/dreamina';
  const $=(s,root=document)=>root.querySelector(s);
  const el=(tag,attrs={},text='')=>{const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs))if(k==='class')n.className=v;else n.setAttribute(k,v);n.textContent=text;return n;};
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-dreamina.css?v=0.7.0-channels-storage.2';document.head.append(css);
  const state={status:null,config:null,loginId:null,timer:null,loginBusy:false,loginSeq:0};
  const api=async(path,method='GET',body)=>{const r=await fetch(`${ENDPOINT}${path}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});let data={};try{data=await r.json();}catch{}if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:(data.message||'即梦服务暂不可用。'));return data;};
  function notice(text,error=false){const n=$('#dreaminaNotice');if(!n)return;n.hidden=false;n.dataset.error=String(error);n.textContent=text;}
  function tabPanel(show){$('#apiPanel').hidden=show;$('#generalPanel').hidden=show;if(show&&$('#controlPanel'))$('#controlPanel').hidden=true;$('#dreaminaPanel').hidden=!show;document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab==='dreamina'&&show)));}
  function insertPanel(){
    const nav=document.querySelector('.settings-top nav[aria-label="设置分类"]');if(!nav||$('#dreaminaPanel'))return false;
    const tab=el('button',{'data-tab':'dreamina','aria-selected':'false'},'即梦账号');tab.type='button';tab.addEventListener('click',e=>{e.preventDefault();e.stopImmediatePropagation();tabPanel(true);refresh().catch(err=>notice(err.message,true));},true);nav.append(tab);
    const main=$('main');const panel=el('section',{id:'dreaminaPanel',hidden:'hidden','aria-label':'即梦通道设置'});
    panel.innerHTML=`<div class="dreamina-intro"><div class="eyebrow">第三方生成渠道</div><h1>即梦通道</h1><p>通过本机即梦程序授权后，将已启用模型作为独立生成渠道使用。授权、账号和积分状态单独显示，不会替换默认 API。</p></div>
      <div class="dreamina-card"><div class="dreamina-card-head"><div><h2>连接设置</h2><p>停用只关闭生成通道，账号登录状态会保留。</p></div><span id="dreaminaStatus" class="dreamina-status" data-state="disabled"><i></i><span>检查中…</span></span></div>
        <div class="dreamina-grid"><label>即梦程序路径<input id="dreaminaPath" aria-label="即梦程序路径" placeholder="选择或填写即梦程序的完整路径" autocomplete="off"></label><label>账号状态<input id="dreaminaAccount" aria-label="即梦账号状态" value="未连接" disabled></label></div>
        <div class="dreamina-actions"><label class="dreamina-check"><input id="dreaminaEnabled" type="checkbox" aria-label="启用即梦通道"><span>启用即梦通道</span></label><button id="dreaminaSave" type="button">保存即梦设置</button><button id="dreaminaConnect" class="primary" type="button">重新授权 / 换号</button><button id="dreaminaLogout" type="button">退出账号</button><button id="dreaminaRefresh" type="button">刷新状态</button></div>
        <p class="dreamina-help">重新授权会清除当前本机登录态并启动新的即梦授权；退出账号只清除本机登录态，不删除通道配置或任务。账号授权由本机即梦程序完成。</p><div id="dreaminaNotice" class="dreamina-result" role="status" aria-live="polite" hidden></div><div id="dreaminaLogin" class="dreamina-login" hidden></div>
      </div>
      <div class="dreamina-card"><div class="dreamina-card-head"><div><h2>即梦账号与积分</h2><p>余额只表示账号剩余积分，不代表单次任务费用。</p></div><span class="dreamina-credit" id="dreaminaCredit">积分状态待连接</span></div><div class="dreamina-account"><div><b>账号</b><small id="dreaminaAccountName">未连接</small></div><div><b>单次任务费用</b><small>未知 · 当前 CLI 未提供报价接口</small></div></div></div>
      <div class="dreamina-card"><div class="dreamina-card-head"><div><h2>已启用模型</h2><p>按模型系列查看可用版本。关闭的模型仍保留在已有节点上，但不会默默改用 API。</p></div><button id="dreaminaReloadModels" type="button">重新载入</button></div><div id="dreaminaModels" class="dreamina-model-list"></div></div>`;
    main.append(panel);
    nav.querySelectorAll('[data-tab]:not([data-tab="dreamina"])').forEach(button=>button.addEventListener('click',()=>tabPanel(false),true));
    $('#dreaminaRefresh').onclick=()=>refresh().catch(err=>notice(err.message,true));
    $('#dreaminaReloadModels').onclick=()=>refresh().catch(err=>notice(err.message,true));
    $('#dreaminaSave').onclick=saveConfig;
    $('#dreaminaConnect').onclick=startLogin;
    $('#dreaminaLogout').onclick=logout;
    $('#dreaminaEnabled').onchange=()=>saveConfig(true);
    return true;
  }
  function statusText(){
    const s=state.status||{};const status=$('#dreaminaStatus');if(!status)return;
    const disabled=!s.enabled;const connected=!!s.authenticated;const available=s.available!==false;
    status.dataset.state=disabled?'disabled':!available?'error':connected?'connected':'pending';
    status.lastElementChild.textContent=disabled?(connected?'已停用 · 账号仍登录':'已停用'):!available?'程序不可用':connected?'已连接': '未授权';
    $('#dreaminaAccount').value=connected?(s.account||'即梦账号已连接'):'未连接';
    $('#dreaminaAccountName').textContent=connected?(s.account||'已连接，即梦账号'):'尚未连接';
    $('#dreaminaCredit').textContent=connected&&Number.isFinite(Number(s.credit))&&s.credit!==null?`${s.credit} 即梦积分`:'积分状态待连接';
    $('#dreaminaEnabled').checked=!!s.enabled;
    if(s.error)notice('连接状态暂不可用，请检查程序路径后刷新。',true);
  }
  function renderModels(){
    const host=$('#dreaminaModels');if(!host)return;host.replaceChildren();
    const models=state.status?.models||[];
    if(!models.length){host.append(el('div',{class:'dreamina-result'},'尚未读取到即梦模型。检查 CLI 路径、启用状态与账号连接后刷新。'));return;}
    for(const m of models){
      const row=el('div',{class:'dreamina-model'});const info=el('div');const title=el('b',{},m.name||m.id);const detail=el('small',{},`${m.kind==='video'?'视频':m.kind==='image'?'图片':m.kind||'模型'} · ${(m.versions||[]).join(' / ')||'默认版本'}`);info.append(title,detail);
      const actions=el('div',{class:'dreamina-model-actions'});const label=el('label');const check=document.createElement('input');check.type='checkbox';check.checked=m.enabled!==false;check.setAttribute('aria-label',`启用即梦模型 ${m.name||m.id}`);check.onchange=()=>toggleModel(m.id,check.checked);label.append(check,document.createTextNode('启用'));const remove=el('button',{},m.enabled===false?'恢复':'停用');remove.type='button';remove.setAttribute('aria-label',`${m.enabled===false?'恢复':'停用'}即梦模型 ${m.name||m.id}`);remove.onclick=()=>toggleModel(m.id,m.enabled===false);actions.append(label,remove);row.append(info,actions);host.append(row);
    }
  }
  async function refresh(){
    try{const status=await api('/status');let config=state.config;if($('#dreaminaPath'))config=await api('/config');state.status=status;state.config=config||state.config;const info=$('#dreaminaNotice');if(info?.dataset.error==='true'){info.hidden=true;info.textContent='';info.dataset.error='false';}if($('#dreaminaPath'))$('#dreaminaPath').value=config?.cli_path||'';statusText();renderModels();window.dispatchEvent(new CustomEvent('studio-dreamina-state',{detail:{status,config:state.config}}));announceChange();return status;}
    catch(error){const status=$('#dreaminaStatus');if(status){status.dataset.state='error';status.lastElementChild.textContent='状态读取失败';}throw error;}
  }
  async function saveConfig(silent=false){
    if(!$('#dreaminaPath'))return false;
    const cfg=state.config||{};const models={...(cfg.models||{})};for(const m of state.status?.models||[])models[m.id]=m.enabled!==false;
    const body={enabled:$('#dreaminaEnabled').checked,cli_path:$('#dreaminaPath').value.trim(),models};
    if(body.enabled&&!body.cli_path){notice('请填写即梦程序路径后再启用。',true);return false;}
    try{state.config=await api('/config','PUT',body);if(!silent)notice('即梦连接设置已保存。默认 API 未更改。');await refresh();return true;}
    catch(error){notice(error.message,true);if(silent)$('#dreaminaEnabled').checked=!!state.status?.enabled;return false;}
  }
  async function toggleModel(id,enabled){
    const models={...(state.config?.models||{})};models[id]=enabled;
    try{state.config=await api('/config','PUT',{...state.config,models});notice(`${id} 已${enabled?'启用':'停用'}。已有节点会保留原选择。`);await refresh();}
    catch(error){notice(error.message,true);await refresh().catch(()=>{});}
  }
  async function startLogin(){
    try{
      if(state.loginBusy)return;state.loginBusy=true;clearTimeout(state.timer);state.timer=null;state.loginId=null;const seq=++state.loginSeq;$('#dreaminaConnect').disabled=true;
      if(!$('#dreaminaEnabled').checked){notice('请先启用即梦通道，再开始授权。',true);return;}
      if(!$('#dreaminaPath').value.trim()){notice('请先填写即梦程序路径。',true);return;}
      const saved=await saveConfig(true);if(!saved)throw new Error('即梦设置未能保存，请检查程序路径与启用状态。');
      const login=await api('/login','POST',{});state.loginId=login.login_id;const box=$('#dreaminaLogin');box.replaceChildren();box.hidden=false;box.append(el('div',{class:'dreamina-code'},login.user_code||'请查看即梦客户端'),el('a',{href:login.verification_uri||'#',target:'_blank',rel:'noopener noreferrer'},'打开即梦授权页面'),el('p',{},`授权有效期约 ${Math.ceil((login.expires_in||0)/60)} 分钟。请在授权页面完成操作。`),el('button',{type:'button'},'取消本次授权'));
      box.querySelector('button').onclick=cancelLogin;notice('已启动新的账号授权。请在即梦网页完成操作；成功后页面会明确显示“已连接”。');pollLogin(seq);
    }catch(error){notice(error.message,true);}
    finally{state.loginBusy=false;$('#dreaminaConnect').disabled=false;}
  }
  async function pollLogin(seq){
    if(!state.loginId||seq!==state.loginSeq)return;
    try{const result=await api('/login-check','POST',{login_id:state.loginId,poll:true});if(seq!==state.loginSeq)return;if(result.complete||result.authenticated){clearTimeout(state.timer);state.loginId=null;$('#dreaminaLogin').hidden=true;await refresh();notice(result.authenticated?'即梦授权成功，账号已连接。':'授权流程已结束，请刷新状态确认。',!result.authenticated);return;}if(result.message)notice(result.message);state.timer=setTimeout(()=>pollLogin(seq),2500);}
    catch(error){clearTimeout(state.timer);state.timer=null;state.loginId=null;$('#dreaminaLogin').hidden=true;state.loginSeq++;notice(error.message,true);}
  }
  async function cancelLogin(){
    const loginId=state.loginId;clearTimeout(state.timer);state.timer=null;state.loginId=null;state.loginSeq++;$('#dreaminaLogin').hidden=true;
    if(loginId){try{await api('/login-cancel','POST',{login_id:loginId});notice('本次授权轮询已取消。');}catch(error){notice(`本次授权轮询已停止；服务端会在授权超时后清理。${error.message}`,true);}}
  }
  async function logout(){
    clearTimeout(state.timer);state.timer=null;state.loginId=null;state.loginSeq++;$('#dreaminaLogin').hidden=true;
    try{const result=await api('/logout','POST',{});await refresh();notice(result.message||'已退出本机即梦账号。');}
    catch(error){notice(error.message,true);}
  }
  function announceChange(){
    const message={type:'dreamina-changed',updated_at:Date.now()};
    try{parent.postMessage(message,location.origin);}catch{}
    try{const channel=new BroadcastChannel('studio-dreamina');channel.postMessage(message);channel.close();}catch{}
    try{const channel=new BroadcastChannel('studio-api');channel.postMessage({type:'providers-changed',updated_at:Date.now()});channel.close();}catch{}
  }
  function install(){if(!document.querySelector('.settings-top nav[aria-label="设置分类"]'))return;insertPanel();refresh().catch(error=>notice(error.message,true));}
  window.StudioDreamina={providerId:'dreamina-cli',isProvider:id=>id==='dreamina-cli',getStatus:()=>state.status,refresh,openSettings:()=>{tabPanel(true);refresh().catch(err=>notice(err.message,true));},canGenerate:()=>{const s=state.status;return !!s?.enabled&&!!s?.authenticated&&s?.available!==false;}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
