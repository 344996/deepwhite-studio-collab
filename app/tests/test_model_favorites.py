"""U04/UX03 (handover 2026-10-26): favourites are stored per kind as "provider|model" keys.

Validation, de-duplication, per-kind separation, and a damaged file never breaking the picker. Offline.
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
runtime = tempfile.TemporaryDirectory(prefix='dw-favourites-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import studio_server
import studio_favorites as favourites


class ModelFavouriteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)
        favourites.path().unlink(missing_ok=True)

    def put(self, kind, keys, status=200):
        response = self.client.put(f'/api/studio/model-favorites/{kind}', json={'keys': keys})
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def test_kinds_are_separate_and_duplicates_collapse(self):
        self.put('image', ['deepwhite|img-a', 'mirror|img-a', 'deepwhite|img-a'])
        saved = self.put('video', ['deepwhite|vid-a'])
        self.assertEqual(saved['image'], ['deepwhite|img-a', 'mirror|img-a'], 'same model on two channels stays distinct')
        self.assertEqual(saved['video'], ['deepwhite|vid-a'])

    def test_invalid_requests_are_refused_and_change_nothing(self):
        self.put('image', ['deepwhite|img-a'])
        for kind, keys in (('IMAGE', []), ('image', 'deepwhite|img-a'), ('image', [1]), ('image', ['no-separator']),
                           ('image', ['p|m'] * 201), ('image', ['p|' + 'x' * 400])):
            self.put(kind, keys, 400)
        self.assertEqual(self.client.get('/api/studio/model-favorites').json()['image'], ['deepwhite|img-a'])

    def test_a_damaged_file_reads_as_empty(self):
        favourites.path().write_text(json.dumps({'image': 'deepwhite|img-a', 'video': None, 'chat': [3, 'p|m']}), encoding='utf-8')
        listed = self.client.get('/api/studio/model-favorites')
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json(), {'image': [], 'video': [], 'chat': ['p|m'], 'audio': [], 'workflow': []})
        favourites.path().write_text('[not json', encoding='utf-8')
        self.assertEqual(self.client.get('/api/studio/model-favorites').json()['image'], [])
        self.assertEqual(self.put('image', ['p|m'])['image'], ['p|m'], 'saving over a damaged file works')


if __name__ == '__main__':
    unittest.main()
