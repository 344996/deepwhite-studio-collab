"""Durable receipts for legacy canvas workers; never resubmit during reads.

The payload fingerprint and worker claim are persisted before execution. Receipt
hooks are task-local (also propagated by asyncio.to_thread), not global callbacks.
Recovery is deliberately a ledger read: provider-specific replay is not implied.
"""
import contextvars
import hashlib
import json
import os
import re
import threading
import time
import uuid
import urllib.parse
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

_LOCK = threading.RLock()
_ACTIVE = set()
_VOLATILE = {}
_CONTEXT = contextvars.ContextVar('legacy_canvas_receipt', default=None)
_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,160}$')


def directory():
    import main as core
    path = Path(core.DATA_DIR) / 'studio_legacy_tasks'
    path.mkdir(parents=True, exist_ok=True)
    return path


def validate_id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise HTTPException(400, '任务请求编号格式无效')
    return value


def task_identity(kind, request_id):
    validate_id(request_id)
    prefixes = {'image': 'canvas_img_', 'comfy': 'canvas_comfy_',
                'llm': 'canvas_llm_', 'video': 'canvas_video_'}
    if kind not in prefixes:
        raise HTTPException(400, '任务类型无效')
    prefix = prefixes[kind]
    return prefix + hashlib.sha256((kind + ':' + request_id).encode()).hexdigest()


def _key(task_id):
    validate_id(task_id)
    return str(directory()), task_id


@contextmanager
def _disk_lock():
    # Separate processes must share the same create/claim critical section.
    with _LOCK:
        path = directory() / '.ledger.lock'
        with path.open('a+b') as fh:
            fh.seek(0, 2)
            if not fh.tell():
                fh.write(b'0'); fh.flush()
            fh.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fh.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _write(record):
    """Atomic, flushed writes. Never publish a half-written task."""
    path = directory() / (validate_id(record['id']) + '.json')
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as fh:
            json.dump(record, fh, ensure_ascii=False, allow_nan=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def _read(task_id):
    key = _key(task_id)
    path = directory() / (task_id + '.json')
    try:
        record = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None
    except (ValueError, OSError) as exc:
        raise HTTPException(503, '任务账本无法读取，请核对原任务，勿重新提交') from exc
    if record.get('id') != task_id:
        raise HTTPException(503, '任务账本身份不一致')
    return _VOLATILE.get(key, record)


def safe_error_detail(detail):
    """Keep failure reasons while excluding credentials and exception URLs."""
    sensitive = {'authorization', 'apikey', 'xapikey', 'xgoogapikey', 'accesstoken',
                 'refreshtoken', 'token', 'secret', 'password'}

    def clean(value):
        if isinstance(value, dict):
            return {key: '[已隐藏]' if re.sub(r'[^a-z0-9]', '', str(key).lower()) in sensitive
                    else clean(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [clean(item) for item in value]
        if not isinstance(value, str):
            return value
        text = re.sub(r'\b(?:https?|wss?)://[^\s<>"\']+', '[链接已隐藏]', value, flags=re.I)
        # Structured details sometimes arrive already serialized by an upstream.
        text = re.sub(r'''((?:["'])(?:authorization|api[-_]?key|x-api-key|x-goog-api-key|access[-_]?token|refresh[-_]?token|token|secret|password)["']\s*:\s*)(["'])(.*?)\2''',
                      lambda match: match[1] + match[2] + '[已隐藏]' + match[2], text, flags=re.I)
        text = re.sub(r'''((?:authorization|api[-_]?key|x-api-key|x-goog-api-key|access[-_]?token|refresh[-_]?token|token|secret|password)["']?\s*[=:]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s,;"']+''',
                      r'\1[已隐藏]', text, flags=re.I)
        return re.sub(r'\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+', r'\1 [已隐藏]', text, flags=re.I)

    sanitized = clean(detail)
    text = sanitized if isinstance(sanitized, str) else json.dumps(sanitized, ensure_ascii=False, default=str)
    return text[:1400] or '任务执行失败，请核对原任务'


def public(record):
    if record is None:
        return None
    value = {k: v for k, v in record.items() if k not in ('request', 'fingerprint', 'task_kind', 'execution')}
    value = json.loads(json.dumps(value, ensure_ascii=False))
    if value.get('error'):
        value['error'] = safe_error_detail(value['error'])  # Older ledgers may contain raw exceptions.
    value['task_id'] = value['id']
    value['retryable'] = False  # Querying an original receipt is not a new submission.
    value['queryable'] = bool(value.get('receipts'))
    if value['status'] in ('queued', 'running') and _key(value['id']) not in _ACTIVE:
        if value.get('receipts'):
            value.update(status='paused', recovery_status='receipt_saved',
                         error='执行已中断，远端回执已保存；请核对原任务，勿重新提交')
        elif value.get('dispatch_started'):
            value.update(status='uncertain', recovery_status='verification_required',
                         error='执行已中断且未保存远端回执，提交结果待核实，勿重新提交')
        else:
            value.update(status='paused', recovery_status='safe_to_dispatch',
                         error='请求已保存但尚未开始执行；当前只查询账本，不自动提交')
    if record.get('task_kind') in ('llm', 'video'):
        value['processing'] = _key(value['id']) in _ACTIVE
        if not value['processing'] and value['status'] == 'archiving':
            value.update(status='paused', media_status='pending')
        value.setdefault('recovery_action', None)
        if value['status'] == 'succeeded':
            value['recovery_action'] = None
    return value


def begin(kind, payload, execution=None):
    request = payload.model_dump() if hasattr(payload, 'model_dump') else dict(payload)
    request_id = request.get('request_id') or uuid.uuid4().hex
    task_id = task_identity(kind, request_id)
    canonical = {k: v for k, v in request.items() if k != 'request_id'}
    fingerprint = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(',', ':'),
                                            ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    try:
        with _disk_lock():
            previous = _read(task_id)
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise HTTPException(409, '同一请求编号对应的输入不同，请核对原任务')
                return public(previous), False
            now = time.time()
            record = dict(id=task_id, type={'image': 'online-image', 'comfy': 'comfy', 'llm': 'llm', 'video': 'video'}[kind],
                          task_kind=kind, request_id=request_id, canvas_id=request.get('canvas_id', ''),
                          node_id=request.get('node_id', ''), status='queued', created_at=now,
                          updated_at=now, result=None, error='', fingerprint=fingerprint,
                          request=request, dispatch_started=False, receipts=[], receipt=None,
                          upstream_task_id='', recovery_status='queued')
            if kind in ('image', 'llm', 'video'):
                record.update(provider_id=request.get('provider_id', request.get('provider', '')), model=request.get('model', ''))
            else:
                record['workflow_json'] = request.get('workflow_json', '')
            if kind in ('llm', 'video'):
                record.update(execution=execution or {}, output_node_id=request.get('output_node_id', ''),
                              output_slot_id=request.get('output_slot_id', ''), remote_status='not_submitted',
                              media_status='pending' if kind == 'video' else 'not_applicable', recovery_action=None)
            _write(record)
            _ACTIVE.add(_key(task_id))
            return public(record), True
    except HTTPException:
        raise
    except (OSError, ValueError) as exc:
        raise HTTPException(503, '任务尚未提交：无法保存请求，请恢复本地保存后重试') from exc


def read(task_id, kind=None):
    with _disk_lock():
        record = _read(task_id)
        if record and (kind is None or record['task_kind'] == kind):
            return public(record)
    return None


def find_image_request(request_id):
    return read(task_identity('image', request_id), 'image')


def find_comfy_request(request_id):
    return read(task_identity('comfy', request_id), 'comfy')


def request_payload(task_id, kind):
    """Execution uses exactly the payload whose fingerprint was committed."""
    with _disk_lock():
        record = _read(task_id)
        if not record or record['task_kind'] != kind:
            raise HTTPException(404, '任务请求快照不存在')
        return json.loads(json.dumps(record['request'], ensure_ascii=False))


def raw(task_id, kind=None):
    """Private immutable snapshot for an explicitly bound worker/recovery adapter."""
    with _disk_lock():
        record = _read(task_id)
        if not record or (kind is not None and record['task_kind'] != kind):
            raise HTTPException(404, '任务账本不存在')
        return json.loads(json.dumps(record, ensure_ascii=False))


def current_task():
    return _CONTEXT.get()


def activate(task_id):
    """Recovery owns no submission claim and never clears dispatch_started."""
    with _LOCK:
        _ACTIVE.add(_key(task_id))


def dispatch(task_id):
    with _disk_lock():
        record = _read(task_id)
        if not record or record['dispatch_started']:
            return False
        record.update(dispatch_started=True, status='running', recovery_status='dispatch_started',
                      updated_at=time.time())
        _write(record)  # A failed claim never reaches the provider.
        _ACTIVE.add(_key(task_id))
        return True


def update(task_id, **changes):
    with _disk_lock():
        return _update_locked(task_id, changes)


def _update_locked(task_id, changes):
    record = _read(task_id)
    if not record:
        raise HTTPException(404, '任务账本不存在')
    record.update(changes, updated_at=time.time())
    try:
        _write(record)
    except Exception:
        # Keep any receipt/result available in this process even if disk fails.
        _VOLATILE[_key(task_id)] = record
        raise
    _VOLATILE.pop(_key(task_id), None)
    return public(record)


@contextmanager
def receipt_context(task_id):
    token = _CONTEXT.set(task_id)
    try:
        yield
    finally:
        _CONTEXT.reset(token)


def remember_receipt(protocol, remote_id, **binding):
    """No-op outside a ledger worker. Called immediately after a known receipt."""
    task_id = _CONTEXT.get()
    if not task_id:
        return
    if not remote_id:
        raise ValueError('远端任务回执为空')
    for key in ('submit_url', 'query_url'):
        if key in binding:
            parts = urllib.parse.urlsplit(str(binding[key]))
            # Authentication may be in a URL's credentials or query string.
            netloc = parts.netloc.rsplit('@', 1)[-1]
            binding[key] = urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, '', ''))
    receipt = dict(protocol=protocol, task_id=str(remote_id), **binding)
    with _disk_lock():
        record = _read(task_id)
        receipts = list(record.get('receipts') or [])
        if receipt not in receipts:
            receipts.append(receipt)
        _update_locked(task_id, dict(receipts=receipts, receipt=receipt, upstream_task_id=str(remote_id),
                                    recovery_status='receipt_saved'))


def fail(task_id, exc, dispatched=True):
    with _disk_lock():
        record = _read(task_id)
        receipts = record.get('receipts') or []
        detail = safe_error_detail(getattr(exc, 'detail', None) or str(exc) or type(exc).__name__)
        # Exceptions after dispatch cannot establish that upstream did not accept it.
        has_result = record.get('result') is not None
        status = 'paused' if receipts or has_result else 'uncertain' if dispatched else 'failed'
        recovery = 'result_not_persisted' if has_result else 'receipt_saved' if receipts else 'verification_required' if dispatched else 'not_submitted'
        return _update_locked(task_id, dict(status=status, error=detail,
                                           status_code=getattr(exc, 'status_code', 500), recovery_status=recovery))


def release(task_id):
    with _LOCK:
        _ACTIVE.discard(_key(task_id))
