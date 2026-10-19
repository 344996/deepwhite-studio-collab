"""Exercise actual Windows entrypoints with official Python, without a server.

python scripts/check_windows_launcher.py --runtime ARCHIVE --workspace NEW_DIR
Retains the fixture and a JSON evidence report. No system Python/PATH is used by
either entrypoint; the fake supervisor records the received path and arguments.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

from build_windows_release import ROOT, canonical, extract_runtime, release_metadata


def check(runtime, workspace):
    workspace = Path(workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=False)
    root = workspace / "中文 空格 & ! (canvas) single'quote"
    version = '0.10.2-studio.16'
    release = root / 'versions' / version
    (release / 'app').mkdir(parents=True)
    extract_runtime(runtime, release / 'python')
    for name in ('Start.cmd', 'Start.ps1', 'launcher.py'):
        shutil.copyfile(ROOT / 'portable' / name, root / name)
    (root / 'current.json').write_bytes(canonical({'version': version}))
    (release / 'release.json').write_bytes(canonical(release_metadata(version, 'a' * 40)))
    (release / 'app' / 'VERSION').write_text(version, encoding='utf-8')
    (release / 'app' / 'studio_portable.py').write_text('''import json, pathlib, sys
args = sys.argv[1:]
root = pathlib.Path(args[args.index('--root') + 1])
port = args[args.index('--port') + 1]
folder = root / 'userdata'
folder.mkdir(exist_ok=True)
(folder / ('probe-' + port + '.json')).write_text(json.dumps({
    'args': args, 'python': sys.executable, 'isolated': sys.flags.isolated,
    'path': sys.path}, ensure_ascii=False), encoding='utf-8')
''', encoding='utf-8')
    powershell = Path(os.environ['SystemRoot']) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe'
    cmd = Path(os.environ['SystemRoot']) / 'System32' / 'cmd.exe'
    environment = dict(os.environ, PATH=str(Path(os.environ['SystemRoot']) / 'System32'))
    commands = [
        ('powershell', 3961, [str(powershell), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            str(root / 'Start.ps1'), '-NoBrowser', '-Port', '3961']),
        ('cmd', 3962, '"' + str(cmd) + '" /d /v:off /s /c ""' + str(root / 'Start.cmd') + '" -NoBrowser -Port 3962"'),
    ]
    results = []
    for name, port, command in commands:
        result = subprocess.run(command, cwd=workspace, env=environment, capture_output=True, timeout=20)
        if result.returncode:
            raise AssertionError(name + ' failed: ' + result.stderr.decode('utf-8', errors='replace'))
        probe = root / 'userdata' / ('probe-' + str(port) + '.json')
        deadline = time.monotonic() + 15
        while not probe.exists() and time.monotonic() < deadline:
            time.sleep(.1)
        record = json.loads(probe.read_text(encoding='utf-8'))
        assert record['args'] == ['--root', str(root), '--port', str(port), '--no-browser'], record
        assert Path(record['python']) == release / 'python' / 'python.exe', record
        assert record['isolated'] == 1, record
        results.append({'entrypoint': name, 'passed': True, **record})
    (root / 'current.json').write_text('{"version":"0.10.2-studio.16","version":"0.10.2-studio.16"}', encoding='utf-8')
    result = subprocess.run([str(powershell), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        str(root / 'Start.ps1'), '-NoBrowser', '-Port', '3963'], env=environment, capture_output=True, timeout=20)
    assert result.returncode == 1, result
    assert not (root / 'userdata' / 'probe-3963.json').exists()
    assert (root / 'updates' / 'launcher.log').is_file()
    broken_version = '0.10.2-studio.17'
    broken = root / 'versions' / broken_version
    (broken / 'python').mkdir(parents=True)
    (broken / 'python' / 'python.exe').write_bytes(b'fixture unexecutable Python')
    (root / 'current.json').write_bytes(canonical({'version': broken_version}))
    transaction = {'id': 'b' * 32, 'old': version, 'new': broken_version,
                   'phase': 'validating', 'action': 'install', 'backup_complete': True}
    (root / 'updates' / 'transaction.json').write_bytes(canonical(transaction))
    command = '"' + str(cmd) + '" /d /v:off /s /c ""' + str(root / 'Start.cmd') + '" -NoBrowser -Port 3964"'
    result = subprocess.run(command, cwd=workspace, env=environment, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr
    probe = root / 'userdata' / 'probe-3964.json'
    deadline = time.monotonic() + 15
    while not probe.exists() and time.monotonic() < deadline:
        time.sleep(.1)
    recovered = json.loads(probe.read_text(encoding='utf-8'))
    assert Path(recovered['python']) == release / 'python' / 'python.exe', recovered
    assert json.loads((root / 'current.json').read_text())['version'] == broken_version
    # Malformed/duplicate transactions never select any executable.
    invalid = canonical(transaction).decode().replace('"phase":"validating"', '"phase":"validating","phase":"committed"')
    (root / 'updates' / 'transaction.json').write_text(invalid)
    result = subprocess.run([str(powershell), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        str(root / 'Start.ps1'), '-NoBrowser', '-Port', '3965'], env=environment, capture_output=True, timeout=20)
    assert result.returncode == 1 and not (root / 'userdata' / 'probe-3965.json').exists()
    (root / 'updates' / 'transaction.json').write_bytes(canonical(transaction))
    report = {'special_path': str(root), 'entrypoints': results, 'duplicate_pointer_rejected': True,
              'uses_system_python': False, 'unexecutable_new_python_recovers_with_old_python': True,
              'duplicate_transaction_rejected': True, 'bootstrap_preserves_pointer': True}
    (workspace / 'verification.json').write_bytes(canonical(report))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.runtime, args.workspace), ensure_ascii=False, indent=2))
