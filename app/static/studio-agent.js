(() => {
  'use strict';
  if (window.__studioAgentInstalled) return;
  window.__studioAgentInstalled = true;
    const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-agent.css?v=0.6.0-agent.2';document.head.append(css);
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const canvasId = params.get('id') || '';
  const state = {open:false, projectId:'', bootstrap:null, sessions:[], session:null, assets:[], attachments:[], selectedAttachmentIds:new Set(), busy:false, pollTimer:0, requestId:'', planBusy:false, appliedPlans:new Set()};
  const toolbar = document.querySelector('.toolbar-fixed');
  if (!toolbar) return;
  const button = document.createElement('button');
  button.type='button'; button.id='studioAgentToggle'; button.className='tool-btn'; button.title='画布助手'; button.setAttribute('aria-label','画布助手');
  const icon=document.createElement('i');icon.dataset.lucide='bot';icon.className='w-4 h-4';const label=document.createElement('span');label.textContent='画布助手';button.append(icon,label);
  const assetButton=document.getElementById('canvasAssetToggle');toolbar.insertBefore(button,assetButton?.nextSibling || null);
  button.addEventListener('click',togglePanel);
  buildPanel();
  if(window.lucide) window.lucide.createIcons();

  async function request(url, options={}) {
    const response=await fetch(url,options);let data={};try{data=await response.json();}catch(_){}
    if(!response.ok) throw new Error(data.detail || data.error || data.message || `请求失败（${response.status}）`);
    return data;
  }
  function unwrap(data,key) {return data?.[key] || data;}
  function jsonOptions(body) {return {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};}
  async function togglePanel() {if(state.open) closePanel();else await openPanel();}
  async function openPanel() {
    state.open=true; $('studioAgentPanel').hidden=false;button.classList.add('active');
    try {if(!state.bootstrap) await initialize(); else if(state.session) await refreshSession();}
    catch(error){showError(error.message);}
    focusComposer();
  }
  function closePanel() {state.open=false;$('studioAgentPanel').hidden=true;button.classList.remove('active');}
  async function initialize() {
    if(!canvasId) throw new Error('请先打开一个项目画布。');
    const canvasData=await request(`/api/canvases/${encodeURIComponent(canvasId)}`);const canvas=canvasData.canvas || canvasData;
    state.projectId=String(canvas.project || 'default');
    const [bootstrap,sessionList,assetList]=await Promise.all([
      request(`/api/studio/agent/bootstrap?canvas_id=${encodeURIComponent(canvasId)}`),
      request(`/api/studio/agent/sessions?canvas_id=${encodeURIComponent(canvasId)}`),
      request(`/api/studio/assets?project_id=${encodeURIComponent(state.projectId)}`)
    ]);
    state.bootstrap=unwrap(bootstrap,'bootstrap');state.sessions=Array.isArray(sessionList.items)?sessionList.items:[];state.assets=Array.isArray(assetList.items)?assetList.items:[];
    renderModels();renderSkills();renderAssets();renderSessions();
    if(state.sessions.length) await selectSession(state.sessions[0].id);
    else await createSession();
  }
  function buildPanel() {
    const panel=document.createElement('aside');panel.id='studioAgentPanel';panel.className='studio-agent-panel';panel.hidden=true;panel.setAttribute('aria-label','画布助手');
    panel.innerHTML=`<div class="studio-agent-head"><div class="studio-agent-brand"><span class="studio-agent-mark">DW</span><div><strong>画布助手</strong><small>方案确认后写入节点；媒体生成需单独执行</small></div></div><div class="studio-agent-head-actions"><button id="studioAgentNew" type="button" title="新建会话" aria-label="新建会话">＋</button><button id="studioAgentClose" type="button" title="关闭" aria-label="关闭">×</button></div></div>
      <div class="studio-agent-sessionbar"><select id="studioAgentSessions" aria-label="历史会话"></select><button id="studioAgentReload" type="button" title="刷新会话">↻</button></div>
      <div id="studioAgentError" class="studio-agent-error" role="alert" hidden></div>
      <div id="studioAgentMessages" class="studio-agent-messages" aria-live="polite"></div>
      <section id="studioAgentPlan" class="studio-agent-plan" hidden></section>
      <div class="studio-agent-options"><label class="studio-agent-subtitle" for="studioAgentSkills">处理技能</label><select id="studioAgentSkills" multiple size="2" aria-label="选择处理技能"></select>
        <div class="studio-agent-attachrow"><input id="studioAgentFiles" type="file" accept=".txt,.md,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple hidden><button id="studioAgentAttach" type="button">＋ 上传剧本 / 文本</button><input id="studioAgentSkillFolder" type="file" webkitdirectory directory multiple hidden><button id="studioAgentImportSkill" type="button">导入技能</button></div>
        <div id="studioAgentAttachments" class="studio-agent-attachments"></div>
        <details class="studio-agent-advanced"><summary>高级设置</summary><div class="studio-agent-modelrow"><label>对话模型<select id="studioAgentModel"></select></label><label>图片目标<select id="studioAgentImageTarget"></select></label><label>视频目标<select id="studioAgentVideoTarget"></select></label></div>
          <label class="studio-agent-inline"><input id="studioAgentNodeContext" type="checkbox"><span>附带其他选中的画布节点</span><small id="studioAgentNodeCount">0 个</small></label>
          <label class="studio-agent-inline"><input id="studioAgentVision" type="checkbox"><span>让模型查看所选图片（会发送图片）</span></label>
          <label class="studio-agent-subtitle" for="studioAgentAssets">其他项目资产参考</label><select id="studioAgentAssets" multiple size="3" aria-label="选择项目资产"></select>
        </details>
      </div>
      <form id="studioAgentComposer" class="studio-agent-composer"><label class="studio-agent-subtitle" for="studioAgentInput">补充要求</label><textarea id="studioAgentInput" rows="3" placeholder="说明本轮要分析、修改或生成什么…" aria-label="补充要求"></textarea><div class="studio-agent-sendrow"><span>开始后先生成可审阅方案</span><button id="studioAgentSend" type="submit">开始分析</button></div></form>`;
    document.body.append(panel);
    $('studioAgentClose').addEventListener('click',closePanel);$('studioAgentNew').addEventListener('click',createSession);$('studioAgentReload').addEventListener('click',reloadSessions);
    $('studioAgentComposer').addEventListener('submit',sendMessage);$('studioAgentAttach').addEventListener('click',()=>$('studioAgentFiles').click());$('studioAgentFiles').addEventListener('change',uploadAttachments);
    $('studioAgentImportSkill').addEventListener('click',()=>$('studioAgentSkillFolder').click());$('studioAgentSkillFolder').addEventListener('change',importSkillFolder);
    $('studioAgentNodeContext').addEventListener('change',updateNodeCount);document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.open)closePanel();});
    $('studioAgentSessions').addEventListener('change',event=>selectSession(event.target.value));
    setInterval(updateNodeCount,700);
  }
  function renderModels() {
    const bootstrap=state.bootstrap || {}; const models=Array.isArray(bootstrap.models)?bootstrap.models:[];
    const modelSelect=$('studioAgentModel');fillSelect(modelSelect,models.map(m=>({value:modelKey(m),label:m.label || `${m.provider_id}/${m.model}`})),'选择对话模型');
    const targets=Array.isArray(bootstrap.targets)?bootstrap.targets:[];
    for(const [kind,id,labelText] of [['image','studioAgentImageTarget','不指定图片目标'],['video','studioAgentVideoTarget','不指定视频目标']]) {
      const select=$(id);const rows=targets.filter(target=>target.kind===kind);fillSelect(select,rows.map(m=>({value:modelKey(m),label:m.label || `${m.provider_id}/${m.model}`})),labelText);
    }
  }
  function modelKey(model) {return JSON.stringify([model.provider_id || '',model.model || '']);}
  function fillSelect(select,options,placeholder) {select.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent=placeholder;select.append(empty);options.forEach(option=>{const el=document.createElement('option');el.value=option.value;el.textContent=option.label;select.append(el);});}
  function parseKey(key) {try{const [provider_id,model]=JSON.parse(String(key||'[]'));return provider_id&&model?{provider_id,model}:null;}catch(_){return null;}}
  function renderSkills() {
    const select=$('studioAgentSkills');select.replaceChildren();const skills=Array.isArray(state.bootstrap?.skills)?state.bootstrap.skills:[];
    skills.forEach(skill=>{const option=document.createElement('option');option.value=skill.id || skill.name;option.textContent=skill.name || skill.id || '未命名技能';option.title=skill.description || '';select.append(option);});
  }
  function renderAssets() {
    const select=$('studioAgentAssets');select.replaceChildren();
    state.assets.forEach(item=>{const option=document.createElement('option');option.value=item.version_id;option.textContent=`${item.name || '未命名资产'} · ${item.status || ''}${item.missing?' · 文件缺失':''}`;option.disabled=!item.version_id || Boolean(item.missing);option.title=`${item.category || item.kind || ''}${item.asset_id?` · ${item.asset_id}`:''}`;select.append(option);});
  }
  function renderSessions() {
    const select=$('studioAgentSessions');select.replaceChildren();
    if(!state.sessions.length){const option=document.createElement('option');option.value='';option.textContent='暂无历史会话';select.append(option);return;}
    state.sessions.forEach(session=>{const option=document.createElement('option');option.value=session.id;option.textContent=session.title || `会话 · ${shortDate(session.updated_at || session.created_at)}`;select.append(option);});
    if(state.session) select.value=state.session.id;
  }
  async function reloadSessions() {
    try {const data=await request(`/api/studio/agent/sessions?canvas_id=${encodeURIComponent(canvasId)}`);state.sessions=Array.isArray(data.items)?data.items:[];renderSessions();if(state.session && state.sessions.some(row=>row.id===state.session.id)) await selectSession(state.session.id,false);}
    catch(error){showError(error.message);}
  }
  async function createSession() {
    clearError();if(state.busy)return;state.busy=true;
    try {const data=await request('/api/studio/agent/sessions',jsonOptions({canvas_id:canvasId}));state.session=unwrap(data,'session');if(!state.session?.id)throw new Error('服务没有返回会话编号。');state.attachments=[];state.selectedAttachmentIds=new Set();await reloadSessions();renderSession();}
    catch(error){showError(`新建会话失败：${error.message}`);}
    finally{state.busy=false;renderSession();}
  }
  async function selectSession(id,restoreControls=true) {
    if(!id)return;clearError();
    try {const data=await request(`/api/studio/agent/sessions/${encodeURIComponent(id)}`);state.session=unwrap(data,'session');state.attachments=Array.isArray(state.session.attachments)?state.session.attachments:[];state.selectedAttachmentIds=new Set();if(restoreControls)restoreLastTurnControls();renderSessions();renderSession();schedulePoll();}
    catch(error){showError(`读取会话失败：${error.message}`);}
  }
  function restoreLastTurnControls() {
    const turn=state.session?.turns?.[state.session.turns.length-1];if(!turn)return;
    const modelValue=modelKey({provider_id:turn.provider_id,model:turn.model});
    if([...$('studioAgentModel').options].some(option=>option.value===modelValue)) $('studioAgentModel').value=modelValue;
    const targets=turn.target_models || {};
    for(const [kind,id] of [['image','studioAgentImageTarget'],['video','studioAgentVideoTarget']]) {
      const target=targets[kind];const value=target?.provider_id && target?.model?modelKey(target):'';
      if([...$(id).options].some(option=>option.value===value)) $(id).value=value;
    }
    const skillSet=new Set(turn.skill_ids || []);[...$('studioAgentSkills').options].forEach(option=>{option.selected=skillSet.has(option.value);});
    state.selectedAttachmentIds=new Set(turn.attachment_ids || []);
    $('studioAgentVision').checked=Boolean(turn.vision);
  }
  async function refreshSession() {
    if(!state.session?.id)return;
    try {const data=await request(`/api/studio/agent/sessions/${encodeURIComponent(state.session.id)}`);state.session=unwrap(data,'session');state.attachments=Array.isArray(state.session.attachments)?state.session.attachments:state.attachments;renderSession();schedulePoll();}
    catch(error){showError(`刷新会话失败：${error.message}`);}
  }
  function renderSession() {
    const host=$('studioAgentMessages');host.replaceChildren();
    const turns=Array.isArray(state.session?.turns)?state.session.turns:[];
    if(turns.length) turns.forEach(turn=>{
      appendBubble(host,'user',turn.user_message || turn.user_content || '', 'completed','');
      const status=turn.status || state.session?.status;
      const reply=turn.reply || (status==='running'?'':status==='failed'?'本轮未完成。':'');
      appendBubble(host,'assistant',reply,status,turn.error || '');
      if(status==='completed' && !turn.plan){const note=document.createElement('div');note.className='studio-agent-no-nodes';note.textContent='纯文本答复 · 未创建画布节点';host.append(note);}
    });
    else {
      const messages=Array.isArray(state.session?.messages)?state.session.messages:[];
      messages.forEach(message=>appendBubble(host,message.role==='user'?'user':'assistant',readable(message.content),message.status || '',message.error || ''));
    }
    if(!turns.length && !state.session?.messages?.length){const welcome=document.createElement('div');welcome.className='studio-agent-welcome';welcome.textContent='可以请助手分析画布、整理参考关系或拟定资产方案。图片与视频只会生成明确方案，确认后才会写入画布。';host.append(welcome);}
    const usage=sessionUsage(turns);if(usage){const line=document.createElement('div');line.className='studio-agent-total-usage';line.textContent=usage;host.append(line);}
    const latestTurn=turns[turns.length-1];
    const currentPlan=!state.busy && latestTurn?.plan ? (state.session?.plan?.id===latestTurn.plan.id?state.session.plan:latestTurn.plan) : null;
    renderPlan(currentPlan);renderAttachments();host.scrollTop=host.scrollHeight;updateNodeCount();
    const agentStatus=state.session?.status==='running'?'running':state.session?.status==='failed'||state.session?.status==='interrupted'?'failed':currentPlan?.applied?'applied':currentPlan?'review':'complete';
    const agentLabel=agentStatus==='running'?'正在分析':agentStatus==='failed'?'执行失败':agentStatus==='applied'?'方案已写入':agentStatus==='review'?'方案待确认':latestTurn?.status==='completed'&&!latestTurn.plan?'纯文本答复，未创建节点':'等待开始';
    window.studioSkillNodeStatus?.(state.session?.id,agentStatus,agentLabel);
    const locked=state.busy || needsPolling(state.session);
    $('studioAgentSend').disabled=locked || !state.session?.id;
    $('studioAgentAttach').disabled=locked;$('studioAgentFiles').disabled=locked;
  }
  function appendBubble(host,role,text,status,error) {
    const bubble=document.createElement('article');bubble.className=`studio-agent-message ${role==='user'?'user':'assistant'}`;
    const label=document.createElement('small');label.textContent=role==='user'?'你':'助手';bubble.append(label);
    if(text){const content=document.createElement('div');content.className='studio-agent-message-content';content.textContent=readable(text);bubble.append(content);}
    if(status==='running'){const pending=document.createElement('div');pending.className='studio-agent-pending';pending.textContent='正在处理…';bubble.append(pending);}
    if(error){const err=document.createElement('div');err.className='studio-agent-message-error';err.textContent=readable(error);bubble.append(err);}
    host.append(bubble);
  }
  function sessionUsage(turns) {
    const total={prompt_tokens:0,completion_tokens:0,total_tokens:0};
    turns.forEach(turn=>{const usage=turn.usage;if(!usage || typeof usage!=='object')return;Object.keys(total).forEach(key=>{if(Number.isFinite(Number(usage[key])))total[key]+=Number(usage[key]);});});
    if(!total.prompt_tokens && !total.completion_tokens && !total.total_tokens)return '';
    return `本会话累计用量：输入 ${total.prompt_tokens.toLocaleString()} tokens · 输出 ${total.completion_tokens.toLocaleString()} tokens · 合计 ${total.total_tokens.toLocaleString()} tokens`;
  }
  function readable(value) {return typeof value==='string'?value:value==null?'':JSON.stringify(value);}
  function renderPlan(plan) {
    const host=$('studioAgentPlan');host.replaceChildren();host.hidden=!plan;if(!plan)return;
    const header=document.createElement('div');header.className='studio-agent-plan-head';const title=document.createElement('strong');title.textContent='画布方案';const stateLabel=document.createElement('span');stateLabel.textContent=plan.applied?'已写入画布':state.session?.status==='running'?'正在规划…':'等待确认';header.append(title,stateLabel);host.append(header);
    const nodes=Array.isArray(plan.nodes)?plan.nodes:[];
    nodes.forEach((node,index)=>{const card=document.createElement('article');card.className='studio-agent-plan-node';const heading=document.createElement('div');heading.className='studio-agent-plan-title';heading.textContent=`${index+1}. ${node.title || node.kind || '节点'}`;const mapping=document.createElement('small');mapping.textContent=node.target_node_id?`更新节点 ${node.target_node_id} · 会替换该节点现有连线`:'新建节点';const prompt=document.createElement('p');prompt.textContent=node.prompt || '未提供提示词';card.append(heading,mapping,prompt);if(node.provider_id || node.model){const target=document.createElement('small');target.textContent=`目标：${[node.provider_id,node.model].filter(Boolean).join(' · ')}`;card.append(target);}if(Array.isArray(node.references)&&node.references.length){const refs=document.createElement('div');refs.className='studio-agent-plan-refs';refs.textContent=`输入对应：${node.references.map((ref,i)=>`${ref.mention || `@参考${i+1}`} → ${ref.label || ref.name || ref.title || ref.version_id || ref.node_id || '参考素材'}`).join('；')}`;card.append(refs);}host.append(card);});
    if(plan.usage){const usage=document.createElement('small');usage.className='studio-agent-usage';usage.textContent=typeof plan.usage==='string'?plan.usage:`用量信息：${Object.entries(plan.usage).map(([key,value])=>`${key} ${value}`).join(' · ')}`;host.append(usage);}
    if(nodes.length && !plan.applied && !state.appliedPlans.has(plan.id) && state.session?.status!=='running'){const apply=document.createElement('button');apply.type='button';apply.className='studio-agent-apply';apply.textContent=state.planBusy?'正在写入…':'确认写入画布';apply.disabled=state.planBusy;apply.addEventListener('click',()=>applyPlan(plan));host.append(apply);}
  }
  async function applyPlan(plan) {
    if(state.planBusy || !state.session?.id || !plan?.id)return;
    if(typeof window.studioApplyAgentPlan!=='function'){showError('画布写入接口尚未加载，请刷新后重试。');return;}
    state.planBusy=true;renderPlan(plan);
    try {await window.studioApplyAgentPlan(state.session.id,plan.id);state.appliedPlans.add(plan.id);showInfo('方案已写入画布。');}
    catch(error){showError(`写入方案失败：${error.message}`);}
    finally{state.planBusy=false;renderPlan(state.session?.plan || plan);}
    if(state.appliedPlans.has(plan.id)) await refreshSession();
  }
  async function uploadAttachments(event) {
    const files=[...(event.target.files||[])];event.target.value='';if(!files.length)return;
    for(const file of files) {
      if(!state.session?.id){showError('请先创建会话。');return;}
      const form=new FormData();form.append('file',file);
      try {const data=await request(`/api/studio/agent/sessions/${encodeURIComponent(state.session.id)}/attachments`,{method:'POST',body:form});const attachment=unwrap(data,'attachment');state.attachments.push(attachment);state.selectedAttachmentIds.add(attachment.id);
        if(typeof window.studioAgentCreateTextNode==='function') attachment.canvas_node_id=window.studioAgentCreateTextNode({session_id:state.session.id,...attachment});
        renderAttachments();}
      catch(error){showError(`上传 ${file.name} 失败：${error.message}`);}
    }
  }
  function renderAttachments() {
    const host=$('studioAgentAttachments');host.replaceChildren();
    state.attachments.forEach(attachment=>{
      const label=document.createElement('label');label.className='studio-agent-attachment';
      const check=document.createElement('input');check.type='checkbox';check.checked=state.selectedAttachmentIds.has(attachment.id);check.addEventListener('change',()=>{check.checked?state.selectedAttachmentIds.add(attachment.id):state.selectedAttachmentIds.delete(attachment.id);});
      const name=document.createElement('span');name.textContent=(attachment.name || '附件')+(attachment.canvas_node_id?' · 已添加为画布文本节点':'');label.append(check,name);host.append(label);
    });
  }
  async function importSkillFolder(event) {
    const files=[...(event.target.files||[])];event.target.value='';if(!files.length)return;
    const map=Object.create(null);let name='';
    try {
      for(const file of files) {
        const relative=file.webkitRelativePath || file.name;const parts=relative.split('/');if(!name && parts.length>1)name=parts[0];
        if(!/\.(md|txt|json)$/i.test(file.name))continue;
        map[parts.slice(1).join('/') || file.name]=await file.text();
      }
      if(!map['SKILL.md'])throw new Error('所选文件夹根目录或子目录中没有 SKILL.md。');
      if(!name)name=window.prompt('技能名称',files[0].name.replace(/\.[^.]+$/,'')) || '';
      if(!name)return;
      const data=await request('/api/studio/skills',jsonOptions({name,files:map}));
      showInfo(`技能“${data.name || name}”已导入。`);
      const boot=await request(`/api/studio/agent/bootstrap?canvas_id=${encodeURIComponent(canvasId)}`);state.bootstrap=unwrap(boot,'bootstrap');renderSkills();
    } catch(error){showError(`技能导入失败：${error.message}`);}
  }
  async function sendMessage(event) {
    event.preventDefault();if(state.busy || !state.session?.id)return;
    const message=$('studioAgentInput').value.trim();if(!message)return;
    const model=parseKey($('studioAgentModel').value);if(!model){showError('请选择对话模型。');return;}
    state.busy=true;clearError();$('studioAgentInput').value='';$('studioAgentSend').disabled=true;renderSession();
    let payload=null;
    try {
      if(typeof window.studioFlushAgentCanvas==='function') await window.studioFlushAgentCanvas();
      const nodeIds=new Set($('studioAgentNodeContext').checked?[...document.querySelectorAll('.node.selected')].map(node=>node.dataset.id).filter(Boolean):[]);
      const attachedNodeIds=window.studioSkillNodesForAttachments?.(state.session.id,[...state.selectedAttachmentIds]) || [];
      attachedNodeIds.forEach(id=>nodeIds.add(id));
      const skillIds=[...$('studioAgentSkills').selectedOptions].map(option=>option.value);
      if(skillIds.length>3)throw new Error('一次最多选择 3 个技能。');
      payload={request_id:createRequestId(),message,provider_id:model.provider_id,model:model.model,
        skill_ids:skillIds,attachment_ids:[...state.selectedAttachmentIds],node_ids:[...nodeIds],
        asset_version_ids:[...$('studioAgentAssets').selectedOptions].map(option=>option.value),image_model:parseKey($('studioAgentImageTarget').value),video_model:parseKey($('studioAgentVideoTarget').value),vision:$('studioAgentVision').checked};
      appendLocalUserMessage(message);renderSession();
      const data=await request(`/api/studio/agent/sessions/${encodeURIComponent(state.session.id)}/messages`,jsonOptions(payload));state.session=unwrap(data,'session');state.attachments=Array.isArray(state.session.attachments)?state.session.attachments:state.attachments;renderSession();schedulePoll();await reloadSessions();
    }
    catch(error){if(payload && Array.isArray(state.session?.messages))state.session.messages=state.session.messages.filter(item=>item.request_id!==payload.request_id);showError(`发送失败：${error.message}`);$('studioAgentInput').value=message;renderSession();}
    finally{state.busy=false;renderSession();}
  }
  function appendLocalUserMessage(message) {
    state.session.messages=Array.isArray(state.session.messages)?state.session.messages:[];
    state.session.messages.push({role:'user',content:message,request_id:state.requestId});
  }
  function createRequestId() {state.requestId=window.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;return state.requestId;}
  function schedulePoll() {clearTimeout(state.pollTimer);if(!needsPolling(state.session))return;state.pollTimer=setTimeout(pollSession,1400);}
  function needsPolling(session) {return Boolean(session && (session.status==='running' || session.turns?.some(turn=>turn.status==='running') || session.messages?.some(message=>message.status==='running')));}
  async function pollSession() {
    if(!state.session?.id)return;
    try {const data=await request(`/api/studio/agent/sessions/${encodeURIComponent(state.session.id)}`);state.session=unwrap(data,'session');renderSession();if(needsPolling(state.session))schedulePoll();else reloadSessions();}
    catch(error){showError(`更新会话失败：${error.message}`);state.pollTimer=setTimeout(pollSession,3500);}
  }
  function updateNodeCount() {const count=document.querySelectorAll('.node.selected').length;const node=$('studioAgentNodeCount');if(node)node.textContent=`${count} 个`+(count?'（将发送编号）':'');}
  function focusComposer() {requestAnimationFrame(()=>$('studioAgentInput')?.focus());}
  function shortDate(value) {if(!value)return '新会话';const date=new Date(value);return Number.isNaN(date.getTime())?'新会话':date.toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
  function showError(message) {const box=$('studioAgentError');box.textContent=message;box.className='studio-agent-error';box.hidden=false;}
  function showInfo(message) {const box=$('studioAgentError');box.textContent=message;box.className='studio-agent-info';box.hidden=false;setTimeout(()=>{if(box.textContent===message)box.hidden=true;},3500);}
  function clearError() {const box=$('studioAgentError');box.hidden=true;box.textContent='';}
  window.StudioAgent={openSession:async sessionId=>{
    try {
      if(!state.bootstrap) await initialize();
      state.open=true;$('studioAgentPanel').hidden=false;button.classList.add('active');
      if(state.session?.id!==sessionId) await selectSession(sessionId);
      focusComposer();
    } catch(error) {showError(`打开 Skill 会话失败：${error.message}`);}
  }};
})();
