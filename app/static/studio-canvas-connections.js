/* Feedback follows native validation and never starts a generation. */
(() => {
  'use strict';
  function initialize() {
    if (!window.StudioCanvasWorkspace || window.StudioConnectionFeedback) return;
    const smart = document.documentElement.classList.contains('studio-v2-smart');
    const hint = document.createElement('output'); hint.className = 'workspace-connection-hint'; hint.id = 'workspaceConnectionHint';
    hint.setAttribute('role', 'status'); hint.setAttribute('aria-live', 'polite'); hint.hidden = true; document.body.append(hint);
    const show = (message, state = 'active') => { hint.hidden = !message; if (hint.textContent !== message) hint.textContent = message; if (hint.dataset.state !== state) hint.dataset.state = state; };
    const blocked = hit => hit?.closest('dialog,.workspace-inspector,.workspace-canvas-tools,.workspace-viewport,#workspaceCanvasRail,.workspace-more-panel,.composer,.asset-panel,.workflow-transfer-panel');
    if (!smart) {
      const nativeTarget = linkDropTarget;
      linkDropTarget = function(x, y, kind, originId, originKind) {
        const hit = nativeTarget.apply(this, arguments);
        if (blocked(document.elementFromPoint(x, y))) show('请在画布节点的端口上释放', 'invalid');
        else if (hit && !hit.valid) show(hit.card.dataset.id === originId ? '节点不能连接自身 · Esc 取消' : '节点类型或连线方向不兼容 · Esc 取消', 'invalid');
        else show(hit?.valid ? '释放以连接 · Esc 取消' : '拖到输入端口，或空白处添加节点 · Esc 取消', hit?.valid ? 'valid' : 'active');
        return hit;
      };
      const nativeStart = startLink;
      startLink = function(...args) { const result = nativeStart.apply(this, args); show('拖到另一节点的对应端口 · Esc 取消'); return result; };
      const nativeLinks = renderLinks;
      renderLinks = function(...args) { const result = nativeLinks.apply(this, args); if (!tempLink) show(''); return result; };
    } else {
      function targetFor(event, drag) {
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        if (blocked(hit)) return {blocked:true,reason:'请在画布节点的端口上释放'};
        const port = hit?.closest('.node-port'), card = hit?.closest('.image-node'), wanted = drag.fromPort === 'out' ? 'in' : 'out';
        if (card) {
          if (card.dataset.id === drag.fromId) return {invalid:true,reason:'节点不能连接自身 · Esc 取消'};
          const rect = card.getBoundingClientRect(), side = port?.dataset.port || (event.clientX < rect.left + rect.width / 2 ? 'in' : 'out');
          if (side !== wanted) return {invalid:true,reason:'请连接输出与输入端口 · Esc 取消'};
          const target = card.querySelector(`[data-port="${wanted}"]`); if (target) { const box = target.getBoundingClientRect(); return {x:box.left+box.width/2,y:box.top+box.height/2}; }
        }
        // A wire gesture caches screen geometry; viewport changes invalidate it.
        const key = `${viewport.x}:${viewport.y}:${viewport.scale}`;
        if (drag.workspacePortKey !== key) {
          drag.workspacePortKey = key;
          drag.workspacePorts = [...world.querySelectorAll(`.node-port[data-port="${wanted}"]`)].filter(item => item.closest('.image-node')?.dataset.id !== drag.fromId).map(item => {
            const rect = item.getBoundingClientRect(); return {element:item,x:rect.left+rect.width/2,y:rect.top+rect.height/2};
          });
        }
        let nearest, distance = 28;
        for (const item of drag.workspacePorts || []) { const delta = Math.hypot(item.x-event.clientX,item.y-event.clientY); if (item.element.isConnected && delta < distance) { nearest = item; distance = delta; } }
        return nearest || {};
      }
      const adapted = (event, target) => target.x === undefined ? event : {clientX:target.x,clientY:target.y,preventDefault:()=>event.preventDefault(),stopPropagation:()=>event.stopPropagation()};
      const nativeMove = window.onmousemove;
      window.onmousemove = function(event) {
        if (!portDragState) return nativeMove.call(this, event);
        const target = targetFor(event, portDragState), result = nativeMove.call(this, adapted(event, target));
        show(target.reason || (target.x === undefined ? '拖到对应端口，或空白处添加节点 · Esc 取消' : '释放以连接 · Esc 取消'), target.reason ? 'invalid' : target.x === undefined ? 'active' : 'valid'); return result;
      };
      const nativeDrop = handlePortDrop;
      handlePortDrop = function(drag, event) { const target = targetFor(event, drag); show(''); if (target.invalid || target.blocked) { discardPendingUndo(); render(); return; } return nativeDrop.call(this, drag, adapted(event, target)); };
      const nativeVisual = updatePortDragVisual;
      updatePortDragVisual = function(...args) { const result = nativeVisual.apply(this,args); if (portDragState && hint.hidden) show('拖到另一节点的对应端口 · Esc 取消'); return result; };
      const nativeClear = clearPortDragVisual;
      clearPortDragVisual = function(...args) { show(''); return nativeClear.apply(this,args); };
    }
    // Stop window-level canvas shortcuts at both current and lazy dialog boundaries.
    const isolated = new WeakSet(), isolate = dialog => { if (isolated.has(dialog)) return; isolated.add(dialog); StudioCanvasWorkspace.isolate(dialog); };
    document.querySelectorAll('dialog').forEach(isolate);
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) { if (node.matches('dialog')) isolate(node); node.querySelectorAll('dialog').forEach(isolate); } }).observe(document.body,{childList:true});
    window.StudioConnectionFeedback = Object.freeze({ready:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once:true}); else initialize();
})();
