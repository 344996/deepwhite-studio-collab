"""Run backend regressions with disposable data and loopback-only networking."""
import ipaddress
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'test-output'
OUTPUT.mkdir(exist_ok=True)
RUNTIME = Path(tempfile.mkdtemp(prefix='phase1-backend-', dir=OUTPUT))
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = str(RUNTIME)
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT))


def require_loopback(address):
    if not isinstance(address, tuple):
        return
    host = address[0]
    if host == 'localhost':
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise RuntimeError('External network blocked during phase-one tests')


if __name__ == '__main__':
    connect, connect_ex = socket.socket.connect, socket.socket.connect_ex

    def local_connect(self, address):
        require_loopback(address)
        return connect(self, address)

    def local_connect_ex(self, address):
        require_loopback(address)
        return connect_ex(self, address)

    socket.socket.connect, socket.socket.connect_ex = local_connect, local_connect_ex
    try:
        suite = unittest.defaultTestLoader.discover(str(ROOT / 'tests'), pattern='test_*.py')
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    finally:
        socket.socket.connect, socket.socket.connect_ex = connect, connect_ex
    summary = {'passed': result.wasSuccessful(), 'tests': result.testsRun,
               'failures': [test.id() for test, _ in result.failures],
               'errors': [test.id() for test, _ in result.errors],
               'skipped': len(result.skipped), 'runtime': str(RUNTIME)}
    (OUTPUT / 'backend-result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))
    sys.exit(not result.wasSuccessful())
