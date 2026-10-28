/* U03 (handover 2026-10-26): a generation node that already has a result shows the result, its name
   and its status; the prompt, references and parameters open for the node you selected or last worked
   in, while you type in it, and while its task needs you (failed, unconfirmed, paused). Watching the
   result does not open it. Nothing is cleared: collapsing only hides the editor.
   Also keeps UI-NEW-01/02 in check: collapsed cards are short, so they stop covering their neighbours. */
(() => {
  'use strict';
  const layer = document.getElementById('nodes');
  if (!layer) return;
  let frame = 0, lastOpen = '';
  // A failed, unconfirmed or paused task (MJ keeps its own status) needs the user: its editor, retry and
  // "query the original task" stay in reach instead of being folded away.
  const ATTENTION = ['failed', 'uncertain', 'paused'], MJ_ATTENTION = ['failed', 'uncertain', 'paused', 'submitting'];
  function needsAction(id) {
    const node = typeof nodes !== 'undefined' && Array.isArray(nodes) ? nodes.find(n => n.id === id) : null;
    return Boolean(node && (ATTENTION.includes(node.studioJobState) || MJ_ATTENTION.includes(node.studioMjStatus)));
  }
  function apply() {
    frame = 0;
    const selectedCards = layer.querySelectorAll('.node.selected');
    // The card you opened or last worked in stays open until you pick something else or click the empty canvas,
    // so an undo or a redraw that drops the selection does not fold the editor under your hands.
    if (selectedCards.length === 1) lastOpen = selectedCards[0].dataset.id || '';
    else if (selectedCards.length > 1) lastOpen = '';
    for (const card of layer.querySelectorAll('.node.generator-node, .node.video-node')) {
      const hasResult = Boolean(card.querySelector('.studio-node-media img, .studio-node-media video'));
      const active = document.activeElement, editing = card.contains(active) && !active.closest('.studio-node-media');
      const open = !hasResult || (lastOpen && card.dataset.id === lastOpen) || editing || needsAction(card.dataset.id);
      if (card.classList.contains('studio-collapsed') === open) card.classList.toggle('studio-collapsed', !open);
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  new MutationObserver(schedule).observe(layer, {subtree: true, childList: true, attributes: true, attributeFilter: ['class']});
  // Leaving a field may collapse its card, but only after the click that moved focus is handled.
  document.addEventListener('focusin', schedule, true);
  document.addEventListener('pointerdown', event => {
    const target = event.target, card = target.closest?.('#nodes .node');
    // Working in a card (e.g. pressing its generate button) keeps it open when its result arrives.
    // Playing or enlarging the result is watching it, not editing: that leaves the card as it is.
    if (card) { if (!target.closest('.studio-node-media')) { lastOpen = card.dataset.id || ''; schedule(); } }
    else if (event.button === 0 && target.closest?.('#board') && !target.closest('[popover]')) { lastOpen = ''; schedule(); }
  }, true);
  document.addEventListener('focusout', () => setTimeout(schedule, 0), true);
  window.StudioResultCollapse = Object.freeze({refresh: apply});
  schedule();
})();
