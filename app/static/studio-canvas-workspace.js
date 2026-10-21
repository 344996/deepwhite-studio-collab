/* Shared canvas controls. Engine adapters remain the owners of edits and history. */
(() => {
  'use strict';
  function initialize() {
    if (window.StudioCanvasWorkspace || !window.StudioWorkspace) return;
    const root = document.documentElement, smart = root.classList.contains('studio-v2-smart');
    if (!smart && !root.classList.contains('studio-v2-canvas')) return;
    root.classList.add('studio-canvas-workspace');
    const sheet = document.createElement('link'); sheet.rel = 'stylesheet'; sheet.href = '/static/studio-canvas-workspace.css'; document.head.append(sheet);
    const feel = document.createElement('link'); feel.rel = 'stylesheet'; feel.href = '/static/studio-canvas-feel.css?v=0.11.0-studio.7'; document.head.append(feel);
    const button = (id, label, icon, action) => {
      const item = document.createElement('button'); item.type = 'button'; item.id = id;
      item.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i><span>${label}</span>`;
      item.title = label; item.setAttribute('aria-label', label); item.addEventListener('click', action); return item;
    };
    const isolate = element => {
      for (const type of ['pointerdown', 'mousedown', 'dblclick', 'wheel', 'keydown', 'keyup']) element.addEventListener(type, event => event.stopPropagation());
    };
    const controls = document.querySelector('.workspace-canvas-tools'), more = document.querySelector('.workspace-more-panel');
    const saveStatus = document.getElementById(smart ? 'smartV2SaveStatus' : 'studioV2SaveState');
    saveStatus.className = 'workspace-save-state'; saveStatus.setAttribute('aria-live', 'polite'); saveStatus.setAttribute('aria-atomic', 'true');
    if (smart) document.querySelector('.sv2-heading').append(saveStatus);
    let currentStatusCanvas = null;
    function showSave(state, detail = '') {
      saveStatus.dataset.state = state;
      saveStatus.textContent = {dirty:'有改动',saving:'保存中',saved:'已保存',error:'保存失败',conflict:'版本冲突'}[state];
      saveStatus.title = detail || {dirty:'本地改动等待保存',saving:'正在等待服务器确认',saved:'已保存到本地项目',error:'草稿仍保留，请重试保存',conflict:'本地草稿仍保留，请先处理版本冲突'}[state];
    }
    const matchesCanvas = event => event.detail?.canvasId === canvas?.id;
    const nativeSave = saveCanvas;
    saveCanvas = function(...args) {
      if (canvas?.id) window.dispatchEvent(new CustomEvent('studio-save-started', {detail:{canvasId:canvas.id}}));
      return nativeSave.apply(this, args);
    };
    if (!smart) {
      const nativeSchedule = scheduleSave;
      scheduleSave = function(...args) {
        const result = nativeSchedule.apply(this, args);
        if (canvas?.id) window.dispatchEvent(new CustomEvent('studio-save-pending', {detail:{canvasId:canvas.id}}));
        return result;
      };
    }
    window.addEventListener('studio-save-pending', event => { if (matchesCanvas(event)) showSave('dirty'); });
    window.addEventListener('studio-save-started', event => { if (matchesCanvas(event)) showSave('saving'); });
    window.addEventListener('studio-save-state', event => {
      if (!matchesCanvas(event)) return;
      const result = event.detail;
      const pending = result.pending || result.code === 'busy' || (!smart && result.ok && saveCanvasAgain);
      showSave(result.code === 'conflict' ? 'conflict' : pending ? 'saving' : result.ok ? 'saved' : 'error', result.error);
    });
    const save = document.getElementById('smartV2Save') || button('workspaceSave', '保存', 'save', () => saveCanvas());
    const history = document.querySelector('.studio-history-button') || document.getElementById('smartLogToggle');
    if (history) { history.dataset.workspaceTasks = ''; history.textContent = '任务记录'; history.setAttribute('aria-label', '任务记录'); }
    for (const item of [save, document.getElementById(smart ? 'smartV2Search' : 'studioV2Search'), history,
      document.getElementById('studioSettingsButton'), document.getElementById('studioAccountButton'), document.getElementById('workspaceMoreTools')]) if (item) controls.append(item);
    const rail = document.querySelector(smart ? '.sv2-rail' : '#quickToolbar .toolbar-items');
    rail.id = 'workspaceCanvasRail'; rail.setAttribute('aria-label', '画布工具');
    const add = document.getElementById(smart ? 'smartV2Add' : 'studioV2Add');
    let select = document.getElementById('studioV2Select'), hand = document.getElementById('studioV2Hand');
    if (smart) {
      select = button('workspaceSelect', '选择 · V', 'mouse-pointer-2', () => StudioSmartV2.setMode('select'));
      hand = button('workspaceHand', '移动 · H', 'hand', () => StudioSmartV2.setMode('hand'));
    }
    const assets = document.getElementById(smart ? 'assetToggle' : 'canvasAssetToggle');
    const workflow = document.querySelector('[data-workflow-workbench]') || document.getElementById(smart ? 'smartWorkflowToggle' : 'workflowTransferToggle');
    const primary = [add, select, hand, assets, workflow].filter(Boolean);
    const extra = document.createElement('div'); extra.className = 'workspace-extra-tools';
    for (const item of [...rail.children]) if (!primary.includes(item) && !item.classList.contains('v2-rail-divider')) {
      if (item.classList.contains('sv2-advanced')) extra.append(...item.querySelector('.sv2-advanced-panel').children); else extra.append(item);
    }
    rail.replaceChildren(...primary); if (extra.children.length) more.append(extra);
    const narrow = matchMedia('(max-width:768px)'), search = document.getElementById(smart ? 'smartV2Search' : 'studioV2Search');
    const responsiveTools = () => { if (search) { if (narrow.matches) more.prepend(search); else controls.insertBefore(search, history || document.getElementById('studioSettingsButton')); } };
    narrow.addEventListener('change', responsiveTools); responsiveTools();
    for (const [item, label, key] of [[add,'添加',''],[select,'选择','V'],[hand,'移动','H'],[assets,'素材',''],[workflow,'工作流','']]) {
      if (!item) continue;
      const symbol = item.querySelector('svg,i') || document.createElement('i');
      if (!symbol.getAttribute('data-lucide')) symbol.setAttribute('data-lucide', item === workflow ? 'workflow' : 'folder-open');
      const text = document.createElement('span'); item.replaceChildren(symbol, text);
      text.textContent = label; item.title = label + (key ? ' · ' + key : ''); item.setAttribute('aria-label', item.title);
      if (key) item.setAttribute('aria-keyshortcuts', key);
    }
    isolate(rail);
    const view = document.querySelector(smart ? '.sv2-view' : '.v2-navigation');
    view.classList.add('workspace-viewport'); view.setAttribute('aria-label', '缩放与导航');
    if (smart) {
      const fit = document.getElementById('smartV2Fit'); fit.setAttribute('aria-label', '适应全部节点 · Shift+1');
      const shortcuts = document.querySelector('#smartShortcutModal .shortcut-list');
      shortcuts.querySelector('[data-i18n="smart.shortcutPan"]')?.closest('.shortcut-item').remove();
      shortcuts.querySelector('[data-i18n="smart.shortcutBoxSelect"]')?.closest('.shortcut-item').remove();
      for (const [key, label] of [['V / H','选择 / 移动工具'],['空白处拖动 / Shift + 拖动','框选 / 追加选择'],['空格 / 中键 + 拖动','临时平移画布'],['Ctrl / ⌘ + K','查找节点'],['F / Shift + 1','定位选中 / 适应全部'],['按住 X 拖动','断开经过的连线']]) {
        const row = document.createElement('div'); row.className = 'shortcut-item';
        const keys = document.createElement('span'); keys.className = 'shortcut-keys'; const kbd = document.createElement('kbd'); kbd.textContent = key; keys.append(kbd);
        const text = document.createElement('span'); text.textContent = label; row.append(keys, text); shortcuts.append(row);
      }
      const map = button('workspaceMinimap', '导航地图', 'map', () => {
        const minimap = document.querySelector('.smart-minimap'); minimap.hidden = !minimap.hidden; map.setAttribute('aria-pressed', String(!minimap.hidden));
      }); map.setAttribute('aria-pressed', 'true');
      view.append(fit, map); isolate(view);
    }
    function sync() {
      if (canvas && currentStatusCanvas !== canvas) { currentStatusCanvas = canvas; showSave('saved'); }
      if (smart) { const mode = StudioSmartV2.mode; select.setAttribute('aria-pressed', String(mode === 'select')); hand.setAttribute('aria-pressed', String(mode === 'hand')); }
      window.StudioCanvasInspector?.sync();
    }
    // Existing adapters call this after their native render/selection work; no polling.
    window.StudioCanvasWorkspace = Object.freeze({ready:true, sync, button, isolate});
    sync(); window.lucide?.createIcons();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once:true}); else initialize();
})();
