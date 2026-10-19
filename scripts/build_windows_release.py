"""Build Windows releases from committed source and verified binary distributions.

Preparation: python scripts/build_windows_release.py --cache PATH --prepare-only
Release: add --output NEW_DIR --private-key EXTERNAL_PEM --key-id ID --sequence N.
No system site-packages are copied. Runtime downloads and wheels are hash-checked
against Python.org and PyPI, then installed into an isolated embedded interpreter.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
import email.parser
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
from urllib.request import Request, urlopen
import uuid
import zipfile

from sign_release import canonical, external_key_path, public_key, sign_manifest

ROOT = Path(__file__).resolve().parents[1]
PYTHON_VERSION = '3.13.16'
PYTHON_URL = 'https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip'
PYTHON_SHA256 = '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297'
PYTHON_RELEASE_PAGE = 'https://www.python.org/downloads/release/python-31316/'
FORBIDDEN = {'.git', '.venv', 'venv', 'workspace', 'userdata', 'private', '__pycache__',
             'logs', 'test-output', '.test-runtime', 'release-secrets'}
VERSION_PATTERN = r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-studio\.(0|[1-9]\d*)'
PRIVATE_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.jks'}
PUBLIC_RUNTIME_CERTIFICATES = {'python/lib/site-packages/certifi/cacert.pem'}


class BuildError(Exception):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def package_name(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def parse_lock(path):
    result = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9][A-Za-z0-9_.+!-]*)', line)
        if not match or package_name(match[1]) in result:
            raise BuildError('The runtime lock must contain unique package==version pins only.')
        result[package_name(match[1])] = match[2]
    if not result:
        raise BuildError('The runtime lock is empty.')
    return result


def forbidden(path):
    parts = PurePosixPath(path).parts
    return any(part.lower() in FORBIDDEN or part.lower() == '.env' or
        part.lower().startswith('.env.') for part in parts) or path.lower().endswith(('.pyc', '.pyo', '.log', '.db', '.sqlite', '.sqlite3')) or (
        PurePosixPath(path).suffix.lower() in PRIVATE_SUFFIXES and path.lower() not in PUBLIC_RUNTIME_CERTIFICATES) or (
        PurePosixPath(path).name.lower() in {'key.env', 'global_config.json'})


def committed_sources(repo, ref):
    archive = subprocess.check_output(['git', '-C', str(repo), 'archive', '--format=tar', ref])
    result = {}
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        for entry in stream.getmembers():
            if entry.isfile() and PurePosixPath(entry.name).suffix.lower() in PRIVATE_SUFFIXES:
                raise BuildError('Source commit contains a possible private key: ' + entry.name)
            if forbidden(entry.name) or entry.isdir():
                continue
            if not entry.isfile() or PurePosixPath(entry.name).is_absolute() or '..' in PurePosixPath(entry.name).parts:
                raise BuildError('Source archive contains a non-regular or unsafe path.')
            content = stream.extractfile(entry).read()
            if re.search(rb'(?m)^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\r?$', content):
                raise BuildError('Source commit contains a PEM private key header: ' + entry.name)
            result[entry.name] = content
    return result


def download(url, target, expected_hash=None, max_bytes=128 * 1024 * 1024):
    target = Path(target)
    if target.exists():
        if expected_hash and sha256(target) != expected_hash:
            raise BuildError('Cached download has the wrong digest; preserve it and use a fresh cache: ' + target.name)
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + '.part-' + uuid.uuid4().hex)
    with urlopen(Request(url, headers={'User-Agent': 'DeepWhite-release-builder/1'}), timeout=45) as response, partial.open('xb') as stream:
        size = 0
        while block := response.read(256 * 1024):
            size += len(block)
            if size > max_bytes:
                raise BuildError('Download exceeds the size limit: ' + target.name)
            stream.write(block)
    if expected_hash and sha256(partial) != expected_hash:
        raise BuildError('Download digest does not match the official source; partial retained: ' + partial.name)
    os.replace(partial, target)
    return target


def wheel_metadata(path):
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if name.endswith('.dist-info/METADATA')]
        if len(names) != 1:
            raise BuildError('Wheel metadata is missing or ambiguous: ' + path.name)
        return email.parser.Parser().parsestr(archive.read(names[0]).decode('utf-8'))


def check_dependencies(metadata, pins):
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement
    environment = dict(default_environment(), python_version='3.13', python_full_version=PYTHON_VERSION,
        os_name='nt', sys_platform='win32', platform_system='Windows', platform_machine='AMD64', extra='')
    for info in metadata:
        for value in info.get_all('Requires-Dist', []):
            requirement = Requirement(value)
            if requirement.marker and not requirement.marker.evaluate(environment):
                continue
            name = package_name(requirement.name)
            if name not in pins or not requirement.specifier.contains(pins[name], prereleases=True):
                raise BuildError(f'Lock is incomplete for Python {PYTHON_VERSION}: {info["Name"]} requires {requirement}.')


def verify_wheels(directory, pins):
    paths = sorted(Path(directory).glob('*.whl'))
    metadata = [wheel_metadata(path) for path in paths]
    found = {package_name(info['Name']): info['Version'] for info in metadata}
    if found != pins or len(paths) != len(pins):
        raise BuildError('Wheel set does not exactly match the lock.')
    check_dependencies(metadata, pins)

    def verify(item):
        path, info = item
        url = f'https://pypi.org/pypi/{package_name(info["Name"])}/{info["Version"]}/json'
        with urlopen(url, timeout=30) as response:
            release = json.load(response)
        row = next((row for row in release['urls'] if row['filename'] == path.name), None)
        if (not row or not row['url'].startswith('https://files.pythonhosted.org/') or
                row['digests']['sha256'] != sha256(path) or row['size'] != path.stat().st_size):
            raise BuildError('Wheel does not match its published PyPI digest: ' + path.name)
        return {'package': package_name(info['Name']), 'version': info['Version'], 'file': path.name,
                'url': row['url'], 'sha256': row['digests']['sha256'], 'size': row['size']}
    with ThreadPoolExecutor(max_workers=6) as workers:
        return list(workers.map(verify, zip(paths, metadata)))


def prepare(lock, cache):
    cache = Path(cache).resolve()
    pins = parse_lock(lock)
    lock_hash = sha256(lock)
    wheels = cache / ('wheels-' + lock_hash[:16])
    wheels.mkdir(parents=True, exist_ok=True)
    runtime = download(PYTHON_URL, cache / Path(PYTHON_URL).name, PYTHON_SHA256)
    subprocess.run([sys.executable, '-m', 'pip', '--isolated', 'download', '--disable-pip-version-check',
        '--index-url', 'https://pypi.org/simple', '--only-binary=:all:', '--no-deps',
        '--python-version', '3.13', '--implementation', 'cp', '--abi', 'cp313', '--platform', 'win_amd64',
        '--dest', str(wheels), '-r', str(lock)], check=True)
    inventory = verify_wheels(wheels, pins)
    provenance = {'python': {'version': PYTHON_VERSION, 'url': PYTHON_URL, 'sha256': PYTHON_SHA256,
        'source_page': PYTHON_RELEASE_PAGE}, 'requirements_sha256': lock_hash, 'wheels': inventory}
    (cache / ('provenance-' + lock_hash[:16] + '.json')).write_bytes(canonical(provenance))
    return runtime, wheels, provenance


def extract_runtime(archive, target, expected_hash=PYTHON_SHA256):
    if sha256(archive) != expected_hash:
        raise BuildError('Embedded Python SHA-256 does not match Python.org.')
    target = Path(target)
    target.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(archive) as bundle:
        for item in bundle.infolist():
            path = PurePosixPath(item.filename)
            if (path.is_absolute() or '..' in path.parts or '\\' in item.filename or ':' in item.filename
                    or stat.S_ISLNK(item.external_attr >> 16)):
                raise BuildError('Embedded runtime contains an unsafe path.')
        bundle.extractall(target)
    (target / 'python313._pth').write_text('python313.zip\n.\nLib/site-packages\n../app\nimport site\n', encoding='utf-8')


def install_runtime(archive, wheels, lock, target):
    extract_runtime(archive, target)
    site_packages = target / 'Lib' / 'site-packages'
    subprocess.run([sys.executable, '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
        '--no-index', '--no-deps', '--no-compile', '--only-binary=:all:',
        '--python-version', '3.13', '--implementation', 'cp', '--abi', 'cp313', '--platform', 'win_amd64',
        '--find-links', str(wheels), '--target', str(site_packages), '-r', str(lock)], check=True)
    removed_scripts = strip_host_entrypoints(site_packages)
    code = ('import sys,ssl,sqlite3,fastapi,pydantic,pydantic_core,uvicorn,httpx,requests,psutil,websockets;'
            'from PIL import Image;from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey;'
            'assert sys.version_info[:3]==(3,13,16);assert sys.flags.isolated;'
            'assert all("site-packages" not in p or p.startswith(sys.prefix) for p in sys.path);'
            'print(sys.version);print("Bundled runtime imports passed")')
    subprocess.run([str(target / 'python.exe'), '-I', '-B', '-c', code], check=True)
    return removed_scripts


def strip_host_entrypoints(site_packages):
    """Omit optional pip-generated console wrappers that embed the build Python.

    Studio invokes modules with its bundled python.exe. Package code, metadata
    and licenses remain; only unused generated CLI wrappers/RECORD rows leave.
    """
    site_packages = Path(site_packages).resolve()
    scripts = site_packages / 'bin'
    if not scripts.exists():
        return []
    if scripts.is_symlink() or not scripts.resolve().is_relative_to(site_packages):
        raise BuildError('Unexpected linked scripts directory in runtime staging.')
    files = list(scripts.iterdir())
    if any(path.is_symlink() or not path.is_file() for path in files):
        raise BuildError('Unexpected entry in generated scripts directory.')
    removed = sorted(path.name for path in files)
    records = []
    for record in site_packages.glob('*.dist-info/RECORD'):
        with record.open(newline='', encoding='utf-8') as stream:
            rows = list(csv.reader(stream))
        kept = [row for row in rows if not (row and row[0].startswith('../../bin/')
                    and row[0][len('../../bin/'):] in removed)]
        if kept != rows:
            records.append((record, kept))
    for path in files:
        path.unlink()
    scripts.rmdir()
    for record, rows in records:
        with record.open('w', newline='', encoding='utf-8') as stream:
            csv.writer(stream, lineterminator='\n').writerows(rows)
    return removed


def release_metadata(version, commit):
    if not re.fullmatch(VERSION_PATTERN, version) or not re.fullmatch('[a-f0-9]{40}', commit):
        raise BuildError('Invalid release version or commit.')
    return {'app': 'deepwhite-studio', 'version': version, 'platform': 'windows-x64',
        'data_schema': {'read_min': 1, 'read_max': 1, 'write': 1}, 'min_bootstrap': 1, 'commit': commit}


def manifest_metadata(release, artifact, unpacked_size, *, sequence, artifact_url, notes,
                      issued_at=None, expires_days=90):
    issued_at = int(time.time()) if issued_at is None else issued_at
    if not 1 <= expires_days <= 93 or type(sequence) is not int or sequence < 1:
        raise BuildError('Invalid release expiry or sequence.')
    return {'schema': 'deepwhite.update.v1', **release, 'channel': 'stable', 'sequence': sequence,
        'issued_at': issued_at, 'expires_at': issued_at + expires_days * 86400, 'notes': notes,
        'artifact': {'url': artifact_url, 'size': Path(artifact).stat().st_size,
                     'sha256': sha256(artifact), 'unpacked_size': unpacked_size}}


def write_zip(tree, output, timestamp, empty_directories=()):
    tree = Path(tree)
    total = 0
    stamp = time.gmtime(max(315532800, timestamp))[:6]
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(tree.rglob('*')):
            if path.is_symlink():
                raise BuildError('Refusing to package a symlink.')
            if not path.is_file():
                continue
            relative = path.relative_to(tree).as_posix()
            item = zipfile.ZipInfo(relative, stamp)
            item.external_attr = (stat.S_IFREG | 0o644) << 16
            item.compress_type = zipfile.ZIP_DEFLATED
            with path.open('rb') as source, archive.open(item, 'w') as destination:
                shutil.copyfileobj(source, destination, 1024 * 1024)
            total += path.stat().st_size
        for name in empty_directories:
            item = zipfile.ZipInfo(name.rstrip('/') + '/', stamp)
            item.external_attr = (stat.S_IFDIR | 0o755) << 16
            archive.writestr(item, b'')
    return total


def build_release(repo, ref, cache, output, private_key, key_id, sequence, notes, artifact_url=None):
    repo, cache, output = Path(repo).resolve(), Path(cache).resolve(), Path(output).resolve()
    external_key_path(private_key, (repo, cache, output))
    commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', ref + '^{commit}'], text=True).strip()
    timestamp = int(subprocess.check_output(['git', '-C', str(repo), 'show', '-s', '--format=%ct', commit], text=True))
    sources = committed_sources(repo, commit)
    required = ['app/VERSION', 'app/studio_server.py', 'app/studio_portable.py', 'app/update-trust.json',
                'app/LICENSE', 'README.md', 'requirements.lock.txt', 'portable/launcher.py',
                'portable/Start.cmd', 'portable/Start.ps1', 'portable/README.md']
    if any(path not in sources for path in required):
        raise BuildError('Commit is incomplete; required portable/update files must be committed before building.')
    version = sources['app/VERSION'].decode('utf-8').strip()
    release = release_metadata(version, commit)
    trust = json.loads(sources['app/update-trust.json'])
    if trust.get(key_id) != public_key(private_key, key_id)[key_id]:
        raise BuildError('Signing key does not match the committed update trust file.')
    if output.exists() and any(output.iterdir()):
        raise BuildError('Release output must be a new or empty directory; previous artifacts are preserved.')
    output.mkdir(parents=True, exist_ok=True)
    staging = cache / ('stage-' + version + '-' + uuid.uuid4().hex[:8])
    portable = staging / 'portable'
    version_tree = portable / 'versions' / version
    version_tree.mkdir(parents=True)
    for path, content in sources.items():
        if path.startswith('app/'):
            target = version_tree / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
    (version_tree / 'LICENSE').write_bytes(sources['app/LICENSE'])
    (version_tree / 'README.md').write_bytes(sources['README.md'])
    references = version_tree / 'references'
    references.mkdir()
    lock = references / 'requirements.lock.txt'
    lock.write_bytes(sources['requirements.lock.txt'])
    runtime, wheels, provenance = prepare(lock, cache)
    removed_scripts = install_runtime(runtime, wheels, lock, version_tree / 'python')
    provenance['omitted_generated_console_scripts'] = removed_scripts
    provenance.update(commit=commit, source_files={path: hashlib.sha256(content).hexdigest()
        for path, content in sources.items() if path.startswith('app/')})
    (references / 'build-provenance.json').write_bytes(canonical(provenance))
    (version_tree / 'release.json').write_bytes(canonical(release))
    for path in version_tree.rglob('*'):
        if path.is_file() and forbidden(path.relative_to(version_tree).as_posix()):
            raise BuildError('Unexpected runtime/private file in staged version: ' + path.name)
    for name in ('launcher.py', 'Start.cmd', 'Start.ps1', 'README.md'):
        data = sources['portable/' + name]
        if name.endswith(('.cmd', '.ps1')):
            data = data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
        (portable / name).write_bytes(data)
    (portable / 'current.json').write_bytes(canonical({'version': version}))
    version_zip = output / ('deepwhite-' + version + '-windows-x64-version.zip')
    unpacked_size = write_zip(version_tree, version_zip, timestamp)
    artifact_url = artifact_url or ('https://github.com/344996/deepwhite-studio-collab/releases/download/v' + version + '/' + version_zip.name)
    signed = manifest_metadata(release, version_zip, unpacked_size, sequence=sequence,
        artifact_url=artifact_url, notes=notes)
    envelope = sign_manifest(signed, private_key, key_id)
    (output / 'update-stable.json').write_bytes(canonical(envelope))
    # Validate with exactly the shipped interpreter and verifier, without
    # creating bytecode in the staged release or reusing build-host imports.
    verification = ('import json,sys;from pathlib import Path;from studio_update_core import verify_manifest;'
        'verify_manifest(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")),'
        'json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")),current=sys.argv[3]);'
        'print("Bundled update signature verification passed")')
    subprocess.run([str(version_tree / 'python' / 'python.exe'), '-I', '-B', '-c', verification,
        str(output / 'update-stable.json'), str(version_tree / 'app' / 'update-trust.json'), version], check=True)
    portable_zip = output / ('deepwhite-' + version + '-windows-x64-portable.zip')
    write_zip(portable, portable_zip, timestamp, empty_directories=('userdata', 'updates'))
    artifacts = [version_zip, portable_zip, output / 'update-stable.json']
    (output / 'SHA256SUMS.txt').write_text(''.join(sha256(path) + '  ' + path.name + '\n' for path in artifacts), encoding='utf-8')
    report = {'version': version, 'commit': commit, 'stage': str(staging), 'files': {
        path.name: {'size': path.stat().st_size, 'sha256': sha256(path)} for path in artifacts},
        'unpacked_size': unpacked_size, 'python': provenance['python'], 'wheel_count': len(provenance['wheels'])}
    (output / 'build-report.json').write_bytes(canonical(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--ref', default='HEAD')
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--private-key', type=Path)
    parser.add_argument('--key-id')
    parser.add_argument('--sequence', type=int)
    parser.add_argument('--notes-file', type=Path)
    parser.add_argument('--artifact-url')
    args = parser.parse_args()
    if args.prepare_only:
        _, _, provenance = prepare(args.repo / 'requirements.lock.txt', args.cache)
        print(json.dumps({'python': PYTHON_VERSION, 'wheels_verified': len(provenance['wheels'])}))
        return
    if not all((args.output, args.private_key, args.key_id, args.sequence, args.notes_file)):
        parser.error('A release requires --output, --private-key, --key-id, --sequence and --notes-file.')
    report = build_release(args.repo, args.ref, args.cache, args.output, args.private_key, args.key_id,
        args.sequence, args.notes_file.read_text(encoding='utf-8'), args.artifact_url)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
