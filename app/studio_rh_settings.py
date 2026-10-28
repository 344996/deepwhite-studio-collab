"""U07 (handover 2026-10-26): RunningHub credentials, status and defaults live in Settings.

There is still one RunningHub provider entry and one pair of keys (stored the same way as the
advanced provider page); this module only gives Settings a focused view of them. Keys are never
returned. Defaults apply to RH nodes created afterwards; existing nodes and tasks keep their values.
"""
import json
import os
import threading
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel

import main as core

LOCK = threading.Lock()
DEFAULTS = {'default_payment': 'free', 'default_instance': ''}


class RunningHubSettings(BaseModel):
    api_key: str | None = None
    wallet_api_key: str | None = None
    clear_key: bool = False
    clear_wallet_key: bool = False
    default_payment: str | None = None
    default_instance: str | None = None


def path():
    return Path(core.DATA_DIR) / 'studio_rh_settings.json'


def defaults():
    try:
        value = json.loads(path().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        value = {}
    return {**DEFAULTS, **{k: v for k, v in (value if isinstance(value, dict) else {}).items() if k in DEFAULTS}}


def provider():
    try:
        return core.get_api_provider_exact('runninghub')
    except HTTPException:
        return None


def status():
    saved = provider()
    return {**defaults(), 'base_url': (saved or {}).get('base_url') or core.RUNNINGHUB_DEFAULT_BASE_URL,
            'has_key': bool(core.provider_env_key_value('runninghub')),
            'has_wallet_key': bool(core.runninghub_wallet_key_value()),
            'enabled': bool(saved and saved.get('enabled', True))}


def save(payload):
    if payload.default_payment not in (None, 'free', 'wallet'):
        raise HTTPException(400, '默认扣费方式只能是会员积分（free）或钱包余额（wallet）。')
    if payload.default_instance not in (None, '', 'plus'):
        raise HTTPException(400, '默认实例类型只能是标准或 plus。')
    updates = {}
    for value, clear, env in ((payload.api_key, payload.clear_key, core.provider_key_env('runninghub')),
                              (payload.wallet_api_key, payload.clear_wallet_key, core.runninghub_wallet_key_env())):
        if clear:
            updates[env] = ''
        elif value is not None and value.strip():
            if len(value.strip()) > 512 or any(ch.isspace() for ch in value.strip()):
                raise HTTPException(400, 'API Key 格式无效。')
            updates[env] = value.strip()
    with LOCK:
        providers = core.load_api_providers()
        if not any(p['id'] == 'runninghub' for p in providers):
            providers.append(core.normalize_provider({'id': 'runninghub', 'name': 'RunningHub', 'protocol': 'runninghub',
                                                      'base_url': core.RUNNINGHUB_DEFAULT_BASE_URL, 'enabled': True}))
            core.save_api_providers(providers)
        current = defaults()
        for key in DEFAULTS:
            value = getattr(payload, key)
            if value is not None:
                current[key] = value
        target = path()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps(current, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, target)
        if updates:
            core.update_env_values(updates)
            core.reload_env_globals()
    state = status()
    message = '已保存。画布中的 RH 节点使用同一份密钥；默认设置只影响之后新建的 RH 节点。'
    if state['default_payment'] == 'wallet' and not state['has_wallet_key']:
        message += '注意：默认扣费方式是钱包余额，但还没有保存钱包 Key，新建的 RH 节点在提交时会被拦下。'
    return {**state, 'message': message}


def _reach(meta):
    errors = ' '.join(str(item) for item in meta.get('errors') or []).lower()
    return 'timeout' if 'timed out' in errors or 'timeout' in errors else 'unreachable'


async def check():
    """Probe each saved key on its own: a missing key, a refused key (401/403) and an unreachable or
    timed-out service are different answers. Only the model catalogue is read; nothing is submitted."""
    state = status()
    keys = (('member', '会员积分 Key', core.provider_env_key_value('runninghub')),
            ('wallet', '钱包 Key', core.runninghub_wallet_key_value()))
    if not any(value for _, _, value in keys):
        return {'ok': False, 'missing': True, 'checks': [],
                'message': '尚未保存 RunningHub Key：请先填写会员积分 Key（使用钱包余额时再填钱包 Key），保存后再测试。'}
    checks = []
    for key_id, label, value in keys:
        if not value:
            checks.append({'key': key_id, 'label': label, 'saved': False})
            continue
        payload = await core.runninghub_models_payload({'id': 'runninghub', 'name': 'RunningHub', 'protocol': 'runninghub',
                                                        'base_url': state['base_url'], 'api_key': value, 'wallet_api_key': value})
        meta = payload.get('raw') or {}
        stages = core.runninghub_connection_stages(meta)
        if not stages['service']:
            stages['reach'] = _reach(meta)
        checks.append({'key': key_id, 'label': label, 'saved': True, 'stages': stages})
    saved = [item for item in checks if item['saved']]
    failed = [item for item in saved if item['stages']['auth'] == 'failed']
    unreached = [item for item in saved if not item['stages']['service']]
    if failed:
        message = '、'.join(item['label'] for item in failed) + ' 鉴权未通过（HTTP ' + '/'.join(
            str(item['stages']['auth_status']) for item in failed) + '）：Key 无效、已过期或没有权限。'
    elif unreached:
        message = ('连接 RunningHub 超时' if any(item['stages'].get('reach') == 'timeout' for item in unreached)
                   else '无法连接 RunningHub') + '：请检查网络或代理后重试。'
    elif all(item['stages']['auth'] == 'ok' for item in saved):
        message = '鉴权通过：' + '、'.join(item['label'] for item in saved) + '。具体应用或工作流的运行权限要在提交时才能确认。'
    else:
        message = '未能核实鉴权：RunningHub 没有给出明确结果，请稍后重试。'
    return {'ok': bool(saved) and all(item['stages']['auth'] == 'ok' for item in saved), 'missing': False,
            'checks': checks, 'message': message}


def install(app):
    @app.get('/api/studio/settings/runninghub')
    async def get_settings():
        return status()

    @app.post('/api/studio/settings/runninghub/test')
    async def test_settings():
        return await check()

    @app.put('/api/studio/settings/runninghub')
    async def put_settings(payload: RunningHubSettings):
        return save(payload)
