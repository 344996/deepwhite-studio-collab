(() => {
  const panel = document.getElementById('controlPanel');
  if (!panel) return;
  const $ = id => document.getElementById(id);
  const endpoint = '/api/studio/control/settings';
  let state = null, busy = false, pollTimer = 0, opened = false, diagnosticReport = null;
  const configHost = $('controlClientConfig').parentElement;
  const clientLabel = document.createElement('label'); clientLabel.className = 'control-client-label';
  clientLabel.textContent = '外接客户端';
  const clientSelect = document.createElement('select'); clientSelect.id = 'controlClientType';
  for (const [value, text] of [['codex_toml','Codex · TOML'], ['claude_json','Claude / 通用 · JSON']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; clientSelect.append(option);
  }
  clientLabel.append(clientSelect); configHost.insertBefore(clientLabel, $('controlClientConfig'));
  const clientHelp = document.createElement('p'); clientHelp.className = 'muted'; clientHelp.id = 'controlClientHelp';
  configHost.insertBefore(clientHelp, $('controlClientConfig'));
  const connectionInfo = document.createElement('p'); connectionInfo.className = 'control-connection-info';
  connectionInfo.textContent = 'MCP 连接这台电脑的画布。请先启动画布，再在同一电脑的外接客户端添加配置；API 网站地址用于生成服务。';
  configHost.append(connectionInfo);
  const diagnosticActions = document.createElement('div'); diagnosticActions.className = 'control-diagnostic-actions';
  const checkButton = document.createElement('button'); checkButton.id = 'controlCheck'; checkButton.type = 'button'; checkButton.textContent = '检查本机连接';
  const exportButton = document.createElement('button'); exportButton.id = 'controlExportDiagnostics'; exportButton.type = 'button'; exportButton.textContent = '导出检查结果'; exportButton.hidden = true;
  const commandButton = document.createElement('button'); commandButton.id = 'controlCopyCheck'; commandButton.type = 'button'; commandButton.textContent = '复制客户端检查命令';
  const skillLink = document.createElement('a'); skillLink.href = '/api/studio/control/skill'; skillLink.download = 'SKILL.md'; skillLink.textContent = '下载画布 Skill 示例'; skillLink.className = 'control-skill-link';
  diagnosticActions.append(checkButton, commandButton, exportButton, skillLink); configHost.append(diagnosticActions);
  const diagnosticBox = document.createElement('div'); diagnosticBox.id = 'controlDiagnostics'; diagnosticBox.setAttribute('aria-live', 'polite'); diagnosticBox.hidden = true; configHost.append(diagnosticBox);

  async function api(url, method = 'GET', body) {
    const response = await fetch(url, {method, headers:{'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    let data;
    try { data = await response.json(); } catch { throw Error('本地服务返回异常，请稍后重试。'); }
    if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : '本地智能体设置未能保存。');
    return data;
  }
  function normalize(data) {
    const value = data?.settings && typeof data.settings === 'object' ? {...data, ...data.settings} : data;
    return value || {};
  }
  function say(message, error = false) {
    const box = $('controlResult'); box.hidden = !message; box.textContent = message || ''; box.dataset.error = String(error);
  }
  function setBusy(value) {
    busy = value;
    panel.querySelectorAll('button,input,select').forEach(el => { el.disabled = value; });
    $('controlAutoRefresh').disabled = value;
    if (!value) panel.querySelectorAll('.control-request button.accent').forEach(el => { el.disabled = !state?.enabled; });
  }
  function configText(config) {
    if (typeof config === 'string') return config;
    return config && typeof config === 'object' ? JSON.stringify(config, null, 2) : '客户端配置暂不可用，请刷新重试。';
  }
  function renderConfig() {
    const selected = clientSelect.value;
    $('controlClientConfig').textContent = configText(state?.client_configs?.[selected] || state?.client_config);
    clientHelp.textContent = selected === 'codex_toml'
      ? 'Codex：将此段合并到用户目录 .codex/config.toml；已有同名配置时替换该段，然后重启 MCP 连接。不要把 JSON 粘贴进 TOML。'
      : 'Claude：合并到客户端的 MCP JSON 配置，然后重新启动该连接。不同客户端的入口名称可能不同。';
    if (state?.launcher_warning) clientHelp.textContent += ' ' + state.launcher_warning;
    else if (state?.stable_launcher) clientHelp.textContent += ' 当前使用固定启动入口，更新版本后会自动选择新程序。';
  }
  function sessionLabel(value) {
    if (!value) return '';
    const numeric = Number(value);
    const date = Number.isFinite(numeric) && numeric > 0
      ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : ` · 到期 ${date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
  }
  function quoteLabel(item) {
    const quote = item.quote;
    if (quote == null) return {text:'费用未知', unknown:true};
    if (typeof quote === 'string' || typeof quote === 'number') return {text:`费用参考：${quote}`, unknown:false};
    if (quote.display || quote.label) return {text:`费用参考：${quote.display || quote.label}`, unknown:false};
    if (quote.amount != null) return {text:`费用参考：${quote.currency || ''}${quote.amount}`, unknown:false};
    return {text:'费用未知', unknown:true};
  }
  function renderPending(items) {
    const host = $('controlPending'); host.replaceChildren();
    const pending = Array.isArray(items) ? items.filter(item => item.status === 'pending') : [];
    if (!pending.length) { host.textContent = '当前没有待确认的生成请求。'; return; }
    for (const item of pending) {
      const card = document.createElement('article'); card.className = 'control-request';
      const head = document.createElement('div'); head.className = 'control-request-head';
      const title = document.createElement('h3'); title.textContent = item.title || '未命名生成请求';
      const meta = document.createElement('p'); meta.textContent = [item.model || '模型未知', item.provider_id ? `平台 ${item.provider_id}` : '', item.status || '待确认'].filter(Boolean).join(' · ');
      const info = document.createElement('div'); info.append(title, meta); head.append(info); card.append(head);
      const inputs=document.createElement('p');
      inputs.textContent=`生成数量：${item.count || 1} · 参考素材：${(item.references || []).length} 项`;
      if(item.references?.length)inputs.textContent+=' · '+item.references.map(r=>r.mention||r.name||r.kind).join('、');
      card.append(inputs);
      const q = quoteLabel(item); const quote = document.createElement('p'); quote.textContent = q.text; if (q.unknown) quote.className = 'control-quote-unknown'; card.append(quote);
      const prompt = document.createElement('pre'); prompt.hidden = true; prompt.textContent = item.prompt || '此请求没有附带提示词。'; prompt.setAttribute('aria-label','生成提示词'); card.append(prompt);
      const actions = document.createElement('div'); actions.className = 'control-request-actions';
      const reveal = document.createElement('button'); reveal.type = 'button'; reveal.textContent = '查看提示词'; reveal.setAttribute('aria-expanded','false'); reveal.onclick = () => { prompt.hidden = !prompt.hidden; reveal.textContent = prompt.hidden ? '查看提示词' : '收起提示词'; reveal.setAttribute('aria-expanded', String(!prompt.hidden)); };
      const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'accent'; approve.textContent = '批准并执行'; approve.onclick = () => decide(item.id, 'approve');
      approve.disabled = !state?.enabled || item.status !== 'pending';
      if (!state?.enabled) approve.title = '请先启用 MCP 访问，再批准生成。';
      const reject = document.createElement('button'); reject.type = 'button'; reject.textContent = '拒绝'; reject.onclick = () => decide(item.id, 'reject');
      actions.append(reveal, approve, reject); card.append(actions); host.append(card);
    }
  }
  function render(data) {
    state = normalize(data);
    const enabled = Boolean(state.enabled);
    $('controlEnabled').checked = enabled;
    const mode = state.generation_mode === 'session' ? 'session' : 'confirm';
    const expiry = Number(state.session_expires_at);
    const activeSession = mode === 'session' && Number.isFinite(expiry) && expiry * 1000 > Date.now() && Number(state.remaining_runs) > 0;
    const displayMode = activeSession ? 'session' : 'confirm';
    $('controlConfirm').setAttribute('aria-pressed', String(displayMode === 'confirm'));
    $('controlSession').setAttribute('aria-pressed', String(displayMode === 'session'));
    $('controlSessionStatus').textContent = mode === 'session'
      ? activeSession
        ? `本次授权已开启 · 剩余 ${state.remaining_runs} 次${sessionLabel(state.session_expires_at)}`
        : '本次授权已结束或次数已用尽；下一次生成需逐次确认。'
      : '当前为逐次确认模式。';
    $('controlEndSession').hidden = !activeSession;
    renderConfig();
    renderPending(state.pending);
    $('controlLoadError').hidden = true;
  }
  async function refresh(showError = true) {
    if (busy) return;
    try { render(await api(endpoint)); }
    catch (error) { if (showError) { $('controlLoadError').hidden = false; $('controlLoadError').textContent = error.message; } }
  }
  async function update(body, success) {
    if (busy) return;
    setBusy(true); say('正在保存…');
    try { render(await api(endpoint, 'PUT', body)); say(success); }
    catch (error) { if (state) render(state); say(error.message, true); }
    finally { setBusy(false); }
  }
  async function decide(id, action) {
    if (busy) return;
    if (action === 'approve' && !state?.enabled) { say('MCP 访问已关闭，请先启用后再批准生成。', true); return; }
    if (action === 'approve' && !window.confirm('批准后会立即执行这次生成请求。要继续吗？')) return;
    setBusy(true); say(action === 'approve' ? '正在批准并执行…' : '正在拒绝请求…');
    try {
      await api(`/api/studio/control/approvals/${encodeURIComponent(id)}`, 'POST', {action});
      try { render(await api(endpoint)); }
      catch { /* The approval action succeeded; keep its success message if refresh is unavailable. */ }
      say(action === 'approve' ? '已批准；本地服务已接收执行请求。' : '已拒绝此请求。');
    } catch (error) { say(error.message, true); }
    finally { setBusy(false); }
  }
  async function copyText(text, message) {
    try { await navigator.clipboard.writeText(text); say(message); }
    catch {
      const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select();
      const copied = document.execCommand('copy'); area.remove(); say(copied ? message : '复制失败，请检查浏览器剪贴板权限。', !copied);
    }
  }
  async function copyConfig() {
    if (!state?.client_config) { say('客户端配置尚未就绪，请刷新状态后再复制。', true); return; }
    await copyText($('controlClientConfig').textContent, '客户端配置已复制。');
  }
  async function checkConnection() {
    if (busy) return;
    setBusy(true); diagnosticBox.hidden = false; diagnosticBox.textContent = '正在检查启动入口、本机画布和控制授权…';
    try {
      diagnosticReport = await api('/api/studio/control/diagnostics', 'POST');
      diagnosticBox.replaceChildren();
      for (const item of diagnosticReport.checks || []) {
        const row = document.createElement('p'); row.dataset.ok = String(Boolean(item.ok));
        row.textContent = `${item.ok ? '通过' : '未通过'} · ${item.step}${item.message ? '：' + item.message : ''}`;
        if (item.hint) { const hint = document.createElement('small'); hint.textContent = item.hint; row.append(hint); }
        diagnosticBox.append(row);
      }
      const scope = document.createElement('p'); scope.className = 'muted';
      scope.textContent = diagnosticReport.scope || '这是画布进程的检查结果；请在 Codex 中确认能够发现并调用工具。';
      diagnosticBox.append(scope); exportButton.hidden = false;
    } catch (error) {
      diagnosticBox.textContent = error.message; diagnosticReport = null; exportButton.hidden = true;
    }
    finally { setBusy(false); }
  }
  function tabChanged(tab) {
    panel.hidden = tab !== 'control';
    if (tab === 'control' && !opened) { opened = true; refresh(); }
    syncPolling();
  }
  function syncPolling() {
    clearInterval(pollTimer); pollTimer = 0;
    if ($('controlAutoRefresh').checked && !panel.hidden) pollTimer = setInterval(() => refresh(false), 8000);
  }

  // The settings sidebar owns navigation; this module only manages its own panel.
  window.addEventListener('studio:settings-tab', event => tabChanged(event.detail?.tab));
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.onclick = () => {
      if (window.StudioSettingsNavigation) return;
      document.querySelectorAll('[data-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
      $('apiPanel').hidden = button.dataset.tab !== 'api';
      $('generalPanel').hidden = button.dataset.tab !== 'general';
      tabChanged(button.dataset.tab);
    };
  });
  $('controlEnabled').onchange = () => update({enabled:$('controlEnabled').checked}, 'MCP 访问设置已保存。');
  $('controlConfirm').onclick = () => update({generation_mode:'confirm'}, '已切换为逐次确认。');
  $('controlSession').onclick = () => {
    if (!window.confirm('授权本地智能体在接下来最多 30 分钟或 20 次生成内直接执行。现在开启本次授权？')) return refresh(false);
    update({generation_mode:'session'}, '本次授权已开启；最多 30 分钟或 20 次生成。');
  };
  $('controlEndSession').onclick = () => update({generation_mode:'confirm'}, '本次授权已结束，后续生成将逐次确认。');
  $('controlCopyConfig').onclick = copyConfig;
  $('controlRefresh').onclick = () => refresh();
  $('controlAutoRefresh').onchange = syncPolling;
  clientSelect.onchange = renderConfig;
  checkButton.onclick = checkConnection;
  commandButton.onclick = () => state?.check_command
    ? copyText(state.check_command, '检查命令已复制，请在运行外接客户端的电脑上用 PowerShell 执行。')
    : say('请先刷新连接配置。', true);
  exportButton.onclick = () => {
    if (!diagnosticReport) return;
    const file = new Blob([JSON.stringify(diagnosticReport, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(file), link = document.createElement('a');
    link.href = url; link.download = 'deepwhite-mcp-diagnostics.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})();
