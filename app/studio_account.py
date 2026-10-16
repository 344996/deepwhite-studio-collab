"""API-site account bridge. Upstream cookies stay in expiring process memory."""
import secrets
import time
import math
from urllib.parse import urljoin, urlparse
import httpx
from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, Field

ORIGIN = 'https://api.deepwhiteai.com'
SESSIONS = {}
COOKIE = 'deepwhite_account'
TRANSPORT = None  # injectable for offline contract tests

class Login(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)

class Code(BaseModel):
    code: str = Field(min_length=6, max_length=32)

async def call(session, method, path, body=None):
    headers = {'Accept':'application/json'}
    if session.get('user_id'): headers['New-Api-User'] = str(session['user_id'])
    try:
        async with httpx.AsyncClient(base_url=ORIGIN, cookies=session['cookies'], headers=headers,
                                    timeout=15, follow_redirects=False, transport=TRANSPORT) as client:
            r = await client.request(method, path, json=body)
            if r.status_code in (401,403): raise HTTPException(r.status_code, '账号未登录、登录已失效，或网站限制了此请求。请重新登录或前往 API 网站。')
            r.raise_for_status()
            data = r.json()
            if not isinstance(data,dict) or data.get('success') is not True:
                raise HTTPException(400, '网站未接受此操作，请检查账号、密码或验证码；也可前往 API 网站登录。')
            session['cookies'] = client.cookies
            return data.get('data') or {}
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, '暂时无法连接 API 账号服务，请稍后重试。')

def current(request):
    now=time.time()
    for key in list(SESSIONS):
        if SESSIONS[key]['expires'] < now: SESSIONS.pop(key,None)
    s=SESSIONS.get(request.cookies.get(COOKIE,''))
    if not s: raise HTTPException(401,'请登录你的 DeepWhite API 账号。')
    return s

def accept(s, user):
    if not isinstance(user,dict) or not str(user.get('id','')).isdigit():
        raise HTTPException(502,'账号服务返回格式不兼容。')
    if user.get('status',1)!=1: raise HTTPException(403,'此账号当前不可用。')
    s['user_id']=user['id']

def wallet(user, config):
    result={'username':str(user.get('display_name') or user.get('username') or '')[:80], 'balance':None,'symbol':'','quota':user.get('quota')}
    avatar=user.get('avatar_url') or user.get('avatar') or user.get('picture')
    if isinstance(avatar,str):
        url=urljoin(ORIGIN,avatar)
        parsed=urlparse(url)
        if parsed.scheme=='https' and parsed.hostname and not parsed.username and not parsed.password:
            result['avatar_url']=url
    try:
        unit=float(config['quota_per_unit']);quota=float(user['quota'])
        mode=config.get('quota_display_type','USD').upper()
        rate=1 if mode=='USD' else float(config['usd_exchange_rate'] if mode=='CNY' else config['custom_currency_exchange_rate'])
        symbol={'USD':'$','CNY':'¥'}.get(mode,config.get('custom_currency_symbol',''))
        if config.get('display_in_currency') is not False and unit>0 and rate>0 and symbol and all(math.isfinite(v) for v in [unit,quota,rate]):
            result.update(balance=quota/unit*rate,symbol=symbol[:4])
    except (KeyError,ValueError,TypeError,AttributeError): pass
    return result

def install(app):
    @app.post('/api/studio/account/login')
    async def login(payload:Login, request:Request, response:Response):
        s={'cookies':httpx.Cookies(),'expires':time.time()+12*3600}
        data=await call(s,'POST','/api/user/login?turnstile=',payload.model_dump())
        two=data.get('require_2fa') is True
        if not two: accept(s,data)
        SESSIONS.pop(request.cookies.get(COOKIE,''),None)
        sid=secrets.token_urlsafe(32);SESSIONS[sid]=s
        response.set_cookie(COOKIE,sid,httponly=True,samesite='strict',max_age=12*3600)
        return {'ok':True,'two_factor':two}

    @app.post('/api/studio/account/verify')
    async def verify(payload:Code,request:Request):
        s=current(request);accept(s,await call(s,'POST','/api/user/login/2fa',payload.model_dump()))
        return {'ok':True}

    @app.get('/api/studio/account')
    async def account(request:Request):
        s=current(request)
        if not s.get('user_id'): raise HTTPException(401,'请完成两步验证。')
        user=await call(s,'GET','/api/user/self');accept(s,user)
        try: config=await call(s,'GET','/api/status')
        except HTTPException: config={}
        return wallet(user,config)

    @app.post('/api/studio/account/logout')
    async def logout(request:Request,response:Response):
        s=SESSIONS.pop(request.cookies.get(COOKIE,''),None)
        if s:
            try: await call(s,'GET','/api/user/logout')
            except HTTPException: pass
        response.delete_cookie(COOKIE)
        return {'ok':True}

_legacy_install = install

def install(app):
    _legacy_install(app)
    import studio_account_extension
    studio_account_extension.install(app)
