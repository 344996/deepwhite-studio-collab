"""Per-account New API generation access; keys live only in the login session.

The on-disk binding contains a random installation name and token IDs, never a
password, website cookie or generation key. Token management is session-user
scoped. A timed-out create is reconciled by name, never blindly repeated.
"""
import hashlib
import json
import re
import secrets
import time
from pathlib import Path

from fastapi import HTTPException

import main as core
import studio_catalog as catalog
import studio_settings as settings

PREFIX = 'deepwhite-account-'
BASE_URL = 'https://api.deepwhiteai.com/v1'
ACTIVE = None
KEY_TRANSPORT = None  # offline model-list contract tests only


def managed(provider_id):
    return str(provider_id).startswith(PREFIX)


def provider_id(user_id):
    return PREFIX + hashlib.sha256(('deepwhite:' + str(user_id)).encode()).hexdigest()[:16]


def state_path():
    return Path(core.DATA_DIR) / 'studio_account_link.json'


def load_state():
    path = state_path()
    if not path.exists():
        return {'installation': secrets.token_hex(12), 'bindings': {}}
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or not re.fullmatch(r'[a-f0-9]{24}', str(data.get('installation', ''))):
        raise HTTPException(409, '本机账户连接记录需要修复，请保留数据并联系支持；其他手动 API 仍可使用。')
    if not isinstance(data.get('bindings'), dict):
        raise HTTPException(409, '本机账户连接记录格式不兼容，请保留数据并联系支持。')
    return data


def save_state(data):
    path = state_path()
    core._atomic_write_bytes(str(path), json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8'))


def provider_key(pid):
    """All old and new generation routes call the same fail-closed resolver."""
    s = ACTIVE
    if (not s or s.get('revoked') or s.get('expires', 0) <= time.time()
            or not s.get('user_id') or provider_id(s['user_id']) != pid):
        return ''
    provider = next((p for p in core.load_api_providers() if p['id'] == pid), None)
    if (not provider or provider.get('enabled') is False
            or provider.get('base_url', '').rstrip('/') != BASE_URL
            or provider.get('protocol') != 'openai'):
        return ''
    return s.get('generation_key', '')


def deactivate(session=None):
    global ACTIVE
    if session is not None:
        session.pop('generation_key', None)
        session['revoked'] = True
    if session is not None and ACTIVE is not session:
        return
    if ACTIVE:
        ACTIVE.pop('generation_key', None)
    ACTIVE = None
    providers = core.load_api_providers()
    changed = False
    for item in providers:
        if managed(item['id']) and (item.get('enabled') or item.get('primary')):
            item.update(enabled=False, primary=False)
            changed = True
    if changed:
        core.save_api_providers(providers)


def status(session):
    data = dict(session.get('generation') or {
        'status': 'action_required',
        'message': '账户已登录，官方 API 尚未完成配置。点击重新连接可重试。',
        'retryable': True,
    })
    if session.get('user_id'):
        data['provider_id'] = provider_id(session['user_id'])
    if data['status'] == 'ready' and not provider_key(data.get('provider_id')):
        data.update(status='action_required', message='官方生成授权已失效，请重新登录或连接。', retryable=True)
    return data


def parse_rows(data):
    rows = data if isinstance(data, list) else data.get('items', data.get('data')) if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, 'API 网站的令牌列表格式暂不兼容，请在网站创建密钥后通过自选 API 配置。')
    return [row for row in rows if isinstance(row, dict)]


def full_key(data):
    key = data.get('key') if isinstance(data, dict) else ''
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,256}', key):
        raise HTTPException(502, 'API 网站未提供可用的生成授权。请在网站检查令牌权限，或使用自选 API。')
    return key if key.startswith('sk-') else 'sk-' + key


async def token_for(session, call, state, pid):
    name = 'DeepWhite Studio ' + state['installation'][:12]
    binding = state['bindings'].setdefault(pid, {})
    # Search is user-scoped and returns only this installation's exact name.
    rows = parse_rows(await call(session, 'GET', f'/api/token/search?keyword={name.replace(" ", "%20")}&p=1&page_size=100'))
    matches = [row for row in rows if row.get('name') == name]
    token = next((row for row in matches if row.get('id') == binding.get('token_id')), None)
    if token is None and matches:
        token = max(matches, key=lambda row: int(row.get('id', 0)))
    if token is None:
        if binding.get('create_pending'):
            raise HTTPException(409, '上次创建授权的结果尚未确认，已停止重复创建。请稍后重新连接，或到 API 网站检查名为 DeepWhite Studio 的令牌。')
        binding['create_pending'] = True
        save_state(state)
        try:
            await call(session, 'POST', '/api/token/', {
                'name': name, 'expired_time': -1, 'remain_quota': 0,
                'unlimited_quota': True, 'model_limits_enabled': False,
                'model_limits': '', 'allow_ips': '', 'group': '',
                'allow_user_quota_query': True,
            })
        except HTTPException as exc:
            # A definite 4xx rejection did not create a token. Network/5xx errors
            # are ambiguous and retain the pending receipt for reconciliation.
            if 400 <= exc.status_code < 500:
                binding.pop('create_pending', None)
                save_state(state)
            raise
        rows = parse_rows(await call(session, 'GET', f'/api/token/search?keyword={name.replace(" ", "%20")}&p=1&page_size=100'))
        token = next((row for row in rows if row.get('name') == name), None)
        if not token:
            raise HTTPException(502, '授权创建已提交，网站暂未返回记录。请稍后重新连接；不会重复创建令牌。')
    tid = token.get('id')
    if not isinstance(tid, int) or isinstance(tid, bool) or tid <= 0:
        raise HTTPException(502, 'API 网站返回的授权编号不兼容，请使用自选 API。')
    if str(token.get('user_id', session['user_id'])) != str(session['user_id']):
        raise HTTPException(403, '网站返回的授权账户不匹配，已停止自动配置。')
    binding.update(token_id=tid, create_pending=False)
    save_state(state)
    if token.get('status', 1) != 1 or (token.get('expired_time', -1) not in (-1, 0) and token['expired_time'] <= time.time()):
        raise HTTPException(409, '此画布的 API 令牌已被停用或过期。请在 API 网站检查后重新连接；不会自动重新启用。')
    # New API masks list/get responses; its dedicated key endpoint returns full
    # generation access. Older deployments returned an unmasked key on GET.
    try:
        key_data = await call(session, 'POST', f'/api/token/{tid}/key')
    except HTTPException as exc:
        if exc.status_code not in (404, 405):
            raise
        key_data = await call(session, 'GET', f'/api/token/{tid}')
    return full_key(key_data)


async def provision(session, call):
    """Called under studio_account.FLOW_LOCK; failure never undoes site login."""
    global ACTIVE
    pid = provider_id(session['user_id'])
    reconnecting = ACTIVE is session and bool(session.get('generation_key'))
    try:
        state = load_state()
        save_state(state)
        key = await token_for(session, call, state, pid)
        session['generation_key'] = key
        session.pop('revoked', None)
        ACTIVE = session
        providers = core.load_api_providers()
        saved = next((p for p in providers if p['id'] == pid), {})
        provider = core.normalize_provider({
            **saved, 'id': pid, 'name': 'DeepWhite API · 登录账户',
            'base_url': BASE_URL, 'protocol': 'openai',
            'image_request_mode': 'openai', 'enabled': True,
            'primary': bool(saved.get('primary')) if reconnecting else True,
        })
        providers = [{**p, **({'enabled': False, 'primary': False} if managed(p['id'])
                             else {'primary': False} if provider['primary'] else {})}
                     for p in providers if p['id'] != pid]
        core.save_api_providers([provider, *providers])
        try:
            result = await settings.synchronize_provider(core.ApiProviderPayload(**provider), transport=KEY_TRANSPORT, managed_ok=True)
            session['generation'] = {
                'status': 'ready', 'provider_id': pid,
                'model_count': sum(catalog.active(m) for m in result['models']),
                'message': '官方 API 和模型已自动配置，可以回到画布生成。', 'retryable': True,
            }
        except HTTPException as exc:
            session['generation'] = {
                'status': 'models_pending', 'provider_id': pid, 'model_count': 0,
                'message': '生成授权已连接，模型同步未完成：' + str(exc.detail),
                'retryable': True,
            }
    except (HTTPException, OSError, ValueError, TypeError) as exc:
        session.pop('generation_key', None)
        if ACTIVE is session:
            ACTIVE = None
        message = str(exc.detail) if isinstance(exc, HTTPException) else '本机连接记录暂时无法保存，请检查数据目录后重试。'
        session['generation'] = {
            'status': 'action_required', 'provider_id': pid, 'model_count': 0,
            'message': '账户已登录，官方 API 自动连接未完成。' + message,
            'retryable': True,
        }
    return status(session)
