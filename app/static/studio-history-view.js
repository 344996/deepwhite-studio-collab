/* Shared presentation for history. Canvas adapters own persistence and actions. */
(() => {
  'use strict';
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = '/static/studio-generation-history.css?v=0.11.0-studio.3';
  document.head.append(css);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const kinds = {image: '图片', video: '视频', audio: '音频', chat: '文本'};
  const views = new WeakMap();
  const icons = {
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
    video: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>',
    audio: '<path d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4"/>',
    chat: '<path d="M5 5h14M12 5v14M8 19h8"/>',
    failed: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  };
  function icon(name) {
    const span = element('span', 'studio-history-icon');
    span.setAttribute('aria-hidden', 'true');
    // Only fixed icon paths enter HTML; all record content uses textContent.
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + (icons[name] || icons.image) + '</svg>';
    return span;
  }
  function button(text, action, className) {
    const item = element('button', className, text);
    item.type = 'button';
    item.onclick = action;
    return item;
  }
  function copyButton(label, value) {
    const copy = button(label, async () => {
      try {
        const copied = await copyTextToClipboard(value);
        copy.textContent = copied === false ? '复制失败，请重试' : '已复制';
      } catch {copy.textContent = '复制失败，请重试';}
      setTimeout(() => {copy.textContent = label;}, 1600);
    });
    return copy;
  }
  function prepareMedia(media, source, fallback = '') {
    if (media.tagName === 'IMG') {
      media.loading = 'lazy'; media.decoding = 'async';
      if (/^\/(?:output|assets)\/.+\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?)(?:[?#]|$)/i.test(source)) {
        fallback = fallback || source;
        source = '/api/media-preview?w=768&url=' + encodeURIComponent(source);
      }
    } else {media.preload = 'none';}
    media.dataset.historySrc = source;
    media.dataset.historyFallback = fallback;
    media.addEventListener('error', () => {
      if (fallback && fallback !== media.getAttribute('src') && !media.dataset.historyFallbackTried) {
        media.dataset.historyFallbackTried = 'true'; media.src = fallback; return;
      }
      media.dispatchEvent(new Event('history-media-error'));
    });
  }
  function activateMedia(media) {
    if (!media.dataset.historySrc || media.hasAttribute('src')) return;
    if (media.tagName !== 'IMG') media.preload = 'metadata';
    media.src = media.dataset.historySrc;
  }
  function readableError(message) {
    const text = String(message || '');
    const bounds = /prompt length must be between (\d+) and (\d+) characters/i.exec(text);
    if (bounds) return `提示词长度需要在 ${bounds[1]}–${bounds[2]} 个字符之间。请调整后再生成。`;
    if (/insufficient|quota.*exceed|余额不足/i.test(text)) return '账户额度不足，请检查所选平台的余额。';
    if (/invalid.*api.?key|unauthorized|401/i.test(text)) return '生成授权无效或已过期，请到设置检查账户与 API 连接。';
    return text;
  }
  function mount(panel, body, {close, refresh} = {}) {
    panel.classList.add('studio-history-view');
    const head = element('header', 'studio-history-head');
    const title = element('div', 'studio-history-title');
    const titleText = element('div');
    titleText.append(element('strong', '', '生成记录'), element('small', '', '回看作品，继续创作。'));
    title.append(icon('image'), titleText);
    const actions = element('div', 'studio-history-head-actions');
    if (refresh) {
      const reload = button('刷新', refresh);
      reload.dataset.historyRefresh = '';
      actions.append(reload);
    }
    const exit = button('×', close, 'studio-history-close');
    exit.setAttribute('aria-label', '关闭生成记录');
    actions.append(exit);
    head.append(title, actions);
    const filters = element('div', 'studio-history-filters studio-smart-history-filters');
    const search = element('label', 'studio-history-search');
    search.append(icon('search'));
    const input = element('input');
    input.type = 'search';
    input.placeholder = '搜索提示词、模型、任务编号';
    input.setAttribute('aria-label', '搜索生成记录');
    input.dataset.historySearch = '';
    search.append(input);
    filters.append(search);
    for (const [key, label, choices] of [
      ['status', '生成状态', {'': '全部状态', succeeded: '已完成', failed: '生成失败', running: '生成中', queued: '排队中', paused: '等待查询', uncertain: '结果待核实', modal: '等待选区确认'}],
      ['period', '生成时间', {'0': '全部时间', '1': '最近 24 小时', '7': '最近 7 天', '30': '最近 30 天'}],
    ]) {
      const select = element('select');
      select.setAttribute('aria-label', '筛选' + label);
      select.dataset['history' + key[0].toUpperCase() + key.slice(1)] = '';
      for (const [value, text] of Object.entries(choices)) {
        const option = element('option', '', text); option.value = value; select.append(option);
      }
      filters.append(select);
    }
    const clear = button('重置', () => reset(panel), 'studio-history-reset');
    clear.hidden = true; filters.append(clear);
    const navigation = element('div', 'studio-history-navigation');
    const tabs = element('div', 'studio-history-types');
    tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '筛选生成类型');
    for (const [kind, text] of Object.entries({'': '全部', ...kinds})) {
      const tab = button(text, () => {panel.dataset.historyKind = kind; filter(panel);});
      tab.dataset.historyKind = kind;
      tab.setAttribute('aria-pressed', String(!kind));
      tabs.append(tab);
    }
    navigation.append(tabs, element('span', 'studio-history-sort', '最新在前'));
    const foot = element('footer', 'studio-history-foot');
    const count = element('span'); count.dataset.historyCount = ''; count.setAttribute('role', 'status');
    foot.append(count, element('span', '', '当前画布 · 费用以平台账单为准'));
    body.classList.add('studio-history-body');
    panel.prepend(head, filters, navigation);
    panel.append(foot);
    panel.dataset.historyKind = '';
    views.get(panel)?.observer?.disconnect();
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {activateMedia(entry.target); observer.unobserve(entry.target);}
    }, {root:body, rootMargin:'120px'}) : null;
    views.set(panel, {body, input, filters, count, observer});
    filters.addEventListener('input', () => filter(panel));
    filters.addEventListener('change', () => filter(panel));
    return head;
  }
  function reset(panel) {
    const view = views.get(panel); if (!view) return;
    view.input.value = '';
    view.filters.querySelector('[data-history-status]').value = '';
    view.filters.querySelector('[data-history-period]').value = '0';
    panel.dataset.historyKind = ''; filter(panel); view.input.focus();
  }
  function filter(panel) {
    const view = views.get(panel); if (!view) return;
    const query = view.input.value.trim().toLowerCase();
    const kind = panel.dataset.historyKind;
    const status = view.filters.querySelector('[data-history-status]').value;
    const days = Number(view.filters.querySelector('[data-history-period]').value);
    const cards = [...view.body.querySelectorAll(':scope > .studio-history-card')];
    let visible = 0;
    for (const card of cards) {
      card.hidden = Boolean(query && !card.dataset.search.includes(query) || kind && card.dataset.kind !== kind || status && card.dataset.status !== status || days && Number(card.dataset.created) < Date.now() / 1000 - days * 86400);
      if (!card.hidden) visible++;
    }
    for (const tab of panel.querySelectorAll('button[data-history-kind]')) tab.setAttribute('aria-pressed', String(tab.dataset.historyKind === kind));
    view.filters.querySelector('.studio-history-reset').hidden = !(query || kind || status || days);
    view.count.textContent = visible === cards.length ? `${cards.length} 条记录` : `${visible} / ${cards.length} 条记录`;
    const empty = view.body.querySelector('[data-history-empty]');
    if (empty) {
      empty.hidden = visible > 0;
      empty.querySelector('strong').textContent = cards.length ? '没有找到匹配的记录' : '第一份作品，从画布开始';
      empty.querySelector('p').textContent = cards.length ? '试试其他关键词，或清除筛选条件。' : '生成后的图片、视频、文本和任务状态会保存在这里。';
      empty.querySelector('button').hidden = !cards.length;
    }
  }
  function empty(panel) {
    const {body} = views.get(panel);
    const state = element('div', 'studio-history-empty');
    state.dataset.historyEmpty = '';
    state.append(icon('image'), element('strong'), element('p'), button('清除筛选', () => reset(panel)));
    body.append(state); filter(panel);
  }
  function loading(body) {
    const state = element('div', 'studio-history-empty studio-history-loading');
    state.setAttribute('role', 'status');
    state.append(icon('clock'), element('strong', '', '正在读取生成记录'), element('p', '', '作品和参数正在加载，请稍候。'));
    body.replaceChildren(state);
  }
  function loadError(body, message, retry) {
    const state = element('div', 'studio-history-empty studio-history-load-error');
    state.setAttribute('role', 'alert');
    state.append(icon('failed'), element('strong', '', '暂时无法读取记录'), element('p', '', message), button('重新加载', retry));
    body.replaceChildren(state);
  }
  function clear(panel) {
    const view = views.get(panel);
    view.observer?.disconnect(); view.body.replaceChildren();
  }
  function decorate(card, record, panel) {
    card.classList.add('studio-history-card');
    card.dataset.kind = record.kind;
    card.dataset.status = record.status;
    card.dataset.created = record.createdAt;
    card.dataset.search = [record.name, record.prompt, ...(record.taskIds || [])].join(' ').toLowerCase();
    const title = card.querySelector(':scope > strong');
    const meta = card.querySelector(':scope > small'); meta?.remove();
    const prompt = card.querySelector(':scope > p:not([class])');
    if (prompt) {
      prompt.className = 'studio-history-prompt';
      prompt.title = record.prompt;
      if (!prompt.textContent) prompt.textContent = '未记录提示词';
    }
    const heading = element('div', 'studio-history-card-heading');
    if (title) heading.append(title);
    const stage = element('div', 'studio-history-preview');
    const badge = element('small', 'studio-history-status', record.stateLabel);
    badge.dataset.state = record.status;
    stage.append(badge);
    const outputs = [...card.querySelectorAll(':scope > .studio-history-output')];
    if (outputs.length) {
      const media = outputs[0].querySelector('img,video,audio');
      if (media.tagName === 'IMG') {media.loading = 'lazy'; media.alt = record.prompt || '生成结果';}
      const error = element('div', 'studio-history-media-error');
      error.hidden = true; error.setAttribute('role', 'status');
      error.append(icon('image'), element('strong', '', '预览暂不可用'), element('span', '', '可重试预览，或下载原文件查看。'));
      error.append(button('重试预览', () => {
        error.hidden = true; media.hidden = false; delete media.dataset.historyFallbackTried;
        media.removeAttribute('src'); activateMedia(media);
      }));
      media.addEventListener('history-media-error', () => {media.hidden = true; error.hidden = false;});
      stage.append(media, error);
      const observer = views.get(panel)?.observer;
      if (observer) observer.observe(media); else activateMedia(media);
      const count = element('span', 'studio-history-output-count', (kinds[record.kind] || '作品') + (outputs.length > 1 ? ' · ' + outputs.length + ' 项' : ''));
      const preview = button('放大预览 ↗', () => window.StudioNodeComposer?.preview(record.outputs[0]), 'studio-history-preview-button');
      preview.setAttribute('aria-label', '预览 ' + record.name);
      stage.append(count, preview);
    } else if (record.text) {
      stage.classList.add('studio-history-text-preview');
      stage.append(element('span', 'studio-history-text-label', '文本结果'), element('p', '', record.text.slice(0, 360)));
    } else {
      stage.classList.add('studio-history-task-preview');
      const pending = ['running', 'queued', 'paused', 'uncertain', 'modal'].includes(record.status);
      stage.append(icon(record.status === 'failed' ? 'failed' : pending ? 'clock' : record.kind));
      stage.append(element('strong', '', record.status === 'failed' ? '这次创作未完成' : pending ? record.stateLabel : '暂无可预览的结果'));
      stage.append(element('span', '', record.status === 'failed' ? '查看原因后，可复用设置继续创作' : pending ? '任务记录已保留，可稍后查看结果' : '提示词和参数仍保留在详情中'));
    }
    const stamp = element('div', 'studio-history-stamp');
    const date = new Date(record.createdAt * 1000);
    const validDate = Number.isFinite(date.getTime()) && record.createdAt > 0;
    const time = element('time', '', validDate ? date.toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false}) : '时间未记录');
    if (validDate) {time.dateTime = date.toISOString(); time.title = date.toLocaleString();}
    stamp.append(time);
    const bill = card.querySelector(':scope > .studio-history-bill');
    if (bill) {bill.title = bill.textContent; stamp.append(bill);}
    const details = element('details', 'studio-history-details');
    details.append(element('summary', '', '提示词与参数详情'));
    const detailPrompt = element('div', 'studio-history-full-prompt');
    detailPrompt.append(element('strong', '', '完整提示词'), element('p', '', record.prompt || '未记录提示词'));
    details.append(detailPrompt);
    const tools = element('div', 'studio-history-detail-tools');
    if (record.prompt) tools.append(copyButton('复制提示词', record.prompt));
    const originalError = card.querySelector('.studio-history-error');
    if (originalError) tools.append(copyButton('复制原始错误', originalError.title || originalError.textContent));
    if (tools.children.length) details.append(tools);
    const params = card.querySelector(':scope > details');
    if (params) {const pre = params.querySelector('pre'); if (pre) details.append(pre); params.remove();}
    for (const extra of outputs.slice(1)) details.append(extra);
    details.addEventListener('toggle', () => {
      if (details.open) for (const media of details.querySelectorAll('img,video,audio')) activateMedia(media);
      else pauseMedia(details);
    });
    const text = card.querySelector(':scope > pre'); if (text) details.append(text);
    const actions = element('div', 'studio-history-card-actions studio-smart-history-actions');
    for (const action of [...card.querySelectorAll(':scope > button')]) actions.append(action);
    if (outputs[0]) {
      actions.prepend(...outputs[0].querySelectorAll('a,button'));
      outputs[0].remove();
    }
    for (const action of actions.children) if (action.textContent === '放入画布') action.classList.add('studio-history-primary');
    card.prepend(stage, heading);
    card.append(stamp, details, actions);
  }
  function pauseMedia(panel) {
    for (const media of panel.querySelectorAll('video,audio')) media.pause();
  }
  window.StudioHistoryView = Object.freeze({mount, decorate, filter, empty, loading, loadError, readableError, pauseMedia, prepareMedia, clear});
})();
