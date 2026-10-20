"""HTTP boundary checks, isolated Codex profile and isolated canvas data."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix="dw-codex-api-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import studio_server
import studio_control
from fastapi.testclient import TestClient


class SetupAPI(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dw-codex-profile-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name) / "isolated-codex"
        environment = patch.dict(os.environ, {"CODEX_HOME": str(self.home)})
        environment.start()
        self.addCleanup(environment.stop)
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)
        value = studio_control._load()
        value["enabled"] = False
        studio_control._save(value)
        self.url = "/api/studio/control/codex"
        self.headers = {"Origin": "http://testserver"}

    def post(self, **changes):
        payload = {"action": "install", "expected_revision": self.client.get(self.url).json()["revision"]}
        payload.update(changes)
        return self.client.post(self.url, json=payload, headers=self.headers)

    def test_read_never_creates_profile_and_enable_is_required(self):
        result = self.client.get(self.url)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["state"], "missing")
        self.assertFalse(self.home.exists())
        self.assertEqual(self.post().status_code, 403)
        self.assertFalse(self.home.exists())

    def test_origin_and_payload_cannot_choose_path_or_command(self):
        self.client.put("/api/studio/control/settings", json={"enabled": True})
        data = {"action": "install", "expected_revision": self.client.get(self.url).json()["revision"]}
        for headers in ({}, {"Origin": "https://attacker.invalid"}):
            self.assertEqual(self.client.post(self.url, json=data, headers=headers).status_code, 403)
        for extra in ({"path": "../private"}, {"command": "arbitrary.exe"}, {"replace_existing": "true"}):
            self.assertEqual(self.post(**extra).status_code, 400)
        self.assertFalse(self.home.exists())

    def test_full_setup_and_undo_is_allowed_after_disabling_mcp(self):
        self.client.put("/api/studio/control/settings", json={"enabled": True})
        response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["state"], "installed")
        self.assertTrue((self.home / "config.toml").exists())
        self.client.put("/api/studio/control/settings", json={"enabled": False})
        undo = self.post(action="undo")
        self.assertEqual(undo.status_code, 200, undo.text)
        self.assertEqual(undo.json()["state"], "missing")


if __name__ == "__main__":
    unittest.main()
