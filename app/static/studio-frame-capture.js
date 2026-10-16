/* Capture only the decoded local player frame; the upload route saves to this installation. */
(() => {
  const style=document.createElement('link');style.rel='stylesheet';style.href='/static/studio-frame-capture.css';document.head.append(style);
  async function capture(video,button){
    if(button.disabled)return;
    const sourceId=video.id==='outputLightboxVideo'?currentOutputLightboxOutId:video.closest('.node[data-id]')?.dataset.id;
    const source=nodes.find(n=>n.id===sourceId),canvasId=canvas?.id;
    const url=video.id==='outputLightboxVideo'?currentOutputLightboxUrl:(video.currentSrc||video.src);
    if(!source){setStatus('请从画布视频打开播放器后截帧。');return;}
    button.disabled=true;button.textContent='正在保存当前帧…';
    try{
      video.pause();
      if(video.seeking||video.readyState<2||!video.videoWidth||!video.videoHeight)throw Error('画面尚未就绪，请等待定位完成后再截帧。');
      const time=video.currentTime,surface=document.createElement('canvas');surface.width=video.videoWidth;surface.height=video.videoHeight;
      surface.getContext('2d').drawImage(video,0,0);
      const blob=await new Promise((resolve,reject)=>surface.toBlob(b=>b?resolve(b):reject(Error('当前帧编码失败。')),'image/png'));
      const form=new FormData();form.append('files',blob,`frame-${time.toFixed(3)}s.png`);
      const response=await fetch('/api/ai/upload',{method:'POST',body:form}),data=await response.json();
      if(!response.ok||!data.files?.[0]?.url)throw Error('当前帧保存失败，请重试。');
      if(canvas?.id!==canvasId||!nodes.includes(source))throw Error('画布或源节点已变化，图片已保存在本机但未添加到当前画布。');
      pushUndo();const rect=estimatedNodeRect(source),file=data.files[0];
      addNode({id:uid('frame'),type:'image',x:rect.x+rect.w+50,y:rect.y,url:file.url,name:`视频帧 ${time.toFixed(3)}秒`,kind:'image',
        studioProcessing:{type:'video-frame',sourceNode:source.id,sourceUrl:url,sourceTime:time,width:surface.width,height:surface.height}});
      render();scheduleSave();setStatus(`已保存 ${surface.width} × ${surface.height} 当前帧`);
    }catch(error){setStatus(error.name==='SecurityError'?'此视频不允许读取画面，请先下载并导入本地视频。':error.message);}
    finally{button.disabled=false;button.textContent='截取当前帧';}
  }
  function attach(video){
    if(video.dataset.studioFrameCapture)return;video.dataset.studioFrameCapture='true';
    const button=document.createElement('button');button.type='button';button.className='studio-capture-frame';button.textContent='截取当前帧';
    button.setAttribute('aria-label','截取当前帧');
    for(const type of ['mousedown','pointerdown','dblclick'])button.addEventListener(type,e=>e.stopPropagation());
    button.onclick=e=>{e.preventDefault();e.stopPropagation();capture(video,button);};video.after(button);
    if(video.id==='outputLightboxVideo'){
      const sync=()=>{button.hidden=video.style.display==='none'||!outputLightbox.classList.contains('open');};
      new MutationObserver(sync).observe(video,{attributes:true,attributeFilter:['style','src']});sync();
    }
  }
  const scan=()=>{document.querySelectorAll('#nodes video,#outputLightboxVideo').forEach(attach);};
  new MutationObserver(scan).observe(document.getElementById('nodes'),{childList:true,subtree:true});scan();
})();
