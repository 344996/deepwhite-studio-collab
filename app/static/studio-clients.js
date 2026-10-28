/* External agent clients (Settings → 外接智能体): connect MCP, copy a verification command, show verified state. */
(() => {
  'use strict';
  const grid = document.getElementById('clientGrid');
  if (!grid) return;
  const $ = id => document.getElementById(id);
  const manualSelect = $('clientManualSelect'), manualText = $('clientManualText');
  let data = null, busy = '';
  const ICONS = {codex: 'Cx', claude_code: 'CC', workbuddy: 'WB', doubao: '豆', deepseek_harness: 'DS'};

  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function say(message, error = false) {
    const box = $('clientResult');
    box.hidden = !message; box.textContent = message || ''; box.dataset.error = String(error);
  }
  async function api(url, body) {
    const options = body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)};
    const response = await fetch(url, options);
    let value;
    try { value = await response.json(); } catch { throw Error('本地服务返回异常，请稍后重试。'); }
    if (!response.ok) throw Error(typeof value.detail === 'string' ? value.detail : '操作未完成，请刷新后重试。');
    return value;
  }

  // U11: written configuration and a real round trip are different facts.
  function status(client) {
    const state = client.mcp.state, verified = client.verification?.verified_at;
    if (verified && (state === 'connected' || state === 'manual')) return ['已验证', 'ok'];
    if (state === 'connected') return ['已写入配置 · 待验证', 'warn'];
    if (state === 'blocked') return ['需处理', 'warn'];
    if (state === 'different') return ['需要更新', 'warn'];
    if (client.detectable === false) return ['不支持自动检测', 'idle'];
    if (!client.detected) return ['未检测到', 'off'];
    if (state === 'manual') return ['需在客户端里添加', 'idle'];
    return ['已安装 · 未连接', 'idle'];
  }
  function button(label, cls, onClick, attention = false) {
    const node = el('button', label, 'client-button ' + (cls || ''));
    node.type = 'button';
    if (attention) node.dataset.attention = 'true';
    node.disabled = Boolean(busy);
    node.addEventListener('click', onClick);
    return node;
  }

  async function act(client, action) {
    busy = client.id + ':' + action; render();
    try {
      const result = await api('/api/studio/clients/' + client.id, {action});
      const index = data.items.findIndex(item => item.id === client.id);
      if (index >= 0 && result.client) data.items[index] = result.client;
      say(result.message || (result.changed === false ? '已是最新状态，无需修改。' : '已完成。'));
      document.dispatchEvent(new CustomEvent('studio-clients-changed'));
    } catch (error) {
      say(error.message, true);
    } finally {
      busy = ''; render();
    }
  }
  async function copy(text, message) {
    try { await navigator.clipboard.writeText(text); say(message); }
    catch { say('无法访问剪贴板，请手动选择文字复制。', true); }
  }

  function card(client) {
    const [label, tone] = status(client);
    const node = el('article', undefined, 'client-card');
    node.dataset.client = client.id;
    node.dataset.tone = tone;
    const head = el('div', undefined, 'client-head');
    const icon = el('span', ICONS[client.id] || client.name.slice(0, 2), 'client-icon');
    icon.setAttribute('aria-hidden', 'true');
    const title = el('div', undefined, 'client-title');
    title.append(el('strong', client.name), el('span', label, 'client-pill'));
    head.append(icon, title);
    node.append(head);

    const actions = el('div', undefined, 'client-actions');
    const mcp = client.mcp.state;
    if (mcp === 'manual') {
      actions.append(button('复制连接配置', '', () => copy(client.manual.text, '已复制连接配置。粘贴到客户端的 MCP 设置后重启客户端。')));
    } else if (mcp === 'connected') {
      actions.append(button(busy === client.id + ':disconnect' ? '正在断开…' : '断开', '', () => act(client, 'disconnect')));
    } else if (client.detected || mcp === 'different') {
      actions.append(button(busy === client.id + ':connect' ? '正在连接…' : mcp === 'different' ? '更新连接' : '一键连接',
        'accent', () => act(client, 'connect'), mcp === 'different'));
    }
    const verification = client.verification;
    if (verification && (mcp === 'connected' || mcp === 'manual')) {
      actions.append(button('复制验证命令', '', () => copy(verification.command, '已复制验证命令。发给 ' + client.name + '，它读取画布后这里会显示“已验证”。')));
    }
    if (actions.childElementCount) node.append(actions);
    const hint = mcp === 'blocked' || mcp === 'manual' ? client.mcp.message
      : mcp === 'connected' && !verification?.verified_at ? '配置已写入，尚未确认能连上。' + (client.restart_hint || '') + ' 然后发送验证命令。'
      : verification?.verified_at ? '最近一次验证：' + new Date(verification.verified_at * 1000).toLocaleString() : '';
    if (hint) node.append(el('p', hint, 'client-hint'));
    return node;
  }

  function render() {
    if (!data) return;
    grid.replaceChildren(...data.items.map(card));
    const connected = data.items.filter(item => item.mcp.state === 'connected').map(item => item.name);
    $('clientSummary').textContent = connected.length ? '已连接：' + connected.join('、') : '还没有连接任何客户端。';
    const badge = $('controlCodexBadge'), step = $('controlStepCodex');
    if (badge) badge.textContent = connected.length ? `已连接 ${connected.length} 个` : '未连接';
    if (step) step.dataset.complete = String(connected.length > 0);
  }
  function showManual() {
    const client = data?.items.find(item => item.id === manualSelect.value);
    if (!client) return;
    manualText.textContent = client.manual.text;
    $('clientManualPath').textContent = client.mcp.config_path ? '配置文件：' + client.mcp.config_path
      : client.mcp.message || '';
  }
  async function copyManual() {
    try { await navigator.clipboard.writeText(manualText.textContent); say('已复制连接配置。粘贴到客户端后请重启该客户端。'); }
    catch { say('无法访问剪贴板，请手动选择配置文字复制。', true); }
  }

  async function load() {
    try {
      data = await api('/api/studio/clients');
      if (!manualSelect.options.length) {
        for (const client of data.items) manualSelect.append(new Option(client.name, client.id));
      }
      render(); showManual();
    } catch (error) {
      say(error.message, true);
    }
  }
  manualSelect.addEventListener('change', showManual);
  $('clientManualCopy').addEventListener('click', copyManual);
  $('clientRefresh').addEventListener('click', () => { say(''); load(); });
  const tab = document.querySelector('[data-tab="control"]');
  tab?.addEventListener('click', () => load());
  // The verification arrives from the agent, not from this page: look again while one is pending.
  setInterval(() => {
    if (document.hidden || busy || !grid.offsetParent) return;
    if (data?.items.some(item => ['connected', 'manual'].includes(item.mcp.state) && !item.verification?.verified_at)) load();
  }, 4000);
  load();
})();
