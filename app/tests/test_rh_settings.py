"""U07 (handover 2026-10-26): RunningHub credentials and defaults are managed in Settings.

One key store shared with the canvas, keys never echoed, defaults validated and kept. Offline.
"""
import json
import os
import sys
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()
