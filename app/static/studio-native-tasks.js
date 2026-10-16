/* Native LLM/video requests: one durable submission, explicitly bound output. */
(() => {
    'use strict';
    const copy = value => JSON.parse(JSON.stringify(value));
    const smart = () => typeof LEGACY_SMART_CANVAS !== 'undefined' && LEGACY_SMART_CANVAS;
    const active = new Map();
    let capabilities = null;
    const isNative = a => a?.native === true && ['llm','video'].includes(a.kind);
    function safeDetail(value){
        const text=typeof value==='string'?value:JSON.stringify(value);
        return String(text||'任务提交响应异常。').replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi,'[链接已隐藏]')
            .replace(/((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)["']?\s*[=:]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s,;"']+/gi,'$1[已隐藏]')
            .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,'$1 [已隐藏]').slice(0,1100);
    }
    function scope(ctx){
        return Boolean(ctx && !ctx.missingOutput && canvas === ctx.origin && String(canvas?.id) === ctx.attempt.canvasId
            && nodes.find(n => n.id === ctx.node.id) === ctx.node
            && nodes.find(n => n.id === ctx.out.id) === ctx.out
            && ctx.node.studioLegacyAttempts?.[ctx.attempt.id] === ctx.attempt);
    }
    function pending(ctx){
        return smart() ? (ctx.out.pendingTasks || []).find(p => p.requestId === ctx.attempt.id)
            : (ctx.out._pending || []).find(p => p.requestId === ctx.attempt.id && p.id === ctx.attempt.pendingId);
    }
    function owned(ctx){ return scope(ctx) && (ctx.attempt.kind === 'llm' || ctx.attempt.applied || Boolean(pending(ctx))); }
    function held(ctx,message){ const e=Error(message);e.legacyTaskHeld=true;e.legacyContext=ctx;return e; }
    function check(ctx){ if(!owned(ctx)) throw held(ctx,'原画布、节点或输出槽已改变；结果保留在原任务中。'); }
    function reason(a){
        if(a.error) return a.error;
        if(a.status === 'uncertain') return '提交结果待核实；只查询原请求，不会重新提交。';
        if(a.recovery_action === 'archive_result') return '远端结果已保留，可重试保存结果；不会重新生成。';
        if(a.recovery_action === 'query_upstream') return '远端回执已保留，可继续查询原任务。';
        if(a.status === 'paused') return '任务已暂停；原请求已保留，不会自动重新提交。';
        return '原任务记录已保留。';
    }
    async function ensureCapability(kind){
        if(capabilities?.kinds?.includes(kind)) return;
        let r;
        try { r=await fetch('/api/canvas-native-tasks/capabilities'); }
        catch { throw Error('无法检测任务保护能力，任务未提交；请恢复网络后重试。'); }
        if(!r.ok) throw Error(r.status===404 ? '需要重启应用载入更新，任务未提交。' : '无法检测任务保护能力，任务未提交。');
        let value;try { value=await r.json(); } catch { throw Error('任务保护能力响应无效，任务未提交。'); }
        if(value.version!==1 || !value.kinds?.includes(kind)) throw Error('需要重启应用载入更新，任务未提交。');
        capabilities=value;
    }
    function refresh(ctx){
        if(!scope(ctx)) return;
        if(smart()) render(); else refreshRunNodes(ctx.node,ctx.out);
        scheduleSave();decorate();
    }
    function state(ctx,data){
        check(ctx);const a=ctx.attempt;
        if(data.task_id) a.taskId=data.task_id;
        for(const key of ['status','error','recovery_status','recovery_action','remote_status','media_status','processing','upstream_task_id'])
            if(data[key]!==undefined) a[key]=copy(data[key]);
        if(data.result!=null) a.result=copy(data.result);
        a.updatedAt=Date.now();const p=pending(ctx);
        if(p){p.taskId=a.taskId||a.id;p.canvasTaskId=a.taskId||a.id;p.legacyStatus=a.status;p.canvasTaskStatus=a.status;p.error=reason(a);p.failed=false;}
        if(['paused','uncertain','failed'].includes(a.status) && latest(ctx)){
            ctx.node.running=false;ctx.out.running=false;ctx.node.runStatus=a.status;ctx.node.runError=reason(a);
        }
        scheduleSave();decorate();
    }
    function accept(ctx,data){
        check(ctx);const a=ctx.attempt,r=a.snapshot.request;
        if(!data || !data.task_id || data.request_id!==a.id || String(data.canvas_id)!==a.canvasId
            || data.node_id!==a.nodeId || data.output_node_id!==r.output_node_id || data.output_slot_id!==r.output_slot_id
            || a.taskId && data.task_id!==a.taskId){
            state(ctx,{status:'uncertain',error:'原任务回执归属不匹配，结果需核实；不会重新提交。',processing:false,recovery_action:null});
            throw held(ctx,reason(a));
        }
        delete a.submitError;state(ctx,data);return data;
    }
    async function prepare(kind,payload,options){
        // Check routes before creating any attempt or output binding on an old server.
        const origin=options.origin||canvas,node=options.node,out=options.out||node;
        payload=copy(payload);const frozenMeta=copy(options.meta||{}),frozenRun=copy(options.run||{});
        await ensureCapability(kind);
        if(canvas!==origin || !node || nodes.find(n=>n.id===node.id)!==node || nodes.find(n=>n.id===out.id)!==out)
            throw held(null,'原画布或节点已改变，任务未提交。');
        const id=crypto.randomUUID(),slot=options.pendingId||crypto.randomUUID();
        const request=copy({...payload,request_id:id,canvas_id:String(origin.id),node_id:node.id,output_node_id:out.id,output_slot_id:slot});
        const a={id,native:true,kind,canvasId:String(origin.id),nodeId:node.id,outputId:out.id,pendingId:slot,
            status:'prepared',taskId:'',createdAt:Date.now(),retryable:false,
            snapshot:{request,run:frozenRun,meta:frozenMeta}};
        if(a.snapshot.run.node) clearCopiedLegacyTaskState(a.snapshot.run.node);
        node.studioLegacyAttempts=node.studioLegacyAttempts||{};node.studioLegacyAttempts[id]=a;
        const ctx={attempt:a,node,out,origin};
        if(kind==='video'){
            if(smart()){
                out.pendingTasks=out.pendingTasks||[];
                out.pendingTasks.push({taskId:id,requestId:id,attemptOwnerId:node.id,taskType:'video',kind:'video',model:request.model,providerId:request.provider_id});
                out.pending=Math.max(out.pendingTasks.length,Number(out.pending)||0);
            } else {
                let p=(out._pending||[]).find(p=>p.id===slot);
                if(!p){p=makePendingForRun(slot,copy(options.run||{}),node,options);out._pending=[...(out._pending||[]),p];}
                Object.assign(p,{requestId:id,attemptOwnerId:node.id,canvasTaskType:'video',canvasTaskId:id,legacyStatus:'prepared',providerId:request.provider_id});
            }
        }
        scheduleSave();decorate();return ctx;
    }
    async function read(ctx){
        check(ctx);const a=ctx.attempt;
        const url='/api/canvas-'+a.kind+'-tasks/'+(a.taskId?encodeURIComponent(a.taskId):'by-request/'+encodeURIComponent(a.id));
        try {
            const r=await fetch(url);check(ctx);
            if(!r.ok) throw Error(r.status===404?'未找到原请求记录；提交结果需核实。':'无法读取原任务记录。');
            return accept(ctx,await r.json());
        } catch(e){
            if(!scope(ctx)||e.legacyTaskHeld) throw e;
            const message=e.message||'查询中断，原任务编号已保留。';
            state(ctx,{status:'uncertain',error:(a.submitError?a.submitError+'\n':'')+message,processing:false,recovery_action:null});
            throw held(ctx,reason(a));
        }
    }
    async function submit(ctx){
        check(ctx);const a=ctx.attempt;
        if(a.status!=='prepared') return read(ctx);
        try {
            if(!window.StudioSave?.ensureCurrent) throw Error('保存保护尚未就绪，任务未提交。');
            await window.StudioSave.ensureCurrent({canvasId:a.canvasId,nodeId:a.nodeId,jobId:a.id,request:a.snapshot.request,
                requestField:['studioLegacyAttempts',a.id,'id'],snapshotField:['studioLegacyAttempts',a.id,'snapshot']});
            check(ctx);
        } catch(e){
            if(scope(ctx)) state(ctx,{status:'paused',error:e.message||'保存未确认，任务未提交。',recovery_action:null,processing:false});
            throw held(ctx,e.message||'保存未确认，任务未提交。');
        }
        if(a.status!=='prepared') return read(ctx);
        a.status='dispatching';a.dispatchStartedAt=Date.now();scheduleSave();
        try {
            const r=await fetch('/api/canvas-'+a.kind+'-tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(a.snapshot.request)});
            check(ctx);
            if(!r.ok){
                const raw=await r.text();let detail=raw;try{detail=JSON.parse(raw).detail||raw;}catch{}
                a.submitError='提交响应（HTTP '+r.status+'）：'+safeDetail(detail);
                throw Error(a.submitError);
            }
            return accept(ctx,await r.json());
        } catch(e){
            check(ctx);
            // Even a lost receipt or malformed response is recovered by UUID, never another POST.
            if(e.legacyTaskHeld) throw e;
            return read(ctx);
        }
    }
    async function wait(ctx,initial){
        let data=initial;
        for(;;){
            if(!data) data=await read(ctx);check(ctx);
            if(data.status==='succeeded') return data.result||{};
            if(data.status==='jimeng_pending' && data.result?.jimeng_pending) return data.result;
            if(data.status==='failed') throw held(ctx,data.error||'原任务执行失败，记录已保留。');
            if(['paused','uncertain'].includes(data.status) || data.status==='archiving'&&!data.processing) throw held(ctx,reason(ctx.attempt));
            if(!['queued','running','archiving'].includes(data.status)){
                state(ctx,{status:'uncertain',error:'原任务状态需核实；不会重新提交。',processing:false,recovery_action:null});throw held(ctx,reason(ctx.attempt));
            }
            await new Promise(resolve=>setTimeout(resolve,1200));data=null;
        }
    }
    async function run(kind,payload,options){
        const ctx=await prepare(kind,payload,options);options.nativeContext=ctx;
        const result=await wait(ctx,await submit(ctx));return {result,ctx};
    }
    function latest(ctx){
        return Object.values(ctx.node.studioLegacyAttempts||{}).filter(a=>isNative(a)&&a.kind===ctx.attempt.kind&&a.outputId===ctx.out.id).at(-1)===ctx.attempt;
    }
    function textCanApply(ctx){
        if(!scope(ctx)||!latest(ctx)) return false;
        const m=ctx.attempt.snapshot.meta;
        if(m.mode==='smart-text') return ctx.node.llmEnabled===true && String(ctx.node.text||'')===m.textBaseline;
        if(m.mode==='classic-chat') return JSON.stringify(ctx.node.messages||[])===m.messagesBaseline;
        return String(ctx.node.outputText||'')===m.textBaseline;
    }
    function applyText(ctx,explicit=false){
        check(ctx);const a=ctx.attempt,m=a.snapshot.meta,text=String(a.result?.text||'');
        if(a.applied || !a.result) return false;
        if(!explicit&&!textCanApply(ctx)){a.resultHeld=true;scheduleSave();decorate();return false;}
        if(explicit) pushUndo();
        if(m.mode==='smart-text') ctx.node.text=text.trim();
        else if(m.mode==='classic-chat'){
            if(!textCanApply(ctx)){a.resultHeld=true;decorate();return false;}
            ctx.node.messages.push({role:'assistant',content:text});ctx.node.outputText=text;
        }else ctx.node.outputText=text;
        a.applied=true;a.resultHeld=false;if(latest(ctx)){ctx.node.running=false;ctx.node.runStatus='done';ctx.node.runError='';}refresh(ctx);return true;
    }
    function markApplied(ctx){check(ctx);ctx.attempt.applied=true;ctx.attempt.error='';scheduleSave();decorate();}
    function detachPending(ctx){
        if(smart()){ctx.out.pendingTasks=(ctx.out.pendingTasks||[]).filter(p=>p.requestId!==ctx.attempt.id);ctx.out.pending=ctx.out.pendingTasks.length;}
        else ctx.out._pending=(ctx.out._pending||[]).filter(p=>p.requestId!==ctx.attempt.id);
    }
    function applyVideo(ctx){
        check(ctx);const a=ctx.attempt;if(a.applied)return;
        if(!latest(ctx) && a.snapshot.meta.replace){a.resultHeld=true;decorate();return;}
        const result=a.result||{},items=resultMediaUrls(result).map(item=>typeof item==='string'?{url:item,kind:'video'}:{...item,kind:item.kind||'video'});
        if(result.jimeng_pending){if(smart())setNodeJimengPending(ctx.out,{submitId:result.submit_id,kind:result.kind||'video',queueInfo:result.queue_info,message:result.message});markApplied(ctx);detachPending(ctx);refresh(ctx);return;}
        if(!items.length)throw held(ctx,'任务返回没有可用视频，原结果已保留。');
        if(smart()){
            if(a.snapshot.meta.replace) replaceOutputsToNodeWithHistory(ctx.out,items,'video',a.snapshot.meta.runMeta||null,{skipShift:true});
            else finalizeSmartPendingTask(ctx.out,pending(ctx)?.taskId||a.taskId,items,'video');
            if(a.snapshot.meta.runMeta)attachRunMeta(ctx.out,a.snapshot.meta.runMeta);
        }else {
            const meta=collectRunMeta(ctx.out,a.pendingId);
            appendOutputImages(ctx.out,items,a.snapshot.request.images?.[0],[{...meta,kind:'video'}]);
            mergeGeneratedOutputs(ctx.node,items,Boolean(a.snapshot.meta.cascade));
        }
        // Keep the result and identity even after its output slot is consumed.
        a.applied=true;detachPending(ctx);if(latest(ctx)){ctx.node.running=false;ctx.out.running=false;ctx.node.runStatus='done';ctx.node.runError='';}refresh(ctx);
    }
    async function query(ctx,resume=false){
        if(!owned(ctx)){const message='原输出槽已删除或节点已改变；原结果仍可查看，未创建新的输出槽。';if(smart())toast(message);else setStatus(message);return;}
        check(ctx);const key=ctx.attempt.id;if(active.has(key))return;active.set(key,ctx);
        const originalPending=pending(ctx);if(originalPending)originalPending.querying=true;refresh(ctx);
        try {
            let data=await read(ctx);
            if(resume && ctx.attempt.taskId && ['query_upstream','archive_result'].includes(data.recovery_action)){
                const r=await fetch('/api/canvas-video-tasks/'+encodeURIComponent(ctx.attempt.taskId)+'/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
                check(ctx);if(!r.ok)throw held(ctx,'原任务恢复未确认；可再次查询，未重新生成。');data=accept(ctx,await r.json());
            }
            await wait(ctx,data);check(ctx);
            if(ctx.attempt.kind==='llm')applyText(ctx);else applyVideo(ctx);
        } catch(e){if(scope(ctx)){if(latest(ctx)){ctx.node.running=false;ctx.out.running=false;}refresh(ctx);if(smart())toast(e.message);else setStatus(e.message);}}
        finally{active.delete(key);if(scope(ctx)){const p=pending(ctx);if(p)p.querying=false;refresh(ctx);}}
    }
    function html(node){
        const all=Object.values(node.studioLegacyAttempts||{}).filter(isNative),entries=all.slice(-6);
        if(!entries.length)return '';
        const esc=escapeHtml;
        const row=a=>`<div class="studio-native-task" data-native-attempt="${esc(a.id)}"><span>${a.kind==='llm'?'文字任务':'视频任务'} · ${esc(({succeeded:'已完成',failed:'失败',paused:'已暂停',uncertain:'待核实',prepared:'未提交',dispatching:'提交中',queued:'排队中',running:'运行中',archiving:'保存结果中',jimeng_pending:'即梦队列'})[a.status]||a.status)}</span>${a.error?`<p>${esc(a.error)}</p>`:''}<div class="studio-native-task-actions"><button type="button" data-native-action="query" data-native-id="${esc(a.id)}" ${active.has(a.id)?'disabled':''}>${active.has(a.id)?'查询中…':'查询任务'}</button>${a.kind==='video'&&['query_upstream','archive_result'].includes(a.recovery_action)?`<button type="button" data-native-action="resume" data-native-id="${esc(a.id)}" ${active.has(a.id)?'disabled':''}>${active.has(a.id)?(a.recovery_action==='archive_result'?'保存中…':'查询中…'):(a.recovery_action==='archive_result'?'重试保存结果':'继续查询')}</button>`:''}${a.result?`<button type="button" data-native-action="view" data-native-id="${esc(a.id)}">生成结果</button>`:''}</div></div>`;
        return `<div class="studio-native-task-list" data-native-canvas="${esc(String(canvas?.id||''))}" data-native-owner="${esc(node.id)}">${row(entries.at(-1))}${entries.length>1?`<details><summary>最近历史（${entries.length-1} 条 / 共 ${all.length-1} 条）</summary>${entries.slice(0,-1).reverse().map(row).join('')}</details>`:''}</div>`;
    }
    const listKey=e=>e.dataset.nativeCanvas+':'+e.dataset.nativeOwner;
    function captureLists(){return new Map([...document.querySelectorAll('.studio-native-task-list')].map(e=>[listKey(e),{open:Boolean(e.querySelector(':scope > details')?.open),top:e.scrollTop}]));}
    function decorate(saved=new Map()){
        if(typeof nodes==='undefined')return;
        const stale=new Set(document.querySelectorAll('.studio-native-task-list'));
        for(const n of nodes){
            let content=html(n);
            if(!content)continue;
            const el=document.querySelector(`.node[data-id="${CSS.escape(n.id)}"],.image-node[data-id="${CSS.escape(n.id)}"],.prompt-node[data-id="${CSS.escape(n.id)}"]`);
            if(!el)continue;
            const host=el.querySelector('.prompt-node-card')||el.querySelector('.node-body')||el;
            let list=host.querySelector(':scope > .studio-native-task-list');
            if(list)stale.delete(list);
            const ui=saved.get(String(canvas?.id)+':'+n.id)||{open:Boolean(list?.querySelector(':scope > details')?.open),top:list?.scrollTop||0};
            if(ui.open)content=content.replace('<details>','<details open="">');
            if(list?.outerHTML===content)continue;
            if(list)list.outerHTML=content;else host.insertAdjacentHTML('beforeend',content);
            host.querySelector(':scope > .studio-native-task-list').scrollTop=ui.top;
        }
        for(const list of stale)list.remove();
    }
    function hold(error){
        if(!error?.legacyTaskHeld)return false;
        const ctx=error.legacyContext;
        if(scope(ctx)){
            if(latest(ctx)){ctx.node.running=false;ctx.out.running=false;}
            refresh(ctx);if(smart())toast(error.message.slice(0,240));else setStatus(error.message);
        }
        return true;
    }
    function find(id){
        for(const node of nodes){const a=node.studioLegacyAttempts?.[id];if(!isNative(a))continue;const out=nodes.find(n=>n.id===a.outputId);return {attempt:a,node,out:out||node,origin:canvas,missingOutput:!out};}return null;
    }
    function view(ctx){
        const a=ctx.attempt,dialog=document.createElement('dialog');dialog.className='studio-native-result-dialog';
        const esc=escapeHtml,media=a.kind==='video'?resultMediaUrls(a.result||{}).map(item=>typeof item==='string'?item:item?.url||'').filter(url=>/^(https?:\/\/|\/(?!\/))/.test(url)):[];
        dialog.innerHTML=`<h3>生成结果</h3><p>${ctx.missingOutput?'原输出槽已删除；结果仍保留，可查看和复制。':a.kind==='llm'?'本次结果已保留；替换当前文字后可撤销。':'原视频任务结果 · '+new Date(a.createdAt).toLocaleString()}</p>${a.kind==='video'?media.map(url=>`<video controls preload="metadata" src="${esc(url)}"></video><a href="${esc(url)}" target="_blank" rel="noopener" download>打开 / 下载视频</a>`).join('')+'<details><summary>原任务详情</summary><textarea readonly aria-label="原任务详情"></textarea></details>':'<textarea readonly aria-label="生成结果"></textarea>'}<div><button type="button" data-result-copy>${a.kind==='video'?'复制视频地址':'复制'}</button>${a.kind==='llm'&&a.snapshot.meta.mode!=='classic-chat'?'<button type="button" data-result-replace>替换当前文字</button>':''}<button type="button" data-result-close>关闭</button></div>`;
        const text=a.kind==='llm'?String(a.result?.text||''):media.join('\n');dialog.querySelector('textarea').value=a.kind==='llm'?text:JSON.stringify(a.result,null,2);
        dialog.querySelector('[data-result-copy]').onclick=async()=>{try{await navigator.clipboard.writeText(text);}catch{if(a.kind==='llm'){dialog.querySelector('textarea').select();document.execCommand('copy');}}};
        dialog.querySelector('[data-result-close]').onclick=()=>dialog.close();
        const replace=dialog.querySelector('[data-result-replace]');if(replace)replace.onclick=()=>{try{check(ctx);a.applied=false;applyText(ctx,true);dialog.close();}catch(e){dialog.querySelector('p').textContent=e.message;}};
        dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.appendChild(dialog);dialog.showModal();
    }
    document.addEventListener('click',e=>{
        const button=e.target.closest('[data-native-action]');if(!button)return;
        e.preventDefault();e.stopPropagation();const ctx=find(button.dataset.nativeId);if(!ctx)return;
        if(button.dataset.nativeAction==='view')view(ctx);else void query(ctx,button.dataset.nativeAction==='resume');
    },true);
    document.addEventListener('mousedown',e=>{if(e.target.closest('.studio-native-task-list'))e.stopPropagation();},true);
    // Receipt history is a native scroll area, not a canvas zoom gesture.
    document.addEventListener('wheel',e=>{
        const list=e.target.closest('.studio-native-task-list');
        const container=e.target.closest('.image-node>.node-body:has(>.studio-native-task-list),.prompt-node-card:has(>.studio-native-task-list)');
        if(list || container&&container.scrollHeight>container.clientHeight+1)e.stopPropagation();
    },{capture:true,passive:true});
    // No periodic DOM scan: decorate only when the native renderer changes its cards.
    const oldRender=render;render=function(...args){const saved=captureLists(),value=oldRender.apply(this,args);decorate(saved);return value;};
    if(!smart() && typeof refreshNodes==='function'){
        const oldRefresh=refreshNodes;refreshNodes=function(...args){const saved=captureLists(),value=oldRefresh.apply(this,args);decorate(saved);return value;};
    }
    window.StudioNativeTasks={isNative,scope,owned,check,held,hold,reason,ensureCapability,run,read,wait,query,applyText,applyVideo,markApplied,latest,decorate,find};
    decorate();
})();
