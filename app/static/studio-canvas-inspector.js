/* The old inspector entry point now keeps actions beside the selected node.
 * Fields remain in the native node/composer, with a single owner for undo/save. */
(() => {
  'use strict';
  function initialize() {
    const workspace = window.StudioCanvasWorkspace;
    if (!workspace || window.StudioCanvasInspector) return;
    const smart = document.documentElement.classList.contains('studio-v2-smart');
    let frame = 0, watched = [];
    function refresh() {
      frame = 0;
      document.documentElement.classList.remove('workspace-inspector-open');
      if (smart) return; // Native smart menu is already attached to its node.
      const toolbar = document.getElementById('studioV2Selection');
      if (!toolbar || !canvas) return;
      const cards = [...selected].map(id => nodesEl.querySelector(`[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
      toolbar.hidden = !cards.length;
      // A selected node grows when its composer opens, after the click that selected it.
      if (cards.length !== watched.length || cards.some((card, index) => card !== watched[index])) { watched = cards; resized.disconnect(); cards.forEach(card => resized.observe(card)); }
      if (!cards.length) return;
      toolbar.classList.add('workspace-node-actions');
      toolbar.setAttribute('aria-label', '选中节点操作');
      const bounds = cards.map(card => card.getBoundingClientRect());
      const left = Math.min(...bounds.map(rect => rect.left)), right = Math.max(...bounds.map(rect => rect.right));
      const top = Math.min(...bounds.map(rect => rect.top)), bottom = Math.max(...bounds.map(rect => rect.bottom));
      const width = toolbar.offsetWidth, height = toolbar.offsetHeight, floor = innerHeight-height-84;
      let x = Math.max(12, Math.min(innerWidth-width-12, (left+right-width)/2));
      const headerAt = at => Math.max(0, ...['.topbar', '.workspace-canvas-tools'].map(selector => {
        const bar = document.querySelector(selector)?.getBoundingClientRect();
        return bar && bar.left < at+width && bar.right > at ? bar.bottom : 0;
      }));
      let header = headerAt(x);
      // Above the selection when it fits, else below it, else beside it, so the bar never covers the node's fields.
      let y = top-height-12;
      if (y < header+10) {
        const beside = right+12+width <= innerWidth-12 ? right+12 : left-width-12 >= 12 ? left-width-12 : null;
        if (bottom+12 <= floor) y = bottom+12;
        else if (beside !== null) { x = beside; header = headerAt(x); y = top; }
      }
      toolbar.style.left = x + 'px';
      toolbar.style.top = Math.max(header+10, Math.min(floor, y)) + 'px';
      toolbar.style.bottom = 'auto'; toolbar.style.transform = 'none';
      toolbar.hidden = right < 0 || left > innerWidth || bottom < header;
    }
    function sync() { if (!frame) frame=requestAnimationFrame(refresh); }
    const resized = new ResizeObserver(sync);
    window.addEventListener('mouseup',sync); window.addEventListener('resize',sync);
    window.StudioCanvasInspector = Object.freeze({sync,ready:true,mode:'node-actions'}); sync();
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',initialize,{once:true}); else initialize();
})();
