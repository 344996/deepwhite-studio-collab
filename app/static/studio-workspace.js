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
    if (home) { const layout = document.createElement('link'); layout.rel = 'stylesheet'; layout.href = '/static/studio-home-1102.css?v=1'; document.head.append(layout); }
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
      newCanvasBtn.className = 'home-new-card'; newCanvasBtn.removeAttribute('data-i18n'); newCanvasBtn.setAttribute('aria-label', '新建画布');
      newCanvasBtn.innerHTML = '<span class="home-new-plus"><i data-lucide="plus" aria-hidden="true"></i></span><b>新建画布创作</b>';
      heading.replaceChildren(newCanvasBtn);
      const assets = () => location.assign('/static/studio-assets.html?project=' + encodeURIComponent(currentProjectId || 'default'));
      const openSettings = tab => window.StudioOpenSettings ? window.StudioOpenSettings(tab) : settings.click();
      // One click opens a new canvas already holding the nodes for that way of working.
      async function start(title, starter) {
        try {
          const reply = await fetch('/api/canvases', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({title, kind: 'classic', project: currentProjectId || 'default'})});
          const value = await reply.json(); if (!reply.ok) throw new Error(value.detail || '新建画布失败，请重试。');
          location.assign(`/static/canvas.html?id=${encodeURIComponent(value.canvas.id)}&project=${encodeURIComponent(currentProjectId || 'default')}&starter=${starter}`);
        } catch (error) { document.getElementById('boardStatus').textContent = error.message; }
      }
      const tools = document.createElement('nav'); tools.className = 'workspace-tools workspace-quickstart'; tools.setAttribute('aria-label', '快速开始');
      for (const [label, icon, action] of [
        ['图片生成', 'image', () => start('图片生成', 'image')], ['视频生成', 'video', () => start('视频生成', 'video')],
        ['音频生成', 'audio-lines', () => start('音频生成', 'audio')], ['文本生成', 'type', () => start('文本生成', 'text')],
        ['RH 工作流', 'workflow', () => start('RH 工作流', 'workflows')], ['ComfyUI', 'sparkles', () => openSettings('comfy')],
        ['导入素材', 'upload', assets], ['外接智能体', 'bot', () => openSettings('control')]
      ]) {
        const button = document.createElement('button'); button.type = 'button'; button.addEventListener('click', action);
        button.innerHTML = `<span class="workspace-tool-tile"><i data-lucide="${icon}" aria-hidden="true"></i></span><b>${label}</b>`; tools.append(button);
      }
      heading.after(tools);
      const flowsTitle = document.createElement('h3'); flowsTitle.className = 'workspace-flows-title'; flowsTitle.textContent = '常用流程';
      const flows = document.createElement('nav'); flows.className = 'workspace-flows'; flows.setAttribute('aria-label', '常用流程');
      // Repository-owned AI samples illustrate each starting point; they never masquerade as user work.
      for (const [label, cover, starter] of [['分镜与场景', 'scene', 'storyboard'], ['角色设定', 'character', 'character'], ['产品与道具', 'props', 'product'], ['风格参考', 'linen', 'style'], ['图生视频', 'scene', 'img2video']]) {
        const button = document.createElement('button'); button.type = 'button'; button.addEventListener('click', () => start(label, starter));
        button.innerHTML = `<img src="/static/home-covers/${cover}.jpg" alt=""><span>${label}</span>`; flows.append(button);
      }
      tools.after(flowsTitle, flows);
      const nav = document.createElement('nav'); nav.className = 'workspace-nav'; nav.setAttribute('aria-label', '工作空间');
      const menu = makeButton('导航', 'menu', () => setSidebar(!root.classList.contains('workspace-sidebar-open')));
      menu.id = 'workspaceMenuToggle'; menu.setAttribute('aria-controls', sidebar.id); menu.setAttribute('aria-expanded', 'false');
      document.querySelector('.ws-topbar').prepend(menu);
      const scrim = document.createElement('button'); scrim.className = 'workspace-sidebar-scrim'; scrim.type = 'button'; scrim.setAttribute('aria-label', '关闭导航'); scrim.hidden = true; document.body.append(scrim);
      const narrow = matchMedia('(max-width: 768px)');
      function setSidebar(open) {
        root.classList.toggle('workspace-sidebar-open', open); menu.setAttribute('aria-expanded', String(open));
        scrim.hidden = !open || !narrow.matches; sidebar.inert = narrow.matches && !open;
        // A mobile drawer owns keyboard focus until it closes.
        for (const child of main.children) if (!child.classList.contains('ws-topbar')) child.inert = open && narrow.matches;
        document.querySelector('.ws-topbar-right').inert = open && narrow.matches;
        sidebar.setAttribute('aria-label', '工作空间导航');
        if (open) nav.querySelector('button')?.focus();
      }
      const navGroup = (title, items, host = nav) => {
        const group = document.createElement('div'); group.className = 'workspace-nav-group';
        if (title) { const heading = document.createElement('h4'); heading.textContent = title; group.append(heading); }
        for (const [label, icon, action] of items) group.append(makeButton(label, icon, () => {setSidebar(false); action();}));
        host.append(group);
      };
      navGroup('', [
        ['首页', 'house', () => {main.scrollTo({top:0}); newCanvasBtn.focus();}],
        ['项目', 'panels-top-left', () => {document.getElementById('homeSearch').focus();}],
        ['资产', 'folder-open', assets], ['工作流', 'workflow', () => start('RH 工作流', 'workflows')]
      ]);
      navGroup('创作', [['深白画布', 'layers', () => newCanvasBtn.click()], ['外接智能体', 'bot', () => openSettings('control')]]);
      navGroup('发现', [['公共画廊', 'images', openGallery]]);
      nav.querySelector('button').setAttribute('aria-current', 'page'); sidebar.querySelector('.ws-side-head').before(nav);
      const foot = document.createElement('nav'); foot.className = 'workspace-nav-foot'; foot.setAttribute('aria-label', '设置与记录');
      foot.append(makeButton('API 与设置', 'sliders-horizontal', () => {setSidebar(false); settings.click();}));
      const trash = document.getElementById('trashEntry'); if (trash) foot.append(trash);
      foot.append(makeButton('版本更新记录', 'history', () => location.assign('/static/studio-updates.html')));
      sidebar.append(foot);
      // Native folder/trash entries live outside the new nav. They must release
      // the same drawer before handing keyboard and pointer access back to main.
      sidebar.addEventListener('click', event => {
        if (!narrow.matches) return;
        if (event.target.closest('#trashEntry')) {
          setSidebar(false); document.getElementById('trashClose').focus();
        } else if (event.target.closest('.ws-project-row') && !event.target.closest('button,input')) {
          setSidebar(false); document.getElementById('homeSearch').focus();
        }
      });
      document.getElementById('trashClose').addEventListener('click', () => {if (narrow.matches) menu.focus();});
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && narrow.matches && trashPanel.classList.contains('active')) {
          closeTrashView(); menu.focus();
        }
      }, true);
      scrim.onclick = () => {setSidebar(false); menu.focus();};
      document.addEventListener('keydown', event => {
        if (!root.classList.contains('workspace-sidebar-open') || !narrow.matches) return;
        if (event.key === 'Escape') {setSidebar(false); menu.focus();}
        if (event.key === 'Tab') {
          const items = [...sidebar.querySelectorAll('button,input,a,[tabindex="0"]')].filter(el => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
          if (event.shiftKey && document.activeElement === items[0]) {event.preventDefault(); items.at(-1)?.focus();}
          else if (!event.shiftKey && document.activeElement === items.at(-1)) {event.preventDefault(); items[0]?.focus();}
        }
      });
      narrow.addEventListener('change', () => setSidebar(false)); setSidebar(false);
      document.querySelector('.v2-home-footer').textContent = '项目与素材保存在本机，生成内容使用你选择的 API 服务。';
      document.querySelectorAll('.studio-home-views button').forEach(button => {
        const label = button.textContent; button.setAttribute('aria-label', label); button.title = label;
        button.innerHTML = `<i data-lucide="${button.dataset.view === 'grid' ? 'layout-grid' : 'list'}" aria-hidden="true"></i>`;
      });
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
