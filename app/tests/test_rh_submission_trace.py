"""REF-03 (handover 2026-10-26): the RunningHub ledger traces media like the general generation path.

Before the paid POST the ledger records, for every media field, which local file and asset version
was sent, its SHA-256 and the RH file name it was uploaded as. No key or signed link is stored.
The RH upstream is mocked; nothing is submitted or billed.
"""
import base64
import hashlib
import json
import os
import re
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix='dw-rh-trace-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import studio_server
import main as core

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')


class TraceTests(unittest.TestCase):
    def setUp(self):
        original = httpx.AsyncClient
        self.posts = []

        def upstream(request):
            if request.url.path.endswith('/task/openapi/upload'):
                return httpx.Response(200, json={'code': 0, 'data': {'fileName': 'api/up-' + uuid.uuid4().hex[:6] + '.png', 'fileType': 'image'}})
            if request.url.path.endswith('/task/openapi/ai-app/run'):
                self.posts.append(json.loads(request.content))
                return httpx.Response(200, json={'code': 0, 'data': {'taskId': 'rh-trace-1'}})
            return httpx.Response(404, json={'code': 404})
        provider = {'id': 'runninghub', 'name': 'RunningHub', 'base_url': 'https://rh.invalid', 'api_key': 'trace-secret-key'}
        for item in (patch.object(core.httpx, 'AsyncClient', side_effect=lambda *a, **kw: original(*a, **{**kw, 'transport': httpx.MockTransport(upstream)})),
                     patch.object(core, 'runninghub_provider', side_effect=lambda: dict(provider)),
                     patch.object(core, 'runninghub_api_key', side_effect=lambda *a, **k: 'trace-secret-key')):
            item.start(); self.addCleanup(item.stop)
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)
        folder = Path(core.storage_kind_dir('generated')); folder.mkdir(parents=True, exist_ok=True)
        (folder / 'trace-person.png').write_bytes(PNG + b'person')
        self.version_url = self.client.post('/api/studio/assets/register', json={'url': '/api/storage-files/generated/trace-person.png'}).json()['item']['url']
        self.version_id = re.search(r'assets/([a-f0-9]{32})/file', self.version_url).group(1)

    def test_ledger_records_source_version_hash_and_upload_before_the_post(self):
        uploaded = self.client.post('/api/runninghub/upload-asset', json={'url': self.version_url, 'kind': 'image'}).json()['data']['fileName']
        request = {'request_id': str(uuid.uuid4()), 'canvas_id': 'c', 'node_id': 'n', 'kind': 'app',
                   'payload': {'webappId': '1234567890', 'nodeInfoList': [{'nodeId': '403', 'fieldName': 'image', 'fieldValue': uploaded},
                                                                           {'nodeId': '9', 'fieldName': 'text', 'fieldValue': '雨夜'}],
                               'useWallet': False, 'instanceType': ''}}
        job = self.client.post('/api/studio/runninghub/tasks', json=request).json()
        snapshot = job['submission']
        self.assertEqual(snapshot['recorded'], 'local_before_send')
        self.assertEqual(snapshot['media'], [{'node': '403', 'field': 'image', 'uploaded_as': uploaded, 'source': self.version_url,
                                              'version_id': self.version_id, 'sha256': hashlib.sha256(PNG + b'person').hexdigest()}])
        self.assertRegex(snapshot['body_sha256'], r'^[0-9a-f]{64}$')
        self.assertNotIn('trace-secret-key', json.dumps(job, ensure_ascii=False))

    def test_unknown_file_names_are_listed_without_inventing_a_source(self):
        request = {'request_id': str(uuid.uuid4()), 'canvas_id': 'c', 'node_id': 'n', 'kind': 'app',
                   'payload': {'webappId': '1234567890', 'nodeInfoList': [{'nodeId': '403', 'fieldName': 'image', 'fieldValue': 'api/uploaded-elsewhere.png'}],
                               'useWallet': False, 'instanceType': ''}}
        media = self.client.post('/api/studio/runninghub/tasks', json=request).json()['submission']['media']
        self.assertEqual(media, [{'node': '403', 'field': 'image', 'uploaded_as': 'api/uploaded-elsewhere.png', 'source': '', 'version_id': '', 'sha256': ''}])


class TraceIndexTests(unittest.TestCase):
    def setUp(self):
        import studio_runninghub
        self.rh = studio_runninghub
        self.rh.upload_index_path().unlink(missing_ok=True)

    def test_parallel_uploads_all_stay_traced(self):
        import threading
        threads = [threading.Thread(target=self.rh.remember_upload, args=(f'api/p{i}.png', f'/output/p{i}.png', PNG + bytes([i])))
                   for i in range(24)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        index = json.loads(self.rh.upload_index_path().read_text(encoding='utf-8'))
        self.assertEqual(len(index), 24, 'a parallel upload overwrote another one')

    def test_model_requests_are_traced_by_field_path(self):
        self.rh.remember_upload('api/m1.png', '/output/m1.png', PNG)
        snapshot = self.rh.submission_snapshot({'model': 'rh/some-model', 'params': {'image_urls': ['api/m1.png'], 'prompt': '雨夜'}})
        self.assertEqual([(m['field'], m['uploaded_as'], m['source']) for m in snapshot['media']],
                         [('params.image_urls[0]', 'api/m1.png', '/output/m1.png')])

    def test_a_damaged_index_is_ignored(self):
        self.rh.upload_index_path().write_text(json.dumps({'api/x.png': 'not-a-dict', 'api/y.png': {'at': 1}}), encoding='utf-8')
        self.rh.remember_upload('api/z.png', '/output/z.png', PNG)
        index = json.loads(self.rh.upload_index_path().read_text(encoding='utf-8'))
        self.assertEqual(sorted(index), ['api/y.png', 'api/z.png'])
        self.assertEqual(len(self.rh.submission_snapshot({'nodeInfoList': [{'nodeId': '1', 'fieldName': 'image', 'fieldValue': 'api/x.png'}]})['media']), 1)


if __name__ == '__main__':
    unittest.main()
