'use strict';
(() => {
  const $ = id => document.getElementById(id), form = $('feedbackForm');
  const labels = {new:'已收到',in_progress:'处理中',done:'已解决',closed:'已关闭'};
  let draftId = crypto.randomUUID(), image = '', previewURL = '', busy = false, imageProcessing = false, imageRequest = 0;
  function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  function notice(text,error=false){const node=$('feedbackNotice');node.hidden=false;node.textContent=text;node.dataset.error=String(error);}
  async function api(path,method='GET',body){const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(typeof d.detail==='string'?d.detail:'请求未完成，请重试。');return d;}
  function applyLock(){form.querySelectorAll('button,input,textarea,select').forEach(control=>control.disabled=busy||imageProcessing);}
  function lock(value){busy=value;applyLock();}
  function removeImage(){imageRequest++;imageProcessing=false;image='';$('feedbackScreenshot').value='';$('feedbackPreview').hidden=true;if(previewURL)URL.revokeObjectURL(previewURL);previewURL='';applyLock();}
  $('removeScreenshot').onclick=removeImage;
  $('feedbackScreenshot').onchange=async()=>{
    const file=$('feedbackScreenshot').files[0];if(!file)return removeImage();
    const request=++imageRequest;imageProcessing=true;applyLock();
    try{
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024)throw Error('请选择 8 MB 以内的 JPG、PNG 或 WebP 截图。');
      const bitmap=await createImageBitmap(file);
      if(bitmap.width*bitmap.height>6_000_000){bitmap.close();throw Error('请将截图缩小到 600 万像素以内。');}
      const scale=Math.min(1,1600/bitmap.width,1200/bitmap.height),canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.75));if(!blob||blob.size>300000)throw Error('截图压缩后仍较大，请裁剪后重试。');
      const encoded=(await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);})).split(',')[1];
      if(request!==imageRequest)return;image=encoded;
      if(previewURL)URL.revokeObjectURL(previewURL);previewURL=URL.createObjectURL(blob);$('feedbackPreview').querySelector('img').src=previewURL;$('feedbackPreview').hidden=false;
    }catch(e){if(request===imageRequest){removeImage();notice(e.message||'截图读取失败。',true);}}
    finally{if(request===imageRequest){imageProcessing=false;applyLock();}}
  };
  function render(rows){
    $('feedbackEmpty').hidden=rows.length>0;$('feedbackRecords').replaceChildren();
    for(const row of rows){
      const card=el('article',undefined,'feedback-record');
      card.append(el('span',row.sent?(labels[row.remote?.status]||'已发送'):'本机待发送','badge'),el('h3',row.title),
        el('div',new Date(row.created*1000).toLocaleString()+' · '+row.id.slice(0,8),'record-meta'),el('p',row.description),el('p',row.message));
      if(row.remote?.reply)card.append(el('blockquote',row.remote.reply));
      const action=el('button',row.sent?'查询处理结果':'发送反馈');action.type='button';action.onclick=async()=>{
        action.disabled=true;
        try{const result=await api('/api/studio/feedback/'+row.id+(row.sent?'/refresh':'/send'),'POST');notice(result.message);follow(result);await load();}
        catch(e){notice(e.message,true);}finally{action.disabled=false;}
      };card.append(action);$('feedbackRecords').append(card);
    }
  }
  function follow(row){if(row?.issue_url&&row.channel==='github'){const link=el('a','打开 GitHub 提交页面');link.href=row.issue_url;link.target='_blank';link.rel='noopener';const box=$('feedbackNotice');box.append(' ',link);window.open(row.issue_url,'_blank','noopener');}}
  async function channels(){try{const c=await api('/api/studio/feedback/channels');$('feedbackChannel').textContent='当前发送方式：'+(c.gallery?'画廊反馈后台':c.webhooks.length?'开发者群机器人（'+c.webhooks.join('、')+'）':'GitHub Issue（'+c.github_repository+'，需你在浏览器确认提交）');}catch{$('feedbackChannel').textContent='';}}
  async function load(){const data=await api('/api/studio/feedback');if(document.activeElement!==$('feedbackURL'))$('feedbackURL').value=data.url||'';render(data.items);}
  $('reloadFeedback').onclick=()=>load().catch(e=>notice(e.message,true));
  $('feedbackDestination').onsubmit=async event=>{event.preventDefault();try{await api('/api/studio/gallery','PUT',{url:$('feedbackURL').value.trim()});notice('反馈接收地址已保存。');}catch(e){notice(e.message,true);}};
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||imageProcessing)return;lock(true);
    try{
      const data={id:draftId,category:form.elements.category.value,title:form.elements.title.value,description:form.elements.description.value,contact:form.elements.contact.value,screenshot:image,include_diagnostics:form.elements.include_diagnostics.checked};
      let row=await api('/api/studio/feedback','POST',data);
      if(event.submitter?.value==='send')row=await api('/api/studio/feedback/'+row.id+'/send','POST');
      notice(row.message);follow(row);form.reset();removeImage();draftId=crypto.randomUUID();sessionStorage.removeItem('studio-feedback-draft');await load();
    }catch(e){notice(e.message,true);}finally{lock(false);}
  };
  form.addEventListener('input',()=>{try{sessionStorage.setItem('studio-feedback-draft',JSON.stringify({title:form.elements.title.value,description:form.elements.description.value,contact:form.elements.contact.value,category:form.elements.category.value}));}catch{}});
  try{const draft=JSON.parse(sessionStorage.getItem('studio-feedback-draft')||'{}');for(const key of ['title','description','contact','category'])if(typeof draft[key]==='string')form.elements[key].value=draft[key];}catch{}
  channels();
  load().catch(e=>notice(e.message,true));
})();
