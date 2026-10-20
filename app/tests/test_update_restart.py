"""Restart ownership and startup recovery checks with isolated installation data."""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from studio_restart import owned_process, process_identity
import studio_portable as portable
import studio_updates as api
from studio_update_core import UpdateError, atomic_json, read_json


class RestartIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='dw-restart-identity-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.release=self.root/'versions'/'0.11.0-studio.6'
        self.process=Mock()
        self.process.create_time.return_value=1234.5
        self.process.exe.return_value=str(self.release/'python'/'python.exe')
        self.argv=[str(self.release/'python'/'python.exe'),'-I','-B',
                   str(self.release/'app'/'studio_portable.py'),'--root',str(self.root)]
        self.process.cmdline.return_value=self.argv
        self.record={'pid':1234,'created':1234.5}

    def test_ownership_requires_all_fields_not_just_pid(self):
        with patch('studio_restart.psutil.Process',return_value=self.process):
            actual,selected=owned_process(self.root,self.record)
            self.assertIs(actual,self.process)
            self.assertEqual(selected,'0.11.0-studio.6')
            for record in ({'pid':1234,'created':1233.5},{'pid':True,'created':1234.5},
                           {'pid':1234,'created':float('nan')},{'pid':1234,'created':float('inf')},
                           {'pid':1234,'created':True},{'pid':-1,'created':1234.5}):
                with self.subTest(record=record),self.assertRaises(UpdateError):
                    owned_process(self.root,record)

    def test_foreign_interpreter_script_root_and_server_role_are_rejected(self):
        with patch('studio_restart.psutil.Process',return_value=self.process):
            self.process.exe.return_value=str(self.root/'other'/'python.exe')
            with self.assertRaises(UpdateError): owned_process(self.root,self.record)
            self.process.exe.return_value=str(self.release/'python'/'python.exe')
            for argv in (self.argv[:-1]+[str(self.root/'other')],
                         self.argv[:3]+[str(self.root/'unrelated.py')]+self.argv[4:],
                         self.argv+['--serve']):
                self.process.cmdline.return_value=argv
                with self.subTest(argv=argv),self.assertRaises(UpdateError):
                    owned_process(self.root,self.record)
            self.process.cmdline.return_value=self.argv+['--serve']
            self.assertEqual(owned_process(self.root,self.record,server=True)[1],'0.11.0-studio.6')

    def test_malformed_expected_identity_is_rejected(self):
        for record in (None,[],{}, {'pid':1,'created':0},{'pid':1.0,'created':1}):
            with self.subTest(record=record),self.assertRaises(UpdateError):
                process_identity(record)


class RestartStartupTests(unittest.TestCase):
    """Exercise real startup, disk recovery and API status without spawning a server."""
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='dw-restart-startup-')
        self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name).resolve()
        self.current='0.11.0-studio.6'
        self.release=self.root/'versions'/self.current
        (self.release/'app').mkdir(parents=True)
        (self.release/'app'/'VERSION').write_text(self.current,encoding='utf-8')
        atomic_json(self.release/'release.json',{'app':'deepwhite-studio','version':self.current})
        atomic_json(self.root/'current.json',{'version':self.current})
        portable.updates.layout(self.root)
        self.project=self.root/'userdata'/'saved-project.json'
        self.saved=b'{"prompt":"synthetic project kept after interrupted restart"}'
        self.project.write_bytes(self.saved)
        self.state=self.root/'updates'/'state.json'
        self.error='Previous restart was interrupted before startup finished.'
        environment=patch.dict(os.environ,{'DEEPWHITE_INSTALL_ROOT':str(self.root)})
        environment.start(); self.addCleanup(environment.stop)
        self.core=SimpleNamespace(BASE_DIR=str(self.release/'app'),RUNTIME_DIR=str(self.root/'userdata'))

    def _interrupted(self):
        portable.updates.state(self.root,phase='restarting',error=self.error)
        portable.updates.gate(self.root,True)

    def _run_startup(self,ready,supervisor_version=None):
        runner=portable.Supervisor(self.root,39841,no_browser=True)
        child=Mock(pid=12345)
        # The synthetic child exits after the controlled health check, ending the
        # real supervisor loop without sleeps, signals or any real child process.
        child.poll.return_value=0
        def start(selected):
            self.assertEqual(selected,self.current)
            self.assertEqual(read_json(self.state)['phase'],'restarting')
            runner.child=child
        def health_check(selected):
            self.assertEqual(selected,self.current)
            self.assertEqual(read_json(self.state)['phase'],'restarting')
            self.assertEqual(read_json(self.state)['error'],self.error)
            self.assertEqual(self.project.read_bytes(),self.saved)
            return ready
        script=self.root/'versions'/(supervisor_version or self.current)/'app'/'studio_portable.py'
        with (patch.object(portable,'__file__',str(script)),
              patch.object(runner,'start',side_effect=start) as launch,
              patch.object(runner,'ready',side_effect=health_check) as check,
              patch.object(portable.psutil,'Process',return_value=SimpleNamespace(create_time=lambda:1234.5)),
              patch.object(portable.subprocess,'Popen',side_effect=AssertionError('No real child may be launched')),
              patch.object(portable,'healthy',side_effect=AssertionError('No network check is allowed')),
              patch.object(portable.webbrowser,'open',side_effect=AssertionError('No browser may be opened'))):
            runner.run()
        launch.assert_called_once_with(self.current)
        check.assert_called_once_with(self.current)
        child.terminate.assert_not_called()
        self.assertIsNone(runner.child)

    def test_start_cmd_recovers_interrupted_restart_only_after_new_service_is_ready(self):
        for completed_install in (False,True):
            with self.subTest(completed_install=completed_install):
                if completed_install:
                    atomic_json(self.root/'updates'/'transaction.json',{
                        'id':'a'*32,'old':'0.11.0-studio.5','new':self.current,
                        'action':'install','phase':'committed','backup_complete':True})
                self._interrupted()
                pointer=(self.root/'current.json').read_bytes()
                self._run_startup(ready=True)
                with patch.object(api,'supervisor_version',return_value=self.current):
                    status=api.status(self.core)
                self.assertEqual(status['phase'],'restarted')
                self.assertEqual(status['current_version'],self.current)
                self.assertIsNone(status['error'])
                self.assertFalse(status['maintenance'])
                self.assertFalse(status['restart_required'])
                self.assertEqual((self.root/'current.json').read_bytes(),pointer)
                self.assertEqual(self.project.read_bytes(),self.saved)

    def test_failed_startup_keeps_interrupted_state_and_error(self):
        self._interrupted()
        with self.assertRaisesRegex(UpdateError,'画布启动失败'):
            self._run_startup(ready=False)
        state=read_json(self.state)
        self.assertEqual(state['phase'],'restarting')
        self.assertEqual(state['error'],self.error)
        self.assertEqual(self.project.read_bytes(),self.saved)

    def test_old_supervisor_cannot_mark_restart_complete_even_if_child_is_healthy(self):
        self._interrupted()
        self._run_startup(ready=True,supervisor_version='0.11.0-studio.5')
        state=read_json(self.state)
        self.assertEqual(state['phase'],'restarting')
        self.assertEqual(state['error'],self.error)
        self.assertEqual(self.project.read_bytes(),self.saved)


if __name__=='__main__':
    unittest.main()
