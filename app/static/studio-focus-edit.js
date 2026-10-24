/* UX-01: editing text on a zoomed-out canvas. When a field's on-screen text would be smaller
   than READABLE_PX, the view eases to a readable zoom centred on that field; when editing ends
   (focus leaves the node, or Escape) it returns to the exact previous view. Shared by both canvases. */
(() => {
  'use strict';
  const READABLE_PX = 12, TARGET_PX = 14;
  const reference = () => (typeof shell !== 'undefined' && shell) || (typeof board !== 'undefined' && board) || null;
  const nodeOf = el => el?.closest?.('.node[data-id], .image-node[data-id], #composer');
  const editable = el => el instanceof HTMLElement && (el.matches('textarea, input[type="text"], input:not([type])') || el.isContentEditable)
    && !el.readOnly && !el.disabled && !!nodeOf(el) && !!(typeof world !== 'undefined' && world?.contains(el));
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = () => reduced() ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--studio-motion-viewport')) || 210;
  let saved = null, editing = null, frame = 0, intent = {time: -1e9, target: null};
  // Only focus the person just caused (a press or Tab) zooms; focus restored by the app does not.
  const userCaused = el => performance.now() - intent.time < 800 && (intent.target === 'keyboard' || nodeOf(intent.target) === nodeOf(el));
  document.addEventListener('pointerdown', event => { intent = {time: performance.now(), target: event.target}; }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Tab') intent = {time: performance.now(), target: 'keyboard'}; }, true);
  const same = (a, b) => a && b && Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5 && Math.abs(a.scale - b.scale) < 1e-4;

  function animateTo(target) {
    cancelAnimationFrame(frame);
    const from = {x: viewport.x, y: viewport.y, scale: viewport.scale}, ms = duration(), start = performance.now();
    return new Promise(resolve => {
      const step = now => {
        const t = ms ? Math.min(1, (now - start) / ms) : 1, k = 1 - Math.pow(1 - t, 3);
        viewport.x = from.x + (target.x - from.x) * k; viewport.y = from.y + (target.y - from.y) * k;
        viewport.scale = from.scale + (target.scale - from.scale) * k;
        applyViewport();
        if (t < 1) frame = requestAnimationFrame(step); else { frame = 0; if (typeof refreshGeometry === 'function') refreshGeometry(); resolve(); }
      };
      step(start);
    });
  }

  function onScreenFontPx(el) {
    // The real rendered size, whatever transforms scale the layer it sits in.
    const scale = el.offsetHeight ? el.getBoundingClientRect().height / el.offsetHeight : viewport.scale;
    return parseFloat(getComputedStyle(el).fontSize) * scale;
  }

  async function begin(el) {
    const ref = reference();
    if (!ref || typeof viewport === 'undefined' || typeof applyViewport !== 'function') return;
    const px = onScreenFontPx(el);
    if (!(px > 0) || px >= READABLE_PX) return;
    const limits = window.STUDIO_SMART_ZOOM || {max: 8};
    const scale = Math.min(limits.max, viewport.scale * TARGET_PX / px);
    const box = ref.getBoundingClientRect(), rect = el.getBoundingClientRect();
    const wx = (rect.left + Math.min(rect.width, box.width) / 2 - box.left - viewport.x) / viewport.scale;
    const wy = (rect.top + Math.min(rect.height, box.height * .4) / 2 - box.top - viewport.y) / viewport.scale;
    if (!saved) saved = {x: viewport.x, y: viewport.y, scale: viewport.scale};
    editing = {node: nodeOf(el), view: {x: box.width / 2 - wx * scale, y: box.height * .4 - wy * scale, scale}};
    await animateTo(editing.view);
    el.focus({preventScroll: true});
  }

  async function end() {
    const restore = saved, view = editing?.view, moving = Boolean(frame);
    saved = null; editing = null;
    // Restore unless the person moved the canvas themselves while editing.
    if (restore && (moving || same(view, {x: viewport.x, y: viewport.y, scale: viewport.scale}))) await animateTo(restore);
  }

  document.addEventListener('focusin', event => {
    const el = event.target;
    if (!editable(el)) return;
    if (editing && nodeOf(el) === editing.node) return;
    if (!userCaused(el)) return;
    begin(el);
  });
  document.addEventListener('focusout', event => {
    if (!editing) return;
    setTimeout(() => {
      const next = document.activeElement;
      if (next && editing && nodeOf(next) === editing.node && editable(next)) return;
      end();
    }, 0);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && editing && editable(event.target)) { event.target.blur(); }
  }, true);
  window.StudioFocusEdit = {active: () => Boolean(editing), readablePx: READABLE_PX};
})();
