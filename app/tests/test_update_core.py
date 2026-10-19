"""Release verification uses synthetic signing keys and HTTPS transports only."""
import base64
import hashlib
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import zipfile

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import studio_update_core as updates

URL = 'https://github.com/344996/deepwhite-studio-collab/releases/download/test/version.zip'


class UpdateCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key = Ed25519PrivateKey.generate()
        self.trust = {'fixture': base64.b64encode(self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()}
        self.signed = {'schema':'deepwhite.update.v1', 'app':updates.APP_ID, 'version':'0.10.2-studio.16',
                       'channel':'stable','platform':'windows-x64','sequence':16,'issued_at':1000,'expires_at':2000,
                       'min_bootstrap':1, 'data_schema':{'read_min':1,'read_max':1,'write':1},'commit':'a'*40,
                       'notes':'Fixture release', 'artifact':{'url':URL,'size':3,'sha256':hashlib.sha256(b'abc').hexdigest(),'unpacked_size':100}}

    def envelope(self):
        return {'signed':self.signed, 'signatures':[{'key_id':'fixture', 'signature':base64.b64encode(self.key.sign(updates.canonical(self.signed))).decode()}]}

    def verify(self, envelope=None, **kw):
        return updates.verify_manifest(envelope or self.envelope(), self.trust, current='0.10.2-studio.15', now=1500, **kw)

    def bundle(self, extra=None):
        metadata = {k:self.signed[k] for k in ('app','version','platform','data_schema','min_bootstrap','commit')}
        entries = {'release.json':json.dumps(metadata), 'app/VERSION':self.signed['version'],
                   'app/studio_server.py':'# server','app/studio_portable.py':'# launcher','python/python.exe':'fixture'}
        entries.update(extra or {})
        archive = self.root / 'update.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            for name, data in entries.items():
                z.writestr(name, data)
        self.signed['artifact']['unpacked_size'] = sum(len(v.encode()) for v in entries.values())
        return archive

    def test_valid_signature_and_numeric_version(self):
        self.assertEqual(self.verify()['version'], self.signed['version'])
        self.assertGreater(updates.version('0.10.2-studio.100'), updates.version('0.10.2-studio.99'))

    def test_modified_manifest_is_rejected_before_download(self):
        envelope = self.envelope()
        self.signed['notes'] = 'tampered'
        with self.assertRaisesRegex(updates.UpdateError, '签名'):
            self.verify(envelope)

    def test_unknown_signer_is_rejected(self):
        envelope = self.envelope()
        envelope['signatures'][0]['key_id'] = 'stranger'
        with self.assertRaises(updates.UpdateError):
            self.verify(envelope)

    def test_replayed_sequence_and_downgrade_rejected(self):
        with self.assertRaises(updates.UpdateError):
            self.verify(minimum_sequence=17)
        self.signed['version'] = '0.10.2-studio.14'
        with self.assertRaises(updates.UpdateError):
            self.verify()

    def test_expiry_schema_platform_and_bootstrap_boundaries(self):
        for name, value in [('expires_at',1499), ('issued_at',2500), ('expires_at',10**9),
                            ('data_schema',{'read_min':True,'read_max':1,'write':1}),
                            ('data_schema',{'read_min':1,'read_max':2,'write':2}),
                            ('platform','linux'),('min_bootstrap',2),('version',16)]:
            old = self.signed[name]
            with self.subTest(name=name, value=value), self.assertRaises(updates.UpdateError):
                self.signed[name] = value
                self.verify()
            self.signed[name] = old

    def test_url_boundaries_include_redirect_targets(self):
        for url in ['http://github.com/344996/deepwhite-studio-collab/releases/x',
                    'https://github.com/other/repo/releases/x','https://127.0.0.1/x',
                    'https://user:secret@github.com/344996/deepwhite-studio-collab/releases/x',
                    'https://github.com:8888/344996/deepwhite-studio-collab/releases/x']:
            with self.subTest(url=url), self.assertRaises(updates.UpdateError):
                updates.trusted_url(url)
        transport = httpx.MockTransport(lambda _:httpx.Response(302, headers={'location':'http://127.0.0.1/private'}))
        with self.assertRaises(updates.UpdateError):
            updates.fetch_manifest(URL, transport)

    def test_unpublished_and_oversized_manifest_have_clear_failures(self):
        for response in [httpx.Response(404),httpx.Response(200,content=b'x'*(updates.MAX_MANIFEST+1))]:
            with self.assertRaises(updates.UpdateError):
                updates.fetch_manifest(URL, httpx.MockTransport(lambda _:response))

    def test_download_hash_and_cached_package(self):
        calls=[]
        transport=httpx.MockTransport(lambda request:(calls.append(request) or httpx.Response(200,content=b'abc')))
        target=updates.download(self.signed['artifact'], self.root, transport=transport)
        self.assertEqual(target.read_bytes(),b'abc')
        self.assertEqual(updates.download(self.signed['artifact'],self.root,transport=transport),target)
        self.assertEqual(len(calls),1)

    def test_partial_download_resumes_with_range(self):
        partial=self.root/(self.signed['artifact']['sha256']+'.part')
        partial.write_bytes(b'a')
        def handler(request):
            self.assertEqual(request.headers['range'],'bytes=1-')
            self.assertNotIn('authorization',request.headers)
            return httpx.Response(206,headers={'content-range':'bytes 1-2/3'},content=b'bc')
        self.assertEqual(updates.download(self.signed['artifact'],self.root,transport=httpx.MockTransport(handler)).read_bytes(),b'abc')

    def test_ignored_range_restarts_instead_of_appending(self):
        (self.root/(self.signed['artifact']['sha256']+'.part')).write_bytes(b'a')
        target=updates.download(self.signed['artifact'],self.root,transport=httpx.MockTransport(lambda _:httpx.Response(200,content=b'abc')))
        self.assertEqual(target.read_bytes(),b'abc')

    def test_bad_content_range_cannot_corrupt_partial(self):
        partial=self.root/(self.signed['artifact']['sha256']+'.part'); partial.write_bytes(b'a')
        with self.assertRaises(updates.UpdateError):
            updates.download(self.signed['artifact'],self.root,transport=httpx.MockTransport(lambda _:httpx.Response(206,headers={'content-range':'bytes 0-2/3'},content=b'abc')))
        self.assertEqual(partial.read_bytes(),b'a')

    def test_hash_failure_is_quarantined_and_retry_can_succeed(self):
        with self.assertRaises(updates.UpdateError):
            updates.download(self.signed['artifact'],self.root,transport=httpx.MockTransport(lambda _:httpx.Response(200,content=b'bad')))
        self.assertEqual(len(list(self.root.glob('*.rejected-*'))),1)
        target=updates.download(self.signed['artifact'],self.root,transport=httpx.MockTransport(lambda _:httpx.Response(200,content=b'abc')))
        self.assertEqual(target.read_bytes(),b'abc')

    def test_short_download_keeps_partial_for_retry(self):
        with self.assertRaises(updates.UpdateError):
            updates.download(self.signed['artifact'],self.root,transport=httpx.MockTransport(lambda _:httpx.Response(200,content=b'a')))
        self.assertEqual((self.root/(self.signed['artifact']['sha256']+'.part')).read_bytes(),b'a')

    def test_extraction_checks_metadata_and_preserves_existing_version(self):
        archive=self.bundle()
        target=self.root/'version'
        self.assertEqual(updates.extract_package(archive,target,self.signed)['version'],self.signed['version'])
        with self.assertRaises(updates.UpdateError):
            updates.extract_package(archive,target,self.signed)
        self.assertTrue((target/'app'/'VERSION').exists())

    def test_traversal_private_and_windows_special_paths(self):
        for name in ['../escape','app/../escape','app/./hidden','app//hidden','C:/file','app\\evil',
                     'app/NUL.txt','app/file.','app/.env','app/.env.local','userdata/secret','app/__pycache__/x']:
            with self.subTest(name=name), self.assertRaises(updates.UpdateError):
                updates.safe_member(name)

    def test_zip_case_collision_symlink_and_size_mismatch(self):
        for kind in ['collision','symlink','size']:
            archive=self.bundle()
            with zipfile.ZipFile(archive,'a') as z:
                if kind=='collision': z.writestr('app/version','bad')
                if kind=='symlink':
                    info=zipfile.ZipInfo('app/link'); info.external_attr=(stat.S_IFLNK|0o777)<<16
                    z.writestr(info,'../../secret')
            self.signed['artifact']['unpacked_size'] += 100
            with self.subTest(kind=kind), self.assertRaises(updates.UpdateError):
                updates.extract_package(archive,self.root/kind,self.signed)


if __name__=='__main__':
    unittest.main()
