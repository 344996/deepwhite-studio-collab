import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import studio_feedback as feedback


class FeedbackTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='dw-feedback-')
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        for scope in [patch.object(feedback, 'folder', return_value=self.directory / 'outbox'),
                      patch.object(feedback.studio_gallery, 'read', return_value={'url': ''})]:
            scope.start()
            self.addCleanup(scope.stop)
        self.app = FastAPI()
        feedback.install(self.app)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.payload = {'id': str(uuid4()), 'category': 'bug', 'title': '保存遇到问题', 'description': '编辑后刷新没有保留位置'}

    def create(self):
        response = self.client.post('/api/studio/feedback', json=self.payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_save_without_website_keeps_private_receipt(self):
        row = self.create()
        self.assertFalse(row['sent'])
        self.assertNotIn('receipt_key', row)
        result = self.client.post('/api/studio/feedback/' + row['id'] + '/send').json()
        self.assertIn('本机', result['message'])
        self.assertEqual(len(self.client.get('/api/studio/feedback').json()['items']), 1)
        self.create()
        self.assertEqual(len(list((self.directory / 'outbox').glob('*.json'))), 1)

    def test_retry_same_receipt_after_uncertain_network_and_pinned_destination(self):
        row = self.create()
        calls, failed = [], [True]
        def handler(request):
            if request.url.path.endswith('/session'):
                return httpx.Response(200, json={'csrf': 'fixture-csrf'}, headers={'set-cookie': 'gallery=fixture'})
            body = json.loads(request.content)
            calls.append((str(request.url), body))
            if failed[0]:
                failed[0] = False
                raise httpx.ReadTimeout('fixture after server accepted request')
            self.assertEqual(request.headers['origin'], 'https://feedback.invalid')
            self.assertEqual(request.headers['x-csrf-token'], 'fixture-csrf')
            return httpx.Response(201, json={'id': row['id'], 'status': 'new', 'revision': 1, 'reply': ''})
        with patch.object(feedback, 'TRANSPORT', httpx.MockTransport(handler)), patch.object(feedback.studio_gallery, 'read', return_value={'url':'https://feedback.invalid'}):
            first = self.client.post('/api/studio/feedback/' + row['id'] + '/send').json()
            self.assertFalse(first['sent'])
            with patch.object(feedback.studio_gallery, 'read', return_value={'url':'https://different.invalid'}):
                second = self.client.post('/api/studio/feedback/' + row['id'] + '/send').json()
            self.assertTrue(second['sent'])
        self.assertEqual(calls[0], calls[1])
        self.assertNotIn('receipt_key', second)
        self.assertNotIn('password', calls[0][1])

    def test_disk_failure_preserves_saved_record(self):
        self.create()
        original = feedback.path(self.payload['id']).read_bytes()
        with patch.object(feedback.core, '_atomic_write_bytes', side_effect=OSError('fixture full disk')):
            response = self.client.post('/api/studio/feedback/' + self.payload['id'] + '/send')
        self.assertEqual(response.status_code, 507)
        self.assertEqual(feedback.path(self.payload['id']).read_bytes(), original)

    def test_opt_in_diagnostics_do_not_include_paths_or_credentials(self):
        self.payload['include_diagnostics'] = True
        self.payload['description'] += ' api_key=fixture-secret-value'
        row = self.create()
        saved = feedback.load(row['id'])
        self.assertEqual(set(saved['diagnostics']), {'version', 'platform', 'client'})
        self.assertNotIn('fixture-secret-value', saved['description'])

    def test_bad_attachment_and_missing_record_do_not_create_files(self):
        self.payload['screenshot'] = 'not-base64'
        self.assertEqual(self.client.post('/api/studio/feedback', json=self.payload).status_code, 422)
        self.assertFalse(feedback.folder().exists())
        self.assertEqual(self.client.post('/api/studio/feedback/' + str(uuid4()) + '/send').status_code, 404)

    def test_retry_cannot_silently_add_diagnostics_to_existing_draft(self):
        self.create()
        self.payload['include_diagnostics'] = True
        self.assertEqual(self.client.post('/api/studio/feedback', json=self.payload).status_code, 409)
        self.assertEqual(feedback.load(self.payload['id'])['diagnostics'], {})

    def test_authorization_header_and_quoted_json_secrets_redacted(self):
        self.payload['description'] = 'Authorization: Bearer fictional_credential_1234\n{"password":"fictional_password_1234"}'
        row = self.create()
        self.assertNotIn('fictional_credential_1234', row['description'])
        self.assertNotIn('fictional_password_1234', row['description'])
