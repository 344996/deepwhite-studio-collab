"""F08 (handover 2026-10-26): Suno sound effects and music follow the real DeepWhite catalogue.

The catalogue lists `suno-generation` (POST /music/generations) and `suno-sounds`
(POST /music/generations/sounds) as separate models. Sound effects were rejected unless an old
`suno`/`suno-music` entry existed. Offline: nothing is submitted.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix='dw-audio-suno-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name

import main as core
import studio_generation as generation
from studio_capabilities import profile
from fastapi import HTTPException

BASE = 'https://api.deepwhiteai.com'


class SunoCatalogTests(unittest.TestCase):
    def check(self, model, ids, channel):
        payload = generation.Generation(request_id='audio-suno-0001', provider_id='deepwhite', model=model,
                                        kind='audio', prompt='远处雷声', params={'channel': channel})
        # The real builder, so classification and variants match a synced catalogue.
        store = {'deepwhite': {'base_url': BASE, 'models': generation.catalog.build_catalog(ids)}}
        provider = {'id': 'deepwhite', 'enabled': True, 'base_url': BASE}
        with patch.object(generation.catalog, 'load_store', return_value=store), \
             patch.object(core, 'get_api_provider', return_value=provider), \
             patch.object(core, 'get_api_provider_exact', return_value=provider), \
             patch.object(core, 'provider_env_key_value', return_value='test-key'):
            return generation.checked(payload)

    def test_sound_effects_need_only_their_own_catalogue_entry(self):
        req, raw, _ = self.check('suno-sounds', ['suno-sounds'], 'sound')
        self.assertEqual(raw, 'suno-sounds')
        self.assertEqual(generation.audio_body(raw, req['prompt'], req['params']), ('/music/generations/sounds', {'model': 'suno', 'prompt': '远处雷声'}))

    def test_suno_generation_is_the_music_model(self):
        self.assertEqual(profile('suno-generation', 'audio')['channel'], 'music')
        self.assertNotEqual(profile('suno-generation', 'audio').get('supported'), False)
        req, raw, _ = self.check('suno-generation', ['suno-generation'], 'music')
        endpoint, body = generation.audio_body(raw, req['prompt'], {**req['params'], 'version': 'v5'})
        self.assertEqual(endpoint, '/music/generations')
        self.assertEqual((body['model'], body['version']), ('suno', 'v5'))

    def test_without_any_suno_sound_entry_the_reason_names_the_sound_model(self):
        with self.assertRaises(HTTPException) as caught:
            self.check('suno-sounds', ['qwen3-tts-flash'], 'sound')
        self.assertIn('suno-sounds', caught.exception.detail)

    def test_older_catalogues_with_only_a_music_entry_still_allow_sound_effects(self):
        _, raw, _ = self.check('suno-sounds', ['suno'], 'sound')
        self.assertEqual(raw, 'suno-sounds')


if __name__ == '__main__':
    unittest.main()
