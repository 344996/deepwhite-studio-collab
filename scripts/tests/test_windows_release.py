import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
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
        (repo / 'app' / 'server.py').write_text('committed source')
        (repo / 'app' / '.env').write_text('fixture-private-config')
        (repo / 'app' / 'workspace' / 'canvas.json').write_text('fixture-user-data')
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        for command in [['git', 'add', '.'], ['git', '-c', 'user.name=Fixture', '-c',
                'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]:
            subprocess.run(command, cwd=repo, check=True, capture_output=True)
        (repo / 'app' / 'server.py').write_text('uncommitted modification')
        (repo / 'app' / 'private-key.pem').write_text('untracked secret')
        files = build.committed_sources(repo, 'HEAD')
        self.assertEqual(files['app/server.py'], b'committed source')
        self.assertNotIn('app/.env', files)
        self.assertNotIn('app/workspace/canvas.json', files)
        self.assertNotIn('app/private-key.pem', files)

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
