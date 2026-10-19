"""Explicit local import of untrusted prompt data. Never executes a model or fetches a URL."""
import hashlib
import json
import threading
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

import main as core

MAX_BYTES = 65536
IMPORT_LOCK = threading.Lock()


class PromptPackage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: Literal['deepwhite.prompt.v1'] = Field(alias='schema')
    title: str = Field(max_length=120)
    prompt: str = Field(min_length=1, max_length=8000)
    kind: Literal['prompt', 'image', 'video']
    source_url: str = Field(max_length=1024)

    @field_validator('prompt')
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError('提示词不能为空。')
        return value

    @field_validator('source_url')
    @classmethod
    def source(cls, value):
        parts = urlsplit(value)
        parts.port
        if (parts.scheme not in ('https', 'http') or not parts.hostname or parts.username
                or parts.password or parts.query or parts.fragment or '\\' in value
                or any(c.isspace() or ord(c) < 32 for c in value)):
            raise ValueError('来源链接无效。')
        return value


class ImportRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    project_id: str = Field(min_length=1, max_length=128)
    payload: PromptPackage


def import_prompt(payload):
    fingerprint = hashlib.sha256(json.dumps(payload.model_dump(), sort_keys=True,
        ensure_ascii=False).encode('utf-8')).hexdigest()
    canvas_id = 'gallery_' + payload.operation_id
    receipt_path = Path(core.DATA_DIR) / 'studio_gallery_imports' / (canvas_id + '.json')
    path = Path(core.canvas_path(canvas_id))
    result = {'canvas_id': canvas_id, 'url': '/static/canvas.html?id=' + canvas_id}
    # save_canvas owns CANVAS_LOCK; do not recursively acquire its non-reentrant lock.
    with IMPORT_LOCK:
        if receipt_path.exists():
            try:
                receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
                if not isinstance(receipt, dict):
                    raise ValueError()
            except (OSError, ValueError):
                raise HTTPException(503, '导入记录无法读取，请先备份并检查数据。') from None
            if receipt.get('fingerprint') != fingerprint:
                raise HTTPException(409, '本次导入的内容已变化，请重新打开提示词文件。')
            if path.exists():
                saved = core.load_canvas_any(canvas_id)
                if saved.get('_gallery_import') != {'fingerprint': fingerprint, 'canvas_id': canvas_id}:
                    raise HTTPException(409, '导入记录与画布不一致，请先检查数据。')
                if saved.get('deleted_at'):
                    raise HTTPException(409, '导入的画布已在回收站，请恢复后打开。')
                return result
            if receipt.get('state') != 'failed':
                raise HTTPException(409, '上次导入结果待核实或画布已删除。请先核对画布列表，再重新打开文件导入。')
        if path.exists():
            raise HTTPException(409, '画布编号已存在，请重新打开文件导入。')
        projects = {p['id'] for p in core.load_projects()} | {core.DEFAULT_PROJECT_ID}
        if payload.project_id not in projects:
            raise HTTPException(404, '所选项目不存在，请刷新项目列表。')
        data, now = payload.payload, core.now_ms()
        canvas = {'id': canvas_id, 'title': (data.title.strip() or '画廊灵感')[:80],
            'kind': 'classic', 'icon': 'layers', 'project': payload.project_id,
            'owner': '', 'color': '', 'pinned': False, 'created_at': now, 'updated_at': now,
            'nodes': [{'id': 'gallery_prompt', 'type': 'prompt', 'text': data.prompt,
                       'x': 120, 'y': 100, 'w': 400, 'h': 300}],
            'connections': [], 'viewport': {'x': 0, 'y': 0, 'scale': 1},
            'gallery_source': {'url': data.source_url, 'kind': data.kind},
            '_gallery_import': {'fingerprint': fingerprint, 'canvas_id': canvas_id}}
        receipt = {'fingerprint': fingerprint, 'state': 'reserved'}
        try:
            core._atomic_write_bytes(str(receipt_path), json.dumps(receipt).encode('utf-8'))
            core.save_canvas(canvas)
        except OSError as error:
            if receipt_path.exists() and not path.exists():
                try:
                    core._atomic_write_bytes(str(receipt_path), json.dumps({**receipt, 'state': 'failed'}).encode('utf-8'))
                except OSError:
                    pass
            raise HTTPException(507, '提示词导入未完成，请检查磁盘空间和权限后重试。') from error
        return result


def install(app):
    @app.get('/gallery-import')
    async def import_page():
        return FileResponse(Path(__file__).parent / 'static' / 'studio-gallery-import.html',
            headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
                     'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})

    @app.post('/api/studio/gallery/import')
    async def import_request(request: Request):
        if request.headers.get('origin') != str(request.base_url).rstrip('/'):
            raise HTTPException(403, '请在本机导入页面确认操作。')
        if request.headers.get('content-type', '').split(';', 1)[0] != 'application/json':
            raise HTTPException(415, '请使用提示词 JSON 文件。')
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > MAX_BYTES:
                raise HTTPException(413, '提示词文件超过 64 KB。')
            raw.extend(chunk)
        try:
            payload = ImportRequest.model_validate_json(raw)
        except ValidationError:
            raise HTTPException(422, '提示词文件格式无效或包含不支持的字段。') from None
        return import_prompt(payload)
