/* Versioned ComfyUI workspace. Preview and editing never submit a generation. */
(() => {
  'use strict';
  const API = '/api/studio/comfy';
  const providers = new Map();
  let capabilities = null;
  async function requireCapabilities() {
    if (capabilities) return capabilities;
    try {
      const value = await request('/workflow-capabilities');
      if (value.schema !== 1 || value.preview !== true || value.integer_wire !== 'decimal-string' || value.request_lookup !== true) throw Error('能力版本不匹配');
      return capabilities = value;
    } catch { throw Error('工作台服务需要重新启动后才能使用新功能；已有工作流仍可浏览。不会自动重启或提交。'); }
  }
  const DRAFT_KEY = 'deepwhite-comfy-workspace-drafts-v1';
  const ACTIVE = new Set(['submitting', 'queued', 'running', 'saving']);
  const PENDING = new Set([...ACTIVE, 'paused', 'uncertain']);
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const allNodes = () => typeof nodes !== 'undefined' ? nodes : window.nodes;
  const currentCanvas = () => typeof canvas !== 'undefined' ? canvas : window.canvas;
  const canvasId = () => String(currentCanvas()?.id || '');
  const uid = () => 'sw_' + crypto.randomUUID().replaceAll('-', '');
  const statusName = value => ({submitting:'正在提交',queued:'排队中',running:'运行中',saving:'结果保存中',paused:'已暂停',uncertain:'待核实',succeeded:'已完成',failed:'失败'}[value] || value || '未运行');
  const typeNames = {text:'文本',number:'数值',seed:'种子',bool:'开关',enum:'枚举',model:'模型',image:'图片',video:'视频',audio:'音频'};
  const labels = {text:'提示文字',prompt:'提示词',seed:'随机种子',steps:'采样步数',cfg:'引导强度',image:'参考图片',video:'参考视频',audio:'参考音频',filename_prefix:'保存名称',unet_name:'主模型'};
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/static/studio-workflows.css';
  document.head.append(css);

  // Preserve unsafe integer tokens before JSON.parse; strings, bool and decimals retain their types.
  function parseJSON(text) {
    let result = '', inString = false, escaped = false;
    for (let i = 0; i < text.length;) {
      const ch = text[i];
      if (inString) {
        result += ch; i++;
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; result += ch; i++; continue; }
      const token = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (token) {
        const value = token[0];
        if (/^-?\d+$/.test(value) && !Number.isSafeInteger(Number(value))) result += JSON.stringify(value);
        else {
          if (!Number.isFinite(Number(value)) || (/^[^\.]*[eE]/.test(value) && Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER)) throw Error('过大的指数数值无法精确读取，请使用十进制整数。');
          result += value;
        }
        i += value.length;
      } else { result += ch; i++; }
    }
    return JSON.parse(result);
  }

  async function request(path, method = 'GET', body, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(API + path, {method, signal:controller.signal,
        headers:body === undefined ? undefined : {'Content-Type':'application/json'},
        body:body === undefined ? undefined : JSON.stringify(body)});
      const data = parseJSON(await response.text());
      if (!response.ok) {
        const error = Error(typeof data.detail === 'string' ? data.detail : '工作流请求失败。');
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError' && !signal?.aborted) throw Error('请求超时，结果尚未确认；不会自动重复提交。');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const modal = document.createElement('dialog');
  modal.className = 'studio-workflow-modal';
  modal.setAttribute('aria-label', '工作流工作台');
  modal.innerHTML = `<header><div><small>深白片场 / 工作流</small><h2>工作流工作台</h2></div><button type="button" data-close aria-label="关闭工作流工作台">×</button></header>
    <div class="sw-body"><aside class="sw-sidebar"><div class="sw-side-title"><strong>我的工作流</strong><button type="button" data-import-open aria-label="导入工作流">＋</button></div>
    <input type="search" data-search aria-label="搜索工作流" placeholder="搜索工作流名称"><select data-provider-filter aria-label="来源筛选"><option value="all">全部已接入来源</option><option value="comfy">ComfyUI</option></select><select data-scope-filter aria-label="收藏筛选"><option value="all">全部工作流</option><option value="fav">只看收藏</option></select><div data-list></div><button type="button" data-refresh>刷新列表</button><p class="sw-tip">预览不写库。显式保存创建版本，画布旧节点保持原版本。</p></aside>
    <main><div class="sw-workflow-header"><div><small>ComfyUI 工作流</small><h3 data-heading>选择或导入工作流</h3><p data-version></p></div><button type="button" data-save class="primary" disabled>保存新版本</button></div>
    <nav class="sw-stages" aria-label="配置阶段"><button type="button" data-stage="connection"><span>1</span>连接来源</button><button type="button" data-stage="configure"><span>2</span>导入与配置</button><button type="button" data-stage="preview"><span>3</span>节点预览</button></nav>
    <div class="sw-work-area"><section class="sw-editor-panel"><div data-connection hidden></div><div data-editor></div><div data-history hidden></div></section>
    <aside class="sw-preview-panel"><div class="sw-section-heading"><h3>实时节点预览</h3><small>不运行</small></div><p class="sw-tip">临时调整预览值不会保存或生成。</p><div data-preview></div><div class="sw-preview-bottom"><p data-add-note></p><button type="button" data-add class="primary" disabled>添加画布节点</button></div></aside></div></main></div>
    <footer><div class="sw-footer-status"><span role="status" aria-live="polite"></span><span data-storage-warning role="alert" hidden></span></div><button type="button" data-export>导出配置草稿</button></footer>`;
  document.body.append(modal);

  const importDialog = document.createElement('dialog');
  importDialog.className = 'studio-workflow-subdialog';
  importDialog.setAttribute('aria-label', '导入 ComfyUI 工作流');
  importDialog.innerHTML = `<header><h3>导入工作流</h3><button type="button" data-cancel aria-label="关闭导入">×</button></header>
    <label>工作流来源<select data-import-provider aria-label="导入来源"><option value="comfy">ComfyUI</option></select></label><label data-kind-label hidden>来源类型<select data-kind aria-label="来源类型"></select></label><label data-source-label hidden>链接或应用 ID<input data-source aria-label="来源链接或ID"></label><label>工作流名称<input data-name aria-label="导入工作流名称"></label><label class="sw-file">读取 JSON 文件<input type="file" accept=".json,application/json"></label>
    <label>工作流 JSON<textarea data-json aria-label="工作流 JSON" rows="10" spellcheck="false" placeholder="粘贴 API JSON 或普通 ComfyUI 画布 JSON"></textarea></label>
    <p class="sw-tip">引擎会检查节点依赖并转换普通画布 JSON；本步骤仅预览，不创建工作流、不提交任务。</p><p data-error role="alert"></p>
    <footer><button type="button" data-cancel>取消</button><button type="button" data-import class="primary">导入并预览配置</button></footer>`;
  document.body.append(importDialog);
  const unsavedDialog = document.createElement('dialog');
  unsavedDialog.className = 'studio-workflow-subdialog';

  unsavedDialog.innerHTML = '<h3>保留未保存的配置？</h3><p>草稿只保存在本标签页，不创建版本，也不改写已有画布节点。</p><footer><button data-cancel>取消</button><button data-discard>放弃改动</button><button data-keep class="primary">保留草稿</button></footer>';
  document.body.append(unsavedDialog);

  let library = [], selected = null, stage = 'configure', info = null;
  let managerEpoch = 0, busy = false, pendingAction = null, previewValues = {};
  let drafts = {}, storageLocked = false, corruptDrafts = '', storageNotice = '';
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (!saved || saved.version !== 1 || !saved.drafts || typeof saved.drafts !== 'object' || Array.isArray(saved.drafts) || Object.values(saved.drafts).some(d => !d || typeof d.key !== 'string' || !Array.isArray(d.fields) || !Array.isArray(d.outputs) || !Array.isArray(d.versions))) throw Error('草稿格式无法识别');
      drafts = saved.drafts;
    }
  } catch (error) {
    storageLocked = true;
    try { corruptDrafts = sessionStorage.getItem(DRAFT_KEY) || ''; } catch {}
    storageNotice = '本标签页草稿存储不可读，原数据未覆盖。请导出当前配置；刷新可能无法恢复新改动。';
  }
  const $ = selector => modal.querySelector(selector);
  const flash = text => { $('footer [role=status]').textContent = text; };
  const dirty = () => Boolean(selected?.dirty);
  function storageWarning() {
    const warning = $('[data-storage-warning]'); warning.hidden = !storageNotice; warning.textContent = storageNotice;
  }
  function persistDrafts() {
    if (storageLocked) { storageWarning(); flash(storageNotice); return false; }
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({version:1,drafts}));
      storageNotice = ''; storageWarning();
      return true;
    } catch {
      storageNotice = '本标签页草稿未能保存，请导出配置。当前改动仍在窗口内，刷新可能丢失。';
      storageWarning(); flash(storageNotice);
      return false;
    }
  }
  function rememberDraft() {
    if (!selected) return;
    drafts[selected.key] = clone(selected);
    persistDrafts();
  }
  function markDirty() {
    if (!selected) return;
    selected.dirty = true;
    rememberDraft();
    renderMeta();
    renderPreview();
    renderList();
  }
  const disabledBeforeBusy = new WeakMap();
  function setBusy(value) {
    busy = value;
    modal.dataset.busy = String(value);
    modal.querySelectorAll('button, input, select, textarea').forEach(el => {
      if (value) { disabledBeforeBusy.set(el,el.disabled); el.disabled = true; }
      else if (disabledBeforeBusy.has(el)) { el.disabled = disabledBeforeBusy.get(el); disabledBeforeBusy.delete(el); }
    });
    if (!value) { renderMeta(); renderStage(); }
  }
  function chooseAction(action) {
    if (busy) return;
    if (!dirty()) return action();
    pendingAction = action;
    unsavedDialog.showModal();
  }
  unsavedDialog.querySelector('[data-cancel]').onclick = () => { pendingAction = null; unsavedDialog.close(); };
  unsavedDialog.querySelector('[data-discard]').onclick = () => {
    if (selected) delete drafts[selected.key];
    persistDrafts();
    const action = pendingAction;
    selected = null; previewValues = {};
    pendingAction = null; unsavedDialog.close(); action?.();
  };
  unsavedDialog.querySelector('[data-keep]').onclick = () => {
    rememberDraft();
    const action = pendingAction;
    pendingAction = null; unsavedDialog.close(); action?.();
  };
  unsavedDialog.addEventListener('cancel', () => { pendingAction = null; });

  function configureDialog(dialog, close) {
    let backdropDown = false;
    dialog.addEventListener('pointerdown', e => { backdropDown = e.target === dialog && outside(e, dialog); });
    dialog.addEventListener('click', e => {
      const backdrop = backdropDown && e.target === dialog && outside(e, dialog);
      backdropDown = false;
      if (backdrop) close();
    });
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dialog.addEventListener('keydown', e => e.stopPropagation());
  }
  function outside(event, el) {
    const r = el.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  }
  const closeManager = () => chooseAction(() => { managerEpoch++; modal.close(); });
  $('[data-close]').onclick = closeManager;
  configureDialog(modal, closeManager);
  configureDialog(importDialog, () => { if (!busy) importDialog.close(); });
  importDialog.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { if (!busy) importDialog.close(); });
  modal.addEventListener('close', () => { managerEpoch++; });
  for (const event of ['pointerdown','mousedown','keydown','wheel']) modal.addEventListener(event, e => e.stopPropagation());

  let libraryErrors = [];
  async function refresh() {
    const sources = [['comfy',{label:'ComfyUI',list:() => request('/workflows')}],...providers.entries()];
    const results = await Promise.allSettled(sources.map(async ([id,adapter]) => {
      const value = await adapter.list();
      return (value.items || []).map(item => ({...item,provider:id,key:id === 'comfy' ? item.id : id + ':' + item.id}));
    }));
    const next = []; libraryErrors = [];
    results.forEach((result,index) => {
      const [id,adapter] = sources[index];
      if (result.status === 'fulfilled') next.push(...result.value);
      else { next.push(...library.filter(item => item.provider === id)); libraryErrors.push(adapter.label + ' 工作流读取失败：' + result.reason.message); }
    });
    library = next; renderList();
  }
  // UX03: favourites are listed first and can be shown alone; kept on the server like model favourites.
  let favorites = new Set();
  fetch('/api/studio/model-favorites').then(r => r.ok ? r.json() : {}).then(v => { favorites = new Set(v.workflow || []); renderList(); }).catch(() => {});
  const favKey = item => (item.provider || 'comfy') + '|' + item.key;
  function toggleFavorite(item) {
    const key = favKey(item); favorites.has(key) ? favorites.delete(key) : favorites.add(key);
    fetch('/api/studio/model-favorites/workflow', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({keys: [...favorites]})}).catch(() => {});
    renderList();
  }
  function renderList() {
    const host = $('[data-list]');
    const q = $('[data-search]').value.trim().toLowerCase(), filter = $('[data-provider-filter]').value, scope = $('[data-scope-filter]').value;
    host.replaceChildren();
    for (const message of libraryErrors) { const warning = document.createElement('p'); warning.className = 'sw-tip'; warning.setAttribute('role','alert'); warning.textContent = message; host.append(warning); }
    const items = [...library,
      ...Object.values(drafts).filter(d => !d.id).map(d => ({key:d.key,name:d.name,provider:d.provider || 'comfy',revision:0,fields:d.fields,dirty:true}))];
    const shown = items.filter(item => String(item.name).toLowerCase().includes(q) && (filter === 'all' || item.provider === filter) && (scope !== 'fav' || favorites.has(favKey(item))));
    shown.sort((a, b) => favorites.has(favKey(b)) - favorites.has(favKey(a)));
    for (const item of shown) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'sw-item'; button.dataset.workflowId = item.key;
      button.setAttribute('aria-current', String(selected?.key === item.key));
      const title = document.createElement('strong'), meta = document.createElement('small');
      title.textContent = item.name;
      meta.textContent = (item.revision ? 'v' + item.revision : '未保存') + (drafts[item.key]?.dirty ? ' · 草稿' : '') + ' · ' + (item.fields?.length || 0) + ' 个参数';
      button.append(title,meta);
      button.onclick = () => chooseAction(() => openWorkflow(item.key));
      const star = document.createElement('button'), starred = favorites.has(favKey(item));
      star.type = 'button'; star.className = 'sw-star'; star.textContent = starred ? '★' : '☆'; star.setAttribute('aria-pressed', String(starred));
      star.setAttribute('aria-label', (starred ? '取消收藏：' : '收藏：') + item.name); star.onclick = () => toggleFavorite(item);
      const row = document.createElement('div'); row.className = 'sw-item-row'; row.append(button, star);
      host.append(row);
    }
    if (!host.children.length) host.textContent = scope === 'fav' ? '还没有收藏的工作流：点工作流右侧的 ☆ 收藏。' : q ? '没有匹配的工作流。' : '暂无工作流。导入 JSON 后先预览，再保存。';
  }
  $('[data-search]').oninput = renderList;
  $('[data-provider-filter]').onchange = renderList;
  $('[data-scope-filter]').onchange = renderList;
  $('[data-refresh]').onclick = () => refresh().catch(e => flash(e.message));
  async function ensureInfo(force = false) {
    if (force) info = null;
    if (!info) info = await request('/object-info');
    return info;
  }
  window.addEventListener('studio-comfy-ready', () => { info = null; });
  function guessType(key, schema, value) {
    if (Array.isArray(schema?.[0]) || Array.isArray(schema?.[1]?.options)) return 'enum';
    if (key === 'seed' || key.endsWith('_seed')) return 'seed';
    if (typeof value === 'boolean' || /BOOL/.test(String(schema?.[0]))) return 'bool';
    if (/^(INT|INTEGER|FLOAT|NUMBER)$/.test(String(schema?.[0]).toUpperCase()) || typeof value === 'number') return 'number';
    if (/unet|checkpoint|clip|vae|model/i.test(key)) return 'model';
    return ({IMAGE:'image',VIDEO:'video',AUDIO:'audio'}[String(schema?.[0]).toUpperCase()]) || 'text';
  }
  function isLink(value) { return Array.isArray(value); }
  function fieldsFrom(version) {
    const bindings = new Map((version.bindings || []).map(f => [f.node_id + ':' + f.input, f]));

    const result = [];
    for (const [nodeId,node] of Object.entries(version.prompt || {})) {
      const schemas = {...info?.[node.class_type]?.input?.required, ...info?.[node.class_type]?.input?.optional};
      const keys = new Set([...Object.keys(node.inputs || {}),...Object.keys(schemas)]);
      for (const key of keys) {
        const value = node.inputs?.[key], schema = schemas[key], id = nodeId + ':' + key, prior = bindings.get(id);
        if (isLink(value) || (!prior && value === undefined && !['IMAGE','VIDEO','AUDIO'].includes(schema?.[0]))) continue;
        if (!prior && value !== undefined && !['string','number','boolean'].includes(typeof value)) continue;
        const type = prior?.type || guessType(key,schema,value);
        const choices = prior?.values || (Array.isArray(schema?.[0]) ? schema[0] : schema?.[1]?.options) || [];
        result.push({id,node_id:nodeId,input:key,label:prior?.label || labels[key] || key,type,
          default:type === 'seed' ? String(prior?.default ?? value ?? '0') : prior?.default ?? value ?? '',
          enabled:Boolean(prior),values:clone(choices),classType:node.class_type,schema:clone(schema || []),
          ...Object.fromEntries(['required','min','max','step'].filter(key => prior && Object.hasOwn(prior,key)).map(key => [key,clone(prior[key])]))});
      }
    }
    // Preserve binding order across versions, including fields absent from object_info while offline.
    const originalOrder = new Map(result.map((field,index) => [field.id,index]));
    return result.sort((a,b) => {
      const order = [...bindings.keys()];
      return (bindings.has(a.id) ? order.indexOf(a.id) : order.length + originalOrder.get(a.id)) -
        (bindings.has(b.id) ? order.indexOf(b.id) : order.length + originalOrder.get(b.id));
    });
  }
  function configFrom(wf, key) {
    const version = wf.versions.at(-1);
    return {provider:'comfy',key:key || wf.id || uid(),id:wf.id || null,name:wf.name,baseRevision:wf.id ? version.revision : 0,
      prompt:clone(version.prompt),fields:fieldsFrom(version),outputs:clone(version.outputs || []).map(o => ({...o,selected:true})),dirty:!wf.id,versions:clone(wf.versions)};
  }
  async function openWorkflow(id) {
    const epoch = ++managerEpoch;
    try {
      if (drafts[id]) { selected = clone(drafts[id]); previewValues = {}; renderAll(); return; }
      const item = library.find(item => item.key === id);
      const provider = item?.provider || 'comfy';
      const adapter = providers.get(provider);
      const wf = adapter ? await adapter.get(item.id) : (await Promise.all([request('/workflows/' + encodeURIComponent(id)),ensureInfo().catch(() => null)]))[0];
      if (epoch !== managerEpoch || !modal.open) return;
      const config = adapter ? adapter.toConfig(wf) : null;
      selected = adapter ? {...config,provider,key:provider + ':' + wf.id,dirty:!config.id || Boolean(config.dirty)} : configFrom(wf);
      if (selected.dirty) rememberDraft();
      previewValues = {}; renderAll();
    } catch (e) { if (epoch === managerEpoch && modal.open) flash(e.message); }
  }
  function renderMeta() {
    $('.sw-workflow-header small').textContent = providers.get(selected?.provider)?.label || 'ComfyUI 工作流';
    $('[data-heading]').textContent = selected?.name || '选择或导入工作流';
    $('[data-version]').textContent = selected ? (selected.baseRevision ? '当前 v' + selected.baseRevision + ' · ' : '') + (dirty() ? '未保存的配置草稿' : '已保存；旧节点固定原版本') : '预览不写库；保存后才能添加固定版本节点';
    $('[data-save]').disabled = busy || !selected || !dirty();
    const canCreate = selected?.provider !== 'comfy' || typeof window.addComfyNode === 'function';
    $('[data-add]').disabled = busy || !selected || dirty() || !selected.id || !canCreate;
    $('[data-add]').textContent = dirty() ? '保存后添加' : '添加画布节点';
    $('[data-add-note]').textContent = dirty() ? '先保存当前配置，避免添加时丢失改动。' : selected ? '添加后固定到 v' + selected.baseRevision + '；不会运行工作流。' : '选择已保存的工作流。';
    if (selected && !canCreate) $('[data-add-note]').textContent = '当前智能画布暂不支持新增此节点。可管理与预览，请在经典画布中添加。';
  }
  function renderStage() {
    $('[data-connection]').hidden = stage !== 'connection';
    $('[data-editor]').hidden = stage !== 'configure';
    $('[data-history]').hidden = stage !== 'preview';
    modal.querySelectorAll('[data-stage]').forEach(b => b.setAttribute('aria-current', String(b.dataset.stage === stage)));
  }
  modal.querySelectorAll('[data-stage]').forEach(b => b.onclick = () => { stage = b.dataset.stage; renderStage(); if (stage === 'connection') renderConnection(); });
  function renderAll() {
    storageWarning(); renderMeta(); renderEditor(); renderPreview(); renderHistory(); renderList(); renderStage();
    flash(storageNotice || (selected ? (dirty() ? '当前配置为草稿，尚未创建版本。' : '当前工作流已保存为 v' + selected.baseRevision + '。') : '选择或导入一个工作流。'));
  }
  function labeled(title, control) {
    const label = document.createElement('label'), text = document.createElement('span');
    text.textContent = title; label.append(text,control); return label;
  }
  function valueControl(field, value, onChange) {
    let el;
    if (field.type === 'enum') {
      el = document.createElement('select');
      for (const option of field.values || []) {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(option); opt.textContent = String(option); el.append(opt);
      }
      el.value = JSON.stringify(value);
      if (el.selectedIndex < 0 && el.options.length) el.selectedIndex = 0;
    } else if (field.type === 'bool') {
      el = document.createElement('input'); el.type = 'checkbox'; el.checked = Boolean(value);
    } else {
      el = document.createElement(field.type === 'text' ? 'textarea' : 'input');
      if (field.type === 'text') el.rows = 2;
      else { el.type = 'text'; if (['number','seed'].includes(field.type)) el.inputMode = field.type === 'seed' ? 'numeric' : 'decimal'; }
      el.value = value ?? '';
    }
    el.dataset.default = '';
    el.setAttribute('aria-label', field.label);
    const getValue = () => {
      if (field.type === 'bool') return el.checked;
      if (field.type === 'enum') return parseJSON(el.value);
      if (field.type === 'seed') {
        if (!/^-?\d+$/.test(el.value.trim())) throw Error(field.label + '需要十进制整数。');
        return el.value.trim();
      }
      if (field.type === 'number') {
        const raw = el.value.trim();
        if (!raw) throw Error(field.label + '需要数值。');
        if (/^-?\d+$/.test(raw) && !Number.isSafeInteger(Number(raw))) return raw;
        const value = Number(raw);
        if (!Number.isFinite(value)) throw Error(field.label + '需要有限数值。');
        return value;
      }
      return el.value;
    };
    el.addEventListener(field.type === 'bool' || field.type === 'enum' ? 'change' : 'input', () => {
      try { const v = getValue(); el.setCustomValidity(''); onChange?.(v); }
      catch (e) { el.setCustomValidity(e.message); flash(e.message); }
    });
    el.workflowValue = getValue;
    return el;
  }
  function renderEditor() {
    const host = $('[data-editor]'); host.replaceChildren();
    if (!selected) { host.textContent = '导入 API JSON 或普通 ComfyUI 画布 JSON，先检查依赖再配置。'; return; }
    const name = document.createElement('input'); name.value = selected.name; name.dataset.title = '';
    name.setAttribute('aria-label','工作流名称');
    name.oninput = () => { selected.name = name.value; markDirty(); };
    const title = labeled('工作流名称',name); title.className = 'sw-title'; host.append(title);

    const tip = document.createElement('p'); tip.className = 'sw-tip';
    tip.textContent = '只暴露节点需要的输入。连线保留在原图中，不作为可编辑参数。技术标识收纳在详情内。';
    host.append(tip);
    selected.fields.forEach((field,index) => {
      const row = document.createElement('section'); row.className = 'sw-field'; row.dataset.key = field.id;
      const head = document.createElement('div'); head.className = 'sw-field-head';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = field.enabled; check.dataset.enabled = '';
      check.onchange = () => { field.enabled = check.checked; row.classList.toggle('is-disabled',!field.enabled); markDirty(); };
      const enable = labeled('暴露到节点',check); enable.className = 'sw-check';
      const order = document.createElement('div'); order.className = 'sw-order';
      for (const [delta,label] of [[-1,'上移'],[1,'下移']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.disabled = index + delta < 0 || index + delta >= selected.fields.length;
        button.onclick = () => {
          const next = index + delta;
          [selected.fields[index],selected.fields[next]] = [selected.fields[next],selected.fields[index]];
          markDirty(); renderEditor();
        };
        order.append(button);
      }
      head.append(enable,order);
      const controls = document.createElement('div'); controls.className = 'sw-controls';
      const name = document.createElement('input'); name.value = field.label; name.dataset.label = '';
      name.oninput = () => { field.label = name.value; markDirty(); };
      const type = document.createElement('select'); type.dataset.type = '';
      for (const [value,label] of Object.entries(typeNames)) { const opt = document.createElement('option'); opt.value = value; opt.textContent = label; type.append(opt); }
      type.value = field.type;
      type.onchange = () => { field.type = type.value; if (field.type === 'seed') field.default = String(field.default); markDirty(); renderEditor(); };
      controls.append(labeled('中文名称',name),labeled('参数类型',type));
      const defaults = document.createElement('div'); defaults.className = 'sw-default';
      if (field.type === 'enum') {
        const choices = document.createElement('textarea'); choices.rows = 2; choices.dataset.values = '';
        choices.value = JSON.stringify(field.values); choices.setAttribute('aria-label','枚举选项（JSON）');
        choices.onchange = () => {
          try {
            const values = parseJSON(choices.value);
            if (!Array.isArray(values) || !values.length || values.some(v => !['string','number','boolean'].includes(typeof v))) throw Error('枚举需要非空 JSON 数组，可保留数值或开关类型。');
            field.values = values;
            if (!values.some(v => Object.is(v,field.default))) field.default = values[0];
            markDirty(); renderEditor();
          } catch (e) { flash(e.message); }
        };
        defaults.append(labeled('枚举选项（JSON）',choices));
      }
      defaults.append(labeled('默认值',valueControl(field,field.default,v => { field.default = v; markDirty(); })));
      const detail = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('p');
      summary.textContent = '节点与输入标识'; body.textContent = field.classType + ' · 节点 ' + field.node_id + ' · ' + field.input;
      detail.append(summary,body); row.append(head,controls,defaults,detail); row.classList.toggle('is-disabled',!field.enabled); host.append(row);
    });
    const outputs = document.createElement('section'); outputs.className = 'sw-outputs';
    const heading = document.createElement('h3'); heading.textContent = '结果输出'; outputs.append(heading);
    for (const output of selected.outputs) {
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = output.selected; check.dataset.outputCheck = '';
      check.onchange = () => { output.selected = check.checked; markDirty(); };
      const label = labeled(output.name + ' · ' + typeNames[output.type],check);
      label.dataset.node = output.node_id; label.dataset.type = output.type; label.className = 'sw-check'; outputs.append(label);
    }
    if (!selected.outputs.length) outputs.append(document.createTextNode(selected.provider === 'comfy' ? '未识别到可保存的媒体输出。' : 'RH 结果由原任务响应提供，不在这里伪造本地输出节点定义。'));
    host.append(outputs);
    if (selected.id && selected.provider === 'comfy') {
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除工作流'; remove.className = 'sw-delete';
      remove.onclick = async () => {
        if (!confirm('删除工作流及其版本后，原画布节点将无法读取对应版本。是否删除？')) return;
        const id = selected.id; setBusy(true);
        try { await request('/workflows/' + id,'DELETE'); delete drafts[id]; selected = null; persistDrafts(); await refresh(); renderAll(); flash('工作流已删除。'); }
        catch (e) { flash(e.message); } finally { setBusy(false); }
      };
      host.append(remove);
    }
  }
  function renderPreview() {
    const host = $('[data-preview]'); host.replaceChildren();
    if (!selected) { host.textContent = '选择工作流后显示参数节点。'; return; }
    const heading = document.createElement('h3'); heading.textContent = selected.name;
    const meta = document.createElement('small'); meta.textContent = (dirty() ? '草稿预览' : '固定 v' + selected.baseRevision) + ' · 不提交任务';
    host.append(heading,meta);
    for (const field of selected.fields.filter(f => f.enabled)) {
      const input = valueControl(field,Object.hasOwn(previewValues,field.id) ? previewValues[field.id] : field.default,v => { previewValues[field.id] = v; });
      host.append(labeled(field.label,input));
    }
    if (!selected.fields.some(f => f.enabled)) host.append(document.createTextNode('尚未暴露参数。'));
  }
  function renderHistory() {
    const host = $('[data-history]'); host.replaceChildren();
    const p = document.createElement('p'); p.className = 'sw-tip'; p.textContent = '每个画布节点固定保存版本。修改并保存工作流会创建新版本，不静默改变旧节点。添加后请在画布节点中提交。'; host.append(p);
    for (const version of [...(selected?.versions || [])].reverse()) {
      const row = document.createElement('div'); row.className = 'sw-version-row';
      const rhFields = version.definition?.entry?.fields;
      row.textContent = '本地配置 v' + version.revision + ' · ' + (selected.provider === 'comfy' ? (version.bindings || []).length + ' 个参数 · ' + (version.outputs || []).length + ' 个输出' : (rhFields || []).filter(f => f.enabled !== false).length + ' 个参数 · 结果由原任务响应提供');
      host.append(row);
    }
  }
  async function renderConnection() {
    const host = $('[data-connection]');
    const adapter = providers.get(selected?.provider);
    if (adapter) {
      host.replaceChildren();
      const title = document.createElement('h3'); title.textContent = adapter.label;
      const message = document.createElement('p'); message.className = 'sw-tip'; message.textContent = '使用已配置的来源。此处不提交生成。';
      host.append(title,message);
      try { const value = await adapter.connection?.(); if (value) message.textContent = value.message; } catch (e) { message.textContent = e.message; }
      if (adapter.openSettings) { const button = document.createElement('button'); button.textContent = '打开来源设置'; button.onclick = adapter.openSettings; host.append(button); }
      return;
    }

    host.innerHTML = '<h3>连接来源</h3><p class="sw-tip">使用应用已配置的 ComfyUI 服务。测试只读取服务状态与节点清单，不执行生成、不安装依赖。</p><p data-connection-status role="status">正在读取连接状态…</p><div class="sw-actions"><button data-connection-test>测试连接</button><button data-connection-settings>打开 ComfyUI 设置</button></div>';
    const state = host.querySelector('[data-connection-status]');
    const test = async () => {
      const epoch = managerEpoch; host.querySelector('[data-connection-test]').disabled = true;
      try {
        const response = await fetch('/api/studio/local-engine', {signal:AbortSignal.timeout(15000)});
        const result = parseJSON(await response.text());
        if (!response.ok) throw Error(result.detail || '读取连接失败。');
        await ensureInfo(true);
        if (epoch === managerEpoch && modal.open) state.textContent = (result.state === 'ready' ? '已连接' : '服务状态：' + result.state) + ' · ' + (result.base_url || '') + (result.message ? ' · ' + result.message : '');
      } catch (e) { if (epoch === managerEpoch && modal.open) state.textContent = '连接或节点依赖检查失败：' + e.message; }
      finally { if (host.isConnected) host.querySelector('[data-connection-test]').disabled = false; }
    };
    host.querySelector('[data-connection-test]').onclick = test;
    host.querySelector('[data-connection-settings]').onclick = () => window.StudioLocalEngine?.open();
    await test();
  }

  function bindings() {
    return selected.fields.filter(f => f.enabled).map(f => ({id:f.id,node_id:f.node_id,input:f.input,label:f.label || f.input,type:f.type,default:clone(f.default),...Object.fromEntries(['required','min','max','step'].filter(key => Object.hasOwn(f,key)).map(key => [key,clone(f[key])])),...(f.type === 'enum' ? {values:clone(f.values)} : {})}));
  }
  async function saveVersion() {
    if (!selected || busy) return;
    for (const input of $('[data-editor]').querySelectorAll('input,textarea')) if (!input.checkValidity()) { input.reportValidity(); return; }
    const origin = selected;
    const body = {name:origin.name,bindings:bindings(),outputs:origin.outputs.filter(o => o.selected).map(o => ({node_id:o.node_id,type:o.type}))};
    const adapter = providers.get(origin.provider);
    if (!adapter) {
      if (origin.id) { body.expected_revision = origin.baseRevision; body.prompt = clone(origin.prompt); }
      else body.workflow = clone(origin.prompt);
    }
    setBusy(true);
    try {
      if (!adapter) await requireCapabilities();
      const wf = adapter ? await adapter.saveVersion(clone(origin)) : await request(origin.id ? '/workflows/' + origin.id : '/workflows/import', origin.id ? 'PUT' : 'POST', body);
      delete drafts[origin.key]; persistDrafts();
      selected = adapter ? {...adapter.toConfig(wf),provider:origin.provider,key:origin.provider + ':' + wf.id,dirty:false} : configFrom(wf); previewValues = {}; workflowCache.clear();
      await refresh(); renderAll(); flash('已保存版本 ' + selected.baseRevision + '；旧画布节点保持原版本。');
    } catch (e) { flash('保存失败，草稿保留：' + e.message); }
    finally { setBusy(false); }
  }
  $('[data-save]').onclick = saveVersion;
  $('[data-export]').onclick = () => {
    const blob = new Blob([JSON.stringify({format:'deepwhite-comfy-workspace-drafts-v1',drafts,selected,unreadableOriginal:corruptDrafts || undefined},null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'comfy-workflow-drafts.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
    flash('已导出配置草稿；不包含画布任务或连接密钥。');
  };
  function openImport() { if (!busy) importDialog.showModal(); }
  $('[data-import-open]').onclick = openImport;
  importDialog.querySelector('input[type=file]').onchange = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 12 * 1024 * 1024) { importDialog.querySelector('[data-error]').textContent = 'JSON 超过 12 MB。'; return; }
    importDialog.querySelector('[data-json]').value = await file.text();
    importDialog.querySelector('[data-name]').value = file.name.replace(/\.json$/i,'');
  };
  importDialog.querySelector('[data-import]').onclick = async () => {
    if (busy) return;
    const error = importDialog.querySelector('[data-error]');
    let raw;
    try {
      const text = importDialog.querySelector('[data-json]').value || (importDialog.querySelector('[data-import-provider]').value !== 'comfy' ? '{}' : '');
      if (text.length > 12 * 1024 * 1024) throw Error('JSON 超过 12 MB。');
      raw = parseJSON(text);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('工作流 JSON 必须是对象。');
    } catch (e) { error.textContent = '无法读取 JSON：' + e.message; return; }
    const provider = importDialog.querySelector('[data-import-provider]').value, adapter = providers.get(provider);
    const button = importDialog.querySelector('[data-import]'); button.disabled = true; busy = true;
    try {
      const payload = {workflow:raw,name:importDialog.querySelector('[data-name]').value || '导入的工作流',kind:importDialog.querySelector('[data-kind]').value,source:importDialog.querySelector('[data-source]').value};
      if (!adapter) await requireCapabilities();
      const wf = adapter ? await adapter.previewImport(payload) : await request('/workflows/preview','POST',payload);
      if (!adapter) await ensureInfo();
      const draft = adapter ? {...adapter.toConfig(wf),provider,key:provider + ':' + uid(),id:null,baseRevision:0,dirty:true} : configFrom(wf);
      importDialog.close(); busy = false;
      chooseAction(() => { managerEpoch++; selected = draft; previewValues = {}; stage = 'configure'; rememberDraft(); renderAll(); flash('已检查并导入为草稿，尚未写入工作流库。'); });
    } catch (e) { error.textContent = '预览失败：' + e.message; }
    finally { button.disabled = false; busy = false; }
  };

  async function createCanvasNode(wf, version) {
    await requireCapabilities();
    const origin = currentCanvas();
    if (!origin?.id) throw Error('请先打开画布，再添加工作流节点。');
    if (typeof window.addComfyNode !== 'function') throw Error('当前画布暂不支持新增此节点，请在经典画布中添加。');
    let node;
    if (typeof window.addComfyNode === 'function') node = window.addComfyNode();
    if (!node) throw Error('当前页面无法创建 ComfyUI 节点。');
    Object.assign(node,{mode:'custom',studioWorkflowId:wf.id,studioWorkflowRevision:version.revision,studioWorkflowName:wf.name,
      comfyWorkflow:wf.id,comfyParams:Object.fromEntries((version.bindings || []).map(f => [f.id,clone(f.default)]))});
    window.render?.();
    if (!window.StudioSave?.ensureCurrent) throw Error('保存保护尚未就绪，节点尚未确认保存。');
    await window.StudioSave.ensureCurrent({canvasId:String(origin.id),nodeId:node.id});
    if (currentCanvas() !== origin || !allNodes()?.includes(node)) throw Error('画布已切换，未确认当前节点保存。');
    return node;
  }
  $('[data-add]').onclick = async () => {
    if (!selected?.id || dirty() || busy) return;
    const version = selected.versions.find(v => v.revision === selected.baseRevision);
    setBusy(true);
    try {
      const adapter = providers.get(selected.provider);
      if (adapter) await adapter.createNode({id:selected.id,name:selected.name,versions:selected.versions,definition:selected.definition},version.revision);
      else await createCanvasNode({id:selected.id,name:selected.name},version);

      modal.close(); window.setStatus?.('已添加固定本地配置 v' + version.revision + ' 的 ' + (adapter?.label || 'ComfyUI') + ' 节点；尚未运行。');
    } catch (e) { flash(e.message); }
    finally { setBusy(false); }
  };
  async function openManager() {
    if (!modal.open) modal.showModal();
    if (!selected) renderAll();
    const epoch = ++managerEpoch;
    const results = await Promise.allSettled([refresh(),ensureInfo()]);
    if (epoch !== managerEpoch || !modal.open) return;
    if (!selected) {
      const draft = Object.values(drafts).find(d => d.dirty);
      if (draft) { selected = clone(draft); renderAll(); }
      else {
        const saved = library.find(item => item.revision > 0 && !item.legacy);
        if (saved) await openWorkflow(saved.key); else renderAll();
      }
    } else renderAll();
    const failure = results.find(r => r.status === 'rejected');
    if (failure) flash('已保存工作流可继续查看；连接检查失败：' + failure.reason.message);
  }

  // Node tasks: one owner, one immutable request and one poll loop per node.
  const workflowCache = new Map(), flights = new WeakMap(), polls = new WeakMap(), contexts = new Set();
  function loadNodeWorkflow(node) {
    const id = node.studioWorkflowId, revision = node.studioWorkflowRevision, key = id + ':' + revision;
    if (!workflowCache.has(key)) {
      const promise = request('/workflows/' + encodeURIComponent(id)).then(wf => {
        const version = wf.versions.find(v => v.revision === revision);
        if (!version) throw Error('此节点固定的工作流版本不存在。');
        return {wf,version};
      });
      workflowCache.set(key,promise);
      promise.catch(() => { if (workflowCache.get(key) === promise) workflowCache.delete(key); });
    }
    return workflowCache.get(key);
  }
  function owned(ctx) {
    return (!ctx.node.studioHistoryRestored || ctx.explicit) && currentCanvas() === ctx.canvas && canvasId() === ctx.canvasId && allNodes()?.includes(ctx.node) &&
      ctx.node.studioWorkflowRequestId === ctx.requestId && ctx.node.studioWorkflowId === ctx.workflowId &&
      ctx.node.studioWorkflowRevision === ctx.revision && (!ctx.taskId || ctx.node.studioWorkflowTaskId === ctx.taskId);
  }
  const allConnections = () => typeof connections !== 'undefined' ? connections : window.connections || [];
  function prepareOutput(node) {
    const output = typeof outputForNode === 'function' ? outputForNode(node,480) : null;
    return output ? {id:output.id} : null;
  }
  function contextFor(node,explicit = false) {
    const target = node.studioWorkflowSubmission?.output;
    const output = target ? allNodes()?.find(n => n.id === target.id && n.type === 'output') : null;
    const edge = output ? allConnections().find(c => c.from === node.id && c.to === output.id) : null;
    return {canvas:currentCanvas(),canvasId:canvasId(),node,output,edge,explicit,workflowId:node.studioWorkflowId,revision:node.studioWorkflowRevision,
      requestId:node.studioWorkflowRequestId,body:clone(node.studioWorkflowSubmission?.request || {}),taskId:node.studioWorkflowTaskId || '',controller:new AbortController()};
  }
  function saveSoon() { window.scheduleSave?.(); }
  function panelFor(node) {
    if (!allNodes()?.includes(node)) return null;
    return document.querySelector('#nodes [data-id="' + CSS.escape(String(node.id)) + '"] .studio-workflow-node');
  }
  function updateTaskUI(node) {
    const panel = panelFor(node); if (!panel) return;
    const task = node.studioWorkflowTaskStatus;
    panel.querySelector('[data-state]').textContent = (node.studioHistoryRestored ? '历史恢复已暂停，需显式核实原任务。 ' : '') + statusName(task) + (node.studioWorkflowError ? ' · ' + node.studioWorkflowError : '');
    const button = panel.querySelector('[data-submit]');
    button.disabled = flights.has(node) || Boolean(polls.get(node) && !polls.get(node).ctx.controller.signal.aborted);
    button.textContent = node.studioWorkflowTaskId ? '查询原任务' : node.studioWorkflowRequestId && !(task === 'failed' && node.studioWorkflowSubmission?.notSubmitted) ? '核实原请求' : '提交工作流';
    const fresh = panel.querySelector('[data-new]');
    fresh.hidden = !node.studioWorkflowRequestId; fresh.disabled = button.disabled;
  }
  function canvasValues(node,version) {
    const values = clone(node.comfyParams || {}), sources = window.generatorSources?.(node) || [];
    const refs = sources.flatMap(s => s.refs || []), used = {image:0,video:0,audio:0};
    for (const field of version.bindings || []) {
      if (['image','video','audio'].includes(field.type) && (values[field.id] == null || values[field.id] === '')) {
        const ref = refs.filter(r => (r.kind || 'image') === field.type)[used[field.type]++];
        if (ref?.url) values[field.id] = ref.url;
      }
      if (field.type === 'text' && /prompt/i.test(field.input) && !values[field.id]) {
        const prompt = sources.map(s => s.prompt).filter(Boolean).join('\n\n');
        if (prompt) values[field.id] = prompt;
      }
      if (values[field.id] === undefined) values[field.id] = clone(field.default);
      if (field.type === 'seed') values[field.id] = String(values[field.id]);
    }
    return values;
  }
  async function ensureSaved(ctx) {
    if (!window.StudioSave?.ensureCurrent) throw Error('保存保护尚未就绪，任务未提交。');
    if (!owned(ctx)) throw Error('画布、节点或任务已改变，任务未提交。');
    if (ctx.node.studioWorkflowSubmission?.request) {
      await window.StudioSave.ensureCurrent({canvasId:ctx.canvasId,nodeId:ctx.node.id,jobId:ctx.requestId,request:ctx.body,requestField:'studioWorkflowRequestId',snapshotField:'studioWorkflowSubmission'});
    } else {
      if (!ctx.taskId) throw Error('原请求输入快照缺失，请核实原任务；不会重新提交。');
      const saved = await window.StudioSave.ensureCurrent({canvasId:ctx.canvasId,nodeId:ctx.node.id});
      if (saved.node?.studioWorkflowTaskId !== ctx.taskId || saved.node?.studioWorkflowId !== ctx.workflowId || saved.node?.studioWorkflowRevision !== ctx.revision) throw Error('旧任务回执保存核对未通过。');
    }
    if (!owned(ctx)) throw Error('画布、节点或任务已改变，任务未提交。');
  }
  function verifyReceipt(task,ctx) {
    if (!task?.id || (ctx.taskId && task.id !== ctx.taskId) ||
      (task.canvas_id && String(task.canvas_id) !== ctx.canvasId) ||
      (task.node_id && String(task.node_id) !== String(ctx.node.id)) ||
      (task.workflow_id && task.workflow_id !== ctx.workflowId) ||
      (task.revision != null && String(task.revision) !== String(ctx.revision)) ||
      (task.request_id && ctx.requestId && task.request_id !== ctx.requestId)) {
      throw Error('任务回执与原画布、节点、工作流版本或请求不匹配。');
    }
  }
  async function showOutputs(task,ctx) {
    if (!owned(ctx) || task.id !== ctx.taskId || task.status !== 'succeeded') return;
    const node = ctx.node, panel = panelFor(node), host = panel?.querySelector('[data-output]');
    if (host) {
      host.replaceChildren();
      for (const item of task.outputs || []) {
        if (!safeURL(item.url)) continue;
        const link = document.createElement('a'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener';
        link.textContent = typeNames[item.kind] || '文件'; host.append(link);
      }
    }
    if (node.studioWorkflowAppliedTask === task.id) return;
    const media = (task.outputs || []).filter(item => ['image','video','audio'].includes(item.kind) && safeURL(item.url));
    if (media.length) {
      const outputCurrent = ctx.output && ctx.edge && allNodes()?.includes(ctx.output) && allConnections().includes(ctx.edge) && ctx.edge.from === node.id && ctx.edge.to === ctx.output.id;
      if (!outputCurrent) { node.studioWorkflowError = '任务已完成，但原输出槽已改变。结果仍保存在任务记录中，可从链接取回；未写入其他输出。'; updateTaskUI(node); saveSoon(); return; }
      if (typeof appendOutputImagesWithoutDuplicates === 'function') { appendOutputImagesWithoutDuplicates(ctx.output,media); node.studioWorkflowAppliedTask = task.id; window.render?.(); }
    }
    if (media.length) {
      try { await ensureSaved(ctx); }
      catch (e) { if (owned(ctx)) { node.studioWorkflowError = '结果已在当前画布中，但保存未确认：' + e.message; updateTaskUI(node); } }
    }
  }
  function safeURL(value) { try { return ['http:','https:'].includes(new URL(value,location.href).protocol); } catch { return false; } }
  function wait(ms,signal) {
    return new Promise(resolve => {
      if (signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort',done); resolve(); };
      const timer = setTimeout(done,ms); signal.addEventListener('abort',done,{once:true});
    });
  }
  function waitTask(ctx) {
    const old = polls.get(ctx.node);

    if (old && owned(old.ctx) && old.ctx.taskId === ctx.taskId && !old.ctx.controller.signal.aborted) return old.promise;
    if (old) old.ctx.controller.abort();
    contexts.add(ctx);
    const entry = {ctx,promise:null};
    entry.promise = (async () => {
      try {
        for (let count = 0; count < 360; count++) {
          if (!owned(ctx) || ctx.controller.signal.aborted) return;
          const task = await request('/tasks/' + encodeURIComponent(ctx.taskId),'GET',undefined,ctx.controller.signal);
          if (!owned(ctx) || ctx.controller.signal.aborted) return;
          verifyReceipt(task,ctx);
          if (ctx.explicit) delete ctx.node.studioHistoryRestored;
          ctx.node.studioWorkflowTaskStatus = task.status;
          ctx.node.studioWorkflowError = task.error || '';
          updateTaskUI(ctx.node); saveSoon();
          if (!['queued','running','saving'].includes(task.status)) { await showOutputs(task,ctx); return task; }
          await wait(2500,ctx.controller.signal);
        }
        if (owned(ctx)) { ctx.node.studioWorkflowTaskStatus = 'paused'; ctx.node.studioWorkflowError = '查询达到时间上限，保留原任务 ID。请稍后显式查询，不会重新提交。'; saveSoon(); }
      } catch (e) {
        if (owned(ctx) && !ctx.controller.signal.aborted) { ctx.node.studioWorkflowTaskStatus = 'paused'; ctx.node.studioWorkflowError = '原任务查询未确认：' + e.message; saveSoon(); }
      } finally {
        contexts.delete(ctx);
        if (polls.get(ctx.node) === entry) polls.delete(ctx.node);
        if (owned(ctx)) updateTaskUI(ctx.node);
      }
    })();
    polls.set(ctx.node,entry); updateTaskUI(ctx.node);
    return entry.promise;
  }
  async function recoverRequest(ctx) {
    await requireCapabilities();
    const task = await request('/tasks/by-request/' + encodeURIComponent(ctx.requestId));
    if (!owned(ctx)) return;
    verifyReceipt(task,ctx);
    ctx.node.studioWorkflowTaskId = ctx.taskId = task.id;
    ctx.node.studioWorkflowTaskStatus = task.status; ctx.node.studioWorkflowError = task.error || '';
    await ensureSaved(ctx);
    return waitTask(ctx);
  }
  async function runNode(node,forceNew = false) {
    if (flights.has(node)) return flights.get(node);
    const promise = (async () => {
      let ctx, dispatched = false, freshAttempt = false;
      try {
        if (!allNodes()?.includes(node)) throw Error('当前节点不存在。');
        if (!forceNew && node.studioWorkflowTaskId) {
          if (!node.studioWorkflowSubmission?.output) {
            node.studioWorkflowSubmission = {...node.studioWorkflowSubmission,output:prepareOutput(node)};
          }
          ctx = contextFor(node,true);
          // Explicit query may release a history hold only after the existing receipt is saved.
          await ensureSaved(ctx);
          return await waitTask(ctx);
        }
        if (!forceNew && node.studioWorkflowRequestId && !(node.studioWorkflowTaskStatus === 'failed' && node.studioWorkflowSubmission?.notSubmitted === true)) {
          ctx = contextFor(node,true);
          return await recoverRequest(ctx);
        }
        await requireCapabilities();
        const origin = currentCanvas(), originId = canvasId(), workflowId = node.studioWorkflowId, revision = node.studioWorkflowRevision;
        const {version} = await loadNodeWorkflow(node);
        if (currentCanvas() !== origin || !allNodes()?.includes(node) || node.studioWorkflowId !== workflowId || node.studioWorkflowRevision !== revision) throw Error('画布或节点配置已改变，任务未提交。');
        freshAttempt = true;
        const body = {revision,values:canvasValues(node,version),request_id:uid(),canvas_id:originId,node_id:node.id};
        node.studioWorkflowRequestId = body.request_id;
        node.studioWorkflowSubmission = {request:clone(body),output:prepareOutput(node),notSubmitted:false};
        node.studioWorkflowTaskId = ''; node.studioWorkflowTaskStatus = 'submitting'; node.studioWorkflowError = '';
        ctx = contextFor(node,true);
        updateTaskUI(node);
        await ensureSaved(ctx);
        if (!owned(ctx)) return;
        dispatched = true;
        const task = await request('/workflows/' + encodeURIComponent(workflowId) + '/submit','POST',ctx.body);
        if (!owned(ctx)) return;
        verifyReceipt(task,ctx);
        node.studioWorkflowTaskId = ctx.taskId = task.id;
        node.studioWorkflowTaskStatus = task.status;
        node.studioWorkflowError = task.error || '';
        delete node.studioHistoryRestored;
        try { await ensureSaved(ctx); }
        catch (e) {
          if (owned(ctx)) { node.studioWorkflowTaskStatus = 'paused'; node.studioWorkflowError = '已收到原任务回执，但画布保存未确认：' + e.message; saveSoon(); }
          return task;
        }
        return await waitTask(ctx);
      } catch (e) {
        if (ctx && owned(ctx)) {
          node.studioWorkflowTaskStatus = dispatched ? (e.status && e.status < 500 ? 'failed' : 'uncertain') : freshAttempt ? 'failed' : node.studioWorkflowTaskId ? 'paused' : 'uncertain';
          if (freshAttempt && !dispatched) node.studioWorkflowSubmission.notSubmitted = true;
          node.studioWorkflowError = freshAttempt && !dispatched ? '未提交，保存或输入核对失败：' + e.message : e.status === 404 && !dispatched ? '尚未找到原请求回执，请核实引擎队列；不会自动再次提交。' : e.message;
          saveSoon(); updateTaskUI(node);
        } else if (!ctx && allNodes()?.includes(node)) {
          node.studioWorkflowError = e.message; updateTaskUI(node);
        }
        throw e;
      }
    })();
    flights.set(node,promise); updateTaskUI(node);
    try { return await promise; }
    finally { if (flights.get(node) === promise) flights.delete(node); if (allNodes()?.includes(node)) updateTaskUI(node); }
  }
  function renderCanvasControls() {
    for (const ctx of contexts) if (!owned(ctx)) ctx.controller.abort();
    for (const node of allNodes() || []) {
      if (node.type !== 'comfy' || !node.studioWorkflowId) continue;
      const root = document.querySelector('#nodes [data-id="' + CSS.escape(String(node.id)) + '"]'), body = root?.querySelector('.comfy-body');
      if (!body || body.querySelector('.studio-workflow-node')) continue;
      root.classList.add('studio-workflow-custom-node');
      const panel = document.createElement('section'); panel.className = 'studio-workflow-node';
      panel.innerHTML = '<b></b><div data-fields>正在读取固定版本…</div><p data-state role="status"></p><div class="sw-node-actions"><button type="button" class="primary" data-submit>提交工作流</button><button type="button" data-new hidden>新建任务</button></div><div data-output></div>';
      panel.querySelector('b').textContent = (node.studioWorkflowName || 'ComfyUI 工作流') + ' · 固定 v' + node.studioWorkflowRevision;

      for (const event of ['pointerdown','mousedown','keydown','dblclick','wheel']) panel.addEventListener(event,e => e.stopPropagation());
      body.prepend(panel);
      const origin = currentCanvas(), id = node.studioWorkflowId, revision = node.studioWorkflowRevision;
      const current = () => currentCanvas() === origin && allNodes()?.includes(node) && node.studioWorkflowId === id && node.studioWorkflowRevision === revision && panel.isConnected;
      const fill = async () => {
        try {
          const {version} = await loadNodeWorkflow(node);
          if (!current()) return;
          const fields = panel.querySelector('[data-fields]'); fields.replaceChildren();
          for (const field of version.bindings || []) {
            const input = valueControl(field,node.comfyParams?.[field.id] ?? field.default,v => {
              if (!current()) return;
              node.comfyParams ||= {}; node.comfyParams[field.id] = v; saveSoon();
            });
            fields.append(labeled(field.label,input));
          }
          panel.querySelector('[data-submit]').onclick = () => runNode(node).catch(() => {});
          panel.querySelector('[data-new]').onclick = () => {
            if (!current() || !confirm('新建任务会提交新的生成请求。若原任务待核实，请先确认原请求未受理；已有结果会保留。是否明确新建？')) return;
            runNode(node,true).catch(() => {});
          };
          updateTaskUI(node);
          if (!node.studioHistoryRestored && node.studioWorkflowTaskId && ['queued','running','saving'].includes(node.studioWorkflowTaskStatus)) {
            if (!node.studioWorkflowSubmission?.output) { node.studioWorkflowSubmission = {...node.studioWorkflowSubmission,output:prepareOutput(node)}; saveSoon(); }
            waitTask(contextFor(node));
          }
        } catch (e) {
          if (!current()) return;
          const fields = panel.querySelector('[data-fields]'); fields.replaceChildren();
          const text = document.createElement('p'); text.textContent = e.message;
          const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新读取版本'; retry.onclick = fill;
          fields.append(text,retry); panel.querySelector('[data-submit]').disabled = true;
        }
      };
      fill();
    }
  }
  if (typeof window.runComfyNode === 'function') {
    const original = window.runComfyNode.bind(window);
    window.runComfyNode = (nodeId,opts = {}) => {
      const node = allNodes()?.find(n => n.id === nodeId);
      return node?.studioWorkflowId ? runNode(node) : original(nodeId,opts);
    };
  }
  const root = document.getElementById('nodes');
  let scheduled = false;
  function scheduleControls() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; renderCanvasControls(); });
  }
  if (root) new MutationObserver(scheduleControls).observe(root,{childList:true});
  setInterval(() => { if (contexts.size) for (const ctx of contexts) if (!owned(ctx)) ctx.controller.abort(); },1000);
  renderCanvasControls();
  function addEntry() {
    const bar = document.querySelector('.toolbar-fixed') || document.querySelector('.topbar') || document.querySelector('.sv2-header-tools');
    if (!bar || document.querySelector('[data-workflow-workbench]')) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = bar.matches('.sv2-header-tools') ? 'sv2-button' : 'tool-btn';
    button.dataset.workflowWorkbench = ''; button.textContent = '工作流工作台';
    button.onclick = () => openManager().catch(e => flash(e.message)); bar.append(button);
  }
  addEntry();
  new MutationObserver(addEntry).observe(document.body,{childList:true});
  function registerProvider(id,adapter) {
    if (!id || id === 'comfy' || providers.has(id)) throw Error('工作流来源标识重复或无效。');
    providers.set(id,adapter);
    for (const host of [$('[data-provider-filter]'),importDialog.querySelector('[data-import-provider]')]) { const option = document.createElement('option'); option.value = id; option.textContent = adapter.label; host.append(option); }
    if (modal.open) refresh().catch(e => flash(e.message));
  }
  importDialog.querySelector('[data-import-provider]').onchange = event => {
    const adapter = providers.get(event.target.value), kinds = adapter?.kinds || [];
    importDialog.setAttribute('aria-label','导入 ' + (adapter?.label || 'ComfyUI') + ' 工作流');
    importDialog.querySelector('.sw-tip').textContent = adapter ? '读取来源或 JSON 后先预览本地配置，不创建版本、不提交任务；远端应用内部版本不由本地版本号替代。' : '引擎会检查节点依赖并转换普通画布 JSON；本步骤仅预览，不创建工作流、不提交任务。';
    const select = importDialog.querySelector('[data-kind]'); select.replaceChildren();
    for (const kind of kinds) { const option = document.createElement('option'); option.value = kind.id; option.textContent = kind.label; select.append(option); }
    importDialog.querySelector('[data-kind-label]').hidden = !adapter; importDialog.querySelector('[data-source-label]').hidden = !adapter;
  };
  window.StudioWorkflows = Object.freeze({open:openManager,addNode:createCanvasNode,registerProvider});
})();
