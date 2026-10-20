"""Registration and per-provider balance extension for studio_account."""
import asyncio
import hashlib
import math
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

import studio_account as account

VERIFICATION_COOLDOWN = 60
VERIFICATION_REQUESTS = {}


class Registration(BaseModel):
    username: str = Field(min_length=1, max_length=20)
    password: str = Field(min_length=8, max_length=20)
    confirm_password: str = Field(min_length=8, max_length=20)
    email: str = Field(default='', max_length=254)
    verification_code: str = Field(default='', max_length=32)
    agree_terms: bool = False
    agree_privacy: bool = False


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _capabilities(data):
    register = data.get('register_enabled', data.get('password_register_enabled', False)) is True
    password = data.get('password_register_enabled', data.get('register_enabled', False)) is True
    turnstile = data.get('turnstile_check') is True
    return {'registration_available': register and password and not turnstile,
            'register_enabled': register, 'password_register_enabled': password,
            'email_verification': data.get('email_verification') is True,
            'turnstile_check': turnstile,
            'user_agreement_enabled': data.get('user_agreement_enabled') is True,
            'privacy_policy_enabled': data.get('privacy_policy_enabled') is True}


def _error_for(status, data=None):
    message = ''
    if isinstance(data, dict):
        message = str(data.get('message') or data.get('msg') or data.get('detail') or '')[:300].lower()
    if status == 429 or any(v in message for v in ('too many', 'rate limit', '频繁', '稍后再试')):
        return HTTPException(429, '操作过于频繁，请稍后重试。')
    if status in (401, 403):
        return HTTPException(status, '账号验证失败或网站限制了此操作，请检查账号状态后重试。')
    if status in (404, 405):
        return HTTPException(status, 'API 网站暂未提供此授权接口。可使用自选 API，或联系网站管理员开启兼容接口。')
    if any(v in message for v in ('disabled', 'not allowed', '关闭注册', '禁止注册')):
        return HTTPException(403, 'API 网站当前未开放此注册方式。')
    if any(v in message for v in ('already exists', 'duplicate', '已存在', '已注册', '重复')):
        return HTTPException(409, '用户名或邮箱已被使用，请更换后重试。')
    if any(v in message for v in ('expired', '过期', '已失效')):
        return HTTPException(400, '验证码已过期，请重新获取验证码。')
    if any(v in message for v in ('verification', 'verify', '验证码', 'invalid code', 'incorrect code')):
        return HTTPException(400, '验证码无效，请检查最新邮件中的验证码。')
    if any(v in message for v in ('password', '密码')):
        return HTTPException(400, '密码不符合 API 网站要求，请检查后重试。')
    if any(v in message for v in ('username', '用户名')):
        return HTTPException(400, '用户名不符合 API 网站要求，请检查后重试。')
    if any(v in message for v in ('email', '邮箱')):
        return HTTPException(400, '邮箱无效或尚未通过验证，请检查后重试。')
    if status >= 500:
        return HTTPException(502, 'API 账号服务暂时不可用，请稍后重试。')
    return HTTPException(400, 'API 网站未接受此操作，请检查输入后重试。')


async def _safe_call(session, method, path, body=None, params=None):
    headers = {'Accept': 'application/json'}
    if session.get('user_id'):
        headers['New-Api-User'] = str(session['user_id'])
    try:
        async with httpx.AsyncClient(base_url=account.ORIGIN, cookies=session.get('cookies', httpx.Cookies()),
                                     headers=headers, timeout=15, follow_redirects=False,
                                     transport=account.TRANSPORT) as client:
            response = await client.request(method, path, json=body, params=params)
            try:
                data = response.json()
            except ValueError:
                data = {}
            if response.status_code >= 400:
                raise _error_for(response.status_code, data)
            if not isinstance(data, dict) or data.get('success') is not True:
                raise _error_for(400, data)
            session['cookies'] = client.cookies
            value = data.get('data')
            return value if isinstance(value, (dict, list)) else {}
    except HTTPException:
        raise
    except httpx.HTTPError:
        raise HTTPException(502, '暂时无法连接 API 账号服务，请稍后重试。')


def _amount(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _balance_item(provider_id, name, status, balance=None, unit='', message=''):
    return {'id': provider_id, 'name': str(name or provider_id)[:100], 'status': status,
            'balance': balance if isinstance(balance, (int, float)) and math.isfinite(balance) else None,
            'unit': str(unit or '')[:16], 'updated_at': _now_iso(), 'message': str(message or '')[:180]}


async def _deepwhite_key_balance(provider):
    if urlparse(str(provider.get('base_url') or '')).hostname != 'api.deepwhiteai.com':
        return _balance_item(provider.get('id'), provider.get('name'), 'unsupported', message='未发现此渠道的受支持余额查询接口。')
    if provider.get('enabled') is False:
        return _balance_item(provider.get('id'), provider.get('name'), 'unsupported', message='此渠道已停用。')
    try:
        import main as core
        key = core.provider_env_key_value(provider.get('id'))
    except Exception:
        key = ''
    if not key:
        return _balance_item(provider.get('id'), provider.get('name'), 'unsupported', message='尚未配置 API Key，无法查询钱包余额。')
    try:
        async with httpx.AsyncClient(base_url=account.ORIGIN, timeout=15, follow_redirects=False, transport=account.TRANSPORT) as client:
            response = await client.get('/api/usage/wallet/', headers={'Accept': 'application/json', 'Authorization': f'Bearer {key}'})
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if response.status_code >= 400 or not isinstance(payload, dict) or payload.get('code') is False:
            return _balance_item(provider.get('id'), provider.get('name'), 'error', message='DeepWhite API Key 钱包查询失败，请检查密钥或稍后重试。')
        data = payload.get('data') if isinstance(payload.get('data'), dict) else {}
        amount, unit = _amount(data.get('amount')), data.get('display_type') or 'CNY'
        if amount is not None:
            return _balance_item(provider.get('id'), provider.get('name'), 'available', amount, unit)
        return _balance_item(provider.get('id'), provider.get('name'), 'unsupported', unit=unit, message='余额接口未返回可展示的货币金额。')
    except httpx.HTTPError:
        return _balance_item(provider.get('id'), provider.get('name'), 'error', message='DeepWhite API Key 钱包暂时无法连接。')


def install(app):
    account.call = _safe_call

    @app.get('/api/studio/account/capabilities')
    async def capabilities():
        return _capabilities(await _safe_call({'cookies': httpx.Cookies()}, 'GET', '/api/status'))

    @app.get('/api/studio/account/verification')
    async def request_verification(email: str, turnstile: str = ''):
        now = time.time()
        for key, expiry in list(VERIFICATION_REQUESTS.items()):
            if expiry <= now:
                VERIFICATION_REQUESTS.pop(key, None)
        email = email.strip()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            raise HTTPException(422, '请输入有效邮箱地址。')
        status = _capabilities(await _safe_call({'cookies': httpx.Cookies()}, 'GET', '/api/status'))
        if not status['email_verification']:
            raise HTTPException(400, 'API 网站当前未启用邮箱验证码注册。')
        if status['turnstile_check']:
            raise HTTPException(400, 'API 网站要求安全验证，请前往网站完成注册。')
        key = hashlib.sha256(email.lower().encode('utf-8')).hexdigest()
        until = VERIFICATION_REQUESTS.get(key, 0)
        if until > now:
            wait = int(until - now + 0.999)
            raise HTTPException(429, f'请等待 {wait} 秒后再获取验证码。', headers={'Retry-After': str(wait)})
        await _safe_call({'cookies': httpx.Cookies()}, 'GET', '/api/verification', params={'email': email, 'turnstile': turnstile or ''})
        VERIFICATION_REQUESTS[key] = time.time() + VERIFICATION_COOLDOWN
        return {'ok': True, 'retry_after': VERIFICATION_COOLDOWN, 'message': '验证码已发送，请查收邮件。'}

    @app.post('/api/studio/account/register')
    async def register(payload: Registration):
        config = await _safe_call({'cookies': httpx.Cookies()}, 'GET', '/api/status')
        flags = _capabilities(config)
        if not flags['register_enabled'] or not flags['password_register_enabled']:
            raise HTTPException(403, 'API 网站当前未开放此注册方式。')
        if flags['turnstile_check']:
            raise HTTPException(400, 'API 网站要求安全验证，请前往网站完成注册。')
        if flags['email_verification'] and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', payload.email.strip()):
            raise HTTPException(422, '请输入有效邮箱地址。')
        if flags['email_verification'] and not payload.verification_code.strip():
            raise HTTPException(422, '请输入邮箱验证码。')
        if flags['user_agreement_enabled'] and not payload.agree_terms:
            raise HTTPException(422, '请先阅读并同意用户协议。')
        if flags['privacy_policy_enabled'] and not payload.agree_privacy:
            raise HTTPException(422, '请先阅读并同意隐私政策。')
        if payload.password != payload.confirm_password:
            raise HTTPException(422, '两次输入的密码不一致。')
        username = payload.username.strip()
        if not username or len(username) > 20:
            raise HTTPException(422, '用户名最多 20 个字符。')
        if len(payload.password.encode('utf-8')) > 72:
            raise HTTPException(422, '密码编码长度超出 API 网站支持范围。')
        body = {'username': username, 'password': payload.password, 'turnstile': '', 'aff_code': ''}
        if payload.email.strip():
            body['email'] = payload.email.strip()
        if payload.verification_code.strip():
            body['verification_code'] = payload.verification_code.strip()
        await _safe_call({'cookies': httpx.Cookies()}, 'POST', '/api/user/register', body=body, params={'turnstile': ''})
        return {'ok': True, 'message': '账号已创建，请使用新账号登录。'}

    @app.get('/api/studio/channel-balances')
    async def channel_balances(request: Request):
        import main as core
        rows = []
        for provider in core.load_api_providers():
            if not isinstance(provider, dict):
                continue
            provider_id, name = str(provider.get('id') or ''), provider.get('name')
            if provider.get('enabled') is False:
                rows.append(_balance_item(provider_id, name, 'unsupported', message='此渠道已停用。'))
            elif provider_id == 'deepwhiteai' or urlparse(str(provider.get('base_url') or '')).hostname == 'api.deepwhiteai.com':
                rows.append(await _deepwhite_key_balance(provider))
            else:
                rows.append(_balance_item(provider_id, name, 'unsupported', message='当前渠道未接入受支持的余额查询接口。'))
        try:
            import studio_dreamina
            state = await asyncio.to_thread(studio_dreamina.status)
            credit = _amount(state.get('credit'))
            if state.get('available') is True and state.get('enabled') is True and state.get('authenticated') is True and credit is not None:
                rows.append(_balance_item('dreamina-cli', '即梦 CLI', 'available', credit, '积分'))
            elif not (state.get('available') is True and state.get('enabled') is True):
                rows.append(_balance_item('dreamina-cli', '即梦 CLI', 'unsupported', message='即梦 CLI 通道未启用或尚未配置。'))
            else:
                rows.append(_balance_item('dreamina-cli', '即梦 CLI', 'error', message=state.get('error') or '即梦账号未登录或余额暂不可用。'))
        except Exception:
            rows.append(_balance_item('dreamina-cli', '即梦 CLI', 'error', message='即梦余额查询暂时不可用。'))
        session = account.SESSIONS.get(request.cookies.get(account.COOKIE, ''))
        if session and session.get('user_id'):
            try:
                user = await _safe_call(session, 'GET', '/api/user/self')
                config = await _safe_call(session, 'GET', '/api/status')
                value = account.wallet(user, config)
                if value['balance'] is not None:
                    rows.append(_balance_item('deepwhite-account', 'DeepWhite AI（登录账户）', 'available', value['balance'], value['symbol']))
                else:
                    rows.append(_balance_item('deepwhite-account', 'DeepWhite AI（登录账户）', 'unsupported', message='账号接口未提供可换算的余额信息。'))
            except HTTPException:
                rows.append(_balance_item('deepwhite-account', 'DeepWhite AI（登录账户）', 'error', message='登录账户余额暂时无法读取。'))
        return {'items': rows, 'updated_at': _now_iso()}
