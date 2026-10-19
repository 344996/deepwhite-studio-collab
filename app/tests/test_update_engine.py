"""Crash/rollback drills on synthetic installations; no user service is stopped."""
import base64
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import studio_update_engine as engine
from studio_update_core import APP_ID, UpdateError, canonical, atomic_json, read_json


class UpdateTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='dw-update-fixture-'); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.old='0.10.2-studio.15'; self.new='0.10.2-studio.16'
        self.key=Ed25519PrivateKey.generate()
        self.trust={'fixture':base64.b64encode(self.key.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw)).decode()}
        self.meta={'app':APP_ID,'version':self.old,'platform':'windows-x64','data_schema':{'read_min':1,'read_max':1,'write':1},'min_bootstrap':1,'commit':'a'*40}
        self.old_dir=self.root/'versions'/self.old; (self.old_dir/'app').mkdir(parents=True)
        atomic_json(self.old_dir/'release.json',self.meta)
        (self.old_dir/'app'/'VERSION').write_text(self.old)
        atomic_json(self.old_dir/'app'/'update-trust.json',self.trust)
        atomic_json(self.root/'current.json',{'version':self.old})
        self.runtime=self.root/'userdata'; (self.runtime/'data'/'canvases').mkdir(parents=True)
        (self.runtime/'data'/'canvases'/'fixture.json').write_text('{"nodes":[{"text":"Synthetic prompt"}]}')
        (self.runtime/'key.env').write_text('SYNTHETIC_ONLY')
        (self.runtime/'media.bin').write_bytes(bytes(range(256)))
        self.before=engine.tree_manifest(self.runtime)
        self.events=[]
        self.bundle()

    def bundle(self):
        metadata={**self.meta,'version':self.new}
        files={'release.json':json.dumps(metadata),'app/VERSION':self.new,'app/studio_server.py':'# fixture server',
               'app/studio_portable.py':'# fixture supervisor','python/python.exe':'fixture',
               'app/update-trust.json':json.dumps(self.trust)}
        archive=self.root/'fixture.zip'
        with zipfile.ZipFile(archive,'w') as z:
            for name,data in files.items(): z.writestr(name,data)
        self.content=archive.read_bytes()
        now=int(time.time())
        self.signed={'schema':'deepwhite.update.v1',**metadata,'channel':'stable','sequence':16,'issued_at':now-1,'expires_at':now+86400,
                     'notes':'Fixture update','artifact':{'url':'https://github.com/344996/deepwhite-studio-collab/releases/download/fixture/version.zip',
                     'size':len(self.content),'sha256':hashlib.sha256(self.content).hexdigest(),'unpacked_size':sum(len(v.encode()) for v in files.values())}}
        self.envelope={'signed':self.signed,'signatures':[{'key_id':'fixture','signature':base64.b64encode(self.key.sign(canonical(self.signed))).decode()}]}
        self.transport=httpx.MockTransport(lambda req:httpx.Response(200,content=self.content if req.url.path.endswith('version.zip') else canonical(self.envelope)))

    def prepare(self):
        self.assertEqual(engine.check(self.root,transport=self.transport)['phase'],'available')
        self.assertEqual(engine.prepare(self.root,transport=self.transport)['phase'],'ready')

    def stop(self): self.events.append('stop')
    def start(self,value): self.events.append('start:'+value)
    def healthy(self,value): self.events.append('healthy:'+value); return True
    def install(self,**kw): return engine.install(self.root,self.stop,self.start,self.healthy,**kw)

    def test_install_keeps_old_program_and_verifiable_userdata_backup(self):
        self.prepare(); result=self.install()
        self.assertEqual(result['phase'],'installed')
        self.assertEqual(read_json(self.root/'current.json')['version'],self.new)
        self.assertTrue((self.old_dir/'app'/'VERSION').exists())
        self.assertEqual(engine.tree_manifest(self.runtime),self.before)
        backup=self.root/'updates'/'backups'/result['backup']
        self.assertEqual(engine.tree_manifest(backup/'userdata'),read_json(backup/'manifest.json')['files'])
        self.assertFalse((self.root/'updates'/'maintenance.json').exists())
        self.assertLess(self.events.index('stop'),self.events.index('start:'+self.new))

    def test_health_failure_restores_data_mutated_during_startup(self):
        self.prepare()
        def start(value):
            self.start(value)
            if value==self.new:
                (self.runtime/'key.env').write_text('MUTATED_FIXTURE')
                (self.runtime/'new-cache').write_text('fixture')
        result=engine.install(self.root,self.stop,start,lambda value:value==self.old)
        self.assertEqual(result['phase'],'rolled_back')
        self.assertEqual(engine.tree_manifest(self.runtime),self.before)
        self.assertEqual(read_json(self.root/'current.json')['version'],self.old)
        preserved=list((self.root/'updates').glob('failed-data-*'))
        self.assertEqual(len(preserved),1)
        self.assertEqual((preserved[0]/'key.env').read_text(),'MUTATED_FIXTURE')

    def test_manual_program_rollback_preserves_works_created_after_update(self):
        self.prepare(); self.install()
        (self.runtime/'later-work.json').write_text('{"new":true}')
        newest=engine.tree_manifest(self.runtime)
        result=self.install(action='rollback')
        self.assertEqual(result['current_version'],self.old)
        self.assertEqual(engine.tree_manifest(self.runtime),newest)

    def test_mutated_staging_is_not_used_as_executable_input(self):
        self.prepare()
        stage=self.root/read_json(self.root/'updates'/'prepared.json')['path']
        (stage/'app'/'studio_server.py').write_text('tampered')
        self.install()
        self.assertEqual((self.root/'versions'/self.new/'app'/'studio_server.py').read_text(),'# fixture server')

    def test_mutated_archive_is_rejected_before_stopping_server(self):
        self.prepare()
        archive=next((self.root/'updates'/'downloads').glob('*.zip')); archive.write_bytes(b'bad')
        with self.assertRaises(UpdateError): self.install()
        self.assertEqual(self.events,[])
        self.assertEqual(engine.tree_manifest(self.runtime),self.before)

    def test_unresolved_jobs_and_corrupt_receipts_block_install(self):
        self.prepare(); directory=self.runtime/'data'/'studio_jobs'; directory.mkdir()
        for content in ['{"status":"running"}','{"status":"uncertain"}','{"status":"paused"}','{broken','[]','null','{}']:
            (directory/'fixture.json').write_text(content)
            with self.subTest(content=content),self.assertRaises(UpdateError): self.install()
        self.assertEqual(self.events,[])

    def test_insufficient_disk_space_keeps_current_program(self):
        self.prepare()
        with patch.object(engine.shutil,'disk_usage',return_value=type('Usage',(),{'free':1})()), self.assertRaises(UpdateError):
            self.install()
        self.assertEqual(self.events,[])

    def test_backup_failure_restarts_old_version_without_touching_data(self):
        self.prepare()
        with patch.object(engine,'backup_data',side_effect=OSError('synthetic disk failure')):
            result=self.install()
        self.assertEqual(result['current_version'],self.old)
        self.assertEqual(engine.tree_manifest(self.runtime),self.before)
        self.assertEqual(self.events,['stop','stop','start:'+self.old,'healthy:'+self.old])
        # A failed version directory is preserved, and a clean retry is possible.
        self.assertEqual(self.install()['phase'],'installed')
        self.assertEqual(len(list((self.root/'updates').glob('unused-version-*'))),1)

    def test_interrupted_precommit_recovers_before_server_start(self):
        self.prepare(); operation='b'*32
        engine.backup_data(self.root,operation)
        (self.runtime/'key.env').write_text('PARTIAL_STARTUP')
        atomic_json(self.root/'updates'/'transaction.json',{'id':operation,'old':self.old,'new':self.new,'action':'install','phase':'switching','backup_complete':True})
        engine.gate(self.root,True)
        engine.recover(self.root)
        self.assertEqual(engine.tree_manifest(self.runtime),self.before)
        self.assertEqual(read_json(self.root/'updates'/'transaction.json')['phase'],'reverted')

    def test_committed_recovery_never_rewinds_recent_userdata(self):
        self.prepare(); self.install()
        (self.runtime/'new-work.txt').write_text('created after commit')
        newest=engine.tree_manifest(self.runtime); engine.gate(self.root,True)
        engine.recover(self.root)
        self.assertEqual(engine.tree_manifest(self.runtime),newest)
        self.assertEqual(read_json(self.root/'current.json')['version'],self.new)

    def test_backup_tampering_prevents_destructive_restore(self):
        self.prepare(); operation='c'*32
        backup=engine.backup_data(self.root,operation)
        (backup/'userdata'/'key.env').write_text('bad')
        with self.assertRaises(UpdateError): engine.restore_backup(self.root,{'id':operation})
        self.assertEqual(engine.tree_manifest(self.runtime),self.before)

    def test_pointer_traversal_and_shared_supervisor_lock(self):
        with engine.exclusive(self.root/'lock'):
            with self.assertRaises(UpdateError):
                with engine.exclusive(self.root/'lock'): pass
        atomic_json(self.root/'current.json',{'version':'../../outside'})
        with self.assertRaises(UpdateError): engine.layout(self.root)

    def test_startup_readiness_checks_projects_database_and_data_schema(self):
        engine.validate_data(self.runtime)
        self.assertEqual(read_json(self.runtime/'data-schema.json'),{'schema':1})
        canvas=self.runtime/'data'/'canvases'/'fixture.json'
        canvas.write_text('{broken')
        with self.assertRaises(UpdateError): engine.validate_data(self.runtime)
        self.assertEqual(canvas.read_text(),'{broken')
        canvas.write_text('{}')
        atomic_json(self.runtime/'data-schema.json',{'schema':2})
        with self.assertRaises(UpdateError): engine.validate_data(self.runtime)
        atomic_json(self.runtime/'data-schema.json',{'schema':1})
        database=self.runtime/'data'/'studio-assets'/'index.sqlite3'; database.parent.mkdir()
        database.write_bytes(b'corrupted fixture database')
        with self.assertRaises(UpdateError): engine.validate_data(self.runtime)

    def test_unknown_recovery_phase_retains_current_works_and_gate(self):
        self.prepare(); operation='d'*32
        engine.backup_data(self.root,operation)
        (self.runtime/'later-work.json').write_text('{}')
        newest=engine.tree_manifest(self.runtime)
        base={'id':operation,'old':self.old,'new':self.new,'action':'install','phase':'switching','backup_complete':True}
        for mutation in ({'phase':'unknown'},{'backup_complete':'true'},{'old':'0.10.2-studio.1'},{'phase':'committed'}):
            atomic_json(self.root/'updates'/'transaction.json',{**base,**mutation})
            with self.subTest(mutation=mutation),self.assertRaises(UpdateError): engine.recover(self.root)
            self.assertEqual(engine.tree_manifest(self.runtime),newest)
            self.assertTrue((self.root/'updates'/'maintenance.json').exists())

    def test_readiness_rejects_semantically_invalid_but_parseable_records(self):
        project=self.runtime/'data'/'projects.json'
        canvas=self.runtime/'data'/'canvases'/'fixture.json'
        for value in (True,{'projects':'wrong'},[{'id':'x'},{'id':'x'}]):
            atomic_json(project,value)
            with self.subTest(project=value),self.assertRaises(UpdateError): engine.validate_data(self.runtime)
        atomic_json(project,{'projects':[{'id':'default'}]})
        for value in ([],True,{'nodes':{}},{'connections':[1]}):
            atomic_json(canvas,value)
            with self.subTest(canvas=value),self.assertRaises(UpdateError): engine.validate_data(self.runtime)
        atomic_json(canvas,{'nodes':[],'connections':[]})
        engine.validate_data(self.runtime)
        atomic_json(self.runtime/'data-schema.json',{'schema':True})
        with self.assertRaises(UpdateError): engine.validate_data(self.runtime)

    def test_live_server_lock_prevents_any_backup_or_recovery(self):
        self.prepare(); engine.gate(self.root,True)
        with engine.exclusive(self.root/'updates'/'runtime.lock'):
            with self.assertRaises(UpdateError): engine.recover(self.root)
            with self.assertRaises(UpdateError): engine.backup_data(self.root,'e'*32)
        self.assertEqual(engine.tree_manifest(self.runtime),self.before)
        self.assertTrue((self.root/'updates'/'maintenance.json').exists())


if __name__=='__main__': unittest.main()
