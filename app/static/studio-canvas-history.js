/* Editing history never submits, resumes, polls, or recreates a generation task. */
(() => {
  'use strict';
  const frames=new WeakMap(),projects=new WeakMap(),outputs=new WeakMap();
  // Output revisions live only in this document, independently of persisted editing data.
  const outputVersion=node=>outputs.get(node)||{version:0,segments:new Map(),materials:new Map()};
  function recordOutput(node,segment,item){
    if(!node)return;const previous=outputVersion(node),state={version:previous.version+1,segments:new Map(previous.segments),materials:new Map(previous.materials)};
    const url=typeof item==='string'?item:item?.url;
    if(segment?.id){const prior=previous.segments.get(segment.id),results=new Map(prior?.results);if(url)results.set(url,{version:state.version,item:copy(segment.result)});state.segments.set(segment.id,{version:state.version,result:copy(segment.result),results});}
    const material=(node.materials||[]).find(m=>m.url===url);if(material)state.materials.set(url,{version:state.version,item:copy(material)});outputs.set(node,state);
  }
  const runtime=new Set(['studioHistoryRestored','studioLegacyAttempts','studioLegacyUnknown','studioJob','studioControlJob','studioSubmission','studioJobState','studioJobError','studioSavingSubmission','studioAccepted',
    'studioWorkflowRequestId','studioWorkflowSubmission','studioWorkflowTaskId','studioWorkflowTaskStatus','studioWorkflowAppliedTask','studioWorkflowError',
    'studioRhRequest','studioRhSnapshot','studioRhRemote','studioRhStatus','studioRhApplied','studioRhModelRun','studioRhModelLogged',
    'studioMjAttempt','studioMjTask','studioMjHistory','studioMjRequest','studioMjStatus','studioMjState','studioMjRemoteStatus','studioMjMediaStatus','studioMjCompleted','studioMjPastTasks','studioMjUsage',
    '_pending','pendingTasks','jimengPending','lastTaskId','lastTaskStatus','lastHistoryId','recoverTaskId','mjModalTaskId',
    'running','pending','queued','querying','runStatus','runError','runStartedAt','runFinishedAt','runElapsedMs','runTimerHidden',
    '_cascadeIdx','_cascadeFailed','_activeLoopCtx','_runMetaTargetId','_selectAfterRunId','task_id','taskId','history_id','historyId','request_id','requestId','submit_id','submitId','prompt_id']);
  const derived=new Set(['generatedOutputs','studioAudioOutputs','outputText']);
  const transient=new Set(['_dom','_ltxEditor','timelinePlaying']);
  const bindingKeys=['studioLegacyAttempts','studioLegacyUnknown','studioJob','studioControlJob','studioSubmission','studioWorkflowRequestId','studioWorkflowSubmission','studioWorkflowTaskId','studioRhRequest','studioRhRemote','studioMjAttempt','studioMjTask','studioMjHistory','studioMjRequest','_pending','pendingTasks','jimengPending','lastTaskId','lastHistoryId','recoverTaskId','mjModalTaskId'];
  const hasBinding=n=>bindingKeys.some(k=>n?.[k]&&(Array.isArray(n[k])?n[k].length:typeof n[k]==='object'?Object.keys(n[k]).length:true));
  const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  function restoredMaterials(base,current,record){const state=outputVersion(current),existing=new Set((base||[]).map(m=>m.url));return [...(current.materials||[]).flatMap(m=>{const generated=state.materials.get(m.url);return generated&&generated.version>record.outputVersion.version&&!existing.has(m.url)?[copy(generated.item)]:[]}),...(base||[])];}
  const segmentVersion=(state,id)=>state.segments.get(id)?.version||0;
  function restoredSegmentResults(data,state,baseVersion){const base=data.results||[],seen=new Set(base.map(m=>m.url));return [...[...state.results.values()].filter(entry=>entry.version>baseVersion&&!seen.has(entry.item.url)).map(entry=>copy(entry.item)).reverse(),...base];}
  const profile=node=>JSON.stringify(Object.fromEntries([...runtime].filter(k=>!['_activeLoopCtx','_cascadeIdx','runElapsedMs','querying'].includes(k)&&Object.hasOwn(node,k)).map(k=>[k,node[k]])));
  const derivedProfile=node=>JSON.stringify(Object.fromEntries([...derived,'studioMjText'].filter(k=>Object.hasOwn(node,k)).map(k=>[k,node[k]])));
  const outputProfile=node=>JSON.stringify([node.outputLayout||null,node.imageComparisons||null]);
  const imageKeys=node=>(node.images||[]).map(i=>typeof i==='string'?i:i?.url||i?.src||'').filter(Boolean);
  const active=node=>Boolean(node?.running||node?.pending||['prepared','dispatching','submitting','pending','queued','running','archiving'].includes(node?.studioJobState)||['submitting','queued','running','saving'].includes(node?.studioWorkflowTaskStatus)||['prepared','pending','submitting','queued','running'].includes(node?.studioMjStatus)||['submitting','queued','running','archiving'].includes(node?.studioRhStatus)||Object.values(node?.studioLegacyAttempts||{}).some(a=>['prepared','dispatching','queued','running'].includes(a.status)));
  const editable=node=>Object.fromEntries(Object.entries(node).filter(([k])=>!runtime.has(k)&&!derived.has(k)&&!transient.has(k)));
  function capture({canvas,nodes=[],connections=[],...extra}={}){
    if(!canvas?.id)return null;
    const prior=projects.get(canvas)||new Set(),present=new Set(nodes.map(n=>n.id)),absent=new Set([...prior].filter(id=>!present.has(id)));
    const records=new Map();
    for(const node of nodes){records.set(node.id,{node,bound:hasBinding(node),profile:profile(node),derived:derivedProfile(node),images:imageKeys(node),outputMeta:outputProfile(node),outputVersion:outputVersion(node),segments:new Map((Array.isArray(node.segments)?node.segments:[]).map(seg=>[seg.id,seg]))});prior.add(node.id);}
    projects.set(canvas,prior);
    const snapshot={nodes:nodes.map(n=>copy(editable(n))),connections:copy(connections),...copy(extra)};
    frames.set(snapshot,{canvas,canvasId:String(canvas.id),records,absent});return snapshot;
  }
  const finished=status=>['succeeded','success','SUCCESS','done','completed','failed','FAILED','uncertain','verification_required'].includes(status);
  const note='节点通过撤销恢复；原任务身份保留，未自动继续执行，请先核实任务记录。';
  function pauseRestored(node){
    if(!hasBinding(node))return;
    node.studioHistoryRestored=true;node.running=false;node.queued=false;node.querying=false;
    if(node.studioJob&&!finished(node.studioJobState)){node.studioJobState='uncertain';node.studioJobError=note+' 继续执行可能包含未完成阶段。';}
    if((node.studioWorkflowRequestId||node.studioWorkflowTaskId)&&!finished(node.studioWorkflowTaskStatus)){node.studioWorkflowTaskStatus='uncertain';node.studioWorkflowError=note;}
    if((node.studioMjTask||node.studioMjHistory||node.studioMjAttempt)&&!finished(node.studioMjStatus)){node.studioMjStatus='paused';node.studioMjState=note;}
    if(node.studioRhRequest&&!finished(node.studioRhStatus)){node.studioRhStatus='uncertain';node.runError=note;}
    for(const a of Object.values(node.studioLegacyAttempts||{}))if(!finished(a.status)){a.status='paused';a.error=note;a.recovery_status='history_restored';a.retryable=false;}
    for(const p of [...(node._pending||[]),...(node.pendingTasks||[])]){p.querying=false;p.historyRestored=true;p.legacyStatus='paused';p.canvasTaskStatus='paused';p.error=note;p.failed=false;}
    if(node._pending?.length||node.pendingTasks?.length){node.pending=0;node.runStatus='paused';node.runError=note;}
    if(node.jimengPending){node.jimengPending.querying=false;node.jimengPending.historyRestored=true;node.runStatus='paused';node.runError=note;}
  }
  const continuation=new Set(['_activeLoopCtx','_cascadeIdx','_cascadeFailed','_runMetaTargetId','_selectAfterRunId','studioSavingSubmission']);
  function restore({canvas,nodes=[],connections=[],snapshot}={}){
    const meta=snapshot&&frames.get(snapshot);
    if(!meta||meta.canvas!==canvas||meta.canvasId!==String(canvas?.id))return {ok:false,blocked:true,reason:'历史记录不属于当前画布；已保留当前编辑和任务。'};
    if(!Array.isArray(snapshot.nodes)||!Array.isArray(snapshot.connections))return {ok:false,blocked:true,reason:'历史记录无法安全恢复；当前编辑和任务未改变。'};
    let prepared;
    try{
      const live=new Map(nodes.map(n=>[n.id,n])),wanted=new Set(snapshot.nodes.map(n=>n.id)),changed=new Set(),protectedIds=new Set(),restoredIds=[];
      for(const n of nodes){const before=meta.records.get(n.id);if((hasBinding(n)||before?.bound)&&(!before||before.profile!==profile(n)||before.derived!==derivedProfile(n))||before&&before.outputVersion.version!==outputVersion(n).version)changed.add(n.id);}
      for(const id of changed){protectedIds.add(id);const n=live.get(id);for(const a of Object.values(n?.studioLegacyAttempts||{}))if(a.outputId)protectedIds.add(a.outputId);}
      for(const edge of connections)if(changed.has(edge.from)){const out=live.get(edge.to);if(out&&(out.type==='output'||out.isHistoryGroup||out.historyFor))protectedIds.add(edge.to);}
      for(const n of nodes){
        if(changed.has(n.historyFor))protectedIds.add(n.id);
        const before=meta.records.get(n.id),now=imageKeys(n),old=before?.images||[],appended=now.length>old.length&&old.every(k=>now.includes(k)),metadataChanged=before&&before.outputMeta!==outputProfile(n);if(!appended&&!metadataChanged)continue;
        const owners=[n,...connections.filter(e=>e.to===n.id).map(e=>live.get(e.from))];
        if((n.type==='output'||hasBinding(n)||n.historyFor)&&owners.some(o=>hasBinding(o)&&active(o)))protectedIds.add(n.id);
      }
      for(const n of nodes)if(!wanted.has(n.id)&&!meta.absent.has(n.id)&&(hasBinding(n)||protectedIds.has(n.id)))protectedIds.add(n.id);
      const plans=[],result=[];
      // Complete every potentially failing clone before touching any live object.
      for(const data of snapshot.nodes){
        const current=live.get(data.id),fields=copy(editable(data));
        if(current){
          if(Object.isFrozen(current))throw Error('节点不可修改');
          const media=protectedIds.has(data.id)?new Map(['images','outputLayout','imageComparisons','studioMjText'].map(k=>[k,{exists:Object.hasOwn(current,k),value:current[k]}])):null;
          let segmentPlans=null,heldSegments=new Set();
          if(['minimax','smart-minimax'].includes(current.type)&&Array.isArray(fields.segments)){
            const byId=new Map((current.segments||[]).map(seg=>[seg.id,seg])),before=meta.records.get(current.id),versions=outputVersion(current);
            segmentPlans=[];const requested=new Set(fields.segments.map(seg=>seg.id));for(const id of byId.keys())if(!requested.has(id))heldSegments.add(id);fields.segments=fields.segments.map(data=>{const seg=byId.get(data.id);if(!seg){heldSegments.add(data.id);return data;}if(Object.isFrozen(seg))throw Error('片段不可修改');const baseVersion=before?segmentVersion(before.outputVersion,seg.id):0,generated=versions.segments.get(seg.id),fresh=baseVersion!==segmentVersion(versions,seg.id),keep=fresh?new Map([['result',{exists:true,value:copy(generated.result)}],['results',{exists:true,value:restoredSegmentResults(data,generated,baseVersion)}]]):null;segmentPlans.push({seg,fields:data,keep});return seg;});
            if(before&&before.outputVersion.version!==versions.version)fields.materials=restoredMaterials(fields.materials,current,before);
          }
          plans.push({current,fields,media,segmentPlans,heldSegments});result.push(current);
        }else{
          const restored=fields,record=meta.records.get(data.id),original=record?.node;
          if(original){
            for(const key of [...runtime,...derived])if(!continuation.has(key)&&Object.hasOwn(original,key))restored[key]=copy(original[key]);
            const fresh=(hasBinding(original)||record.bound)&&(record.profile!==profile(original)||record.derived!==derivedProfile(original)||active(original)&&(JSON.stringify(record.images)!==JSON.stringify(imageKeys(original))||record.outputMeta!==outputProfile(original)));
            if(fresh)for(const key of ['images','outputLayout','imageComparisons','studioMjText']){if(Object.hasOwn(original,key))restored[key]=copy(original[key]);else delete restored[key];}
          }
          if(original&&['minimax','smart-minimax'].includes(restored.type)){
            const versions=outputVersion(original);outputs.set(restored,versions);
            if(record.outputVersion.version!==versions.version){
              restored.materials=restoredMaterials(restored.materials,original,record);
              restored.segments=(restored.segments||[]).map(seg=>{const source=(original.segments||[]).find(s=>s.id===seg.id)||record.segments.get(seg.id);if(source&&segmentVersion(record.outputVersion,seg.id)!==segmentVersion(versions,seg.id)){const generated=versions.segments.get(seg.id);seg.result=copy(generated.result);seg.results=restoredSegmentResults(seg,generated,segmentVersion(record.outputVersion,seg.id));}return seg;});
            }
          }
          pauseRestored(restored);result.push(restored);restoredIds.push(restored.id);
        }
      }
      for(const n of nodes)if(!wanted.has(n.id)&&protectedIds.has(n.id)&&!meta.absent.has(n.id))result.push(n);
      const ids=new Set(result.map(n=>n.id)),edges=copy(snapshot.connections).filter(e=>ids.has(e.from)&&ids.has(e.to));
      for(const edge of connections)if(ids.has(edge.from)&&ids.has(edge.to)&&((!wanted.has(edge.from)&&protectedIds.has(edge.from))||(!wanted.has(edge.to)&&protectedIds.has(edge.to)))&&!edges.some(e=>e.from===edge.from&&e.to===edge.to))edges.push(copy(edge));
      prepared={plans,result,edges,protectedIds,restoredIds};
    }catch(e){return {ok:false,blocked:true,reason:'历史数据无法安全复制；当前编辑与任务保持原样。'};}
    const {plans,result,edges,protectedIds,restoredIds}=prepared;
    for(const {current,fields,media,segmentPlans} of plans){
      for(const plan of segmentPlans||[]){for(const key of Object.keys(plan.seg))if(!Object.hasOwn(plan.fields,key))delete plan.seg[key];Object.assign(plan.seg,plan.fields);if(plan.keep)for(const [key,item]of plan.keep){if(item.exists)plan.seg[key]=item.value;else delete plan.seg[key];}}
      for(const key of Object.keys(current))if(!runtime.has(key)&&!derived.has(key)&&!transient.has(key)&&!Object.hasOwn(fields,key))delete current[key];
      Object.assign(current,fields);
      if(media)for(const [key,item]of media){if(item.exists)current[key]=item.value;else delete current[key];}
    }
    for(const {current,heldSegments}of plans){
      for(const a of Object.values(current.studioLegacyAttempts||{}))if(heldSegments.has(a.snapshot?.segmentId)){
        if(!finished(a.status)){a.status='paused';a.error=note;a.recovery_status='history_restored';a.retryable=false;current.runError=note;current.runStatus='paused';}
        const out=result.find(n=>n.id===a.outputId);
        for(const p of [...(out?._pending||[]),...(out?.pendingTasks||[])])if(p.requestId===a.id||p.id===a.pendingId){p.historyRestored=true;p.querying=false;p.error=note;p.legacyStatus=a.status;p.canvasTaskStatus=a.status;p.failed=false;}
      }
      if(heldSegments.size){
        const waiting=Object.values(current.studioLegacyAttempts||{}).filter(a=>['dispatching','queued','running'].includes(a.status));
        current.running=waiting.length>0;
        if(Array.isArray(current.pendingTasks)){current.pending=current.pendingTasks.filter(p=>!p.historyRestored&&!p.failed&&!['paused','uncertain','failed','succeeded'].some(status=>p.legacyStatus===status||p.canvasTaskStatus===status)).length;current.running=current.running&&current.pending>0;}
        if(!current.running&&!current.pending)current.queued=false;
        if(current.running)current.runStatus=waiting.some(a=>a.status!=='queued')?'running':'queued';
      }
    }
    const restoredSet=new Set(restoredIds);
    for(const n of result)for(const a of Object.values(n.studioLegacyAttempts||{}))if(restoredSet.has(a.outputId)&&!finished(a.status)){
      a.status='paused';a.error=note;a.recovery_status='history_restored';a.retryable=false;n.runError=note;
      n.running=Object.values(n.studioLegacyAttempts).some(a=>['dispatching','queued','running'].includes(a.status));
    }
    const registry=projects.get(canvas)||new Set();for(const n of result)registry.add(n.id);projects.set(canvas,registry);
    return {ok:true,blocked:false,nodes:result,connections:edges,protectedIds:[...protectedIds],restoredIds,reason:protectedIds.size?'已撤销编辑；新任务回执与结果已保留。':restoredIds.some(id=>hasBinding(result.find(n=>n.id===id)))?note:''};
  }
  window.StudioCanvasHistory=Object.freeze({capture,restore,recordOutput});
})();
