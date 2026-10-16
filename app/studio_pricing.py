"""Read-only public price evidence. Never submit a generation to estimate its cost."""
import asyncio
import json
import math
import re
import time
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field
import main as core
import studio_catalog as catalog

_cache = None
_expires = 0
_lock = asyncio.Lock()


async def snapshot():
    global _cache, _expires
    async with _lock:
        if _cache and time.monotonic() < _expires:
            return _cache
        try:
            async with httpx.AsyncClient(timeout=6, follow_redirects=False) as client:
                response = await client.get('https://api.deepwhiteai.com/api/pricing')
                response.raise_for_status()
                value = response.json()
                if not isinstance(value,dict) or not value.get('pricing_version'):
                    raise ValueError('Missing pricing version')
                _cache = {**value, '_stale': False}
        except (httpx.HTTPError, ValueError):
            value = _cache or json.loads(catalog.SNAPSHOT.read_text(encoding='utf-8'))
            _cache = {**value, '_stale': True}
        _expires = time.monotonic() + (60 if _cache['_stale'] else 300)
        return _cache


class Quote(BaseModel):
    provider_id: str
    model: str
    kind: str = 'image'
    params: dict = Field(default_factory=dict)
    count: int = Field(default=1, ge=1, le=8)
    image_count: int = Field(default=0, ge=0, le=100)
    video_count: int = Field(default=0, ge=0, le=100)
    audio_count: int = Field(default=0, ge=0, le=100)
    multimodal: bool | None = None
    frame_mode: bool = False


def feature(key):
    key = key.split('.')[-1].lower()
    return {'seconds':'duration','duration_seconds':'duration', 'aspectratio':'aspect_ratio','ratio':'aspect_ratio', 'inputimagecount':'input_image_count',
            'image_count':'input_image_count', 'generateaudio':'generate_audio','hasimageinput':'has_image_input'}.get(key,key)


def equal(actual, desired):
    if actual is None or desired is None or desired == '':
        return False
    match = re.fullmatch(r'(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)',str(actual))
    if match:
        try: return float(match[1]) <= float(desired) <= float(match[2])
        except (ValueError,TypeError): return False
    return str(actual).lower() == str(desired).lower()


def estimate(raw, mid, request):
    unknown = {'price':None, 'label':'暂无可靠估价', 'note':'当前参数缺少价格证据，最终以 API 账单为准。', 'model':mid}
    if request.kind == 'chat':
        return {**unknown,'label':'按实际 Token 用量计费','note':'文本长度和回复长度未确定，生成前无法给出本次总价。'}
    params = {feature(k):v for k,v in request.params.items()}
    params['input_image_count'] = request.image_count
    params['has_image_input'] = request.image_count > 0
    params.setdefault('quality','auto')
    profile = raw.get('price_estimates',{}).get(mid) or {}
    entries = profile.get('entries') or []
    fields = [feature(k) for k in profile.get('active_features') or []]
    source = '历史估价'
    if profile.get('status') != 'ready' or not entries:
        observed = raw.get('observed_prices',{}).get(mid) or {}
        entries = observed.get('entries') or []
        # Task identifiers are not comparable price features. Such evidence cannot price a new task.
        fields = list({feature(k) for e in entries for k in e.get('params',{})})
        source = '同参数历史账单'
    if not entries:
        return unknown
    if request.kind == 'video' and 'duration' not in fields:
        return unknown
    matches=[]
    for entry in entries:
        values = {feature(k):v for k,v in entry.get('params',{}).items()}
        if all(equal(values.get(key),params.get(key)) for key in fields): matches.append(entry)
    approximate=False
    if not matches and 'input_image_count' in fields and 'quality' in fields:
        # Like Fisher: only relax reference count, never quality/resolution/duration/model.
        candidates=[]
        for entry in entries:
            values={feature(k):v for k,v in entry.get('params',{}).items()}
            if all(equal(values.get(k),params.get(k)) for k in fields if k not in ('input_image_count','has_image_input')):
                try: candidates.append((abs(float(values['input_image_count'])-request.image_count),entry))
                except (KeyError,TypeError,ValueError): pass
        if candidates:
            nearest=min(distance for distance,_ in candidates)
            matches=[entry for distance,entry in candidates if distance==nearest];approximate=True
    comparable = []
    for entry in matches:
        try:
            price=float(entry['price_cny']);low=float(entry.get('low_cny',price));high=float(entry.get('high_cny',price))
            if not all(math.isfinite(v) and v>0 for v in (price,low,high)):
                continue
        except (ValueError,TypeError,KeyError): continue
        comparable.append((price,low,high,max(1,int(entry.get('sample_count',1)))))
    if not comparable:
        return unknown
    comparable.sort()
    total=sum(e[3] for e in comparable);weight=0
    for price,_,_,n in comparable:
        weight+=n
        if weight>=total/2: break
    count=request.count
    low=min(e[1] for e in comparable)*count;high=max(e[2] for e in comparable)*count
    price*=count
    note=f'{source}，非固定报价；最终以本次 API 账单为准。'
    if approximate: note='参考相同参数、相近参考图数量的历史价格；参考图数量不同，实际费用可能变化。'+note
    if not fields: note='历史单次参考，尚未细分当前参数；最终以本次 API 账单为准。'
    if high-low>.005: note+=f' 历史区间 ¥{low:.3f}–{high:.3f}。'
    if raw.get('_stale'): note+=' 当前使用缓存价格。'
    return {'price':price,'low':low,'high':high,'label':f'预计 ≈ ¥{price:.3f}', 'note':note,
            'model':mid,'count':count,'source':source,'approximate':approximate,'version':raw.get('pricing_version'), 'stale':bool(raw.get('_stale'))}


def install(app):
    @app.post('/api/studio/quote')
    async def quote(request: Quote):
        from studio_comfy import PROVIDER
        if request.provider_id==PROVIDER:
            return {'price':0,'label':'本地运行 · 不扣 API 额度','note':'使用本机显卡和电力；需要启动本地 ComfyUI。'}
        provider=core.get_api_provider(request.provider_id)
        if urlsplit(provider.get('base_url','')).hostname != 'api.deepwhiteai.com':
            return {'price':None,'label':'暂无可靠估价','note':'此平台未提供可用的计价数据。'}
        try:
            if request.model.startswith('midjourney-') and request.model!='midjourney-imagine':
                from studio_midjourney import require_action
                require_action(request.provider_id,request.model.removeprefix('midjourney-'))
                mid=request.model
            else:
                mid=catalog.resolve_model(request.provider_id,request.model,request.kind,
                    images=[{'role':'first_frame' if request.frame_mode else ''}]*request.image_count,videos=[1]*request.video_count,audios=[1]*request.audio_count,multimodal=False if request.frame_mode else request.multimodal)
        except HTTPException as exc:
            return {'price':None,'label':'请检查模型或输入','note':exc.detail}
        return estimate(await snapshot(),mid,request)
