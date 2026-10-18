import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import studio_gallery as gallery


class GalleryEntryTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='studio-gallery-entry-')
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / 'data' / 'studio_gallery.json'
        scope = patch.object(gallery, 'config_path', return_value=self.path)
        scope.start()
        self.addCleanup(scope.stop)
        app = FastAPI()
        gallery.install(app)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_default_does_not_invent_public_domain(self):
        self.assertEqual(self.client.get('/api/studio/gallery').json(), {'url': ''})
        self.assertFalse(self.path.exists())

    def test_save_reload_and_clear_only_website_url(self):
        result = self.client.put('/api/studio/gallery', json={'url': 'https://gallery.example/'})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.client.get('/api/studio/gallery').json(), {'url': 'https://gallery.example'})
        self.assertEqual(json.loads(self.path.read_text()), {'url': 'https://gallery.example'})
        self.assertEqual(self.client.put('/api/studio/gallery', json={'url': ''}).status_code, 200)
        self.assertEqual(self.client.get('/api/studio/gallery').json()['url'], '')

    def test_unsafe_addresses_and_extra_credentials_rejected(self):
        for url in ['javascript:alert(1)', 'http://example.com', 'https://u:p@example.com',
                    'https://example.com/?token=secret', 'https://example.com/#fragment',
                    'https://example.com/path', 'file:///C:/x', 'https://exam\\ple.com', 'https://a b.com']:
            with self.subTest(url=url):
                self.assertEqual(self.client.put('/api/studio/gallery', json={'url': url}).status_code, 400)
        self.assertEqual(self.client.put('/api/studio/gallery', json={'url': '', 'api_key': 'test'}).status_code, 422)

    def test_loopback_preview_address_allowed(self):
        self.assertEqual(self.client.put('/api/studio/gallery', json={'url': 'http://127.0.0.1:3856'}).status_code, 200)

    def test_failed_save_preserves_previous_config(self):
        self.client.put('/api/studio/gallery', json={'url': 'https://gallery.example'})
        with patch.object(gallery.core, '_atomic_write_bytes', side_effect=OSError('fixture full disk')):
            self.assertEqual(self.client.put('/api/studio/gallery', json={'url': 'https://new.example'}).status_code, 507)
        self.assertEqual(self.client.get('/api/studio/gallery').json()['url'], 'https://gallery.example')

    def test_corrupt_config_reports_error_without_silent_overwrite(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text('broken')
        self.assertEqual(self.client.get('/api/studio/gallery').status_code, 500)
        self.assertEqual(self.path.read_text(), 'broken')
