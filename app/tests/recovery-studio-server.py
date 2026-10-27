"""Test-only studio process for crash and network-loss recovery.

The real app runs unchanged, except that requests to api.deepwhiteai.com and the fake CDN travel over
real sockets to tests/recovery-upstream.py, so killing this process leaves them in flight upstream.
Every other outbound host is refused. The DeepWhite provider and its key are fixtures; nothing is
billed anywhere.
"""
import base64
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx

UPSTREAM = 'http://127.0.0.1:%s' % os.environ['RECOVERY_UPSTREAM_PORT']
FORWARD = {'api.deepwhiteai.com', 'cdn.recovery.invalid'}
OFFLINE = Path(os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']) / 'recovery-offline'
_Real = httpx.AsyncClient


async def forward(request):
    if request.url.host not in FORWARD:
        return httpx.Response(503, json={'error': 'External traffic disabled in recovery fixture'})
    if OFFLINE.exists():
        # What a dead network raises: the connection never opens, so nothing was sent.
        raise httpx.ConnectError('network is unreachable', request=request)
    path = request.url.raw_path.decode()
    if request.url.host == 'cdn.recovery.invalid':
        path = path.replace('/upload/', '/media/upload-')
    # No timeout: a hanging upstream must stay in flight until the test kills this process.
    async with _Real(timeout=None) as client:
        response = await client.request(request.method, UPSTREAM + path, content=request.content,
                                        headers={k: v for k, v in request.headers.items() if k.lower() not in ('host', 'content-length')})
        return httpx.Response(response.status_code, headers={'content-type': response.headers.get('content-type', '')}, content=response.content)


def client(*args, **kwargs):
    kwargs['transport'] = httpx.MockTransport(forward)
    return _Real(*args, **kwargs)


httpx.AsyncClient = client

import studio_server
import main
import studio_catalog as catalog
import uvicorn

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')
BASE = 'https://api.deepwhiteai.com/v1'
main.save_api_providers([main.normalize_provider({'id': 'dw', 'name': 'DeepWhite fixture', 'base_url': BASE, 'enabled': True,
                                                   'primary': True, 'protocol': 'openai'})])
_key = main.provider_env_key_value
main.provider_env_key_value = lambda pid: 'fixture-key' if pid == 'dw' else _key(pid)
# The MJ path needs its actions in a synced catalogue; the generic path resolves from it too.
catalog.save_store({'dw': {'base_url': BASE, 'models': catalog.build_catalog(['deepwhiteai-image-g-v2.5-lowprice', 'midjourney-imagine'])}})
storage = Path(main.storage_kind_dir('generated'))
storage.mkdir(parents=True, exist_ok=True)
(storage / 'recovery-ref.png').write_bytes(PNG)
uvicorn.run(studio_server.app, host='127.0.0.1', port=int(os.environ['DEEPWHITE_STUDIO_PORT']))
