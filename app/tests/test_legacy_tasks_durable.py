"""Temporary ledgers and mocked transports only; no paid/GPU execution."""
import asyncio
import importlib
import json
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

os.environ.setdefault('DEEPWHITE_STUDIO_RUNTIME_DIR', tempfile.mkdtemp(prefix='legacy-import-'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import main as core
import studio_legacy_tasks as ledger


class LedgerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='legacy-test-')
        self.addCleanup(self.temp.cleanup)
        helper = patch.object(core, 'DATA_DIR', self.temp.name)
        helper.start(); self.addCleanup(helper.stop)
        ledger._ACTIVE.clear(); ledger._VOLATILE.clear()

    def image(self, request_id='request-one', **params):
        return core.OnlineImageRequest(request_id=request_id, canvas_id='canvas-A', node_id='node-1',
                                       prompt='mock image', provider_id='mock', **params)

    async def wait_finished(self, task_id):
        for _ in range(100):
            if ledger._key(task_id) not in ledger._ACTIVE:
                return ledger.read(task_id)
            await asyncio.sleep(.001)
        self.fail('worker did not finish')

    async def test_same_identity_and_full_fingerprint_conflict(self):
        payload = self.image()
        first, created = ledger.begin('image', payload)
        self.assertTrue(created)
        second, created = ledger.begin('image', payload)
        self.assertFalse(created); self.assertEqual(first['id'], second['id'])
        for field, value in [('prompt','different'), ('canvas_id','B'), ('node_id','other'), ('n',2),
                             ('quality','high'), ('reference_images',[core.AIReference(url='/assets/mock.png')])]:
            altered = payload.model_copy(update={field:value})
            with self.assertRaises(core.HTTPException) as exc:
                ledger.begin('image', altered)
            self.assertEqual(exc.exception.status_code, 409)
        self.assertNotIn('request', second); self.assertNotIn('fingerprint', second)

    async def test_concurrent_claim_executes_only_once(self):
        payload = self.image()
        with ThreadPoolExecutor(max_workers=6) as pool:
            values = list(pool.map(lambda _: ledger.begin('image', payload), range(12)))
        self.assertEqual(sum(created for _, created in values), 1)
        task = values[0][0]
        self.assertTrue(ledger.dispatch(task['id'])); self.assertFalse(ledger.dispatch(task['id']))

    async def test_creation_write_failure_never_schedules(self):
        with patch.object(ledger, '_write', side_effect=OSError('mock disk full')), patch.object(core.asyncio, 'create_task') as schedule:
            with self.assertRaises(core.HTTPException) as exc:
                await core.create_canvas_image_task(self.image())
            self.assertEqual(exc.exception.status_code,503); schedule.assert_not_called()
        self.assertIsNone(ledger.find_image_request('request-one'))

    async def test_dispatch_write_failure_never_generates(self):
        task, _ = ledger.begin('image', self.image())
        original = ledger._write
        def write(record):
            if record.get('dispatch_started'):
                raise OSError('mock claim write failure')
            return original(record)
        with patch.object(ledger, '_write', side_effect=write), patch.object(core, 'build_online_image_result', AsyncMock()) as generate:
            await core.run_canvas_image_task(task['id'], self.image())
            generate.assert_not_awaited()
        value=ledger.read(task['id'])
        self.assertEqual(value['status'],'failed'); self.assertEqual(value['recovery_status'],'not_submitted')

    async def test_image_result_and_get_by_request_survive_restart(self):
        payload=self.image()
        result={'images':['/output/mock.png'], 'image_items':[{'url':'/output/mock.png'}]}
        async def generate(_):
            record=ledger.find_image_request(payload.request_id)
            self.assertTrue(record['dispatch_started']); self.assertEqual(record['status'],'running')
            return result
        with patch.object(core,'build_online_image_result',side_effect=generate) as generate:
            first=await core.create_canvas_image_task(payload)
            await self.wait_finished(first['id'])
            ledger._ACTIVE.clear(); ledger._VOLATILE.clear()
            second=await core.create_canvas_image_task(payload)
            self.assertEqual(second['id'],first['id']);generate.assert_awaited_once()
            self.assertEqual((await core.get_canvas_image_task_by_request(payload.request_id))['result'],result)
            self.assertEqual((await core.get_canvas_image_task(first['id']))['status'],'succeeded')

    async def test_restart_states_never_dispatch_on_reads_or_duplicate_posts(self):
        for suffix, mode, expected in [('queued','queued','paused'), ('lost','dispatch','uncertain'), ('known','receipt','paused')]:
            payload=self.image('request-'+suffix)
            task,_=ledger.begin('image',payload)
            if mode!='queued':ledger.dispatch(task['id'])
            if mode=='receipt':
                with ledger.receipt_context(task['id']):
                    ledger.remember_receipt('mock','remote-known',query_url='https://mock.invalid/query')
            ledger.release(task['id'])
            with patch.object(core.asyncio,'create_task') as schedule:
                recovered=await core.create_canvas_image_task(payload)
                await core.get_canvas_image_task(task['id'])
                await core.get_canvas_image_task_by_request(payload.request_id)
                schedule.assert_not_called()
            self.assertEqual(recovered['status'],expected);self.assertFalse(recovered['retryable'])
            self.assertEqual(recovered['queryable'],mode=='receipt')

    async def test_receipt_write_failure_keeps_received_id_and_never_repeats(self):
        payload=self.image()
        task,_=ledger.begin('image',payload)
        async def generate(_):
            with patch.object(ledger,'_write',side_effect=OSError('mock receipt disk failure')):
                ledger.remember_receipt('mock','received-42',query_url='https://mock.invalid/query')
            self.fail('polling must stop when the receipt cannot be persisted')
        with patch.object(core,'build_online_image_result',side_effect=generate) as generate:
            await core.run_canvas_image_task(task['id'],payload)
            stored=ledger.read(task['id'])
            self.assertEqual(stored['upstream_task_id'],'received-42');self.assertEqual(stored['status'],'paused')
            await core.create_canvas_image_task(payload);generate.assert_awaited_once()
            # Once disk recovers, exception handling has persisted the received ID.
            ledger._VOLATILE.clear();self.assertEqual(ledger.read(task['id'])['upstream_task_id'],'received-42')

    async def test_result_write_failure_is_observable_without_fake_success(self):
        payload=self.image();task,_=ledger.begin('image',payload)
        original=ledger._write
        def write(record):
            if record.get('status')=='succeeded':raise OSError('mock result disk failure')
            original(record)
        with patch.object(ledger,'_write',side_effect=write), patch.object(core,'build_online_image_result',AsyncMock(return_value={'images':['/output/mock.png']})):
            await core.run_canvas_image_task(task['id'],payload)
        value=ledger.read(task['id'])
        self.assertEqual(value['status'],'paused');self.assertEqual(value['recovery_status'],'result_not_persisted')
        self.assertEqual(value['result']['images'],['/output/mock.png']);self.assertIn('failure',value['error'])

    async def test_timeout_without_receipt_is_uncertain_not_failed(self):
        payload=self.image();task,_=ledger.begin('image',payload)
        with patch.object(core,'build_online_image_result',AsyncMock(side_effect=TimeoutError('submit timeout'))):
            await core.run_canvas_image_task(task['id'],payload)
        self.assertEqual(ledger.read(task['id'])['status'],'uncertain')

    async def test_failure_details_are_sanitized_on_disk_and_http_after_restart(self):
        payload=self.image('redacted-failure');task,_=ledger.begin('image',payload)
        detail={'message':'上游配额不足，请核对原任务', 'url':'https://user:url-password@mock.invalid/task?token=url-token',
                'headers':{'Authorization':'Bearer header-secret','X-API-Key':'api-secret'},
                'nested':[{'access_token':'access-secret'},'token=plain-secret; Basic basic-secret==']}
        failure=core.HTTPException(429,detail)
        with patch.object(core,'build_online_image_result',AsyncMock(side_effect=failure)) as generate:
            await core.run_canvas_image_task(task['id'],payload)
            await core.create_canvas_image_task(payload);generate.assert_awaited_once()
        raw=(ledger.directory()/(task['id']+'.json')).read_text(encoding='utf-8')
        for secret in ['url-password','url-token','header-secret','api-secret','access-secret','plain-secret','basic-secret']:
            self.assertNotIn(secret,raw)
        ledger._ACTIVE.clear();ledger._VOLATILE.clear()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=core.app),base_url='http://testserver') as client:
            response=await client.get('/api/canvas-image-tasks/by-request/redacted-failure')
        self.assertEqual(response.status_code,200)
        value=response.json();self.assertEqual(value['status'],'uncertain');self.assertEqual(value['status_code'],429)
        self.assertIn('上游配额不足',value['error']);self.assertFalse(value['retryable'])
        self.assertNotIn('https://',value['error'])

    async def test_comfy_transport_exception_redacted_without_changing_uncertainty(self):
        payload=core.GenerateRequest(request_id='comfy-redacted',canvas_id='A',node_id='same')
        task,_=ledger.begin('comfy',payload)
        message='poll timeout wss://user:ws-secret@mock.invalid/ws?token=ws-query Authorization: Basic auth-secret==; api_key=key-secret'
        with patch.object(core,'generate',side_effect=TimeoutError(message)) as generate:
            await core.run_canvas_comfy_task(task['id'],payload);generate.assert_called_once()
        ledger._ACTIVE.clear();ledger._VOLATILE.clear()
        value=await core.get_canvas_comfy_task_by_request('comfy-redacted')
        raw=(ledger.directory()/(task['id']+'.json')).read_text(encoding='utf-8')
        for secret in ['ws-secret','ws-query','auth-secret','key-secret']:
            self.assertNotIn(secret,raw);self.assertNotIn(secret,value['error'])
        self.assertEqual(value['status'],'uncertain');self.assertIn('poll timeout',value['error'])

    async def test_historical_error_is_redacted_on_read_but_result_urls_stay_usable(self):
        task,_=ledger.begin('image',self.image('old-error'))
        result={'images':['https://mock.invalid/result.png?signature=media-signature']}
        ledger.update(task['id'],status='paused',result=result,
            error='archive failed {"Authorization": "Bearer old-secret", "token": "old-token"} https://mock.invalid/query?key=old-url-secret')
        ledger.release(task['id'])
        value=await core.get_canvas_image_task(task['id'])
        self.assertIn('archive failed',value['error'])
        for secret in ['old-secret','old-token','old-url-secret']:
            self.assertNotIn(secret,value['error'])
        # F04 (2026-10-26): a signed result stays usable through a local handle, never as a public signed link.
        handle=value['result']['images'][0]
        self.assertTrue(handle.startswith('/api/studio/task-media/'),handle)
        self.assertNotIn('media-signature',json.dumps(value,ensure_ascii=False))
        self.assertEqual(ledger.signed_media_url(task['id'],handle.split('u=',1)[1]),result['images'][0])
        self.assertEqual(ledger.raw(task['id'])['result'],result)

    async def test_comfy_thread_context_receipts_and_results_persist(self):
        payload=core.GenerateRequest(request_id='comfy-one',canvas_id='A',node_id='same')
        def generate(_):
            ledger.remember_receipt('comfy','prompt-17',backend='127.0.0.1:8188')
            return {'images':['/output/comfy.png'],'prompt_id':'prompt-17'}
        with patch.object(core,'generate',side_effect=generate) as generate:
            task=await core.create_canvas_comfy_task(payload)
            await self.wait_finished(task['id'])
            ledger._ACTIVE.clear();ledger._VOLATILE.clear()
            value=await core.get_canvas_comfy_task_by_request('comfy-one')
            self.assertEqual(value['status'],'succeeded');self.assertEqual(value['receipt']['backend'],'127.0.0.1:8188')
            await core.create_canvas_comfy_task(payload);generate.assert_called_once()
            with self.assertRaises(core.HTTPException):await core.get_canvas_image_task(task['id'])

    async def test_multiple_receipts_and_task_context_are_isolated(self):
        a,_=ledger.begin('image',self.image('context-a'));b,_=ledger.begin('image',self.image('context-b'))
        async def remember(task,ids):
            with ledger.receipt_context(task['id']):
                for remote in ids:
                    await asyncio.sleep(0);ledger.remember_receipt('mock',remote,provider_id='mock')
        await asyncio.gather(remember(a,['a-1','a-2']),remember(b,['b-1']))
        self.assertEqual([x['task_id'] for x in ledger.read(a['id'])['receipts']],['a-1','a-2'])
        self.assertEqual(ledger.read(b['id'])['upstream_task_id'],'b-1')
        ledger.remember_receipt('mock','outside-noop')
        self.assertEqual(len(ledger.read(a['id'])['receipts']),2)

    async def test_worker_uses_committed_snapshot_not_mutable_caller(self):
        payload=self.image();task,_=ledger.begin('image',payload)
        payload.prompt='changed after begin';payload.n=7
        async def generate(actual):
            self.assertEqual(actual.prompt,'mock image');self.assertEqual(actual.n,1)
            return {'images':['/output/mock.png']}
        with patch.object(core,'build_online_image_result',side_effect=generate) as generate:
            await core.run_canvas_image_task(task['id'],payload)
            generate.assert_awaited_once()
        self.assertEqual(ledger.read(task['id'])['status'],'succeeded')

    async def test_duplicate_worker_exit_cannot_release_original_worker(self):
        payload=self.image();task,_=ledger.begin('image',payload)
        started=asyncio.Event();finish=asyncio.Event()
        async def generate(_):
            started.set();await finish.wait();return {'images':['/output/mock.png']}
        with patch.object(core,'build_online_image_result',side_effect=generate) as generate:
            first=asyncio.create_task(core.run_canvas_image_task(task['id'],payload))
            await started.wait()
            await core.run_canvas_image_task(task['id'],payload)
            self.assertEqual(ledger.read(task['id'])['status'],'running')
            self.assertIn(ledger._key(task['id']),ledger._ACTIVE)
            finish.set();await first;generate.assert_awaited_once()
        self.assertEqual(ledger.read(task['id'])['status'],'succeeded')

    async def test_unknown_ids_and_traversal_never_create_records(self):
        self.assertIsNone(ledger.find_image_request('does-not-exist'))
        with self.assertRaises(core.HTTPException) as exc:await core.get_canvas_image_task_by_request('does-not-exist')
        self.assertEqual(exc.exception.status_code,404)
        for bad in ['../bad','x/y','', 'x'*161]:
            with self.assertRaises(core.HTTPException):ledger.find_image_request(bad)
        self.assertEqual(list(ledger.directory().glob('*.json')),[])

    async def test_real_http_routes_by_request_preserve_legacy_fields(self):
        payload=self.image();task,_=ledger.begin('image',payload)
        ledger.update(task['id'],status='succeeded',result={'images':['/output/mock.png']})
        ledger.release(task['id'])
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=core.app),base_url='http://testserver') as client:
            response=await client.get('/api/canvas-image-tasks/by-request/request-one')
            self.assertEqual(response.status_code,200)
            value=response.json()
            for key in ['task_id','id','type','status','result','error','provider_id','model']:
                self.assertIn(key,value)
            response=await client.post('/api/canvas-image-tasks',json=payload.model_copy(update={'prompt':'conflict'}).model_dump())
            self.assertEqual(response.status_code,409)

    async def test_comfy_actual_prompt_hook_before_history(self):
        workflow=Path(self.temp.name)/'mock.json';workflow.write_text('{}',encoding='utf-8')
        payload=core.GenerateRequest(request_id='comfy-real-hook',workflow_json='mock.json')
        task,_=ledger.begin('comfy',payload)
        response=Mock();response.read.return_value=b'{"prompt_id":"prompt-actual"}'
        def history(backend,remote):
            self.assertEqual(ledger.read(task['id'])['receipt']['task_id'],'prompt-actual')
            self.assertEqual(backend,'mock.invalid:8188')
            return {remote:{'outputs':{}}}
        with patch.object(core,'WORKFLOW_DIR',self.temp.name),patch.object(core,'reserve_best_backend',return_value='mock.invalid:8188'),patch.object(core.urllib.request,'urlopen',return_value=response) as submit,patch.object(core,'get_comfy_history',side_effect=history),patch.object(core,'save_to_history'),patch.object(core,'GLOBAL_LOOP',None):
            await core.run_canvas_comfy_task(task['id'],payload)
            submit.assert_called_once()
        self.assertEqual(ledger.read(task['id'])['status'],'succeeded')

    async def test_rh_model_actual_hook_precedes_polling(self):
        payload=self.image();task,_=ledger.begin('image',payload)
        original_client=httpx.AsyncClient
        calls=[]
        def handle(request):
            calls.append(request)
            return httpx.Response(200,json={'data':{'taskId':'rh-received'}})
        async def wait(*args):
            self.assertEqual(ledger.read(task['id'])['upstream_task_id'],'rh-received')
            raise TimeoutError('mock poll unavailable')
        async def generate(_):
            return await core.generate_runninghub_provider_image('mock','1024x1024','mock',provider={'id':'mock','base_url':'https://rh.invalid'})
        with patch.object(core,'runninghub_entry_config_from_model',return_value=None),patch.object(core,'runninghub_model_definition',AsyncMock(return_value={'endpoint':'model','params':[]})),patch.object(core,'runninghub_task_endpoint',return_value='https://rh.invalid/model'),patch.object(core,'runninghub_openapi_url',return_value='https://rh.invalid/query'),patch.object(core,'runninghub_json_headers',return_value={}),patch.object(core.httpx,'AsyncClient',side_effect=lambda **kw:original_client(transport=httpx.MockTransport(handle),**kw)),patch.object(core,'wait_for_runninghub_image_task',side_effect=wait),patch.object(core,'build_online_image_result',side_effect=generate):
            await core.run_canvas_image_task(task['id'],payload)
        self.assertEqual(len(calls),1);self.assertEqual(ledger.read(task['id'])['status'],'paused')

    async def test_rh_entry_actual_receipt_precedes_outputs_query(self):
        payload=self.image();task,_=ledger.begin('image',payload)
        original_client=httpx.AsyncClient;calls=[]
        def handle(request):
            calls.append(request)
            if request.url.path.endswith('/run'):
                return httpx.Response(200,json={'code':0,'data':{'taskId':'entry-received'}})
            self.assertEqual(ledger.read(task['id'])['upstream_task_id'],'entry-received')
            return httpx.Response(200,json={'code':805,'msg':'mock remote failed'})
        async def generate(_):
            return await core.generate_runninghub_entry_image('mock','1024x1024','app:12345678',[],
                {'id':'mock','base_url':'https://rh.invalid'}, {'kind':'app','id':'12345678','fields':[]})
        with patch.object(core,'runninghub_api_key',return_value='mock-only-key'),patch.object(core,'runninghub_app_headers',return_value={}),patch.object(core,'runninghub_endpoint_url',side_effect=lambda p,path:'https://rh.invalid'+path),patch.object(core.httpx,'AsyncClient',side_effect=lambda **kw:original_client(transport=httpx.MockTransport(handle),**kw)),patch.object(core.asyncio,'sleep',AsyncMock()),patch.object(core,'build_online_image_result',side_effect=generate):
            await core.run_canvas_image_task(task['id'],payload)
        self.assertEqual(len(calls),2)
        self.assertEqual(ledger.read(task['id'])['receipt']['protocol'],'runninghub-entry')
        self.assertEqual(ledger.read(task['id'])['status'],'paused')

    async def test_responses_receipt_is_saved_before_first_get_and_sanitized(self):
        task,_=ledger.begin('image',self.image())
        calls=[]
        def handle(request):
            calls.append(request)
            if request.method=='POST':return httpx.Response(200,json={'id':'resp-mock','status':'queued'})
            receipt=ledger.read(task['id'])['receipt']
            self.assertEqual(receipt['task_id'],'resp-mock')
            self.assertEqual(receipt['submit_url'],'https://mock.invalid/v1/responses')
            self.assertNotIn('mock-secret',json.dumps(receipt))
            return httpx.Response(200,json={'id':'resp-mock','status':'completed'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with ledger.receipt_context(task['id']),patch.object(core,'RESPONSES_POLL_INTERVAL',0):
                await core.post_openai_responses(client,'https://user:mock-secret@mock.invalid/v1/responses?key=mock-secret',{}, {})
        self.assertEqual([r.method for r in calls],['POST','GET'])

    async def test_responses_receipt_failure_stops_before_poll_or_mode_fallback(self):
        task,_=ledger.begin('image',self.image());calls=[]
        def handle(request):calls.append(request);return httpx.Response(200,json={'id':'resp-mock','status':'queued'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with ledger.receipt_context(task['id']),patch.object(ledger,'_write',side_effect=OSError('receipt fail')):
                with self.assertRaises(OSError):await core.post_openai_responses(client,'https://mock.invalid/responses',{}, {})
        self.assertEqual([r.method for r in calls],['POST'])
        self.assertEqual(ledger.read(task['id'])['upstream_task_id'],'resp-mock')

    async def test_generic_async_receipt_precedes_poll_and_failed_hook_stops(self):
        original_client=httpx.AsyncClient
        for failure in (False,True):
            task,_=ledger.begin('image',self.image('generic-'+str(failure)))
            calls=[]
            def handle(request):calls.append(request);return httpx.Response(200,json={'task_id':'image-remote'})
            async def poll(*args):
                self.assertEqual(ledger.read(task['id'])['upstream_task_id'],'image-remote')
                return {'data':[{'url':'https://mock.invalid/image.png'}]}
            with ExitStack() as stack:
                stack.enter_context(ledger.receipt_context(task['id']))
                stack.enter_context(patch.object(core,'get_api_provider',return_value={'id':'mock','base_url':'https://mock.invalid','protocol':'openai'}))
                for name in ['is_tudou_provider','is_codex_provider','is_gemini_cli_provider','is_jimeng_provider','is_runninghub_provider','is_volcengine_provider','is_tudou_async_image_mode','is_apimart_provider']:
                    stack.enter_context(patch.object(core,name,return_value=False))
                stack.enter_context(patch.object(core,'effective_protocol',return_value='openai'))
                stack.enter_context(patch.object(core,'effective_image_request_mode',return_value='auto'))
                stack.enter_context(patch.object(core,'api_headers',return_value={}))
                stack.enter_context(patch.object(core,'image_task_url_for_provider',return_value='https://mock.invalid/tasks/image-remote'))
                stack.enter_context(patch.object(core.httpx,'AsyncClient',side_effect=lambda **kw:original_client(transport=httpx.MockTransport(handle),**kw)))
                polling=stack.enter_context(patch.object(core,'wait_for_image_task',side_effect=poll))
                if failure:
                    stack.enter_context(patch.object(ledger,'_write',side_effect=OSError('mock receipt fail')))
                    with self.assertRaises(OSError):await core.generate_ai_image('mock','1024x1024','medium','image-model',provider_id='mock')
                    polling.assert_not_awaited()
                else:
                    await core.generate_ai_image('mock','1024x1024','medium','image-model',provider_id='mock')
                    polling.assert_awaited_once()
            self.assertEqual(len(calls),1)


class SubmissionRetriesTests(unittest.IsolatedAsyncioTestCase):
    async def test_edit_timeout_and_5xx_never_generations_fallback_but_reject_can(self):
        original_client=httpx.AsyncClient
        for mode,expected in [('timeout',1),('502',1),('400',2)]:
            requests=[]
            def handle(request):
                requests.append(request)
                if len(requests)==1:
                    if mode=='timeout':raise httpx.ReadTimeout('mock edit timeout',request=request)
                    return httpx.Response(int(mode),json={'error':'mock rejected','Authorization':'Bearer edit-secret','url':'https://mock.invalid/query?token=edit-url-secret'})
                return httpx.Response(200,json={'data':[{'url':'https://mock.invalid/image.png'}]})
            with ExitStack() as stack:
                stack.enter_context(patch.object(core,'get_api_provider',return_value={'id':'mock','base_url':'https://mock.invalid','protocol':'openai'}))
                for name in ['is_tudou_provider','is_codex_provider','is_gemini_cli_provider','is_jimeng_provider','is_runninghub_provider','is_volcengine_provider','is_tudou_async_image_mode','is_apimart_provider']:
                    stack.enter_context(patch.object(core,name,return_value=False))
                stack.enter_context(patch.object(core,'effective_protocol',return_value='openai'))
                stack.enter_context(patch.object(core,'effective_image_request_mode',return_value='auto'))
                stack.enter_context(patch.object(core,'api_headers',return_value={}))
                stack.enter_context(patch.object(core,'output_file_from_url',return_value=None))
                stack.enter_context(patch.object(core,'reference_to_data_url',return_value='data:image/png;base64,bW9jaw=='))
                stack.enter_context(patch.object(core.httpx,'AsyncClient',side_effect=lambda **kw:original_client(transport=httpx.MockTransport(handle),**kw)))
                if mode=='400':await core.generate_ai_image('mock','1024x1024','medium','image-model',[{'url':'/output/fake.png'}],'mock')
                else:
                    with self.assertRaises((httpx.ReadTimeout,core.HTTPException)) as error:
                        await core.generate_ai_image('mock','1024x1024','medium','image-model',[{'url':'/output/fake.png'}],'mock')
                    if mode=='502':
                        self.assertIn('图片编辑接口',error.exception.detail)
                        self.assertNotIn('GPT-Image-2',error.exception.detail)
                        self.assertNotIn('edit-secret',error.exception.detail)
                        self.assertNotIn('edit-url-secret',error.exception.detail)
            self.assertEqual(len(requests),expected)
            self.assertTrue(requests[0].url.path.endswith('/images/edits'))

    async def test_generation_timeout_and_502_do_not_retry_but_get_does(self):
        for method,mode,count in [('POST','timeout',1),('POST','502',1),('GET','timeout',2),('GET','502',2)]:
            requests=[]
            def handle(request):
                requests.append(request)
                if len(requests)==1:
                    if mode=='timeout':raise httpx.ReadTimeout('mock timeout',request=request)
                    return httpx.Response(502)
                return httpx.Response(200)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                try:await core.httpx_request_with_transient_retries(client,method,'https://mock.invalid/task',retry_delay=0)
                except httpx.ReadTimeout:self.assertEqual(method,'POST')
            self.assertEqual(len(requests),count)

    async def test_responses_transport_failure_never_stream_resubmits(self):
        requests=[]
        def handle(request):requests.append(request);raise httpx.ReadTimeout('mock timeout',request=request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with self.assertRaises(httpx.ReadTimeout):await core.post_openai_responses(client,'https://mock.invalid/responses',{}, {})
        self.assertEqual(len(requests),1)

    async def test_responses_502_no_resubmit_and_explicit_reject_can_fallback(self):
        for status,count in [(502,1),(400,2)]:
            requests=[]
            def handle(request):
                requests.append(request)
                return httpx.Response(status if len(requests)==1 else 200,json={})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                await core.post_openai_responses(client,'https://mock.invalid/responses',{}, {})
            self.assertEqual(len(requests),count)


if __name__=='__main__':unittest.main()
