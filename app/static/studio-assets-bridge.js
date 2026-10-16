(() => {
  'use strict';
  const buttonAnchor = document.getElementById('canvasAssetToggle');
  if (!buttonAnchor || window.__studioAssetsBridgeInstalled) return;
  window.__studioAssetsBridgeInstalled = true;
  const origin = window.location.origin;
  let projectId = '';
  let canvasId = '';
  let overlay = null;
  let frame = null;
  let opening = false;

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = buttonAnchor.className;
  openButton.title = '项目资产';
  openButton.setAttribute('aria-label', '项目资产');
  const icon = document.createElement('i');
  icon.dataset.lucide = 'folder-open'; icon.className = 'w-4 h-4';
  const label = document.createElement('span'); label.textContent = '项目资产';
  openButton.append(icon,label);
  buttonAnchor.parentElement.insertBefore(openButton, buttonAnchor.nextSibling);
  openButton.addEventListener('click', openPanel);

  async function resolveProject() {
    const params = new URLSearchParams(window.location.search);
    canvasId = params.get('id') || '';
    if (!canvasId) throw new Error('请先打开一个项目画布。');
    const response = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}`);
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || !data.canvas) throw new Error(data.detail || '无法读取当前画布所属项目。');
    projectId = String(data.canvas.project || 'default');
    return projectId;
  }
  async function openPanel() {
    if (opening) return;
    opening = true; openButton.disabled = true;
    try {
      const pid = await resolveProject();
      if (!overlay) createPanel();
      frame.src = `/static/studio-assets.html?project=${encodeURIComponent(pid)}&embed=1`;
      overlay.style.display = 'flex';
      overlay.hidden = false;
      document.body.classList.add('studio-assets-panel-open');
    } catch (error) { showError(error.message || '无法打开项目资产。'); }
    finally {opening = false; openButton.disabled = false;}
  }
  function createPanel() {
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#0009;backdrop-filter:blur(2px);display:none;justify-content:flex-end';
    overlay.hidden = true;
    overlay.addEventListener('click', event => {if(event.target===overlay) closePanel();});
    frame = document.createElement('iframe');
    frame.title = '项目资产';
    frame.style.cssText = 'border:0;width:min(980px,100vw);height:100%;background:#101113;box-shadow:-24px 0 60px #0008';
    frame.setAttribute('allow','clipboard-read; clipboard-write');
    overlay.append(frame); document.body.append(overlay);
  }
  function closePanel() {
    if (!overlay) return;
    overlay.hidden = true; overlay.style.display = 'none'; frame.src = 'about:blank'; document.body.classList.remove('studio-assets-panel-open');
  }
  window.addEventListener('message', event => {
    if (!frame || event.origin !== origin || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'studio-assets:close') {closePanel();return;}
    if (data.type !== 'studio-assets:add-to-canvas') return;
    const item = data.item;
    if (!item || !projectId || String(data.project_id) !== projectId || String(item.project_id) !== projectId) {
      frame.contentWindow.postMessage({type:'studio-assets:result',ok:false,message:'素材所属项目与当前画布不一致。'},origin); return;
    }
    if (!item.version_id || !item.url || !item.name || !canvasId) {
      frame.contentWindow.postMessage({type:'studio-assets:result',ok:false,message:'素材信息不完整，无法加入画布。'},origin); return;
    }
    try {
      if (typeof window.pushUndo !== 'function' || typeof window.addImageNode !== 'function' || typeof window.scheduleSave !== 'function') throw new Error('当前画布暂不支持添加资产引用。');
      window.pushUndo();
      const node = window.addImageNode();
      if (!node) throw new Error('画布尚未准备好，请稍后再试。');
      node.url = item.url;
      node.name = item.name;
      node.assetId = item.asset_id || '';
      node.assetVersionId = item.version_id;
      node.assetProjectId = projectId;
      node.assetReference = true;
      node.studioAssetRefs = [{asset_id:item.asset_id || null,version_id:item.version_id,url:item.url,project_id:projectId}];
      node.mediaKind = item.kind || 'image';
      if (typeof window.render === 'function') window.render();
      window.scheduleSave();
      frame.contentWindow.postMessage({type:'studio-assets:result',ok:true,version_id:item.version_id},origin);
    } catch(error) {
      frame.contentWindow.postMessage({type:'studio-assets:result',ok:false,message:error.message || '加入画布失败。'},origin);
    }
  });
  function showError(message) {
    let box = document.getElementById('studioAssetsBridgeError');
    if (!box) {
      box = document.createElement('div'); box.id='studioAssetsBridgeError';
      box.style.cssText='position:fixed;z-index:100001;top:20px;left:50%;transform:translateX(-50%);max-width:min(500px,calc(100vw - 24px));padding:12px 16px;border:1px solid #694747;border-radius:9px;background:#241a1a;color:#f0b5b2;box-shadow:0 12px 36px #0008;font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif';
      document.body.append(box);
    }
    box.textContent = message; clearTimeout(box._timer); box._timer=setTimeout(()=>box.remove(),5000);
  }
})();
