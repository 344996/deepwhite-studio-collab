"""Signed update metadata, bounded HTTPS downloads and safe version-package extraction.

No application imports: also used by the standalone updater after the server exits.
"""
from contextlib import contextmanager
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time
from urllib.parse import urljoin, urlsplit
import uuid
import zipfile

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
import httpx

APP_ID = 'deepwhite-studio'
BOOTSTRAP_VERSION = 1
DATA_SCHEMA = 1
MAX_MANIFEST = 256 * 1024
MAX_PACKAGE = 2 * 1024**3
MAX_UNPACKED = 6 * 1024**3
RELEASE_PREFIX = '/344996/deepwhite-studio-collab/releases/'
HOSTS = {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'}


class UpdateError(Exception):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('xb') as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_json(path, limit=MAX_MANIFEST):
    path = Path(path)
    try:
        if path.stat().st_size > limit:
            raise UpdateError('更新记录超过大小限制。')
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise UpdateError('更新记录无法读取；请保留文件并查看恢复说明。') from exc


def read_object(path, limit=MAX_MANIFEST):
    value=read_json(path,limit)
    if not isinstance(value,dict): raise UpdateError('更新记录必须是 JSON 对象。')
    return value


def version(value):
    if not isinstance(value, str):
        raise UpdateError('不支持此版本编号。')
    match = re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-studio\.(0|[1-9]\d*)', str(value))
    if not match or len(value) > 60:
        raise UpdateError('不支持此版本编号。')
    return tuple(int(v) for v in match.groups())


def trusted_url(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 33 for c in value) or '\\' in value:
        raise UpdateError('更新下载地址无效。')
    try:
        parts = urlsplit(value)
        if parts.port not in (None, 443):
            raise ValueError()
    except ValueError as exc:
        raise UpdateError('更新下载地址无效。') from exc
    if parts.scheme != 'https' or parts.hostname not in HOSTS or parts.username or parts.password or parts.fragment:
        raise UpdateError('更新仅允许受支持的 HTTPS 发布地址。')
    if parts.hostname == 'github.com' and not parts.path.startswith(RELEASE_PREFIX):
        raise UpdateError('更新必须来自 344996 的画布发布仓库。')
    if parts.hostname == 'raw.githubusercontent.com' and not parts.path.startswith('/344996/deepwhite-studio-collab/'):
        raise UpdateError('更新清单仓库不匹配。')
    return value


def _integer(value, low, high):
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def verify_manifest(envelope, trust, *, current, channel='stable', minimum_sequence=0, now=None):
    now = int(time.time() if now is None else now)
    if not isinstance(trust,dict) or not trust or not _integer(minimum_sequence,0,2**53):
        raise UpdateError('本机更新信任配置或清单序号不正确。')
    if not isinstance(envelope, dict) or set(envelope) != {'signed', 'signatures'}:
        raise UpdateError('更新清单格式不正确。')
    signed, signatures = envelope['signed'], envelope['signatures']
    if not isinstance(signed, dict) or not isinstance(signatures, list) or not 1 <= len(signatures) <= 8:
        raise UpdateError('更新签名格式不正确。')
    try:
        payload = canonical(signed)
    except (ValueError, TypeError) as exc:
        raise UpdateError('更新清单格式不正确。') from exc
    verified = False
    for item in signatures:
        if not isinstance(item, dict) or not isinstance(item.get('key_id'),str) or item['key_id'] not in trust:
            continue
        try:
            key = Ed25519PublicKey.from_public_bytes(base64.b64decode(trust[item['key_id']], validate=True))
            key.verify(base64.b64decode(item.get('signature', ''), validate=True), payload)
            verified = True
            break
        except (ValueError, TypeError, InvalidSignature):
            continue
    if not verified:
        raise UpdateError('更新签名验证失败；未下载或执行更新。')
    fields = {'schema', 'app', 'version', 'channel', 'platform', 'sequence', 'issued_at', 'expires_at',
              'min_bootstrap', 'data_schema', 'commit', 'notes', 'artifact'}
    if set(signed) != fields or signed.get('schema') != 'deepwhite.update.v1' or signed.get('app') != APP_ID:
        raise UpdateError('更新清单属于其他应用或不支持的协议。')
    if signed['channel'] != channel or signed['platform'] != 'windows-x64':
        raise UpdateError('更新通道或系统架构不匹配。')
    if version(signed['version']) < version(current):
        raise UpdateError('发布清单版本倒退，已拒绝自动降级。')
    if not _integer(signed['sequence'], 1, 2**53) or signed['sequence'] < minimum_sequence:
        raise UpdateError('更新清单序号已过期，已拒绝重放。')
    if (not _integer(signed['issued_at'], 1, 2**53) or not _integer(signed['expires_at'], 1, 2**53)
            or signed['issued_at'] > now + 600 or signed['expires_at'] <= now
            or not 0 < signed['expires_at'] - signed['issued_at'] <= 93 * 86400):
        raise UpdateError('更新清单尚未生效或已过期，请检查系统时间。')
    if not _integer(signed['min_bootstrap'], 1, BOOTSTRAP_VERSION):
        raise UpdateError('此更新需要新版启动器，请下载完整发行包。')
    schema = signed['data_schema']
    if (not isinstance(schema, dict) or set(schema) != {'read_min', 'read_max', 'write'}
            or any(not _integer(v, DATA_SCHEMA, DATA_SCHEMA) for v in schema.values())):
        raise UpdateError('此更新的数据版本尚不能安全迁移，请使用经过验证的迁移包。')
    if not isinstance(signed['commit'], str) or not re.fullmatch('[a-f0-9]{40}', signed['commit']):
        raise UpdateError('更新缺少构建来源。')
    if not isinstance(signed['notes'], str) or len(signed['notes']) > 8000:
        raise UpdateError('更新说明格式无效。')
    artifact = signed['artifact']
    if not isinstance(artifact, dict) or set(artifact) != {'url', 'size', 'sha256', 'unpacked_size'}:
        raise UpdateError('更新包信息无效。')
    if not _integer(artifact['size'], 1, MAX_PACKAGE) or not _integer(artifact['unpacked_size'], 1, MAX_UNPACKED):
        raise UpdateError('更新包超过支持的大小。')
    if not isinstance(artifact['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', artifact['sha256']):
        raise UpdateError('更新包校验值无效。')
    trusted_url(artifact['url'])
    return signed


@contextmanager
def response_stream(client, url, headers=None):
    """Follow only bounded trusted redirects; never forward user API credentials."""
    for _ in range(5):
        url = trusted_url(url)
        with client.stream('GET', url, headers=headers or {}) as response:
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get('location')
                if not location:
                    raise UpdateError('更新下载重定向无效。')
                url = urljoin(url, location)
                continue
            yield response
            return
    raise UpdateError('更新下载重定向次数过多。')


def client(transport=None):
    return httpx.Client(timeout=httpx.Timeout(60, connect=15), follow_redirects=False, trust_env=False, transport=transport)


def fetch_manifest(url, transport=None):
    try:
        with client(transport) as session, response_stream(session, url) as response:
            if response.status_code == 404:
                raise UpdateError('发布仓库尚未提供此通道的更新清单。')
            if response.status_code != 200:
                raise UpdateError('更新服务器暂时不可用，请稍后重试。')
            data = bytearray()
            for block in response.iter_bytes(16384):
                if len(data) + len(block) > MAX_MANIFEST:
                    raise UpdateError('更新清单超过大小限制。')
                data.extend(block)
        return json.loads(data)
    except (httpx.HTTPError, ValueError) as exc:
        raise UpdateError('无法读取更新清单，请检查网络后重试。') from exc


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def download(artifact, directory, *, transport=None, progress=None):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (artifact['sha256'] + '.zip')
    if target.exists() and target.stat().st_size == artifact['size'] and digest(target) == artifact['sha256']:
        return target
    partial = target.with_suffix('.part')
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > artifact['size']:
        raise UpdateError('暂存包大小异常，请保留诊断文件并重新检查更新。')
    try:
        if offset < artifact['size']:
            headers = {'Range': 'bytes=' + str(offset) + '-'} if offset else {}
            with client(transport) as session, response_stream(session, artifact['url'], headers) as response:
                if response.status_code not in (200, 206):
                    raise UpdateError('下载中断，可重新尝试继续下载。')
                if response.status_code == 206:
                    match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('content-range', ''))
                    if not match or int(match[1]) != offset or int(match[3]) != artifact['size'] or int(match[2]) != artifact['size'] - 1:
                        raise UpdateError('服务器的续传响应无效。')
                else:
                    offset = 0
                with partial.open('ab' if offset else 'wb') as stream:
                    for block in response.iter_bytes(256 * 1024):
                        if offset + len(block) > artifact['size']:
                            raise UpdateError('下载内容超过清单大小。')
                        stream.write(block)
                        offset += len(block)
                        if progress:
                            progress(offset, artifact['size'])
                    stream.flush()
                    os.fsync(stream.fileno())
        if offset != artifact['size']:
            raise UpdateError('下载尚未完成，已保留暂存文件以便继续下载。')
        if digest(partial) != artifact['sha256']:
            os.replace(partial, partial.with_name(partial.name + '.rejected-' + uuid.uuid4().hex))
            raise UpdateError('更新包长度或校验值不匹配，未安装。')
        os.replace(partial, target)
        return target
    except httpx.HTTPError as exc:
        raise UpdateError('下载中断，已保留暂存文件以便重试。') from exc


def safe_member(name):
    if not isinstance(name, str) or '\\' in name or name.startswith('/') or len(name) > 240:
        raise UpdateError('更新包包含无效文件路径。')
    parts = tuple(name.removesuffix('/').split('/'))
    if not parts or any(p in ('', '.', '..') or ':' in p or p.endswith((' ', '.')) or any(ord(c) < 32 for c in p)
                        or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', p, re.I) for p in parts):
        raise UpdateError('更新包包含越界或不支持的文件路径。')
    if parts[0] not in ('app', 'python', 'references', 'release.json', 'LICENSE', 'README.md'):
        raise UpdateError('更新包包含未允许的顶层目录。')
    if any(p.lower() in ('.git', '.env', 'workspace', 'userdata', 'private', '__pycache__')
           or p.lower().startswith('.env.') for p in parts):
        raise UpdateError('更新包包含用户数据或私有文件目录。')
    return parts


def extract_package(archive, target, signed):
    target = Path(target)
    if target.exists():
        raise UpdateError('解压目标已存在，已停止以保留原文件。')
    target.mkdir(parents=True)
    seen, total = set(), 0
    try:
        with zipfile.ZipFile(archive) as bundle:
            entries = bundle.infolist()
            if len(entries) > 50000:
                raise UpdateError('更新包文件数超过上限。')
            for entry in entries:
                parts = safe_member(entry.filename)
                key = '/'.join(parts).casefold()
                mode = entry.external_attr >> 16
                if key in seen or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                    raise UpdateError('更新包包含重复路径或特殊链接。')
                seen.add(key)
                total += entry.file_size
                if total > signed['artifact']['unpacked_size'] or total > MAX_UNPACKED:
                    raise UpdateError('更新包解压大小超出清单。')
                destination = target.joinpath(*parts)
                if not destination.resolve().is_relative_to(target.resolve()):
                    raise UpdateError('更新包路径越界。')
                if entry.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, destination.open('xb') as output:
                    while block := source.read(256 * 1024):
                        output.write(block)
        if total != signed['artifact']['unpacked_size']:
            raise UpdateError('更新包解压大小与清单不一致。')
        release = read_json(target / 'release.json')
        expected = {'app': APP_ID, 'version': signed['version'], 'platform': signed['platform'],
                    'data_schema': signed['data_schema'], 'min_bootstrap': signed['min_bootstrap'], 'commit': signed['commit']}
        if release != expected or (target / 'app' / 'VERSION').read_text(encoding='utf-8').strip() != signed['version']:
            raise UpdateError('包内版本与签名清单不一致。')
        for name in ('app/studio_server.py', 'app/studio_portable.py', 'python/python.exe'):
            if not (target / name).is_file():
                raise UpdateError('更新包缺少启动文件。')
        return release
    except (zipfile.BadZipFile, OSError, ValueError, RuntimeError) as exc:
        raise UpdateError('更新包无法完整解压，当前版本保持不变。') from exc
