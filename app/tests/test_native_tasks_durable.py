"""Temporary ledgers, MockTransport and mocked CLI only. Never executes a provider."""
import asyncio
import hashlib
import json
import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

os.environ.setdefault('DEEPWHITE_STUDIO_RUNTIME_DIR', tempfile.mkdtemp(prefix='native-import-'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI
import main as core
import studio_catalog as catalog
import studio_generation as generation
import studio_legacy_tasks as ledger
import studio_native_tasks as native

REAL_CLIENT = httpx.AsyncClient


class NativeTasksTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-durable-')
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.temp.cleanup)
        self.provider = {'id': 'mock', 'base_url': 'https://mock.invalid', 'protocol': 'openai',
                         'chat_models': ['mock-chat'], 'video_models': ['mock-video']}
        self.key = 'mock-secret-key'
        self.stack.enter_context(patch.object(core, 'DATA_DIR', self.temp.name))
        self.stack.enter_context(patch.object(core, 'load_api_providers', side_effect=lambda: [self.provider]))
        self.stack.enter_context(patch.object(core, 'provider_env_key_value', side_effect=lambda _: self.key))
        self.stack.enter_context(patch.object(core, 'runninghub_wallet_key_value', return_value='mock-wallet-key'))
        self.stack.enter_context(patch.object(core, 'jimeng_env_value', return_value=''))
        self.stack.enter_context(patch.object(catalog, 'resolve_model', side_effect=lambda pid, model, kind, *args, **kw: model or 'mock-chat'))
        self.stack.enter_context(patch.object(core, 'output_path_for', side_effect=lambda name, *args: str(Path(self.temp.name) / name)))
        self.stack.enter_context(patch.object(core, 'output_url_for', side_effect=lambda name, *args: '/output/' + name))
        ledger._ACTIVE.clear(); ledger._VOLATILE.clear(); native.WORKERS.clear(); generation.WORKERS.clear()

    async def asyncTearDown(self):
        tasks = list(native.WORKERS.values()) + list(generation.WORKERS.values())
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        native.WORKERS.clear(); generation.WORKERS.clear(); ledger._ACTIVE.clear(); ledger._VOLATILE.clear()

    def payload(self, kind='video', request_id='request-A', **values):
        common = dict(request_id=request_id, canvas_id='A', node_id='source', output_node_id='output', output_slot_id='slot-A')
        common.update(values)
        if kind == 'llm':
            return core.CanvasLLMRequest(message=common.pop('message', 'hello mock'), provider='mock', model='mock-chat', **common)
        return core.CanvasVideoRequest(prompt=common.pop('prompt', 'video mock'), provider_id='mock', model=common.pop('model', 'mock-video'), **common)

    def begin(self, kind='video', **values):
        payload = self.payload(kind, **values)
        task_id = ledger.task_identity(kind, payload.request_id)
        result, _ = ledger.begin(kind, payload, execution=native.prepare(kind, payload, task_id))
        return result['id']

    def transport(self, handler):
        def client(*args, **kwargs):
            kwargs['transport'] = httpx.MockTransport(handler)
            return REAL_CLIENT(*args, **kwargs)
        return patch.object(httpx, 'AsyncClient', side_effect=client)

    async def settle(self, task_id):
        task = native.WORKERS.get(ledger._key(task_id))
        if task:
            await task
        return native.read(task_id, ledger.raw(task_id)['task_kind'])

    def receipt(self, task_id, protocol='video-generic', **fields):
        ledger.dispatch(task_id)
        with ledger.receipt_context(task_id):
            native.remember_video_receipt(protocol, 'remote-A', self.provider, base_url=self.provider['base_url'], **fields)
        ledger.release(task_id)

    async def test_identity_full_input_and_slot_conflict(self):
        payload = self.payload('llm')
        with patch.object(native, 'launch') as launch:
            # Close the unscheduled coroutine created by the test mock.
            launch.side_effect = lambda task_id, coro: coro.close()
            first = await native.create('llm', payload)
            second = await native.create('llm', payload)
        self.assertEqual(first['id'], second['id']); self.assertEqual(launch.call_count, 1)
        for field, value in [('message', 'different'), ('messages', [{'role':'user','content':'changed'}]),
                             ('images', ['/assets/new.png']), ('output_slot_id', 'slot-B'), ('canvas_id', 'B')]:
            with self.assertRaises(core.HTTPException) as exc:
                await native.create('llm', payload.model_copy(update={field:value}))
            self.assertEqual(exc.exception.status_code, 409)
        self.assertEqual(second['output_node_id'], 'output'); self.assertEqual(second['output_slot_id'], 'slot-A')
        self.assertNotIn('execution', second); self.assertNotIn(self.key, json.dumps(second))

    async def test_initial_write_failure_does_not_launch(self):
        with patch.object(ledger, '_write', side_effect=OSError('disk full')), patch.object(native, 'launch') as launch:
            with self.assertRaises(core.HTTPException) as exc:
                await native.create('video', self.payload())
        self.assertEqual(exc.exception.status_code, 503); launch.assert_not_called()

    async def test_unknown_or_disabled_provider_never_falls_back_or_dispatches(self):
        for kind in ('llm','video'):
            for disabled in (False,True):
                payload=self.payload(kind,request_id='invalid-'+kind+str(disabled))
                field='provider' if kind=='llm' else 'provider_id'
                if disabled:self.provider['enabled']=False
                else:payload=payload.model_copy(update={field:'deleted-channel'})
                with patch.object(native,'launch') as launch,patch.object(core,'get_api_provider') as fallback:
                    with self.assertRaises(core.HTTPException) as exc:await native.create(kind,payload)
                self.assertEqual(exc.exception.status_code,400);launch.assert_not_called();fallback.assert_not_called()
                self.provider.pop('enabled',None)

    async def test_dispatch_write_failure_does_not_call_builder(self):
        task_id = self.begin('llm')
        original = ledger._write
        def fail_claim(record):
            if record['dispatch_started']:
                raise OSError('claim disk fail')
            return original(record)
        with patch.object(ledger, '_write', side_effect=fail_claim), patch.object(core, 'canvas_llm', new_callable=AsyncMock) as generate:
            await native.run(task_id, 'llm')
        generate.assert_not_called(); self.assertEqual(native.read(task_id, 'llm')['status'], 'failed')

    async def test_committed_payload_not_mutable_input(self):
        task_id = self.begin('llm')
        async def generate(payload):
            self.assertEqual(payload.message, 'hello mock'); self.assertEqual(payload.output_slot_id, 'slot-A')
            return {'text':'actual answer','model':payload.model,'raw_usage':{'tokens':2},'custom':{'kept':True}}
        with patch.object(core, 'canvas_llm', side_effect=generate):
            await native.run(task_id, 'llm')
        ledger._ACTIVE.clear(); ledger._VOLATILE.clear()
        result = native.find('llm', 'request-A')
        self.assertEqual(result['status'], 'succeeded'); self.assertTrue(result['result']['custom']['kept'])

    async def test_binding_changed_endpoint_model_or_key_never_dispatches(self):
        for field in ('base_url', 'chat_models', 'key'):
            task_id = self.begin('llm', request_id='binding-' + field)
            previous = dict(self.provider); old_key = self.key
            if field == 'key': self.key = 'another-account-secret'
            else: self.provider[field] = 'https://different.invalid' if field == 'base_url' else ['changed-model']
            with patch.object(core, 'canvas_llm', new_callable=AsyncMock) as generate:
                await native.run(task_id, 'llm')
            generate.assert_not_called(); self.assertEqual(native.read(task_id, 'llm')['status'], 'failed')
            self.provider.clear(); self.provider.update(previous); self.key = old_key

    async def test_key_change_after_preparation_before_post_is_blocked(self):
        task_id = self.begin('llm')
        async def generate(payload):
            self.key = 'changed-secret'
            native.before_submit()
            self.fail('must not reach paid POST')
        with patch.object(core, 'canvas_llm', side_effect=generate):
            await native.run(task_id, 'llm')
        value = native.read(task_id, 'llm')
        self.assertEqual(value['status'], 'failed'); self.assertEqual(value['remote_status'], 'not_submitted')

    async def test_restart_without_receipt_never_replays(self):
        for dispatched in (False, True):
            task_id = self.begin('llm', request_id='restart-' + str(dispatched))
            if dispatched: ledger.dispatch(task_id)
            ledger.release(task_id)
            with patch.object(core, 'canvas_llm', new_callable=AsyncMock) as generate:
                value = native.read(task_id, 'llm')
            generate.assert_not_called()
            self.assertEqual(value['status'], 'uncertain' if dispatched else 'paused')
            self.assertIsNone(value['recovery_action']); self.assertFalse(value['processing'])

    async def test_llm_one_post_empty_and_async_id_are_not_success(self):
        for body in ({'choices':[{'message':{'content':''}}]}, {'data':{'id':'async-id'}}):
            calls = []
            def handler(request):
                calls.append(request); return httpx.Response(200, json=body)
            task_id = self.begin('llm', request_id='llm-' + str(len(body.get('data', {}))))
            with self.transport(handler):
                await native.run(task_id, 'llm')
            value = native.read(task_id, 'llm')
            self.assertEqual(len(calls), 1); self.assertEqual(value['status'], 'uncertain')
            self.assertIsNone(value['result']); self.assertIsNone(value['recovery_action'])

    async def test_llm_http_result_and_timeout_do_not_retry(self):
        for failure in (False, True):
            calls = []
            def handler(request):
                calls.append(request)
                if failure: raise httpx.ReadTimeout('timeout', request=request)
                return httpx.Response(200, json={'choices':[{'message':{'content':'real text'}}],'usage':{'tokens':3}})
            task_id = self.begin('llm', request_id='llm-http-' + str(failure))
            with self.transport(handler): await native.run(task_id, 'llm')
            value = native.read(task_id, 'llm')
            self.assertEqual(len(calls), 1); self.assertEqual(value['status'], 'uncertain' if failure else 'succeeded')
            if not failure: self.assertEqual(value['result']['text'], 'real text')

    async def test_video_ambiguous_json_html_5xx_only_one_post(self):
        for code, body in ((200, '<html>accepted?</html>'), (200, 'not json'), (502, '<html>gateway</html>')):
            task_id = self.begin(request_id='ambiguous-' + str(code) + '-' + str(len(body)))
            calls = []
            def handler(request):
                calls.append(request); return httpx.Response(code, text=body)
            with self.transport(handler): await native.run(task_id, 'video')
            self.assertEqual(len(calls), 1); self.assertEqual(native.read(task_id, 'video')['status'], 'uncertain')

    async def test_explicit_404_allows_next_endpoint_without_changing_payload(self):
        task_id = self.begin()
        posts = []
        def handler(request):
            posts.append(request)
            if len(posts) == 1: return httpx.Response(404, json={'error':'unsupported'})
            return httpx.Response(200, json={'video_url':'/output/mock.mp4'})
        with self.transport(handler): await native.run(task_id, 'video')
        self.assertEqual(len(posts), 2); self.assertEqual(posts[0].content, posts[1].content)
        self.assertEqual(native.read(task_id, 'video')['result']['videos'], ['/output/mock.mp4'])

    async def test_generic_receipt_written_before_first_poll_and_remote_result_before_archive(self):
        task_id = self.begin()
        def handler(request): return httpx.Response(200, json={'id':'upstream-1'})
        async def poll(*args):
            record = ledger.raw(task_id)
            self.assertEqual(record['receipt']['task_id'], 'upstream-1')
            self.assertTrue(record['dispatch_started'])
            return {'status':'succeeded','video_url':'https://cdn.invalid/video.mp4'}
        async def save(url, **kwargs):
            self.assertEqual(ledger.raw(task_id)['remote_result']['videos'], [url])
            self.assertEqual(ledger.raw(task_id)['remote_status'], 'succeeded')
            return '/output/video.mp4'
        with self.transport(handler), patch.object(core, 'wait_for_video_task', side_effect=poll), patch.object(core, 'save_remote_video_to_output', side_effect=save):
            await native.run(task_id, 'video')
        self.assertEqual(native.read(task_id, 'video')['status'], 'succeeded')

    async def test_receipt_write_failure_stops_poll_without_fallback(self):
        task_id = self.begin()
        original = ledger._write
        def write(record):
            if record.get('receipts'): raise OSError('receipt disk fail')
            original(record)
        calls = []
        def handler(request): calls.append(request); return httpx.Response(200,json={'id':'saved-in-memory'})
        with self.transport(handler), patch.object(ledger, '_write', side_effect=write), patch.object(core, 'wait_for_video_task', new_callable=AsyncMock) as poll:
            with self.assertRaises(OSError): await native.run(task_id, 'video')
        poll.assert_not_called(); self.assertEqual(len(calls), 1)
        self.assertEqual(ledger.raw(task_id)['receipt']['task_id'], 'saved-in-memory')

    async def test_real_archive_failure_retains_remote_result_and_resume_only_downloads(self):
        task_id = self.begin()
        calls = []
        broken = True
        def handler(request):
            calls.append(request)
            if request.method == 'POST': return httpx.Response(200,json={'id':'upstream','video_url':'https://cdn.invalid/result.mp4'})
            return httpx.Response(503 if broken else 200, content=b'fake video',headers={'content-type':'video/mp4'})
        with self.transport(handler): await native.run(task_id, 'video')
        value = native.read(task_id, 'video')
        self.assertEqual(value['status'], 'paused'); self.assertEqual(value['recovery_action'], 'archive_result')
        self.assertEqual(value['remote_status'], 'succeeded'); self.assertFalse(value['processing'])
        ledger._ACTIVE.clear(); ledger._VOLATILE.clear(); broken = False; calls.clear()
        with self.transport(handler):
            await native.resume(task_id); value = await self.settle(task_id)
        self.assertEqual(value['status'], 'succeeded'); self.assertEqual([r.method for r in calls], ['GET'])
        self.assertEqual(calls[0].url.host, 'cdn.invalid')
        self.assertTrue(value['result']['videos'][0].startswith('/output/'))

    async def test_public_read_hides_signed_result_urls_but_recovery_keeps_them(self):
        # F04 (2026-10-26 review): native.read() exposed X-Amz-Signature from remote_result.
        signed = 'https://cdn.invalid/result.mp4?X-Amz-Credential=cred1&X-Amz-Signature=sig123&X-Amz-Expires=600'
        task_id = self.begin()
        calls = []
        state = {'download': 403}
        def handler(request):
            calls.append(request)
            if request.method == 'POST': return httpx.Response(200, json={'id': 'upstream', 'video_url': signed})
            return httpx.Response(state['download'], content=b'fake video', headers={'content-type': 'video/mp4'})
        with self.transport(handler): await native.run(task_id, 'video')
        for download, outcome in ((403, 'paused'), (500, 'paused'), (200, 'succeeded')):
            state['download'] = download
            if download != 403:
                ledger._ACTIVE.clear(); ledger._VOLATILE.clear()
                with self.transport(handler):
                    await native.resume(task_id); await self.settle(task_id)
            value = native.read(task_id, 'video')
            self.assertEqual(value['status'], outcome)
            public = json.dumps(value, ensure_ascii=False)
            for leaked in ('X-Amz-Signature', 'sig123', 'cred1'):
                self.assertNotIn(leaked, public)
        self.assertEqual([r.method for r in calls].count('POST'), 1)
        downloads = [str(r.url) for r in calls if r.method == 'GET']
        self.assertTrue(downloads and all('X-Amz-Signature=sig123' in url for url in downloads),
                        'recovery must still download with the original signed URL')
        self.assertTrue(value['result']['videos'][0].startswith('/output/'))
        self.assertIn('sig123', json.dumps(ledger.raw(task_id), ensure_ascii=False), 'internal recovery data was discarded')

    async def test_known_receipt_query_resume_has_no_generation_post(self):
        task_id = self.begin(); self.receipt(task_id)
        calls = []
        def handler(request): calls.append(request); return httpx.Response(200,json={'status':'succeeded','video_url':'/output/existing.mp4'})
        with self.transport(handler): await native.resume(task_id); value = await self.settle(task_id)
        self.assertEqual(value['status'], 'succeeded'); self.assertEqual([r.method for r in calls], ['GET'])

    async def test_pending_resume_finishes_worker_and_stays_queryable(self):
        task_id = self.begin(); self.receipt(task_id)
        with self.transport(lambda req: httpx.Response(200,json={'status':'running'})):
            await native.resume(task_id); value = await self.settle(task_id)
        self.assertEqual(value['status'], 'paused'); self.assertFalse(value['processing'])
        self.assertEqual(value['recovery_action'], 'query_upstream')

    async def test_failed_remote_is_failed_not_unknown_or_retry(self):
        task_id = self.begin(); self.receipt(task_id)
        with self.transport(lambda req: httpx.Response(200,json={'status':'failed','message':'policy reject'})):
            await native.resume(task_id); value = await self.settle(task_id)
        self.assertEqual(value['status'], 'failed'); self.assertIsNone(value['recovery_action'])

    async def test_unknown_receipt_or_missing_receipt_resume_never_posts(self):
        for protocol in (None, 'unknown-protocol'):
            task_id = self.begin(request_id='unknown-' + str(protocol))
            if protocol: self.receipt(task_id, protocol)
            else: ledger.dispatch(task_id); ledger.release(task_id)
            with patch.object(httpx, 'AsyncClient') as client:
                with self.assertRaises(core.HTTPException): await native.resume(task_id)
            client.assert_not_called()

    async def test_resume_binding_change_and_restoration(self):
        task_id = self.begin(); self.receipt(task_id)
        self.key = 'new-account-key'
        with patch.object(httpx, 'AsyncClient') as client:
            with self.assertRaises(core.HTTPException): await native.resume(task_id)
        client.assert_not_called(); self.key = 'mock-secret-key'
        with self.transport(lambda req: httpx.Response(200,json={'status':'running'})):
            await native.resume(task_id); value = await self.settle(task_id)
        self.assertEqual(value['remote_status'], 'running')

    async def test_resume_lock_is_cross_process_os_lock_and_released(self):
        task_id = self.begin(); self.receipt(task_id)
        lock = native.recovery_lock(task_id)
        with self.assertRaises(core.HTTPException): native.recovery_lock(task_id)
        lock.close(); native.recovery_lock(task_id).close()

    async def test_all_http_protocol_recovery_paths_and_ids(self):
        for protocol, path in [('video-tudou','/v1/tasks/remote-A'), ('video-agnes','/agnesapi'),
                               ('video-grok','/v1/videos/remote-A'), ('video-runninghub','/query')]:
            task_id = self.begin(request_id=protocol)
            self.receipt(task_id, protocol, model='agnes-video-v2.0', video_id='remote-A' if protocol=='video-agnes' else '', query_url='https://mock.invalid/query')
            calls = []
            def handler(request):
                calls.append(request)
                if protocol=='video-tudou':
                    return httpx.Response(200,json={'data':{'status':'SUCCESS','result':{'video_url':'/output/mock.mp4'}}})
                return httpx.Response(200,json={'status':'SUCCESS','data':{'status':'SUCCESS','video_url':'/output/mock.mp4'},'video_url':'/output/mock.mp4'})
            with self.transport(handler): await native.resume(task_id); value = await self.settle(task_id)
            self.assertEqual(value['status'], 'succeeded', protocol); self.assertEqual(calls[0].url.path, path)
            if protocol=='video-runninghub': self.assertEqual(json.loads(calls[0].content), {'taskId':'remote-A'})
            else: self.assertEqual(calls[0].method, 'GET')
            if protocol=='video-agnes': self.assertEqual(calls[0].url.params['model_name'],'agnes-video-v2.0')

    async def test_grok_content_success_without_url_is_download_only(self):
        task_id = self.begin(); self.receipt(task_id, 'video-grok')
        with ledger.receipt_context(task_id): native.remember_video_result({'status':'completed'}, [], archive_mode='grok-content')
        calls = []
        def handler(request): calls.append(request); return httpx.Response(200,content=b'mock binary',headers={'content-type':'video/mp4'})
        with self.transport(handler): await native.resume(task_id); value = await self.settle(task_id)
        self.assertEqual(value['status'], 'succeeded'); self.assertEqual(len(calls),1)
        self.assertEqual(calls[0].url.path, '/v1/videos/remote-A/content'); self.assertEqual(calls[0].method,'GET')

    async def test_jimeng_pending_and_cached_result_query_or_archive_only(self):
        task_id = self.begin(); self.receipt(task_id, 'video-jimeng')
        with patch.object(core,'jimeng_query_result',AsyncMock(return_value={'submit_id':'remote-A'})) as query:
            await native.resume(task_id); value = await self.settle(task_id)
        query.assert_awaited_once_with('remote-A','video'); self.assertEqual(value['status'],'paused')
        raw={'submit_id':'remote-A','mock':'cached'}
        with ledger.receipt_context(task_id): native.remember_video_result(raw,['mock local'],archive_mode='jimeng')
        with patch.object(core,'jimeng_query_result',new_callable=AsyncMock) as query, patch.object(core,'jimeng_store_outputs',AsyncMock(return_value=['/output/cli.mp4'])) as store:
            await native.resume(task_id); value = await self.settle(task_id)
        query.assert_not_called(); store.assert_awaited_once_with(raw,'video',allow_query=False)
        self.assertEqual(value['result']['videos'],['/output/cli.mp4'])

    async def test_routes_capabilities_and_by_request_are_reads(self):
        app=FastAPI(); native.install(app)
        task_id=self.begin('llm'); ledger.dispatch(task_id); ledger.release(task_id)
        with patch.object(core,'canvas_llm',new_callable=AsyncMock) as generate:
            async with REAL_CLIENT(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                capabilities=await client.get('/api/canvas-native-tasks/capabilities')
                result=await client.get('/api/canvas-llm-tasks/by-request/request-A')
                by_id=await client.get('/api/canvas-llm-tasks/'+task_id)
        generate.assert_not_called(); self.assertEqual(capabilities.json()['version'],1)
        self.assertEqual(result.json()['task_id'],task_id); self.assertEqual(by_id.json()['status'],'uncertain')

    async def test_signed_result_handle_streams_only_links_stored_in_the_task(self):
        app=FastAPI(); native.install(app)
        signed='https://cdn.invalid/old.mp4?X-Amz-Signature=sig456'
        task_id=self.begin(); ledger.update(task_id,status='paused',result={'videos':[signed]}); ledger.release(task_id)
        handle=native.read(task_id,'video')['result']['videos'][0]
        fetched=[]
        def handler(request): fetched.append(str(request.url)); return httpx.Response(200,content=b'old video',headers={'content-type':'video/mp4'})
        with self.transport(handler):
            async with REAL_CLIENT(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                media=await client.get(handle)
                unknown=await client.get('/api/studio/task-media/'+task_id+'?u='+'0'*24)
        self.assertEqual((media.status_code,media.content,media.headers['content-type']),(200,b'old video','video/mp4'))
        self.assertEqual(fetched,[signed]); self.assertEqual(unknown.status_code,404)

    async def test_each_http_provider_receipt_precedes_actual_builder_poll(self):
        cases=[('agnes','agnes-video-v2.0',core.generate_agnes_video,'wait_for_agnes_video_task','video-agnes'),
               ('lingjing','mock-video',core.generate_lingjing_openai_video,'wait_for_video_task','video-generic'),
               ('yuli','veo3.1',core.generate_yuli_openai_video,'wait_for_video_task','video-generic'),
               ('tudou','sora2',core.generate_tudou_video,'tudou_wait_video_task','video-tudou'),
               ('grok','grok-imagine-video',core.generate_tudou_grok_video,'wait_for_video_task','video-grok'),
               ('rh','mock-video',core.generate_runninghub_video,'wait_for_runninghub_openapi_task','video-runninghub')]
        for name,model,builder,wait_name,protocol in cases:
            task_id=self.begin(request_id='initial-'+name,model=model)
            posts=[]
            def handler(request):
                posts.append(request)
                return httpx.Response(200,json={'id':'remote-A','task_id':'task-A','video_id':'video-A','taskId':'rh-A'})
            async def poll(*args,**kwargs):
                receipt=ledger.raw(task_id)['receipt']
                self.assertEqual(receipt['protocol'],protocol)
                if name=='agnes':
                    self.assertEqual(receipt['task_id'],'video-A');self.assertEqual(receipt['provider_task_id'],'task-A')
                return {'status':'succeeded','video_url':'/output/generated.mp4','data':{'status':'succeeded','result':{'video_url':'/output/generated.mp4'}}}
            async def execute(payload):
                if name=='rh':return await builder(payload,self.provider)
                async with httpx.AsyncClient() as client:
                    return await builder(client,payload,self.provider,self.provider['base_url'],model)
            with self.transport(handler),patch.object(core,wait_name,side_effect=poll) as wait,patch.object(core,'runninghub_model_definition',AsyncMock(return_value={'endpoint':'mock-video','params':[]})),patch.object(core,'canvas_video',side_effect=execute):
                await native.run(task_id,'video')
            value=native.read(task_id,'video')
            self.assertEqual(value['status'],'succeeded',(name,value.get('error')))
            wait.assert_awaited_once();self.assertEqual(len(posts),1);self.assertEqual(posts[0].method,'POST')
            self.assertEqual(ledger.raw(task_id)['remote_result']['videos'],['/output/generated.mp4'])

    async def test_jimeng_receipt_precedes_store_and_pending_shape_is_preserved(self):
        task_id=self.begin(model='seedance2.0',multimodal=False)
        async def store(raw,kind):
            self.assertEqual(ledger.raw(task_id)['receipt']['task_id'],'jimeng-A')
            raise core.JimengPendingError('jimeng-A','video',{'queue_position':2},raw)
        async def execute(payload):return await core.generate_jimeng_video(payload,self.provider)
        with patch.object(core,'run_jimeng_cli',AsyncMock(return_value={'submit_id':'jimeng-A'})) as cli,patch.object(core,'jimeng_store_outputs',side_effect=store),patch.object(core,'canvas_video',side_effect=execute):
            await native.run(task_id,'video')
        value=native.read(task_id,'video')
        self.assertEqual(cli.await_count,1,value.get('error'));self.assertTrue(value['result']['jimeng_pending'])
        self.assertEqual(value['result']['submit_id'],'jimeng-A');self.assertEqual(value['status'],'paused')
        self.assertEqual(value['recovery_action'],'query_upstream')

    async def test_initial_worker_os_lock_blocks_second_worker_and_resume(self):
        task_id=self.begin();entered=asyncio.Event();release=asyncio.Event();calls=[]
        async def generate(payload):
            calls.append(payload)
            with ledger.receipt_context(task_id):native.remember_video_receipt('video-generic','original',self.provider,base_url=self.provider['base_url'])
            entered.set();await release.wait()
            return {'videos':['/output/mock.mp4'],'task_id':'original'}
        with patch.object(core,'canvas_video',side_effect=generate):
            first=asyncio.create_task(native.run(task_id,'video'));await entered.wait()
            ledger._ACTIVE.clear() # Simulate another process without the first process's in-memory ownership.
            self.assertTrue(native.read(task_id,'video')['processing'])
            self.assertEqual(native.read(task_id,'video')['status'],'running')
            await native.run(task_id,'video')
            with self.assertRaises(core.HTTPException) as exc:await native.resume(task_id)
            self.assertEqual(exc.exception.status_code,409);self.assertEqual(len(calls),1)
            release.set();await first
        self.assertEqual(native.read(task_id,'video')['status'],'succeeded')
        native.recovery_lock(task_id).close()

    async def test_result_and_remote_cache_remove_credentials(self):
        task_id=self.begin()
        with ledger.receipt_context(task_id):
            native.remember_video_result({'authorization':'Bearer '+self.key,'nested':{'api_key':self.key,'credential_fingerprint':'private'},'video_url':'/output/mock.mp4'},['/output/mock.mp4'])
        native.finish(task_id,ledger.raw(task_id)['remote_result'])
        value=native.read(task_id,'video');text=json.dumps(value)
        self.assertNotIn(self.key,text);self.assertNotIn('"private"',text);self.assertEqual(value['result']['raw']['authorization'],'[已隐藏]')
        self.assertNotIn(self.key,(ledger.directory()/(task_id+'.json')).read_text(encoding='utf-8'))

    async def test_result_persistence_failure_does_not_fake_success(self):
        task_id=self.begin('llm');original=ledger._write;failed=False
        def write(record):
            nonlocal failed
            if record['status']=='succeeded' and not failed:
                failed=True;raise OSError('mock result disk fail')
            original(record)
        with patch.object(ledger,'_write',side_effect=write),patch.object(core,'canvas_llm',AsyncMock(return_value={'text':'actual reply','model':'mock-chat'})):
            await native.run(task_id,'llm')
        value=native.read(task_id,'llm')
        self.assertEqual(value['status'],'paused');self.assertEqual(value['result']['text'],'actual reply')
        self.assertEqual(value['recovery_status'],'result_not_persisted');self.assertFalse(value['processing'])

    async def test_cli_empty_friendly_placeholder_is_not_generated_text(self):
        for kind,check,method in [('codex','is_codex_provider','codex_chat_text'),('gemini','is_gemini_cli_provider','gemini_cli_chat_text')]:
            with patch.object(core,check,return_value=True):
                task_id=self.begin('llm',request_id='cli-empty-'+kind)
                with patch.object(core,method,AsyncMock(return_value=('CLI 返回了空回复。',{}))) as cli:
                    await native.run(task_id,'llm')
            cli.assert_awaited_once();value=native.read(task_id,'llm')
            self.assertEqual(value['status'],'uncertain');self.assertIsNone(value['result'])

    async def test_native_standard_and_cli_malformed_content_type_matrix(self):
        values=[None,42,False,{'not':'text'},[],[{'text':42}],'  ', ' real answer ',[{'text':'real '},{'content':'answer'}]]
        for index,value in enumerate(values):
            task_id=self.begin('llm',request_id='native-type-'+str(index));calls=[]
            def handler(request):calls.append(request);return httpx.Response(200,json={'choices':[{'message':{'content':value}}]})
            with self.transport(handler):await native.run(task_id,'llm')
            result=native.read(task_id,'llm');valid=index>=7
            self.assertEqual(result['status'],'succeeded' if valid else 'uncertain');self.assertEqual(len(calls),1)
            if valid:self.assertIn('real',result['result']['text'])
            else:self.assertIsNone(result['result'])
        for name,check,method in [('codex','is_codex_provider','codex_chat_text'),('gemini','is_gemini_cli_provider','gemini_cli_chat_text')]:
            for index,value in enumerate([None,42,False,{'not':'text'},[], '  ', ' actual CLI answer ']):
                with patch.object(core,check,return_value=True):
                    task_id=self.begin('llm',request_id='cli-type-'+name+str(index))
                    with patch.object(core,method,AsyncMock(return_value=('converted placeholder',{'text':value}))):await native.run(task_id,'llm')
                result=native.read(task_id,'llm')
                self.assertEqual(result['status'],'succeeded' if index==6 else 'uncertain')
                if index==6:self.assertEqual(result['result']['text'],'actual CLI answer')
                else:self.assertIsNone(result['result'])

    async def test_rh_wallet_credential_change_is_detected(self):
        self.provider.update(id='runninghub',base_url='https://www.runninghub.ai',protocol='runninghub')
        payload=core.CanvasVideoRequest(request_id='rh-bind',provider_id='runninghub',model='mock-video',prompt='test video')
        task_id=ledger.task_identity('video','rh-bind')
        execution=native.prepare('video',payload,task_id)
        ledger.begin('video',payload,execution=execution)
        with patch.object(core,'runninghub_wallet_key_value',return_value='different-wallet'),patch.object(core,'canvas_video',new_callable=AsyncMock) as generate:
            await native.run(task_id,'video')
        generate.assert_not_called();self.assertEqual(native.read(task_id,'video')['status'],'failed')

    async def test_rh_actual_wallet_secret_is_redacted_from_arbitrary_raw_values(self):
        self.provider.update(id='runninghub',base_url='https://www.runninghub.ai',protocol='runninghub')
        payload=core.CanvasVideoRequest(request_id='rh-redact',provider_id='runninghub',model='mock-video',prompt='test video')
        task_id=ledger.task_identity('video','rh-redact')
        ledger.begin('video',payload,execution=native.prepare('video',payload,task_id))
        with ledger.receipt_context(task_id):
            native.remember_video_result({'diagnostic':'echo mock-wallet-key here','video_url':'/output/valid.mp4'},['/output/valid.mp4'])
        native.finish(task_id,ledger.raw(task_id)['remote_result'])
        self.assertNotIn('mock-wallet-key',json.dumps(native.read(task_id,'video')))
        self.assertNotIn('mock-wallet-key',(ledger.directory()/(task_id+'.json')).read_text(encoding='utf-8'))

    def stage_child(self, kind='video', status='running', upstream='child-remote', remote_result=None):
        self.provider['base_url']='https://api.deepwhiteai.com'
        task_id=self.begin(kind)
        child_id=ledger.raw(task_id)['execution']['child_id']
        payload=generation.Generation(request_id=child_id,canvas_id='A',node_id='source',provider_id='mock',
                                      model='mock-video' if kind=='video' else 'mock-chat',kind='video' if kind=='video' else 'chat',prompt='fixed input')
        with ledger.receipt_context(task_id): generation.native_parent_plan(payload)
        child=dict(id=child_id,created_at=1,status=status,error='',request=payload.model_dump(),resolved_model=payload.model,
                   base_url=self.provider['base_url'],fingerprint=hashlib.sha256(payload.model_dump_json().encode()).hexdigest(),
                   children=[dict(status=status,**({'upstream_id':upstream} if upstream else {}))])
        if remote_result: child['children'][0]['remote_result']=remote_result
        generation.save(child); ledger.dispatch(task_id); ledger.release(task_id)
        return task_id,child

    async def test_deepwhite_missing_or_queued_child_is_not_created_on_resume(self):
        for missing in (True,False):
            task_id,child=self.stage_child(status='queued',upstream='')
            if missing: (generation.directory()/(child['id']+'.json')).unlink()
            with patch.object(generation,'submit',new_callable=AsyncMock) as submit, patch.object(generation,'start') as start:
                with self.assertRaises(core.HTTPException): await native.resume(task_id)
                value=native.read(task_id,'video')
            submit.assert_not_called(); start.assert_not_called(); self.assertEqual(value['status'],'uncertain')
            # Use a fresh identity for the next subcase.
            (ledger.directory()/(task_id+'.json')).unlink()

    async def test_deepwhite_parent_lost_receipt_uses_fixed_existing_child(self):
        task_id,child=self.stage_child()
        calls=[]
        def handler(request):
            calls.append(request);return httpx.Response(200,json={'status':'succeeded','video_url':'https://cdn.invalid/movie.mp4'})
        async def save(client,url,kind,job_id,index):
            self.assertEqual(job_id,child['id']); self.assertIn('remote_result',generation.read(job_id)['children'][0])
            return {'url':'/output/child.mp4','kind':'video'}
        with self.transport(handler), patch.object(generation,'persist_media',side_effect=save),patch.object(generation,'submit',new_callable=AsyncMock) as submit,patch.object(generation,'start') as start:
            await native.resume(task_id);value=await self.settle(task_id)
        submit.assert_not_called();start.assert_not_called();self.assertEqual(value['status'],'succeeded')
        self.assertEqual(len(calls),1);self.assertEqual(calls[0].method,'GET');self.assertTrue(calls[0].url.path.endswith('/child-remote'))
        self.assertEqual(value['result']['request_id'],child['id'])

    async def test_deepwhite_cached_result_does_not_query_again(self):
        task_id,child=self.stage_child(remote_result={'status':'succeeded','urls':['https://cdn.invalid/cached.mp4'],'usage':None})
        async def save(*args):return {'url':'/output/cached.mp4','kind':'video'}
        with patch.object(generation,'persist_media',side_effect=save),self.transport(lambda request:self.fail('cached result must not query')):
            await native.resume(task_id);value=await self.settle(task_id)
        self.assertEqual(value['status'],'succeeded')

    async def test_deepwhite_completed_text_survives_parent_restart_read_only(self):
        task_id,child=self.stage_child(kind='llm',status='succeeded',upstream='')
        child['children'][0].update(text='completed child text',usage={'tokens':8});generation.save(child)
        with patch.object(generation,'start') as start,patch.object(generation,'submit',new_callable=AsyncMock) as submit:
            value=native.find('llm','request-A')
        start.assert_not_called();submit.assert_not_called();self.assertEqual(value['status'],'succeeded')
        self.assertEqual(value['result']['text'],'completed child text')

    async def test_deepwhite_failed_and_cached_child_projection_is_truthful(self):
        task_id,child=self.stage_child(status='failed')
        child['error']='actual remote failure';generation.save(child)
        value=native.read(task_id,'video')
        self.assertEqual(value['status'],'failed');self.assertIsNone(value['recovery_action'])
        child.update(status='paused',error='archive failed');child['children'][0]['remote_result']={'urls':['https://cdn.invalid/cached.mp4'],'status':'succeeded','usage':None};generation.save(child)
        with ledger.receipt_context(task_id):generation.native_parent_receipt(child)
        native.mark_failure(task_id,core.HTTPException(502,'archive interrupted'),True)
        value=native.read(task_id,'video');self.assertEqual(value['recovery_action'],'archive_result')

    async def test_deepwhite_execute_saves_child_and_parent_receipt_before_query(self):
        task_id,child=self.stage_child(status='queued',upstream='')
        calls=[]
        def handler(request):
            calls.append(request)
            if request.method=='POST':return httpx.Response(200,json={'id':'accepted-child'})
            record=ledger.raw(task_id)
            self.assertEqual(record['receipt']['protocol'],'studio-generation')
            self.assertEqual(generation.read(child['id'])['children'][0]['upstream_id'],'accepted-child')
            return httpx.Response(200,json={'status':'succeeded','video_url':'https://cdn.invalid/result.mp4'})
        async def save(client,url,kind,job_id,index):
            self.assertEqual(generation.read(job_id)['children'][0]['remote_result']['urls'],[url])
            return {'url':'/output/actual-child.mp4','kind':'video'}
        with ledger.receipt_context(task_id),self.transport(handler),patch.object(generation,'media_body',return_value={'model':'mock-video','prompt':'fixed input'}),patch.object(generation,'persist_media',side_effect=save):
            await generation.execute(child['id'])
        self.assertEqual([request.method for request in calls],['POST','GET'])
        self.assertEqual(native.read(task_id,'video')['result']['videos'],['/output/actual-child.mp4'])

    async def test_deepwhite_empty_or_malformed_choices_are_uncertain_one_post(self):
        bodies=[{'choices':[]},{'choices':[{'message':{'content':None}}]},
                {'choices':[{'message':{'content':{'not':'text'}}}]},
                {'choices':[{'message':{'content':42}}]},{'choices':[{'message':{'content':'  '}}]},
                {'choices':[{'message':{'content':[{'text':4}]}}]}]
        for body in bodies:
            task_id,child=self.stage_child(kind='llm',status='queued',upstream='')
            calls=[]
            def handler(request):calls.append(request);return httpx.Response(200,json=body)
            with ledger.receipt_context(task_id),self.transport(handler):await generation.execute(child['id'])
            self.assertEqual(generation.read(child['id'])['status'],'uncertain')
            self.assertEqual([r.method for r in calls],['POST'])
            self.assertNotEqual(native.read(task_id,'llm')['status'],'succeeded')
            (ledger.directory()/(task_id+'.json')).unlink()

    async def test_deepwhite_parent_receipt_write_loss_stops_poll_then_recovers_child(self):
        task_id,child=self.stage_child(status='queued',upstream='')
        original=ledger._write;failed=False;calls=[]
        def write(record):
            nonlocal failed
            if record.get('receipts') and not failed:
                failed=True;raise OSError('parent receipt disk failure')
            original(record)
        def handler(request):
            calls.append(request)
            return httpx.Response(200,json={'id':'accepted-child'}) if request.method=='POST' else httpx.Response(200,json={'status':'succeeded','video_url':'https://cdn.invalid/result.mp4'})
        with ledger.receipt_context(task_id),self.transport(handler),patch.object(ledger,'_write',side_effect=write),patch.object(generation,'media_body',return_value={'model':'mock-video','prompt':'fixed input'}):
            await generation.execute(child['id'])
        self.assertEqual([r.method for r in calls],['POST'])
        self.assertEqual(generation.read(child['id'])['status'],'paused')
        ledger._VOLATILE.clear();self.assertFalse(ledger.raw(task_id)['receipts'])
        with self.transport(handler),patch.object(generation,'persist_media',AsyncMock(return_value={'url':'/output/recovered-child.mp4','kind':'video'})):
            await native.resume(task_id);value=await self.settle(task_id)
        self.assertEqual([r.method for r in calls],['POST','GET']);self.assertEqual(value['status'],'succeeded')

    async def test_deepwhite_compatibility_generates_fixed_child_id_and_parent_plan(self):
        self.provider['base_url']='https://api.deepwhiteai.com'
        task_id=self.begin('llm')
        originals=(core.build_online_image_result,core.canvas_video,core.canvas_llm)
        generation.install_compatibility()
        self.addCleanup(lambda:setattr(core,'build_online_image_result',originals[0]))
        self.addCleanup(lambda:setattr(core,'canvas_video',originals[1]))
        self.addCleanup(lambda:setattr(core,'canvas_llm',originals[2]))
        captured=[]
        async def submit(payload):
            captured.append(payload)
            execution=ledger.raw(task_id)['execution']
            self.assertEqual(execution['child_fingerprint'],hashlib.sha256(payload.model_dump_json().encode()).hexdigest())
            child=dict(id=payload.request_id,request=payload.model_dump(),resolved_model=payload.model,base_url=self.provider['base_url'],
                       status='succeeded',error='',created_at=1,fingerprint=execution['child_fingerprint'],
                       children=[{'status':'succeeded','text':'fixed child text','usage':None}])
            generation.save(child);return generation.public(child)
        with patch.object(generation,'submit',side_effect=submit):await native.run(task_id,'llm')
        self.assertEqual(captured[0].request_id,native.child_identity(task_id))
        self.assertEqual(native.read(task_id,'llm')['result']['text'],'fixed child text')


if __name__=='__main__':
    unittest.main()
