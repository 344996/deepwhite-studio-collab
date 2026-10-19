"""Local capability and GET-only diagnostics boundaries; no upstream generation."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_runtime = tempfile.TemporaryDirectory(prefix='dw-provider-capabilities-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = _runtime.name
import studio_provider_capabilities as capabilities


class ProviderCapabilities(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'diagnostics.json'
        self.patch = patch.object(capabilities, '_path', return_value=self.path)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.provider = {'id':'fixture', 'protocol':'openai', 'base_url':'https://api.deepwhiteai.com/v1',
                         'image_models':['deepwhiteai-image-g-v2.5-lowprice'], 'audio_models':['unrecognized-audio']}

    def test_builtin_models_do_not_claim_live_verification(self):
        report = capabilities.describe(self.provider)
        image = next(row for row in report['capabilities'] if row['kind'] == 'image')
        audio = next(row for row in report['capabilities'] if row['kind'] == 'audio')
        self.assertEqual(image['status'], 'adapted')
        self.assertEqual(audio['status'], 'no-adapted-model')
        self.assertFalse(any(row['live_generation_verified'] for row in report['capabilities']))
        self.assertFalse(report['account_is_generation_credential'])
        self.assertFalse(report['account_required_for_local_editing'])

    def test_custom_url_never_inherits_deepwhite_generation_support(self):
        report = capabilities.describe({**self.provider, 'base_url':'https://custom.invalid/v1'})
        values = {row['kind']:row['status'] for row in report['capabilities']}
        self.assertEqual(values['image'], 'protocol-compatible')
        self.assertEqual(values['video'], 'model-specific')
        self.assertEqual(values['audio'], 'not-adapted')
        report = capabilities.describe({**self.provider, 'base_url':'https://custom.invalid', 'protocol':'anthropic'})
        self.assertTrue(all(row['status'] == 'not-adapted' for row in report['capabilities']))

    def test_probe_receipt_is_bound_to_address_and_contains_no_credentials(self):
        capabilities.record_probe('fixture', self.provider['base_url'], {'model_count':7,'api_key':'synthetic-secret'})
        receipt = capabilities._receipts()['fixture']
        report = capabilities.describe(self.provider, receipt)
        self.assertEqual(report['connection_check']['scope'], 'model-list-only')
        self.assertEqual(report['connection_check']['model_count'], 7)
        self.assertNotIn('synthetic-secret', self.path.read_text())
        self.assertNotIn('address_hash', json.dumps(report))
        changed = {**self.provider, 'base_url':'https://other.invalid/v1'}
        self.assertIsNone(capabilities.describe(changed, receipt)['connection_check'])

    def test_damaged_nonessential_diagnostics_do_not_block_settings(self):
        self.path.write_text('{broken')
        self.assertEqual(capabilities._receipts(), {})
        capabilities.record_probe('fixture', self.provider['base_url'], {'model_count':0})
        self.assertEqual(capabilities._receipts()['fixture']['model_count'], 0)


if __name__ == '__main__':
    unittest.main()
