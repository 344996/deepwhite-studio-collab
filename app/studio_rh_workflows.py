"""Local immutable RH configuration versions. Preview never saves or runs a task."""
import copy
import hashlib
import json
import math
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException
import main as core
import studio_runninghub as rh

MAX_BYTES = 12 * 1024 * 1024
SAFE_INTEGER = 9007199254740991
LOCK = threading.RLock()
ID = re.compile(r'^rh_[a-f0-9]{32}$')
SECRET_NAMES = {'apikey', 'api_key', 'wallet_api_key', 'authorization', 'access_token', 'password', 'secret'}


def directory():
    # GET and preview must not even create an empty library directory.
    return Path(core.DATA_DIR) / 'studio_rh_workflows'


def _wire(value):
    if isinstance(value, bool): return value
    if isinstance(value, int): return str(value) if abs(value) > SAFE_INTEGER else value
    if isinstance(value, float) and (not math.isfinite(value) or (value.is_integer() and abs(value) > SAFE_INTEGER)):
        raise HTTPException(400, '超长整数请使用十进制字符串。')
    if isinstance(value, list): return [_wire(x) for x in value]
    if isinstance(value, dict): return {k: _wire(v) for k, v in value.items()}
    return value


def _json(value):
    try:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (ValueError, TypeError):
        raise HTTPException(400, '配置包含无效 JSON 或数值。')
    if len(text.encode('utf-8')) > MAX_BYTES: raise HTTPException(413, '配置不能超过 12 MB。')
    return text


def _secret_check(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in SECRET_NAMES and item not in (None, ''):
                raise HTTPException(400, '配置包含凭据，请把密钥留在 API 设置中。')
            _secret_check(item)
    elif isinstance(value, list):
        for item in value: _secret_check(item)


def target_id(source, kind):
    if kind not in ('app', 'workflow'): raise HTTPException(400, '请选择 RH 应用或工作流。')
    text = str(source or '').strip()
    if re.fullmatch(r'\d{1,80}', text): return text
    try:
        parsed = urlsplit(text)
    except ValueError:
        raise HTTPException(400, 'RH 链接格式无效。')
    match = re.fullmatch(r'/(?:run/)?(ai-app|ai-detail|workflow)/(\d{1,80})/?', parsed.path)
    # Older RH shares use a hash router. Never extract an arbitrary trailing
    # number: post IDs, invitation IDs and task IDs are not workflow IDs.
    if not match and parsed.path in ('', '/'):
        match = re.fullmatch(r'/(workflow)/(\d{1,80})/?', parsed.fragment.split('?', 1)[0])
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or not match:
        raise HTTPException(400, '请输入 RH 应用/工作流 ID 或应用、工作流的直接链接；帖子链接不能作为工作流 ID。')
    if ('app' if match[1] in ('ai-app', 'ai-detail') else 'workflow') != kind:
        raise HTTPException(400, '链接来源与所选 RH 类型不一致。')
    return match[2]


def _graph(value):
    if not isinstance(value, dict) or not value: raise HTTPException(400, 'RH 工作流需要完整 API JSON；请先读取工作流参数。')
    if isinstance(value.get('nodes'), list): raise HTTPException(400, '这里需要 API 格式工作流，不能将普通/UI JSON 当作已转换的 RH 工作流。')
    for key, node in value.items():
        if not isinstance(node, dict) or not isinstance(node.get('inputs'), dict) or not node.get('class_type'):
            raise HTTPException(400, '工作流不是有效的 API 节点图。')
        for name, item in node['inputs'].items():
            if core.runninghub_is_workflow_link_value(item):
                if str(item[0]) not in value: raise HTTPException(400, '工作流连线引用了不存在的节点。')
    return copy.deepcopy(value)


def _validate_default(field):
    value = field['fieldValue']
    if value is None or value == '': return
    kind = field['fieldType'].upper()
    if kind in ('BOOL', 'BOOLEAN'):
        if type(value) is bool: return
        if str(value).lower() not in ('true', 'false', '0', '1'):
            raise HTTPException(400, '开关默认值必须为 true 或 false。')
        field['fieldValue'] = str(value).lower() in ('true', '1')
    elif kind in ('INT', 'INTEGER', 'FLOAT', 'NUMBER', 'SLIDER'):
        try:
            if type(value) is bool: raise InvalidOperation()
            number = Decimal(str(value))
            if not number.is_finite(): raise InvalidOperation()
            integer = kind in ('INT', 'INTEGER') or bool(re.search('seed|种子', field['fieldName'] + ' ' + field['label'], re.I))
            if integer and number != number.to_integral_value(): raise InvalidOperation()
            limits = {}
            for key in ('min', 'max', 'step'):
                if field[key] not in (None, ''):
                    limits[key] = Decimal(str(field[key]))
                    if not limits[key].is_finite(): raise InvalidOperation()
            if 'min' in limits and number < limits['min']: raise InvalidOperation()
            if 'max' in limits and number > limits['max']: raise InvalidOperation()
            if 'step' in limits:
                if limits['step'] <= 0: raise InvalidOperation()
                if integer and (number - limits.get('min', Decimal(0))) % limits['step'] != 0: raise InvalidOperation()
        except (InvalidOperation, ValueError):
            raise HTTPException(400, '数值默认值或范围无效：' + field['label'])


def normalize_definition(payload):
    if not isinstance(payload, dict): raise HTTPException(400, 'RH 配置格式无效。')
    _json(payload)
    kind = payload.get('kind')
    original = payload.get('entry') or payload
    if not isinstance(original, dict): raise HTTPException(400, 'RH 条目格式无效。')
    target = target_id(payload.get('target_id') or original.get('appId') or original.get('webappId') or original.get('workflowId') or original.get('id'), kind)
    raw_fields = original.get('fields')
    if not isinstance(raw_fields, list): raise HTTPException(400, 'RH 参数清单必须是数组。')
    fields, seen = [], set()
    for raw in raw_fields:
        if not isinstance(raw, dict): raise HTTPException(400, 'RH 参数格式无效。')
        try: field = core.runninghub_normalize_field(raw)
        except (ValueError, TypeError, OverflowError): raise HTTPException(400, '参数顺序或字段格式无效。')
        if not field['nodeId'] or not field['fieldName']: raise HTTPException(400, '每个参数需要 nodeId 与 fieldName。')
        field['id'] = field['nodeId'] + '::' + field['fieldName']
        for flag in ('enabled', 'sourceFromUpstream', 'random_enabled', 'required'):
            if flag in raw and type(raw[flag]) is not bool: raise HTTPException(400, '参数开关必须是 true 或 false。')
        key = (field['nodeId'], field['fieldName'])
        if key in seen: raise HTTPException(400, '同一个节点参数不能重复映射。')
        seen.add(key)
        # Do not let core's historical string coercion turn false into "False",
        # or let JS round a large integer in the public schema.
        value = next((raw[k] for k in ('fieldValue', 'defaultValue', 'value') if k in raw and raw[k] is not None), '')
        if isinstance(value, (dict, list)): value = _json(value)
        if isinstance(value, float) and (not math.isfinite(value) or (value.is_integer() and abs(value) > SAFE_INTEGER)):
            raise HTTPException(400, '超长整数请使用十进制字符串。')
        field['fieldValue'] = _wire(value)
        # Preserve typed enum choices and exact limits instead of inheriting
        # the legacy editor's blanket string conversion / browser rounding.
        if isinstance(raw.get('options'), list):
            if any(type(item) not in (str, int, float, bool) for item in raw['options']):
                raise HTTPException(400, '枚举选项仅支持文本、数字和布尔值。')
            field['options'] = _wire(raw['options'])
        for limit in ('min', 'max', 'step'):
            field[limit] = _wire(field[limit])
        _validate_default(field)
        if field['fieldName'].lower() in SECRET_NAMES and field['fieldValue'] not in ('', None):
            raise HTTPException(400, '配置包含凭据，请把密钥留在 API 设置中。')
        fields.append(field)
    entry = {'id': target, ('appId' if kind == 'app' else 'workflowId'): target,
             'title': str(original.get('title') or original.get('name') or payload.get('name') or 'RH ' + target)[:120],
             'note': str(original.get('note') or original.get('description') or '')[:1000], 'enabled': True, 'fields': fields}
    if kind == 'workflow':
        entry['workflowJson'] = _wire(_graph(original.get('workflowJson')))
        mode = original.get('optionalImageMode') or 'prune-workflow'
        if mode not in ('prune-workflow', 'keep-workflow'): raise HTTPException(400, '可选图片处理模式无效。')
        entry['optionalImageMode'] = mode
        for field in fields:
            node = entry['workflowJson'].get(field['nodeId'])
            if not node or field['fieldName'] not in node['inputs']: raise HTTPException(400, '映射参数在固定工作流图中不存在。')
            if core.runninghub_is_workflow_link_value(node['inputs'][field['fieldName']]): raise HTTPException(400, '工作流连线不能作为普通可编辑参数。')
    _secret_check(entry)
    return {'kind': kind, 'target_id': target, 'entry': entry}


def _path(key):
    if not isinstance(key, str) or not ID.fullmatch(key): raise HTTPException(400, '本地配置编号无效。')
    return directory() / (key + '.json')


def read(key):
    path = _path(key)
    if not path.exists(): raise HTTPException(404, '本地 RH 配置不存在。')
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        if data.get('id') != key or not isinstance(data.get('versions'), list) or not data['versions']: raise ValueError()
        return _wire(data)
    except (OSError, ValueError, TypeError, AttributeError): raise HTTPException(503, '本地 RH 配置损坏或暂不可读取，不会覆盖原文件。')


@contextmanager
def _disk_lock():
    with LOCK:
        directory().mkdir(parents=True, exist_ok=True)
        with (directory() / '.versions.lock').open('a+b') as fh:
            fh.seek(0, 2)
            if not fh.tell(): fh.write(b'0'); fh.flush()
            fh.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try: yield
            finally:
                fh.seek(0)
                if os.name == 'nt': msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                else: fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _write(record):
    path = _path(record['id'])
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as fh:
            fh.write(_json(record)); fh.flush(); os.fsync(fh.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists(): temp.unlink()


def save_version(payload, key=None):
    if not isinstance(payload, dict): raise HTTPException(400, '保存内容格式无效。')
    definition = normalize_definition(payload.get('definition') or payload)
    name = str(payload.get('name') or definition['entry']['title']).strip()[:120]
    if not name: raise HTTPException(400, '请填写配置名称。')
    with _disk_lock():
        if key:
            record = read(key)
            if type(payload.get('expected_revision')) is not int or payload['expected_revision'] != record['revision']:
                raise HTTPException(409, '配置已被更新，请保留草稿并重新读取后保存。')
            if record['kind'] != definition['kind'] or record['target_id'] != definition['target_id']:
                raise HTTPException(409, '同一配置不能改变 RH 来源；请另存为新配置。')
        else:
            record = {'id': 'rh_' + uuid.uuid4().hex, 'provider': 'runninghub', 'kind': definition['kind'],
                      'target_id': definition['target_id'], 'name': name, 'versions': [], 'revision': 0}
        revision = record['revision'] + 1
        record['versions'].append({'revision': revision, 'created_at': time.time(),
            'definition_hash': hashlib.sha256(_json(definition).encode()).hexdigest(), 'definition': definition})
        record.update(name=name, revision=revision, fields=definition['entry']['fields'])
        try: _write(record)
        except (OSError, ValueError): raise HTTPException(503, '配置未能保存，原版本保持不变。')
    return _wire(record)


def list_items():
    return [read(path.stem) for path in sorted(directory().glob('rh_*.json'))] if directory().exists() else []


def legacy_items():
    provider = next((p for p in core.load_api_providers() if p.get('id') == 'runninghub'), None)
    if not provider: return []
    provider = core.runninghub_provider_with_workflow_store(provider)
    items = []
    for kind, field in (('app', 'rh_apps'), ('workflow', 'rh_workflows')):
        for entry in provider.get(field, []):
            if entry.get('hidden') or entry.get('enabled') is False: continue
            items.append({'kind': kind, 'target_id': core.runninghub_entry_id(entry, kind),
                          'source': 'legacy', 'name': entry.get('title') or entry.get('name') or entry.get('id'),
                          'entry': _wire({k: copy.deepcopy(entry[k]) for k in ('id', 'appId', 'workflowId', 'title', 'note', 'fields', 'workflowJson', 'optionalImageMode') if k in entry})})
    return items


async def preview(payload):
    if not isinstance(payload, dict): raise HTTPException(400, '预览内容格式无效。')
    kind = payload.get('kind')
    if payload.get('definition') is not None:
        definition = normalize_definition(payload['definition'])
    elif isinstance(payload.get('entry'), dict):
        definition = normalize_definition(payload)
    elif isinstance(payload.get('workflow'), dict) and payload['workflow']:
        raw = payload['workflow']
        if isinstance(raw.get('definition'), dict): bag = raw['definition']
        elif isinstance(raw.get('entry'), dict): bag = raw
        else:
            entry = copy.deepcopy(raw)
            target = target_id(payload.get('source') or entry.get('appId') or entry.get('webappId') or entry.get('workflowId') or entry.get('id'), kind)
            if kind == 'workflow' and 'workflowJson' not in entry:
                graph = _graph(raw)
                entry = {'id': target, 'workflowJson': graph, 'fields': core.runninghub_collect_workflow_fields(graph)}
            bag = {'kind': kind, 'target_id': target, 'entry': entry}
        definition = normalize_definition(bag)
    else:
        target = target_id(payload.get('source'), kind)
        secrets = ()
        try:
            provider = core.runninghub_provider()
            secrets = (core.runninghub_api_key(provider),)
            if kind == 'app':
                result = await core.runninghub_app_info(target)
                data = result.get('data') or {}
                fields = data.get('nodeInfoList') or data.get('fields')
                entry = {'id': target, 'title': data.get('webappName') or data.get('name') or 'RH ' + target, 'fields': fields}
            else:
                result = await core.fetch_runninghub_workflow(core.RunningHubWorkflowConfig(workflowId=target, title=payload.get('name') or target))
                data = result.get('data') or {}
                entry = {'id': target, 'title': data.get('title') or target, 'fields': data.get('fields'), 'workflowJson': data.get('workflowJson'), 'optionalImageMode': 'prune-workflow'}
        except HTTPException as exc:
            raise HTTPException(exc.status_code, '读取 RH 参数失败：' + rh.safe_reason(exc.detail, secrets)) from exc
        except Exception as exc:
            raise HTTPException(502, '读取 RH 参数失败，请检查原渠道与连接；没有保存或执行任务。') from exc
        definition = normalize_definition({'kind': kind, 'target_id': target, 'entry': entry})
    if kind and kind != definition['kind']: raise HTTPException(400, '导入内容与所选 RH 类型不一致。')
    if payload.get('source') and target_id(payload['source'], definition['kind']) != definition['target_id']:
        raise HTTPException(400, '导入内容与链接的 RH ID 不一致。')
    return {'draft': True, 'name': str(payload.get('name') or definition['entry']['title'])[:120],
            'provider': 'runninghub', 'kind': definition['kind'], 'target_id': definition['target_id'],
            'revision': 0, 'fields': definition['entry']['fields'],
            'versions': [{'revision': 0, 'definition': definition}], 'diagnostics': [],
            'notice': '仅预览，尚未保存或执行。RH 应用只固定本地参数配置，不冻结平台内部实现。'}


def install(app):
    @app.get('/api/studio/runninghub/workflows')
    def listing(): return {'items': list_items()}

    @app.get('/api/studio/runninghub/workflows/legacy')
    def legacy(): return {'items': legacy_items()}

    @app.post('/api/studio/runninghub/workflows/preview')
    async def import_preview(payload: dict): return await preview(payload)

    @app.post('/api/studio/runninghub/workflows')
    def create(payload: dict): return save_version(payload)

    @app.get('/api/studio/runninghub/workflows/{key}')
    def detail(key: str): return read(key)

    @app.put('/api/studio/runninghub/workflows/{key}')
    def update(key: str, payload: dict): return save_version(payload, key)
