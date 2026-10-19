"""Local update permissions, busy checks and maintenance gate without any installer."""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import studio_updates as api
from studio_update_core import atomic_json, read_json


class UpdateAPITests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='dw-update-api-'); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.version='0.10.2-studio.16'
        self.release=self.root/'versions'/self.version; (self.release/'app').mkdir(parents=True)
        (self.release/'app'/'VERSION').write_text(self.version)
        atomic_json(self.release/'release.json',{'app':'deepwhite-studio','version':self.version})
        atomic_json(self.root/'current.json',{'version':self.version})
        self.core=SimpleNamespace(BASE_DIR=str(self.release/'app'),RUNTIME_DIR=str(self.root/'userdata'),manager=SimpleNamespace(active_connections=[]))
        self.env=patch.dict(os.environ,{'DEEPWHITE_INSTALL_ROOT':str(self.root)}); self.env.start(); self.addCleanup(self.env.stop)
        app=FastAPI(); api.install(app,self.core)
        @app.get('/api/tasks')
        def tasks(): return {'would_poll':True}
        self.client=TestClient(app,base_url='http://127.0.0.1:39841'); self.addCleanup(self.client.close)
        self.headers={'Origin':'http://127.0.0.1:39841'}
        api._active=0

    def post(self,path,payload=None,headers=None):
        return self.client.post('/api/studio/updates/'+path,json=payload or {},headers=headers or self.headers)

    def test_source_mode_does_not_claim_current_release_is_latest(self):
        with patch.dict(os.environ,{'DEEPWHITE_INSTALL_ROOT':''}):
            value=self.client.get('/api/studio/updates/status').json()
            self.assertEqual(value['phase'],'source'); self.assertIsNone(value['latest_version'])
            self.assertFalse(value['can_install'])
            self.assertEqual(self.post('download').status_code,409)

    def test_mutating_routes_require_same_origin(self):
        for headers in ({'Origin':'https://evil.invalid'},{'Origin':'http://127.0.0.1:99'},{'x-test':'no-origin'}):
            with self.subTest(headers=headers): self.assertEqual(self.post('check',headers=headers).status_code,403)

    def test_maintenance_gate_blocks_even_gets_that_might_poll_tasks(self):
        api.engine.layout(self.root); api.engine.gate(self.root,True)
        self.assertEqual(self.client.get('/api/tasks').status_code,503)
        self.assertEqual(self.client.get('/api/studio/updates/status').status_code,200)
        self.assertEqual(self.post('check').status_code,503)

    def test_open_canvas_refuses_install_and_removes_temporary_gate(self):
        self.core.manager.active_connections=[object()]
        with patch.object(api,'_supervisor'):
            response=self.post('install',{'action':'install','saved_and_closed':True})
        self.assertEqual(response.status_code,409)
        self.assertIn('画布',response.json()['detail'])
        self.assertFalse((self.root/'updates'/'maintenance.json').exists())

    def test_unconfirmed_and_unknown_parameters_are_rejected(self):
        with patch.object(api,'_supervisor'):
            self.assertEqual(self.post('install',{'saved_and_closed':False}).status_code,409)
            self.assertEqual(self.post('install',{'saved_and_closed':True,'path':'C:/anything'}).status_code,422)

    def test_busy_request_and_unresolved_task_cannot_race_snapshot(self):
        with patch.object(api,'_supervisor'):
            api._active=1
            self.assertEqual(self.post('install',{'saved_and_closed':True}).status_code,409)
            api._active=0
            directory=self.root/'userdata'/'data'/'studio_jobs'; directory.mkdir(parents=True)
            atomic_json(directory/'fixture.json',{'status':'uncertain'})
            self.assertEqual(self.post('install',{'saved_and_closed':True}).status_code,409)
            atomic_json(directory/'fixture.json',[])
            self.assertEqual(self.post('install',{'saved_and_closed':True}).status_code,409)
        self.assertFalse((self.root/'updates'/'request.json').exists())
        self.assertFalse((self.root/'updates'/'maintenance.json').exists())

    def test_install_only_queues_bounded_request_and_keeps_gate_closed(self):
        api.engine.layout(self.root)
        atomic_json(self.root/'updates'/'prepared.json',{'version':'0.10.2-studio.17'})
        with patch.object(api,'_supervisor'),patch.object(api.engine,'verified_available',return_value={'version':'0.10.2-studio.17'}):
            response=self.post('install',{'action':'install','saved_and_closed':True})
        self.assertEqual(response.status_code,200,response.text)
        request=read_json(self.root/'updates'/'request.json')
        self.assertEqual(set(request),{'action','version','at'})
        self.assertEqual(request['version'],self.version)
        self.assertTrue((self.root/'updates'/'maintenance.json').exists())


if __name__=='__main__': unittest.main()
