"""Exercise the real project-index functions against disposable local files."""
import ast
import asyncio
import json
import os
import re
import sys
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid
from typing import Optional
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
RUNTIME = APP.parent / '.test-runtime' / 'projects'
RUNTIME.mkdir(parents=True, exist_ok=True)
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = str(RUNTIME)
TREE = ast.parse((APP / 'main.py').read_text(encoding='utf-8-sig'))


def project_functions(path):
    """Avoid importing unrelated startup code; execute unchanged function ASTs."""
    selected = [node for node in TREE.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and (node.name in ('load_projects', 'save_projects', 'ensure_default_project',
                                   'restore_projects_backup', 'recover_project_index', '_atomic_write_bytes',
                                   'CanvasMetaUpdate', 'canvas_path', 'load_canvas', 'canvas_record',
                                   'normalize_canvas_kind', 'normalize_canvas_color', 'delete_project', 'update_canvas_meta')
                     or node.name.startswith('_project_index_'))]
    scope = dict(os=os, json=json, re=re, tempfile=tempfile, uuid=uuid, CANVAS_LOCK=threading.Lock(),
                 PROJECTS_PATH=str(path), DEFAULT_PROJECT_ID='default', HTTPException=HTTPException,
                 CANVAS_DIR=str(path.parent / 'canvases'), CANVAS_COLORS={'', 'red', 'blue'},
                 BaseModel=BaseModel, Optional=Optional,
                 now_ms=lambda: int(time.time() * 1000), app=FastAPI())
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(APP / 'main.py'), 'exec'), scope)
    return scope


class ProjectIndexSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=RUNTIME, prefix='index-')
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'projects.json'
        self.core = project_functions(self.path)
        self.projects = [{'id': 'default', 'name': '默认项目'}, {'id': 'film', 'name': '影片'}]
        self.canvas_dir = self.path.parent / 'canvases'
        self.canvas_dir.mkdir()

    def canvas_fixture(self, identity='a', project='film', **extra):
        data = {'id': identity, 'title': '原画布', 'project': project, 'updated_at': 123,
                'nodes': [{'id': 'paid-result', 'images': [{'url': '/output/original.png'}]}],
                'connections': [], 'settings': {'keep': True}, 'unknown_field': {'must': 'survive'}, **extra}
        path = self.canvas_dir / (identity + '.json')
        path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        return path, data

    def test_corrupt_index_is_reported_without_default_overwrite(self):
        damaged = b'{"projects": [incomplete'
        self.path.write_bytes(damaged)
        with self.assertRaises(HTTPException) as caught:
            self.core['ensure_default_project']()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn('recover', str(caught.exception.detail))
        self.assertEqual(self.path.read_bytes(), damaged)

    def test_structurally_invalid_index_is_not_silently_filtered(self):
        for data in ({'projects': [{'name': 'missing identity'}]}, {'projects': None},
                     {'projects': [{'id': 'same'}, {'id': 'same'}]}):
            self.path.write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(HTTPException):
                self.core['load_projects']()

    def test_atomic_replace_failure_keeps_last_index(self):
        original = json.dumps({'projects': self.projects}, ensure_ascii=False)
        self.path.write_text(original, encoding='utf-8')
        real_replace = os.replace
        def fail_current(source, destination):
            if str(destination) == str(self.path):
                raise OSError('simulated disk write failure')
            return real_replace(source, destination)
        with patch.object(os, 'replace', side_effect=fail_current):
            with self.assertRaises(HTTPException):
                self.core['save_projects']([{'id': 'default', 'name': 'replacement'}])
        self.assertEqual(self.path.read_text(encoding='utf-8'), original)
        self.assertEqual(list(self.path.parent.glob('*.tmp')), [])

    def test_backup_retains_previous_valid_version_and_recovery_preserves_damage(self):
        self.core['save_projects'](self.projects)
        changed = self.projects + [{'id': 'new', 'name': '新项目'}]
        self.core['save_projects'](changed)
        backup = Path(str(self.path) + '.bak')
        self.assertEqual(json.loads(backup.read_text(encoding='utf-8'))['projects'], self.projects)
        damaged = b'{broken'
        self.path.write_bytes(damaged)
        outcome = self.core['restore_projects_backup']()
        self.assertTrue(outcome['ok'])
        self.assertEqual(self.core['load_projects'](), self.projects)
        self.assertEqual(Path(outcome['preserved_path']).read_bytes(), damaged)
        self.assertEqual(json.loads(backup.read_text(encoding='utf-8'))['projects'], self.projects)

    def test_recovery_refuses_bad_backup_and_healthy_index(self):
        self.core['save_projects'](self.projects)
        with self.assertRaises(HTTPException):
            self.core['restore_projects_backup']()
        self.path.write_bytes(b'{broken')
        Path(str(self.path) + '.bak').write_bytes(b'{also broken')
        with self.assertRaises(HTTPException):
            self.core['restore_projects_backup']()
        self.assertEqual(self.path.read_bytes(), b'{broken')

    def test_missing_index_with_backup_never_becomes_empty_default(self):
        Path(str(self.path) + '.bak').write_text(json.dumps({'projects': self.projects}), encoding='utf-8')
        with self.assertRaises(HTTPException):
            self.core['ensure_default_project']()
        self.assertFalse(self.path.exists())
        self.core['restore_projects_backup']()
        self.assertEqual(self.core['load_projects'](), self.projects)

    def test_legacy_list_and_clean_first_run_remain_supported(self):
        self.assertEqual(self.core['load_projects'](), [])
        self.path.write_text(json.dumps(self.projects), encoding='utf-8')
        self.assertEqual(self.core['load_projects'](), self.projects)

    def test_metadata_replace_failure_keeps_original_canvas(self):
        path, _ = self.canvas_fixture()
        original = path.read_bytes()
        payload = self.core['CanvasMetaUpdate'](title='new title', owner='new owner')
        for operation in ('replace', 'fsync'):
            with self.subTest(operation=operation), patch.object(os, operation, side_effect=OSError('interrupted write')):
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(self.core['update_canvas_meta']('a', payload))
                self.assertEqual(caught.exception.status_code, 507)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(self.canvas_dir.glob('*.tmp')), [])

    def test_metadata_updates_only_requested_fields_without_touching_revision_or_assets(self):
        path, original = self.canvas_fixture()
        payload = self.core['CanvasMetaUpdate'](title='new title', owner='  owner  ', color='red',
                                               pinned=True, board_x=0, board_y=-12)
        result = asyncio.run(self.core['update_canvas_meta']('a', payload))
        updated = json.loads(path.read_text(encoding='utf-8'))
        expected = {**original, 'title': 'new title', 'owner': 'owner', 'color': 'red',
                    'pinned': True, 'board_x': 0.0, 'board_y': -12.0}
        self.assertEqual(updated, expected)
        self.assertEqual(result['canvas']['updated_at'], 123)

    def test_migration_write_failure_preserves_canvas_and_project_index(self):
        self.core['save_projects'](self.projects)
        path, _ = self.canvas_fixture()
        original, index = path.read_bytes(), self.path.read_bytes()
        for operation in ('replace', 'fsync'):
            with self.subTest(operation=operation), patch.object(os, operation, side_effect=OSError('interrupted migration')):
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(self.core['delete_project']('film'))
                self.assertEqual(caught.exception.status_code, 507)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(self.path.read_bytes(), index)
            self.assertEqual(list(self.canvas_dir.glob('*.tmp')), [])

    def test_partial_migration_can_retry_without_losing_remaining_canvas(self):
        self.core['save_projects'](self.projects)
        one, first = self.canvas_fixture('a')
        two, second = self.canvas_fixture('b', deleted_at=7)
        unrelated, _ = self.canvas_fixture('other', project='unrelated')
        original_two, original_other = two.read_bytes(), unrelated.read_bytes()
        real_replace = os.replace
        def fail_second(source, destination):
            if str(destination) == str(two):
                raise OSError('second canvas unavailable')
            return real_replace(source, destination)
        with patch.object(os, 'replace', side_effect=fail_second):
            with self.assertRaises(HTTPException):
                asyncio.run(self.core['delete_project']('film'))
        self.assertEqual(json.loads(one.read_text(encoding='utf-8')), {**first, 'project': 'default'})
        self.assertEqual(two.read_bytes(), original_two)
        self.assertEqual(self.core['load_projects'](), self.projects)
        result = asyncio.run(self.core['delete_project']('film'))
        self.assertEqual(result, {'ok': True, 'moved': 1})
        self.assertEqual(json.loads(two.read_text(encoding='utf-8')), {**second, 'project': 'default'})
        self.assertEqual(unrelated.read_bytes(), original_other)
        self.assertEqual(self.core['load_projects'](), [self.projects[0]])


if __name__ == '__main__':
    unittest.main()
