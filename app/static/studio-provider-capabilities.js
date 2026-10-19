/* Capability descriptions are local facts, not a claim that paid generation was tested. */
(() => {
  'use strict';
  const host=document.getElementById('providerCapabilities');
  if(!host)return;
  let generation=0;
  const names={'adapted':'已有专用适配','no-adapted-model':'尚无已适配模型','protocol-compatible':'兼容协议，待验证','model-specific':'需要具体模型适配','not-adapted':'尚未适配'};
  async function refresh() {
    const run=++generation,id=document.getElementById('providerSelect').value;
    host.replaceChildren();
    const heading=document.createElement('h2');heading.textContent='此平台的调用范围';host.append(heading);
    try {
      const response=await fetch('/api/studio/settings/provider-capabilities');
      if(!response.ok)throw Error('能力说明暂时无法读取，连接设置仍可使用。');
      const data=await response.json();if(run!==generation)return;
      const item=data.providers.find(p=>p.provider_id===id);
      const note=document.createElement('p');note.className='muted';
      note.textContent=item?.notice||'保存平台后显示能力说明。同步模型只验证列表可读，不会执行生成。';
      host.append(note);if(!item)return;
      const table=document.createElement('table');table.className='provider-capability-table';
      const body=document.createElement('tbody');
      for(const entry of item.capabilities) {
        const tr=document.createElement('tr');
        for(const value of [entry.label,names[entry.status]||'待验证',entry.note]) {
          const td=document.createElement('td');td.textContent=value;tr.append(td);
        }
        body.append(tr);
      }
      table.append(body);host.append(table);
      const receipt=document.createElement('p');receipt.className='muted';
      receipt.textContent=item.connection_check?'最近列表检查：'+new Date(item.connection_check.checked_at).toLocaleString()+'，可读 '+item.connection_check.model_count+' 个模型；未验证付费生成。':'此地址尚无成功的模型列表检查记录。';
      host.append(receipt);
    } catch(error) {
      if(run!==generation)return;
      const p=document.createElement('p');p.textContent=error.message;host.append(p);
    }
  }
  window.addEventListener('studio-provider-selected',refresh);
  window.addEventListener('studio-provider-probed',refresh);
  refresh();
})();
