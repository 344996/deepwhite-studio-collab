"""Local website entry configuration. Never proxies credentials, files or uploads."""
import ipaddress
import json
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

import main as core


def normalize(value):
    value = value.strip()
    if not value:
        return ''
    try:
        parts = urlsplit(value)
        parts.port
        local = parts.hostname == 'localhost'
        try:
            local = local or ipaddress.ip_address(parts.hostname or '').is_loopback
        except ValueError:
            pass
        if (parts.scheme not in ('https', 'http') or not parts.hostname
                or parts.username or parts.password or parts.query or parts.fragment
                or parts.path not in ('', '/') or (parts.scheme == 'http' and not local)
                or '\\' in value or any(c.isspace() or ord(c) < 32 for c in value)):
            raise ValueError()
        return parts.scheme + '://' + parts.netloc.lower()
    except ValueError:
        raise HTTPException(400, '请填写 HTTPS 画廊根地址；本机测试可使用 http://127.0.0.1:端口。')


def config_path():
    return Path(core.DATA_DIR) / 'studio_gallery.json'


def read():
    path = config_path()
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict) or not isinstance(value.get('url'), str):
            raise ValueError()
        return {'url': normalize(value['url'])}
    except FileNotFoundError:
        return {'url': ''}
    except (OSError, ValueError, HTTPException):
        raise HTTPException(500, '画廊配置无法读取，请重新保存地址。')


class GalleryConfig(BaseModel):
    model_config = ConfigDict(extra='forbid')
    url: str = Field(max_length=512)


def install(app):
    @app.get('/api/studio/gallery')
    async def get_gallery():
        return read()

    @app.put('/api/studio/gallery')
    async def put_gallery(payload: GalleryConfig):
        result = {'url': normalize(payload.url)}
        try:
            core._atomic_write_bytes(str(config_path()), json.dumps(result, ensure_ascii=False).encode('utf-8'))
        except OSError:
            raise HTTPException(507, '地址保存失败，请检查本机存储空间后重试。')
        return result
