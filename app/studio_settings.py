"""Basic settings backed by the original canvas provider store; probes are GET-only."""
import asyncio
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import HTTPException
import main as core
import studio_catalog as catalog
from pydantic import BaseModel
from typing import List

save_lock = asyncio.Lock()


def models_url(base):
    try:
        parts = urlsplit(base.strip())
        _ = parts.port
    except ValueError:
        raise HTTPException(400, 'API 地址格式不正确。')
    if (parts.scheme not in ('https', 'http') or not parts.hostname
            or parts.username or parts.password or parts.query or parts.fragment):
        raise HTTPException(400, '请填写完整的 API 基础地址，不要包含密钥、查询参数或接口名称。')
    if parts.scheme == 'http' and parts.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise HTTPException(400, '远程 API 请使用 HTTPS 地址。')
    path = parts.path.rstrip('/')
    if not path.endswith('/v1'):
        path += '/v1'
    return urlunsplit((parts.scheme, parts.netloc.lower(), path + '/models', '', ''))


def validate_key(key):
    if any(ord(c) < 32 or ord(c) == 127 for c in key):
        raise HTTPException(400, '密钥中不能包含换行或控制字符。')
    return core.strip_auth_scheme(key.strip(), 'Bearer')


def resolve_key(payload):
    if payload.provider_id.strip().lower().startswith('deepwhite-account-'):
        return core.api_key_from_payload(payload)
    explicit = validate_key(payload.api_key or '')
    if explicit:
        return explicit
    key = core.provider_env_key_value(payload.provider_id)
    if key:
        core.assert_saved_provider_address(payload.provider_id, payload.base_url)
        return validate_key(key)
    raise HTTPException(400, '请先填写 API Key；已保存的密钥可以留空使用。')


def suggested_kind(model):
    value = model.lower()
    if any(word in value for word in ('audio', 'speech', 'tts', 'suno', 'mureka', 'whisper', '音频', '语音', '音乐')):
        return 'audio'
    if any(word in value for word in ('seedance', 'minimax-h3', 'ltx', 'video', 'veo', 'sora', 'kling', 'hailuo', 'wan2', 'wanx', '视频')):
        return 'video'
    if any(word in value for word in ('image', 'gpt-img', 'seedream', 'flux', 'banana', 'dall-e', 'imagen', 'ideogram', 'midjourney', '图片', '生图')):
        return 'image'
    if any(word in value for word in ('gpt', 'deepseek', 'qwen', 'claude', 'gemini', 'llama', 'glm', 'chat', 'o1', 'o3', 'o4', '文本', '语言')):
        return 'chat'
    return 'unknown'


async def read_models(payload, transport=None):
    url = models_url(payload.base_url)
    key = resolve_key(payload)
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False, transport=transport) as client:
            response = await client.get(url, headers={'Authorization': 'Bearer ' + key, 'Accept': 'application/json'})
    except httpx.TimeoutException:
        raise HTTPException(504, '连接超时，请检查 API 地址和网络后重试。')
    except httpx.RequestError:
        raise HTTPException(502, '无法连接 API，请检查地址、网络或证书。')
    errors = {401: '密钥无效或已过期。', 403: '该密钥没有访问模型列表的权限。',
              404: '未找到模型列表接口，请检查基础地址。', 429: '请求过于频繁，请稍后重试。'}
    if response.status_code != 200:
        detail = errors.get(response.status_code, 'API 服务暂时不可用。')
        if 300 <= response.status_code < 400:
            detail = 'API 返回跳转，请填写最终 API 地址；密钥不会随跳转发送。'
        raise HTTPException(502, f'{detail}（HTTP {response.status_code}）')
    try:
        raw = response.json()
    except ValueError:
        raise HTTPException(502, '返回内容不是模型列表，请确认填写的是 API 地址，而非网站页面。')
    if not isinstance(raw, dict) or not any(isinstance(raw.get(k), list) for k in ('data', 'models', 'list')):
        raise HTTPException(502, '返回格式不符合模型列表格式，请检查 API 地址。')
    _, ids = core.parse_upstream_models(raw)
    # Never render or return upstream strings containing the submitted credential.
    ids = [mid for mid in ids if key not in mid]
    rows = next((raw[k] for k in ('data','models','list') if isinstance(raw.get(k), list)), [])
    records = []
    for row in rows:
        item = row if isinstance(row, dict) else {'id':row}
        mid = str(item.get('id') or item.get('name') or item.get('model') or '')
        if mid not in ids:
            continue
        records.append({'id':mid, **{field:str(item[field]) for field in ('tags','type','kind','owned_by')
                                   if item.get(field) and key not in str(item[field])}})
    return {'ok': True, 'models': [{'id': mid, 'kind': suggested_kind(mid)} for mid in ids],
            'model_records': records,
            'model_count': len(ids), 'message': f'连接成功，密钥可读取 {len(ids)} 个模型。未发起生成任务。'}


class ModelPreference(BaseModel):
    id: str
    enabled: bool = True
    removed: bool = False


class CatalogPreferences(BaseModel):
    models: List[ModelPreference]


def assert_editable(provider_id, managed_ok=False):
    if provider_id.strip().lower().startswith('deepwhite-account-') and not managed_ok:
        raise HTTPException(409, '登录账户的官方 API 由账户连接管理，请在账户中重新连接；自选 API 请新增平台。')


async def save_provider_config(payload, *, managed_ok=False):
    assert_editable(payload.id, managed_ok)
    models_url(payload.base_url)
    if payload.protocol != 'openai':
        raise HTTPException(400, '此页用于 OpenAI 兼容平台；其他协议请使用原版高级设置。')
    payload.api_key = validate_key(payload.api_key or '') or None
    async with save_lock:
        providers = core.load_api_providers()
        saved = next((p for p in providers if p['id'] == payload.id), None)
        merged = {**(saved or {}), **payload.model_dump(exclude_unset=True, exclude={'api_key'})}
        provider = core.normalize_provider(merged)
        if provider['protocol'] != 'openai':
            raise HTTPException(400, '此页用于 OpenAI 兼容平台；其他协议请使用原版高级设置。')
        core.validate_provider_credential_update(provider, payload, providers, managed_ok=managed_ok)
        providers = [p for p in providers if p['id'] != provider['id']]
        if provider.get('primary'):
            providers = [{**p, 'primary': False} for p in providers]
        providers.insert(0, provider)
        if payload.clear_key or payload.api_key:
            core.update_env_values({core.provider_key_env(provider['id']): '' if payload.clear_key else payload.api_key})
            core.reload_env_globals()
        core.save_api_providers(providers)
        return {'provider': core.public_provider(provider)}


async def synchronize_provider(payload, *, transport=None, managed_ok=False):
    assert_editable(payload.id, managed_ok)
    # Probe before saving: an unavailable upstream must not erase a catalogue.
    probe = core.TestConnectionPayload(base_url=payload.base_url, api_key=payload.api_key or '', provider_id=payload.id)
    result = await read_models(probe, transport=transport) if transport is not None else await read_models(probe)
    if not result['model_records']:
        raise HTTPException(400, '接口返回空模型列表，已保留原有模型，请稍后重试。')
    meta, vendors = await catalog.metadata(payload.base_url)
    await save_provider_config(payload, managed_ok=managed_ok)
    async with save_lock:
        store = catalog.load_store()
        prior = store.get(payload.id, {})
        previous = prior.get('models', []) if prior.get('base_url', '').rstrip('/') == payload.base_url.rstrip('/') else []
        entries = catalog.build_catalog(result['model_records'], meta, vendors, previous)
        store[payload.id] = {'base_url': payload.base_url, 'models': entries}
        provider = catalog.apply_to_provider(payload.id, entries)
        catalog.save_store(store)
    return {'provider': provider, 'models': entries, 'raw_count': result['model_count'],
            'sync': {'status': 'ready'},
            'message': f'已同步 {len(entries)} 个模型，自动分类并启用新模型；已有停用和移除设置已保留。'}


def install(app):
    catalog.install_generation_routes(app)
    import studio_provider_capabilities
    studio_provider_capabilities.install(app)

    @app.get('/api/studio/model-catalog')
    async def get_catalog():
        import studio_comfy
        return {'providers':{**catalog.load_store(),studio_comfy.PROVIDER:studio_comfy.catalog()},
                'preview': catalog.preview_catalog()}

    @app.patch('/api/studio/model-catalog/{provider_id}')
    async def preferences(provider_id: str, payload: CatalogPreferences):
        async with save_lock:
            store = catalog.load_store()
            if provider_id not in store:
                raise HTTPException(404, '请先同步模型。')
            entries = store[provider_id]['models']
            changes = {p.id:p for p in payload.models}
            if set(changes) - {e['id'] for e in entries}:
                raise HTTPException(400, '模型列表已变化，请重新打开设置。')
            for entry in entries:
                if entry['id'] in changes:
                    pref = changes[entry['id']]
                    entry.update(enabled=pref.enabled, removed=pref.removed)
            provider = catalog.apply_to_provider(provider_id, entries)
            catalog.save_store(store)
            return {'provider':provider, 'models':entries}

    @app.post('/api/studio/settings/sync-models')
    async def sync_models(payload: core.ApiProviderPayload):
        return await synchronize_provider(payload)

    @app.post('/api/studio/settings/test')
    async def test_connection(payload: core.TestConnectionPayload):
        result = await read_models(payload)
        # Diagnostic persistence must not turn a successful read-only check into a failure.
        try:
            studio_provider_capabilities.record_probe(payload.provider_id, payload.base_url, result)
        except OSError:
            result['diagnostic_saved'] = False
        return result

    @app.put('/api/studio/settings/provider')
    async def save_provider(payload: core.ApiProviderPayload):
        saved = await save_provider_config(payload)
        if payload.clear_key or not saved['provider']['has_key']:
            return {**saved, 'sync': {'status': 'not_connected', 'message': '连接设置已保存，尚未提供生成密钥。'}}
        try:
            return await synchronize_provider(payload)
        except HTTPException as exc:
            return {**saved, 'sync': {'status': 'retryable', 'message': str(exc.detail)},
                    'message': '连接设置已保存，模型同步未完成；原有模型已保留，可以重试。'}
