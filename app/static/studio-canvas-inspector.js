/* The old inspector entry point now keeps actions beside the selected node.
 * Fields remain in the native node/composer, with a single owner for undo/save. */
(() => {
  'use strict';
  function initialize() {
    const workspace = window.StudioCanvasWorkspace;
    if (!workspace || window.StudioCanvasInspector) return;
    const smart = document.documentElement.classList.contains('studio-v2-smart');
    let frame = 0;
    function refresh() {
      frame = 0;
      document.documentElement.classList.remove('workspace-inspector-open');
      if (smart) return; // Native smart menu is already attached to its node.
      const toolbar = document.getElementById('studioV2Selection');
      if (!toolbar || !canvas) return;
      const cards = [...selected].map(id => nodesEl.querySelector(`[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
      toolbar.hidden = !cards.length;
      if (!cards.length) return;
      toolbar.classList.add('workspace-node-actions');
      toolbar.setAttribute('aria-label', '选中节点操作');
      const bounds = cards.map(card => card.getBoundingClientRect());
      const left = Math.min(...bounds.map(rect => rect.left)), right = Math.max(...bounds.map(rect => rect.right));
      const top = Math.min(...bounds.map(rect => rect.top)), bottom = Math.max(...bounds.map(rect => rect.bottom));
      const header = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 72;
      const width = toolbar.offsetWidth, height = toolbar.offsetHeight, floor = innerHeight-height-84;
      // Above the selection when it fits, else below it, so the bar never covers the selected node's header.
      let y = top-height-12;
      if (y < header+10 && bottom+12 <= floor) y = bottom+12;
      toolbar.style.left = Math.max(12, Math.min(innerWidth-width-12, (left+right-width)/2)) + 'px';
      toolbar.style.top = Math.max(header+10, Math.min(floor, y)) + 'px';
      toolbar.style.bottom = 'auto'; toolbar.style.transform = 'none';
      toolbar.hidden = right < 0 || left > innerWidth || bottom < header;
    }
    function sync() { if (!frame) frame=requestAnimationFrame(refresh); }
    window.addEventListener('mouseup',sync); window.addEventListener('resize',sync);
    window.StudioCanvasInspector = Object.freeze({sync,ready:true,mode:'node-actions'}); sync();
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',initialize,{once:true}); else initialize();
})();
