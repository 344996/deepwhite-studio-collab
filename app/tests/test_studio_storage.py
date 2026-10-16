"""Storage migration tests use temporary directories only."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main
import studio_assets
import studio_storage


class StudioStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="deepwhite-storage-test-")
        self.base = Path(self.temp.name)
        self.app_dir = self.base / "application"
        self.runtime = self.app_dir / "runtime"
        self.data = self.runtime / "data"
        self.external = self.base / "external"
        self.input_dir = self.base / "input"
        for folder in (self.app_dir, self.runtime, self.data, self.external, self.input_dir):
            folder.mkdir(parents=True, exist_ok=True)
        self.patches = [
            patch.object(main, "BASE_DIR", str(self.app_dir)),
            patch.object(main, "RUNTIME_DIR", str(self.runtime)),
            patch.object(main, "DATA_DIR", str(self.data)),
            patch.object(main, "OUTPUT_DIR", str(self.runtime / "output")),
            patch.object(main, "ASSETS_DIR", str(self.runtime / "assets")),
        ]
        for active in self.patches:
            active.start()
        studio_assets.database()
        self.project = "project_one"

    def tearDown(self):
        for active in reversed(self.patches):
            active.stop()
        self.temp.cleanup()

    def test_default_config_is_lazy_and_external_project_root_is_allowed(self):
        self.assertFalse(studio_storage.config_path().exists())
        self.assertEqual(studio_storage._read_config()["default_root"], str(studio_assets.root()))
        chosen = self.external / "project-storage"
        self.assertEqual(studio_storage.validate_root(chosen, configured_paths=()), chosen.resolve())
        with self.assertRaises(Exception):
            studio_storage.validate_root(self.app_dir / "inside-app")

    def test_migration_keeps_version_url_and_original_files(self):
        source = self.input_dir / "候选.png"
        source.write_bytes(b"candidate-image-bytes")
        candidate = studio_assets._register_path(source, project_id=self.project,
                                                 source={"type": "import", "prompt": "sample"})
        confirmed = studio_assets.confirm(candidate["version_id"], category="角色")
        old_candidate = Path(studio_assets._row(candidate["version_id"])["candidate_path"])
        old_confirmed = Path(studio_assets._row(candidate["version_id"])["confirmed_path"])
        old_bytes = (old_candidate.read_bytes(), old_confirmed.read_bytes())
        target = self.external / "new-project-root"
        result = studio_storage.migrate_project(self.project, target)
        new_row = dict(studio_assets._row(candidate["version_id"]))

        self.assertEqual(confirmed["url"], candidate["url"])
        self.assertEqual(result["path"], str(target.resolve()))
        self.assertTrue(result["old_files_retained"])
        self.assertTrue(Path(new_row["candidate_path"]).is_relative_to(target))
        self.assertTrue(Path(new_row["confirmed_path"]).is_relative_to(target))
        self.assertEqual(old_candidate.read_bytes(), old_bytes[0])
        self.assertEqual(old_confirmed.read_bytes(), old_bytes[1])
        self.assertEqual(Path(new_row["candidate_path"]).read_bytes(), old_bytes[0])
        self.assertEqual(Path(new_row["confirmed_path"]).read_bytes(), old_bytes[1])
        self.assertEqual(studio_storage.project_root(self.project), target.resolve())

    def test_missing_managed_media_aborts_without_switching_references(self):
        source = self.input_dir / "broken.png"
        source.write_bytes(b"media")
        item = studio_assets._register_path(source, project_id=self.project)
        row = dict(studio_assets._row(item["version_id"]))
        old_path = Path(row["candidate_path"])
        old_path.unlink()

        with self.assertRaises(Exception):
            studio_storage.migrate_project(self.project, self.external / "should-not-switch")
        current = dict(studio_assets._row(item["version_id"]))
        self.assertEqual(current["candidate_path"], row["candidate_path"])
        self.assertFalse((self.external / "should-not-switch").exists())

    def test_migration_journal_recovers_config_after_commit(self):
        target = self.external / "recovered-project"
        desired = {"default_root": str(self.external / "global"), "projects": {self.project: str(target)}}
        with studio_assets.connect() as db:
            studio_storage._journal_table(db)
            db.execute("INSERT INTO storage_migrations VALUES(?,?,?)",
                       (self.project, json.dumps(desired), "[]"))
            db.commit()
        studio_storage._recover_migrations()
        self.assertEqual(studio_storage._read_config(), desired)
        with studio_assets.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM storage_migrations").fetchone()[0], 0)

    def test_config_write_failure_restores_database_paths(self):
        source=self.input_dir/'rollback.png';source.write_bytes(b'rollback-image')
        item=studio_assets._register_path(source,project_id=self.project)
        before=dict(studio_assets._row(item['version_id']))
        with patch.object(studio_storage,'_write_config',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                studio_storage.migrate_project(self.project,self.external/'failed-migration')
        after=dict(studio_assets._row(item['version_id']))
        self.assertEqual(after['candidate_path'],before['candidate_path'])
        self.assertEqual(Path(after['candidate_path']).read_bytes(),b'rollback-image')

    @unittest.skipUnless(sys.platform=='win32','Windows native dialog')
    def test_picker_keeps_untrusted_initial_path_out_of_shell_code(self):
        from types import SimpleNamespace
        initial=r'D:\example\$(not_a_command)'
        with patch.object(studio_storage.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=str(self.external))) as run:
            self.assertEqual(studio_storage._pick_folder(initial),str(self.external.resolve()))
            self.assertFalse(run.call_args.kwargs['shell'])
            self.assertNotEqual(run.call_args.kwargs.get('creationflags'),getattr(studio_storage.subprocess,'CREATE_NO_WINDOW',None))
            self.assertEqual(run.call_args.kwargs['env']['DEEPWHITE_PICK_INITIAL'],initial)
            self.assertNotIn(initial,' '.join(run.call_args.args[0]))

    @unittest.skipUnless(sys.platform=='win32','Windows native dialog')
    def test_picker_cancel_returns_empty_without_changing_any_path(self):
        from types import SimpleNamespace
        with patch.object(studio_storage.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='')):
            self.assertEqual(studio_storage._pick_folder(self.external),'')


if __name__ == "__main__":
    unittest.main()
