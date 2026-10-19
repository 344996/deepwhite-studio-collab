import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_windows_release as build
import sign_release as signing

spec = importlib.util.spec_from_file_location('portable_launcher', ROOT / 'portable' / 'launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dw-release-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def fixture(self, suffix='中文 & ! (test) single\'quote'):
        root = self.root / suffix
        version = '0.10.2-studio.16'
        release = root / 'versions' / version
        (release / 'app').mkdir(parents=True)
        (release / 'python').mkdir()
        (root / 'current.json').write_text(json.dumps({'version': version}))
        (release / 'app' / 'VERSION').write_text(version)
        (release / 'app' / 'studio_portable.py').write_text('pass')
        (release / 'python' / 'python.exe').write_bytes(b'fixture executable')
        info = build.release_metadata(version, 'a' * 40)
        (release / 'release.json').write_text(json.dumps(info))
        return root, release

    def test_launcher_passes_special_paths_as_arguments_and_uses_bundled_python(self):
        root, release = self.fixture()
        with patch.object(launcher.subprocess, 'call', return_value=0) as call:
            self.assertEqual(launcher.launch(root, port=3961, no_browser=True), 0)
        args, kwargs = call.call_args
        self.assertEqual(args[0], [str(release / 'python' / 'python.exe'), '-I', '-B',
            str(release / 'app' / 'studio_portable.py'), '--root', str(root), '--port', '3961', '--no-browser'])
        self.assertEqual(kwargs['cwd'], root)

    def test_launcher_rejects_boolean_schema_and_privileged_ports(self):
        root, release = self.fixture()
        with patch.object(launcher.subprocess, 'call') as call:
            for port in [True, 0, 80, 1023, 65536]:
                with self.assertRaises(launcher.LaunchError):
                    launcher.launch(root, port=port)
            info = build.release_metadata('0.10.2-studio.16', 'a' * 40)
            info['data_schema']['write'] = True
            (release / 'release.json').write_text(json.dumps(info))
            with self.assertRaises(launcher.LaunchError):
                launcher.launch(root)
        call.assert_not_called()

    def test_hidden_supervisor_failure_is_logged_and_reported(self):
        root, _ = self.fixture()
        with patch.object(launcher.subprocess, 'call', return_value=7) as call:
            with self.assertRaisesRegex(launcher.LaunchError, 'exit code 7'):
                launcher.launch(root, no_browser=True)
        self.assertEqual(call.call_args.kwargs['stderr'], subprocess.STDOUT)
        self.assertEqual(Path(call.call_args.kwargs['stdout'].name), root / 'updates' / 'launcher.log')
        self.assertTrue((root / 'updates' / 'launcher.log').is_file())
        self.assertFalse((root / 'userdata').exists())

    def test_strip_host_python_entrypoints_preserves_importable_dependencies(self):
        site = self.root / 'site-packages'
        (site / 'bin').mkdir(parents=True)
        (site / 'bin' / 'tool.exe').write_bytes(b'fixture host python path')
        info = site / 'package-1.0.dist-info'
        info.mkdir()
        (site / 'package.py').write_text('fixture package')
        (info / 'RECORD').write_text('../../bin/tool.exe,sha256=fixture,24\npackage.py,sha256=keep,15\n')
        removed = build.strip_host_entrypoints(site)
        self.assertEqual(removed, ['tool.exe'])
        self.assertFalse((site / 'bin').exists())
        self.assertEqual((info / 'RECORD').read_text(), 'package.py,sha256=keep,15\n')
        self.assertTrue((site / 'package.py').is_file())

    def test_launcher_rejects_invalid_duplicate_or_mismatched_version_without_spawning(self):
        root, release = self.fixture()
        for content in ['{"version":"../outside"}', '{"version":true}',
                        '{"version":"0.10.2-studio.16","version":"0.10.2-studio.16"}']:
            (root / 'current.json').write_text(content)
            with self.assertRaises(launcher.LaunchError), patch.object(launcher.subprocess, 'call') as call:
                launcher.launch(root)
            call.assert_not_called()
        (root / 'current.json').write_text('{"version":"0.10.2-studio.16"}')
        (release / 'app' / 'VERSION').write_text('0.10.2-studio.15')
        with self.assertRaises(launcher.LaunchError):
            launcher.launch(root)

    def test_bootstrap_uses_previous_runtime_for_unfinished_transaction_only(self):
        root, old = self.fixture()
        new = root / 'versions' / '0.10.2-studio.17'
        shutil.copytree(old, new)
        (new / 'app' / 'VERSION').write_text('0.10.2-studio.17')
        (new / 'release.json').write_text(json.dumps(build.release_metadata('0.10.2-studio.17', 'b' * 40)))
        (root / 'current.json').write_text('{"version":"0.10.2-studio.17"}')
        (root / 'updates').mkdir()
        tx = {'id': 'c' * 32, 'old': '0.10.2-studio.16', 'new': '0.10.2-studio.17',
              'phase': 'validating', 'action': 'install', 'backup_complete': True}
        path = root / 'updates' / 'transaction.json'
        path.write_text(json.dumps(tx))
        self.assertEqual(launcher.selected_installation(root)[1], old / 'python' / 'python.exe')
        # Selection never mutates the pointer/data; the old supervisor recovers.
        self.assertEqual(json.loads((root / 'current.json').read_text())['version'], tx['new'])
        tx['phase'] = 'committed'
        path.write_text(json.dumps(tx))
        self.assertEqual(launcher.selected_installation(root)[1], new / 'python' / 'python.exe')
        for changes in [{'phase': 'unknown'}, {'phase': 'validating', 'backup_complete': False},
                        {'id': '../escape'}, {'phase': 'stopping'}, {'backup_complete': 1}, {'extra': 1},
                        {'phase': []}, {'error': {}}, {'new': True}]:
            path.write_text(json.dumps({**tx, **changes}))
            with self.assertRaises(launcher.LaunchError):
                launcher.selected_installation(root)

    def test_source_export_rejects_private_keys_and_omits_runtime_databases(self):
        repo = self.root / 'secret-fixture'
        (repo / 'app').mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        for name in ['saved.sqlite3', 'saved.sqlite', 'saved.db', 'global_config.json', 'key.env']:
            (repo / 'app' / name).write_text('fixture user data')
        (repo / 'app' / 'update-trust.json').write_text('{"fixture":"public"}')
        def commit():
            subprocess.run(['git', 'add', '-f', '.'], cwd=repo, check=True, capture_output=True)
            subprocess.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                            'commit', '-qm', 'fixture'], cwd=repo, check=True, capture_output=True)
        commit()
        self.assertEqual(set(build.committed_sources(repo, 'HEAD')), {'app/update-trust.json'})
        for name, data in [('signing-key.pem', 'fixture private'), ('private.key', 'fixture private'),
                           ('private.p12', 'fixture private'), ('private.pfx', 'fixture private'), ('private.jks', 'fixture private'),
                           ('private.txt', '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n')]:
            (repo / 'app' / name).write_text(data)
            commit()
            with self.assertRaises(build.BuildError):
                build.committed_sources(repo, 'HEAD')
            (repo / 'app' / name).unlink()

    def test_loading_existing_signing_key_inside_git_is_rejected(self):
        private = self.root / 'external' / 'fixture.pem'
        signing.create_key(private, 'fixture')
        repo = self.root / 'key-repo'
        repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        shutil.copyfile(private, repo / 'fixture.pem')
        with self.assertRaises(ValueError):
            signing.load_key(repo / 'fixture.pem')
        with self.assertRaises(ValueError):
            signing.external_key_path(private, (private.parent,))

    def test_lock_requires_unique_exact_versions_and_rejects_install_options(self):
        lock = self.root / 'requirements.lock.txt'
        lock.write_text('# comment\nPillow==12.3.0\npydantic_core==2.33.2\n')
        self.assertEqual(build.parse_lock(lock), {'pillow': '12.3.0', 'pydantic-core': '2.33.2'})
        for text in ['requests>=2', '--extra-index-url https://untrusted.invalid\n',
                     'Pillow==12.3.0\npillow==12.3.0', 'pkg @ https://example.invalid/pkg.whl']:
            lock.write_text(text)
            with self.assertRaises(build.BuildError):
                build.parse_lock(lock)

    def test_source_export_uses_committed_bytes_and_excludes_private_runtime_files(self):
        repo = self.root / 'repo'
        (repo / 'app' / 'workspace').mkdir(parents=True)
        (repo / 'docs').mkdir()
        (repo / 'docs' / 'recovery.md').write_bytes('离线恢复说明\n'.encode('utf-8'))
        (repo / 'app' / 'server.py').write_text('committed source')
        (repo / 'app' / '.env').write_text('fixture-private-config')
        (repo / 'app' / 'workspace' / 'canvas.json').write_text('fixture-user-data')
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        for command in [['git', 'add', '.'], ['git', '-c', 'user.name=Fixture', '-c',
                'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]:
            subprocess.run(command, cwd=repo, check=True, capture_output=True)
        (repo / 'app' / 'server.py').write_text('uncommitted modification')
        (repo / 'docs' / 'recovery.md').write_text('uncommitted documentation')
        (repo / 'app' / 'private-key.pem').write_text('untracked secret')
        files = build.committed_sources(repo, 'HEAD')
        self.assertEqual(files['app/server.py'], b'committed source')
        self.assertNotIn('app/.env', files)
        self.assertNotIn('app/workspace/canvas.json', files)
        self.assertNotIn('app/private-key.pem', files)
        build.write_reference_docs(files, self.root / 'references')
        self.assertEqual(files['docs/recovery.md'].decode('utf-8').splitlines(), ['离线恢复说明'])
        self.assertEqual((self.root / 'references' / 'docs' / 'recovery.md').read_bytes(), files['docs/recovery.md'])

    def test_source_archive_rejects_windows_path_separators_and_drives(self):
        for name in ['app/..\\..\\outside.txt', 'app/C:stream', '/absolute.txt']:
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w') as archive:
                item = tarfile.TarInfo(name)
                item.size = 1
                archive.addfile(item, io.BytesIO(b'x'))
            with patch.object(build.subprocess, 'check_output', return_value=buffer.getvalue()):
                with self.assertRaises(build.BuildError):
                    build.committed_sources(self.root, 'HEAD')

    def test_runtime_extraction_rejects_bad_hash_and_traversal(self):
        archive = self.root / 'runtime.zip'
        with zipfile.ZipFile(archive, 'w') as stream:
            stream.writestr('../outside.txt', 'bad')
        with self.assertRaises(build.BuildError):
            build.extract_runtime(archive, self.root / 'one', '0' * 64)
        with self.assertRaises(build.BuildError):
            build.extract_runtime(archive, self.root / 'two', build.sha256(archive))
        self.assertFalse((self.root / 'outside.txt').exists())

    def test_release_zip_size_and_signature_match_updater_contract(self):
        tree = self.root / 'tree'
        (tree / 'app').mkdir(parents=True)
        (tree / 'app' / 'fixture.txt').write_bytes(b'1234567')
        (tree / 'LICENSE').write_bytes(b'license')
        archive = self.root / 'version.zip'
        unpacked = build.write_zip(tree, archive, 1780000000)
        self.assertEqual(unpacked, 14)
        with zipfile.ZipFile(archive) as stream:
            self.assertEqual(sum(i.file_size for i in stream.infolist()), unpacked)
            self.assertEqual(sorted(stream.namelist()), ['LICENSE', 'app/fixture.txt'])
        private = self.root / 'private.pem'
        trust = signing.create_key(private, 'fixture-key')
        release = build.release_metadata('0.10.2-studio.16', 'b' * 40)
        signed = build.manifest_metadata(release, archive, unpacked, sequence=2026101901,
            artifact_url='https://github.com/344996/deepwhite-studio-collab/releases/download/v0.10.2-studio.16/version.zip',
            notes='Fixture release', issued_at=1792378800, expires_days=90)
        envelope = signing.sign_manifest(signed, private, 'fixture-key')
        sys.path.insert(0, str(ROOT / 'app'))
        from studio_update_core import verify_manifest, UpdateError
        verified = verify_manifest(envelope, trust, current='0.10.2-studio.15', now=1792378801)
        self.assertEqual(verified['artifact']['unpacked_size'], 14)
        envelope['signed']['notes'] = 'tampered'
        with self.assertRaises(UpdateError):
            verify_manifest(envelope, trust, current='0.10.2-studio.15', now=1792378801)


if __name__ == '__main__':
    unittest.main()
