/* Shared workspace presentation. Native project, save and account handlers own their data. */
(() => {
  'use strict';
  function initialize() {
    if (window.StudioWorkspace) return;
    const root = document.documentElement;
    const home = root.classList.contains('studio-v2-home');
    const smart = root.classList.contains('studio-v2-smart');
    if (!home && !smart && !root.classList.contains('studio-v2-canvas')) return;
    root.classList.add('studio-workspace-refresh');
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/static/studio-workspace.css'; document.head.append(style);
    const makeButton = (label, icon, action) => {
      const button = document.createElement('button'); button.type = 'button';
      button.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i><span>${label}</span>`;
      button.addEventListener('click', action); return button;
    };
    const settings = document.getElementById('studioSettingsButton');
    if (settings) {settings.textContent = 'API / 设置'; settings.setAttribute('aria-label', 'API / 设置');}
    let galleryDialog;
    async function openGallery() {
      if (!galleryDialog) {
        galleryDialog = document.createElement('dialog'); galleryDialog.id = 'workspaceGalleryDialog';
        galleryDialog.setAttribute('aria-labelledby', 'workspaceGalleryTitle');
        galleryDialog.innerHTML = '<form><h2 id="workspaceGalleryTitle">公共画廊</h2><p>浏览和分享提示词、图片与视频。发布时，在画廊登录并选择要公开的内容。</p><label for="workspaceGalleryURL">画廊网站地址</label><input id="workspaceGalleryURL" type="url" maxlength="512" placeholder="https://你的画廊域名" autocomplete="off"><p class="workspace-gallery-note">域名尚未配置时可以先留空。此入口不会上传本机画布、素材或 API Key。</p><p id="workspaceGalleryMessage" role="status" aria-live="polite"></p><div class="workspace-gallery-actions"><button type="button" data-gallery-close>关闭</button><button type="submit">保存地址</button><a id="workspaceGalleryOpen" target="_blank" rel="noopener noreferrer" hidden>打开画廊 ↗</a><a href="/gallery-import" target="_blank" rel="noopener noreferrer">导入提示词文件 ↗</a></div></form>';
        document.body.append(galleryDialog);
        // Preserve canvas shortcuts and wheel/drag state while this modal owns input.
        for (const type of ['keydown','keyup','pointerdown','mousedown','wheel']) galleryDialog.addEventListener(type, event => event.stopPropagation());
        galleryDialog.querySelector('[data-gallery-close]').onclick = () => galleryDialog.close();
        const input = galleryDialog.querySelector('input'), message = galleryDialog.querySelector('[role=status]'), link = galleryDialog.querySelector('a');
        input.oninput = () => {link.hidden = true; message.textContent = '';};
        galleryDialog.querySelector('form').onsubmit = async event => {
          event.preventDefault(); const submit = event.submitter; submit.disabled = true;
          try {
            const reply = await fetch('/api/studio/gallery', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:input.value})});
            const value = await reply.json(); if (!reply.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '请检查地址后重试。');
            input.value = value.url; link.href = value.url; link.hidden = !value.url; message.textContent = value.url ? '地址已保存。点击“打开画廊”继续。' : '画廊地址已清除。';
          } catch (error) {message.textContent = error.message || '地址保存失败，请重试。';}
          finally {submit.disabled = false;}
        };
      }
      if (!galleryDialog.open) galleryDialog.showModal();
      const input = galleryDialog.querySelector('input'), message = galleryDialog.querySelector('[role=status]'), link = galleryDialog.querySelector('a');
      input.disabled = true; link.hidden = true; message.textContent = '正在读取地址…';
      try {
        const reply = await fetch('/api/studio/gallery'), value = await reply.json();
        if (!reply.ok) throw new Error(value.detail || '配置读取失败。');
        input.value = value.url; link.href = value.url; link.hidden = !value.url; message.textContent = value.url ? '' : '请先填写已部署的画廊网站地址。';
      } catch (error) {message.textContent = error.message;}
      finally {input.disabled = false; input.focus();}
    }
    if (home) {
      const sidebar = document.querySelector('.ws-sidebar'), main = document.querySelector('.ws-main');
      const heading = document.querySelector('.v2-home-heading'); heading.classList.add('workspace-create-hero');
      heading.firstElementChild.innerHTML = '<small>深白片场 · 本地创作空间</small><h1>创作，从画布开始。</h1><p>整理灵感、连接素材，让每一步创作都有迹可循。</p>';
      const create = kind => {
        newCanvasBtn.click();
        document.querySelector(`#homeCreateDialog [data-kind="${kind}"]`)?.click();
      };
      const assets = () => location.assign('/static/studio-assets.html?project=' + encodeURIComponent(currentProjectId || 'default'));
      const quickstart = document.createElement('nav'); quickstart.className = 'workspace-quickstart'; quickstart.setAttribute('aria-label', '快速开始');
      for (const [label, icon, action, kind] of [
        ['经典画布', 'layout-dashboard', () => create('classic'), 'classic'],
        ['智能画布', 'workflow', () => create('smart'), 'smart'],
        ['本地资产', 'folder-open', assets], ['选择 API 服务', 'sliders-horizontal', () => settings.click()]
      ]) {const button = makeButton(label, icon, action); if (kind) button.dataset.workspaceCreate = kind; quickstart.append(button);}
      heading.after(quickstart);
      const nav = document.createElement('nav'); nav.className = 'workspace-nav'; nav.setAttribute('aria-label', '工作空间');
      const menu = makeButton('导航', 'menu', () => setSidebar(!root.classList.contains('workspace-sidebar-open')));
      menu.id = 'workspaceMenuToggle'; menu.setAttribute('aria-controls', sidebar.id); menu.setAttribute('aria-expanded', 'false');
      document.querySelector('.ws-topbar').prepend(menu);
      const scrim = document.createElement('button'); scrim.className = 'workspace-sidebar-scrim'; scrim.type = 'button'; scrim.setAttribute('aria-label', '关闭导航'); scrim.hidden = true; document.body.append(scrim);
      const narrow = matchMedia('(max-width: 768px)');
      function setSidebar(open) {
        root.classList.toggle('workspace-sidebar-open', open); menu.setAttribute('aria-expanded', String(open));
        scrim.hidden = !open || !narrow.matches; sidebar.inert = narrow.matches && !open;
        if (open) nav.querySelector('button')?.focus();
      }
      for (const [label, icon, action] of [
        ['创作工作台', 'house', () => {main.scrollTo({top:0}); newCanvasBtn.focus();}],
        ['项目画布', 'panels-top-left', () => {document.getElementById('homeSearch').focus();}],
        ['本地资产', 'folder-open', assets], ['公共画廊', 'images', openGallery], ['API 服务', 'sliders-horizontal', () => settings.click()]
      ]) nav.append(makeButton(label, icon, () => {setSidebar(false); action();}));
      nav.firstElementChild.setAttribute('aria-current', 'page'); sidebar.querySelector('.ws-side-head').before(nav);
      scrim.onclick = () => {setSidebar(false); menu.focus();};
      document.addEventListener('keydown', event => {if(event.key === 'Escape' && root.classList.contains('workspace-sidebar-open')) {setSidebar(false); menu.focus();}});
      narrow.addEventListener('change', () => setSidebar(false)); setSidebar(false);
      const note = document.createElement('p'); note.className = 'workspace-local-note'; note.textContent = '本地画布可直接使用。登录用于 API 网站账户，也可以配置自己的服务。';
      quickstart.after(note); document.querySelector('.v2-home-footer').textContent = '项目与素材保存在本机，生成内容使用你选择的 API 服务。';
    } else {
      const controls = document.createElement('nav'); controls.className = 'workspace-canvas-tools'; controls.setAttribute('aria-label', '画布操作');
      const more = document.createElement('details'); more.id = 'workspaceMoreTools';
      const summary = document.createElement('summary'); summary.innerHTML = '<i data-lucide="ellipsis" aria-hidden="true"></i><span>更多工具</span>'; more.append(summary);
      const panel = document.createElement('div'); panel.className = 'workspace-more-panel'; more.append(panel);
      panel.append(makeButton('公共画廊', 'images', openGallery));
      const account = document.getElementById('studioAccountButton');
      const search = document.getElementById(smart ? 'smartV2Search' : 'studioV2Search');
      for (const element of [search, settings, account]) if (element) controls.append(element);
      controls.append(more);
      if (smart) {
        const workflow = document.querySelector('[data-workflow-workbench]'); if (workflow) panel.append(workflow);
        panel.append(makeButton('快捷键帮助', 'keyboard', () => document.getElementById('smartShortcutToggle').click()));
        document.querySelector('.sv2-header-tools').append(controls);
      } else {
        const fixed = document.querySelector('#quickToolbar .toolbar-fixed'); if (fixed) panel.append(fixed);
        (document.getElementById('quickToolbar') || document.body).append(controls);
      }
      ['pointerdown', 'mousedown', 'dblclick', 'wheel'].forEach(type => controls.addEventListener(type, event => event.stopPropagation()));
      panel.addEventListener('click', event => {if (event.target.closest('button') && !event.target.closest('select')) more.open = false;});
      document.addEventListener('pointerdown', event => {if(!more.contains(event.target)) more.open = false;});
      document.addEventListener('keydown', event => {if (event.key === 'Escape' && more.open) {event.preventDefault(); event.stopImmediatePropagation(); more.open = false; summary.focus();}}, true);
    }
    window.lucide?.createIcons();
    window.StudioWorkspace = Object.freeze({ready:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once:true}); else initialize();
})();
