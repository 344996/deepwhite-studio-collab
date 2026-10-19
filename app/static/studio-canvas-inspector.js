/* Selection properties share the existing engine state, undo stack and save queue. */
(() => {
  'use strict';
  function initialize() {
    const workspace = window.StudioCanvasWorkspace;
    if (!workspace || window.StudioCanvasInspector) return;
    const smart = document.documentElement.classList.contains('studio-v2-smart');
    const narrow = matchMedia('(max-width:900px)');
    const element = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text) item.textContent = text; return item; };
    const selectedIdsNow = () => smart ? selectedNodeIds() : [...selected];
    const titleOf = node => node.studioTitle || node.title || node.name || ({prompt:'文本',generator:'图片生成',video:'视频生成',audio:'音频生成','smart-prompt':'文本','smart-image':'图片节点'}[node.type] || '节点');
    const panel = element('aside', 'workspace-inspector'); panel.id = 'workspaceInspector'; panel.hidden = true; panel.setAttribute('aria-label', '节点属性');
    const head = element('header'), heading = element('h2', '', '节点属性');
    const close = workspace.button('workspaceInspectorClose', '收起属性', 'x', () => setOpen(false)); head.append(heading, close);
    const content = element('div', 'workspace-inspector-content'); panel.append(head, content);
    const scrim = workspace.button('workspaceInspectorScrim', '关闭属性抽屉', 'x', () => setOpen(false)); scrim.hidden = true; scrim.tabIndex = -1;
    const toggle = workspace.button('workspaceInspectorToggle', '节点属性', 'sliders-horizontal', () => setOpen(panel.hidden));
    toggle.setAttribute('aria-controls', panel.id); toggle.hidden = true;
    document.body.append(scrim, panel, toggle); workspace.isolate(panel);
    let selectionKey = '', signature = '', frame = 0, pointerHeld = false;
    // Blurring a changed input may render the canvas before the following click.
    // Retain its action button until pointerup so the click keeps its DOM target.
    panel.addEventListener('pointerdown', () => { pointerHeld = true; });
    const releasePointer = () => { pointerHeld = false; sync(); };
    window.addEventListener('pointerup', releasePointer);
    window.addEventListener('pointercancel', releasePointer);
    window.addEventListener('blur', releasePointer);
    function setOpen(open) {
      const hadFocus = panel.contains(document.activeElement);
      panel.hidden = !open; panel.dataset.modal = String(open && narrow.matches); scrim.hidden = !open || !narrow.matches;
      panel.setAttribute('role', narrow.matches ? 'dialog' : 'complementary'); panel.setAttribute('aria-modal', String(open && narrow.matches));
      toggle.setAttribute('aria-expanded', String(open)); document.documentElement.classList.toggle('workspace-inspector-open', open);
      if (open && narrow.matches) close.focus(); else if (!open && hadFocus) toggle.focus();
      if (smart) StudioSmartV2.sync();
    }
    narrow.addEventListener('change', () => setOpen(false));
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); setOpen(false); return; }
      if (event.key !== 'Tab' || !narrow.matches) return;
      const focusable = [...panel.querySelectorAll('button,input,textarea,select')].filter(item => !item.disabled && item.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    function owned(origin, node) { return canvas === origin && nodes.includes(node) && selectedIdsNow().length === 1 && selectedIdsNow()[0] === node.id; }
    function field(node, key, label, type = 'text') {
      const origin = canvas, wrap = element('label', 'workspace-property'), caption = element('span', '', label);
      const input = element(type === 'textarea' ? 'textarea' : 'input'); input.dataset.property = key; input.setAttribute('aria-label', label);
      if (type !== 'textarea') input.type = type; else { input.rows = 6; input.spellcheck = false; }
      input.value = node[key] ?? (type === 'text' ? titleOf(node) : ''); if (type === 'text') input.maxLength = 80;
      if (type === 'number') { input.step = '1'; input.min = '-1000000'; input.max = '1000000'; }
      let recorded = false, changed = false;
      input.addEventListener('focus', () => { recorded = false; });
      input.addEventListener('input', () => {
        if (!owned(origin, node)) { input.disabled = true; return; }
        let value = type === 'number' ? input.valueAsNumber : input.value;
        const invalid = type === 'number' ? !Number.isFinite(value) || Math.abs(value) > 1000000 : type === 'text' && !value.trim();
        input.setCustomValidity(invalid ? '请填写有效值' : ''); if (invalid || value === node[key]) return;
        if (!recorded) { pushUndo(); recorded = true; }
        node[key] = value; changed = true; scheduleSave();
      });
      input.addEventListener('blur', () => {
        if (!changed) return; changed = false;
        if (owned(origin, node)) { render(); sync(); }
      });
      wrap.append(caption, input); return wrap;
    }
    function parameterSelect(node, label, options, current, apply) {
      const origin = canvas, wrap = element('label', 'workspace-property'), select = element('select'); select.setAttribute('aria-label', label);
      for (const option of options) { const item = element('option', '', option.label); item.value = option.value; item.disabled = option.disabled; select.append(item); }
      select.value = String(current ?? ''); select.dataset.parameter = label;
      select.onchange = () => {
        if (!owned(origin, node) || String(current ?? '') === select.value) return;
        pushUndo(); apply(select.value); render(); signature = ''; sync();
      };
      wrap.append(element('span', '', label), select); return wrap;
    }
    function parameters(node, host) {
      if (smart) {
        if (activeSettingsSubject()?.id !== node.id || !composer.classList.contains('open')) return;
        for (const [key, label] of [['provider_id','API 平台'],['model','生成模型'],['videoProvider','视频平台'],['videoModel','视频模型'],['ratio','画面比例'],['resolution','分辨率']]) {
          const options = [...dynamicParams.querySelectorAll(`[data-smart-param="${key}"]`)].map(item => ({value:item.dataset.smartValue,label:item.textContent.trim()}));
          if (options.length) host.append(parameterSelect(node, label, options, settings[key], value => setDynamicSetting(key, value)));
        }
      } else {
        const card = nodesEl.querySelector(`[data-id="${CSS.escape(node.id)}"]`);
        for (const [selector, label] of [['.provider-select,.video-provider,[data-provider]','API 平台'],['.model-select,.video-model,[data-model]','生成模型'],['.ratio,.video-aspect','画面比例'],['.resolution,.video-resolution','分辨率']]) {
          const source = card?.querySelector('select' + selector.replaceAll(',', ',select'));
          if (!source || source.disabled) continue;
          const options = [...source.options].map(option => ({value:option.value,label:option.textContent,disabled:option.disabled}));
          host.append(parameterSelect(node, label, options, source.value, value => { source.value = value; source.dispatchEvent(new Event('change', {bubbles:true})); }));
        }
      }
    }
    function duplicate() {
      document.activeElement?.blur();
      if (!smart) { StudioCanvasV2.duplicate(); return; }
      const originals = nodes.filter(node => selectedIdsNow().includes(node.id)); if (!originals.length) return;
      copySelectedNodes(); const previous = lastMouseWorld;
      lastMouseWorld = {x:(Math.min(...originals.map(node => node.x)) + Math.max(...originals.map(node => node.x)))/2+40,y:(Math.min(...originals.map(node => node.y)) + Math.max(...originals.map(node => node.y)))/2+40};
      try { pasteNodes(); } finally { lastMouseWorld = previous; }
    }
    function refresh() {
      frame = 0; if (!canvas || pointerHeld) return;
      const ids = selectedIdsNow(), key = canvas.id + ':' + ids.join('|');
      toggle.hidden = !ids.length;
      if (key !== selectionKey) { selectionKey = key; signature = ''; setOpen(ids.length > 0 && !narrow.matches); }
      if (!ids.length) { content.replaceChildren(); return; }
      if (panel.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) return;
      const selection = ids.map(id => nodes.find(node => node.id === id)).filter(Boolean);
      const next = JSON.stringify(selection.map(node => [node.id,node.studioTitle,node.title,node.x,node.y,node.text,node.studioPrompt,node.audioPrompt,node.apiProvider,node.model,node.ratio,node.resolution,node.runSettings]));
      if (signature === next) return; signature = next;
      content.replaceChildren(); heading.textContent = selection.length === 1 ? '节点属性' : `已选择 ${selection.length} 个节点`;
      const actions = element('nav', 'workspace-selection-actions'); actions.setAttribute('aria-label', '选中节点操作');
      actions.append(workspace.button('', '定位', 'focus', () => smart ? StudioSmartV2.fit(selection.length === 1 ? selection[0] : null) : StudioCanvasV2.focus(ids)), workspace.button('', '复制', 'copy-plus', duplicate));
      if (selection.length > 1) actions.append(workspace.button('', '整理', 'layout-grid', () => document.getElementById(smart ? 'smartArrangeBtn' : 'canvasArrangeBtn')?.click()), workspace.button('', '分组', 'group', () => smart ? groupSelectedNodes() : StudioCanvasV2.group()));
      content.append(actions);
      if (selection.length === 1) {
        const node = selection[0]; content.append(element('p', 'workspace-property-kind', titleOf(node)));
        content.append(field(node, smart ? 'title' : 'studioTitle', '节点名称'));
        // A group is moved through its native drag action, which also moves members.
        if (!/group/i.test(node.type)) { const position = element('div', 'workspace-property-position'); position.append(field(node,'x','X 位置','number'),field(node,'y','Y 位置','number')); content.append(position); }
        const promptKey = node.type === 'prompt' || node.type === 'smart-prompt' ? 'text' : ['generator','video'].includes(node.type) ? 'studioPrompt' : node.type === 'audio' ? 'audioPrompt' : '';
        if (promptKey) content.append(field(node, promptKey, '提示词', 'textarea'));
        parameters(node, content);
        if (smart && composer.classList.contains('open')) content.append(workspace.button('workspaceNativeEditor', '打开生成编辑器', 'square-pen', () => { setOpen(false); StudioSmartV2.fit(node); promptInput.focus(); }));
        content.append(element('p', 'workspace-property-note', '修改自动保存；一次输入可撤销。更多生成与素材操作在节点中。'));
      } else content.append(element('p', 'workspace-property-note', '批量操作沿用画布的撤销记录。拖动任一选中节点可一起移动。'));
      window.lucide?.createIcons({root:panel});
    }
    function sync() { if (!frame) frame = requestAnimationFrame(refresh); }
    document.addEventListener('change', event => { if (!panel.contains(event.target)) { signature = ''; sync(); } });
    window.addEventListener('mouseup', sync);
    window.StudioCanvasInspector = Object.freeze({sync, ready:true}); sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once:true}); else initialize();
})();
