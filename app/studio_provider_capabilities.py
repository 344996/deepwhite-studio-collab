"""Local capability descriptions and address-bound GET-only connection receipts."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

import main as core
from studio_capabilities import profile

KINDS = ('chat', 'image', 'video', 'audio')
LABELS = {'chat': '文本', 'image': '图片', 'video': '视频', 'audio': '音频'}


def _address(value):
    return hashlib.sha256(str(value).strip().rstrip('/').encode('utf-8')).hexdigest()


def _path():
    return Path(core.DATA_DIR) / 'studio_provider_diagnostics.json'


def _receipts():
    try:
        value = json.loads(_path().read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def record_probe(provider_id, base_url, result):
    """Store only successful model-list checks, never keys, errors or upstream strings."""
    if not provider_id:
        return
    receipts = _receipts()
    receipts[provider_id] = {
        'address_hash': _address(base_url),
        'checked_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'model_count': int(result['model_count']),
        'scope': 'model-list-only',
    }
    core._atomic_write_bytes(str(_path()), json.dumps(receipts, ensure_ascii=False).encode('utf-8'))


def describe(provider, receipt=None):
    try:
        deepwhite = urlsplit(provider.get('base_url', '')).hostname == 'api.deepwhiteai.com'
    except ValueError:
        deepwhite = False
    compatible = provider.get('protocol', 'openai') == 'openai'
    rows = []
    for kind in KINDS:
        models = provider.get(kind + '_models') or []
        adapted = [model for model in models if deepwhite and profile(model, kind).get('supported')]
        if deepwhite:
            status = 'adapted' if adapted else 'no-adapted-model'
            note = '使用深白任务适配器；实际可用性和额度以站点为准。' if adapted else '尚未配置本通道已适配的模型。'
        elif compatible and kind in ('chat', 'image'):
            status = 'protocol-compatible'
            note = '原画布提供兼容调用；仍需匹配模型、请求方式及返回格式。'
        elif compatible and kind == 'video':
            status = 'model-specific'
            note = '视频提交和轮询因平台而异，请核对原版高级设置的具体适配。'
        else:
            status = 'not-adapted'
            note = '当前统一任务接口未适配此平台的这项能力。'
        rows.append({'kind': kind, 'label': LABELS[kind], 'status': status,
                     'configured_models': len(models), 'adapted_models': adapted,
                     'note': note, 'live_generation_verified': False})
    current_receipt = receipt if receipt and receipt.get('address_hash') == _address(provider.get('base_url')) else None
    return {
        'provider_id': provider['id'], 'adapter': 'deepwhite' if deepwhite else 'compatible' if compatible else 'custom',
        'capabilities': rows,
        'connection_check': {k: v for k, v in (current_receipt or {}).items() if k != 'address_hash'} or None,
        'account_required_for_local_editing': False,
        'account_is_generation_credential': False,
        'notice': '网站登录管理账户；生成使用此平台单独配置的 API Key。模型列表测试不代表生成验收。',
    }


def install(app):
    @app.get('/api/studio/settings/provider-capabilities')
    async def capabilities():
        receipts = _receipts()
        return {'schema': 'deepwhite.provider-capabilities.v1',
                'providers': [describe(p, receipts.get(p['id'])) for p in core.load_api_providers()],
                'special_adapters': [
                    {'id': 'comfyui', 'label': '本地 ComfyUI', 'configuration': '使用本地引擎及工作流设置'},
                    {'id': 'dreamina', 'label': '即梦', 'configuration': '使用独立账号授权及模型设置'},
                    {'id': 'runninghub', 'label': 'RunningHub', 'configuration': '使用原版工作流/任务适配设置'},
                ]}
