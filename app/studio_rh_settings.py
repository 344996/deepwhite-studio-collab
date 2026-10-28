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
    return {**status(), 'message': '已保存。画布中的 RH 节点使用同一份密钥；默认设置只影响之后新建的 RH 节点。'}


def install(app):
    @app.get('/api/studio/settings/runninghub')
    async def get_settings():
        return status()

    @app.put('/api/studio/settings/runninghub')
    async def put_settings(payload: RunningHubSettings):
        return save(payload)
