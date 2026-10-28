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
      const copy = heading.firstElementChild; copy.className = 'workspace-hero-copy';
      copy.innerHTML = '<small><span></span> DEEPWHITE · 创作空间</small><h1>让灵感，<br>在画布上发生。</h1><p>从一句提示词，到一个完整的视觉世界。<br>连接想法与素材，开始你的下一幕。</p>';
      const heroActions = document.createElement('div'); heroActions.className = 'workspace-hero-actions';
      heroActions.append(newCanvasBtn); copy.append(heroActions);
      const heroArt = document.createElement('div'); heroArt.className = 'workspace-hero-art'; heroArt.setAttribute('aria-hidden', 'true');
      // Repository-owned AI samples illustrate the workflow; never masquerade as user work.
      heroArt.innerHTML = '<div class="workspace-art-wire"></div><div class="workspace-art-prompt"><span><i data-lucide="text-cursor-input"></i> 灵感起点</span><p>暮色中的长街，<br>让故事从这一帧开始。</p><i class="workspace-art-port"></i></div><div class="workspace-art-scene"><img src="/static/design-review/assets/scene-v1.png" alt="" decoding="async" width="1536" height="1024"><span><i data-lucide="image"></i> 场景探索</span><i class="workspace-art-port"></i></div><div class="workspace-art-character"><img src="/static/design-review/assets/character-v1.png" alt="" decoding="async" width="1536" height="1024"><span>CHARACTER STUDY / 01</span></div><small class="workspace-art-caption">提示词 → 画面 → 故事<span>AI 创作示意</span></small>';
      heading.append(heroArt);
      const welcome = document.createElement('div'); welcome.className = 'workspace-welcome';
      welcome.innerHTML = '<div><span>工作空间</span><h2>今天，想创造点什么？</h2></div><span class="workspace-local-badge"><i data-lucide="hard-drive" aria-hidden="true"></i> 本地工作台</span>';
      heading.before(welcome);
      const create = kind => {
        newCanvasBtn.click();
        document.querySelector(`#homeCreateDialog [data-kind="${kind}"]`)?.click();
      };
      const assets = () => location.assign('/static/studio-assets.html?project=' + encodeURIComponent(currentProjectId || 'default'));
      const quickstart = document.createElement('nav'); quickstart.className = 'workspace-quickstart'; quickstart.setAttribute('aria-label', '快速开始');
      for (const [label, icon, action, kind, description] of [
        ['经典画布', 'layout-dashboard', () => create('classic'), 'classic', '编排与连接灵感'],
        ['本地资产', 'folder-open', assets, '', '让素材随时就绪'],
        ['选择 API 服务', 'sliders-horizontal', () => settings.click(), '', '连接创作工具']
      ]) {
        const button = makeButton(label, icon, action), text = button.querySelector('span');
        text.className = 'workspace-quick-copy'; const hint = document.createElement('small'); hint.textContent = description; text.append(hint);
        const arrow = document.createElement('i'); arrow.dataset.lucide = 'arrow-up-right'; arrow.setAttribute('aria-hidden','true'); button.append(arrow);
        if (kind) button.dataset.workspaceCreate = kind; quickstart.append(button);
      }
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
        // A mobile drawer owns keyboard focus until it closes.
        for (const child of main.children) if (!child.classList.contains('ws-topbar')) child.inert = open && narrow.matches;
        document.querySelector('.ws-topbar-right').inert = open && narrow.matches;
        sidebar.setAttribute('aria-label', '工作空间导航');
        if (open) nav.querySelector('button')?.focus();
      }
      for (const [label, icon, action] of [
        ['创作工作台', 'house', () => {main.scrollTo({top:0}); newCanvasBtn.focus();}],
        ['项目画布', 'panels-top-left', () => {document.getElementById('homeSearch').focus();}],
        ['本地资产', 'folder-open', assets], ['公共画廊', 'images', openGallery], ['API 服务', 'sliders-horizontal', () => settings.click()]
      ]) nav.append(makeButton(label, icon, () => {setSidebar(false); action();}));
      nav.firstElementChild.setAttribute('aria-current', 'page'); sidebar.querySelector('.ws-side-head').before(nav);
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
      const note = document.createElement('p'); note.className = 'workspace-local-note'; note.innerHTML = '<i data-lucide="shield-check" aria-hidden="true"></i><span>本地创作，随时开始。登录可连接 API 账户，也支持自选服务。</span>';
      quickstart.after(note); document.querySelector('.v2-home-footer').textContent = '项目与素材保存在本机，生成内容使用你选择的 API 服务。';
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
