/* REF-02: under the smart composer, say which references are bound, which @ text is plain
   text, and which upstream inputs are still sent through connections. Every count comes from
   buildPromptRequest, the same function that assembles the request that is sent. */
(() => {
  'use strict';
  const input = document.getElementById('promptInput');
  if (!input || typeof buildPromptRequest !== 'function') return;
  const line = document.createElement('div');
  line.id = 'smartRefSemantics'; line.className = 'smart-ref-semantics';
  line.setAttribute('role', 'status'); line.setAttribute('aria-live', 'polite');
  line.title = '已绑定：从候选列表插入的素材标记，会随请求发送；纯文本 @：手写的 @文字，只作为文字发送，不绑定素材；'
    + '仍随连线发送：连线提供的输入素材，删除提示词里的标记不会移除它们，需断开连线或在输入缩略图上排除。';
  input.after(line);

  function describe() {
    const node = typeof activeComposerNode === 'function' ? activeComposerNode() : null;
    if (!node) return null;
    const parts = collectPromptParts();
    const blocked = blockedInputRefKeys(node);
    const bound = new Set(parts.filter(p => p.type === 'image' && p.url && !blocked.has(inputRefKey(p))).map(p => p.url));
    const plain = parts.filter(p => p.type === 'text').map(p => p.text).join('').match(/@[^\s@，,。；;：:、]+/g) || [];
    const request = buildPromptRequest(node, null, false);
    const sent = (request.refs || []).filter(r => r.url);
    const upstream = sent.filter(r => !bound.has(r.url));
    return {bound: sent.filter(r => bound.has(r.url)).length, plain: plain.length, upstream: upstream.length, sent: sent.length};
  }
  function update() {
    let info = null;
    try { info = describe(); } catch { info = null; }
    if (!info || !(info.bound || info.plain || info.upstream)) { line.hidden = true; line.textContent = ''; return; }
    const parts = [];
    if (info.bound) parts.push(`已绑定 ${info.bound} 个素材`);
    if (info.plain) parts.push(`纯文本 @ ${info.plain} 处（不绑定素材）`);
    if (info.upstream) parts.push(`仍随连线发送 ${info.upstream} 个上游素材`);
    line.hidden = false;
    line.textContent = '引用：' + parts.join(' · ') + `；本次共发送 ${info.sent} 个素材。`;
    line.dataset.bound = info.bound; line.dataset.plain = info.plain; line.dataset.upstream = info.upstream; line.dataset.sent = info.sent;
  }
  let timer = 0;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 80); };
  input.addEventListener('input', schedule);
  new MutationObserver(schedule).observe(input, {childList: true, subtree: true, characterData: true});
  const thumbs = document.getElementById('inputThumbsRow');
  if (thumbs) new MutationObserver(schedule).observe(thumbs, {childList: true, subtree: true});
  document.addEventListener('click', schedule, true);
  window.StudioRefSemantics = {update, describe};
  schedule();
})();
