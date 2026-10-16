import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

# main.py creates its runtime directory during import; keep that initialization
# isolated from the user's real workspace.
TEST_RUNTIME = tempfile.TemporaryDirectory()
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = TEST_RUNTIME.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import studio_assets as assets
import main as core


class StudioAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.data = self.base / "data"
        self.data.mkdir()
        self.outputs = self.base / "outputs"
        self.outputs.mkdir()
        self.data_patch = patch.object(core, "DATA_DIR", str(self.data))
        self.data_patch.start()
        self.resolver_patch = patch.object(core, "output_file_from_url", self.resolve)
        self.resolver_patch.start()

    def tearDown(self):
        self.resolver_patch.stop()
        self.data_patch.stop()
        self.temp.cleanup()

    def resolve(self, url):
        if not isinstance(url, str) or not url.startswith("/output/"):
            return None
        relative = url[len("/output/"):]
        if ".." in Path(relative).parts or Path(relative).is_absolute():
            return None
        candidate = self.outputs / relative
        return str(candidate) if candidate.is_file() else None

    def make_file(self, name, data):
        path = self.outputs / name
        path.write_bytes(data)
        return path

    def test_registration_is_stable_by_project_and_sha(self):
        path = self.make_file("result.png", b"same image bytes")
        first = assets.register_local("/output/result.png", "Render.png", source={"job_id": "job-1", "prompt": "preserve generation context", "api_key":"never-store", "params":{"ratio":"1:1","token":"never-store"}})
        second = assets.register_local("/output/result.png", "Different name.png", source={"job_id": "job-2"})
        other_project = assets.register_local("/output/result.png", project_id="another")

        self.assertEqual(first["version_id"], second["version_id"])
        self.assertEqual(first["asset_id"], second["asset_id"])
        self.assertNotEqual(first["version_id"], other_project["version_id"])
        self.assertEqual(first["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(first["source"], {"job_id": "job-1", "prompt":"preserve generation context", "params":{"ratio":"1:1"}})
        self.assertEqual(Path(assets._row(first["version_id"])["candidate_path"]).read_bytes(), path.read_bytes())

    def test_confirm_keeps_version_identity_and_never_overwrites(self):
        self.make_file("one.png", b"first contents")
        self.make_file("two.png", b"second contents")
        first = assets.register_local("/output/one.png", "same.png")
        second = assets.register_local("/output/two.png", "same.png")
        archived_first = assets.confirm(first["version_id"], category="reference")
        shared_asset = archived_first["asset_id"]
        archived_second = assets.confirm(second["version_id"], shared_asset, "reference")
        row1, row2 = assets._row(first["version_id"]), assets._row(second["version_id"])

        self.assertEqual(archived_first["version_id"], first["version_id"])
        self.assertEqual(archived_second["version_id"], second["version_id"])
        self.assertEqual(archived_first["asset_id"], archived_second["asset_id"])
        self.assertEqual(archived_first["asset_id"], shared_asset)
        self.assertEqual(row1["sha256"], first["sha256"])
        self.assertEqual(Path(row1["confirmed_path"]).read_bytes(), b"first contents")
        self.assertEqual(Path(row2["confirmed_path"]).read_bytes(), b"second contents")
        self.assertNotEqual(row1["confirmed_path"], row2["confirmed_path"])
        self.assertEqual(archived_first["status"], "confirmed")
        archived = assets.archive(first["version_id"])
        self.assertEqual(archived["status"], "archived")
        self.assertEqual(Path(row1["confirmed_path"]).read_bytes(), b"first contents")

    def test_external_traversal_and_unsupported_extensions_are_rejected(self):
        with self.assertRaises(HTTPException):
            assets.register_local("https://example.com/image.png")
        with self.assertRaises(HTTPException):
            assets.register_local("/output/../secret.png")
        self.make_file("script.exe", b"not media")
        with self.assertRaises(HTTPException) as err:
            assets.register_local("/output/script.exe")
        self.assertEqual(err.exception.status_code, 415)
        with self.assertRaises(HTTPException):
            assets.register_local("/output/missing.png")

    def test_repair_marks_missing_and_reconciles_completed_copy(self):
        self.make_file("candidate.jpg", b"candidate")
        item = assets.register_local("/output/candidate.jpg", project_id="repair")
        candidate = Path(assets._row(item["version_id"])["candidate_path"])
        candidate.unlink()
        report = assets.repair("repair")
        self.assertTrue(report["items"][0]["missing"])
        self.assertEqual(report["changed"], 1)

        # Simulate process death after project copy and before the status transaction.
        row = assets._row(item["version_id"])
        project_folder = assets.root() / "projects" / "repair" / row["asset_id"]
        recovered = project_folder / "candidate-recovered.jpg"
        recovered.parent.mkdir(parents=True, exist_ok=True)
        recovered.write_bytes(b"candidate")
        with assets.connect() as db:
            db.execute("INSERT INTO confirmations VALUES(?,?,?,?,?,?)", (item["version_id"], row["asset_id"], row["name"], "", str(recovered), row["sha256"]))
            db.commit()
        report = assets.repair("repair")
        recovered_item = report["items"][0]
        self.assertEqual(recovered_item["status"], "confirmed")
        self.assertFalse(recovered_item["missing"])
        self.assertEqual(Path(assets._row(item["version_id"])["confirmed_path"]), recovered)

    def test_failed_confirm_copy_preserves_candidate_for_retry(self):
        self.make_file("retry.wav", b"audio")
        item = assets.register_local("/output/retry.wav")
        original_copy = assets.atomic_copy
        def fail_confirmation(source, destination, expected_hash=None):
            if Path(destination).parent.parent.parent.name == "projects":
                raise OSError("simulated disk failure")
            return original_copy(source, destination, expected_hash)
        with patch.object(assets, "atomic_copy", fail_confirmation):
            with self.assertRaises(HTTPException) as err:
                assets.confirm(item["version_id"])
        self.assertEqual(err.exception.status_code, 500)
        row = assets._row(item["version_id"])
        self.assertEqual(row["status"], "candidate")
        self.assertTrue(Path(row["candidate_path"]).is_file())
        self.assertFalse(row["confirmed_path"])

    def test_cross_project_asset_reuse_is_rejected(self):
        self.make_file("owner.png", b"owner")
        self.make_file("other.png", b"other")
        owner = assets.register_local("/output/owner.png", project_id="one")
        owner = assets.confirm(owner["version_id"])
        other = assets.register_local("/output/other.png", project_id="two")
        with self.assertRaises(HTTPException) as err:
            assets.confirm(other["version_id"], owner["asset_id"])
        self.assertEqual(err.exception.status_code, 409)
        with self.assertRaises(HTTPException) as err:
            assets.confirm(other["version_id"], "b" * 32)
        self.assertEqual(err.exception.status_code, 404)

    def test_reimport_restores_missing_candidate_without_changing_identity(self):
        original = self.make_file("restore.png", b"restore me")
        item = assets.register_local("/output/restore.png", project_id="restore")
        candidate = Path(assets._row(item["version_id"])["candidate_path"])
        candidate.unlink()
        assets.repair("restore")
        self.assertTrue(assets._row(item["version_id"])["missing"])

        restored = assets.register_local("/output/restore.png", project_id="restore")
        self.assertEqual(restored["version_id"], item["version_id"])
        self.assertFalse(restored["missing"])
        self.assertEqual(Path(assets.file_path(item["version_id"])).read_bytes(), original.read_bytes())

    def test_replacement_at_same_url_gets_new_version_reference(self):
        source = self.make_file("mutable.png", b"first")
        canvas = {"id": "mutable-canvas", "project": "mutable", "nodes": [{"id": "n1", "url": "/output/mutable.png"}]}
        assets.enrich_canvas(canvas)
        first = canvas["nodes"][0]["studioAssetRefs"][0]
        source.write_bytes(b"replacement with new size")
        assets.enrich_canvas(canvas)
        second = canvas["nodes"][0]["studioAssetRefs"][0]
        self.assertNotEqual(first["version_id"], second["version_id"])
        self.assertEqual(second["source_url"], "/output/mutable.png")

    def test_canvas_enrichment_is_idempotent_and_skips_remote(self):
        self.make_file("canvas.mp4", b"video")
        item = assets.register_local("/output/canvas.mp4", project_id="canvas")
        canvas = {"project": "canvas", "nodes": [{"id": "n1", "videos": [{"url": "/output/canvas.mp4"}, {"url": "https://example.com/remote.mp4"}]}]}
        enriched = assets.enrich_canvas(canvas)
        self.assertEqual(len(enriched["studioAssetRefs"]), 1)
        self.assertEqual(enriched["studioAssetRefs"][0]["version_id"], item["version_id"])
        self.assertEqual(enriched["nodes"][0]["studioAssetRefs"][0]["version_id"], item["version_id"])
        snapshot = list(enriched["studioAssetRefs"])
        assets.enrich_canvas(enriched)
        self.assertEqual(enriched["studioAssetRefs"], snapshot)
        self.assertEqual(enriched["nodes"], canvas["nodes"])


if __name__ == "__main__":
    unittest.main()
