"""Stage-one generation: durable jobs, one submit per child, GET-only recovery.

Contracts: DeepWhite llms.txt and the authorized T8 provider reference.
Credentials are looked up at execution time and never written into job records.
"""
import asyncio
import hashlib
import json
import mimetypes
import os
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit, quote

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field
import main as core
import studio_catalog as catalog
import studio_comfy
from studio_capabilities import profile, parameters

TERMINAL={'succeeded','failed','uncertain'}
WORKERS={}
POLL_SECONDS=4


class Generation(BaseModel):
    request_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{8,80}$')
    canvas_id: str = ''
    node_id: str = ''
    provider_id: str
    model: str
    kind: str = Field(pattern=r'^(chat|image|video|audio)$')
    prompt: str = Field(default='',max_length=100000)
    system_prompt: str = Field(default='',max_length=50000)
    skill_ids: list[str] = Field(default_factory=list,max_length=3)
    messages: list[dict] = Field(default_factory=list,max_length=50)
    params: dict = Field(default_factory=dict)
    references: list[dict] = Field(default_factory=list,max_length=50)
    count: int = Field(default=1,ge=1,le=8)
    multimodal: bool = True
    frame_mode: bool = False


def directory():
    p=Path(core.DATA_DIR)/'studio_jobs';p.mkdir(parents=True,exist_ok=True);return p


def read(job_id):
    if not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}',job_id): raise HTTPException(404,'任务不存在。')
    p=directory()/f'{job_id}.json'
    if not p.exists():raise HTTPException(404,'任务不存在。')
    return json.loads(p.read_text(encoding='utf-8'))


def save(job):
    job['updated_at']=time.time()
    p=directory()/f'{job["id"]}.json';tmp=p.with_suffix('.tmp')
    tmp.write_text(json.dumps(job,ensure_ascii=False),encoding='utf-8');os.replace(tmp,p)


def connection(provider_id,expected=None):
    if provider_id.startswith('deepwhite-account-') and not core.provider_env_key_value(provider_id):
        raise HTTPException(401,'此账户的生成授权已退出或失效，请重新登录 DeepWhite API 账户后重试。')
    provider=core.get_api_provider_exact(provider_id)
    if not provider or provider.get('enabled') is False:raise HTTPException(400,'请先启用 API 平台。')
    base=provider.get('base_url','').rstrip('/')
    if urlsplit(base).hostname!='api.deepwhiteai.com':raise HTTPException(400,'第一阶段的生成适配使用 DeepWhite API，请选择已配置的平台。')
    if expected and base!=expected:raise HTTPException(400,'任务创建后 API 地址已改变，请恢复原地址后查询。')
    key=core.provider_env_key_value(provider_id)
    if not key:raise HTTPException(400,'请先在 API 设置中保存密钥。')
    return base if base.endswith('/v1') else base+'/v1', {'Authorization':'Bearer '+key},base


def clean_error(value,job=None):
    text=str(value or '')
    if job:
        key=core.provider_env_key_value(job['request']['provider_id'])
        if key:text=text.replace(key,'[已隐藏]')
    text=re.sub(r'(?i)bearer\s+[^\s,;"\']+','Bearer [已隐藏]',text)
    text=re.sub(r'\bsk-[\w-]+','[已隐藏]',text)
    text=re.sub(r'(?i)((?:api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+',r'\1[已隐藏]',text)
    text=re.sub(r'https?://\S+','[链接已省略]',text)
    return text[:800]


def response_error(response):
    """Extract only diagnostic fields, never echo an entire upstream response/request."""
    try:data=response.json()
    except ValueError:return ''
    def extract(value):
        if isinstance(value,str):return value
        if isinstance(value,dict):
            for key in ('message','detail','error','msg','fail_reason'):
                result=extract(value.get(key))
                if result:return result
        if isinstance(value,list):return '; '.join(filter(None,(extract(v) for v in value[:3])))
        return ''
    return extract(data)


def message(exc,job=None):
    if isinstance(exc,HTTPException):return str(exc.detail)
    if isinstance(exc,httpx.HTTPStatusError):
        status=exc.response.status_code
        base={401:'API 密钥无效或已过期。',403:'账号无权调用此模型。',402:'API 额度不足。',429:'平台繁忙或达到调用频率限制，请稍后手动重试。'}.get(status,f'API 返回 {status}。')
        detail=clean_error(response_error(exc.response),job)
        return base+(' 平台说明：'+detail if detail else ' 平台未返回具体说明，请核对平台任务记录。')
    if isinstance(exc,httpx.HTTPError):return '网络连接暂时中断。'
    return '任务处理失败，请查看 API 平台任务记录。'


def safe_text(text,job):
    return clean_error(text,job)


def seedance_prompt(prompt,refs):
    """Stable UI labels bind to media; protocol indices follow the current per-kind order."""
    counts={'image':0,'video':0,'audio':0};labels={}
    names={'image':('图片','Image'),'video':('视频','Video'),'audio':('音频','Audio')}
    for ref in refs:
        kind=ref['kind'];counts[kind]+=1
        chinese,english=names[kind];label=ref.get('mention') or f'@{chinese}{counts[kind]}'
        if not re.fullmatch('@'+chinese+r'[1-9]\d*',label) or label in labels:raise HTTPException(400,'素材引用标记有重复或类型不匹配，请重新选择 @ 素材。')
        labels[label]=f'@{english} {counts[kind]}'
    def convert(match):
        label='@'+match[1]+match[2]
        if label not in labels:raise HTTPException(400,f'{label} 对应的素材已移除或未添加，请重新选择 @ 素材。')
        return labels[label]
    # Validate user-written protocol tokens before converting bound UI labels.
    for match in re.finditer(r'@(Image|Video|Audio)\s*(\d+)',prompt,re.I):
        if not 1<=int(match[2])<=counts[match[1].lower()]:raise HTTPException(400,f'{match[0]} 没有对应素材，请重新选择 @ 素材。')
    return re.sub(r'@(图片|视频|音频)\s*(\d+)',convert,prompt)


def checked(payload):
    if payload.provider_id==studio_comfy.PROVIDER:return studio_comfy.checked(payload)
    import studio_dreamina
    if payload.provider_id==studio_dreamina.PROVIDER:return studio_dreamina.checked(payload)
    _,_,base=connection(payload.provider_id)
    refs=[dict(r) for r in payload.references if r.get('url')]
    for r in refs:
        if r.get('kind','image') not in ('image','video','audio'):raise HTTPException(400,'参考素材类型不支持。')
        r.setdefault('kind','image')
    images=[r for r in refs if r['kind']=='image'];videos=[r for r in refs if r['kind']=='video'];audios=[r for r in refs if r['kind']=='audio']
    if payload.frame_mode:
        if payload.kind!='video' or videos or audios or not 1<=len(images)<=2:raise HTTPException(400,'首尾帧模式请提供 1–2 张图片，不接受视频或音频。')
        # User ordering is preserved. Explicit roles override it and must be unique.
        roles=[r.get('role') for r in images]
        if roles.count('first_frame')>1 or roles.count('last_frame')>1:raise HTTPException(400,'首帧和尾帧各只能有一张。')
        images.sort(key=lambda r:0 if r.get('role')=='first_frame' else 2 if r.get('role')=='last_frame' else 1)
        if len(images)==1 and images[0].get('role')=='last_frame':raise HTTPException(400,'请先添加首帧。')
        for i,r in enumerate(images):r['role']='first_frame' if i==0 else 'last_frame'
        refs=images
    if payload.kind=='audio' and (refs or payload.frame_mode):raise HTTPException(400,'音频生成暂不支持参考素材。')
    if payload.kind=='audio' and payload.model=='suno-sounds':
        saved=catalog.load_store().get(payload.provider_id,{})
        known={item['id'] for item in saved.get('models',[]) if item.get('kind')=='audio' and catalog.active(item)}
        configured=next((m for m in ('suno','suno-music') if m in known),None)
        if configured:catalog.resolve_model(payload.provider_id,configured,'audio',images,videos,audios,False if payload.frame_mode else payload.multimodal)
        elif saved:raise HTTPException(400,'请先在模型目录中启用 Suno 音乐模型。')
        raw='suno-sounds'
    else:
        raw=catalog.resolve_model(payload.provider_id,payload.model,payload.kind,images,videos,audios,False if payload.frame_mode else payload.multimodal)
    spec=profile(raw,payload.kind)
    params=parameters(raw,payload.kind,payload.params)
    if payload.kind=='audio' and payload.params.get('channel') not in ('',None,spec['channel']):raise HTTPException(400,'所选音频模型不属于当前生成频道。')
    if payload.kind=='audio' and raw in ('mureka-v8-bgm','mureka-v9-bgm'):
        if bool(payload.prompt.strip())==bool(params.get('instrumental_id')):raise HTTPException(400,'Mureka 伴奏请填写音乐描述或伴奏模板 ID，两者只能填写一项。')
    elif payload.kind=='audio' and raw.startswith('qwen3-tts-') and not params.get('voice'):
        raise HTTPException(400,'请填写 Qwen3 TTS 音色 ID。')
    elif payload.kind=='audio' and raw.startswith('minimax-speech-2.8-') and not params.get('voice_id'):
        raise HTTPException(400,'请填写 MiniMax Speech 音色 ID。')
    elif not payload.prompt.strip():raise HTTPException(400,'请先填写提示词。')
    if not spec['prompt_min']<=len(payload.prompt.strip())<=spec['prompt_max']:raise HTTPException(400,f'此模型提示词需要 {spec["prompt_min"]}–{spec["prompt_max"]} 个字符。')
    for label,items,limit in [('图片',images,spec['max_images']),('视频',videos,spec['max_videos']),('音频',audios,spec['max_audios'])]:
        if len(items)>limit:raise HTTPException(400,f'此模型最多支持 {limit} 个{label}参考素材。')
    mode=catalog.family_and_mode(raw)[1]
    if payload.kind=='video':
        if raw.startswith('deepwhiteai-video-g-omni') and 'lowprice' in raw:
            if len(images) not in (0,1,3) or (videos and images):raise HTTPException(400,'此型号请使用 1 或 3 张参考图，或单个视频；不能混合。')
            if payload.frame_mode and len(images)!=1:raise HTTPException(400,'此型号首帧模式只支持一张图片。')
        if mode=='i2v' and (not 1<=len(images)<=2 or videos or audios):raise HTTPException(400,'此型号的首尾帧生成需要 1–2 张图片。')
        if mode in ('multi','r2v') and not refs:raise HTTPException(400,'此型号至少需要一个参考素材。')
        if mode=='t2v' and refs:raise HTTPException(400,'此型号只接受文字输入。')
    for r in refs:
        url=r['url']
        if url.startswith('/'):
            path=core.output_file_from_url(url)
            if not path or not Path(path).is_file():raise HTTPException(400,'参考素材已丢失，请重新上传。')
            limit=30 if r['kind']=='image' else 15 if r['kind']=='audio' and raw.startswith('seedance-2.0-fast') and 'global' not in raw else 50
            if Path(path).stat().st_size>limit*1024*1024:raise HTTPException(400,f'此模型的单个{r["kind"]}素材不能超过 {limit} MB。')
        elif urlsplit(url).scheme not in ('http','https'):raise HTTPException(400,'参考素材请上传文件或使用公开的 HTTP 链接。')
    data=payload.model_dump();data['references']=refs;data['params']=params
    if payload.skill_ids:
        if payload.kind != 'chat': raise HTTPException(400,'技能目前用于文本节点。')
        from studio_skills import instructions
        data['system_prompt'] = '\n\n'.join(filter(None,[payload.system_prompt,instructions(payload.skill_ids)]))
        if len(data['system_prompt'])>50000: raise HTTPException(400,'系统指令与技能合计过长，请减少所选技能。')
    if payload.kind=='video' and raw.startswith('seedance'):
        data['input_prompt']=payload.prompt
        data['prompt']=seedance_prompt(payload.prompt,refs)
    return data,raw,base


async def upload(client,base,headers,ref):
    url=ref['url']
    if not url.startswith('/'):return url
    path=Path(core.output_file_from_url(url));size=path.stat().st_size
    if size>50*1024*1024:raise HTTPException(400,'单个参考文件不能超过 50 MB。')
    cache_key=hashlib.sha256(f'{base}|{headers["Authorization"]}|{path}|{size}|{path.stat().st_mtime_ns}'.encode()).hexdigest()
    cp=directory()/f'upload-{cache_key}.cache'
    if cp.exists():
        cached=json.loads(cp.read_text());
        if cached['expires']>time.time():return cached['url']
    with path.open('rb') as stream:
        r=await client.post(base+'/files/upload',headers=headers,files={'file':(path.name,stream,mimetypes.guess_type(path.name)[0] or 'application/octet-stream')})
    r.raise_for_status();data=r.json();data=data.get('data',data);remote=data.get('url')
    if not remote:raise HTTPException(502,'参考文件上传未返回地址，请稍后再试。')
    cp.write_text(json.dumps({'url':remote,'expires':time.time()+min(int(data.get('expires_in',86400)),86400)-600}))
    return remote


def media_body(model,kind,prompt,params,refs,frame_mode=False):
    """Pure body builder: kept separate so mock tests assert exact wire contracts."""
    imgs=[r['url'] for r in refs if r['kind']=='image'];vids=[r['url'] for r in refs if r['kind']=='video'];auds=[r['url'] for r in refs if r['kind']=='audio']
    body={'model':model,'prompt':prompt};meta=dict(params)
    if kind=='image':
        if 'image-g-v2.5-' in model:
            body.update(meta);body['size']=body.pop('ratio','1:1');body['n']=1;meta={}
        elif any(s in model for s in ('image-nb','image-g-v2-lowprice','image-gk')):
            body['size']=meta.pop('ratio','1:1');body['n']=1
        if imgs:body['images']=imgs
    else:
        if 'duration' in meta:body['seconds']=str(meta.pop('duration'))
        if model.startswith('seedance') and '-multi' in model:
            meta['content']=[{'type':r['kind']+'_url',r['kind']+'_url':{'url':r['url']}} for r in refs]
        else:
            if imgs:body['images']=imgs
            if vids:meta['video_url']=vids[0] if model.startswith(('flux-3','deepwhiteai-video-g-omni')) else vids
            if auds:meta['audio_url']=auds
        if model.startswith('deepwhiteai-video-g-omni') and 'lowprice' in model:
            body['resolution']=meta.pop('resolution');body['aspect_ratio']=meta.pop('ratio')
            if imgs:body['generation_type']='frame' if frame_mode else 'reference'
            if vids:body.pop('seconds',None)
    if meta:body['metadata']=meta
    return body


def audio_body(model,prompt,params):
    """Build only the explicitly documented DeepWhite speech/music/sound requests."""
    values={k:v for k,v in params.items() if k!='channel' and v not in ('',None)}
    if model in ('suno','suno-music'):
        body={'model':'suno','prompt':prompt};body.update(values)
        return '/music/generations',body
    if model=='suno-sounds':
        return '/music/generations/sounds',{'model':'suno','prompt':prompt}
    meta={}
    if model.startswith('qwen3-tts-'):
        meta={k:v for k,v in values.items() if k in ('voice','instructions')}
    elif model.startswith('minimax-speech-2.8-'):
        meta={k:v for k,v in values.items() if k=='voice_id'}
    elif model in ('mureka-v8-bgm','mureka-v9-bgm'):
        meta={k:v for k,v in values.items() if k in ('n','instrumental_id')}
    else:
        raise HTTPException(400,'此音频模型没有已核对的 DeepWhite API 适配。')
    body={'model':model}
    if prompt:body['prompt']=prompt
    if meta:body['metadata']=meta
    return '/audio/generations',body


def normalize(data,kind):
    record=data.get('data',data)
    if not isinstance(record,dict):record=data
    status=str(record.get('status') or data.get('status') or '').lower()
    state='succeeded' if status in ('success','succeeded','completed') else 'failed' if status in ('fail','failure','failed','error','cancelled','canceled') else 'running'
    urls=[]
    def collect(obj):
        if isinstance(obj,dict):
            for key,value in obj.items():
                if key in ('result_url','image_url','image_urls','video_url','video_urls','audio_url','audio_urls','url','urls'):
                    values=value if isinstance(value,list) else [value]
                    for item in values:
                        if isinstance(item,str) and item.startswith(('https://','http://')) and item not in urls:urls.append(item)
                elif key in ('data','content','metadata','result','output','images','videos','music'):collect(value)
        elif isinstance(obj,list):
            for item in obj:collect(item)
    if state=='succeeded':collect(record)
    usage=record.get('usage') or data.get('usage')
    if not usage and isinstance(record.get('cost'),(int,float)):usage={'amount':record['cost'],'currency':'USD'}
    if not usage and isinstance(record.get('data'),dict):usage=record['data'].get('usage')
    progress=record.get('progress',data.get('progress',0))
    return {'status':state,'urls':urls,'usage':usage,'progress':progress,'error':record.get('fail_reason') or record.get('error') or record.get('message') or ''}


async def persist_media(client,url,kind,job_id,index,request=None):
    # No Authorization header is ever sent to result/CDN URLs.
    suffix='.mp4' if kind=='video' else '.mp3' if kind=='audio' else '.png'
    path=None
    async with client.stream('GET',url,follow_redirects=True) as response:
        response.raise_for_status()
        mime=response.headers.get('content-type','').split(';')[0]
        if mime and mime!='application/octet-stream' and not mime.startswith(kind+'/'):raise HTTPException(502,'平台结果不是有效的媒体文件，请查询平台任务。')
        suffix=mimetypes.guess_extension(mime) or suffix
        name=f'studio-{job_id}-{index}{suffix}';path=Path(core.output_path_for(name));path.parent.mkdir(parents=True,exist_ok=True)
        temp=path.with_suffix(path.suffix+'.part');total=0
        try:
            with temp.open('wb') as output:
                async for chunk in response.aiter_bytes():
                    total+=len(chunk)
                    if total>1024*1024*1024:raise HTTPException(502,'结果文件超过本地保存上限 1 GB。')
                    output.write(chunk)
            if not total:raise HTTPException(502,'平台返回了空文件。')
            os.replace(temp,path)
        finally:
            if temp.exists():temp.unlink()
    return persist_local_media(path,kind,job_id,index,request=request,name=name)


def persist_local_media(source,kind,job_id,index,request=None,name=None):
    """Atomically save a trusted local result and register it through the shared asset flow."""
    source=Path(source)
    allowed={'.png','.jpg','.jpeg','.webp','.bmp'} if kind=='image' else {'.mp4','.mov','.webm','.m4v'} if kind=='video' else {'.mp3','.wav','.ogg','.oga','.opus','.aac','.m4a','.mp4','.flac'}
    if kind not in ('image','video','audio') or source.suffix.lower() not in allowed or not source.is_file():
        raise HTTPException(502,'即梦结果文件缺失或格式不受支持，请继续查询原任务。')
    if source.stat().st_size<=0 or source.stat().st_size>1024*1024*1024:
        raise HTTPException(502,'结果文件为空或超过本地保存上限 1 GB。')
    name=name or f'studio-{job_id}-{index}{source.suffix.lower()}'
    path=Path(core.output_path_for(name));path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix(path.suffix+'.part')
    try:
        import shutil
        shutil.copyfile(source,temp)
        os.replace(temp,path)
    finally:
        if temp.exists():temp.unlink()
    from studio_asset_integration import register_output
    if request is None:
        try: request=read(job_id).get('request',{})
        except HTTPException: request={}
    item=register_output(core,core.output_url_for(name),name,request,job_id)
    return {'url':item['url'],'kind':kind,'name':name,'asset_id':item['asset_id'],
            'version_id':item['version_id'],'asset_url':item['url']}


async def execute(job_id):
    if read(job_id)['request']['provider_id']==studio_comfy.PROVIDER:
        return await studio_comfy.execute(job_id)
    import studio_dreamina
    if read(job_id)['request']['provider_id']==studio_dreamina.PROVIDER:
        return await studio_dreamina.execute(job_id)
    job=read(job_id);req=job['request']
    try:
        base,headers,_=connection(req['provider_id'],job['base_url'])
        async with httpx.AsyncClient(timeout=httpx.Timeout(120,connect=20),follow_redirects=False) as client:
            for child_index,child in enumerate(job['children']):
                if child['status']=='succeeded':continue
                if child['status']=='submitting' and not child.get('upstream_id'):
                    job.update(status='uncertain',error='提交结果尚不确定，请先在 API 网站核对任务与账单，避免重复扣费。');save(job);return
                if child['status']=='queued':
                    refs=[]
                    for r in req['references']:refs.append({**r,'url':await upload(client,base,headers,r)})
                    if req['kind']=='chat':
                        content=[{'type':'text','text':req['prompt']}]+[{'type':'image_url','image_url':{'url':r['url']}} for r in refs]
                        messages=([{'role':'system','content':req['system_prompt']}] if req['system_prompt'] else [])+[m for m in req['messages'] if m.get('role') in ('user','assistant')]+[{'role':'user','content':content if refs else req['prompt']}]
                        body={'model':job['resolved_model'],'messages':messages,'stream':False};endpoint='/chat/completions'
                    elif req['kind']=='audio':
                        endpoint,body=audio_body(job['resolved_model'],req['prompt'],req['params'])
                    else:
                        body=media_body(job['resolved_model'],req['kind'],req['prompt'],req['params'],refs,req['frame_mode'])
                        endpoint='/image/generations' if req['kind']=='image' else '/videos'
                    child['status']='submitting';job['status']='running';save(job)
                    core.native_before_submit()
                    try:
                        response=await client.post(base+endpoint,headers=headers,json=body)
                        # A 5xx/timeout can happen after platform acceptance. Never auto-resubmit.
                        if response.status_code>=500:raise HTTPException(502,'平台提交响应异常，需先核对任务。')
                        if response.status_code>=400:
                            child['status']='failed'
                            child['http_status']=response.status_code
                            request_id=response.headers.get('x-request-id') or response.headers.get('request-id')
                            if request_id and re.fullmatch(r'[\w.:-]{1,120}',request_id):child['platform_request_id']=request_id
                            response.raise_for_status()
                        data=response.json()
                    except Exception:
                        if child['status']=='submitting':job['status']='uncertain'
                        raise
                    if req['kind']=='chat':
                        choices=data.get('choices') if isinstance(data,dict) else None
                        chat_message=choices[0].get('message') if isinstance(choices,list) and choices and isinstance(choices[0],dict) else None
                        content=chat_message.get('content') if isinstance(chat_message,dict) else None
                        text=content if isinstance(content,str) else ''
                        if isinstance(content,list):text='\n'.join(x['text'] for x in content if isinstance(x,dict) and isinstance(x.get('text'),str))
                        text=text.strip()
                        if not text:
                            job['status']='uncertain'
                            raise HTTPException(502,'模型未返回文本，请在平台查看本次调用。')
                        child.update(status='succeeded',text=text,usage=data.get('usage'));save(job);continue
                    record=data.get('data',data)
                    if isinstance(record,list):record=record[0] if record else {}
                    task_id=record.get('id') or record.get('task_id') or data.get('id') or data.get('task_id')
                    if not task_id:
                        job['status']='uncertain';raise HTTPException(502,'平台未返回任务编号，请先核对平台任务记录。')
                    child.update(upstream_id=str(task_id),status='running');save(job)
                    native_parent_receipt(job)
                if req['kind']=='audio':
                    endpoint='/music/tasks/' if job['resolved_model'] in ('suno','suno-music','suno-sounds') else '/audio/generations/'
                else:
                    endpoint='/image/generations/' if req['kind']=='image' else '/videos/'
                try:
                    while True:
                        response=await client.get(base+endpoint+quote(child['upstream_id'],safe=''),headers=headers)
                        response.raise_for_status();result=normalize(response.json(),req['kind'])
                        child['progress']=result['progress'];save(job)
                        if result['status'] in ('failed','succeeded'):break
                        await asyncio.sleep(POLL_SECONDS)
                    if result['status']=='failed':
                        child.update(status='failed',usage=result['usage'],error=safe_text(result['error'],job) or '平台生成失败。');job.update(status='failed',error=child['error']);save(job);return
                    if not result['urls']:raise HTTPException(502,'任务已完成但没有媒体地址，请在平台核对。')
                    if req['kind']=='video':
                        child.update(remote_result=result,remote_status='succeeded');save(job)
                        native_parent_receipt(job)
                    outputs=[]
                    for i,url in enumerate(result['urls']):outputs.append(await persist_media(client,url,req['kind'],job_id,f'{child_index}-{i}'))
                    child.update(status='succeeded',outputs=outputs,usage=result['usage']);job['error']='';save(job)
                except Exception as exc:
                    # Polling/downloading failures are safely retryable by GET, never a new paid POST.
                    job.update(status='paused',error=message(exc,job)+' 可点击“继续查询”，不会重新生成。');save(job);return
            job.update(status='succeeded',error='');save(job)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        if job['status']!='uncertain':
            job['status']='paused' if req['kind']=='video' and any(c.get('upstream_id') and c['status']!='failed' for c in job['children']) else 'failed'
        job['error']=message(exc,job)
        if job['status']=='uncertain':job['error']+=' 提交结果待核实，请先在 API 网站核对任务，避免重复扣费。'
        save(job)


def start(job_id):
    if job_id in WORKERS and not WORKERS[job_id].done():return
    task=asyncio.create_task(execute(job_id));WORKERS[job_id]=task
    task.add_done_callback(lambda done:WORKERS.pop(job_id,None) if WORKERS.get(job_id) is done else None)


def public(job):
    diagnosis=''
    if job['status']=='failed' and '400' in job.get('error','') and job['resolved_model']=='deepwhiteai-image-g-v2.5-lowprice' and len(job['request']['prompt'].strip())<5:
        diagnosis='这次提示词不足 5 个字符；此模型实际要求 5–5000 个字符。请补充描述后重新生成。'
    visible={k:v for k,v in job.items() if k!='dreamina_account_binding'}
    return {**visible,'diagnosis':diagnosis,'outputs':[o for child in job['children'] for o in child.get('outputs',[])],
            'text':'\n\n'.join(child['text'] for child in job['children'] if child.get('text')),
            'task_ids':[child['upstream_id'] for child in job['children'] if child.get('upstream_id')]}


async def submit(payload):
    # UUID is the idempotency key. Save synchronously before starting any paid request.
    if (directory()/f'{payload.request_id}.json').exists():
        job=read(payload.request_id)
        if job['fingerprint']!=hashlib.sha256(payload.model_dump_json().encode()).hexdigest():raise HTTPException(409,'此提交编号已经使用，请查询原任务。')
        return public(job)
    req,raw,base=checked(payload)
    job={'id':payload.request_id,'created_at':time.time(),'status':'queued','error':'','request':req,'resolved_model':raw,'base_url':base,
         'fingerprint':hashlib.sha256(payload.model_dump_json().encode()).hexdigest(),
         'children':[{'status':'queued'} for _ in range(payload.count if payload.kind=='image' else 1)]}
    save(job);start(job['id']);return public(job)


def install(app):
    install_compatibility()
    @app.get('/api/studio/capabilities')
    async def capabilities():
        await studio_comfy.refresh_models()
        providers={}
        for pid,saved in catalog.load_store().items():
            providers[pid]={}
            for entry in saved['models']:
                spec=profile(entry['id'],entry['kind'])
                if entry['kind']=='audio':spec['catalog_enabled']=catalog.active(entry)
                providers[pid][entry['id']]=spec
        for pid,saved in catalog.load_store().items():
            if any(item.get('kind')=='audio' and item.get('id') in ('suno','suno-music') and catalog.active(item) for item in saved['models']):
                providers.setdefault(pid,{})['suno-sounds']=profile('suno-sounds','audio')
        providers[studio_comfy.PROVIDER]={studio_comfy.MODEL:studio_comfy.spec()}
        import studio_dreamina
        providers[studio_dreamina.PROVIDER]={m['id']:studio_dreamina.spec(m['id']) for m in studio_dreamina.models()}
        return {'providers':providers}

    @app.post('/api/studio/generations')
    async def create(payload:Generation):return await submit(payload)

    @app.get('/api/studio/generations')
    async def history(canvas_id:str=''):
        jobs=[]
        for path in directory().glob('*.json'):
            job=json.loads(path.read_text(encoding='utf-8'))
            if not canvas_id or job['request']['canvas_id']==canvas_id:jobs.append(public(job))
        from studio_mj_history import items as mj_items
        jobs.extend(mj_items(canvas_id))
        return {'items':sorted(jobs,key=lambda j:j['created_at'],reverse=True)}

    @app.get('/api/studio/generations/{job_id}')
    async def status(job_id:str):
        job=read(job_id)
        if job['status'] not in TERMINAL and job['status']!='paused':start(job_id)
        return public(job)


def native_child_id(kind):
    from studio_native_tasks import current_record
    record=current_record()
    if record and record['task_kind']==kind:
        return record['execution']['child_id']
    return uuid.uuid4().hex


def native_parent_receipt(job):
    """A saved child receipt is recoverable even when its parent's write fails."""
    from studio_native_tasks import current_record
    import studio_legacy_tasks as ledger
    record=current_record()
    if not record or record['task_kind']!='video':return
    if record['execution'].get('child_id')!=job['id']:raise HTTPException(409,'子任务归属不一致')
    ledger.remember_receipt('studio-generation',job['id'])
    ledger.update(record['id'],remote_status='succeeded' if any(c.get('remote_result') for c in job['children']) else 'running',
                  recovery_action='query_upstream')


def native_parent_plan(payload):
    from studio_native_tasks import current_record
    import studio_legacy_tasks as ledger
    parent=current_record()
    if not parent:return
    if parent['execution'].get('child_id')!=payload.request_id:raise HTTPException(409,'子任务计划身份不一致')
    fingerprint=hashlib.sha256(payload.model_dump_json().encode()).hexdigest()
    execution=dict(parent['execution'])
    if execution.get('child_fingerprint') and execution['child_fingerprint']!=fingerprint:
        raise HTTPException(409,'子任务固定输入不一致')
    execution['child_fingerprint']=fingerprint
    ledger.update(parent['id'],execution=execution)


async def resume_receipt_only(job_id):
    """Never call execute/start: queued/submitting children must not be submitted."""
    job=read(job_id)
    req=job['request']
    if req['kind']!='video' or len(job['children'])!=1:raise HTTPException(409,'此子任务不支持原回执查询')
    child=job['children'][0]
    if child['status']=='succeeded':return public(job)
    if not child.get('upstream_id'):raise HTTPException(409,'子任务没有远端回执，请核实平台；不会补交')
    from studio_native_tasks import bound_provider,current_record,remote_failed
    parent=current_record()
    if parent:bound_provider(parent)
    base,headers,_=connection(req['provider_id'],job['base_url'])
    async with httpx.AsyncClient(timeout=httpx.Timeout(120,connect=20),follow_redirects=False) as client:
        result=child.get('remote_result')
        if not result:
            response=await client.get(base+'/videos/'+quote(child['upstream_id'],safe=''),headers=headers)
            response.raise_for_status();result=normalize(response.json(),'video')
            if result['status']=='failed':
                child.update(status='failed',error=safe_text(result['error'],job) or '平台生成失败。')
                job.update(status='failed',error=child['error']);save(job);remote_failed(child['error']);return public(job)
            if result['status']!='succeeded':
                job.update(status='paused',error='原任务仍在处理中，可稍后继续查询。');save(job);return public(job)
            if not result['urls']:raise HTTPException(502,'原任务已完成但未返回视频地址')
            child.update(remote_result=result,remote_status='succeeded');save(job)
        native_parent_receipt(job)
        outputs=[]
        for i,url in enumerate(result['urls']):
            outputs.append(await persist_media(client,url,'video',job_id,f'0-{i}'))
        child.update(status='succeeded',outputs=outputs,usage=result.get('usage'))
        job.update(status='succeeded',error='');save(job)
    return public(job)


def install_compatibility():
    """Original/smart canvas routes use the same protocol adapter and records."""
    old_image=core.build_online_image_result;old_video=core.canvas_video;old_chat=core.canvas_llm
    def applies(pid):return urlsplit((core.get_api_provider_exact(pid) or {}).get('base_url','')).hostname=='api.deepwhiteai.com'
    def adapted(model,kind,values):
        fields=profile(model,kind)['fields']
        return {k:v for k,v in values.items() if k in fields and v not in ('',None,'auto')} # unset native defaults defer to contract
    async def wait_job(payload):
        native_parent_plan(payload)
        result=await submit(payload)
        task=WORKERS.get(result['id'])
        if task:await asyncio.shield(task)
        result=public(read(result['id']))
        if result['status']!='succeeded':
            if result['status']=='failed' and any(c['status']=='failed' for c in result['children']):core.native_remote_failed(result['error'])
            raise HTTPException(502,result['error']+' 记录编号：'+result['id'])
        return result
    async def image(payload):
        if not applies(payload.provider_id) or payload.model=='midjourney-imagine':return await old_image(payload)
        params=adapted(payload.model,'image',{'ratio':payload.aspect_ratio,'resolution':payload.resolution,'quality':payload.quality})
        result=await wait_job(Generation(request_id=uuid.uuid4().hex,provider_id=payload.provider_id,model=payload.model,kind='image',prompt=payload.prompt,params=params,references=[r.model_dump() for r in payload.reference_images],count=payload.n))
        return {'images':[o['url'] for o in result['outputs']],'task_id':','.join(result['task_ids']),'request_id':result['id'],'model':result['resolved_model']}
    async def video(payload):
        if not applies(payload.provider_id):return await old_video(payload)
        refs=[{**r.model_dump(),'kind':'image'} for r in payload.images]+[{'url':u,'kind':'video'} for u in payload.videos]+[{'url':u,'kind':'audio'} for u in payload.audios]
        params=adapted(payload.model,'video',{'ratio':payload.aspect_ratio,'resolution':payload.resolution,'duration':payload.duration,'generate_audio':payload.generate_audio})
        result=await wait_job(Generation(request_id=native_child_id('video'),canvas_id=getattr(payload,'canvas_id',''),node_id=getattr(payload,'node_id',''),provider_id=payload.provider_id,model=payload.model,kind='video',prompt=payload.prompt,params=params,references=refs,multimodal=payload.multimodal,frame_mode=any(r.get('role') in ('first_frame','last_frame') for r in refs)))
        urls=[o['url'] for o in result['outputs']]
        return {'videos':urls,'video_url':urls[0],'url':urls[0],'task_id':','.join(result['task_ids']),'request_id':result['id']}
    async def chat(payload):
        if not applies(payload.provider):return await old_chat(payload)
        refs=[{'url':u,'kind':'image'} for u in payload.images]+[{'url':u,'kind':'video'} for u in payload.videos]
        result=await wait_job(Generation(request_id=native_child_id('llm'),canvas_id=getattr(payload,'canvas_id',''),node_id=getattr(payload,'node_id',''),provider_id=payload.provider,model=payload.model,kind='chat',prompt=payload.message,system_prompt=payload.system_prompt,messages=payload.messages,references=refs))
        return {'text':result['text'],'model':result['resolved_model'],'request_id':result['id'],'raw_usage':result['children'][0].get('usage')}
    core.build_online_image_result=image;core.canvas_video=video;core.canvas_llm=chat

    @core.app.post('/api/studio/generations/{job_id}/resume')
    async def resume(job_id:str):
        job=read(job_id)
        if job['status']=='uncertain':raise HTTPException(409,'提交结果待核实，请先在 API 网站核对，不会自动重复提交。')
        if job['status'] not in ('failed','succeeded'):
            import studio_dreamina
            if job['request']['provider_id'] not in (studio_comfy.PROVIDER,studio_dreamina.PROVIDER):connection(job['request']['provider_id'],job['base_url'])
            job.update(status='running',error='');save(job);start(job_id)
        return public(job)
