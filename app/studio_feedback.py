"""Explicit user feedback outbox; only chosen text/image and basic version leave the machine."""
import asyncio
import base64
import io
import json
import platform
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Literal
from uuid import UUID

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from PIL import Image

import main as core
import studio_gallery

LOCK = threading.RLock()
TRANSPORT = None


class Draft(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: UUID
    category: Literal['bug', 'interaction', 'model', 'suggestion', 'other']
    title: str = Field(min_length=2, max_length=100)
    description: str = Field(min_length=5, max_length=5000)
    contact: str = Field(default='', max_length=160)
    screenshot: str = Field(default='', max_length=410_000)
    include_diagnostics: bool = False


def clean(text):
    text = re.sub(r'(?i)\b(?:sk|sess)-[A-Za-z0-9_-]{8,}', '[已隐藏密钥]', text)
    text = re.sub(r'(?im)^(\s*(?:authorization|cookie)\s*:\s*)[^\r\n]+', r'\1[已隐藏]', text)
    return re.sub(
        r'''(?i)(["']?(?:api[_ -]?key|authorization|password|cookie|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret|密码)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;]+)''',
        r'\1[已隐藏]', text.strip())


def folder():
    return Path(core.DATA_DIR) / 'feedback'


def path(key):
    return folder() / (str(UUID(str(key))) + '.json')


def load(key):
    try:
        row = json.loads(path(key).read_text(encoding='utf-8'))
        if row['id'] != str(key) or not isinstance(row.get('receipt_key'), str):
            raise ValueError()
        return row
    except FileNotFoundError:
        raise HTTPException(404, '反馈记录不存在。') from None
    except (ValueError, KeyError, OSError):
        raise HTTPException(500, '反馈记录无法读取，请保留原文件。') from None


def save(row):
    try:
        core._atomic_write_bytes(str(path(row['id'])), json.dumps(row, ensure_ascii=False).encode('utf-8'))
    except OSError:
        raise HTTPException(507, '反馈保存失败，请检查存储空间。已保存记录不会被覆盖。') from None


def public(row):
    return {key: row.get(key) for key in ('id', 'category', 'title', 'description', 'created', 'sent',
            'message', 'remote', 'destination')} | {'has_screenshot': bool(row.get('screenshot'))}


def screenshot(encoded):
    if not encoded:
        return ''
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > 300_000:
            raise ValueError()
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ('PNG', 'JPEG', 'WEBP') or image.width * image.height > 6_000_000 or getattr(image, 'n_frames', 1) != 1:
                raise ValueError()
            image.load()
            image.thumbnail((1600, 1200))
            out = io.BytesIO()
            image.convert('RGB').save(out, format='WEBP', quality=75)
            if len(out.getvalue()) > 300_000:
                raise ValueError()
            return base64.b64encode(out.getvalue()).decode('ascii')
    except (ValueError, OSError, Image.DecompressionBombError):
        raise HTTPException(422, '截图需为静态 JPG、PNG 或 WebP，压缩后最多 300 KB、600 万像素。') from None


async def exchange(row, refresh=False):
    base = studio_gallery.normalize(row['destination'])
    async with httpx.AsyncClient(base_url=base, timeout=15, follow_redirects=False, trust_env=False, transport=TRANSPORT) as client:
        if refresh:
            response = await client.get('/api/gallery/feedback/' + row['id'],
                                        headers={'X-Feedback-Receipt': row['receipt_key']})
        else:
            session = await client.get('/api/gallery/session')
            session.raise_for_status()
            csrf = session.json().get('csrf')
            if not isinstance(csrf, str) or not csrf:
                raise ValueError()
            body = {key: row[key] for key in ('id', 'receipt_key', 'category', 'title', 'description', 'contact', 'screenshot', 'diagnostics')}
            response = await client.post('/api/gallery/feedback', json=body,
                                         headers={'Origin': base, 'X-CSRF-Token': csrf})
        response.raise_for_status()
        value = response.json()
        if (not isinstance(value, dict) or value.get('id') != row['id'] or
                value.get('status') not in ('new', 'in_progress', 'done', 'closed') or
                type(value.get('revision')) is not int or value['revision'] < 1):
            raise ValueError()
        return {'id': row['id'], 'status': value['status'], 'revision': value['revision'],
                'reply': clean(str(value.get('reply', '')))[:2000]}


async def transmit(key, refresh=False):
    with LOCK:
        row = load(key)
        if refresh and not row['sent']:
            raise HTTPException(409, '反馈尚未发送，请先发送。')
        if not row['destination']:
            row['destination'] = studio_gallery.read()['url']
        if not row['destination']:
            row['message'] = '已保存在本机。请先设置画廊地址，再发送给开发者。'
            save(row)
            return public(row)
        save(row)  # Pin destination and receipt before a request with uncertain outcome.
    try:
        result = await exchange(row, refresh)
    except (httpx.HTTPError, ValueError, KeyError, asyncio.TimeoutError):
        with LOCK:
            row = load(key)
            row['message'] = '暂时无法连接反馈后台，记录已保留。可重试；重复提交不会新建第二份。'
            save(row)
            return public(row)
    with LOCK:
        row = load(key)
        if not row.get('remote') or result['revision'] >= row['remote']['revision']:
            row['remote'] = result
        row['sent'] = True
        row['message'] = '已更新处理结果。' if refresh else '反馈已送达，感谢你的建议。'
        save(row)
        return public(row)


def install(app):
    @app.get('/api/studio/feedback')
    def listing():
        with LOCK:
            rows = [load(p.stem) for p in folder().glob('*.json')]
        return {'items': [public(row) for row in sorted(rows, key=lambda row: row['created'], reverse=True)],
                'url': studio_gallery.read()['url']}

    @app.post('/api/studio/feedback')
    def create(payload: Draft):
        key = str(payload.id)
        body = payload.model_dump(mode='json', exclude={'include_diagnostics'})
        for field in ('title', 'description', 'contact'):
            body[field] = clean(body[field])
        if len(body['title']) < 2 or len(body['description']) < 5:
            raise HTTPException(422, '请填写标题和至少 5 个字的问题描述。')
        body['screenshot'] = screenshot(body['screenshot'])
        diagnostics = {}
        if payload.include_diagnostics:
            diagnostics = {'version': (Path(__file__).parent / 'VERSION').read_text().strip(),
                           'platform': platform.system(), 'client': 'DeepWhite Studio'}
        body['diagnostics'] = diagnostics
        with LOCK:
            if path(key).exists():
                # Immutable once saved: retries use the original payload and receipt.
                previous = load(key)
                if any(previous[field] != body[field] for field in ('category', 'title', 'description', 'contact', 'screenshot', 'diagnostics')):
                    raise HTTPException(409, '此反馈已保存，请创建新的反馈。')
                return public(previous)
            if sum(1 for _ in folder().glob('*.json')) >= 1000:
                raise HTTPException(507, '本地反馈记录已达到上限。')
            row = {**body, 'diagnostics': diagnostics, 'receipt_key': secrets.token_urlsafe(32),
                   'created': time.time(), 'sent': False, 'remote': None, 'destination': '',
                   'message': '已保存到本机，尚未发送。'}
            save(row)
            return public(row)

    @app.post('/api/studio/feedback/{feedback_id}/send')
    async def send(feedback_id: UUID):
        return await transmit(str(feedback_id))

    @app.post('/api/studio/feedback/{feedback_id}/refresh')
    async def refresh(feedback_id: UUID):
        return await transmit(str(feedback_id), refresh=True)
