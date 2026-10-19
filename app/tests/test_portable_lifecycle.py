"""Real-process lifecycle probes using synthetic data and a controlled service body.

The production server registration, parent monitor and runtime lock all run in a
real child process. The HTTP body is replaced with a marker writer so these tests
cannot bind a port, open the user's installation or contact a provider.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import studio_update_engine as engine
from studio_update_core import UpdateError, atomic_json


CHILD = r'''
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])
import studio_portable as portable

root = Path(sys.argv[2])
args = SimpleNamespace(root=str(root), port=39990,
                       supervisor_pid=int(sys.argv[3]),
                       supervisor_created=float(sys.argv[4]))
original_read = portable.read_json

def observed_read(path):
    # A deterministic signal that the real registration loop has been reached.
    (root / 'registration-read').write_text('waiting', encoding='utf-8')
    return original_read(path)

def synthetic_service(args):
    runtime = root / 'userdata'
    runtime.mkdir()
    (runtime / 'entered-service').write_text('synthetic only', encoding='utf-8')
    while True:
        time.sleep(.05)

portable.read_json = observed_read
portable._serve = synthetic_service
# A Windows virtualenv executable can be a launcher with a distinct child PID.
# Record the actual Python process, as the portable embedded interpreter does.
portable.atomic_json(root / 'child-identity.json',
                     {'pid': os.getpid(), 'created': portable.psutil.Process().create_time()})
portable.server(args)
'''


PARENT = r'''
import os
from pathlib import Path
import subprocess
import sys
import time

import psutil

root = Path(sys.argv[1])
with (root / 'child.log').open('wb') as log:
    child = subprocess.Popen(
        [sys.executable, '-I', '-B', str(root / 'child.py'), sys.argv[2],
         str(root), str(os.getpid()), str(psutil.Process().create_time())],
        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    while not (root / 'exit-parent').exists() and child.poll() is None:
        time.sleep(.02)
# Deliberately exit without waiting for the child, modelling a lost supervisor.
'''


class PortableLifecycleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='dw-portable-lifecycle-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'updates').mkdir()
        (self.root / 'child.py').write_text(CHILD, encoding='utf-8')
        (self.root / 'parent.py').write_text(PARENT, encoding='utf-8')
        self.parent = None
        self.child = None
        self.addCleanup(self._cleanup_processes)

    def _wait_for(self, predicate, message, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.02)
        log = self.root / 'child.log'
        self.fail(message + '\n' + (log.read_text(encoding='utf-8', errors='replace') if log.exists() else ''))

    def _start_pair(self):
        self.parent = subprocess.Popen(
            [sys.executable, '-I', '-B', str(self.root / 'parent.py'),
             str(self.root), str(Path(engine.__file__).resolve().parent)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        identity_path = self.root / 'child-identity.json'
        self._wait_for(identity_path.exists, 'Parent did not record its test child.')
        identity = json.loads(identity_path.read_text(encoding='utf-8'))
        self.child = psutil.Process(identity['pid'])
        self.assertAlmostEqual(self.child.create_time(), identity['created'], places=3)
        self._wait_for((self.root / 'registration-read').exists,
                       'Child did not reach the production registration loop.')
        return identity

    def _lose_parent(self):
        (self.root / 'exit-parent').write_text('exit', encoding='utf-8')
        self.assertEqual(self.parent.wait(timeout=5), 0)
        self.child.wait(timeout=5)

    def _cleanup_processes(self):
        if self.parent is not None:
            if self.parent.poll() is None:
                (self.root / 'exit-parent').write_text('cleanup', encoding='utf-8')
                try:
                    self.parent.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.parent.terminate()
                    self.parent.wait(timeout=5)
            if self.parent.stderr:
                self.parent.stderr.close()
        if self.child is not None:
            try:
                if self.child.is_running():
                    self.child.terminate()
                self.child.wait(timeout=5)
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                pass

    def test_parent_exit_before_registration_never_accesses_userdata(self):
        self._start_pair()
        self.assertFalse((self.root / 'updates' / 'server-process.json').exists())
        self.assertFalse((self.root / 'userdata').exists())
        self._lose_parent()
        self.assertFalse((self.root / 'userdata').exists())
        self.assertFalse((self.root / 'updates' / 'runtime.lock').exists())

    def test_wrong_creation_time_does_not_admit_child_to_userdata(self):
        identity = self._start_pair()
        atomic_json(self.root / 'updates' / 'server-process.json',
                    {**identity, 'created': identity['created'] - 60})
        # The actual registration loop must read the mismatched record at least
        # once before parent loss. The marker is rewritten on every read.
        marker = self.root / 'registration-read'
        observed = marker.stat().st_mtime_ns
        self._wait_for(lambda: marker.stat().st_mtime_ns != observed,
                       'Child did not check the mismatched identity.')
        self.assertFalse((self.root / 'userdata').exists())
        self._lose_parent()
        self.assertFalse((self.root / 'userdata').exists())

    def test_registered_child_holds_lock_until_parent_death(self):
        identity = self._start_pair()
        atomic_json(self.root / 'updates' / 'server-process.json', identity)
        marker = self.root / 'userdata' / 'entered-service'
        self._wait_for(marker.exists, 'Registered child did not enter the synthetic service.')
        lock = self.root / 'updates' / 'runtime.lock'
        with self.assertRaises(UpdateError):
            with engine.exclusive(lock):
                self.fail('A live service must own the runtime lock.')
        self._lose_parent()
        with engine.exclusive(lock):
            self.assertEqual(marker.read_text(encoding='utf-8'), 'synthetic only')


if __name__ == '__main__':
    unittest.main()
