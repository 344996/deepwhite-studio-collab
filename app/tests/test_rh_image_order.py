"""F07 (handover 2026-10-26): a missing RH image order is not stored as 0, which outranked 1 and 2."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix="dw-rh-order-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import main as core


def order(**raw):
    return core.runninghub_normalize_field({"nodeId": "403", "fieldName": "image", "fieldType": "IMAGE", **raw})["imageOrder"]


class ImageOrderTests(unittest.TestCase):
    def test_zero_is_kept_and_missing_stays_missing(self):
        self.assertEqual(order(imageOrder=0), 0)
        self.assertEqual(order(imageOrder="2"), 2)
        self.assertEqual(order(image_order=1), 1)
        self.assertIsNone(order())
        self.assertIsNone(order(imageOrder=""))

    def test_unreadable_order_is_kept_for_the_request_builder_to_reject(self):
        self.assertEqual(order(imageOrder="first"), "first")

    def test_backend_sort_puts_missing_after_explicit_orders(self):
        fields = [core.runninghub_normalize_field(f) for f in (
            {"nodeId": "9", "fieldName": "image", "fieldType": "IMAGE"},
            {"nodeId": "404", "fieldName": "image", "fieldType": "IMAGE", "imageOrder": 1},
            {"nodeId": "403", "fieldName": "image", "fieldType": "IMAGE", "imageOrder": 0})]
        import functools
        ordered = sorted(fields, key=functools.cmp_to_key(core._rh_field_cmp))
        self.assertEqual([f["nodeId"] for f in ordered], ["403", "404", "9"])


class SaveReopenTests(unittest.TestCase):
    def test_orders_survive_saving_and_reopening_the_workflow(self):
        from fastapi.testclient import TestClient
        from unittest.mock import patch
        import shutil
        import studio_server
        # Saving a workflow also mirrors it into the shipped RH template; keep that copy temporary.
        template = Path(runtime.name) / "api_providers.json"
        shutil.copyfile(core.STATIC_RUNNINGHUB_API_PROVIDERS_FILE, template)
        guard = patch.object(core, "STATIC_RUNNINGHUB_API_PROVIDERS_FILE", str(template))
        guard.start()
        self.addCleanup(guard.stop)
        client = TestClient(studio_server.app)
        self.addCleanup(client.close)
        fields = [{"nodeId": "404", "fieldName": "image", "fieldType": "IMAGE", "imageOrder": 1},
                  {"nodeId": "403", "fieldName": "image", "fieldType": "IMAGE", "imageOrder": 0},
                  {"nodeId": "9", "fieldName": "image", "fieldType": "IMAGE"}]
        saved = client.put("/api/runninghub/workflows/987654321", json={"workflowId": "987654321", "title": "序号", "fields": fields})
        self.assertEqual(saved.status_code, 200, saved.text)
        reopened = client.get("/api/runninghub/workflows/987654321")
        self.assertEqual(reopened.status_code, 200, reopened.text)
        orders = {f["nodeId"]: f["imageOrder"] for f in reopened.json()["workflow"]["fields"]}
        self.assertEqual(orders, {"404": 1, "403": 0, "9": None})

    def test_saving_works_when_the_install_folder_is_read_only(self):
        # Installed under Program Files the shipped RH template cannot be written. The user's
        # copy in the data folder is what counts, so the save must still succeed.
        from fastapi.testclient import TestClient
        from unittest.mock import patch
        import builtins
        import studio_server
        template = os.path.abspath(core.STATIC_RUNNINGHUB_API_PROVIDERS_FILE)
        real_open = builtins.open
        def guarded(file, mode="r", *args, **kwargs):
            if os.path.abspath(str(file)) == template and any(flag in mode for flag in "wa+"):
                raise PermissionError(13, "Access is denied", str(file))
            return real_open(file, mode, *args, **kwargs)
        client = TestClient(studio_server.app)
        self.addCleanup(client.close)
        with patch.object(builtins, "open", side_effect=guarded):
            saved = client.put("/api/runninghub/workflows/123123123", json={"workflowId": "123123123", "title": "只读安装", "fields": []})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(client.get("/api/runninghub/workflows/123123123").json()["workflow"]["title"], "只读安装")


if __name__ == "__main__":
    unittest.main()
