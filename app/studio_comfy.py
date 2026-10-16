"""Pinned Qwen single-image workflow, using the user's already-running local engine."""
import asyncio
import json
import secrets
import time
import contextlib
from pathlib import Path
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException

PROVIDER = 'deepwhite-local-comfy'
MODEL = 'local-qwen-image-21-edit'
BASE = 'http://127.0.0.1:8188'
TEMPLATE = Path(__file__).parent / 'workflows/qwen-single-edit.api.json'
RATIOS = {'1:1':'1:1 (Square)', '16:9':'16:9 (Widescreen)',
          '9:16':'9:16 (Portrait Widescreen)', '4:3':'4:3 (Standard)', '3:4':'3:4 (Portrait Standard)'}

DEFAULT_UNET = 'qwen_image_2.1_int8_convrot.safetensors'
_models = []
_models_verified = False
_models_at = 0

def engine_base():
    try:
        from studio_comfy_engine import base_url
        return base_url()
    except Exception:
        return BASE

def compatible_model_name(name):
    return isinstance(name, str) and 'qwen_image_2.1' in name.lower().replace('-', '_') and name.endswith('.safetensors')

async def refresh_models():
    """Read installed choices only; never launch an engine or download a model."""
    global _models, _models_at, _models_verified
    if _models_verified and time.monotonic() - _models_at < 15:
        return
    _models_at = time.monotonic()
    _models = []
    _models_verified = False
    try:
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            r = await client.get(engine_base() + '/object_info/UNETLoader'); r.raise_for_status()
            choices = r.json()['UNETLoader']['input']['required']['unet_name'][0]
            if not isinstance(choices, list):
                raise TypeError('ComfyUI UNETLoader choices were not a list')
            # This workflow pins Qwen 2.1 conditioning/latent layout. Other architectures are not interchangeable.
            _models = [name for name in choices if compatible_model_name(name)]
            _models_verified = True
    except (httpx.HTTPError, KeyError, TypeError, ValueError):
        _models = []
        _models_verified = False

async def watch_progress(job, ready):
    """Progress is advisory; history remains authoritative and loss never resubmits."""
    import studio_generation as jobs
    try:
        import websockets
        base=engine_base().replace('https://','wss://').replace('http://','ws://')
        async with websockets.connect(base+'/ws?clientId=deepwhite-' + job['id'],
                                      open_timeout=2, proxy=None) as socket:
            ready.set()
            async for raw in socket:
                if not isinstance(raw, str):
                    continue
                event = json.loads(raw); data = event.get('data', {})
                child = next((c for c in job['children'] if c.get('upstream_id') == data.get('prompt_id') and c.get('status') == 'running'), None)
                if child is None:
                    continue
                if event.get('type') == 'progress' and data.get('max', 0) > 0:
                    child.update(progress=max(0,min(100,100*data.get('value',0)/data['max'])), stage='采样中')
                elif event.get('type') == 'executing':
                    child.update(stage='执行工作流' if data.get('node') else '整理输出')
                    child.pop('progress', None)
                else:
                    continue
                jobs.save(job)
    except Exception:
        pass
    finally:
        ready.set()


def provider():
    return dict(id=PROVIDER, name='本地 ComfyUI', base_url=engine_base(), enabled=True,
                protocol='local-comfy', has_key=False, primary=False,
                image_models=[MODEL], video_models=[], chat_models=[])


def catalog():
    return {'base_url':engine_base(), 'models':[dict(id=MODEL, name='Qwen Image 2.1 · 单图编辑',
        kind='image', series='Qwen 本地工作流', vendor='阿里巴巴', enabled=True,
        removed=False, capabilities=['单张参考图编辑', '本地运行'], variants=[MODEL])]}


def spec():
    from studio_capabilities import option
    if not _models_verified:
        model_label = '主模型（未检测；执行时使用工作流固定值）'
    elif not _models:
        model_label = '主模型（未检测到已安装的兼容模型）'
    else:
        model_label = '主模型（Qwen Image 2.1）'
    main_model = option(model_label, _models, _models[0] if _models else DEFAULT_UNET)
    return dict(kind='image', supported=True, max_images=1, max_videos=0, max_audios=0,
        prompt_min=1, prompt_max=20000,
        note='需一张参考图；本地引擎自动准备，首次生成时加载模型。不扣 API 额度。',
        models_verified=_models_verified,
        fields={'main_model':main_model,
                'ratio':option('输出比例',list(RATIOS),'9:16'),
                'steps':option('采样步数',[20,30,40],40),
                'cfg':option('提示词引导强度',[1.0,1.5,2.0],1.0),
                'optimize_prompt':option('提示词优化',[False,True],False)})


def checked(payload):
    if payload.model != MODEL or payload.kind != 'image':
        raise HTTPException(400,'请选择本地 Qwen 单图编辑模型。')
    refs=payload.references
    if len(refs)!=1 or refs[0].get('kind','image')!='image':
        raise HTTPException(400,'Qwen 单图编辑需要且只能提供一张参考图片。')
    # Resolve using the canvas file boundary, never send arbitrary paths to ComfyUI.
    import main as core
    path=core.output_file_from_url(refs[0].get('url',''))
    if not path or not Path(path).is_file():raise HTTPException(400,'请先将参考图片上传或保存到画布。')
    from PIL import Image
    try:
        with Image.open(path) as image:image.verify()
    except Exception:raise HTTPException(400,'参考文件不是有效图片，请重新上传。')
    if not 1<=len(payload.prompt.strip())<=20000:raise HTTPException(400,'请填写 1–20000 字的编辑要求。')
    params={}
    for key,field in spec()['fields'].items():
        value=payload.params.get(key,field['default'])
        # Preserve a previously selected compatible model across engine restarts.
        # This is not installation evidence: execute checks live choices before POST.
        deferred_model = key=='main_model' and (value==DEFAULT_UNET or (not _models_verified and compatible_model_name(value)))
        if value not in field['values'] and not deferred_model:
            raise HTTPException(400,'本地工作流参数不支持当前值。')
        params[key]=value
    req=payload.model_dump();req['params']=params
    return req,MODEL,engine_base()


def graph(req, image, job_id, index):
    g=json.loads(TEMPLATE.read_text(encoding='utf-8'))
    g['177']['inputs']['image']=image
    g['458']['inputs']['prompt']=req['prompt']
    g['409']['inputs'].update(steps=req['params']['steps'],seed=secrets.randbelow(2**53))
    g['409']['inputs']['cfg']=req['params'].get('cfg',1.0)
    for node in g.values():
        if node['class_type']=='UNETLoader':node['inputs']['unet_name']=req['params'].get('main_model',DEFAULT_UNET)
    g['410']['inputs']['aspect_ratio']=RATIOS[req['params']['ratio']]
    g['468']['inputs']['filename_prefix']=f'DeepWhite/{job_id}-{index}'
    if not req['params']['optimize_prompt']:
        g['408']['inputs']['prompt']=['458',0]
        g.pop('486',None);g.pop('487',None)
    return g


async def execute(job_id):
    import main as core
    import studio_generation as jobs
    job=jobs.read(job_id);req=job['request']
    monitor=None
    async with httpx.AsyncClient(timeout=httpx.Timeout(60,connect=5),follow_redirects=False) as client:
        try:
            from studio_comfy_engine import ensure
            await ensure()
            ready=asyncio.Event();monitor=asyncio.create_task(watch_progress(job,ready))
            await ready.wait()
            for index,child in enumerate(job['children']):
                if child['status']=='succeeded':continue
                if child['status']=='submitting' and not child.get('upstream_id'):
                    job.update(status='uncertain',error='本地任务提交结果待核实，请查看 ComfyUI 队列；不会自动重复生成。');jobs.save(job);return
                if child['status']=='queued':
                    try:
                        base=engine_base()
                        response=await client.get(base+'/object_info');response.raise_for_status()
                    except httpx.HTTPError:
                        raise HTTPException(400,'连接不到本地 ComfyUI，请启动整合包，确认端口为 8188。')
                    info=response.json();g=graph(req,'pending.png',job_id,index)
                    missing=sorted({n['class_type'] for n in g.values()}-set(info))
                    if missing:raise HTTPException(400,'本地 ComfyUI 缺少节点：'+', '.join(missing))
                    for n in g.values():
                        required=info[n['class_type']].get('input',{}).get('required',{})
                        for key in ('unet_name','clip_name','vae_name','aspect_ratio'):
                            schema=required.get(key,[])
                            choices=schema[0] if schema and isinstance(schema[0],list) else schema[1].get('options',[]) if len(schema)>1 and isinstance(schema[1],dict) else []
                            is_model_choice=n['class_type']=='UNETLoader' and key=='unet_name'
                            if key in n['inputs'] and ((is_model_choice and (not choices or n['inputs'][key] not in choices)) or (choices and n['inputs'][key] not in choices)):
                                raise HTTPException(400,'本地工作流缺少模型或参数不匹配：'+str(n['inputs'][key]))
                    resolved=core.output_file_from_url(req['references'][0]['url'])
                    if not resolved:raise HTTPException(400,'参考图已移除，请重新上传。')
                    path=Path(resolved)
                    if not path.is_file() or path.stat().st_size>50*1024*1024:raise HTTPException(400,'参考图不存在或超过 50 MB，请重新上传。')
                    with path.open('rb') as f:
                        response=await client.post(base+'/upload/image',files={'image':(f'deepwhite-{job_id}{path.suffix}',f)},data={'type':'input','overwrite':'false'})
                    response.raise_for_status();uploaded=response.json()
                    image='/'.join(x for x in (uploaded.get('subfolder',''),uploaded['name']) if x)
                    g['177']['inputs']['image']=image
                    child.update(status='submitting',stage='提交工作流');job['status']='running';jobs.save(job)
                    try:
                        response=await client.post(base+'/prompt',json={'prompt':g,'client_id':'deepwhite-'+job_id})
                        if 400<=response.status_code<500:
                            child['status']='failed';raise HTTPException(400,'ComfyUI 拒绝工作流：'+jobs.clean_error(response.text)[:400])
                        response.raise_for_status();pid=response.json().get('prompt_id')
                        if not pid:raise ValueError('Missing prompt_id')
                    except Exception:
                        if child['status']=='submitting':job['status']='uncertain'
                        raise
                    child.update(status='running',upstream_id=pid,stage='排队 / 载入模型');jobs.save(job)
                try:
                    while True:
                        response=await client.get(engine_base()+'/history/'+child['upstream_id']);response.raise_for_status()
                        history=response.json().get(child['upstream_id'])
                        if history:
                            status=history.get('status',{})
                            if status.get('status_str')=='error':
                                child['status']='failed';job.update(status='failed',error='本地 Qwen 运行失败，请检查 ComfyUI 的模型、显存和错误日志。');jobs.save(job);return
                            if status.get('completed'):break
                        await asyncio.sleep(jobs.POLL_SECONDS)
                    images=history.get('outputs',{}).get('468',{}).get('images',[])
                    if not images:raise HTTPException(502,'本地任务已结束但没有保存图片，请检查工作流输出。')
                    child.update(stage='保存图片');child.pop('progress',None);jobs.save(job)
                    outputs=[]
                    for i,item in enumerate(images):
                        url=engine_base()+'/view?'+urlencode({k:item[k] for k in ('filename','subfolder','type') if k in item})
                        outputs.append(await jobs.persist_media(client,url,'image',job_id,f'{index}-{i}'))
                    child.update(status='succeeded',outputs=outputs,usage={'amount':0,'currency':'CNY','local':True});jobs.save(job)
                except (httpx.HTTPError,HTTPException):
                    job.update(status='paused',error='本地任务查询或结果读取中断。恢复 ComfyUI 后点击继续查询，不会重复生成。');jobs.save(job);return
            job.update(status='succeeded',error='');jobs.save(job)
        except Exception as exc:
            if job['status']!='uncertain':job['status']='failed'
            job['error']=str(exc.detail) if isinstance(exc,HTTPException) else '本地调用中断，请检查 ComfyUI 是否运行。'
            if job['status']=='uncertain':job['error']+=' 提交结果待核实，请先查看 ComfyUI 队列。'
            jobs.save(job)
        finally:
            if monitor:
                monitor.cancel()
                with contextlib.suppress(asyncio.CancelledError):await monitor


def install(core):
    original=core.public_api_providers
    core.public_api_providers=lambda:[p for p in original() if p['id']!=PROVIDER]+[provider()]
