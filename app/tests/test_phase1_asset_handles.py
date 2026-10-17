"""Asset database initialization must release Windows file handles immediately."""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
import studio_assets


class AssetHandleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dw-asset-handles-')
        self.connections = []
        self.data = patch.object(main, 'DATA_DIR', self.temp.name)
        self.data.start()
        self.real_connect = sqlite3.connect

    def tearDown(self):
        for db in self.connections:
            db.close()
        self.data.stop()
        self.temp.cleanup()

    def connect(self, *args, **kwargs):
        db = self.real_connect(*args, **kwargs)
        self.connections.append(db)
        return db

    def test_database_initialization_releases_handle_without_garbage_collection(self):
        with patch.object(studio_assets.sqlite3, 'connect', side_effect=self.connect):
            path = studio_assets.database()
        self.assertTrue(path.exists())
        with self.assertRaises(sqlite3.ProgrammingError):
            self.connections[0].execute('SELECT 1')
        moved = path.with_suffix('.moved')
        path.rename(moved)
        moved.rename(path)

    def test_schema_failure_also_releases_handle(self):
        class FailingConnection(sqlite3.Connection):
            def execute(self, sql, *args):
                if sql.startswith('CREATE INDEX'):
                    raise sqlite3.OperationalError('simulated schema write failure')
                return super().execute(sql, *args)

        def connect(*args, **kwargs):
            return self.connect(*args, factory=FailingConnection, **kwargs)

        with patch.object(studio_assets.sqlite3, 'connect', side_effect=connect):
            with self.assertRaisesRegex(sqlite3.OperationalError, 'simulated'):
                studio_assets.database()
        with self.assertRaises(sqlite3.ProgrammingError):
            self.connections[0].execute('SELECT 1')


if __name__ == '__main__':
    unittest.main()
