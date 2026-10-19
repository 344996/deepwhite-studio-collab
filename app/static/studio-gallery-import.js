'use strict';
(() => {
  const $=id=>document.getElementById(id), storageKey='deepwhite.gallery.import.v1';
  let payload=null, operation='', submitted=null, busy=false, fileSequence=0;
  function error(message){$('importError').hidden=!message;$('importError').textContent=message;}
  function remember(){try{sessionStorage.setItem(storageKey,JSON.stringify({payload,operation,submitted}));}catch{}}
  function validate(value){
    const keys=['schema','title','prompt','kind','source_url'];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>typeof value[k]!=='string')||value.schema!=='deepwhite.prompt.v1'||!['image','video','prompt'].includes(value.kind)||Array.from(value.title).length>120||!value.prompt.trim()||Array.from(value.prompt).length>8000||value.source_url.length>1024)throw new Error('不是有效的深白提示词文件。');
    const source=new URL(value.source_url);
    if(!['http:','https:'].includes(source.protocol)||!source.hostname||source.username||source.password||source.search||source.hash||/\s|\\/.test(value.source_url))throw new Error('提示词文件中的来源链接无效。');
    return value;
  }
  function accept(value,resume=null){
    payload=validate(value);operation=resume?.operation||crypto.randomUUID().replaceAll('-','');submitted=resume?.submitted||null;
    $('importTitle').value=submitted?.payload.title||payload.title.slice(0,80)||'画廊灵感';
    $('importPrompt').value=submitted?.payload.prompt||payload.prompt;
    if(submitted)$('importProject').value=submitted.project_id;
    $('sourceLink').href=payload.source_url;$('sourceKind').textContent={image:'图片创作提示词',video:'视频创作提示词',prompt:'创作者分享的提示词'}[payload.kind];
    $('importForm').hidden=false;$('openImported').hidden=true;$('importSubmit').disabled=false;
    $('importStatus').textContent='提示词已准备好。确认内容后创建画布。';error('');remember();
  }
  async function read(response){const data=await response.json();if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'导入失败，请检查文件后重试。');return data;}
  $('promptFile').onchange=async()=>{
    const sequence=++fileSequence, file=$('promptFile').files[0];if(!file||busy)return;
    payload=null;submitted=null;$('importForm').hidden=true;try{sessionStorage.removeItem(storageKey);}catch{}
    try{if(file.size>65536)throw new Error('提示词文件超过 64 KB。');const value=JSON.parse(await file.text());if(sequence===fileSequence)accept(value);}
    catch(e){if(sequence===fileSequence)error(e.message);}
  };
  $('importForm').onsubmit=async event=>{
    event.preventDefault();if(busy||!payload)return;error('');
    const current={...payload,title:$('importTitle').value,prompt:$('importPrompt').value};
    if(submitted&&(JSON.stringify(current)!==JSON.stringify(submitted.payload)||$('importProject').value!==submitted.project_id)){
      error('上次提交的结果尚未确认。请恢复原内容重试，或先核对工作台后重新选择文件导入。');return;
    }
    try{validate(current);}catch(e){error(e.message);return;}
    submitted ||= {operation_id:operation,project_id:$('importProject').value,payload:current};remember();
    busy=true;for(const el of document.querySelectorAll('input,textarea,select,button'))el.disabled=true;
    $('importStatus').textContent='正在保存到本地画布…';
    try{
      const result=await read(await fetch('/api/studio/gallery/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(submitted)}));
      try{sessionStorage.removeItem(storageKey);}catch{}
      $('openImported').href=result.url;$('openImported').hidden=false;$('importStatus').textContent='画布已保存，正在打开…';
      location.assign(result.url);
    }catch(e){error(e.message);$('importStatus').textContent='提示词仍保留在此页，可以重试；也可先在工作台核对结果。';}
    finally{busy=false;for(const el of document.querySelectorAll('input,textarea,select,button'))el.disabled=false;}
  };
  (async()=>{
    const hash=location.hash;history.replaceState(null,'',location.pathname);
    try{
      const projects=await read(await fetch('/api/projects'));
      $('importProject').replaceChildren(...projects.projects.map(project=>{const el=document.createElement('option');el.value=project.id;el.textContent=project.name;return el;}));
      if(hash){
        if(!/^#payload=[A-Za-z0-9_-]+$/.test(hash)||hash.length>90000)throw new Error('提示词链接无效，请改用文件导入。');
        const encoded=hash.slice(9).replace(/-/g,'+').replace(/_/g,'/');
        const raw=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));if(raw.length>65536)throw new Error('提示词文件超过 64 KB。');
        accept(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
      }else{
        let cached='';try{cached=sessionStorage.getItem(storageKey)||'';}catch{}
        if(cached&&cached.length<=131072){const previous=JSON.parse(cached);accept(previous.payload,previous);}
      }
    }catch(e){error(e.message);}
  })();
})();
