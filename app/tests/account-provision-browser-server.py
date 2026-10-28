"""Browser fixture: real local account/settings handlers, synthetic upstream only."""
import os
# Old smart canvases are seeded here only to stand in for existing user data (U10).
os.environ.setdefault('DEEPWHITE_STUDIO_LEGACY_SMART_FIXTURES', '1')
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import studio_server
import studio_account
import studio_account_provision
import studio_catalog
import uvicorn

state = {'token': None, 'creates': 0, 'generation_requests': 0, 'models_fail': False}
raw = json.loads(studio_catalog.SNAPSHOT.read_text(encoding='utf-8'))
models = ['deepwhiteai-image-g2-t2i', 'deepwhiteai-image-g2-i2i', 'deepseek-chat']
credential = 'sk-browser-fixture-only-123456789'


def upstream(request):
    path = request.url.path
    data = {}
    if path == '/api/user/login':
        data = {'id': 42, 'status': 1}
    elif path == '/api/user/self':
        data = {'id': 42, 'username': '测试账户', 'quota': 1000}
    elif path == '/api/status':
        data = {'quota_per_unit': 100, 'quota_display_type': 'CNY', 'usd_exchange_rate': 7,
                'register_enabled': True, 'password_register_enabled': True, 'email_verification': False}
    elif path == '/api/user/logout':
        pass
    elif path == '/api/token/search':
        data = {'items': [state['token']] if state['token'] else []}
    elif path == '/api/token/' and request.method == 'POST':
        state['creates'] += 1
        state['token'] = {'id': 100, 'user_id': 42, 'name': json.loads(request.content)['name'],
                          'status': 1, 'expired_time': -1, 'key': 'sk-****'}
    elif path == '/api/token/100/key':
        data = {'key': credential}
    elif path == '/v1/models':
        if state['models_fail']:
            return httpx.Response(503, json={'error': 'fixture models unavailable'})
        return httpx.Response(200, json={'data': [{'id': model} for model in models]})
    elif path == '/api/pricing':
        return httpx.Response(200, json=raw)
    elif path == '/api/usage/wallet/':
        return httpx.Response(200, json={'code': True, 'data': {'amount': 70, 'display_type': 'CNY'}})
    else:
        if request.method == 'POST':
            state['generation_requests'] += 1
        return httpx.Response(503, json={'error': 'External requests disabled in fixture'})
    return httpx.Response(200, json={'success': True, 'data': data},
                          headers={'set-cookie': 'session=browser-fixture-only; Path=/'})


transport = httpx.MockTransport(upstream)
studio_account.TRANSPORT = studio_account_provision.KEY_TRANSPORT = transport
Client = httpx.AsyncClient


def offline_client(*args, **kwargs):
    kwargs['transport'] = transport
    return Client(*args, **kwargs)


httpx.AsyncClient = offline_client


@studio_server.app.get('/__fixture/state')
async def fixture_state():
    return {'creates': state['creates'], 'generation_requests': state['generation_requests']}


@studio_server.app.post('/__fixture/models-failure/{fail}')
async def fixture_failure(fail: int):
    state['models_fail'] = bool(fail)
    return {'ok': True}


uvicorn.run(studio_server.app, host='127.0.0.1', port=int(os.environ['DEEPWHITE_STUDIO_PORT']))
