"""F03 (handover 2026-10-26): asset-library versions are uploaded to RunningHub as real files.

/api/studio/assets/<version>/file must resolve to the stored file, be checked against the field's
media kind, and be sent to RH's upload API. Anything unresolvable fails instead of reaching RH as a
local path. The RH upstream is mocked; nothing is submitted or billed.
"""
import base64
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix="dw-rh-asset-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import studio_server
import main as core

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")
BASE = "https://rh.invalid"


class AssetUploadTests(unittest.TestCase):
    def setUp(self):
        self.uploads = []
        original = httpx.AsyncClient

        def upstream(request):
            if request.url.path.endswith("/task/openapi/upload"):
                name = re.search(rb'filename="([^"]+)"', request.content).group(1).decode()
                mime = re.search(rb'Content-Type: ([^\r\n]+)', request.content).group(1).decode()
                self.uploads.append((name, mime, PNG in request.content))
                return httpx.Response(200, json={"code": 0, "data": {"fileName": "api/up-%d.png" % len(self.uploads), "fileType": "image"}})
            return httpx.Response(503, json={"error": "unexpected"})
        provider = {"id": "runninghub", "name": "RunningHub", "base_url": BASE, "api_key": "dummy-key"}
        for item in (
            patch.object(core.httpx, "AsyncClient", side_effect=lambda *a, **kw: original(*a, **{**kw, "transport": httpx.MockTransport(upstream)})),
            patch.object(core, "runninghub_provider", side_effect=lambda: dict(provider)),
            patch.object(core, "runninghub_api_key", side_effect=lambda *a, **k: "dummy-key"),
        ):
            item.start()
            self.addCleanup(item.stop)
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)
        folder = Path(core.storage_kind_dir("generated")); folder.mkdir(parents=True, exist_ok=True)
        (folder / "person.png").write_bytes(PNG)
        response = self.client.post("/api/studio/assets/register", json={"url": "/api/storage-files/generated/person.png", "name": "人物"})
        self.assertEqual(response.status_code, 200, response.text)
        self.version_url = response.json()["item"]["url"]
        self.assertRegex(self.version_url, r"^/api/studio/assets/[a-f0-9]{32}/file$")

    def upload(self, url, kind="", status=200):
        response = self.client.post("/api/runninghub/upload-asset", json={"url": url, "kind": kind})
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def test_asset_version_is_uploaded_with_its_bytes_and_mime(self):
        result = self.upload(self.version_url, "image")
        self.assertEqual(result["data"]["fileName"], "api/up-1.png")
        self.assertEqual(len(self.uploads), 1)
        name, mime, same_bytes = self.uploads[0]
        self.assertTrue(name.endswith(".png"), name)
        self.assertEqual(mime, "image/png")
        self.assertTrue(same_bytes)

    def test_field_kind_mismatch_is_rejected_before_upload(self):
        detail = self.upload(self.version_url, "video", status=400)["detail"]
        self.assertIn("类型", detail)
        self.assertEqual(self.uploads, [])

    def test_unresolvable_local_paths_fail_instead_of_passing_through(self):
        for url in ("/api/studio/assets/" + "0" * 32 + "/file", "/static/missing.png"):
            with self.subTest(url=url):
                detail = self.upload(url, "image", status=400)["detail"]
                self.assertIn("素材", detail)
        self.assertEqual(self.uploads, [])


if __name__ == "__main__":
    unittest.main()
