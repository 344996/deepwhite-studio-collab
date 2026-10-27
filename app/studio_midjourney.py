"""DeepWhite's action-specific MJ protocol, independent of the original APIMart adapter."""
import asyncio
import json
import hashlib
import uuid
import re
from pathlib import Path
from urllib.parse import urlsplit, quote

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field
import main as core
import studio_catalog as catalog

# Fields follow DeepWhite /docs/llms.txt and T8's MIDJOURNEY_ACTION_SPECS.
COMMON = ['speed']
SPECS = {
    'imagine': ('文生图', ['prompt'], ['prompt','image_urls','size','version','speed','stylize','chaos','weird','niji'], 'image'),
    'blend': ('多图融合', ['image_urls'], ['image_urls','dimensions','speed'], 'image'),
    'describe': ('图片描述', ['image_urls'], ['image_urls','speed'], 'text'),
    'edits': ('图片编辑', ['prompt','image_urls'], ['prompt','image_urls','speed'], 'image'),
    'upscale': ('放大选图', ['task_id'], ['task_id','index','custom_id','speed'], 'image'),
    'variation': ('生成变体', ['task_id'], ['task_id','index','custom_id','speed'], 'image'),
    'high-variation': ('大幅变体', ['task_id'], ['task_id','index','custom_id','speed'], 'image'),
    'low-variation': ('微调变体', ['task_id'], ['task_id','index','custom_id','speed'], 'image'),
    'reroll': ('重新生成', ['task_id'], ['task_id','custom_id','speed'], 'image'),
    'zoom': ('缩放扩展', ['task_id'], ['task_id','index','custom_id','zoom_ratio','speed'], 'image'),
    'pan': ('平移扩展', ['task_id'], ['task_id','index','custom_id','direction','speed'], 'image'),
    'inpaint': ('局部重绘：选区准备', ['task_id'], ['task_id','index','custom_id','speed'], 'modal'),
    'modal': ('局部重绘：提交遮罩', ['task_id','prompt','mask_url'], ['task_id','prompt','mask_url','speed'], 'image'),
    'video': ('图片生成视频', [], ['prompt','image_urls','task_id','index','video_type','animate_mode','motion','batch_size','end_url'], 'video'),
    'remix-strong': ('强重塑', ['task_id','index'], ['task_id','index','prompt','speed'], 'image'),
    'remix-subtle': ('弱重塑', ['task_id','index'], ['task_id','index','prompt','speed'], 'image'),
}


class Submission(BaseModel):
    provider_id: str
    action: str
    params: dict = Field(default_factory=dict)
    canvas_id: str = ''
    node_id: str = ''
    attempt_id: str = ''


def require_action(provider_id, action):
    if action not in SPECS:
        raise HTTPException(400,'不支持的 MJ 操作。')
    provider = core.get_api_provider(provider_id)
    if not provider.get('enabled',True):
        raise HTTPException(400,'该 API 平台已停用。')
    current=catalog.load_store().get(provider_id,{})
    if current.get('base_url','').rstrip('/') != provider.get('base_url','').rstrip('/'):
        raise HTTPException(400,'请先同步当前 API 平台的模型。')
    item=next((e for e in current.get('models',[]) if e['id']=='midjourney-'+action),None)
    if not item or not catalog.active(item):
        raise HTTPException(400,'此 MJ 功能尚未启用，请在设置中同步或启用。')
    return provider


def validated(action, params):
    if action not in SPECS: raise HTTPException(400,'未知 MJ 操作。')
    _, required, allowed, _ = SPECS[action]
    unknown=set(params)-set(allowed)
    if unknown: raise HTTPException(400,'当前 MJ 功能不接受这些参数：'+', '.join(sorted(unknown)))
    data={k:v for k,v in params.items() if v is not None and v != ''}
    if action=='imagine': data.setdefault('version','8.2')
    if any(not data.get(key) for key in required):
        raise HTTPException(400,'请补齐此功能的必填项：'+', '.join(required))
    for key in ('prompt','task_id','custom_id','mask_url','end_url'):
        if key in data and not isinstance(data[key],str): raise HTTPException(400,'参数格式不正确：'+key)
    if 'task_id' in data and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:\-]{0,255}',data['task_id']):
        raise HTTPException(400,'MJ 任务编号格式不正确。')
    refs=data.get('image_urls',[])
    if not isinstance(refs,list) or any(not isinstance(v,str) for v in refs):
        raise HTTPException(400,'请提供图片列表。')
    if action=='blend' and not 2<=len(refs)<=4: raise HTTPException(400,'多图融合需要 2–4 张参考图。')
    if action=='describe' and len(refs)!=1: raise HTTPException(400,'图片描述每次需要 1 张参考图。')
    if len(refs)>4: raise HTTPException(400,'此 MJ 功能最多支持 4 张参考图。')
    if action in ('upscale','variation','high-variation','low-variation') and not (data.get('index') or data.get('custom_id')):
        raise HTTPException(400,'请选择第 1–4 张图片，或提供任务返回的按钮编号。')
    if action=='pan' and not (data.get('direction') or data.get('custom_id')): raise HTTPException(400,'请选择平移方向。')
    if action=='video' and not (refs or data.get('task_id')): raise HTTPException(400,'请选择参考图或来源 MJ 任务。')
    if 'index' in data and (isinstance(data['index'],bool) or data['index'] not in ((0,1,2,3) if action=='video' else (1,2,3,4))): raise HTTPException(400,'选图编号超出范围。')
    enums={'speed':['relax','fast','turbo'],'direction':['left','right','up','down'],
           'version':['8.2','8.1','7','6.1','5.2','5.1'], 'motion':['low','high'],
           'video_type':['vid_1.1_i2v_480','vid_1.1_i2v_720','vid_1.1_i2v_start_end_480','vid_1.1_i2v_start_end_720'], 'animate_mode':['auto','manual'], 'dimensions':['SQUARE','PORTRAIT','LANDSCAPE']}
    for key,values in enums.items():
        if key in data and data[key] not in values: raise HTTPException(400,'参数值不支持：'+key)
    if action=='video':
        if bool(refs)==bool(data.get('task_id')): raise HTTPException(400,'视频请在首帧图片与来源任务中二选一。')
        if refs and (len(refs)!=1 or not data.get('prompt') or 'index' in data): raise HTTPException(400,'直接图片生成视频需要 1 张首帧和提示词，不填写选图编号。')
        if data.get('animate_mode')=='auto' and (not data.get('task_id') or 'index' not in data): raise HTTPException(400,'自动动画需要来源任务和选图编号。')
        if '_start_end_' in data.get('video_type','') and not data.get('end_url'): raise HTTPException(400,'首尾帧模式需要尾帧图片。')
        if data.get('end_url') and '_start_end_' not in data.get('video_type',''):
            data['video_type']='vid_1.1_i2v_start_end_'+('720' if '720' in data.get('video_type','') else '480')
    if 'zoom_ratio' in data and data['zoom_ratio'] not in (1.5,2): raise HTTPException(400,'扩展比例请选择 1.5 或 2。')
    if 'batch_size' in data and data['batch_size'] not in (1,2,4): raise HTTPException(400,'视频数量请选择 1、2 或 4。')
    for key in ('size',):
        if key in data and not re.fullmatch(r'[1-9]\d?:[1-9]\d?',str(data[key])): raise HTTPException(400,'请输入有效宽高比。')
    for key in ('image_urls','mask_url','end_url'):
        values=data.get(key,[]) if key=='image_urls' else [data[key]] if key in data else []
        converted=[]
        for value in values:
            # Keep local inputs local until the explicit user generation action.
            if value.startswith(('/output/','/assets/','/api/storage-files/')):
                value=core.reference_to_data_url({'url':value})
            if not value.startswith(('https://','http://','data:image/')):
                raise HTTPException(400,'图片地址无效，请上传图片或使用可访问的图片网址。')
            converted.append(value)
        if values: data[key]=converted if key=='image_urls' else converted[0]
    return data


def normalize(raw, action=''):
    containers=[]
    def walk(value,depth=0):
        if depth>8: return
        if isinstance(value,list):
            for item in value: walk(item,depth+1)
        elif isinstance(value,dict):
            containers.append(value)
            for key in ('data','result','task','output'): walk(value.get(key),depth+1)
    walk(raw)
    def first(keys):
        return next((c[k] for c in containers for k in keys if c.get(k) is not None and c[k]!=''),None)
    task_id=str(first(['task_id']) or first(['id']) or '')
    status=str(first(['status']) or '').upper()
    images=[];videos=[]
    for c in containers:
        for dest,keys in [(images,['images','image_urls','imageUrls','image_url','imageUrl','grid_image_url','gridImageUrl']),
                          (videos,['videos','video_urls','videoUrls','video_url','videoUrl'])]:
            for key in keys:
                vals=c.get(key,[]);vals=vals if isinstance(vals,list) else [vals]
                for value in vals:
                    if isinstance(value,dict): value=value.get('url') or value.get('image_url') or value.get('video_url')
                    if isinstance(value,str) and value.startswith(('https://','http://','data:image/')) and value not in dest: dest.append(value)
    text=first(['description','text','descriptions']) or ''
    if not text and action=='describe': text=first(['prompt']) or ''
    if isinstance(text,list): text='\n\n'.join(str(t) for t in text)
    status=('succeeded' if status in ('SUCCESS','SUCCEEDED','COMPLETED','COMPLETE') else 'failed' if status in ('FAILURE','FAILED','ERROR','CANCEL','CANCELLED','CANCELED')
            else 'modal' if status=='MODAL' else 'succeeded' if not task_id and (images or videos or text) else 'pending')
    return {'task_id':task_id,'status':status,'images':images,'videos':videos,'text':str(text),
            'buttons':first(['buttons']) or [],'usage':first(['usage']), 'error':'MJ 任务失败，请在 API 网站查看任务详情。' if status=='failed' else ''}


async def upstream(provider_id, method, suffix, data=None, action=''):
    provider=core.get_api_provider(provider_id)
    key=core.provider_env_key_value(provider_id)
    if not key: raise HTTPException(400,'请先在设置中保存 API Key。')
    base=provider['base_url'].rstrip('/')
    if not base.endswith('/v1'): base+='/v1'
    try:
        async with httpx.AsyncClient(timeout=90,follow_redirects=False) as client:
            response=await client.request(method,base+'/midjourney/'+suffix,
                headers={'Authorization':'Bearer '+key},**({'json':data} if data is not None else {}))
            if not 200<=response.status_code<300:
                raise HTTPException(502,f'MJ 接口返回 HTTP {response.status_code}，请检查余额、权限及输入参数。')
            result=normalize(response.json(), action)
            # Never reflect upstream credentials even if an upstream error echoes its request.
            return json.loads(json.dumps(result,ensure_ascii=False).replace(key,'[redacted]'))
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502,'MJ 网络响应异常。若已提交，请查询任务记录，避免重复提交。')


def registry_path(): return Path(core.DATA_DIR)/'studio_mj_tasks.json'


def remember(provider_id, result, action):
    if not result['task_id']: return
    path=registry_path();store=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    store[provider_id+'|'+result['task_id']]={'base_url':core.get_api_provider(provider_id)['base_url'],'action':action}
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(store),encoding='utf-8');temp.replace(path)


def task_record(provider_id, task_id):
    from studio_mj_history import items
    base=core.get_api_provider(provider_id)['base_url']
    return next((r for r in items() if task_id in r.get('task_ids',[])
                 and r['request']['provider_id']==provider_id and r['base_url']==base),None)


def require_task_scope(provider_id, task_id):
    """Known tasks keep their original channel; unknown manually supplied IDs remain supported."""
    path=registry_path();store=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    previous=store.get(provider_id+'|'+task_id)
    if previous and previous['base_url']!=core.get_api_provider(provider_id)['base_url']:
        raise HTTPException(400,'任务所属 API 地址已修改，请恢复原平台地址后查询。')
    if not previous and any(key.endswith('|'+task_id) for key in store):
        raise HTTPException(400,'此 MJ 任务属于其他 API 平台，请使用创建任务时的平台。')
    from studio_mj_history import items
    known=[r for r in items() if task_id in r.get('task_ids',[])]
    own=next((r for r in known if r['request']['provider_id']==provider_id),None)
    if own and own['base_url']!=core.get_api_provider(provider_id)['base_url']:
        raise HTTPException(400,'任务所属 API 地址已修改，请恢复原平台地址后查询。')
    if known and not own and not previous:
        raise HTTPException(400,'此 MJ 任务属于其他 API 平台，请使用创建任务时的平台。')
    if not previous and own:previous={'base_url':own['base_url'],'action':own['request']['model'].replace('midjourney-','',1)}
    return previous


def save_result(record, result):
    from studio_mj_history import update
    record['remote_status']=result.get('remote_status',result['status'])
    record['media_status']=result.get('media_status','not_required')
    update(record,result)


async def archive_result(result, record=None):
    """Save the remote receipt before downloading. A failed archive remains recoverable."""
    result=dict(result)
    result['remote_status']=result['status']
    result['media_status']='not_required'
    if record:
        result['history_id']=record['id']
        record['remote_result']=dict(result)
    has_media=bool(result.get('images') or result.get('videos'))
    if result['status']=='succeeded' and has_media:
        waiting={**result,'status':'paused','images':[],'videos':[],
                 'media_status':'pending','error':'MJ 已完成，正在保存结果；可以查询原任务继续恢复。'}
        if record:save_result(record,waiting)
        try:
            await persist_result(result,record['request'] if record else {})
            result['media_status']='completed'
        except Exception:
            # Do not advertise remote URLs as locally archived assets, or discard the receipt.
            result={**waiting,'media_status':'failed',
                    'error':'MJ 已完成，但结果保存失败。请查询原任务重试保存，勿重复生成。'}
    if record:save_result(record,result)
    return result


ATTEMPT_ID=re.compile(r'[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}')


def checked_attempt(attempt_id):
    if attempt_id and not ATTEMPT_ID.fullmatch(attempt_id): raise HTTPException(400,'提交编号格式不正确。')
    return attempt_id


def attempt_status(attempt_id):
    """What the server knows about one page attempt; a reloaded page asks this instead of guessing."""
    from studio_mj_history import find_attempt
    record=find_attempt(checked_attempt(attempt_id))
    if not record:return {'found':False}
    return {'found':True,'history_id':record['id'],'task_id':(record.get('task_ids') or [''])[0],
            'status':record['status'],'error':record.get('error',''),
            'canvas_id':record['request']['canvas_id'],'node_id':record['request']['node_id']}


async def submit(request):
    from studio_mj_history import begin, find_attempt
    previous=find_attempt(checked_attempt(request.attempt_id))
    # A known attempt is already paid for or pending: report the original task, never POST again.
    if previous:return {**await resume_history(previous['id']),'history_id':previous['id']}
    require_action(request.provider_id,request.action)
    params=validated(request.action,request.params)
    if params.get('task_id'):require_task_scope(request.provider_id,params['task_id'])
    record=begin(request,params)
    try:
        result=await upstream(request.provider_id,'POST','generations/'+request.action,params,request.action)
        if not result['task_id'] and result['status']=='pending': raise HTTPException(502,'MJ 未返回任务编号或结果，请先检查平台任务记录。')
        # The per-attempt receipt is authoritative; the registry is only a query index.
        record['remote_result']=dict(result)
        receipt={**result,'remote_status':result['status']}
        if result['status']=='succeeded' and (result.get('images') or result.get('videos')):
            receipt.update(status='paused',images=[],videos=[],media_status='pending',error='MJ 已完成，正在保存结果。')
        save_result(record,receipt)
        try:
            remember(request.provider_id,result,request.action)
        except Exception:
            from studio_mj_history import save
            record['registry_error']='任务查询索引保存失败，原任务编号已保存在历史记录。'
            save(record)
        return await archive_result(result,record)
    except Exception:
        save_result(record,{'status':'uncertain','error':'提交结果待核对，请先查看平台记录，勿重复提交。'})
        raise


async def poll(provider_id, task_id):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:\-]{0,255}',task_id): raise HTTPException(400,'任务编号格式不正确。')
    previous=require_task_scope(provider_id,task_id)
    record=task_record(provider_id,task_id)
    if record and record.get('remote_result',{}).get('status')=='succeeded' and record.get('media_status') in ('pending','failed'):
        return await archive_result(record['remote_result'],record)
    try:
        result=await upstream(provider_id,'GET','tasks/'+quote(task_id,safe=''),action=(previous or {}).get('action',''))
        result['task_id']=task_id
    except Exception:
        result={'task_id':task_id,'status':'paused','remote_status':(record or {}).get('remote_status','pending'),
                'media_status':(record or {}).get('media_status','not_required'),
                'error':'MJ 查询失败，任务编号已保留。请继续查询原任务，勿重复生成。'}
        if record:save_result(record,result)
        raise
    return await archive_result(result,record)


async def resume_history(history_id):
    from studio_mj_history import items
    record=next((r for r in items() if r['id']==history_id),None)
    if not record:raise HTTPException(404,'MJ 任务记录不存在。')
    provider=record['request']['provider_id']
    if record['base_url']!=core.get_api_provider(provider)['base_url']:
        raise HTTPException(400,'任务所属 API 地址已修改，请恢复原平台地址后查询。')
    if record.get('task_ids'):return await poll(provider,record['task_ids'][0])
    if record.get('remote_result',{}).get('status')=='succeeded':
        return await archive_result(record['remote_result'],record)
    raise HTTPException(409,'此提交未返回任务编号，请先核对平台记录，勿重复提交。')


async def persist_result(result, context):
    """Persist MJ media before advertising success; retries only fetch results."""
    if result.get('status') != 'succeeded':
        return
    from studio_generation import persist_media
    from studio_asset_integration import register_output
    result['asset_refs']=[]
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        for field,kind in [('images','image'),('videos','video')]:
            local=[]
            for url in result.get(field,[]):
                key='mjasset_'+hashlib.sha256(url.encode()).hexdigest()[:32]
                cache=Path(core.DATA_DIR)/'studio_mj_media'
                cache.mkdir(parents=True,exist_ok=True)
                manifest=cache/(key+'.json')
                stored=json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else None
                if stored and core.output_file_from_url(stored.get('url','')):
                    item=register_output(core,stored['url'],request=context,job_id=key)
                    stored.update(url=item['url'],asset_id=item['asset_id'],version_id=item['version_id'])
                elif core.output_file_from_url(url):
                    item=register_output(core,url,request=context,job_id=key)
                    stored={'url':item['url'],'asset_id':item['asset_id'],'version_id':item['version_id']}
                else:
                    stored=await persist_media(client,url,kind,key+'_'+uuid.uuid4().hex[:8],'0',request=context)
                    temp=manifest.with_suffix('.'+uuid.uuid4().hex+'.tmp')
                    temp.write_text(json.dumps(stored),encoding='utf-8');temp.replace(manifest)
                local.append(stored['url']);result['asset_refs'].append(stored)
            result[field]=local


def install(app):
    @app.get('/api/studio/mj/actions')
    async def actions():
        return {action:{'label':s[0],'required':s[1],'fields':s[2],'result':s[3]} for action,s in SPECS.items()}

    @app.post('/api/studio/mj/submit')
    async def submit_route(request:Submission): return await submit(request)

    @app.get('/api/studio/mj/tasks/{task_id}')
    async def poll_route(task_id:str,provider_id:str): return await poll(provider_id,task_id)

    @app.post('/api/studio/mj/history/{history_id}/resume')
    async def resume_history_route(history_id:str):return await resume_history(history_id)

    @app.get('/api/studio/mj/attempts/{attempt_id}')
    async def attempt_route(attempt_id:str):return attempt_status(attempt_id)

    original=core.generate_ai_image
    async def generate(prompt,size,quality,model,reference_images=None,provider_id='comfly',aspect_ratio='',resolution=''):
        if model!='midjourney-imagine':
            return await original(prompt,size,quality,model,reference_images,provider_id,aspect_ratio,resolution)
        refs=[core.reference_to_data_url(r) for r in reference_images or []]
        result=await submit(Submission(provider_id=provider_id,action='imagine',params={
            'prompt':prompt,'image_urls':refs,'size':aspect_ratio or '1:1','speed':'relax','version':'8.2'}))
        task_id=result['task_id']
        for _ in range(450):
            if result['status'] in ('succeeded','failed','modal','paused','uncertain') or not task_id: break
            await asyncio.sleep(4)
            result=await poll(provider_id,task_id)
        if result['status']!='succeeded' or not result['images']:
            reference=task_id or result.get('history_id','')
            raise HTTPException(502,(result.get('error') or 'MJ 尚未完成或未返回图片，请继续查询原任务。')+(' 任务记录：'+reference if reference else ' 请核对平台记录，勿重复生成。'))
        return result['images'][0],{'data':[{'url':url} for url in result['images']], 'task_id':task_id,'usage':result['usage']}
    core.generate_ai_image=generate
