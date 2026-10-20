/* Visual feedback only. Native controls keep ownership of clicks, shortcuts,
   dragging, focus, saving and generation; this module never dispatches actions. */
(() => {
  'use strict';
  if (window.StudioInteractions) return;
  const root = document.documentElement;
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  const version = new URL(document.currentScript.src).searchParams.get('v');
  stylesheet.href = '/static/studio-interactions.css' + (version ? '?v=' + encodeURIComponent(version) : '');
  document.head.append(stylesheet);
  root.classList.add('studio-interactions');
  const selector = 'button,summary,[role="button"],a[href],[role="link"]';
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  let hovered = null, pressed = null;
  // Watch only active controls and their ancestors. Observing the entire canvas
  // subtree would allocate records for unrelated node updates on every render.
  const statusObserver = new MutationObserver(() => {
    if (hovered && (!hovered.isConnected || control(hovered) !== hovered)) hover(null);
    if (pressed && (!pressed.item.isConnected || control(pressed.item) !== pressed.item)) release();
  });
  function watchStatus() {
    statusObserver.disconnect();
    const targets = new Set();
    for (const item of [hovered, pressed?.item]) {
      for (let ancestor = item; ancestor; ancestor = ancestor.parentElement) targets.add(ancestor);
    }
    for (const target of targets) statusObserver.observe(target, {attributes:true, attributeFilter:['disabled','aria-disabled','aria-busy','inert','class']});
  }
  function control(target) {
    if (!(target instanceof Element) || target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-dw-feedback="none"]')) return null;
    const item = target.closest(selector);
    if (!item || item.matches(':disabled') || item.closest('[inert],[aria-disabled="true"],[aria-busy="true"],.busy')) return null;
    // Links without a destination and disabled fieldset descendants are not actions.
    return item;
  }
  function hover(item) {
    if (hovered === item) return;
    hovered?.removeAttribute('data-dw-hover');
    hovered = item;
    hovered?.setAttribute('data-dw-hover', '');
    watchStatus();
  }
  function release() {
    pressed?.item.removeAttribute('data-dw-press');
    pressed = null;
    watchStatus();
  }
  function reset() {hover(null); release();}
  document.addEventListener('pointerover', event => {
    if (event.pointerType !== 'touch' && finePointer.matches) hover(control(event.target));
  }, {capture:true, passive:true});
  document.addEventListener('pointerout', event => {
    if (event.pointerType !== 'touch' && finePointer.matches) hover(control(event.relatedTarget));
  }, {capture:true, passive:true});
  document.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    release();
    const item = control(event.target);
    if (!item) return;
    pressed = {item, id:event.pointerId, type:event.pointerType, x:event.clientX, y:event.clientY};
    item.setAttribute('data-dw-press', '');
    watchStatus();
  }, {capture:true, passive:true});
  document.addEventListener('pointermove', event => {
    if (!pressed || pressed.id !== event.pointerId) return;
    const {item, type, x, y} = pressed;
    const bounds = item.getBoundingClientRect();
    if (control(item) !== item || (type === 'touch' && Math.hypot(event.clientX - x, event.clientY - y) > 10) ||
        event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) release();
  }, {capture:true, passive:true});
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    window.addEventListener(type, event => {if (pressed?.id === event.pointerId) release();}, {capture:true, passive:true});
  }
  document.addEventListener('keydown', event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || !['Enter', ' '].includes(event.key)) return;
    const item = control(event.target);
    if (!item || (event.key === ' ' && item.matches('a[href],[role="link"]'))) return;
    release(); pressed = {item, key:event.key}; item.setAttribute('data-dw-press', ''); watchStatus();
  }, true);
  window.addEventListener('keyup', event => {if (pressed?.key === event.key) release();}, true);
  document.addEventListener('focusout', () => {if (pressed?.key) release();}, true);
  document.addEventListener('scroll', release, {capture:true, passive:true});
  document.addEventListener('visibilitychange', () => {if (document.hidden) reset();});
  window.addEventListener('blur', reset);
  window.addEventListener('pagehide', reset);
  finePointer.addEventListener('change', reset);
  window.StudioInteractions = Object.freeze({ready:true});
})();
