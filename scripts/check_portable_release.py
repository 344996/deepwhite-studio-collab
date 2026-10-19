"""Build and rehearse portable updates using an isolated Git fixture and key.

All app traffic uses loopback and temporary user data. Release-feed transport is
mocked and ZIP bytes are copied into the verified download cache; signature,
extraction, real process startup, HTTP install, backups and rollback are real.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile

import httpx
import psutil

import build_windows_release as build
from sign_release import canonical, create_key, sign_manifest


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def wait_for(callback, timeout=80, label='condition'):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            result = callback()
            if result:
                return result
        except (OSError, ValueError, httpx.HTTPError, psutil.Error) as exc:
            last = str(exc)
        time.sleep(.25)
    raise AssertionError('Timed out waiting for ' + label + ': ' + str(last))


def make_source(repo, commit, workspace, trust):
    source = workspace / 'source-fixture'
    source.mkdir()
    for name, content in build.committed_sources(repo, commit).items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    (source / 'app' / 'update-trust.json').write_bytes(canonical(trust))
    run(['git', 'init', '-q', str(source)])
    run(['git', 'add', '.'], cwd=source, capture_output=True)
    run(['git', '-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid',
         'commit', '-qm', 'Temporary fixture from ' + commit + ' with test trust only'], cwd=source)
    return source


def make_version(base, workspace, version, private, sequence, *, fail_start=False):
    tree = workspace / ('version-fixture-' + version)
    shutil.copytree(base, tree)
    (tree / 'app' / 'VERSION').write_text(version + '\n', encoding='utf-8')
    release = read(tree / 'release.json')
    release['version'] = version
    (tree / 'release.json').write_bytes(canonical(release))
    if fail_start:
        supervisor = tree / 'app' / 'studio_portable.py'
        supervisor.write_bytes(b'import time; time.sleep(5); raise SystemExit(42)\n' + supervisor.read_bytes())
    provenance = read(tree / 'references' / 'build-provenance.json')
    provenance['fixture'] = {'version_changed_only_in_temporary_tree': True, 'fail_start': fail_start}
    for name in ('app/VERSION', 'app/studio_portable.py'):
        provenance['source_files'][name] = build.sha256(tree / name)
    (tree / 'references' / 'build-provenance.json').write_bytes(canonical(provenance))
    archive = workspace / ('fixture-' + version + '.zip')
    unpacked = build.write_zip(tree, archive, int(time.time()))
    signed = build.manifest_metadata(release, archive, unpacked, sequence=sequence,
        artifact_url='https://github.com/344996/deepwhite-studio-collab/releases/download/fixture/' + archive.name,
        notes='Local rehearsal fixture; never publish.')
    envelope = workspace / ('fixture-' + version + '.json')
    envelope.write_bytes(canonical(sign_manifest(signed, private, 'fixture-only')))
    return archive, envelope


def verify_package(report, workspace):
    output = workspace / 'initial-package'
    package = next(output.glob('*-portable.zip'))
    version_package = next(output.glob('*-version.zip'))
    with zipfile.ZipFile(package) as archive:
        assert 'userdata/' in archive.namelist() and 'updates/' in archive.namelist()
        assert 'Start.cmd' in archive.namelist()
        assert not any('private.pem' in name or '__pycache__' in name for name in archive.namelist())
    with zipfile.ZipFile(version_package) as archive:
        assert sum(item.file_size for item in archive.infolist()) == report['unpacked_size']
        assert not any(build.forbidden(name) for name in archive.namelist())
        assert not any('/site-packages/bin/' in name for name in archive.namelist())
        for name, expected in build.committed_sources(workspace / 'source-fixture', report['commit']).items():
            if name.startswith('app/'):
                assert archive.read(name) == expected, name
        prefixes = {str(Path(sys.base_prefix)).lower().encode(), str(build.ROOT).lower().encode()}
        for item in archive.infolist():
            if item.filename.startswith('python/'):
                content = archive.read(item).lower()
                assert not any(prefix in content for prefix in prefixes), item.filename
    return package


class Rehearsal:
    def __init__(self, root, workspace, report):
        self.root, self.workspace, self.report = root, workspace, report
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.base = 'http://127.0.0.1:' + str(self.port)
        self.http = httpx.Client(base_url=self.base, timeout=5, trust_env=False,
                                 headers={'Origin': self.base, 'Sec-Fetch-Site': 'same-origin'})

    def record(self, name, **details):
        self.report['checks'].append({'name': name, 'passed': True, **details})
        (self.workspace / 'verification.json').write_bytes(canonical(self.report))
        print('Passed:', name, flush=True)

    def launch(self, use_config=False):
        cmd = Path(os.environ['SystemRoot']) / 'System32' / 'cmd.exe'
        command = ('"' + str(cmd) + '" /d /v:off /s /c ""' + str(self.root / 'Start.cmd') + '" -NoBrowser'
                   + ('' if use_config else ' -Port ' + str(self.port)) + '"')
        environment = dict(os.environ, PATH=str(Path(os.environ['SystemRoot']) / 'System32'),
                           DEEPWHITE_NO_BROWSER='1', DEEPWHITE_STUDIO_NO_BROWSER='1')
        environment.pop('DEEPWHITE_STUDIO_PORT', None)
        # A detached Windows child can inherit a capture pipe and hold it open
        # for its entire lifetime. Use the launcher's on-disk log instead.
        result = subprocess.run(command, cwd=self.root, env=environment,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        assert result.returncode == 0, result.returncode

    def health(self, version):
        response = self.http.get('/api/studio/health')
        value = response.json()
        return (value if response.status_code == 200 and value.get('ready') is True
                and value.get('version') == version
                and Path(value.get('installation', '')).resolve() == self.root / 'versions' / version / 'app'
                else False)

    def owned(self, name):
        info = read(self.root / 'updates' / name)
        process = psutil.Process(info['pid'])
        assert abs(process.create_time() - info['created']) < .001
        args = process.cmdline()
        assert '--root' in args and Path(args[args.index('--root') + 1]).resolve() == self.root
        return process

    def canvas(self, title):
        response = self.http.post('/api/canvases', json={'title': title})
        response.raise_for_status()
        value = response.json()['canvas']
        response = self.http.put('/api/canvases/' + value['id'], json={
            'title': title, 'base_updated_at': value['updated_at'], 'client_id': 'release-fixture',
            'nodes': [{'id': 'fixture-text', 'type': 'text', 'text': title, 'x': 0, 'y': 0,
                       'width': 280, 'height': 160}], 'connections': []})
        response.raise_for_status()
        return response.json()['canvas']

    def assert_canvas(self, expected):
        response = self.http.get('/api/canvases/' + expected['id'])
        response.raise_for_status()
        actual = response.json()['canvas']
        assert actual['title'] == expected['title'] and actual['nodes'] == expected['nodes']

    def prepare(self, archive, envelope):
        current = read(self.root / 'current.json')['version']
        python = self.root / 'versions' / current / 'python' / 'python.exe'
        # The feed has no network side effects. ZIP bytes still pass the actual
        # download digest, signature verifier and full safe extractor.
        code = '''import json,sys,shutil
from pathlib import Path
import httpx, studio_update_engine as engine
root=Path(sys.argv[1]); envelope=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
transport=httpx.MockTransport(lambda request:httpx.Response(200,json=envelope))
engine.check(root,transport=transport)
cache=root/'updates'/'downloads'; cache.mkdir(parents=True,exist_ok=True)
shutil.copyfile(sys.argv[3],cache/(envelope['signed']['artifact']['sha256']+'.zip'))
engine.prepare(root)
'''
        run([str(python), '-I', '-B', '-c', code, str(self.root), str(envelope), str(archive)], timeout=120)
        assert self.http.get('/api/studio/updates/status').json()['phase'] == 'ready'

    def install(self, version, phase, action='install'):
        response = self.http.post('/api/studio/updates/install', json={'action': action, 'saved_and_closed': True})
        response.raise_for_status()
        def completed():
            if not self.health(version):
                return False
            status = self.http.get('/api/studio/updates/status').json()
            return status if status['phase'] == phase else False
        return wait_for(completed, timeout=150, label=action + ' ' + version)

    def stop(self):
        # Kill only this fixture's recorded supervisor; its child watchdog then
        # exits and releases the runtime lock. Never stop a process by port/name.
        try:
            process = self.owned('supervisor.json')
            process.kill()
            process.wait(timeout=10)
        except (FileNotFoundError, psutil.NoSuchProcess):
            pass
        try:
            child = self.owned('server-process.json')
            child.wait(timeout=10)
        except (FileNotFoundError, psutil.NoSuchProcess):
            pass


def check(args):
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=False)
    source_commit = subprocess.check_output(['git', '-C', str(args.repo), 'rev-parse', args.ref + '^{commit}'], text=True).strip()
    report = {'source_commit': source_commit, 'checks': [], 'feed_transport': 'mocked',
              'paid_provider_generation': False, 'fixture_signing_key': True}
    with tempfile.TemporaryDirectory(prefix='deepwhite-fixture-key-') as secrets:
        private = Path(secrets) / 'private.pem'
        source = make_source(args.repo, source_commit, workspace, create_key(private, 'fixture-only'))
        initial = build.build_release(source, 'HEAD', args.cache, workspace / 'initial-package',
            private, 'fixture-only', 100, 'Local rehearsal fixture; never publish.')
        package = verify_package(initial, workspace)
        base = Path(initial['stage']) / 'portable' / 'versions' / initial['version']
        assert initial['version'] == '0.10.2-studio.15', 'This rehearsal starts at .15.'
        archive16, envelope16 = make_version(base, workspace, '0.10.2-studio.16', private, 101)
        archive17, envelope17 = make_version(base, workspace, '0.10.2-studio.17', private, 102, fail_start=True)
        root = workspace / "实际安装 中文 & ! (canvas) single'quote"
        with zipfile.ZipFile(package) as archive:
            archive.extractall(root)
        rehearsal = Rehearsal(root, workspace, report)
        try:
            rehearsal.record('Package source, exclusions, runtime origin and unpacked size verified', initial_commit=initial['commit'])
            (root / 'installation.json').write_bytes(canonical({'port': rehearsal.port}))
            rehearsal.launch(use_config=True)
            first = wait_for(lambda: rehearsal.health('0.10.2-studio.15'), label='initial bundled app')
            rehearsal.record('Actual Start.cmd serves bundled .15 using installation.json port', server_pid=first['pid'])
            supervisor = rehearsal.owned('supervisor.json')
            rehearsal.launch()
            time.sleep(2)
            assert rehearsal.health('0.10.2-studio.15')['pid'] == first['pid']
            assert rehearsal.owned('supervisor.json').pid == supervisor.pid
            rehearsal.record('Repeated launch keeps one supervisor and server')
            before = rehearsal.canvas('Before update - fixture text')
            rehearsal.prepare(archive16, envelope16)
            rehearsal.install('0.10.2-studio.16', 'installed')
            rehearsal.assert_canvas(before)
            newer = rehearsal.canvas('Created after update - preserve through rollback')
            rehearsal.record('Signed .15 to .16 upgrade preserves work and accepts new work', canvas_ids=[before['id'], newer['id']])
            rehearsal.install('0.10.2-studio.15', 'rolled_back', action='rollback')
            rehearsal.assert_canvas(before)
            rehearsal.assert_canvas(newer)
            rehearsal.record('Manual rollback preserves work created on .16')
            rehearsal.prepare(archive17, envelope17)
            status = rehearsal.install('0.10.2-studio.15', 'rolled_back')
            assert status.get('error'), status
            rehearsal.assert_canvas(before)
            rehearsal.assert_canvas(newer)
            assert read(root / 'updates' / 'transaction.json')['phase'] == 'reverted'
            rehearsal.record('New-version startup failure automatically restores .15 and all work', error=status['error'])
            old_child = rehearsal.owned('server-process.json')
            rehearsal.stop()
            assert not old_child.is_running()
            rehearsal.launch()
            restarted = wait_for(lambda: rehearsal.health('0.10.2-studio.15'), label='hard-exit recovery')
            rehearsal.assert_canvas(before)
            rehearsal.assert_canvas(newer)
            rehearsal.record('Supervisor hard exit stops its child; relaunch preserves work', old_pid=old_child.pid, new_pid=restarted['pid'])
            rehearsal.prepare(archive17, envelope17)
            response = rehearsal.http.post('/api/studio/updates/install', json={'action': 'install', 'saved_and_closed': True})
            response.raise_for_status()
            def validating():
                tx = read(root / 'updates' / 'transaction.json')
                return tx['phase'] == 'validating' and read(root / 'current.json')['version'] == '0.10.2-studio.17'
            wait_for(validating, timeout=150, label='new broken supervisor validating')
            rehearsal.stop()
            assert read(root / 'updates' / 'transaction.json')['phase'] == 'validating'
            rehearsal.launch(use_config=True)
            wait_for(lambda: rehearsal.health('0.10.2-studio.15'), label='bootstrap recovery from broken new supervisor')
            rehearsal.assert_canvas(before)
            rehearsal.assert_canvas(newer)
            assert read(root / 'updates' / 'transaction.json')['phase'] == 'reverted'
            rehearsal.record('Hard exit during validating with broken new supervisor recovers through old bootstrap runtime')
        finally:
            rehearsal.stop()
            rehearsal.http.close()
            report['temporary_processes_stopped'] = True
            (workspace / 'verification.json').write_bytes(canonical(report))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=build.ROOT)
    parser.add_argument('--ref', required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(check(args), ensure_ascii=False, indent=2))
