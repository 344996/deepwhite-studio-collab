"""Local prompt import, persistence and boundary regressions; no external API calls."""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

runtime = tempfile.TemporaryDirectory(prefix='dw-gallery-import-')
os.environ.setdefault('DEEPWHITE_STUDIO_RUNTIME_DIR', runtime.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import studio_server
import studio_gallery_import as importer
import main as core
from fastapi.testclient import TestClient


class GalleryImportTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)
        self.payload = {'operation_id': uuid.uuid4().hex, 'project_id': 'default', 'payload': {
            'schema': 'deepwhite.prompt.v1', 'title': '来自画廊', 'prompt': '日落\n海边 <script>alert(1)</script>',
            'kind': 'image', 'source_url': 'https://gallery.example/work/test'}}

    def send(self, payload=None, **kwargs):
        return self.client.post('/api/studio/gallery/import', json=payload or self.payload,
                                headers={'Origin': 'http://testserver'}, **kwargs)

    def test_creates_only_prompt_no_job_or_remote_media(self):
        result = self.send()
        self.assertEqual(result.status_code, 200, result.text)
        canvas = core.load_canvas(result.json()['canvas_id'])
        self.assertEqual(canvas['kind'], 'classic')
        self.assertEqual([n['type'] for n in canvas['nodes']], ['prompt'])
        self.assertEqual(canvas['nodes'][0]['text'], self.payload['payload']['prompt'])
        self.assertEqual(canvas['connections'], [])
        self.assertEqual(canvas['gallery_source']['url'], self.payload['payload']['source_url'])

    def test_replay_after_reload_keeps_user_edits(self):
        result = self.send().json()
        canvas = core.load_canvas(result['canvas_id'])
        canvas['nodes'][0]['text'] = '用户新的编辑'
        core.save_canvas(canvas)
        importlib.reload(importer)
        self.assertEqual(self.send().json(), result)
        self.assertEqual(core.load_canvas(result['canvas_id'])['nodes'][0]['text'], '用户新的编辑')
        self.payload['payload']['prompt'] = '其他内容'
        self.assertEqual(self.send().status_code, 409)

    def test_failure_can_retry_without_empty_canvas(self):
        with patch.object(core, 'save_canvas', side_effect=OSError('fixture disk full')):
            self.assertEqual(self.send().status_code, 507)
        self.assertFalse(Path(core.canvas_path('gallery_' + self.payload['operation_id'])).exists())
        self.assertEqual(self.send().status_code, 200)

    def test_receipt_failure_writes_no_canvas(self):
        with patch.object(core, '_atomic_write_bytes', side_effect=OSError('fixture no permission')):
            self.assertEqual(self.send().status_code, 507)
        self.assertFalse(Path(core.canvas_path('gallery_' + self.payload['operation_id'])).exists())

    def test_deleted_canvas_is_not_resurrected_by_retry(self):
        result = self.send().json()
        canvas = core.load_canvas(result['canvas_id']);canvas['deleted_at'] = core.now_ms();core.save_canvas(canvas)
        self.assertEqual(self.send().status_code, 409)
        Path(core.canvas_path(result['canvas_id'])).unlink()
        self.assertEqual(self.send().status_code, 409)

    def test_invalid_schema_extra_fields_and_unsafe_sources(self):
        for edit in ({'schema': 'unknown'}, {'api_key': 'secret'}, {'nodes': []}, {'prompt': ' '}, {'prompt': 'a' * 8001},
                     {'source_url': 'javascript:alert(1)'}, {'source_url': 'https://u:p@evil.test'}, {'source_url': 'https://a\\b.test'}):
            value = {**self.payload, 'payload': {**self.payload['payload'], **edit}}
            with self.subTest(edit=next(iter(edit))):
                self.assertEqual(self.send(value).status_code, 422)
        self.payload['operation_id'] = '../../escape'
        self.assertEqual(self.send().status_code, 422)

    def test_origin_and_received_bytes_are_required(self):
        endpoint = '/api/studio/gallery/import'
        self.assertEqual(self.client.post(endpoint, json=self.payload).status_code, 403)
        self.assertEqual(self.client.post(endpoint, json=self.payload, headers={'Origin': 'https://gallery.example'}).status_code, 403)
        response = self.client.post(endpoint, content=iter([b' ' * 40000, b' ' * 40000]),
            headers={'Origin': 'http://testserver', 'Content-Type': 'application/json'})
        self.assertEqual(response.status_code, 413)

    def test_project_validation_and_page_security(self):
        self.payload['project_id'] = 'missing'
        self.assertEqual(self.send().status_code, 404)
        project = core.new_project('画廊导入测试')
        self.payload['project_id'] = project['id']
        result = self.send().json()
        self.assertEqual(core.load_canvas(result['canvas_id'])['project'], project['id'])
        page = self.client.get('/gallery-import')
        self.assertEqual(page.status_code, 200)
        self.assertIn("frame-ancestors 'none'", page.headers['Content-Security-Policy'])
        self.assertEqual(page.headers['Referrer-Policy'], 'no-referrer')
