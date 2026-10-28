/* U10: the smart canvas is retired. Old canvases still open and save. A badge in the header's title
   line says so without covering the canvas or its controls; it opens a panel that explains it and
   offers a backed-up copy as a classic canvas (the original is never changed) or a JSON export. */
(() => {
  'use strict';
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'studio-smart-retire-badge';
  badge.textContent = '旧版 · 已停止新建';
  badge.setAttribute('aria-haspopup', 'dialog');
  badge.setAttribute('aria-expanded', 'false');
  badge.setAttribute('aria-controls', 'studioSmartRetire');
  const bar = document.createElement('section');
  bar.id = 'studioSmartRetire';
  bar.className = 'studio-smart-retire';
  bar.setAttribute('popover', 'auto');
  bar.setAttribute('role', 'dialog');
  bar.setAttribute('aria-label', '智能画布已停止新建');
  bar.innerHTML = '<p><strong>智能画布已停止新建。</strong>这个旧画布仍可查看和编辑；建议迁移到经典画布（先自动备份，原画布保留不变）。</p>'
    + '<div><button type="button" data-migrate class="primary">迁移到经典画布</button><button type="button" data-export>导出</button>'
    + '<button type="button" data-fold aria-label="收起提示">收起</button></div><p data-result role="status" aria-live="polite"></p>';
  const result = bar.querySelector('[data-result]');
  // Open under the badge; the page's own controls stay where they are and keep working.
  const position = () => {
    const anchor = badge.isConnected && badge.getClientRects().length ? badge.getBoundingClientRect() : {left: 16, bottom: 16};
    const width = Math.min(420, innerWidth - 32);
    bar.style.width = width + 'px';
    bar.style.left = Math.max(16, Math.min(Math.round(anchor.left), innerWidth - width - 16)) + 'px';
    bar.style.top = Math.round(anchor.bottom + 8) + 'px';
  };
  badge.onclick = () => bar.togglePopover();
  bar.addEventListener('toggle', event => {
    badge.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState === 'open') position();
  });
  bar.querySelector('[data-fold]').onclick = () => { bar.hidePopover(); badge.focus({preventScroll: true}); };
  bar.querySelector('[data-export]').onclick = async () => {
    try {
      const response = await fetch('/api/canvases/' + encodeURIComponent(id));
      if (!response.ok) throw Error('读取画布失败');
      const data = await response.json();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(data.canvas, null, 2)], {type: 'application/json'}));
      link.download = (data.canvas.title || 'smart-canvas') + '.json';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      result.textContent = '已导出画布数据。';
    } catch (error) { result.textContent = '导出失败：' + (error.message || '请稍后重试'); }
  };
  bar.querySelector('[data-migrate]').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true; result.textContent = '正在备份并迁移…';
    try {
      // Unsaved edits go first, so the copy contains what is on screen.
      // saveCanvas reports a conflict or a busy save as {ok:false} instead of throwing.
      if (typeof saveCanvas === 'function') {
        let saved = await saveCanvas();
        if (saved?.ok === false && saved.pending) { await new Promise(done => setTimeout(done, 900)); saved = await saveCanvas(); }
        if (saved?.ok === false) throw Error('当前修改还没保存好（' + (saved.error || '保存未完成') + '），请先处理后再迁移');
      }
      const response = await fetch('/api/canvases/' + encodeURIComponent(id) + '/migrate-classic', {method: 'POST'});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : '迁移失败');
      result.textContent = data.message;
      const open = document.createElement('a');
      open.href = data.url; open.textContent = '打开经典版画布'; open.className = 'studio-smart-retire-open';
      result.append(' ', open);
    } catch (error) {
      result.textContent = '迁移未完成：' + (error.message || '请稍后重试') + '。原画布没有改动。';
    } finally { button.disabled = false; }
  };
  for (const target of [bar, badge]) for (const type of ['pointerdown', 'mousedown', 'wheel', 'keydown']) target.addEventListener(type, event => event.stopPropagation());
  document.body.append(bar);
  // The page builds its header after this script runs and may rebuild it; keep the badge on the title
  // line ("深白片场 / 智能画布"), inline, so it adds no height. Without that line it sits top-left.
  const mount = () => {
    const eyebrow = document.querySelector('.sv2-header .sv2-eyebrow');
    if (eyebrow) { if (badge.previousElementSibling !== eyebrow) { badge.classList.remove('floating'); eyebrow.after(badge); } return true; }
    if (!badge.isConnected) { badge.classList.add('floating'); document.body.append(badge); }
    return false;
  };
  mount();
  new MutationObserver(mount).observe(document.body, {childList: true, subtree: true});
  addEventListener('resize', () => { if (bar.matches(':popover-open')) position(); });
})();
