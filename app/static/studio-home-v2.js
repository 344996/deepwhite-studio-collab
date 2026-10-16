/* Reviewed homepage on the real project manager. Native CRUD remains authoritative. */
(() => {
  'use strict';
  if (!document.querySelector('.ws-sidebar') || window.StudioHomeV2) return;
  const root = document.documentElement;
  root.classList.add('studio-v2', 'studio-v2-home');
  for (const href of ['/static/studio-v2-theme.css', '/static/studio-home-v2.css']) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; document.head.append(link);
  }
  function material() {
    let value = '', explicit = false;
    try { value = localStorage.getItem('deepwhite_canvas_material') || ''; explicit = localStorage.getItem('studio_theme') !== null || localStorage.getItem('canvas_theme') !== null; } catch {}
    root.classList.toggle('studio-graphite', value === 'graphite' || (!value && !explicit));
    root.classList.toggle('studio-milk', value === 'milk');
  }
  material(); window.addEventListener('storage', material); window.addEventListener('studio-theme-change', material);
  const main = document.querySelector('.ws-main'), topbar = document.querySelector('.ws-topbar');
  const brand = document.querySelector('.studio-brand-bar');
  if (brand) { topbar.prepend(brand); brand.querySelector('small').textContent = 'DEEPWHITE STUDIO'; }
  document.querySelector('.ws-side-title').textContent = '项目文件夹';
  const navigationTitle = document.createElement('div'); navigationTitle.className = 'v2-workspace-title'; navigationTitle.textContent = '我的工作空间';
  document.querySelector('.ws-sidebar').prepend(navigationTitle);
  document.querySelector('.home-demos')?.remove(); document.querySelector('.home-overview')?.remove();
  const intro = document.querySelector('.home-intro'), search = document.getElementById('homeSearch'), views = document.querySelector('.studio-home-views');
  intro.replaceChildren();
  const heading = document.createElement('div'); heading.className = 'v2-home-heading';
  heading.innerHTML = '<div><small>YOUR NEXT STORY</small><h1>每个故事，都从这里开始。</h1><p>把灵感留在画布上，继续创造你的下一幕。</p></div>';
  heading.append(newCanvasBtn); intro.append(heading);
  const controls = document.createElement('div'); controls.className = 'v2-home-controls';
  controls.innerHTML = '<div class="v2-home-section"><h2 id="homeFolderTitle">项目画布</h2><span id="homeResultCount"></span></div>';
  const tools = document.createElement('div'); tools.className = 'v2-home-search-tools';
  const searchBox = document.createElement('label'); searchBox.className = 'v2-home-search'; searchBox.innerHTML = '<i data-lucide="search" aria-hidden="true"></i>';
  search.type = 'search'; search.placeholder = '搜索当前文件夹的画布'; searchBox.append(search); tools.append(searchBox, views); controls.append(tools); intro.append(controls);
  const noResults = document.createElement('div'); noResults.id = 'homeSearchEmpty'; noResults.className = 'v2-home-empty'; noResults.hidden = true;
  noResults.innerHTML = '<i data-lucide="search" aria-hidden="true"></i><h3>没有找到这张画布</h3><p>换个关键词，或清除搜索继续浏览。</p><button type="button">清除搜索</button>';
  noResults.querySelector('button').onclick = () => { search.value = ''; filter(); search.focus(); }; board.append(noResults);
  const footer = document.createElement('p'); footer.className = 'v2-home-footer'; footer.textContent = '灵感不必完整，先让故事有一个开始。'; main.append(footer);
  function filter() {
    const query = search.value.trim().toLocaleLowerCase(); let count = 0;
    boardWorld.querySelectorAll('.ws-card').forEach(card => { card.hidden = !card.querySelector('.ws-card-title').textContent.toLocaleLowerCase().includes(query); if (!card.hidden) { count++; watch(card); } });
    const total = canvasesInProject(currentProjectId).length;
    noResults.hidden = !query || count > 0 || total === 0;
    boardEmptyHint.classList.toggle('hidden', total > 0);
    document.getElementById('homeResultCount').textContent = query ? `${count} / ${total} 张画布` : `${total} 张画布`;
    document.getElementById('homeFolderTitle').textContent = currentProject()?.name || '项目画布';
  }
  search.oninput = filter;
  // Cache only a cover URL, never complete canvas documents. GET does not generate media.
  const cache = new Map(), queue = []; let active = 0;
  const localImage = value => {
    const raw = typeof value === 'string' ? value : value?.url || value?.src || value?.path;
    if (typeof raw !== 'string') return '';
    try {
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin || !/^\/(?:output|assets|api\/storage-files)\//.test(url.pathname) || !/\.(png|jpe?g|webp|gif|avif)$/i.test(url.pathname)) return '';
      if (value && typeof value === 'object' && /video|audio/i.test(value.kind || value.type || value.mediaKind || '')) return '';
      return url.pathname + url.search;
    } catch { return ''; }
  };
  function coverFor(document) {
    const nodes = Array.isArray(document?.nodes) ? document.nodes : [];
    for (const node of [...nodes].reverse()) {
      for (const field of ['images', 'outputs', 'generatedOutputs', 'output', 'studioOutputs']) {
        const value = node[field]; for (const item of (Array.isArray(value) ? [...value].reverse() : [value])) { const url = localImage(item); if (url) return url; }
      }
    }
    for (const node of nodes) { if (node.type === 'image') { const url = localImage(node.url); if (url) return url; } }
    return '';
  }
  function current(job) { return job.card.isConnected && !job.card.hidden && job.project === currentProjectId && job.card.dataset.canvasId === job.id && job.card.dataset.coverKey === job.key; }
  function paint(job, url) {
    if (!url || !current(job)) return;
    const cover = job.card.querySelector('.home-canvas-cover'), image = new Image(); image.alt = ''; image.decoding = 'async';
    image.onload = () => { if (current(job)) { cover.replaceChildren(image); cover.classList.add('has-image'); } };
    image.src = url;
  }
  async function pump() {
    while (active < 3 && queue.length) {
      const job = queue.shift(); if (!current(job)) { job.card.dataset.coverQueued = ''; continue; }
      active++;
      (async () => {
        try { const response = await fetch(`/api/canvases/${encodeURIComponent(job.id)}`); if (!response.ok) return; const data = await response.json(); const document = data.canvas || data;
          if (document.id !== job.id || String(document.project || 'default') !== job.project) return;
          const url = coverFor(document); cache.set(job.key, url); if (cache.size > 80) cache.delete(cache.keys().next().value); paint(job, url);
        } catch { /* A cover failure must leave the real card usable. */ }
        finally { job.card.dataset.coverQueued = ''; active--; pump(); }
      })();
    }
  }
  function loadCover(card) {
    if (card.hidden) return;
    const job = {card, id:card.dataset.canvasId, project:currentProjectId, key:card.dataset.coverKey};
    if (cache.has(job.key)) { paint(job, cache.get(job.key)); return; }
    if (card.dataset.coverQueued) return;
    card.dataset.coverQueued = 'yes'; queue.push(job); pump();
  }
  const observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) loadCover(entry.target); }, {root:main, threshold:0.05});
  function watch(card) { observer.observe(card); }
  const nativeBuild = buildCard;
  buildCard = function(c) {
    const card = nativeBuild(c); card.dataset.coverKey = `${c.project || 'default'}:${c.id}:${c.updated_at || 0}:${c.node_count || 0}`;
    const cover = card.querySelector('.home-canvas-cover'); cover.innerHTML = '<div class="v2-cover-art"><span></span><span></span><span></span></div><small>等待你的下一幕</small>';
    if (c.pinned) { const label = document.createElement('span'); label.className = 'v2-home-pinned'; label.textContent = '已置顶'; card.querySelector('.ws-card-top').prepend(label); }
    card.setAttribute('aria-label', `${c.title}，${c.kind === 'smart' ? '智能画布' : '普通画布'}`); return card;
  };
  renderBoard = function() {
    observer.disconnect(); queue.length = 0; updateBoardHeader();
    boardWorld.replaceChildren(...canvasesInProject(currentProjectId).map(buildCard));
    updatePasteBtn(); filter(); refreshIcons();
  };
  const nativeProjects = renderProjects;
  renderProjects = function(...args) {
    const result = nativeProjects(...args);
    projectListEl.querySelectorAll('.ws-project-row').forEach(row => { row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-current', String(row.dataset.projectId === currentProjectId)); row.onkeydown = event => { if (event.target === row && ['Enter', ' '].includes(event.key)) { event.preventDefault(); row.click(); } }; });
    return result;
  };
  const nativeSelectProject = selectProject;
  selectProject = function(pid) {
    const result = nativeSelectProject(pid);
    if (currentProjectId === pid) { const url = new URL(location.href); url.searchParams.set('project', pid); history.replaceState(history.state, '', url); }
    return result;
  };
  // Keep the original classic/smart POST and menu actions, with an accessible modal.
  const nativeOpenCreate = openCreateCard, nativeCloseCreate = closeCreateCard; let createDialog, createTrigger;
  closeCreateCard = function(...args) { nativeCloseCreate(...args); if (createDialog) { createDialog.close(); createDialog.remove(); createDialog = null; createTrigger?.focus(); } };
  openCreateCard = function(...args) {
    createTrigger = document.activeElement; nativeOpenCreate(...args);
    const smart = document.createElement('button'); smart.type = 'button'; smart.className = 'ws-create-toggle-btn'; smart.dataset.kind = 'smart'; smart.textContent = L('智能画布', 'Smart');
    smart.onclick = () => { createKind = 'smart'; createCardEl.querySelectorAll('[data-kind]').forEach(button => button.classList.toggle('active', button === smart)); };
    createCardEl.querySelector('.ws-create-toggle').append(smart);
    const d = document.createElement('dialog'); d.id = 'homeCreateDialog'; d.setAttribute('aria-label', '新建画布'); createDialog = d; document.body.append(d); d.append(createCardEl);
    d.addEventListener('cancel', event => { event.preventDefault(); closeCreateCard(); }); d.onclick = event => { if (event.target === d) closeCreateCard(); };
    d.showModal(); createCardEl.querySelector('input').focus();
  };
  document.getElementById('boardStatus').setAttribute('role', 'status');
  document.querySelector('.ws-trash-head-title').setAttribute('id', 'homeTrashTitle'); trashPanel.setAttribute('aria-labelledby', 'homeTrashTitle');
  window.StudioHomeV2 = Object.freeze({version:1}); renderProjects(); renderBoard();
})();
