(() => {
  const panel = document.getElementById('controlPanel');
  if (!panel) return;
  const $ = id => document.getElementById(id);
  const endpoint = '/api/studio/control/settings';
  const codexEndpoint = '/api/studio/control/codex';
  const testPrompt = '请用 deepwhite-studio 先调用 studio_status，再列出我的画布，不修改或生成内容。';
  let state = null, codex = null, busy = false, pollTimer = 0, opened = false, diagnosticReport = null;
  let settingsRead = 0, codexRead = 0;
  const clientSelect = $('controlClientType'), clientHelp = $('controlClientHelp');
  const checkButton = $('controlCheck'), exportButton = $('controlExportDiagnostics');
  const commandButton = $('controlCopyCheck'), diagnosticBox = $('controlDiagnostics');

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
  function setupSay(message, error = false) {
    const box = $('controlSetupResult');
    box.hidden = !message; box.textContent = message || ''; box.dataset.error = String(error);
    box.setAttribute('role', error ? 'alert' : 'status');
  }
  function applyAvailability() {
    $('controlInstallCodex').disabled = busy || !state?.enabled || !codex?.can_install || codex.state === 'installed';
    $('controlUndoCodex').disabled = busy || !codex?.can_undo;
    checkButton.disabled = busy || !state?.enabled;
    $('controlCopyPrompt').disabled = busy || !state?.enabled;
    panel.querySelectorAll('.control-request button.accent').forEach(el => { el.disabled = busy || !state?.enabled; });
  }
  function setBusy(value) {
    busy = value;
    panel.querySelectorAll('button,input,select').forEach(el => { el.disabled = value; });
    $('controlPanel').setAttribute('aria-busy', String(value));
    applyAvailability();
  }
  function renderSetup() {
    const enabled = Boolean(state?.enabled), installed = codex?.state === 'installed';
    $('controlStepAccess').dataset.complete = String(enabled);
    $('controlAccessStatus').textContent = enabled ? '已启用' : '未启用';
    // Step 2 badge belongs to the multi-client panel (studio-clients.js).
    $('controlCodexLegacyBadge').textContent = ({missing:'尚未配置', installed:'已配置', different:'需要更新', blocked:'需处理'})[codex?.state] || '待检查';
    $('controlCodexStatus').textContent = codex?.message || '正在检查这台电脑的 Codex 配置…';
    $('controlInstallCodex').textContent = installed ? '已配置 Codex' : codex?.state === 'different' ? '更新 Codex 配置' : '自动配置 Codex';
    $('controlInstallHelp').textContent = !enabled
      ? '先启用访问，再配置这台电脑上的 Codex。'
      : installed ? '配置已就绪。请重启或重新连接 Codex，再执行下面的测试。'
      : '点击后自动填写本机配置，并备份原有文件。';
    $('controlCodexPath').textContent = codex?.config_path || '配置位置暂不可用，请刷新状态。';
    $('controlInstallType').textContent = codex?.portable === true
      ? '便携发行版 · 使用内置运行环境，版本更新后会自动选择新程序。'
      : codex?.portable === false
        ? '源码运行模式 · 当前连接使用此源码副本的运行环境。客户使用请分发完整便携发行包。'
        : '安装信息暂未就绪，请刷新状态后重试。';
    const checked = enabled && Boolean(diagnosticReport?.ok);
    $('controlStepCheck').dataset.complete = String(checked);
    $('controlCheckStatus').textContent = checked ? '本机检查通过' : diagnosticReport && enabled ? '检查未通过' : '尚未检查';
    applyAvailability();
  }
  function clearDiagnostics() {
    diagnosticReport = null; diagnosticBox.hidden = true; diagnosticBox.replaceChildren(); exportButton.hidden = true;
  }
  async function refreshCodex(showError = true) {
    const request = ++codexRead;
    try {
      const result = await api(codexEndpoint);
      if (request !== codexRead) return;
      if (codex && (codex.revision !== result.revision || codex.state !== result.state)) clearDiagnostics();
      codex = result; renderSetup();
    } catch (error) {
      if (request !== codexRead) return;
      codex = {state:'blocked', message:'暂时无法读取本机 Codex 配置。请刷新状态重试。', can_install:false, can_undo:false};
      clearDiagnostics();
      renderSetup();
      if (showError) setupSay(error.message, true);
    }
  }
  async function configureCodex(action) {
    if (busy || !codex) return;
    if (action === 'install' && (!state?.enabled || !codex.can_install)) return;
    if (action === 'undo' && !codex.can_undo) return;
    const replace = action === 'install' && codex.state === 'different';
    if (replace && !window.confirm('这台电脑已有另一份深白连接配置。是否将它更新为当前画布？只调整深白连接，并备份原有文件。')) return;
    if (action === 'undo' && !window.confirm('撤回上次通过此入口完成的 Codex 配置变更？撤回后需重启或重新连接 Codex。')) return;
    setBusy(true); ++codexRead;
    setupSay(action === 'install' ? '正在配置这台电脑上的 Codex…' : '正在撤回上次配置…');
    try {
      codex = await api(codexEndpoint, 'POST', {action, expected_revision:codex.revision, replace_existing:replace});
      clearDiagnostics(); renderSetup();
      setupSay(codex.message || (action === 'install' ? '已完成配置。请重启或重新连接 Codex，再发送测试提示词。' : '已撤回上次配置。'));
    } catch (error) {
      setupSay(error.message, true);
      await refreshCodex(false);
    } finally { setBusy(false); }
  }
  function configText(config) {
    if (typeof config === 'string') return config;
    return config && typeof config === 'object' ? JSON.stringify(config, null, 2) : '客户端配置暂不可用，请刷新重试。';
  }
  function renderConfig() {
    const selected = clientSelect.value;
    $('controlClientConfig').textContent = configText(state?.client_configs?.[selected] || state?.client_config);
    clientHelp.textContent = selected === 'codex_toml'
      ? '手动配置 Codex：将此段合并到上方的配置文件，保留其他设置；同名深白配置只保留一份。保存后重启或重新连接 Codex。'
      : '其他客户端：合并到客户端的 MCP JSON 配置，再重启该连接。入口及格式因客户端而异；此处自动配置仅支持 Codex。';
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
    if (quote.display || quote.label) return {text:`费用参考：${quote.display || quote.label}`, unknown:quote.price === null};
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
    if (state?.enabled !== Boolean(normalize(data).enabled)) clearDiagnostics();
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
    renderSetup();
    $('controlLoadError').hidden = true;
  }
  async function refresh(showError = true, includeCodex = true) {
    if (busy) return;
    const request = ++settingsRead;
    const setup = includeCodex ? refreshCodex(showError) : Promise.resolve();
    try { const value = await api(endpoint); if (request === settingsRead) render(value); }
    catch (error) { if (showError && request === settingsRead) { $('controlLoadError').hidden = false; $('controlLoadError').textContent = error.message; } }
    await setup;
  }
  async function update(body, success) {
    if (busy) return;
    ++settingsRead; setBusy(true); say('正在保存…');
    try {
      render(await api(endpoint, 'PUT', body)); say(success);
      if (Object.hasOwn(body, 'enabled')) setupSay(state.enabled ? 'MCP 访问已启用，可以配置 Codex。' : 'MCP 访问已关闭，智能体无法再操作此画布。');
    }
    catch (error) { if (state) render(state); say(error.message, true); if (Object.hasOwn(body, 'enabled')) setupSay(error.message, true); }
    finally { setBusy(false); }
  }
  async function decide(id, action) {
    if (busy) return;
    if (action === 'approve' && !state?.enabled) { say('MCP 访问已关闭，请先启用后再批准生成。', true); return; }
    if (action === 'approve' && !window.confirm('批准后会立即执行这次生成请求。要继续吗？')) return;
    setBusy(true); say(action === 'approve' ? '正在批准并执行…' : '正在拒绝请求…');
    try {
      const result = await api(`/api/studio/control/approvals/${encodeURIComponent(id)}`, 'POST', {action});
      try { render(await api(endpoint)); }
      catch { /* The approval action succeeded; keep its success message if refresh is unavailable. */ }
      // TASK-01: say plainly when the job ran but its local receipt was lost or rebuilt.
      if (result?.receipt === 'failed') say(result.message, true);
      else if (result?.recovered) say('已按原编号 ' + result.job_id + ' 找回任务记录，没有重复提交。');
      else say(action === 'approve' ? '已批准；本地服务已接收执行请求。' : '已拒绝此请求。');
    } catch (error) { say(error.message, true); }
    finally { setBusy(false); }
  }
  async function copyText(text, message, report = say) {
    try { await navigator.clipboard.writeText(text); report(message); }
    catch {
      const focused = document.activeElement;
      const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Older or restricted browsers may reject the fallback too. */ }
      finally { area.remove(); if (focused instanceof HTMLElement) focused.focus({preventScroll:true}); }
      report(copied ? message : '复制失败，请检查浏览器剪贴板权限。', !copied);
    }
  }
  async function copyConfig() {
    if (!state?.client_config) { say('客户端配置尚未就绪，请刷新状态后再复制。', true); return; }
    await copyText($('controlClientConfig').textContent, '客户端配置已复制。');
  }
  async function checkConnection() {
    if (busy || !state?.enabled) return;
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
      setupSay(diagnosticReport.ok
        ? '本机画布检查通过。请重启或重新连接 Codex，并发送测试提示词；能列出画布后，才表示 Codex 接入成功。'
        : '本机连接检查未通过，请按下方提示处理后重试。', !diagnosticReport.ok);
    } catch (error) {
      diagnosticBox.textContent = error.message; diagnosticReport = null; exportButton.hidden = true;
      setupSay(error.message, true);
    }
    finally { renderSetup(); setBusy(false); }
  }
  function tabChanged(tab) {
    panel.hidden = tab !== 'control';
    if (tab === 'control' && !opened) { opened = true; refresh(); }
    syncPolling();
  }
  function syncPolling() {
    clearInterval(pollTimer); pollTimer = 0;
    if ($('controlAutoRefresh').checked && !panel.hidden) pollTimer = setInterval(() => refresh(false, false), 8000);
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
    if (!window.confirm('授权本地智能体在接下来最多 30 分钟或 20 次生成内直接执行。现在开启本次授权？')) return refresh(false, false);
    update({generation_mode:'session'}, '本次授权已开启；最多 30 分钟或 20 次生成。');
  };
  $('controlEndSession').onclick = () => update({generation_mode:'confirm'}, '本次授权已结束，后续生成将逐次确认。');
  $('controlCopyConfig').onclick = copyConfig;
  $('controlRefresh').onclick = () => refresh();
  $('controlAutoRefresh').onchange = syncPolling;
  $('controlInstallCodex').onclick = () => configureCodex('install');
  $('controlUndoCodex').onclick = () => configureCodex('undo');
  $('controlRefreshCodex').onclick = async () => {
    if (busy) return;
    setupSay(''); setBusy(true);
    try { await refreshCodex(); } finally { setBusy(false); }
  };
  $('controlCopyPrompt').onclick = () => copyText(testPrompt, '测试提示词已复制。请在已连接的客户端中发送，确认能读取你的画布。', setupSay);
  clientSelect.onchange = renderConfig;
  document.addEventListener('studio-clients-changed', () => refresh(false));
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
