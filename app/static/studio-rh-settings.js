/* U07: RunningHub credentials, connection check and defaults in Settings. Keys are sent only when
   typed and never read back; the canvas uses the same saved keys. */
(() => {
  'use strict';
  const panel = document.getElementById('runninghubPanel');
  if (!panel) return;
  const $ = id => document.getElementById(id);
  const STAGES = [['service', '服务可达'], ['auth', '密钥鉴权'], ['catalog', '模型目录可读']];
  function say(text, error = false) {
    const box = $('rhResult');
    box.hidden = !text; box.textContent = text || ''; box.dataset.error = String(error);
  }
  async function api(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : '操作未完成，请重试。');
    return data;
  }
  function show(state) {
    $('rhKey').value = ''; $('rhWalletKey').value = ''; $('rhClearKey').checked = false; $('rhClearWallet').checked = false;
    $('rhKey').placeholder = state.has_key ? '已保存；留空保留原密钥' : '粘贴 API Key';
    $('rhWalletKey').placeholder = state.has_wallet_key ? '已保存；留空保留原密钥' : '使用钱包余额时填写';
    $('rhKeyState').textContent = state.has_key ? '会员积分 Key 已保存（不回显）' : '尚未保存会员积分 Key';
    $('rhWalletState').textContent = state.has_wallet_key ? '钱包 Key 已保存（不回显）' : '尚未保存钱包 Key';
    for (const radio of panel.querySelectorAll('[name="rhPayment"]')) radio.checked = radio.value === state.default_payment;
    $('rhInstance').value = state.default_instance || '';
  }
  async function load() {
    try { show(await api('/api/studio/settings/runninghub')); } catch (error) { say(error.message, true); }
  }
  $('rhForm').addEventListener('submit', async event => {
    event.preventDefault();
    const body = {default_payment: panel.querySelector('[name="rhPayment"]:checked')?.value || 'free', default_instance: $('rhInstance').value,
      clear_key: $('rhClearKey').checked, clear_wallet_key: $('rhClearWallet').checked};
    if ($('rhKey').value.trim()) body.api_key = $('rhKey').value.trim();
    if ($('rhWalletKey').value.trim()) body.wallet_api_key = $('rhWalletKey').value.trim();
    try {
      const saved = await api('/api/studio/settings/runninghub', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      show(saved); say(saved.message);
      // Open canvases pick up the new defaults without a reload.
      const message = {type: 'providers-changed', updated_at: Date.now()};
      if (parent !== window) parent.postMessage(message, location.origin);
      try { const channel = new BroadcastChannel('studio-api'); channel.postMessage(message); channel.close(); } catch {}
    } catch (error) { say(error.message, true); }
  });
  function row(label, text, ok) {
    const item = document.createElement('li'); item.dataset.ok = String(ok);
    item.append(Object.assign(document.createElement('span'), {textContent: label}), Object.assign(document.createElement('b'), {textContent: text}));
    return item;
  }
  // Each saved key is checked on its own, so a wallet key cannot hide a broken membership key.
  $('rhTest').addEventListener('click', async () => {
    const list = $('rhStages'); list.replaceChildren(); say('正在检查（只读取模型目录，不提交任务、不扣积分）…');
    try {
      const result = await api('/api/studio/settings/runninghub/test', {method: 'POST'});
      for (const check of result.checks || []) {
        if (!check.saved) { list.append(row(check.label, '未保存，不检查', true)); continue; }
        const stages = check.stages || {};
        for (const [key, label] of STAGES) {
          const value = stages[key];
          const ok = value === true || value === 'ok' || value === 'openapi';
          const text = key === 'auth' ? ({ok: '通过', failed: '未通过' + (stages.auth_status ? `（HTTP ${stages.auth_status}）` : ''), unverified: '未能核实'}[value] || '未检查')
            : key === 'catalog' ? ({openapi: '可读', github: '只读到公开目录'}[value] || '未读取')
            : (value ? '可达' : stages.reach === 'timeout' ? '超时' : '不可达');
          list.append(row(check.label + ' · ' + label, text, ok));
        }
      }
      say(result.message || (result.ok ? '连接正常。' : '连接未通过。'), !result.ok);
    } catch (error) { say(error.message, true); }
  });
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    panel.hidden = button.dataset.tab !== 'runninghub';
    if (!panel.hidden) load();
  }));
})();
