"""U07 (handover 2026-10-26): RunningHub credentials and defaults are managed in Settings.

One key store shared with the canvas, keys never echoed, defaults validated and kept. Offline.
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix='dw-rh-settings-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import studio_server
import main as core


class RhSettingsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)

    def put(self, body, status=200):
        response = self.client.put('/api/studio/settings/runninghub', json=body)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def test_saved_key_is_the_one_the_canvas_uses_and_is_never_returned(self):
        saved = self.put({'api_key': 'rh-member-key-123', 'wallet_api_key': 'rh-wallet-key-456'})
        self.assertTrue(saved['has_key'] and saved['has_wallet_key'])
        listed = self.client.get('/api/studio/settings/runninghub').json()
        for secret in ('rh-member-key-123', 'rh-wallet-key-456'):
            self.assertNotIn(secret, json.dumps(saved) + json.dumps(listed))
        self.assertEqual(core.runninghub_api_key(), 'rh-member-key-123')
        self.assertEqual(core.runninghub_api_key(use_wallet=True), 'rh-wallet-key-456')
        self.assertEqual(sum(1 for p in core.load_api_providers() if p['id'] == 'runninghub'), 1)

    def test_blank_key_keeps_the_saved_one_and_clear_removes_it(self):
        self.put({'api_key': 'rh-keep-me-789'})
        self.put({'api_key': '', 'default_payment': 'wallet'})
        self.assertEqual(core.runninghub_api_key(), 'rh-keep-me-789')
        self.assertFalse(self.put({'clear_key': True})['has_key'])

    def test_defaults_are_validated_and_kept(self):
        saved = self.put({'default_payment': 'wallet', 'default_instance': 'plus'})
        self.assertEqual((saved['default_payment'], saved['default_instance']), ('wallet', 'plus'))
        self.put({'default_payment': 'credit'}, 400)
        self.put({'default_instance': 'huge'}, 400)
        listed = self.client.get('/api/studio/settings/runninghub').json()
        self.assertEqual((listed['default_payment'], listed['default_instance']), ('wallet', 'plus'))

    def test_wallet_default_without_a_wallet_key_is_flagged(self):
        self.put({'clear_wallet_key': True, 'default_payment': 'free'})
        self.assertNotIn('钱包 Key', self.put({'default_payment': 'free'})['message'])
        self.assertIn('还没有保存钱包 Key', self.put({'default_payment': 'wallet'})['message'])
        self.assertNotIn('还没有保存钱包 Key', self.put({'wallet_api_key': 'wallet-key-1'})['message'])

    def probe(self, answers):
        """Fake the catalogue read: answers maps a key to (openapi_status, errors)."""
        sent = []

        async def fake(provider):
            sent.append(provider['api_key'])
            status, errors = answers[provider['api_key']]
            return {'raw': {'openapi_status': status, 'source': 'openapi' if status == 200 else 'fallback', 'errors': errors}}
        with mock.patch.object(core, 'runninghub_models_payload', fake):
            response = self.client.post('/api/studio/settings/runninghub/test')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json(), sent

    def test_connection_check_without_a_key_says_so_and_reads_nothing(self):
        self.put({'clear_key': True, 'clear_wallet_key': True})
        result, sent = self.probe({})
        self.assertEqual(sent, [], 'nothing may be sent without a key')
        self.assertTrue(result['missing'])
        self.assertIn('尚未保存', result['message'])

    def test_each_key_is_checked_on_its_own(self):
        self.put({'api_key': 'member-ok', 'wallet_api_key': 'wallet-bad'})
        result, sent = self.probe({'member-ok': (200, []), 'wallet-bad': (401, ['openapi: HTTP 401'])})
        self.assertEqual(sorted(sent), ['member-ok', 'wallet-bad'])
        auth = {item['key']: item['stages']['auth'] for item in result['checks']}
        self.assertEqual(auth, {'member': 'ok', 'wallet': 'failed'})
        self.assertFalse(result['ok'])
        self.assertIn('钱包 Key', result['message'])
        self.assertIn('401', result['message'])
        self.assertNotIn('member-ok', json.dumps(result))

    def test_timeout_is_reported_as_a_timeout(self):
        self.put({'api_key': 'member-slow', 'clear_wallet_key': True})
        result, _ = self.probe({'member-slow': (None, ['openapi: ReadTimeout: timed out'])})
        member = result['checks'][0]
        self.assertEqual((member['stages']['service'], member['stages']['reach']), (False, 'timeout'))
        self.assertIn('超时', result['message'])
        self.assertEqual(result['checks'][1], {'key': 'wallet', 'label': '钱包 Key', 'saved': False})


if __name__ == '__main__':
    unittest.main()
