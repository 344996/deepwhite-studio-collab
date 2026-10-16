"""Product model families, independent of upstream task-mode variants."""
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
import main as core

KINDS = ('chat', 'image', 'video', 'audio')
MODE = re.compile(r'(?:(?<=-)|(?<=_)|^)(t2i|i2i|t2v|i2v|r2v|v2v|s2v|multi)(?=[-_]|$)', re.I)
SNAPSHOT = Path(__file__).parent / 'references/model-selection/pricing.json'


def store_path():
    return Path(core.DATA_DIR) / 'studio_model_catalog.json'


def load_store():
    path = store_path()
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}


def save_store(data):
    path = store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, path)


async def metadata(base_url):
    # Public metadata is fetched without a user credential, only from this known provider.
    if urlsplit(base_url).hostname != 'api.deepwhiteai.com':
        return {}, {}
    raw = {}
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
            response = await client.get('https://api.deepwhiteai.com/api/pricing')
            response.raise_for_status()
            raw = response.json()
    except (httpx.HTTPError, ValueError):
        if SNAPSHOT.exists():
            raw = json.loads(SNAPSHOT.read_text(encoding='utf-8'))
    if not isinstance(raw, dict):
        raw = {}
    return ({item['model_name']: item for item in raw.get('data', []) if isinstance(item, dict) and item.get('model_name')},
            {str(v['id']): v.get('name', '') for v in raw.get('vendors', []) if isinstance(v, dict) and 'id' in v})


def classify(mid, info):
    tags = set(re.split(r'[,\s]+', str(info.get('tags', '')).lower()))
    kind = str(info.get('type') or info.get('kind') or '').lower()
    if kind in KINDS:
        return kind
    if tags & {'3d', 'other', 'embedding', 'rerank'}:
        return 'other'
    if tags & {'text', 'llm', 'chat'}:
        return 'chat'
    if 'audio' in tags:
        return 'audio'
    if 'video' in tags and 'image' not in tags:
        return 'video'
    if 'image' in tags and 'video' not in tags:
        return 'image'
    value = mid.lower()
    if re.search(r'(audio|speech|tts|suno|mureka|whisper|voice|flowmusic|音频|语音|音乐)', value):
        return 'audio'
    if re.search(r'(video|seedance|kling|hailuo|veo|sora|vidu|wan[-\d]|minimax-h3|ltx|[tirvs]2v|视频)', value):
        return 'video'
    if re.search(r'(image|seedream|flux|banana|dall.?e|imagen|ideogram|midjourney|[ti]2i|图片|生图)', value):
        return 'image'
    if re.search(r'(gpt|deepseek|qwen|claude|gemini|llama|glm|chat|kimi|doubao|\bg[456]|\bgk-|\bo[134]|文本|语言)', value):
        return 'chat'
    return 'other'


def family_and_mode(mid):
    match = MODE.search(mid)
    if not match:
        return mid, 'auto'
    family = MODE.sub('', mid)
    family = re.sub(r'[-_]{2,}', '-', family).strip('-_')
    return family, match.group(1).lower()


def display_name(family):
    special = {
        'midjourney-imagine': 'Midjourney 文生图',
        'deepwhiteai-image-g2': '全能图片 G2', 'deepwhiteai-image-g-v2-lowprice': '全能图片 G2 · 低价版',
        'deepwhiteai-image-g-v2.5-flare': '全能图片 G2.5 · 极速版',
        'deepwhiteai-image-g-v2.5-sunburst': '全能图片 G2.5 · 高品质版',
        'deepwhiteai-image-nb-pro': 'Nano Banana Pro', 'deepwhiteai-image-nb-2': 'Nano Banana 2',
        'deepwhiteai-image-nb-2-lite': 'Nano Banana 2 Lite',
    }
    if family in special:
        return special[family]
    name = re.sub(r'^deepwhiteai[-/]', '', family, flags=re.I).replace('_', ' ').replace('-', ' ')
    return ' '.join(word.upper() if word.lower() in ('gpt','glm','tts','gk','hd') else word.capitalize() for word in name.split())


def series_name(mid):
    value = mid.lower()
    rules = [('midjourney','Midjourney'), ('image-nb','Nano Banana'), ('banana','Nano Banana'),
             ('image-gk','Grok Image'), ('image-g','全能图片 G'), ('seedream','Seedream'),
             ('seedance','Seedance'), ('deepseek','DeepSeek'), ('qwen','Qwen'), ('claude','Claude'),
             ('gemini','Gemini'), ('gpt','GPT'), ('glm','GLM'), ('kling','Kling'), ('sora','Sora'),
             ('veo','Veo'), ('vidu','Vidu'), ('hailuo','Hailuo'), ('minimax','MiniMax'),
             ('minmax','MiniMax'), ('wan','Wan'), ('suno','Suno'), ('mureka','Mureka')]
    return next((name for token,name in rules if token in value), display_name(re.split(r'[-/\d]',value)[0]) or '其他系列')


def annotate(entry):
    entry['series'] = series_name(entry['id'])
    mid = entry['id'].lower()
    entry['role'] = 'generate'
    if mid.startswith('midjourney-') and mid != 'midjourney-imagine':
        entry['role'] = 'mj-tool'
        entry['capabilities'] = ['MJ 专用工具']
    elif entry['kind']=='image' and (not set(entry['variants']) & {'auto','t2i'} or
            re.search(r'(?:^|-)(edit|edits|upscale|segment|region-edit|layer-decomposition)(?:-|$)',mid)):
        entry['role'] = 'image-tool'
        entry['capabilities'] = ['图片处理工具']
    return entry


def build_catalog(items, meta=None, vendors=None, previous=None):
    meta, vendors = meta or {}, vendors or {}
    old = {item['id']: item for item in (previous or [])}
    grouped = {}
    for raw in items:
        item = raw if isinstance(raw, dict) else {'id': raw}
        mid = str(item.get('id') or item.get('name') or item.get('model') or '').strip()
        if not mid:
            continue
        info = {**meta.get(mid, {}), **item}
        kind = classify(mid, info)
        family, mode = family_and_mode(mid) if kind in ('image','video') else (mid, 'auto')
        key = (kind, family)
        entry = grouped.setdefault(key, {'id':family, 'name':display_name(family), 'kind':kind,
            'vendor':vendors.get(str(info.get('vendor_id')), '') or str(info.get('owned_by') or 'API'),
            'variants':{}, 'enabled':True, 'removed':False, 'available':True})
        # IDs only merge by exact family tokens; quality, speed, vendor and region stay distinct.
        entry['variants'].setdefault(mode, mid)
    result = []
    for (_, family), entry in grouped.items():
        pref = old.get(family, {})
        entry['enabled'] = pref.get('enabled', True)
        entry['removed'] = pref.get('removed', False)
        entry['capabilities'] = capabilities(entry)
        annotate(entry)
        result.append(entry)
    present = {entry['id'] for entry in result}
    # Keep unavailable and deleted entries as tombstones, so refresh never overrides preferences.
    result += [{**item, 'available':False} for mid,item in old.items() if mid not in present]
    first = {'deepwhiteai-image-g2':0,'deepwhiteai-image-g-v2.5-flare':1,
             'seedance-2.0-fast':0,'deepseek/deepseek-v4.1-flash':0}
    return sorted(result, key=lambda item:(item['kind'],first.get(item['id'],10),item['vendor'],item['name'].lower()))


def capabilities(entry):
    modes = entry['variants']
    if set(modes)=={'auto'} and entry['kind'] in ('image','video'):
        return ['自动匹配输入']
    if entry['kind'] == 'image':
        return ([ '文字生成' ] if 't2i' in modes or 'auto' in modes else []) + (['参考图生成'] if 'i2i' in modes or 'auto' in modes else [])
    if entry['kind'] == 'video':
        return (['文字生成'] if 't2v' in modes or 'auto' in modes else []) + (['图片参考'] if set(modes)&{'i2v','r2v','multi','auto'} else []) + (['视频参考'] if set(modes)&{'v2v','multi'} else [])
    return ['文本对话'] if entry['kind']=='chat' else ['音频'] if entry['kind']=='audio' else ['辅助工具']


def active(entry):
    return entry.get('enabled', True) and not entry.get('removed') and entry.get('available', True)


def apply_to_provider(provider_id, entries):
    providers = core.load_api_providers()
    provider = next((p for p in providers if p['id']==provider_id), None)
    if not provider:
        raise HTTPException(404, '请先保存 API 平台。')
    for kind in ('chat','image','video','audio'):
        provider[f'{kind}_models'] = [item['id'] for item in entries if item['kind']==kind and active(item) and annotate(item)['role']=='generate']
    provider['model_names'] = {item['id']:item['name'] for item in entries if active(item)}
    core.save_api_providers(providers)
    return core.public_provider(provider)


def resolve_model(provider_id, requested, kind, images=None, videos=None, audios=None, multimodal=None):
    catalog = load_store().get(provider_id)
    if not catalog:
        return requested
    provider = core.get_api_provider(provider_id)
    if provider.get('base_url','').rstrip('/') != catalog.get('base_url','').rstrip('/'):
        raise HTTPException(400, 'API 地址已修改，请重新同步模型后生成。')
    entries = catalog['models']
    requested = requested or next((e['id'] for e in entries if e['kind']==kind and active(e)), '')
    entry = next((e for e in entries if e['kind']==kind and (e['id']==requested or requested in e['variants'].values())), None)
    if not entry or not active(entry):
        raise HTTPException(400, '该模型已停用、移除或不再可用，请选择其他模型或同步模型列表。')
    if annotate(entry)['role'] != 'generate':
        raise HTTPException(400, '此模型是专用操作，请使用对应工具节点；生图节点仅提供支持文生图的模型。')
    modes = entry['variants']
    if kind == 'image':
        candidates = ['i2i','auto'] if images else ['t2i','auto']
        reason = '不支持参考图生成' if images else '需要先添加参考图'
    elif kind == 'video':
        frame_roles = any((r.get('role') if isinstance(r,dict) else getattr(r,'role','')) in ('first_frame','last_frame','first','last') for r in (images or []))
        if frame_roles:
            candidates = ['i2v','auto']; reason = '不支持首尾帧输入'
        elif 'seedance' in entry['id'].lower() and multimodal is not False and (images or videos or audios):
            candidates = ['multi','auto']; reason = '不支持全能参考'
        elif multimodal and 'multi' in modes and (images or videos or audios):
            candidates = ['multi']; reason = '不支持全能参考'
        elif multimodal and 'r2v' in modes and (images or videos or audios):
            candidates = ['r2v']; reason = '不支持多素材参考'
        elif audios:
            candidates = ['multi','r2v','auto']; reason = '不支持音频参考'
        elif videos:
            candidates = ['multi','r2v','v2v','auto']; reason = '不支持视频参考'
        elif images:
            candidates = ['r2v','multi','i2v','auto'] if len(images)>1 else ['i2v','r2v','multi','auto']
            reason = '不支持图片参考'
        else:
            candidates = ['t2v','auto']; reason = '需要先添加参考素材'
    else:
        candidates = ['auto']; reason = '不支持当前输入'
    for mode in candidates:
        if mode in modes:
            return modes[mode]
    raise HTTPException(400, f'{entry["name"]}{reason}，请调整输入或选择其他模型。')


def install_generation_routes(app):
    paths = {'/api/online-image','/api/canvas-image-tasks','/api/canvas-video','/api/canvas-llm'}
    app.router.routes[:] = [r for r in app.router.routes if not (getattr(r,'path',None) in paths and 'POST' in getattr(r,'methods',set()))]

    @app.post('/api/online-image')
    async def image(payload: core.OnlineImageRequest):
        payload.model = resolve_model(payload.provider_id,payload.model,'image',images=core.image_references([r.model_dump() for r in payload.reference_images if r.url]))
        return await core.online_image(payload)

    @app.post('/api/canvas-image-tasks')
    async def image_task(payload: core.OnlineImageRequest):
        payload.model = resolve_model(payload.provider_id,payload.model,'image',images=core.image_references([r.model_dump() for r in payload.reference_images if r.url]))
        return await core.create_canvas_image_task(payload)

    @app.post('/api/canvas-video')
    async def video(payload: core.CanvasVideoRequest):
        if 'seedance' in payload.model.lower() and 'multimodal' not in payload.model_fields_set:
            payload.multimodal = True
        payload.model = resolve_model(payload.provider_id,payload.model,'video',images=[r for r in payload.images if r.url],videos=[v for v in payload.videos if v],audios=[a for a in payload.audios if a],multimodal=payload.multimodal)
        return await core.canvas_video(payload)

    @app.post('/api/canvas-llm')
    async def chat(payload: core.CanvasLLMRequest):
        payload.model = resolve_model(payload.provider,payload.model,'chat')
        return await core.canvas_llm(payload)
