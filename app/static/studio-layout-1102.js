/* Canvas layout (2026-11-02): arranges the floating controls and fills a new canvas started from the home
   page. Every control keeps its native handler; nothing here touches the document format. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);

  function arrange() {
    const rail = $('workspaceCanvasRail'), make = window.StudioCanvasWorkspace.button;
    const divider = () => { const line = document.createElement('span'); line.className = 'v2-rail-divider'; line.setAttribute('aria-hidden', 'true'); return line; };
    if (rail && !$('workspaceHistory')) {
      const history = make('workspaceHistory', '历史', 'clock', () => document.querySelector('.studio-history-button')?.click());
      const shortcuts = document.querySelector('.v2-navigation [aria-label="快捷键帮助"]');
      if (shortcuts) shortcuts.id = 'workspaceShortcuts';
      $('studioV2Add')?.after(divider(), history, divider());
      $('studioV2Hand')?.after(divider());
      if (shortcuts) rail.append(divider(), shortcuts);
    }
    // Saving is automatic and shown in the left capsule; the manual button moves under "更多工具".
    const save = $('workspaceSave'), panel = document.querySelector('.workspace-more-panel');
    if (save && panel) panel.prepend(save);
    // The map opens on request instead of covering the corner of the canvas.
    const map = $('minimap'), mapButton = document.querySelector('.v2-navigation [aria-label="显示或隐藏导航地图"]');
    if (map && mapButton) { map.hidden = true; mapButton.setAttribute('aria-pressed', 'false'); }
    const actions = $('studioV2Selection');
    if (actions && !$('workspaceDeleteNodes')) {
      const remove = make('workspaceDeleteNodes', '删除选中节点', 'trash-2', () => deleteSelectedNodes());
      remove.classList.add('v2-icon-button'); remove.querySelector('span').hidden = true; actions.append(remove);
    }
    window.lucide?.createIcons();
  }

  /* A plan is a list of node kinds and positions; links are [from index, to index]. */
  const STARTERS = {
    image: {nodes: [['image', 0, 0]], links: []},
    video: {nodes: [['video', 0, 0]], links: []},
    audio: {nodes: [['audio', 0, 0]], links: []},
    text: {nodes: [['text', 0, 0]], links: []},
    storyboard: {nodes: [['prompt', 0, 380], ['image', 460, 0], ['image', 460, 400], ['image', 460, 800]], links: [[0, 1], [0, 2], [0, 3]]},
    character: {nodes: [['prompt', 0, 200], ['image', 460, 200], ['image', 1180, 0], ['image', 1180, 400]], links: [[0, 1], [1, 2], [1, 3]]},
    product: {nodes: [['prompt', 0, 0], ['image', 460, 0], ['video', 1180, 0]], links: [[0, 1], [1, 2]]},
    style: {nodes: [['image', 0, 0], ['image', 720, 0]], links: [[0, 1]]},
    img2video: {nodes: [['image', 0, 0], ['video', 720, 0]], links: [[0, 1]]},
  };
  function addKind(kind, point) {
    if (kind === 'prompt') return addPromptNode(point);
    if (kind === 'text') return addLLMNode(point);
    if (kind === 'audio') return window.studioAddAudioNode?.(point);
    return kind === 'video' ? addVideoNode(point) : addGeneratorNode(point);
  }
  function applyStarter(name) {
    if (name === 'workflows') { window.StudioWorkflows?.open(); return; }
    const plan = STARTERS[name];
    if (!plan) return;
    const origin = screenToWorld(120, 120);
    const created = plan.nodes.map(([kind, x, y]) => addKind(kind, {x: origin.x + x, y: origin.y + y}));
    for (const [from, to] of plan.links) if (created[from] && created[to]) connections.push({id: uid('c'), from: created[from].id, to: created[to].id});
    const first = created.find(node => node && node.type !== 'prompt') || created[0];
    selected.clear(); if (first) selected.add(first.id);
    render(); scheduleSave();
    if (created.length > 1) document.querySelector('.v2-navigation [aria-label="适应全部节点 · Shift+1"]')?.click();
  }
  // Only a brand-new, empty canvas is filled; the marker leaves the address so a reload cannot repeat it.
  function starter() {
    const url = new URL(location.href), name = url.searchParams.get('starter');
    if (!name) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (typeof canvas === 'undefined' || !canvas) { if (++tries > 100) clearInterval(timer); return; }
      clearInterval(timer);
      url.searchParams.delete('starter'); history.replaceState(null, '', url);
      if (!nodes.length) applyStarter(name);
    }, 100);
  }

  function initialize() {
    if (!document.documentElement.classList.contains('studio-v2-canvas') || !window.StudioCanvasWorkspace) return;
    arrange(); starter();
    window.StudioLayout1102 = Object.freeze({ready: true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once: true}); else initialize();
})();
