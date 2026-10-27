"""Durable RH application/workflow requests; retries query the original request only."""
import asyncio
import json
import hashlib
import inspect
import re
import time
from pathlib import Path
from typing import Any
import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field
import main as core

LOCK=asyncio.Lock()
ACTIVE=set()

class Submit(BaseModel):
    request_id:str=Field(pattern=r'^[A-Za-z0-9_-]{8,100}$')
    canvas_id:str
    node_id:str
    kind:str=Field(pattern=r'^(app|workflow|model)$')
    payload:dict[str,Any]

class ModelPayload(core.OnlineImageRequest):
    count:int=Field(default=1,ge=1,le=8)

class Import(BaseModel):
    source:str=Field(min_length=1,max_length=2000)
    kind:str=Field(pattern=r'^(app|workflow)$')
    name:str=Field(default='',max_length=120)

def directory():
    path=Path(core.DATA_DIR)/'studio-runninghub-tasks';path.mkdir(parents=True,exist_ok=True);return path

def read(key):
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}',key):raise HTTPException(400,'任务编号无效')
    path=directory()/(key+'.json')
    if not path.exists():raise HTTPException(404,'任务不存在')
    record=json.loads(path.read_text(encoding='utf-8'))
    if record['status']=='submitting' and key not in ACTIVE:
        record.update(status='uncertain',error='提交结果待核实；请到 RH 查询，避免重复扣费。');save(record)
    return record

def save(record):
    record['updated_at']=time.time();p=directory()/(record['id']+'.json');tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(record,ensure_ascii=False),encoding='utf-8');tmp.replace(p)

def safe_reason(detail, secrets=()):
    """Expose useful provider errors without credentials, raw payloads or URLs."""
    if isinstance(detail,dict):
        raw=detail.get('raw')
        text=core.runninghub_fail_reason(raw) if isinstance(raw,dict) else ''
        text=text or detail.get('message') or detail.get('error') or ''
    else:text=str(detail or '')
    text=str(text)
    for secret in secrets:
        if secret:text=text.replace(str(secret),'[已隐藏]')
    text=re.sub(r'https?://[^\s<>"\']+','[链接已隐藏]',text,flags=re.I)
    text=re.sub(r'((?:api[-_]?key|authorization|access[-_]?token|token|secret)["\']?\s*[=:]\s*["\']?)(?:Bearer\s+)?[^\s,;"\']+',r'\1[已隐藏]',text,flags=re.I)
    text=re.sub(r'Bearer\s+[A-Za-z0-9._~-]+','Bearer [已隐藏]',text,flags=re.I)
    return text[:800]

def error_code(detail):
    if not isinstance(detail,dict):return ''
    raw=detail.get('raw') if isinstance(detail.get('raw'),dict) else detail
    return str(raw.get('errorCode') or raw.get('code') or '')[:80]

def model_child_request_id(parent_id,index):
    return 'rh_model_'+hashlib.sha256(f'{parent_id}:{index}'.encode('utf-8')).hexdigest()

def find_model_child_request(request_id):
    # The legacy ledger owns execution, receipts and result recovery. A lookup
    # must not create a task or schedule a missing child.
    from studio_legacy_tasks import find_image_request
    return find_image_request(request_id)

async def submit(request):
    body=ModelPayload(**request.payload) if request.kind=='model' else core.RunningHubSubmitRequest(**request.payload) if request.kind=='app' else core.RunningHubWorkflowSubmitRequest(**request.payload)
    normalized=body.model_dump(exclude={'request_id','canvas_id','node_id'}) if request.kind=='model' else body.model_dump()
    request=request.model_copy(update={'payload':normalized})
    if request.kind=='model':
        if body.provider_id!='runninghub' or not body.model.strip():raise HTTPException(400,'请选择有效的 RH 模型')
    else:
        target=body.webappId if request.kind=='app' else body.workflowId
        if not re.fullmatch(r'\d+',target):raise HTTPException(400,'请输入正确的 RH 应用或工作流 ID')
    # Validate configuration before reserving a request; no secrets enter its snapshot.
    provider=core.runninghub_provider()
    api_key=core.runninghub_api_key(provider,use_wallet=True if request.kind=='model' else body.useWallet)
    async with LOCK:
        try:
            existing=read(request.request_id)
            if existing['request']!=request.model_dump():raise HTTPException(409,'请求编号已用于不同输入')
            return existing
        except HTTPException as error:
            if error.status_code!=404:raise
        record={'id':request.request_id,'request':request.model_dump(),'provider_id':'runninghub','base_url':str(provider.get('base_url','')).rstrip('/'),'status':'submitting','task_id':'','outputs':[],'error':'','created_at':time.time()}
        if request.kind=='model':
            record['children']=[{'request_id':model_child_request_id(request.request_id,index),'index':index,'task_id':'','status':'planned','outputs':[],'error':''} for index in range(body.count)]
            record['submission_complete']=False
        ACTIVE.add(record['id'])
        try:save(record)
        except Exception:
            ACTIVE.discard(record['id']);raise HTTPException(503,'RH 请求未能保存，未提交。')
    try:
        if request.kind=='model':
            if not {'request_id','canvas_id','node_id'}.issubset(core.OnlineImageRequest.model_fields):raise HTTPException(503,'模型子任务持久保护尚未就绪，未提交。')
            for plan in record['children']:
                model_body=core.OnlineImageRequest(**{**normalized,'request_id':plan['request_id'],'canvas_id':request.canvas_id,'node_id':request.node_id})
                child=await core.create_canvas_image_task(model_body)
                if not child.get('task_id'):raise ValueError('Missing child task id')
                plan.update(task_id=child['task_id'],status=child.get('status') or 'queued')
                record['task_id']=record['children'][0]['task_id']
                # Persist each receipt before creating the next child. An
                # interrupted batch is queried, never filled with new submits.
                save(record)
            record.update(status='queued',submission_complete=True)
            return record
        response=await (core.runninghub_submit(body) if request.kind=='app' else core.runninghub_workflow_submit(body))
        task_id=response.get('data',{}).get('taskId')
        if not task_id:raise ValueError('Missing task id')
        record.update(task_id=task_id,status='queued')
    except HTTPException as error:
        if isinstance(error.__cause__,(httpx.ConnectError,httpx.ConnectTimeout)) and not record.get('children'):
            # The connection never opened: RH cannot have this request, so it may be sent again.
            record.update(status='not_submitted',error='网络未连接，请求没有发出，未产生费用；恢复网络后可以重新生成。',error_phase='submit',error_code='network')
            return record
        rejected=400<=error.status_code<500 and not record.get('children')
        reason=safe_reason(error.detail,(api_key,))
        message='RH 拒绝提交' if rejected else '提交结果待核实；请到 RH 查询，勿重复提交'
        record.update(status='failed' if rejected else 'uncertain',error=message+('：'+reason if reason else '。'),error_phase='submit',error_code=error_code(error.detail) or str(error.status_code))
    except Exception:
        record.update(status='uncertain',error='提交连接中断，结果待核实；请到 RH 查询，勿重复提交。',error_phase='submit',error_code='')
    finally:
        try:save(record)
        finally:ACTIVE.discard(record['id'])
    return record

async def query_model_remote(task_id):
    """Query an already known standard-model ID using the existing model API."""
    provider=core.runninghub_provider()
    async with core.httpx.AsyncClient(timeout=120) as client:
        response=await client.post(core.runninghub_openapi_url(provider,'query'),headers=core.runninghub_json_headers(provider),json={'taskId':task_id})
        response.raise_for_status();raw=response.json();status=core.runninghub_query_status(raw).upper()
        if status in ('SUCCESS','SUCCEEDED','COMPLETED','COMPLETE','FINISHED','DONE','3'):
            outputs=[]
            for url in core.runninghub_extract_outputs(raw):
                local=await core.runninghub_store_remote_output(client,url)
                outputs.append(core.image_output_meta(local))
            if not outputs:return {'status':'failed','error':'模型未返回可用图片。'}
            return {'status':'archiving' if any(str(item.get('url','')).startswith('http') for item in outputs) else 'succeeded','outputs':outputs}
        if status in ('FAILED','FAIL','ERROR','CANCEL','CANCELED','CANCELLED','4'):
            return {'status':'failed','error':core.runninghub_fail_reason(raw)}
        return {'status':'running'}

async def archive_model_outputs(outputs):
    archived=[]
    async with core.httpx.AsyncClient(timeout=120) as client:
        for item in outputs:
            item=dict(item);url=str(item.get('url',''))
            if url.startswith(('http://','https://')):
                try:item['url']=await core.runninghub_store_remote_output(client,url)
                except Exception:pass  # keep its URL for a GET-only archive retry
            archived.append(item)
    return archived

async def query_model(record):
    if any(child.get('request_id') for child in record.get('children',[])):
        return await query_planned_model(record)
    api_key=core.runninghub_api_key(core.runninghub_provider(),use_wallet=True)
    outputs=[];states=[]
    for child in record.get('children',[]):
        if child.get('status')!='succeeded':
            try:
                if child.get('status')=='archiving' and child.get('outputs'):
                    child['outputs']=await archive_model_outputs(child['outputs'])
                    child['status']='archiving' if any(str(item.get('url','')).startswith('http') for item in child['outputs']) else 'succeeded'
                    outputs.extend(child['outputs']);states.append(child['status']);continue
                task=await core.get_canvas_image_task(child['task_id'])
                status=task.get('status','unknown')
                child.update(status=status,error=safe_reason(task.get('error'),(api_key,)))
                if status=='succeeded':
                    result=task.get('result') or {}
                    child['outputs']=result.get('image_items') or [{'url':url} for url in result.get('images',[])]
                    if not child['outputs']:child.update(status='failed',error='模型未返回可用图片。')
                    elif any(str(item.get('url','')).startswith('http') for item in child['outputs']):
                        child.update(status='archiving',error='模型结果已生成，等待本地转存。')
                # Native tasks may expose an upstream ID on execution failure.
                if task.get('upstream_task_id'):child['upstream_task_id']=task['upstream_task_id']
                if status=='failed' and child.get('upstream_task_id'):
                    remote=await query_model_remote(child['upstream_task_id'])
                    child.update(status=remote['status'],error=safe_reason(remote.get('error'),(api_key,)),outputs=remote.get('outputs',[]))
            except HTTPException as error:
                if child.get('upstream_task_id'):
                    try:
                        remote=await query_model_remote(child['upstream_task_id'])
                        child.update(status=remote['status'],error=safe_reason(remote.get('error'),(api_key,)),outputs=remote.get('outputs',[]))
                    except Exception:child.update(status='unknown',error='已知上游模型任务暂不可查询；请稍后继续查询原请求。')
                else:child.update(status='unknown',error='原模型子任务暂不可查询：'+safe_reason(error.detail,(api_key,)))
            except Exception:
                child.update(status='unknown',error='原模型子任务查询中断，请继续查询原请求。')
        outputs.extend(child.get('outputs',[]));states.append(child.get('status'))
    record.update(outputs=outputs,error='',error_phase='',error_code='')
    if not record.get('submission_complete'):
        record.update(status='uncertain',error='部分模型提交结果待核实；已收到的子任务将继续查询，请勿重新提交。',error_phase='submit')
    elif states and all(status=='succeeded' for status in states):record['status']='succeeded'
    elif any(status in ('queued','running','archiving') for status in states):
        record['status']='running' if any(status in ('queued','running') for status in states) else 'archiving'
        if record['status']=='archiving':record.update(error='模型结果已生成，本地转存尚未完成；继续查询将重试转存。',error_phase='result_storage')
    elif any(status=='unknown' for status in states):
        record.update(status='unknown',error='原模型任务暂不可查询，可能服务已重启；任务编号已保留，请核对 RH 记录，勿重新提交。',error_phase='query')
    else:
        reason=next((child.get('error') for child in record.get('children',[]) if child.get('error')),'模型未返回可用结果。')
        record.update(status='failed',error='RH 模型任务执行失败：'+reason,error_phase='execution')
    return record

async def query_planned_model(record):
    """Aggregate ledger-owned children without submitting or recovering them."""
    api_key=core.runninghub_api_key(core.runninghub_provider(),use_wallet=True)
    outputs=[];states=[];found=0
    for child in record.get('children',[]):
        try:
            task=find_model_child_request(child['request_id'])
            if inspect.isawaitable(task):task=await task
            if not task and child.get('task_id'):
                task=await core.get_canvas_image_task(child['task_id'])
            if not task:
                child.update(status='uncertain',error='尚未找到原子请求账本；请核实提交结果，不会补交。')
            elif task.get('request_id') and task['request_id']!=child['request_id']:
                child.update(status='unknown',error='原子请求归属无法核实，不会补交。')
            else:
                found+=1
                child.update(task_id=task.get('task_id') or task.get('id') or child.get('task_id',''),status=task.get('status') or 'unknown',error=safe_reason(task.get('error'),(api_key,)))
                for key in ('upstream_task_id','receipt','queryable','retryable','recovery_status'):
                    if key in task:child[key]=task[key]
                result=task.get('result') or {}
                child['outputs']=task.get('outputs') or result.get('image_items') or [{'url':url} for url in result.get('images',[])]
                if child['status']=='succeeded' and not child['outputs']:
                    child.update(status='unknown',error='子账本标记完成但尚无可用结果，请核实原任务。')
                elif any(str(item.get('url','')).startswith(('http://','https://')) for item in child['outputs']):
                    child.update(status='archiving',error='子任务仍有远程结果，等待其账本完成本地转存。')
        except Exception:
            child.update(status='unknown',error='原子账本暂不可查询；不会创建新的子任务。')
        outputs.extend(child.get('outputs',[]));states.append(child['status'])
    record.update(outputs=outputs,error='',error_phase='',error_code='')
    if record.get('children') and found==len(record['children']):record['submission_complete']=True
    ids=[child['task_id'] for child in record.get('children',[]) if child.get('task_id')]
    if ids:record['task_id']=ids[0]
    if not record.get('submission_complete') or any(state in ('planned','paused','uncertain') for state in states):
        record.update(status='uncertain',error='模型子请求或回执待核实；仅查询已计划请求，不会补交或重复提交。',error_phase='submit')
    elif any(state=='unknown' for state in states):
        record.update(status='unknown',error='原模型子请求暂不可核实；已保留编号，不会重复提交。',error_phase='query')
    elif states and all(state=='succeeded' for state in states):record['status']='succeeded'
    elif any(state in ('queued','running') for state in states):record['status']='running'
    elif any(state=='archiving' for state in states):
        record.update(status='archiving',error='模型结果等待子任务账本完成本地转存；不会重新提交。',error_phase='result_storage')
    elif states and all(state in ('succeeded','failed') for state in states):
        reason=next((child.get('error') for child in record.get('children',[]) if child.get('error')),'模型子任务执行失败。')
        record.update(status='failed',error='RH 模型任务执行失败：'+reason,error_phase='execution')
    else:
        record.update(status='unknown',error='原模型子任务状态无法核实，不会重复提交。',error_phase='query')
    return record

async def query(key):
    async with LOCK:
        record=read(key)
        planned_model=record['request']['kind']=='model' and any(child.get('request_id') for child in record.get('children',[]))
        if record['status'] in ('succeeded','failed') or (not record['task_id'] and not planned_model):return record
        try:
            if record.get('base_url') and str(core.runninghub_provider().get('base_url','')).rstrip('/')!=record['base_url']:
                record['error']='RH 渠道地址已改变，请恢复提交时的地址后查询原任务。';save(record);return record
            if record['request']['kind']=='model':
                await query_model(record);save(record);return record
            api_key=core.runninghub_api_key(core.runninghub_provider(),use_wallet=bool(record['request']['payload'].get('useWallet')))
            data=(await core.runninghub_query(record['task_id'],bool(record['request']['payload'].get('useWallet'))))['data']
            record['status']={'SUCCESS':'succeeded','FAILED':'failed','RUNNING':'running','QUEUED':'queued'}.get(data.get('status'),'unknown')
            record.update(error='',error_phase='',error_code='')
            if record['status'] in ('failed','unknown'):
                reason=safe_reason(data.get('failReason') or data.get('errorMessage'),(api_key,))
                record.update(error=('RH 任务执行失败' if record['status']=='failed' else 'RH 任务状态待核实')+('：'+reason if reason else '，请查询原任务。'),error_phase='execution' if record['status']=='failed' else 'query',error_code=str(data.get('code') or data.get('errorCode') or '')[:80])
            if record['status']=='succeeded':
                record['outputs']=data.get('image_items') or [{'url':url} for url in data.get('urls',[])]
                if not record['outputs']:record.update(status='failed',error='RH 未返回可用结果。',error_phase='result')
                elif any(str(item.get('url','')).startswith('http') for item in record['outputs']):
                    record.update(status='archiving',error='结果已生成，本地转存尚未成功；继续查询将重试转存。',error_phase='result_storage')
        except HTTPException as error:
            reason=safe_reason(error.detail,(locals().get('api_key',''),))
            record.update(error='RH 任务查询失败'+('：'+reason if reason else '；任务编号已保存，可稍后继续查询。'),error_phase='query',error_code=error_code(error.detail) or str(error.status_code))
        except Exception:
            record.update(error='暂时无法查询 RH；任务编号已保存，可稍后继续查询。',error_phase='query',error_code='')
        save(record);return record

def install(app):
    @app.get('/api/studio/runninghub/catalog')
    def catalog():
        provider=core.runninghub_provider()
        return {'apps':provider.get('rh_apps',[]),'workflows':provider.get('rh_workflows',[]),'reference_library':'skipped_by_user'}

    @app.post('/api/studio/runninghub/import')
    async def import_entry(payload:Import):
        matches=re.findall(r'\d{6,}',payload.source)
        if not matches:raise HTTPException(400,'链接中没有应用或工作流 ID')
        key=matches[-1]
        info=await (core.runninghub_app_info(key) if payload.kind=='app' else core.runninghub_workflow_info(key))
        data=info.get('data') or {};fields=data.get('nodeInfoList') or data.get('fields') or []
        if not isinstance(fields,list):raise HTTPException(502,'RH 未返回可配置字段')
        revision=hashlib.sha256(json.dumps(fields,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        entry={'id':key,'webappId':key if payload.kind=='app' else '', 'workflowId':key if payload.kind=='workflow' else '',
               'name':payload.name or data.get('webappName') or data.get('name') or 'RH '+key,'enabled':True,'fields':fields,
               'raw':{'source_url':payload.source,'revision':revision},'updatedAt':int(time.time())}
        entry=core.normalize_runninghub_entry(entry,payload.kind)
        async with LOCK:
            providers=core.load_api_providers();provider=next((p for p in providers if p['id']=='runninghub'),None)
            if not provider:raise HTTPException(400,'请先在 API 设置配置 RunningHub')
            field='rh_apps' if payload.kind=='app' else 'rh_workflows'
            provider[field]=[p for p in provider.get(field,[]) if core.runninghub_entry_id(p,payload.kind)!=key]+[entry]
            core.save_api_providers(providers)
        return {'entry':entry,'kind':payload.kind}

    @app.post('/api/studio/runninghub/tasks')
    async def create(payload:Submit):return await submit(payload)

    @app.get('/api/studio/runninghub/tasks')
    def tasks(canvas_id:str=''):
        records=[read(p.stem) for p in directory().glob('*.json')]
        return {'tasks':[r for r in records if not canvas_id or r['request']['canvas_id']==canvas_id]}

    @app.get('/api/studio/runninghub/tasks/{key}')
    async def task(key:str):return await query(key)
