"""Portable release transactions. The supervisor is the only process that installs.

Program versions are immutable. User data is backed up only after the owned server
has stopped; the maintenance gate remains closed until the new server is healthy.
"""
from contextlib import contextmanager, closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time
import uuid

from studio_update_core import (APP_ID, DATA_SCHEMA, UpdateError, atomic_json, read_object as read_json,
                                version, verify_manifest, fetch_manifest, download,
                                extract_package, digest)

MANIFEST_URL = 'https://github.com/344996/deepwhite-studio-collab/releases/latest/download/update-stable.json'
TERMINAL = {'succeeded', 'failed', 'cancelled', 'canceled', 'completed'}


def inside(root, path):
    root, path = Path(root).resolve(), Path(path).resolve()
    if path == root or not path.is_relative_to(root):
        raise UpdateError('更新文件路径超出安装目录。')
    return path


def layout(root):
    root = Path(root).resolve()
    pointer = read_json(root / 'current.json')
    if not isinstance(pointer, dict) or set(pointer) != {'version'}:
        raise UpdateError('当前版本指针无效，请按恢复文档检查安装目录。')
    version(pointer['version'])
    release = inside(root, root / 'versions' / pointer['version'])
    metadata = read_json(release / 'release.json')
    if metadata.get('app') != APP_ID or metadata.get('version') != pointer['version']:
        raise UpdateError('安装版本元数据不匹配。')
    if (release / 'app' / 'VERSION').read_text(encoding='utf-8').strip() != pointer['version']:
        raise UpdateError('安装程序版本不匹配。')
    updates = inside(root, root / 'updates'); updates.mkdir(exist_ok=True)
    runtime = inside(root, root / 'userdata'); runtime.mkdir(exist_ok=True)
    if runtime.is_symlink() or (root / 'userdata').is_symlink():
        raise UpdateError('发行版数据目录不能是符号链接。')
    return root, release, runtime, updates, pointer['version']


@contextmanager
def exclusive(path):
    """An OS-owned lock is released even on process death; its file is retained."""
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        stream.seek(0, 2)
        if not stream.tell(): stream.write(b'0'); stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise UpdateError('安装目录已被另一个启动器或更新任务占用。') from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt': msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else: fcntl.flock(stream, fcntl.LOCK_UN)


def state(root, **values):
    path = Path(root) / 'updates' / 'state.json'
    old = read_json(path) if path.exists() else {}
    old.update(values, updated_at=int(time.time()))
    atomic_json(path, old)
    return old


def tree_manifest(root):
    root = Path(root)
    rows = {}
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            path = Path(directory) / name
            if path.is_symlink() or getattr(path, 'is_junction', lambda:False)():
                raise UpdateError('用户数据包含链接目录；请先将数据迁移到普通目录。')
        for name in files:
            path = Path(directory) / name
            if not path.is_file(): raise UpdateError('数据目录存在特殊文件。')
            rows[path.relative_to(root).as_posix()] = {'size':path.stat().st_size, 'sha256':digest(path)}
    return rows


def require_space(root, *, package=0, unpacked=0, data_copies=2):
    runtime = Path(root) / 'userdata'
    size = sum(v['size'] for v in tree_manifest(runtime).values()) if runtime.exists() else 0
    needed = package + unpacked + size * data_copies + 100 * 1024**2
    if shutil.disk_usage(root).free < needed:
        raise UpdateError('磁盘剩余空间不足以保留下载、旧版本和数据备份。')
    return needed


def busy_jobs(runtime):
    """Fail closed for unresolved paid tasks; never resume or resubmit them here."""
    count = 0
    for directory in ('studio_jobs', 'studio_legacy_tasks'):
        for path in (Path(runtime) / 'data' / directory).glob('*.json'):
            try:
                row = read_json(path, 32 * 1024**2)
            except UpdateError:
                raise UpdateError('有任务记录无法读取，请先检查任务记录再更新。')
            if not isinstance(row,dict) or not isinstance(row.get('status'),str):
                raise UpdateError('任务记录格式不正确，请先检查任务记录再更新。')
            if row.get('status') not in TERMINAL:
                count += 1
    return count


def validate_data(runtime):
    """Read existing project records and SQLite before accepting a new server."""
    runtime=Path(runtime)
    marker=runtime/'data-schema.json'
    if marker.exists():
        schema=read_json(marker)
        if set(schema)!={'schema'} or type(schema['schema']) is not int or schema['schema']!=DATA_SCHEMA:
            raise UpdateError('用户数据版本不受当前程序支持，未启动或迁移。')
    paths=[runtime/'data'/'projects.json']
    paths.extend((runtime/'data'/'canvases').glob('*.json'))
    try:
        for path in paths:
            if path.exists():
                from studio_record_validation import project_index, canvas_record
                with path.open(encoding='utf-8-sig') as stream: value=json.load(stream)
                (project_index if path==paths[0] else canvas_record)(value)
        database=runtime/'data'/'studio-assets'/'index.sqlite3'
        if database.exists():
            with closing(sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)) as connection:
                if connection.execute('PRAGMA quick_check').fetchall()!=[('ok',)]:
                    raise UpdateError('素材索引检查失败，已停止启动；请保留原数据。')
    except (OSError,ValueError,sqlite3.Error) as exc:
        raise UpdateError('项目或素材索引无法完整读取，已保留数据并停止启动。') from exc
    if not marker.exists(): atomic_json(marker,{'schema':DATA_SCHEMA})


def check(root, *, transport=None, now=None):
    root, release, runtime, updates, current = layout(root)
    config_path = release / 'app' / 'update-config.json'
    config = read_json(config_path) if config_path.exists() else {'manifest_url':MANIFEST_URL,'channel':'stable'}
    trust = read_json(release / 'app' / 'update-trust.json')
    highest = read_json(updates/'sequence.json').get('sequence',0) if (updates/'sequence.json').exists() else 0
    envelope = fetch_manifest(config['manifest_url'], transport)
    signed = verify_manifest(envelope, trust, current=current, channel=config.get('channel','stable'), minimum_sequence=highest, now=now)
    atomic_json(updates/'sequence.json', {'sequence':signed['sequence']})
    atomic_json(updates/'available.json', envelope)
    result = state(root, phase='available' if version(signed['version']) > version(current) else 'latest',
                   current_version=current, latest_version=signed['version'], notes=signed['notes'], error=None)
    return result


def verified_available(root, *, now=None):
    root, release, _, updates, current = layout(root)
    envelope = read_json(updates/'available.json')
    config = read_json(release/'app'/'update-config.json') if (release/'app'/'update-config.json').exists() else {}
    highest = read_json(updates/'sequence.json').get('sequence',0) if (updates/'sequence.json').exists() else 0
    return verify_manifest(envelope, read_json(release/'app'/'update-trust.json'), current=current,
                           channel=config.get('channel','stable'), minimum_sequence=highest, now=now)


def prepare(root, *, transport=None, now=None):
    root, _, _, updates, current = layout(root)
    with exclusive(updates/'download.lock'):
        signed = verified_available(root, now=now)
        if version(signed['version']) <= version(current): raise UpdateError('当前已是此版本，无需安装。')
        artifact = signed['artifact']
        require_space(root, package=artifact['size'], unpacked=artifact['unpacked_size'])
        state(root, phase='downloading', bytes=0, total=artifact['size'], error=None)
        last = [0.0]
        def progress(done, total):
            if time.monotonic()-last[0] >= .3 or done == total:
                state(root, bytes=done, total=total); last[0]=time.monotonic()
        archive = download(artifact, updates/'downloads', transport=transport, progress=progress)
        stage = updates/'staged'/artifact['sha256']
        # A previous interrupted extraction is preserved; use a fresh sibling.
        if stage.exists(): stage = stage.with_name(stage.name+'-'+uuid.uuid4().hex)
        state(root, phase='verifying')
        extract_package(archive, stage, signed)
        atomic_json(updates/'prepared.json', {'path':stage.relative_to(root).as_posix(), 'sha256':artifact['sha256'], 'version':signed['version']})
        return state(root, phase='ready', bytes=artifact['size'], total=artifact['size'], latest_version=signed['version'], error=None)


def gate(root, enabled):
    path = Path(root)/'updates'/'maintenance.json'
    if enabled: atomic_json(path, {'active':True,'at':int(time.time())})
    else: path.unlink(missing_ok=True)


def journal(root, value):
    atomic_json(Path(root)/'updates'/'transaction.json', value)
    state(root, phase=value['phase'], operation=value['id'], error=value.get('error'))


def backup_data(root, operation):
    with exclusive(Path(root)/'updates'/'runtime.lock'):
        return _backup_data_locked(root,operation)


def _backup_data_locked(root, operation):
    _, _, runtime, updates, _ = layout(root)
    destination = inside(root, updates/'backups'/operation)
    before = tree_manifest(runtime)
    shutil.copytree(runtime, destination/'userdata', copy_function=shutil.copy2)
    if tree_manifest(destination/'userdata') != before or tree_manifest(runtime) != before:
        raise UpdateError('用户数据在备份时发生变化，已停止安装。')
    atomic_json(destination/'manifest.json', {'schema':DATA_SCHEMA,'files':before,'created_at':int(time.time())})
    return destination


def restore_backup(root, tx):
    with exclusive(Path(root)/'updates'/'runtime.lock'):
        return _restore_backup_locked(root,tx)


def _restore_backup_locked(root, tx):
    root = Path(root).resolve()
    backup = inside(root, root/'updates'/'backups'/tx['id'])
    recorded = read_json(backup/'manifest.json', 64*1024**2)
    if tree_manifest(backup/'userdata') != recorded['files']:
        raise UpdateError('回退备份校验失败；已保留全部目录，请按恢复文档处理。')
    restored = inside(root, root/'updates'/('restoring-'+uuid.uuid4().hex))
    shutil.copytree(backup/'userdata', restored)
    if tree_manifest(restored) != recorded['files']:
        raise UpdateError('恢复副本校验失败。')
    runtime = inside(root, root/'userdata')
    if runtime.exists():
        failed = inside(root, root/'updates'/('failed-data-'+tx['id']+'-'+uuid.uuid4().hex))
        os.replace(runtime, failed)
    os.replace(restored, runtime)


def install(root, stop, start, healthy, *, action='install', now=None):
    """Callbacks refer exclusively to the supervisor's child, never an arbitrary PID."""
    root, old_release, runtime, updates, old_version = layout(root)
    if busy_jobs(runtime): raise UpdateError('有生成任务未完成或状态待核实，请处理后再更新。')
    require_space(root)
    operation = uuid.uuid4().hex
    previous = read_json(updates/'previous.json') if (updates/'previous.json').exists() else None
    if action == 'rollback':
        if not previous: raise UpdateError('没有可回退的上一个版本。')
        new_version = previous['version']; version(new_version)
        if new_version == old_version: raise UpdateError('记录中的回退版本就是当前版本，未执行重复切换。')
        new_release = inside(root, root/'versions'/new_version)
        metadata = read_json(new_release/'release.json')
        if metadata.get('data_schema') != {'read_min':1,'read_max':1,'write':1} or metadata.get('app') != APP_ID:
            raise UpdateError('旧版本无法读取当前数据，不支持保留数据回退。')
    elif action == 'install':
        signed = verified_available(root, now=now)
        if version(signed['version']) <= version(old_version): raise UpdateError('不能重复安装或自动降级。')
        prepared = read_json(updates/'prepared.json')
        if (not isinstance(prepared,dict) or set(prepared)!={'version','sha256','path'}
                or not isinstance(prepared.get('path'),str) or prepared.get('version') != signed['version']
                or prepared.get('sha256') != signed['artifact']['sha256']):
            raise UpdateError('准备好的更新与当前清单不一致，请重新下载。')
        stage = inside(root, root/prepared['path'])
        if not stage.is_relative_to((updates/'staged').resolve()): raise UpdateError('更新暂存目录无效。')
        # Verify ZIP again and extract fresh: mutable staging is never executable input.
        archive = updates/'downloads'/(signed['artifact']['sha256']+'.zip')
        if archive.stat().st_size != signed['artifact']['size'] or digest(archive) != signed['artifact']['sha256']:
            raise UpdateError('暂存更新包已改变，请重新下载。')
        new_version = signed['version']
        candidate = root/'versions'/new_version
        if candidate.is_symlink() or getattr(candidate,'is_junction',lambda:False)():
            raise UpdateError('已有版本目录是链接，已保留原文件并停止安装。')
        new_release = inside(root, candidate)
        require_space(root, unpacked=signed['artifact']['unpacked_size'])
        fresh = updates/'staged'/('install-'+operation)
        extract_package(archive, fresh, signed)
        if new_release.exists():
            # The supervisor, bootstrap or an MCP client can still be using this
            # interpreter after a rollback. Never move or overwrite a version.
            # Compare against a fresh extraction of the verified ZIP, not mutable
            # staging or a locally supplied file inventory.
            if tree_manifest(new_release) != tree_manifest(fresh):
                raise UpdateError('已有版本文件与已验证的更新包不一致，未替换任何文件。'
                                  '请保留安装目录和 userdata，按恢复说明使用新的完整便携包。')
        else:
            new_release.parent.mkdir(exist_ok=True)
            os.replace(fresh, new_release)
    else: raise UpdateError('不支持的更新操作。')
    tx = {'id':operation,'old':old_version,'new':new_version,'action':action,'phase':'stopping','backup_complete':False}
    gate(root, True); journal(root, tx)
    stopped = False
    try:
        stop(); stopped = True
        if busy_jobs(runtime): raise UpdateError('停止前新增了未完成任务，已取消更新。')
        tx['phase']='backing_up'; journal(root,tx)
        backup_data(root,operation)
        tx.update(phase='switching',backup_complete=True); journal(root,tx)
        atomic_json(root/'current.json', {'version':new_version})
        tx['phase']='validating'; journal(root,tx)
        start(new_version)
        if not healthy(new_version): raise UpdateError('新版本启动检查失败。')
        # Once committed, later launches MUST NOT restore the older data snapshot.
        atomic_json(updates/'previous.json', {'version':old_version})
        tx['phase']='committed'; journal(root,tx)
        gate(root,False)
        return state(root, phase='installed' if action=='install' else 'rolled_back', current_version=new_version,
                     latest_version=new_version, error=None, backup=operation)
    except Exception as exc:
        if tx['phase'] == 'committed':
            # Writes may already have resumed: never restore a pre-update snapshot.
            raise UpdateError('新版本已提交，清理维护状态失败；重启启动器可继续，不能覆盖当前数据。') from exc
        if stopped:
            stop()
            if tx['backup_complete']: restore_backup(root,tx)
            atomic_json(root/'current.json',{'version':old_version})
            if previous is not None: atomic_json(updates/'previous.json',previous)
            else: (updates/'previous.json').unlink(missing_ok=True)
            start(old_version)
            if not healthy(old_version):
                tx.update(phase='recovery_required',error='旧版本启动失败，数据与版本备份均已保留。'); journal(root,tx)
                raise UpdateError(tx['error']) from exc
        tx.update(phase='reverted',error=str(exc) if isinstance(exc,UpdateError) else '更新未完成，已恢复原版本；详情请查看本机启动日志。')
        journal(root,tx); gate(root,False)
        return state(root,phase='rolled_back',current_version=old_version,error=tx['error'],backup=operation if tx['backup_complete'] else None)


def recover(root):
    """Called under the supervisor lock AFTER ensuring its former child has exited."""
    with exclusive(Path(root)/'updates'/'runtime.lock'):
        return _recover_locked(root)


def validate_transaction(tx,current):
    required={'id','old','new','action','phase','backup_complete'}
    phases={'stopping','backing_up','switching','validating','committed','reverted','recovery_required'}
    if (not isinstance(tx,dict) or not required.issubset(tx) or set(tx)-required-{'error'}
            or tx.get('phase') not in phases or tx.get('action') not in ('install','rollback')
            or type(tx.get('backup_complete')) is not bool):
        raise UpdateError('更新事务格式或阶段不受支持，已保留维护状态和全部数据。')
    version(tx['old']); version(tx['new'])
    if (tx['old']==tx['new'] or current not in (tx['old'],tx['new'])
            or not isinstance(tx['id'],str) or len(tx['id'])!=32 or any(c not in '0123456789abcdef' for c in tx['id'])):
        raise UpdateError('更新事务版本或编号不匹配，拒绝自动恢复。')
    if (tx['phase'] in ('stopping','backing_up','reverted') and current!=tx['old']
            or tx['phase'] in ('validating','committed') and current!=tx['new']
            or tx['phase'] in ('switching','validating','committed') and not tx['backup_complete']):
        raise UpdateError('更新事务与当前安装状态矛盾，拒绝自动恢复。')
    return tx


def _recover_locked(root):
    root, _, _, updates, current = layout(root)
    path = updates/'transaction.json'
    if not path.exists():
        # Gate before request/transaction was durable: no program/data change occurred.
        gate(root,False); return
    gate(root,True)
    tx = validate_transaction(read_json(path),current)
    if tx['phase'] in ('committed','reverted'):
        gate(root,False); return
    if tx['backup_complete']: _restore_backup_locked(root,tx)
    atomic_json(root/'current.json',{'version':tx['old']})
    tx.update(phase='reverted',error='上次更新被中断，启动器已恢复原版本。'); journal(root,tx)
    gate(root,False)
