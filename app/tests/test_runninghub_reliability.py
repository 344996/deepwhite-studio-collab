"""RH mapping/error regressions. Mock transport only; no real files or paid jobs."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault('DEEPWHITE_STUDIO_RUNTIME_DIR', tempfile.mkdtemp(prefix='rh-reliability-'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import studio_runninghub as rh


class ReliabilityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rh-map-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for name, attr in [('upload', 'OUTPUT_INPUT_DIR'), ('generated', 'OUTPUT_OUTPUT_DIR'), ('local', 'LOCAL_UPLOAD_DIR')]:
            directory = root / name
            directory.mkdir()
            (directory / '参考.png').write_bytes(b'isolated-image')
            helper = patch.object(rh.core, attr, str(directory))
            helper.start(); self.addCleanup(helper.stop)
        for attr, value in [('DATA_DIR', str(root)), ('runninghub_provider', {'id': 'runninghub', 'base_url': 'https://rh.invalid'}), ('runninghub_api_key', 'private-test-key')]:
            helper = patch.object(rh.core, attr, return_value=value) if callable(getattr(rh.core, attr)) else patch.object(rh.core, attr, value)
            helper.start(); self.addCleanup(helper.stop)
        self.requests = []
        original_client = httpx.AsyncClient
        def handle(request):
            self.requests.append(request)
            return httpx.Response(200, json={'code': 0, 'data': {'taskId': 'remote-mock', 'fileName': 'api/mock.png'}})
        transport = httpx.MockTransport(handle)
        helper = patch.object(rh.core.httpx, 'AsyncClient', side_effect=lambda **kw: original_client(transport=transport, **kw))
        helper.start(); self.addCleanup(helper.stop)

    def request(self, key, kind='app', **payload):
        return rh.Submit(request_id=key, canvas_id='canvas', node_id='rh-node', kind=kind, payload={('webappId' if kind == 'app' else 'workflowId'): '12345678', 'nodeInfoList': [], **payload})

    async def test_storage_media_all_kinds_upload_binary_and_keep_filename(self):
        for kind in ('upload', 'generated', 'local'):
            url=f'/api/storage-files/{kind}/%E5%8F%82%E8%80%83.png?preview=1'
            response = await rh.core.runninghub_upload_asset(rh.core.RunningHubUploadAssetRequest(url=url))
            self.assertEqual(response['data']['fileName'], 'api/mock.png')
            self.assertEqual(self.requests[-1].url.path, '/task/openapi/upload')
            self.assertIn(b'isolated-image', self.requests[-1].content)
        self.assertEqual(len(self.requests), 3)  # no attempted HTTP GET for local files

    async def test_storage_traversal_and_missing_file_are_not_uploaded(self):
        for url in ('/api/storage-files/local/%2e%2e/escape.png', '/api/storage-files/generated/missing.png'):
            with self.assertRaises(rh.HTTPException):
                await rh.core.runninghub_upload_asset(rh.core.RunningHubUploadAssetRequest(url=url))
        self.assertEqual(self.requests, [])

    async def test_workflow_vram_manual_zero_and_large_seed_survive_wire(self):
        workflow={'3': {'class_type': 'KSampler', 'inputs': {'seed': 669816362794144, 'noise_strength': 0.4}}}
        request=self.request('mapping-0001', 'workflow', instanceType='plus', workflow=workflow,
                             nodeInfoList=[{'nodeId': '3', 'fieldName': 'seed', 'fieldValue': '18446744073709551615'}, {'nodeId': '3', 'fieldName': 'steps', 'fieldValue': 0}])
        await rh.submit(request)
        body=json.loads(self.requests[-1].content)
        self.assertEqual(body['instanceType'], 'plus')
        self.assertEqual(body['nodeInfoList'][0]['fieldValue'], '18446744073709551615')
        self.assertEqual(body['nodeInfoList'][1]['fieldValue'], 0)
        self.assertEqual(json.loads(body['workflow']), workflow)
        self.assertEqual(rh.read(request.request_id)['request']['payload']['instanceType'], 'plus')

    async def test_app_seed_and_zero_are_preserved(self):
        values=[{'nodeId':'3', 'fieldName':'seed', 'fieldValue':0}, {'nodeId':'4', 'fieldName':'noise_strength', 'fieldValue':0.4}]
        await rh.core.runninghub_submit(rh.core.RunningHubSubmitRequest(webappId='12345678', nodeInfoList=values))
        self.assertEqual(json.loads(self.requests[-1].content)['nodeInfoList'], values)

    def test_image_order_zero_is_first(self):
        fields=[{'nodeId':'1','fieldName':'image','fieldType':'IMAGE','imageOrder':1}, {'nodeId':'9','fieldName':'image','fieldType':'IMAGE','imageOrder':0}]
        self.assertEqual(rh.core.rh_field_indexes(fields)[('9','image')], 0)
        normalized=rh.core.runninghub_normalize_field({'nodeId':'9','fieldName':'image','imageOrder':0},{'imageOrder':2})
        self.assertEqual(normalized['imageOrder'], 0)

    def test_media_errors_redact_known_secret_and_quoted_json_keys(self):
        reason=rh.core.runninghub_safe_media_error({'msg':'Image size invalid; private-test-key; "token":"another-secret"; https://remote.invalid/file?token=x'}, 'private-test-key')
        self.assertIn('Image size invalid', reason)
        for secret in ('private-test-key','another-secret','https://remote.invalid'):
            self.assertNotIn(secret, reason)

    async def test_submit_rejection_explains_reason_code_and_redacts(self):
        detail={'message':'HTTP 400', 'raw':{'code':8041, 'msg':'Invalid steps at node 3; apiKey=private-test-key token=another-token https://rh.invalid/?token=secret'}}
        with patch.object(rh.core, 'runninghub_submit', AsyncMock(side_effect=rh.HTTPException(400, detail))):
            record=await rh.submit(self.request('error-000001'))
        self.assertEqual(record['status'], 'failed')
        self.assertEqual(record['error_phase'], 'submit')
        self.assertEqual(record['error_code'], '8041')
        self.assertIn('Invalid steps at node 3', record['error'])
        for secret in ('private-test-key','another-token','https://rh.invalid','token=secret'):
            self.assertNotIn(secret, record['error'])

    async def test_execution_and_query_errors_belong_to_original_job(self):
        request=self.request('error-000002')
        rh.save({'id':request.request_id, 'request':request.model_dump(), 'status':'queued', 'task_id':'remote-old', 'outputs':[], 'error':''})
        with patch.object(rh.core, 'runninghub_query', AsyncMock(return_value={'data':{'status':'FAILED','code':805,'failReason':'KSampler node 3: out of memory; Bearer private-test-key'}})):
            record=await rh.query(request.request_id)
        self.assertIn('out of memory', record['error'])
        self.assertEqual(record['error_phase'], 'execution')
        self.assertEqual(record['task_id'], 'remote-old')
        self.assertNotIn('private-test-key', record['error'])
        record['status']='queued'; rh.save(record)
        with patch.object(rh.core, 'runninghub_query', AsyncMock(side_effect=rh.HTTPException(401, {'message':'expired authorization: Bearer private-test-key'}))):
            record=await rh.query(request.request_id)
        self.assertEqual(record['status'], 'queued')
        self.assertEqual(record['error_phase'], 'query')
        self.assertIn('expired', record['error'])
        self.assertNotIn('private-test-key', record['error'])

    def model_request(self,key,count=2):
        return rh.Submit(request_id=key,canvas_id='canvas',node_id='rh-model',kind='model',payload={'provider_id':'runninghub','model':'model-fixture','prompt':'固定手写','size':'1024x1024','quality':'high','reference_images':[{'url':'/api/storage-files/local/reference.png'}],'count':count})

    async def test_model_preserves_protocol_count_idempotency_and_results(self):
        request=self.model_request('model-000001')
        create=AsyncMock(side_effect=[{'task_id':'child-1'},{'task_id':'child-2'}])
        with patch.object(rh.core,'create_canvas_image_task',create):
            first=await rh.submit(request);again=await rh.submit(request)
            self.assertEqual(first['children'],again['children']);self.assertEqual(create.await_count,2)
            body=create.await_args_list[0].args[0]
            self.assertIsInstance(body,rh.core.OnlineImageRequest);self.assertEqual(body.prompt,'固定手写');self.assertEqual(body.quality,'high')
            self.assertEqual(body.reference_images[0].url,'/api/storage-files/local/reference.png')
            request.payload['prompt']='不同输入'
            with self.assertRaises(rh.HTTPException) as error:await rh.submit(request)
            self.assertEqual(error.exception.status_code,409)
        with patch.object(rh.core,'get_canvas_image_task',AsyncMock(side_effect=[{'status':'succeeded','result':{'images':['/output/one.png']}},{'status':'succeeded','result':{'images':['/output/two.png']}}])):
            result=await rh.query(first['id']);self.assertEqual(result['status'],'succeeded');self.assertEqual(len(result['outputs']),2)

    async def test_model_partial_child_receipt_save_failure_never_fills_batch(self):
        original_save=rh.save;calls=0
        def fail_once(record):
            nonlocal calls;calls+=1
            if calls==2:raise OSError('isolated receipt write interrupted')
            original_save(record)
        create=AsyncMock(return_value={'task_id':'child-known'})
        with patch.object(rh,'save',side_effect=fail_once),patch.object(rh.core,'create_canvas_image_task',create):
            result=await rh.submit(self.model_request('model-000002',3));self.assertEqual(result['status'],'uncertain');create.assert_awaited_once()
        with patch.object(rh.core,'create_canvas_image_task',create),patch.object(rh.core,'get_canvas_image_task',AsyncMock(return_value={'status':'succeeded','result':{'images':['/output/partial.png']}})):
            result=await rh.query(result['id']);await rh.submit(self.model_request(result['id'],3))
            self.assertEqual(result['status'],'uncertain');self.assertEqual(result['outputs'][0]['url'],'/output/partial.png');create.assert_awaited_once()
        self.assertNotIn(result['id'],rh.ACTIVE)

    async def test_model_restart_only_queries_or_marks_unknown(self):
        create=AsyncMock(return_value={'task_id':'lost-on-restart'})
        with patch.object(rh.core,'create_canvas_image_task',create):result=await rh.submit(self.model_request('model-000003',1))
        with patch.object(rh.core,'get_canvas_image_task',AsyncMock(side_effect=rh.HTTPException(404,'服务已重启'))),patch.object(rh.core,'create_canvas_image_task',create):
            result=await rh.query(result['id']);await rh.submit(self.model_request(result['id'],1))
            self.assertEqual(result['status'],'unknown');self.assertIn('不会重复提交',result['error']);create.assert_awaited_once()

    async def test_model_known_upstream_task_resumes_after_restart_without_submit(self):
        request=self.model_request('model-000004',1)
        rh.save({'id':request.request_id,'request':request.model_dump(),'status':'queued','task_id':'local-id','submission_complete':True,'children':[{'task_id':'local-id','upstream_task_id':'remote-id','status':'running','outputs':[]}],'outputs':[],'error':''})
        with patch.object(rh.core,'get_canvas_image_task',AsyncMock(side_effect=rh.HTTPException(404,'服务已重启'))),patch.object(rh,'query_model_remote',AsyncMock(return_value={'status':'succeeded','outputs':[{'url':'/output/resumed.png'}]})) as remote,patch.object(rh.core,'create_canvas_image_task',AsyncMock()) as create:
            result=await rh.query(request.request_id);self.assertEqual(result['status'],'succeeded');remote.assert_awaited_once_with('remote-id');create.assert_not_awaited()

    async def test_model_initial_save_failure_creates_no_child(self):
        with patch.object(rh,'save',side_effect=OSError('isolated full disk')),patch.object(rh.core,'create_canvas_image_task',AsyncMock()) as create:
            with self.assertRaises(rh.HTTPException):await rh.submit(self.model_request('model-000005',1))
            create.assert_not_awaited();self.assertNotIn('model-000005',rh.ACTIVE)

    async def test_model_partial_batch_rejection_keeps_querying_submitted_child(self):
        create=AsyncMock(side_effect=[{'task_id':'accepted-child'},rh.HTTPException(400,'第二个子任务参数被拒绝')])
        with patch.object(rh.core,'create_canvas_image_task',create):
            result=await rh.submit(self.model_request('model-000006',3))
            self.assertEqual(result['status'],'uncertain');self.assertEqual(len(result['children']),3)
            self.assertEqual(sum(bool(child['task_id']) for child in result['children']),1)
            with patch.object(rh.core,'get_canvas_image_task',AsyncMock(return_value={'status':'succeeded','result':{'images':['/output/accepted.png']}})) as query:
                result=await rh.query(result['id']);await rh.submit(self.model_request(result['id'],3))
                self.assertEqual(result['status'],'uncertain');query.assert_awaited_once_with('accepted-child');self.assertEqual(create.await_count,2)
                self.assertEqual(result['outputs'],[{'url':'/output/accepted.png'}])

    async def test_model_remote_result_only_retries_archive_without_requery_or_submit(self):
        create=AsyncMock(return_value={'task_id':'archive-child'})
        with patch.object(rh.core,'create_canvas_image_task',create):result=await rh.submit(self.model_request('model-000007',1))
        # Historical parent records predate the stable child-request contract.
        # Keep their already-supported query/archive path compatible.
        result['children'][0].pop('request_id');rh.save(result)
        query=AsyncMock(return_value={'status':'succeeded','result':{'images':['https://media.invalid/result.png']}})
        with patch.object(rh.core,'get_canvas_image_task',query),patch.object(rh.core,'create_canvas_image_task',create),patch.object(rh.core,'runninghub_store_remote_output',AsyncMock(side_effect=[OSError('isolated disk error'),'/output/archived.png'])) as archive:
            result=await rh.query(result['id']);self.assertEqual(result['status'],'archiving');self.assertEqual(result['outputs'][0]['url'],'https://media.invalid/result.png')
            result=await rh.query(result['id']);self.assertEqual(result['status'],'archiving')
            result=await rh.query(result['id']);self.assertEqual(result['status'],'succeeded');self.assertEqual(result['outputs'][0]['url'],'/output/archived.png')
            query.assert_awaited_once_with('archive-child');create.assert_awaited_once();self.assertEqual(archive.await_count,2)

    async def test_child_plan_is_saved_before_dispatch_and_lost_reply_is_found_without_fill(self):
        request=self.model_request('identity-000001',3);ledger={}
        async def lost_reply(payload):
            parent=rh.read(request.request_id)
            self.assertEqual(len(parent['children']),3)
            self.assertEqual([child['request_id'] for child in parent['children']],[rh.model_child_request_id(request.request_id,index) for index in range(3)])
            self.assertEqual(payload.request_id,parent['children'][0]['request_id'])
            self.assertEqual((payload.canvas_id,payload.node_id),('canvas','rh-model'))
            ledger[payload.request_id]={'task_id':'receipt-only','request_id':payload.request_id,'status':'succeeded','result':{'images':['/output/found-after-lost-reply.png']}}
            raise ConnectionError('child created but response lost')
        create=AsyncMock(side_effect=lost_reply)
        with patch.object(rh.core,'create_canvas_image_task',create),patch.object(rh,'find_model_child_request',side_effect=ledger.get):
            result=await rh.submit(request);self.assertEqual(result['status'],'uncertain');self.assertEqual(result['task_id'],'')
            result=await rh.query(request.request_id);await rh.submit(request)
            self.assertEqual(result['status'],'uncertain');self.assertEqual(result['children'][0]['task_id'],'receipt-only')
            self.assertEqual(result['outputs'][0]['url'],'/output/found-after-lost-reply.png');create.assert_awaited_once()

    async def test_parent_receipt_disk_gap_restarts_from_plan_and_child_result(self):
        request=self.model_request('identity-000002',1);ledger={};original_save=rh.save;calls=0
        def fail_receipt_and_final_write(record):
            nonlocal calls;calls+=1
            if calls>1:raise OSError('parent receipt disk gap')
            original_save(record)
        async def create_child(payload):
            ledger[payload.request_id]={'task_id':'stable-child','request_id':payload.request_id,'status':'succeeded','result':{'image_items':[{'url':'/output/ledger-owned.png'}]}}
            return {'task_id':'stable-child'}
        create=AsyncMock(side_effect=create_child)
        with patch.object(rh,'save',side_effect=fail_receipt_and_final_write),patch.object(rh.core,'create_canvas_image_task',create):
            with self.assertRaises(OSError):await rh.submit(request)
        self.assertNotIn(request.request_id,rh.ACTIVE)
        with patch.object(rh,'find_model_child_request',side_effect=ledger.get),patch.object(rh.core,'create_canvas_image_task',create),patch.object(rh.core,'get_canvas_image_task',AsyncMock()) as by_task:
            result=await rh.query(request.request_id);await rh.submit(request)
            self.assertEqual(result['status'],'succeeded');self.assertEqual(result['task_id'],'stable-child')
            self.assertEqual(result['outputs'],[{'url':'/output/ledger-owned.png'}]);create.assert_awaited_once();by_task.assert_not_awaited()

    async def test_restarted_child_receipt_is_aggregated_without_remote_replay(self):
        request=self.model_request('identity-000003',1);child_id=rh.model_child_request_id(request.request_id,0)
        rh.save({'id':request.request_id,'request':request.model_dump(),'status':'uncertain','task_id':'','submission_complete':False,'children':[{'request_id':child_id,'index':0,'task_id':'','status':'planned','outputs':[]}],'outputs':[],'error':''})
        receipt={'protocol':'runninghub-model','task_id':'remote-saved'}
        task={'task_id':'local-ledger','request_id':child_id,'status':'paused','result':None,'receipt':receipt,'upstream_task_id':'remote-saved','queryable':True,'retryable':False,'recovery_status':'receipt_saved'}
        with patch.object(rh,'find_model_child_request',return_value=task),patch.object(rh.core,'create_canvas_image_task',AsyncMock()) as create,patch.object(rh,'query_model_remote',AsyncMock()) as remote,patch.object(rh,'archive_model_outputs',AsyncMock()) as archive:
            for _ in range(2):result=await rh.query(request.request_id)
            self.assertEqual(result['status'],'uncertain');self.assertEqual(result['children'][0]['receipt'],receipt)
            self.assertTrue(result['children'][0]['queryable']);self.assertFalse(result['children'][0]['retryable'])
            create.assert_not_awaited();remote.assert_not_awaited();archive.assert_not_awaited()

    async def test_stable_child_identity_conflict_never_becomes_retryable_failure(self):
        request=self.model_request('identity-000004',1);child_id=rh.model_child_request_id(request.request_id,0)
        def conflict(payload):
            self.assertEqual(payload.request_id,child_id)
            raise rh.HTTPException(409,'same child ID has different inputs')
        create=AsyncMock(side_effect=conflict)
        task={'task_id':'foreign-child','request_id':'different-request','status':'failed','error':'foreign failure'}
        with patch.object(rh.core,'create_canvas_image_task',create),patch.object(rh,'find_model_child_request',return_value=task):
            result=await rh.submit(request);self.assertEqual(result['status'],'uncertain')
            result=await rh.query(request.request_id);self.assertEqual(result['status'],'uncertain');create.assert_awaited_once()
            request.payload['prompt']='different parent inputs'
            with self.assertRaises(rh.HTTPException) as error:await rh.submit(request)
            self.assertEqual(error.exception.status_code,409);create.assert_awaited_once()

    def test_child_identity_is_deterministic_and_bounded_for_long_parent(self):
        parent='p'*100
        ids=[rh.model_child_request_id(parent,index) for index in range(8)]
        self.assertEqual(len(set(ids)),8);self.assertTrue(all(len(value)==73 for value in ids))
        self.assertEqual(ids,[rh.model_child_request_id(parent,index) for index in range(8)])

    async def test_real_legacy_ledger_recovers_parent_storage_gap_and_enforces_identity(self):
        import studio_legacy_tasks as legacy
        request=self.model_request('identity-000005',1);original_save=rh.save;calls=0;created_payloads=[]
        def fail_parent_receipt(record):
            nonlocal calls;calls+=1
            if calls>1:raise OSError('isolated parent storage interruption')
            original_save(record)
        async def create_local_ledger(payload):
            created_payloads.append(payload)
            task,created=legacy.begin('image',payload);self.assertTrue(created)
            legacy.update(task['id'],status='succeeded',result={'images':['/output/local-ledger-result.png']},recovery_status='completed')
            legacy.release(task['id'])  # no in-process owner remains after restart
            return {'task_id':task['id']}
        create=AsyncMock(side_effect=create_local_ledger)
        with patch.object(rh,'save',side_effect=fail_parent_receipt),patch.object(rh.core,'create_canvas_image_task',create):
            with self.assertRaises(OSError):await rh.submit(request)
        with patch.object(rh.core,'create_canvas_image_task',create),patch.object(rh.core,'get_canvas_image_task',AsyncMock()) as by_task:
            result=await rh.query(request.request_id)
            self.assertEqual(result['status'],'succeeded');self.assertEqual(result['outputs'][0]['url'],'/output/local-ledger-result.png')
            task,created=legacy.begin('image',created_payloads[0]);self.assertFalse(created)
            self.assertEqual(task['task_id'],result['task_id'])
            changed=created_payloads[0].model_copy(update={'prompt':'changed identity inputs'})
            with self.assertRaises(rh.HTTPException) as error:legacy.begin('image',changed)
            self.assertEqual(error.exception.status_code,409);create.assert_awaited_once();by_task.assert_not_awaited()


if __name__ == '__main__': unittest.main()
