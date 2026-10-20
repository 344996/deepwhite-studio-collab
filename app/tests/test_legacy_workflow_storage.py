"""Real legacy HTTP routes, disposable releases and user data; no generation."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
RUNTIME = tempfile.TemporaryDirectory(prefix="dw-legacy-import-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = RUNTIME.name
import main as core
from fastapi.testclient import TestClient


class LegacyWorkflowStorage(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dw-legacy-storage-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bundle = self.root / "versions" / "0.11.0-studio.6" / "app" / "workflows"
        self.older = self.root / "versions" / "0.11.0-studio.5" / "app" / "workflows"
        self.bundle.mkdir(parents=True)
        self.older.mkdir(parents=True)
        self.data = self.root / "userdata" / "data"
        self.data.mkdir(parents=True)
        self.user = self.data / "legacy-workflows"
        self.static = self.bundle.parent / "static" / "runninghub"
        self.static.mkdir(parents=True)
        self.workflow = {"1": {"class_type": "Fixture", "inputs": {"text": "original"}}}
        self.write(self.bundle / "Z-Image.json", self.workflow)
        self.write(self.bundle / "LTXDirectorv2-API.json", self.workflow)
        self.write(self.bundle / "LTXDirectorv2-API.config.json", {"title": "Packaged default", "fields": []})
        self.write(self.bundle / "custom" / "same.json", self.workflow)
        self.write(self.older / "custom" / "older.json", self.workflow)
        self.write(self.older / "custom" / "older.config.json", {"title": "Older user settings", "fields": []})
        self.write(self.static / "api_providers.json", [{
            "id": "runninghub", "name": "RunningHub", "base_url": "https://example.invalid",
            "protocol": "runninghub", "rh_apps": [], "rh_workflows": [],
        }])
        self.before = self.program_files()
        overrides = {
            "DATA_DIR": str(self.data), "WORKFLOW_DIR": str(self.bundle),
            "API_PROVIDERS_FILE": str(self.data / "api_providers.json"),
            "RUNNINGHUB_WORKFLOW_STORE_FILE": str(self.data / "runninghub_workflows.json"),
            "STATIC_RUNNINGHUB_DIR": str(self.static),
            "STATIC_RUNNINGHUB_THUMBNAIL_DIR": str(self.static / "thumbnails"),
            "STATIC_RUNNINGHUB_API_PROVIDERS_FILE": str(self.static / "api_providers.json"),
        }
        for name, value in overrides.items():
            context = patch.object(core, name, value)
            context.start()
            self.addCleanup(context.stop)
        environment = patch.dict(os.environ, {"DEEPWHITE_INSTALL_ROOT": str(self.root)})
        environment.start()
        self.addCleanup(environment.stop)
        self.client = TestClient(core.app)
        self.addCleanup(self.client.close)

    def tearDown(self):
        self.assertEqual(self.program_files(), self.before, "A packaged/older release was changed")

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def program_files(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for p in (self.root / "versions").rglob("*") if p.is_file()}

    def url(self, name):
        return "/api/workflows/" + quote(name, safe="")

    def names(self):
        response = self.client.get("/api/workflows")
        self.assertEqual(response.status_code, 200, response.text)
        return {row["name"]: row for row in response.json()["workflows"]}

    def test_upload_list_config_and_delete_all_stay_in_userdata(self):
        response = self.client.post("/api/workflows", json={"name": "客户.json", "workflow": self.workflow})
        self.assertEqual(response.status_code, 200, response.text)
        name = response.json()["name"]
        self.assertEqual(name, "custom/客户.json")
        self.assertTrue((self.user / name).exists())
        self.assertIn(name, self.names())
        saved = self.client.put(self.url(name) + "/config", json={"title": "My settings", "fields": []})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(self.client.get(self.url(name)).json()["config"]["title"], "My settings")
        self.assertEqual(self.client.delete(self.url(name)).status_code, 200)
        self.assertEqual(self.client.get(self.url(name)).status_code, 404)
        self.assertNotIn(name, self.names())
        self.assertFalse((self.user / name).exists())
        self.assertFalse((self.user / name).with_suffix(".config.json").exists())

    def test_user_override_same_name_and_delete_never_reveals_old_copy(self):
        changed = {"1": {"class_type": "Fixture", "inputs": {"text": "customer"}}}
        self.assertEqual(self.client.get(self.url("custom/same.json")).json()["workflow"], self.workflow)
        response = self.client.post("/api/workflows", json={"name": "same.json", "workflow": changed})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.get(self.url("custom/same.json")).json()["workflow"], changed)
        self.assertEqual(list(self.names()).count("custom/same.json"), 1)
        self.assertEqual(self.client.delete(self.url("custom/same.json")).status_code, 200)
        self.assertEqual(self.client.get(self.url("custom/same.json")).status_code, 404)
        self.assertTrue((self.bundle / "custom" / "same.json").exists())
        self.assertEqual(self.client.post("/api/workflows", json={"name": "same.json", "workflow": changed}).status_code, 200)
        self.assertEqual(self.client.get(self.url("custom/same.json")).json()["workflow"], changed)

    def test_older_custom_file_remains_readable_without_migration(self):
        name = "custom/older.json"
        self.assertIn(name, self.names())
        self.assertEqual(self.client.get(self.url(name)).json()["config"]["title"], "Older user settings")
        self.assertFalse(self.user.exists())
        response = self.client.put(self.url(name) + "/config", json={"title": "Updated", "fields": []})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.get(self.url(name)).json()["config"]["title"], "Updated")
        self.assertEqual(self.client.delete(self.url(name)).status_code, 200)
        self.assertEqual(self.client.get(self.url(name)).status_code, 404)
        self.assertTrue((self.older / name).exists())

    def test_packaged_defaults_can_have_user_config_and_local_hiding(self):
        name = "LTXDirectorv2-API.json"
        self.assertIn(name, self.names())
        self.assertEqual(self.client.get(self.url(name)).json()["config"]["title"], "Packaged default")
        response = self.client.put(self.url(name) + "/config", json={"title": "Personal default", "fields": []})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.get(self.url(name)).json()["config"]["title"], "Personal default")
        self.assertEqual(self.client.delete(self.url(name)).status_code, 200)
        self.assertNotIn(name, self.names())
        self.assertTrue((self.bundle / name).exists())
        self.assertEqual(self.client.delete(self.url("Z-Image.json")).status_code, 400)
        self.assertEqual(self.client.get(self.url("Z-Image.json")).status_code, 200)

    def test_damaged_hidden_records_fail_without_overwriting_files(self):
        hidden = self.data / "legacy-workflows-hidden.json"
        hidden.write_text("{broken", encoding="utf-8")
        self.assertEqual(self.client.get("/api/workflows").status_code, 409)
        result = self.client.post("/api/workflows", json={"name": "new.json", "workflow": self.workflow})
        self.assertEqual(result.status_code, 409)
        self.assertEqual(hidden.read_text(encoding="utf-8"), "{broken")
        self.assertFalse(self.user.exists())

    def test_provider_save_preserves_packaged_runninghub_template(self):
        provider = {"id": "runninghub", "name": "RunningHub", "base_url": "https://example.invalid",
                    "protocol": "runninghub", "rh_workflows": [
                        {"id": "123456", "workflowId": "123456", "title": "Customer workflow",
                         "workflowJson": self.workflow, "enabled": True}
                    ]}
        with patch.object(core, "provider_env_key_value", return_value=""):
            result = self.client.put("/api/providers", json=[provider])
        self.assertEqual(result.status_code, 200, result.text)
        saved = json.loads((self.data / "api_providers.json").read_text(encoding="utf-8"))
        self.assertEqual(saved[0]["rh_workflows"][0]["title"], "Customer workflow")
        result = self.client.get("/api/runninghub/workflows/123456")
        self.assertEqual(result.status_code, 200, result.text)
        self.assertFalse(core.sync_runninghub_provider_workflows_to_static_template(saved[0]))


if __name__ == "__main__":
    unittest.main()
