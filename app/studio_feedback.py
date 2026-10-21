"""Explicit user feedback outbox; only chosen text/image and basic version leave the machine."""
import asyncio
import base64
import io
import json
import os
import platform
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Literal
from urllib.parse import urlencode, urlsplit
from uuid import UUID, uuid4

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
            'message', 'remote', 'destination', 'channel', 'issue_url', 'source')} | {'has_screenshot': bool(row.get('screenshot'))}


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


CATEGORY_LABELS = {'bug': '问题', 'interaction': '交互体验', 'model': '模型与生成', 'suggestion': '建议', 'other': '其他'}
DEFAULT_REPOSITORY = '344996/deepwhite-studio-collab'


def channels():
    """Developer-chosen delivery channels; never taken from an HTTP request.

    feedback_channels.json (next to this file, not committed; copy the example)
    or DEEPWHITE_FEEDBACK_WEBHOOK=type|https://... add group-bot webhooks. A
    GitHub issue link is always available, so feedback can always leave the
    machine through the user's own browser and account.
    """
    config = {}
    try:
        config = json.loads((Path(__file__).with_name('feedback_channels.json')).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        config = {}
    hooks = [hook for hook in config.get('webhooks', []) if isinstance(hook, dict)] if isinstance(config, dict) else []
    raw = os.environ.get('DEEPWHITE_FEEDBACK_WEBHOOK', '').strip()
    if raw:
        kind, _, url = raw.partition('|')
        hooks.append({'type': kind, 'url': url} if url else {'type': 'generic', 'url': kind})
    valid = []
    for hook in hooks:
        url = str(hook.get('url', ''))
        parts = urlsplit(url)
        if hook.get('type') in ('feishu', 'wecom', 'dingtalk', 'generic') and parts.scheme == 'https' and parts.hostname:
            valid.append({'type': hook['type'], 'url': url})
    repository = config.get('github_repository', DEFAULT_REPOSITORY) if isinstance(config, dict) else DEFAULT_REPOSITORY
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', str(repository)):
        repository = DEFAULT_REPOSITORY
    return {'webhooks': valid, 'github_repository': repository}


def report_text(row):
    lines = [f"【{CATEGORY_LABELS.get(row['category'], '反馈')}】{row['title']}", '', row['description']]
    if row.get('contact'):
        lines += ['', '联系方式：' + row['contact']]
    if row.get('diagnostics'):
        lines += ['', '环境：' + ' · '.join(f'{k}={v}' for k, v in row['diagnostics'].items())]
    if row.get('screenshot'):
        lines += ['', '（附有截图，保存在用户本机的反馈记录中）']
    lines += ['', '反馈编号：' + row['id'] + (' · 来自外接智能体' if row.get('source') == 'mcp' else '')]
    return '\n'.join(lines)


def issue_url(row):
    repository = channels()['github_repository']
    title = f"[反馈/{CATEGORY_LABELS.get(row['category'], '其他')}] {row['title']}"
    body = report_text(row)[:6000]
    return f'https://github.com/{repository}/issues/new?' + urlencode({'title': title, 'body': body, 'labels': 'feedback'})


def webhook_payload(kind, row):
    text = report_text(row)
    if kind == 'feishu':
        return {'msg_type': 'text', 'content': {'text': text}}
    if kind == 'wecom':
        return {'msgtype': 'markdown', 'markdown': {'content': text[:4000]}}
    if kind == 'dingtalk':
        return {'msgtype': 'markdown', 'markdown': {'title': row['title'], 'text': text.replace('\n', '\n\n')}}
    return {key: row.get(key) for key in ('id', 'category', 'title', 'description', 'contact', 'diagnostics', 'created', 'source')}


async def deliver_webhooks(row):
    delivered = []
    async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False, transport=TRANSPORT) as client:
        for hook in channels()['webhooks']:
            try:
                response = await client.post(hook['url'], json=webhook_payload(hook['type'], row))
                response.raise_for_status()
                body = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
                # Feishu/WeCom/DingTalk report failures in HTTP 200 bodies.
                if isinstance(body, dict) and (body.get('code') not in (None, 0) or body.get('errcode') not in (None, 0)):
                    continue
                delivered.append(hook['type'])
            except (httpx.HTTPError, ValueError):
                continue
    return delivered


async def transmit(key, refresh=False):
    with LOCK:
        row = load(key)
        if refresh and not row['sent']:
            raise HTTPException(409, '反馈尚未发送，请先发送。')
        if refresh and row.get('channel') in ('webhook', 'github'):
            row['message'] = '此反馈通过群机器人或 GitHub 发送，处理结果请在对应位置查看。'
            return public(row)
        if not row['destination']:
            row['destination'] = studio_gallery.read()['url']
        if not row['destination']:
            save(row)
    if not row['destination']:
        delivered = await deliver_webhooks(row)
        with LOCK:
            row = load(key)
            if delivered:
                row.update(sent=True, channel='webhook',
                           message='反馈已发送给开发者（' + '、'.join(delivered) + '），感谢你的建议。')
            else:
                row.update(channel='github', issue_url=issue_url(row),
                           message='已保存在本机。请在打开的 GitHub 页面点“Submit new issue”完成提交；如有截图可直接拖进页面。')
            save(row)
            return public(row)
    with LOCK:
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


def create_record(payload: Draft, source='ui'):
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
               'source': source, 'message': '已保存到本机，尚未发送。'}
        save(row)
        return public(row)


async def submit(args, source='mcp'):
    """Agent-collected feedback: text only, saved locally, then sent once."""
    try:
        draft = Draft(id=uuid4(), category=args['category'], title=args['title'],
                      description=args['description'], contact=args.get('contact', ''),
                      include_diagnostics=True)
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, '反馈内容不完整：需要分类、标题和至少 5 个字的描述。') from exc
    row = create_record(draft, source=source)
    result = await transmit(row['id'])
    if result.get('issue_url'):
        result['agent_hint'] = '请把 issue_url 提供给用户，由用户在浏览器中确认提交；不要代替用户登录或提交。'
    return result


def install(app):
    @app.get('/api/studio/feedback')
    def listing():
        with LOCK:
            rows = [load(p.stem) for p in folder().glob('*.json')]
        return {'items': [public(row) for row in sorted(rows, key=lambda row: row['created'], reverse=True)],
                'url': studio_gallery.read()['url']}

    @app.get('/api/studio/feedback/channels')
    def channel_summary():
        configured = channels()
        return {'gallery': bool(studio_gallery.read()['url']),
                'webhooks': [hook['type'] for hook in configured['webhooks']],
                'github_repository': configured['github_repository']}

    @app.post('/api/studio/feedback')
    def create(payload: Draft):
        return create_record(payload)

    @app.post('/api/studio/feedback/{feedback_id}/send')
    async def send(feedback_id: UUID):
        return await transmit(str(feedback_id))

    @app.post('/api/studio/feedback/{feedback_id}/refresh')
    async def refresh(feedback_id: UUID):
        return await transmit(str(feedback_id), refresh=True)
