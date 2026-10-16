"""MJ receipts and recovery with a temporary store and an upstream MockTransport only."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_import_runtime = tempfile.TemporaryDirectory(prefix='dw-mj-import-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = _import_runtime.name
import httpx
from fastapi import FastAPI
import main as core
import studio_midjourney as mj
import studio_mj_history as history

Client = httpx.AsyncClient


class MidjourneyRecovery(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = tempfile.TemporaryDirectory(prefix='dw-mj-recovery-')
        self.requests = []
        self.reply = {'data': {'task_id': 'task_receipt', 'status': 'SUBMITTED'}}
        self.failure = None
        self.providers = {p: {'id': p, 'base_url': f'https://{p}.invalid/v1', 'enabled': True}
                          for p in ('original', 'other')}
        self.patches = [
            patch.object(core, 'DATA_DIR', self.runtime.name),
            patch.object(core, 'get_api_provider', side_effect=lambda p: self.providers[p]),
            patch.object(core, 'provider_env_key_value', return_value='mock-mj-not-a-real-key'),
            patch.object(core, 'generate_ai_image', AsyncMock()),
            patch.object(mj.catalog, 'load_store', side_effect=lambda: {
                p: {'base_url': v['base_url'], 'models': [{'id': 'midjourney-'+a, 'enabled': True}
                                                        for a in mj.SPECS]}
                for p, v in self.providers.items()}),
            patch.object(mj.httpx, 'AsyncClient', side_effect=lambda **kw: Client(
                transport=httpx.MockTransport(self.transport), **kw)),
        ]
        for p in self.patches: p.start()
        app = FastAPI()
        mj.install(app)
        self.api = Client(transport=httpx.ASGITransport(app=app), base_url='http://local.invalid')

    async def asyncTearDown(self):
        await self.api.aclose()
        for p in reversed(self.patches): p.stop()
        self.runtime.cleanup()

    def transport(self, request):
        self.requests.append(request)
        if self.failure == 'network': raise httpx.ConnectError('fixture disconnect', request=request)
        if self.failure == 'json': return httpx.Response(200, text='<html>fixture gateway</html>')
        return httpx.Response(200, json=self.reply)

    async def submit(self, node='node-a'):
        return await self.api.post('/api/studio/mj/submit', json={
            'provider_id': 'original', 'action': 'imagine', 'canvas_id': 'isolated-canvas',
            'node_id': node, 'params': {'prompt': 'offline cat', 'size': '16:9', 'speed': 'turbo'}})

    async def poll(self, task='task_receipt', provider='original'):
        return await self.api.get(f'/api/studio/mj/tasks/{task}?provider_id={provider}')

    def record(self, node='node-a'):
        return next(r for r in history.items('isolated-canvas') if r['request']['node_id'] == node)

    async def test_effective_request_and_receipt_are_saved_before_archive_failure(self):
        self.reply = {'data': {'task_id': 'task_receipt', 'status': 'SUCCESS',
                               'image_url': 'https://cdn.invalid/fixture.png'}}

        async def archive_failure(result, context):
            receipt = self.record()
            self.assertEqual(receipt['task_ids'], ['task_receipt'])
            self.assertEqual(receipt['remote_status'], 'succeeded')
            self.assertEqual(receipt['media_status'], 'pending')
            self.assertEqual(receipt['outputs'], [])
            self.assertEqual(context['node_id'], 'node-a')
            raise OSError('fixture disk unavailable')

        with patch.object(mj, 'persist_result', side_effect=archive_failure):
            response = await self.submit()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual((result['status'], result['remote_status'], result['media_status']),
                         ('paused', 'succeeded', 'failed'))
        self.assertEqual(result['task_id'], 'task_receipt')
        self.assertEqual(result['images'], [])
        self.assertEqual(result['history_id'], self.record()['id'])
        sent = json.loads(self.requests[0].content)
        self.assertEqual((sent['size'], sent['speed'], sent['version']), ('16:9', 'turbo', '8.2'))
        self.assertNotIn('resolution', sent)
        self.assertEqual(self.record()['status'], 'paused')
        self.assertEqual(self.record()['task_ids'], ['task_receipt'])

    async def test_poll_network_and_json_failures_keep_id_then_recover_with_get(self):
        self.assertEqual((await self.submit()).status_code, 200)
        for problem in ('network', 'json'):
            self.failure = problem
            response = await self.poll()
            self.assertEqual(response.status_code, 502, response.text)
            receipt = self.record()
            self.assertEqual(receipt['status'], 'paused')
            self.assertEqual(receipt['task_ids'], ['task_receipt'])
            self.assertIn('查询失败', receipt['error'])
        self.failure = None
        # Some valid task responses omit the task ID; the queried ID remains authoritative.
        self.reply = {'data': {'status': 'SUCCESS', 'image_url': 'https://cdn.invalid/fixture.png'}}

        async def save_media(result, context):
            result['images'] = ['/output/recovered.png']

        with patch.object(mj, 'persist_result', side_effect=save_media):
            response = await self.api.post('/api/studio/mj/history/'+self.record()['id']+'/resume', json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['task_id'], 'task_receipt')
        self.assertEqual(self.record()['status'], 'succeeded')
        self.assertEqual(self.record()['error'], '')
        self.assertEqual(self.record()['outputs'][0]['url'], '/output/recovered.png')
        self.assertEqual(sum(r.method == 'POST' for r in self.requests), 1)
        self.assertEqual(self.requests[-1].method, 'GET')

    async def test_registry_failure_does_not_lose_receipt_or_action(self):
        with patch.object(mj, 'remember', side_effect=OSError('fixture registry unavailable')):
            response = await self.submit()
        self.assertEqual(response.status_code, 200, response.text)
        record = self.record()
        self.assertEqual(record['task_ids'], ['task_receipt'])
        self.assertEqual(record['status'], 'running')
        self.assertIn('registry_error', record)
        self.reply = {'data': {'status': 'SUCCESS', 'text': 'recovered original task'}}
        result = (await self.poll()).json()
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['task_id'], 'task_receipt')
        self.assertEqual(self.requests[-1].method, 'GET')
        before = len(self.requests)
        self.assertEqual((await self.poll(provider='other')).status_code, 400)
        self.assertEqual(len(self.requests), before)

    async def test_saved_success_can_archive_when_remote_query_is_unavailable(self):
        self.reply = {'data': {'task_id': 'task_receipt', 'status': 'SUCCESS',
                               'image_url': 'https://cdn.invalid/fixture.png'}}
        with patch.object(mj, 'persist_result', AsyncMock(side_effect=OSError('fixture disk failure'))):
            result = (await self.submit()).json()
        self.assertEqual(result['status'], 'paused')
        self.failure = 'network'

        async def save_media(result, context): result['images'] = ['/output/cached.png']
        with patch.object(mj, 'persist_result', side_effect=save_media):
            response = await self.poll()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['media_status'], 'completed')
        self.assertEqual(len(self.requests), 1, 'Archiving a saved success must not require another upstream call')

    async def test_failed_remote_task_stays_failed(self):
        await self.submit()
        self.reply = {'data': {'status': 'FAILURE'}}
        response = await self.poll()
        self.assertEqual(response.json()['status'], 'failed')
        self.assertEqual(self.record()['remote_status'], 'failed')
        self.assertEqual(self.record()['status'], 'failed')
        self.assertTrue(self.record()['error'])

    async def test_unknown_submission_stays_uncertain_and_history_resume_never_posts(self):
        self.failure = 'json'
        response = await self.submit()
        self.assertEqual(response.status_code, 502)
        record = self.record()
        self.assertEqual(record['status'], 'uncertain')
        self.assertEqual(record['task_ids'], [])
        response = await self.api.post('/api/studio/mj/history/'+record['id']+'/resume', json={})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(len(self.requests), 1)

    async def test_immediate_result_without_task_id_retries_cached_archive_only(self):
        self.reply = {'data': {'status': 'SUCCESS', 'image_url': 'https://cdn.invalid/direct.png'}}
        with patch.object(mj, 'persist_result', AsyncMock(side_effect=OSError('fixture archive failure'))):
            result = (await self.submit()).json()
        self.assertEqual(result['task_id'], '')
        self.assertEqual(self.record()['status'], 'paused')

        async def save_media(result, context): result['images'] = ['/output/direct.png']
        with patch.object(mj, 'persist_result', side_effect=save_media):
            response = await self.api.post('/api/studio/mj/history/'+result['history_id']+'/resume', json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['media_status'], 'completed')
        self.assertEqual(len(self.requests), 1)

    async def test_channel_and_node_isolation(self):
        await self.submit('node-a')
        self.reply = {'data': {'task_id': 'task_second', 'status': 'SUBMITTED'}}
        await self.submit('node-b')
        self.failure = 'network'
        await self.poll('task_receipt')
        self.assertEqual(self.record('node-a')['status'], 'paused')
        self.assertEqual(self.record('node-b')['status'], 'running')
        before = len(self.requests)
        self.assertEqual((await self.poll(provider='other')).status_code, 400)
        action = await self.api.post('/api/studio/mj/submit', json={
            'provider_id': 'other', 'action': 'upscale', 'params': {'task_id': 'task_receipt', 'index': 1}})
        self.assertEqual(action.status_code, 400)
        self.providers['original']['base_url'] = 'https://changed.invalid/v1'
        self.assertEqual((await self.poll()).status_code, 400)
        self.assertEqual(len(self.requests), before)

    async def test_legacy_generate_wrapper_stops_on_paused_and_never_polls_empty_id(self):
        for task_id in ('task_saved', ''):
            result={'task_id':task_id,'history_id':'mj_saved','status':'paused','images':[],
                    'remote_status':'succeeded','media_status':'failed','error':'结果保存失败，请恢复原任务'}
            with patch.object(mj,'submit',AsyncMock(return_value=result)), patch.object(mj,'poll',AsyncMock()) as poll:
                from fastapi import HTTPException
                with self.assertRaises(HTTPException) as error:
                    await core.generate_ai_image('offline prompt','1024x1024','auto','midjourney-imagine',provider_id='original')
                self.assertIn(task_id or 'mj_saved',str(error.exception.detail))
                self.assertIn('结果保存失败',str(error.exception.detail))
                poll.assert_not_called()


if __name__ == '__main__':
    unittest.main()
