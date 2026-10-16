/* Reviewed plan application, isolated from image/video execution. */
(() => {
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  window.studioFlushAgentCanvas=async()=>{
    if(typeof canvas==='undefined'||!canvas)throw Error('请先打开画布。');
    if(nodes.some(n=>n.running))throw Error('请等待画布中的生成任务完成后再修改节点。');
    clearTimeout(saveTimer);saveTimer=null;
    let tries=0;
    while(savingCanvasNow&&tries++<200)await delay(50);
    if(savingCanvasNow)throw Error('画布仍在保存，请稍后重试。');
    if(localCanvasDirty||saveCanvasAgain)await saveCanvas();
    tries=0;
    while((savingCanvasNow||saveCanvasAgain)&&tries++<200)await delay(50);
    if(localCanvasDirty||savingCanvasNow||saveCanvasAgain)throw Error('画布尚未保存成功，请检查连接。');
    return canvas;
  };
  window.studioApplyAgentPlan=async(sessionId,planId)=>{
    const blocker=document.createElement('div');
    blocker.style.cssText='position:fixed;inset:0;z-index:200000;background:#0008;display:grid;place-items:center;color:white;font-size:16px';
    blocker.textContent='正在校验并写入画布…';
    const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
    document.body.append(blocker);document.addEventListener('keydown',stop,true);
    try{
      await window.studioFlushAgentCanvas();
      const result=await fetch('/api/studio/agent/sessions/'+encodeURIComponent(sessionId)+'/apply',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan_id:planId})});
      const data=await result.json();
      if(!result.ok)throw Error(typeof data.detail==='string'?data.detail:'方案写入失败，请重新检查。');
      if(!data.already_applied)pushUndo();
      const localViewport={...viewport};
      canvas={...data.canvas,viewport:localViewport};nodes=canvas.nodes||[];connections=canvas.connections||[];
      lastCanvasUpdatedAt=Number(canvas.updated_at);localCanvasDirty=false;saveCanvasAgain=false;
      selected=new Set(data.node_ids||[]);render();
      window.studioSkillNodesRefresh?.();
      const first=nodes.find(n=>n.id===data.node_ids?.[0]);
      if(first&&typeof centerViewportOnWorldPoint==='function'){
        const panel=document.getElementById('studioAgentPanel');
        const side=panel&&!panel.hidden?panel.getBoundingClientRect().width:0;
        centerViewportOnWorldPoint({x:first.x+(first.w||660)/2+side/(2*viewport.scale),y:first.y+(first.h||520)/2});
        if(typeof scheduleViewportSave==='function')scheduleViewportSave();
      }
      setStatus('助手方案已写入，尚未开始生成');
      return data;
    }finally{blocker.remove();document.removeEventListener('keydown',stop,true);}
  };
})();
