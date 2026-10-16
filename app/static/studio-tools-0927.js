/* 0927 tool placement: keep the dedicated compare action node-based and put link flow in canvas settings. */
(() => {
  if (document.querySelector('.smart-back')) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/static/studio-tools-0927.css?v=1';
  document.head.append(css);

  const assetTools = window.StudioAssetTools;
  if (assetTools) {
    const compareButton = document.querySelector('#quickToolbar [data-canvas-tool="compare"]');
    if (compareButton) document.addEventListener('click', event => {
      const button = event.target.closest?.('#quickToolbar [data-canvas-tool="compare"]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      assetTools.addCompare();
    }, true);

    // Preserve older callers while routing them to a persistent compare node.
    window.openCanvasComparePanel = preselect => {
      const picks = assetTools.selectedPictures();
      const preferred = typeof preselect === 'string' ? { url: preselect } : preselect;
      const first = preferred?.url ? preferred : picks[0];
      const second = picks.find(item => item.url !== first?.url);
      return assetTools.createCompare(first, second);
    };
  }

  const flow = document.querySelector('#quickToolbar .studio-flow-toggle');
  if (flow) {
    flow.addEventListener('click', event => event.stopPropagation());
    const placeFlowInSettings = () => {
      const container = window.StudioCanvasSettings?.container;
      if (!container || !container.append) return false;
      if (flow.parentElement !== container) container.append(flow);
      return true;
    };
    if (!placeFlowInSettings()) window.addEventListener('studio-canvas-settings-ready', placeFlowInSettings);
  }
})();
