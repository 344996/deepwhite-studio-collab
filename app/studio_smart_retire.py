"""U10 (handover 2026-10-26): smart canvases are retired.

No new smart canvas is offered. An old one can be exported or copied into a new classic canvas.
The copy is made from a backup, every converted node keeps its original data (`legacySmart`), nodes
without a classic equivalent become notes instead of being dropped, and the original canvas is
never changed or deleted. Repeating the migration returns the copy made the first time.
"""
import copy
import json
import os
import threading
import time
from pathlib import Path

from fastapi import HTTPException

import main as core

LOCK = threading.Lock()
LABELS = {'smart-group': '分组', 'smart-loop': '循环', 'smart-minimax': 'MiniMax 节点'}


def directory():
    path = Path(core.DATA_DIR) / 'smart_migration'
    path.mkdir(parents=True, exist_ok=True)
    return path


def _url(item):
    return item.get('url') if isinstance(item, dict) else item if isinstance(item, str) else ''


def convert_node(node):
    base = {'id': node['id'], 'x': node.get('x', 0), 'y': node.get('y', 0), 'legacySmart': copy.deepcopy(node)}
    kind, title = node.get('type'), str(node.get('title') or '')
    if kind == 'smart-prompt':
        return {**base, 'type': 'prompt', 'text': str(node.get('text') or ''), 'title': title}, True
    if kind == 'smart-image':
        media = [item for item in node.get('images') or [] if _url(item)]
        if len(media) == 1 and not node.get('runSettings'):
            return {**base, 'type': 'image', 'url': _url(media[0]), 'name': title}, True
        if media:
            return {**base, 'type': 'output', 'images': copy.deepcopy(media), 'studioTitle': title}, True
        draft = str(node.get('promptDraftText') or node.get('runPrompt') or '')
        return {**base, 'type': 'generator', 'studioTitle': title, 'studioPrompt': draft}, True
    label = LABELS.get(kind, kind or '未知类型')
    text = (f'【旧版智能画布：{label}{"「" + title + "」" if title else ""}】经典画布没有对应的节点，未自动转换。'
            '原始数据完整保存在本节点中，可对照旧画布手动重建。')
    return {**base, 'type': 'prompt', 'text': text, 'title': '未转换：' + label}, False


def migrate(canvas_id):
    with LOCK:
        smart = core.load_canvas_any(canvas_id)
        if core.normalize_canvas_kind(smart.get('kind')) != 'smart':
            raise HTTPException(400, '只有旧版智能画布需要迁移。')
        record_path = directory() / f'{canvas_id}.json'
        if record_path.exists():
            record = json.loads(record_path.read_text(encoding='utf-8'))
            try:
                core.load_canvas(record['canvas_id'])
                return record
            except HTTPException:
                pass  # the copy was deleted: make a new one from a fresh backup
        stamp = time.strftime('%Y%m%d-%H%M%S')
        backup = directory() / f'{canvas_id}-{stamp}-backup.json'
        backup.write_text(json.dumps(smart, ensure_ascii=False), encoding='utf-8')
        nodes, unconverted, rewrites = [], 0, 0
        for index, node in enumerate(smart.get('nodes') or []):
            if not isinstance(node, dict):
                continue
            if not node.get('id'):  # a damaged node is still kept, under a new id
                node = {**node, 'id': f'legacy-{index}'}
            converted, ok = convert_node(node)
            nodes.append(converted)
            unconverted += 0 if ok else 1
            # Classic prompt nodes have no AI rewrite: say so instead of dropping the setting silently.
            rewrites += 1 if node.get('type') == 'smart-prompt' and node.get('llmEnabled') else 0
        ids = {node['id'] for node in nodes}
        connections = [{'id': c.get('id') or f'm{index}', 'from': c['from'], 'to': c['to']}
                       for index, c in enumerate(smart.get('connections') or [])
                       if isinstance(c, dict) and c.get('from') in ids and c.get('to') in ids]
        created = core.new_canvas((smart.get('title') or '旧版智能画布') + '（经典版）', kind='classic', project=smart.get('project'))
        canvas = core.load_canvas(created['id'])
        canvas.update(nodes=nodes, connections=connections, viewport=copy.deepcopy(smart.get('viewport') or {'x': 0, 'y': 0, 'scale': 1}),
                      migratedFrom={'canvas_id': canvas_id, 'backup': backup.name})
        core.save_canvas(canvas)
        record = {'canvas_id': created['id'], 'url': '/static/canvas.html?id=' + created['id'], 'backup': backup.name,
                  'converted': len(nodes) - unconverted, 'unconverted': unconverted, 'connections': len(connections),
                  'rewrite_settings_kept': rewrites,
                  'message': f'已备份原画布并创建经典版：转换 {len(nodes) - unconverted} 个节点'
                             + (f'，{unconverted} 个无法直接转换的节点已改为说明节点（原始数据保留）' if unconverted else '')
                             + (f'；{rewrites} 个提示词节点的“AI 改写”设置在经典画布中没有对应功能，只保留了文字，原设置存于节点原始数据' if rewrites else '')
                             + '。原智能画布没有改动，仍可打开。'}
        temporary = record_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(record, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, record_path)
        return record


def legacy_fixtures_allowed():
    """Test servers seed old smart canvases to stand in for user data; nothing else may create one."""
    return os.environ.get('DEEPWHITE_STUDIO_LEGACY_SMART_FIXTURES') == '1'


def install(app):
    create = core.new_canvas

    def new_canvas(title='未命名画布', icon='layers', kind='classic', *args, **kwargs):
        if core.normalize_canvas_kind(kind) == 'smart' and not legacy_fixtures_allowed():
            raise HTTPException(410, '智能画布已停止新建，请新建普通画布。旧智能画布仍可打开，并可迁移到经典画布。')
        return create(title, icon, kind, *args, **kwargs)
    # Every creation path (page, API, MCP) goes through core.new_canvas, so the retirement holds on the server.
    core.new_canvas = new_canvas

    @app.post('/api/canvases/{canvas_id}/migrate-classic')
    async def migrate_route(canvas_id: str):
        return migrate(canvas_id)
