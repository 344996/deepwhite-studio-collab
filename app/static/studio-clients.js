/* External agent clients: connect MCP and install Skills per client (Settings → 外接智能体). */
(() => {
  'use strict';
  const grid = document.getElementById('clientGrid');
  if (!grid) return;
  const $ = id => document.getElementById(id);
  const manualSelect = $('clientManualSelect'), manualText = $('clientManualText');
  let data = null, busy = '';
  const ICONS = {codex: 'Cx', claude_code: 'CC', claude_desktop: 'Cl', workbuddy: 'WB', hermes: 'H', doubao: '豆'};

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

  function status(client) {
    const state = client.mcp.state;
    if (!client.detected && state !== 'connected') return ['未检测到', 'off'];
    if (state === 'manual') return ['需在客户端里添加', 'warn'];
    return ({connected: ['已连接', 'ok'], different: ['需要更新', 'warn'], blocked: ['需处理', 'warn']})[state] || ['未连接', 'idle'];
  }
  function skillBadge(client, skill) {
    if (!client.detected) return ['未检测到客户端', 'off'];
    if (skill.state === 'manual') return ['需手动上传', 'idle'];
    if (skill.state === 'latest') return ['最新 v' + skill.installed, 'ok'];
    if (skill.state === 'upgrade') return ['v' + skill.installed + ' → v' + skill.latest, 'warn'];
    if (skill.state === 'foreign') return ['同名文件夹 · v' + skill.latest, 'warn'];
    if (skill.state === 'damaged') return ['文件缺失 · 需修复', 'warn'];
    if (skill.state === 'modified') return ['已被修改 · v' + skill.installed, 'warn'];
    return ['未安装 · v' + skill.latest, 'idle'];
  }
  const NEEDS_INSTALL = ['upgrade', 'missing', 'foreign', 'damaged', 'modified'];
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
  function download(skill) {
    const link = document.createElement('a');
    link.href = '/api/studio/clients/skills/' + encodeURIComponent(skill.id) + '.zip';
    link.download = skill.id + '.zip';
    document.body.append(link); link.click(); link.remove();
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

    const list = el('ul', undefined, 'client-skills');
    for (const skill of client.skills) {
      const [text, skillTone] = skillBadge(client, skill);
      const row = el('li');
      row.append(el('span', skill.name, 'client-skill-name'), el('span', text, 'client-skill-badge'));
      row.lastChild.dataset.tone = skillTone;
      row.title = skill.description;
      list.append(row);
    }
    node.append(list);

    const actions = el('div', undefined, 'client-actions');
    const mcp = client.mcp.state;
    if (mcp === 'manual') {
      actions.append(button('复制连接配置', '', () => { manualSelect.value = client.id; showManual(); copyManual(); }));
    } else if (mcp === 'connected') {
      actions.append(button(busy === client.id + ':disconnect' ? '正在断开…' : '断开客户端', '', () => act(client, 'disconnect')));
    } else if (client.detected || mcp === 'different') {
      actions.append(button(busy === client.id + ':connect' ? '正在连接…' : mcp === 'different' ? '更新连接' : '连接客户端',
        mcp === 'different' ? 'accent' : '', () => act(client, 'connect'), mcp === 'different'));
    }
    const manualSkills = client.skills.some(skill => skill.state === 'manual');
    const needs = client.skills.filter(skill => NEEDS_INSTALL.includes(skill.state));
    if (manualSkills) {
      actions.append(button('下载 Skills', '', () => client.skills.forEach(download)));
    } else if (client.detected && needs.length) {
      const upgrade = needs.some(skill => skill.state === 'upgrade');
      const repair = !upgrade && needs.some(skill => skill.state === 'damaged' || skill.state === 'modified');
      actions.append(button(busy === client.id + ':install_skills' ? '正在安装…' : upgrade ? '升级 Skills' : repair ? '修复 Skills' : '安装 Skills',
        upgrade || repair ? 'danger' : '', () => act(client, 'install_skills'), upgrade || repair));
    }
    if (actions.childElementCount) node.append(actions);
    const hint = mcp === 'blocked' ? client.mcp.message : manualSkills && client.detected ? client.skills_hint : '';
    if (hint) node.append(el('p', hint, 'client-hint'));
    // Show where Skills go before anything is installed there.
    if (client.skills_path && client.detected && !manualSkills) node.append(el('p', 'Skills 位置：' + client.skills_path, 'client-hint client-path'));
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
  load();
})();
