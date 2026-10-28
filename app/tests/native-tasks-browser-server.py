"""Isolated native-task integration server. All upstream HTTP stays in MockTransport."""
import os
# Old smart canvases are seeded here only to stand in for existing user data (U10).
os.environ.setdefault('DEEPWHITE_STUDIO_LEGACY_SMART_FIXTURES', '1')
import asyncio
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import uvicorn
from fastapi import HTTPException
import studio_server
import studio_settings
import studio_catalog
import studio_pricing

runtime = Path(os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']).resolve()
assert runtime.name.startswith('dw-native-integration-'), 'Only an explicit temporary test runtime is allowed'
state_path = runtime / 'mock-upstream.json'
state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {
    'requests': [], 'videos': {}, 'chat_wait': False, 'pause_queries': False, 'archive_failures': 0,
}


def persist():
    temp = state_path.with_suffix('.tmp')
    temp.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
    os.replace(temp, state_path)


async def upstream(request):
    # Startup probes are simulated locally and may never contact a real Comfy service.
    if request.url.host in ('127.0.0.1', 'localhost') and request.method == 'GET' and request.url.path == '/system_stats':
        return httpx.Response(503, json={'error': 'Comfy probe disabled in native-task fixture'})
    if request.url.host not in ('native-fixture.invalid', 'native-assets.invalid'):
        raise AssertionError('Integration fixture forbids external traffic: ' + request.url.host)
    body = json.loads(request.content or b'{}') if request.method == 'POST' else None
    saved_attempt = None
    if request.method == 'POST':
        import studio_legacy_tasks
        import main as core
        local_id = studio_legacy_tasks._CONTEXT.get()
        if local_id:
            task = studio_legacy_tasks.read(local_id)
            if task and task.get('canvas_id'):
                canvas = core.load_canvas(task['canvas_id'])
                node = next((n for n in canvas.get('nodes', []) if n['id'] == task['node_id']), {})
                saved_attempt = (node.get('studioLegacyAttempts') or {}).get(task['request_id'])
    state['requests'].append({'method': request.method, 'host': request.url.host, 'path': request.url.path, 'body': body,
                              'saved_attempt': saved_attempt})
    persist()
    if request.url.host == 'native-assets.invalid':
        if state['archive_failures'] > 0:
            state['archive_failures'] -= 1
            persist()
            return httpx.Response(503, json={'error': 'fixture archive unavailable'})
        video_path = Path(os.environ['NATIVE_FIXTURE_VIDEO']).resolve()
        assert video_path.parent == runtime
        return httpx.Response(200, content=video_path.read_bytes(), headers={'Content-Type': 'video/webm'})
    if request.method == 'POST' and request.url.path.endswith('/chat/completions'):
        while state['chat_wait']:
            await asyncio.sleep(.02)
        text = str((body.get('messages') or [{}])[-1].get('content', ''))
        if '[EMPTY]' in text:
            return httpx.Response(200, json={'choices': []})
        if '[REJECT]' in text:
            return httpx.Response(503, json={'error': {'message': 'fixture chat unavailable'}})
        return httpx.Response(200, json={'id': 'fixture-chat', 'choices': [{'message': {'role': 'assistant', 'content': '离线生成结果：' + text}}], 'usage': {'total_tokens': 12}})
    if request.method == 'POST' and 'video' in request.url.path:
        task_id = 'fixture-video-' + str(len(state['videos']) + 1)
        state['videos'][task_id] = {'prompt': body.get('prompt', '')}
        persist()
        return httpx.Response(200, json={'id': task_id, 'status': 'queued'})
    if request.method == 'GET':
        match = re.search(r'fixture-video-\d+', str(request.url))
        task_id = match[0] if match else ''
        if task_id in state['videos']:
            if state['pause_queries']:
                return httpx.Response(200, json={'id': task_id, 'status': 'running'})
            return httpx.Response(200, json={'id': task_id, 'status': 'succeeded', 'video_url': 'https://native-assets.invalid/' + task_id + '.webm'})
    return httpx.Response(404, json={'error': 'Unknown fixture protocol'})


original_client = httpx.AsyncClient


def offline_client(*args, **kwargs):
    kwargs['transport'] = httpx.MockTransport(upstream)
    return original_client(*args, **kwargs)


httpx.AsyncClient = offline_client
snapshot = json.loads(studio_catalog.SNAPSHOT.read_text(encoding='utf-8'))


async def read_models(payload):
    if payload.base_url != 'https://native-fixture.invalid/v1' or payload.api_key != 'offline-native-fixture':
        raise HTTPException(400, 'Only the non-network fixture provider is allowed')
    records = [{'id': m['model_name']} for m in snapshot['data']]
    return {'model_records': records, 'models': records, 'model_count': len(records), 'message': '离线模拟渠道'}


async def metadata(base):
    return {m['model_name']: m for m in snapshot['data']}, {str(v['id']): v['name'] for v in snapshot['vendors']}


async def pricing_snapshot():
    return snapshot


studio_settings.read_models = read_models
studio_catalog.metadata = metadata
studio_pricing.snapshot = pricing_snapshot


@studio_server.app.get('/api/fixture/native-state')
async def read_state():
    return state


@studio_server.app.post('/api/fixture/native-state')
async def control_state(payload: dict):
    for key in ('chat_wait', 'pause_queries'):
        if key in payload:
            assert isinstance(payload[key], bool)
            state[key] = payload[key]
    if 'archive_failures' in payload:
        assert isinstance(payload['archive_failures'], int) and 0 <= payload['archive_failures'] <= 100
        state['archive_failures'] = payload['archive_failures']
    persist()
    return {'ok': True}


uvicorn.run(studio_server.app, host='127.0.0.1', port=int(os.environ['DEEPWHITE_STUDIO_PORT']))
