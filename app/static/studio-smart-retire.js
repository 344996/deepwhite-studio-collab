/* U10: the smart canvas is retired. Old canvases still open and save; this bar explains that and
   offers a backed-up copy as a classic canvas (the original is never changed) or a JSON export. */
(() => {
  'use strict';
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;
  const bar = document.createElement('aside');
  bar.id = 'studioSmartRetire';
  bar.className = 'studio-smart-retire';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', '智能画布已停止新建');
  bar.innerHTML = '<p><strong>智能画布已停止新建。</strong>这个旧画布仍可查看和编辑；建议迁移到经典画布（先自动备份，原画布保留不变）。</p>'
    + '<div><button type="button" data-migrate class="primary">迁移到经典画布</button><button type="button" data-export>导出</button>'
    + '<button type="button" data-fold aria-label="收起提示">收起</button></div><p data-result role="status" aria-live="polite"></p>';
  const fold = folded => {
    bar.classList.toggle('folded', folded);
    bar.querySelector('[data-fold]').textContent = folded ? '旧版说明' : '收起';
    try { sessionStorage.setItem('studio.smartRetire.folded', folded ? '1' : ''); } catch {}
  };
  const result = bar.querySelector('[data-result]');
  bar.querySelector('[data-fold]').onclick = () => fold(!bar.classList.contains('folded'));
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
      if (typeof saveCanvas === 'function') await saveCanvas();
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
  for (const type of ['pointerdown', 'mousedown', 'wheel', 'keydown']) bar.addEventListener(type, event => event.stopPropagation());
  document.body.append(bar);
  let folded = false;
  try { folded = sessionStorage.getItem('studio.smartRetire.folded') === '1'; } catch {}
  fold(folded);
})();
