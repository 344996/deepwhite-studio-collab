"""U04 (handover 2026-10-26): "常用" models, kept per kind and per channel + model.

A favourite is a stable "provider_id|model" key, so syncing a catalogue never resets the choice and the
same model on two channels stays distinguishable. Favourites only shape the picker; they never change
a node that already has a model.
"""
import json
import os
import threading
from pathlib import Path

from fastapi import HTTPException

import main as core

KINDS = ('image', 'video', 'chat', 'audio', 'workflow')  # workflow: UX03 favourites in the workbench
LOCK = threading.Lock()


def path():
    return Path(core.DATA_DIR) / 'studio_model_favorites.json'


def load():
    try:
        value = json.loads(path().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        value = {}
    return {kind: [key for key in value.get(kind, []) if isinstance(key, str)] if isinstance(value, dict) else [] for kind in KINDS}


def save(kind, keys):
    if kind not in KINDS:
        raise HTTPException(400, '不支持的模型类型。')
    if not isinstance(keys, list) or len(keys) > 200 or any(
            not isinstance(key, str) or not 3 <= len(key) <= 300 or '|' not in key for key in keys):
        raise HTTPException(400, '常用模型列表格式无效。')
    with LOCK:
        value = load()
        value[kind] = list(dict.fromkeys(keys))
        target = path()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, target)
    return value


def install(app):
    @app.get('/api/studio/model-favorites')
    async def favorites():
        return load()

    @app.put('/api/studio/model-favorites/{kind}')
    async def set_favorites(kind: str, payload: dict):
        return save(kind, payload.get('keys'))
