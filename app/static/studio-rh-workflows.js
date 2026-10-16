/* RH provider for the shared workflow workbench. No independent execution path. */
(() => {
  'use strict';
  const root='/api/studio/runninghub/workflows',clone=value=>JSON.parse(JSON.stringify(value));
  const localId=/^rh_[a-f0-9]{32}$/;
  const currentCanvas=()=>typeof canvas!=='undefined'?canvas:null;
  const currentNodes=()=>typeof nodes!=='undefined'?nodes:[];
  async function request(path='',method='GET',body){
    const response=await fetch(root+path,{method,headers:body?{'Content-Type':'application/json'}:undefined,...(body?{body:JSON.stringify(body)}:{})});
    let data;try{data=await response.json();}catch{throw Error('RH 工作台响应格式无效；没有执行任务。');}
    if(!response.ok){const error=Error(response.status===404&&!path.includes('rh_')?'RH 工作台后端尚未载入，请重启应用载入更新；没有保存或执行任务。':(typeof data.detail==='string'?data.detail:'RH 配置请求失败。'));error.status=response.status;throw error;}
    return data;
  }
  function kindOf(field){
    const raw=String(field.fieldType||'TEXT').toUpperCase();
    if(/seed|种子/i.test(field.fieldName+' '+field.label)&&['INT','INTEGER','NUMBER','FLOAT'].includes(raw))return 'seed';
    if(field.options?.length)return 'enum';
    if(['INT','INTEGER','NUMBER','FLOAT','SLIDER'].includes(raw))return 'number';
    if(['BOOL','BOOLEAN'].includes(raw))return 'bool';
    if(['IMAGE','VIDEO','AUDIO'].includes(raw))return raw.toLowerCase();
    return 'text';
  }
  function toConfig(item){
    const version=item.versions.at(-1),definition=clone(version.definition),entry=definition.entry;
    return {id:item.draft||item.legacy?null:item.id,name:item.name||entry.title,baseRevision:item.draft||item.legacy?0:version.revision,
      definition,versions:clone(item.versions),dirty:Boolean(item.draft||item.legacy),outputs:[],
      fields:entry.fields.map(raw=>{const type=kindOf(raw);let value=raw.fieldValue??'';if(type==='seed')value=String(value);if(type==='bool')value=value===true||String(value).toLowerCase()==='true';return {
        ...clone(raw),id:raw.nodeId+'::'+raw.fieldName,node_id:raw.nodeId,input:raw.fieldName,label:raw.label||raw.fieldName,type,
        default:value,enabled:raw.enabled!==false,values:clone(raw.options||[]),classType:raw.group||'RH 参数',raw:clone(raw)};})};
  }
  async function legacy(){return (await request('/legacy')).items;}
  function legacyId(item){return 'legacy_'+item.kind+':'+item.target_id;}
  async function get(id){
    if(localId.test(id))return request('/'+encodeURIComponent(id));
    const entry=(await legacy()).find(item=>legacyId(item)===id);
    if(!entry)throw Error('原 RH 配置已删除，请重新读取目录。');
    const draft=await request('/preview','POST',{kind:entry.kind,entry:entry.entry,target_id:entry.target_id,name:entry.name});
    return {...draft,id,legacy:true,name:entry.name+' · 旧配置草稿'};
  }
  async function list(){
    const [saved,old]=await Promise.all([request(),legacy()]);
    return {items:[...saved.items,...old.map(item=>({id:legacyId(item),name:item.name+' · 旧配置（需保存版本）',kind:item.kind,revision:0,fields:item.entry.fields||[],legacy:true}))]};
  }
  async function saveVersion(config){
    const definition=clone(config.definition);
    definition.entry.title=config.name;
    const typeMap={text:'TEXT',number:'NUMBER',seed:'INT',bool:'BOOLEAN',enum:'SELECT',model:'TEXT',image:'IMAGE',video:'VIDEO',audio:'AUDIO'};
    definition.entry.fields=config.fields.map(field=>{
      const raw=clone(field.raw||{}),oldType=kindOf(raw);
      const next={...raw,nodeId:field.node_id||raw.nodeId,fieldName:field.input||raw.fieldName,label:field.label,
        enabled:Boolean(field.enabled),fieldValue:field.default,fieldType:field.type===oldType?(raw.fieldType||typeMap[field.type]):typeMap[field.type],
        options:field.type==='enum'?clone(field.values||[]):[]};
      if(!next.fieldType)throw Error('不支持的 RH 参数类型。');
      return next;
    });
    return request(config.id?'/'+encodeURIComponent(config.id):'',config.id?'PUT':'POST',{
      name:config.name,definition,...(config.id?{expected_revision:config.baseRevision}:{})});
  }
  async function createNode(item,revision){
    if(document.querySelector('.smart-back')||typeof addRhNode!=='function'||typeof runRhNode!=='function'||typeof applyRhEntrySelection!=='function'){
      throw Error('RH 配置可在此浏览和保存；请切换经典画布添加并运行 RH 节点。');
    }
    if(!window.StudioSave?.ensureCurrent)throw Error('保存保护尚未就绪，未添加 RH 节点。');
    if(!localId.test(item.id))throw Error('请先显式保存本地配置版本。');
    const origin=currentCanvas();if(!origin?.id)throw Error('请先打开经典项目。');
    const saved=await get(item.id);
    if(currentCanvas()!==origin)throw Error('画布已切换，未添加节点。');
    const version=saved.versions.find(value=>value.revision===revision);
    if(!version)throw Error('固定配置版本不存在。');
    const definition=clone(version.definition),entry=clone(definition.entry),target=definition.target_id;
    if(typeof pushUndo==='function')pushUndo();
    const node=addRhNode(typeof defaultPoint==='function'?defaultPoint():undefined);
    if(!node||!currentNodes().includes(node))throw Error('无法添加 RH 节点。');
    applyRhEntrySelection(node,{kind:definition.kind,id:target,entry});
    node.studioRhDefinition={key:definition.kind+':'+target,kind:definition.kind,id:target,entry,
      local_id:saved.id,revision,definition_hash:version.definition_hash};
    node.studioRhWorkflow={library_id:saved.id,revision,definition_hash:version.definition_hash};
    node.studioRhName=saved.name;node.rhParams={};
    if(definition.kind==='workflow')node.rhWorkflowInfo={workflowId:target,nodeInfoList:clone(entry.fields)};
    else node.rhAppInfo={nodeInfoList:clone(entry.fields)};
    if(typeof render==='function')render();
    const confirmed=await window.StudioSave.ensureCurrent({canvasId:String(origin.id),nodeId:node.id});
    if(currentCanvas()!==origin||!currentNodes().includes(node)||JSON.stringify(confirmed.node?.studioRhDefinition)!==JSON.stringify(node.studioRhDefinition)){
      throw Error('原 RH 配置节点未确认保存，请保留当前编辑并重试保存。');
    }
    return node;
  }
  function pinned(node){
    const pin=node?.studioRhDefinition,ref=node?.studioRhWorkflow;
    return Boolean(ref&&pin?.kind==='workflow'&&pin.key===node.rhConfigKey&&pin.local_id===ref.library_id&&pin.revision===ref.revision&&pin.definition_hash===ref.definition_hash);
  }
  if(typeof ensureRunningHubWorkflowConfigForNode==='function'){
    const previous=ensureRunningHubWorkflowConfigForNode;
    ensureRunningHubWorkflowConfigForNode=async function(node){return pinned(node)?clone(node.studioRhDefinition.entry):previous.apply(this,arguments);};
  }
  if(typeof rhBuildWorkflowRequestExtras==='function'){
    const previous=rhBuildWorkflowRequestExtras;
    rhBuildWorkflowRequestExtras=async function(node,media,fields){
      if(!pinned(node))return previous.apply(this,arguments);
      const entry=node.studioRhDefinition.entry;
      if(!entry.workflowJson||!Object.keys(entry.workflowJson).length)throw Error('固定 RH 工作流缺少完整图，请重新保存本地配置。');
      const extras=await previous.apply(this,arguments);
      return {...extras,workflow:extras.workflow||clone(entry.workflowJson)};
    };
  }
  const adapter={label:'RunningHub',kinds:[{id:'app',label:'RH 应用'},{id:'workflow',label:'RH 工作流'}],list,get,toConfig,saveVersion,createNode,
    previewImport:payload=>request('/preview','POST',payload),
    async connection(){
      const response=await fetch('/api/providers');if(!response.ok)throw Error('无法读取 RH 连接配置。');
      const data=await response.json(),provider=data.providers?.find(value=>value.id==='runninghub');
      return {message:!provider?'请先在 API 设置配置 RunningHub。':provider.enabled===false?'RH 渠道已禁用；配置库仍可管理，不能提交任务。':
        '已读取 RH 渠道配置；普通 Key '+(provider.has_key?'已配置':'未配置')+'，余额 Key '+(provider.has_wallet_key?'已配置':'未配置')+'。这不是上游连接或 GPU 验证；导入参数沿用原接口权限。'};
    },openSettings:()=>window.open('/static/api-settings.html','_blank','noopener')};
  if(!window.StudioWorkflows?.registerProvider)throw Error('统一工作流工作台尚未载入。');
  window.StudioWorkflows.registerProvider('runninghub',adapter);
  window.StudioRhWorkflows=Object.freeze({adapter});
})();
