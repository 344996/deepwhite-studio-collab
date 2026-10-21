"""Narrow local-agent API for ordinary DeepWhite Studio canvases."""
import asyncio
import copy
import hashlib
import json
import os
import secrets
import sys
import threading
import time
import uuid
from pathlib import Path

from fastapi import HTTPException, Request

import main as core
import studio_models as model_inventory
import studio_canvas_services as plans
import studio_assets as assets
import studio_catalog as catalog
import studio_generation as generation
import studio_graph as graph
import studio_packages as packages
from studio_capabilities import parameters
from studio_mcp import BridgeError, _sanitize, _validate, load_tools
from studio_mcp_config import client_configuration

LOCK = threading.RLock()
MAX_SESSION_SECONDS = 30 * 60
MAX_SESSION_RUNS = 20
TOOLS = {
    'list_canvases', 'get_canvas', 'list_models', 'list_assets', 'apply_nodes',
    'undo_edit', 'generate_node', 'get_generation', 'resume_generation',
}
TOOLS.update(graph.TOOLS)
TOOLS.update(packages.TOOLS)
TOOLS.add('submit_feedback')
TOOL_SCHEMAS = {tool['name']: tool['inputSchema'] for tool in load_tools()}


def path():
    return Path(core.DATA_DIR) / 'studio_control.json'


def _load():
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        try:
            value = json.loads(p.read_text(encoding='utf-8'))
            if isinstance(value, dict) and value.get('token'):
                value.setdefault('enabled', False); value.setdefault('generation_mode', 'confirm')
                value.setdefault('session_expires_at', None); value.setdefault('remaining_runs', 0)
                value.setdefault('pending', []); value.setdefault('runs', {}); value.setdefault('undo', {})
                return value
        except (OSError, ValueError):
            pass
    value = {'token': secrets.token_urlsafe(40), 'enabled': False, 'generation_mode': 'confirm',
             'session_expires_at': None, 'remaining_runs': 0, 'pending': [], 'runs': {}, 'undo': {}}
    _save(value)
    return value


def _save(value):
    p = path(); p.parent.mkdir(parents=True, exist_ok=True)
    temp = p.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temp, p)


def _settings(value, base_url='http://127.0.0.1:3848'):
    pending = []
    for item in value.get('pending', []):
        if item.get('status') != 'pending': continue
        row = {k: item.get(k) for k in ('id','canvas_id','node_id','status','created_at','quote')}
        try:
            canvas = core.load_canvas(item.get('canvas_id', ''))
            node = next((n for n in canvas.get('nodes', []) if n.get('id') == item.get('node_id')), {})
            approved_input=item.get('input') or {}
            row.update(title=item.get('title') or node.get('studioTitle') or node.get('name') or '', prompt=approved_input.get('prompt',node.get('studioPrompt') or ''),
                       model=approved_input.get('model',node.get('model') or ''),provider_id=approved_input.get('provider_id',node.get('apiProvider') or ''),
                       count=approved_input.get('count',1),references=approved_input.get('references',[]),params=approved_input.get('params',{}))
        except Exception:
            row.update(title='', prompt='', model='', provider_id='')
        pending.append(row)
    expires = value.get('session_expires_at')
    remaining = value.get('remaining_runs', 0) if value.get('enabled') and expires and expires > time.time() else 0
    return {'enabled': value.get('enabled', False), 'generation_mode': value.get('generation_mode', 'confirm'),
            'session_expires_at': expires, 'remaining_runs': remaining,
            'pending': pending, **client_configuration(sys.executable, Path(__file__).parent,
                Path(core.DATA_DIR).parent, base_url, os.environ.get('DEEPWHITE_INSTALL_ROOT'))}


def _public_canvas(canvas):
    out = copy.deepcopy({k: v for k, v in canvas.items() if k != graph.JOURNAL})
    return _sanitize(out)


def _canvas(canvas_id):
    canvas = core.load_canvas(canvas_id)
    if core.normalize_canvas_kind(canvas.get('kind')) == 'smart':
        raise HTTPException(400, '智能画布暂不支持此控制接口。')
    return canvas


def _touch(canvas):
    core.save_canvas(canvas)
    manager = getattr(core, 'manager', None)
    if manager and hasattr(manager, 'broadcast_canvas_updated'):
        try:
            asyncio.get_running_loop().create_task(manager.broadcast_canvas_updated(
                canvas['id'], int(canvas.get('updated_at') or core.now_ms()), 'studio-mcp'))
        except RuntimeError:
            pass


def _models():
    rows = []
    from studio_capabilities import profile
    for item in model_inventory.available_models()[1]:
        spec = profile(item['model'], item['kind'])
        rows.append({**item, 'supported':bool(spec['supported']), 'fields':spec['fields'],
                     'prompt_min':spec['prompt_min'], 'prompt_max':spec['prompt_max'],
                     'max_images':spec['max_images'], 'max_videos':spec['max_videos'], 'max_audios':spec['max_audios'], 'note':spec['note']})
    rows = [row for row in rows if row['supported']]
    import studio_dreamina
    for item in (studio_dreamina.models() if studio_dreamina.config()['enabled'] else []):
        if not item.get('enabled'): continue
        spec=studio_dreamina.spec(item['id'])
        rows.append({'provider_id':studio_dreamina.PROVIDER,'model':item['id'],'label':item['name'],'kind':item['kind'],
            'supported':True,'fields':spec['fields'],'prompt_min':spec['prompt_min'],'prompt_max':spec['prompt_max'],
            'max_images':spec['max_images'],'max_videos':spec['max_videos'],'max_audios':spec['max_audios'],'note':spec['note']})
    import studio_comfy
    spec=studio_comfy.spec()
    rows.append({'provider_id':studio_comfy.PROVIDER,'model':studio_comfy.MODEL,
                 'label':'Qwen Image 2.1 · 单图编辑（本地）','kind':'image','supported':True,
                 'fields':spec['fields'],'prompt_min':spec['prompt_min'],'prompt_max':spec['prompt_max'],
                 'max_images':spec['max_images'],'max_videos':spec['max_videos'],'max_audios':spec['max_audios'],'note':spec['note']})
    return rows


def _apply(canvas_id, payload):
    with plans.APPLY_LOCK:
        return _apply_locked(canvas_id, payload)


def _apply_locked(canvas_id, payload):
    if not isinstance(payload, dict): raise HTTPException(400, '请求格式错误。')
    operation_id = payload.get('operation_id')
    if not isinstance(operation_id, str) or not 8 <= len(operation_id) <= 80:
        raise HTTPException(400, 'operation_id 无效。')
    fingerprint = hashlib.sha256(json.dumps({k:v for k,v in payload.items() if k != 'expected_revision'}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    canvas = _canvas(canvas_id)
    journal = graph.edit_journal(canvas)
    old = graph.replay_edit(journal, operation_id, fingerprint, 'apply_nodes')
    if old is not None:
        return old
    if plans.revision(canvas) != payload.get('expected_revision'):
        raise HTTPException(409, '画布已发生变化，请重新读取后再编辑。')
    raw_nodes = payload.get('nodes')
    if not isinstance(raw_nodes, list) or not 1 <= len(raw_nodes) <= 40: raise HTTPException(400, 'nodes 需要包含 1–40 个节点。')
    keys = [n.get('key') for n in raw_nodes if isinstance(n, dict)]
    if len(keys) != len(raw_nodes) or len(set(keys)) != len(keys) or any(not isinstance(k,str) or not k or len(k)>80 for k in keys):
        raise HTTPException(400, '节点 key 缺失或重复。')
    ctx = plans.context(canvas_id, [], [])
    targets = _models()
    normalized = []
    for entry in raw_nodes:
        if not isinstance(entry, dict): raise HTTPException(400, '节点格式错误。')
        allowed = {'key','kind','title','prompt','provider_id','model','params','references','target_node_id'}
        if set(entry) - allowed: raise HTTPException(400, '节点包含不支持的字段。')
        kind = entry.get('kind'); pid = entry.get('provider_id'); mid = entry.get('model')
        import studio_comfy
        if pid == studio_comfy.PROVIDER:
            if kind != 'image' or mid != studio_comfy.MODEL: raise HTTPException(400, '本地 ComfyUI 仅支持 Qwen 单图编辑。')
            fields = studio_comfy.spec()['fields']; requested_params = entry.get('params', {})
            if not isinstance(requested_params, dict) or set(requested_params) - set(fields): raise HTTPException(400, 'params 含本地工作流不支持的参数。')
            local_params = {k: requested_params.get(k, v['default']) for k,v in fields.items()}
            for k,v in local_params.items():
                if v not in fields[k]['values']: raise HTTPException(400, '本地工作流参数不支持当前值。')
            refs=[]; rawrefs=entry.get('references') or []
            if not isinstance(rawrefs,list) or len(rawrefs)!=1 or not isinstance(rawrefs[0],dict): raise HTTPException(400, '本地 Qwen 单图编辑需要且只能提供一张参考图。')
            asset = assets.public(assets._row(rawrefs[0].get('version_id')))
            if asset['project_id'] != (core.load_canvas(canvas_id).get('project') or 'default') or asset['kind'] != 'image' or not assets.file_path(asset['version_id']):
                raise HTTPException(400, '参考素材不属于当前项目或文件已缺失。')
            if not isinstance(entry.get('prompt'), str) or not entry['prompt'].strip(): raise HTTPException(400, '生成节点缺少提示词。')
            row={'key':entry.get('key'), 'kind':kind, 'title':str(entry.get('title') or entry.get('key') or '')[:120],
                 'prompt':entry['prompt'].strip(), 'references':[{'version_id':asset['version_id'],'asset_id':asset['asset_id'],
                 'url':asset['url'],'kind':'image','name':asset['name'],'mention':'@图片1','label':asset['name']}],
                 'target_node_id':str(entry.get('target_node_id') or ''), 'provider_id':pid,'model':mid,'params':local_params}
            row['prompt'] = row['prompt'].replace('{{asset:'+asset['version_id']+'}}', '@图片1')
            if '{{asset:' in row['prompt']: raise HTTPException(400, '提示词引用了未绑定的资产版本。')
            if row['target_node_id'] and not any(n.get('id') == row['target_node_id'] and n.get('type') == 'generator' for n in core.load_canvas(canvas_id).get('nodes', [])):
                raise HTTPException(409, '要更新的节点不存在或类型不匹配。')
            normalized.append(row); continue
        # Validate requested model against the live enabled target list, per node.
        target = next((m for m in targets if m.get('kind') == kind and m.get('provider_id') == pid and m.get('model') == mid), None)
        if not target: raise HTTPException(400, '节点模型不可用或未启用。')
        ctx['target_models'] = {kind: {'provider_id': pid, 'model': mid}}
        plan = plans.validate_plan({'nodes': [{k: entry[k] for k in ('key','kind','title','prompt','references','target_node_id') if k in entry}]}, ctx, targets)
        row = plan['nodes'][0]
        # The plan validator supplies defaults; reject unknown or invalid values, never discard them.
        requested_params = entry.get('params', {})
        if not isinstance(requested_params, dict): raise HTTPException(400, 'params 必须是对象。')
        from studio_capabilities import profile
        import studio_dreamina
        fields=studio_dreamina.spec(mid)['fields'] if pid==studio_dreamina.PROVIDER else profile(mid,kind)['fields']
        allowed_params=set(fields)
        if set(requested_params) - allowed_params: raise HTTPException(400, 'params 含模型不支持的参数。')
        if pid==studio_dreamina.PROVIDER:
            normalized_params={key:requested_params.get(key,field['default']) for key,field in fields.items()}
            if any(value not in fields[key]['values'] for key,value in normalized_params.items()):raise HTTPException(400,'即梦模型参数不支持当前值。')
        else:normalized_params = parameters(mid, kind, requested_params)
        row['params'] = normalized_params
        normalized.append(row)
    targets_to_update = [x['target_node_id'] for x in normalized if x['target_node_id']]
    if len(targets_to_update) != len(set(targets_to_update)): raise HTTPException(400, '同一画布节点不能被多个方案节点覆盖。')
    # One validation pass above ensures all nodes and references are valid before mutation.
    with plans.APPLY_LOCK:
        canvas = _canvas(canvas_id)
        journal = graph.edit_journal(canvas)
        if plans.revision(canvas) != payload.get('expected_revision'):
            raise HTTPException(409, '画布已发生变化，请重新读取后再编辑。')
        fresh_targets = _models()
        fresh_ctx = plans.context(canvas_id, [], [])
        for entry in raw_nodes:
            if entry.get('provider_id') == studio_comfy.PROVIDER:
                for ref in entry.get('references') or []:
                    asset = assets.public(assets._row(ref.get('version_id')))
                    if asset['project_id'] != fresh_ctx['project_id'] or not assets.file_path(asset['version_id']):
                        raise HTTPException(409, '参考素材在应用前已变更或缺失。')
                continue
            fresh_ctx['target_models'] = {entry['kind']:{'provider_id':entry['provider_id'],'model':entry['model']}}
            plans.validate_plan({'nodes':[{k:entry[k] for k in ('key','kind','title','prompt','references','target_node_id') if k in entry}]},
                                fresh_ctx, fresh_targets)
        graph._idle(canvas)
        snapshot = {'nodes': copy.deepcopy(canvas.get('nodes', [])), 'connections': copy.deepcopy(canvas.get('connections', []))}
        nodes = canvas.setdefault('nodes', []); conns = canvas.setdefault('connections', [])
        right = max([float(n.get('x', 0)) + float(n.get('w') or 500) for n in nodes] + [0]) + 360
        created = {}
        for i, spec in enumerate(normalized):
            nid = spec['target_node_id'] or ('mcp_' + uuid.uuid4().hex)
            node = next((n for n in nodes if n.get('id') == nid), None)
            if node and (node.get('running') or node.get('studioJobState') in ('queued','running','paused','submitting','uncertain')): raise HTTPException(409, '请先完成或核对节点的已有任务，再修改此节点。')
            if node is None:
                node = {'id': nid, 'type': 'generator' if spec['kind'] == 'image' else 'video',
                        'x': right + (i % 3) * 1160, 'y': (i // 3) * 1300, 'w': 660, 'inputs': [], 'count': 1}
                nodes.append(node)
            conns[:] = [c for c in conns if c.get('to') != nid]
            node.update(studioTitle=spec['title'], studioPrompt=spec['prompt'], apiProvider=spec['provider_id'],
                        model=spec['model'], studioParams=spec['params'], studioParamsModel=spec['model'],
                        studioRefs=[], studioExcludedRefs=[], studioRefRoles={}, studioRefOrder=[], studioRefLabels={},
                        studioAssetRefs=[], multimodal=True, useFrameRoles=False, studioReferenceChoice=True)
            for ri, ref in enumerate(spec['references']):
                source_ref = next((r for r in (next((e for e in raw_nodes if e.get('key') == spec['key']), {}).get('references') or [])
                                   if r.get('version_id') == ref['version_id']), {})
                role = source_ref.get('role')
                if role and role not in ('first_frame','last_frame'):raise HTTPException(400,'参考素材角色仅支持首帧或尾帧。')
                source = next((n for n in nodes if n.get('type') == 'image' and n.get('url') == ref['url']), None)
                if source is None:
                    source = {'id': 'mcp_ref_' + uuid.uuid4().hex, 'type': 'image', 'url': ref['url'], 'name': ref['name'],
                              'mediaKind': ref['kind'], 'x': node['x'] - 380, 'y': node['y'] + ri * 300, 'w': 280, 'h': 260,
                              'studioAssetRefs': [{'version_id': ref['version_id'], 'asset_id': ref['asset_id'],
                                                   'project_id': ctx['project_id'], 'url': ref['url']}]}
                    nodes.append(source)
                node['studioRefOrder'].append(ref['url']); node['studioRefLabels'][ref['url']] = ref['mention']
                node['studioAssetRefs'].append({'version_id': ref['version_id'], 'asset_id': ref['asset_id'],
                                                'project_id': ctx['project_id'], 'url': ref['url'], 'role': role})
                node['studioRefs'].append({'version_id': ref['version_id'], 'asset_id': ref['asset_id'], 'url':ref['url'],
                                           'name':ref['name'], 'label':ref['mention'], 'kind':ref['kind'], 'role':role})
                if role: node['studioRefRoles'][ref['url']] = role
                conns.append({'id': 'mcp_conn_' + uuid.uuid4().hex, 'from': source['id'], 'to': nid})
            if node['studioRefRoles']:
                if spec['kind']!='video':raise HTTPException(400,'首尾帧角色只适用于视频节点。')
                node['useFrameRoles']=True;node['multimodal']=False
                roles=list(node['studioRefRoles'].values())
                if len(roles)!=len(spec['references']) or roles.count('first_frame')!=1 or roles.count('last_frame')>1 or any(r['kind']!='image' for r in spec['references']):
                    raise HTTPException(400,'请指定一个首帧和至多一个尾帧。')
            created[spec['key']] = nid
        result = {'canvas_id': canvas_id, 'node_ids': created, 'revision': plans.revision(canvas)}
        return graph.commit_edit(canvas, journal, operation_id, fingerprint, 'apply_nodes', snapshot, result)


def _undo(canvas_id, payload):
    return graph.undo(canvas_id, payload)


def _control_request(canvas_id, node, request_id, check=True):
    from studio_control_inputs import node_request, request_fingerprint
    payload = node_request(_canvas(canvas_id), node, request_id)
    if check: generation.checked(payload)
    return payload, request_fingerprint(payload)


async def _generate(canvas_id, node_id, request_id):
    import re
    if not isinstance(request_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}', request_id): raise HTTPException(400, 'request_id 格式无效。')
    state = _load(); old = state['runs'].get('gen:' + request_id)
    if old and (old.get('canvas_id') != canvas_id or old.get('node_id') != node_id): raise HTTPException(409, 'request_id 已绑定到其他节点。')
    if old and old.get('status') == 'rejected': return {'status':'rejected'}
    if old:
        if old.get('status') == 'pending': return {'approval_required': True, 'approval_id': old['approval_id']}
        if old.get('job_id'): return {'job_id': old['job_id'], 'status': old.get('status', 'queued')}
        if old.get('status') == 'submitting': return {'request_id': request_id, 'status': 'uncertain'}
    canvas = _canvas(canvas_id); node = next((n for n in canvas.get('nodes', []) if n.get('id') == node_id), None)
    if not node or node.get('type') not in ('generator', 'video'): raise HTTPException(404, '生成节点不存在。')
    if node.get('running') or node.get('studioJobState') in ('queued','running','paused','submitting','uncertain'):
        raise HTTPException(409, '节点正在运行或等待核对。')
    payload, digest = _control_request(canvas_id, node, request_id)
    # Paid generation is gated by explicit approval or a bounded browser session.
    with LOCK:
        state = _load()
        if state.get('generation_mode') == 'session' and state.get('session_expires_at', 0) and state['session_expires_at'] > time.time() and state.get('remaining_runs', 0) > 0:
            if old is None:
                state['remaining_runs'] -= 1
            state['runs']['gen:' + request_id] = {'status': 'submitting', 'canvas_id': canvas_id, 'node_id': node_id, 'digest': digest, 'charged': True}
            _save(state)
        else:
            approval_id = uuid.uuid4().hex
            import studio_comfy, studio_dreamina
            if (node.get('apiProvider') or node.get('provider_id')) == studio_comfy.PROVIDER:
                quote='本地运行，不扣 API 额度。'
            elif (node.get('apiProvider') or node.get('provider_id')) == studio_dreamina.PROVIDER:
                quote='使用本机即梦账号，费用/积分以即梦账号实际账单为准。'
            else:
                quote='暂无可靠估价；费用以 API 实际账单为准。'
            state['pending'].append({'id': approval_id, 'request_id': request_id, 'canvas_id': canvas_id, 'node_id': node_id,
                                     'digest': digest, 'status': 'pending', 'created_at': time.time(), 'quote':quote,
                                     'input':payload.model_dump(),'title':node.get('studioTitle') or node.get('name','')})
            state['runs']['gen:' + request_id] = {'status': 'pending', 'approval_id': approval_id, 'canvas_id': canvas_id,
                                                   'node_id': node_id, 'digest': digest}
            _save(state)
            return {'approval_required': True, 'approval_id': approval_id}
    return await _submit_generation(canvas_id, node_id, request_id, digest, node, payload)


async def _submit_generation(canvas_id, node_id, request_id, digest, node, payload):
    result = await generation.submit(payload)
    state = _load(); row = state['runs'].get('gen:' + request_id, {})
    row.update(status=result.get('status'), job_id=result.get('id'), digest=digest, canvas_id=canvas_id, node_id=node_id)
    state['runs']['gen:' + request_id] = row; _save(state)
    canvas = _canvas(canvas_id); target = next((n for n in canvas.get('nodes', []) if n.get('id') == node_id), None)
    if target:
        target['running'] = True; target['studioJob'] = result.get('id'); target['studioJobState'] = result.get('status')
        target['studioControlJob'] = result.get('id')
        _touch(canvas)
    worker = generation.WORKERS.get(result.get('id'))
    if worker:
        _track_worker(worker, canvas_id, node_id, result.get('id'))
    return {'job_id': result.get('id'), 'status': result.get('status')}


def _track_worker(worker, canvas_id, node_id, job_id):
    worker.add_done_callback(lambda _task, cid=canvas_id, nid=node_id, jid=job_id: _job_done(cid,nid,jid))


def _job_done(canvas_id, node_id, job_id):
    try:
        job = generation.public(generation.read(job_id))
        with plans.APPLY_LOCK:
            canvas = _canvas(canvas_id)
            node = next((n for n in canvas.get('nodes', []) if n.get('id') == node_id), None)
            if not node or node.get('studioJob') != job_id: return
            outputs = job.get('outputs', [])
            accepted = set(node.get('studioAccepted') or [])
            fresh = [o for o in outputs if o.get('url') not in accepted]
            output_ids={c.get('to') for c in canvas.get('connections',[]) if c.get('from')==node_id}
            output_node=next((n for n in canvas['nodes'] if n.get('id') in output_ids and n.get('type')=='output'),None)
            needs_output=bool(outputs) and output_node is None
            if (node.get('studioJobState') == job.get('status') and node.get('studioJobError', '') == job.get('error', '')
                    and not fresh and not needs_output and node.get('studioJobResult', {}).get('outputs') == outputs):
                return
            node['running'] = False; node['studioJobState'] = job.get('status'); node['studioJobError'] = job.get('error', '')
            if fresh:
                node['studioAccepted'] = list(accepted | {o.get('url') for o in fresh if o.get('url')})
                if node.get('type') == 'generator':
                    node['images'] = (node.get('images') or []) + [o for o in fresh if o.get('kind') == 'image']
                else:
                    node['videos'] = (node.get('videos') or []) + [o for o in fresh if o.get('kind') == 'video']
                node['generatedOutputs'] = (node.get('generatedOutputs') or []) + fresh
            if outputs:
                if output_node is None:
                    output_node={'id':'mcp_out_'+uuid.uuid4().hex,'type':'output','x':node.get('x',0),'y':node.get('y',0)+680,
                                 'w':480,'images':[],'studioTitle':(node.get('studioTitle') or '生成')+' · 结果'}
                    canvas['nodes'].append(output_node)
                    canvas.setdefault('connections',[]).append({'id':'mcp_conn_'+uuid.uuid4().hex,'from':node_id,'to':output_node['id']})
                seen_urls={v if isinstance(v,str) else v.get('url') for v in output_node.get('images',[])}
                output_node.setdefault('images',[]).extend(o for o in outputs if o.get('url') not in seen_urls)
            node['studioJobResult'] = {'status': job.get('status'), 'error': job.get('error', ''), 'outputs': job.get('outputs', [])}
            _touch(canvas)
        state = _load(); row = state['runs'].get('gen:' + job.get('id'), {})
        # Request keyed record is maintained separately; update matching job id.
        for key, value in state['runs'].items():
            if key.startswith('gen:') and value.get('job_id') == job_id: value['status'] = job.get('status')
        _save(state)
    except Exception:
        return


async def _approve(approval_id, payload):
    action = payload.get('action')
    if action not in ('approve', 'reject'): raise HTTPException(400, "action 必须为 'approve' 或 'reject'。")
    state = _load(); item = next((p for p in state['pending'] if p.get('id') == approval_id), None)
    if not item: raise HTTPException(404, '审批不存在。')
    if item.get('status') != 'pending': return {'status': item['status'], 'job_id': item.get('job_id')}
    if action == 'reject':
        item['status'] = 'rejected'; state['runs']['gen:' + item['request_id']]['status'] = 'rejected'; _save(state)
        return {'status': 'rejected'}
    if not state.get('enabled'): raise HTTPException(403, '本地智能体控制已禁用。')
    canvas = _canvas(item['canvas_id']); node = next((n for n in canvas.get('nodes', []) if n.get('id') == item['node_id']), None)
    if not node: raise HTTPException(404, '生成节点不存在。')
    if node.get('running') or node.get('studioJobState') in ('queued','running','paused','submitting','uncertain'):
        raise HTTPException(409, '节点正在运行或等待核对。')
    payload, current = _control_request(item['canvas_id'], node, item['request_id'], check=False)
    if current != item['digest']: raise HTTPException(409, '节点内容在审批后发生变化，请重新申请审批。')
    generation.checked(payload)
    item['status'] = 'submitting'; _save(state)
    result = await _submit_generation(item['canvas_id'], item['node_id'], item['request_id'], item['digest'], node, payload)
    state = _load(); item = next((p for p in state['pending'] if p.get('id') == approval_id), None)
    item.update(status='approved', job_id=result.get('job_id')); _save(state)
    return result


def _tool_auth(request):
    state = _load()
    if not state.get('enabled'): raise HTTPException(403, '本地智能体控制已禁用。')
    token = request.headers.get('authorization', '')
    if not token.startswith('Bearer ') or not secrets.compare_digest(token[7:], state['token']):
        raise HTTPException(401, 'Bearer token 无效。')
    return state


def install(app):
    _load()
    @app.get('/api/studio/control/settings')
    async def get_settings(request: Request): return _settings(_load(), str(request.base_url).rstrip('/'))

    def codex_configuration(request):
        return client_configuration(sys.executable, Path(__file__).parent,
            Path(core.DATA_DIR).parent, str(request.base_url).rstrip('/'),
            os.environ.get('DEEPWHITE_INSTALL_ROOT'))

    @app.get('/api/studio/control/codex')
    async def codex_status(request: Request):
        import studio_codex_setup
        return studio_codex_setup.status(codex_configuration(request))

    @app.post('/api/studio/control/codex')
    async def codex_setup(payload: dict, request: Request):
        import studio_codex_setup
        # A client-config write is explicitly initiated by this local settings
        # page. It is never an MCP tool and cannot target a caller-supplied path.
        if (request.headers.get('origin') != str(request.base_url).rstrip('/') or
                request.headers.get('content-type', '').split(';')[0].strip() != 'application/json'):
            raise HTTPException(403, '请从这台电脑的画布设置页面配置 Codex。')
        if payload.get('action') == 'install' and not _load().get('enabled'):
            raise HTTPException(403, '请先启用 MCP 访问，再自动配置 Codex。')
        try:
            return studio_codex_setup.configure(codex_configuration(request), payload)
        except studio_codex_setup.SetupError as exc:
            raise HTTPException(exc.status_code, str(exc)) from None

    def local_page_only(request):
        # Client configuration writes are initiated only by this machine's own
        # settings page; MCP tools and other origins can never reach them.
        if (request.headers.get('origin') != str(request.base_url).rstrip('/') or
                request.headers.get('content-type', '').split(';')[0].strip() != 'application/json'):
            raise HTTPException(403, '请从这台电脑的画布设置页面操作外接客户端。')

    @app.get('/api/studio/clients')
    async def clients(request: Request):
        import studio_clients
        return studio_clients.listing(codex_configuration(request))

    @app.post('/api/studio/clients/{client_id}')
    async def client_action(client_id: str, payload: dict, request: Request):
        import studio_clients
        local_page_only(request)
        if client_id not in studio_clients.CLIENTS:
            raise HTTPException(404, '不支持的客户端。')
        action = payload.get('action')
        if action not in ('connect', 'disconnect', 'install_skills') or set(payload) - {'action'}:
            raise HTTPException(400, '操作无效，请刷新页面重试。')
        if action == 'connect' and not _load().get('enabled'):
            state = _load(); state['enabled'] = True; _save(state)  # Connecting implies allowing MCP access.
        configuration = codex_configuration(request)
        try:
            if action == 'install_skills':
                result = {'skills': studio_clients.install_skills(client_id),
                          'message': '已安装最新 Skills。' + studio_clients.CLIENTS[client_id].get(
                              'restart_hint', '请重启该客户端。')}
            else:
                result = studio_clients.connect(client_id, configuration, remove=action == 'disconnect')
        except studio_clients.ClientError as exc:
            raise HTTPException(exc.status_code, str(exc)) from None
        except OSError:
            raise HTTPException(409, '未能写入客户端文件，请检查目录权限或文件占用后重试；原文件已保留。') from None
        return {**result, 'client': studio_clients.describe(client_id, configuration)}

    @app.get('/api/studio/clients/skills/{skill_id}.zip')
    async def skill_archive(skill_id: str):
        import studio_clients
        from fastapi.responses import Response
        try:
            data = studio_clients.skill_zip(skill_id)
        except studio_clients.ClientError as exc:
            raise HTTPException(exc.status_code, str(exc)) from None
        return Response(data, media_type='application/zip',
                        headers={'Content-Disposition': f'attachment; filename="{skill_id}.zip"'})

    @app.get('/api/studio/control/skill')
    async def skill_template():
        from fastapi.responses import PlainTextResponse
        relative = Path('integrations') / 'skills' / 'deepwhite-canvas' / 'SKILL.md'
        root = Path(__file__).resolve().parent.parent
        for candidate in (root / relative, root / 'references' / relative):
            if candidate.is_file():
                return PlainTextResponse(candidate.read_text(encoding='utf-8'),
                    headers={'Content-Disposition': 'attachment; filename="SKILL.md"'})
        raise HTTPException(404, '当前安装缺少 Skill 示例，请检查完整发行包。')

    @app.put('/api/studio/control/settings')
    async def put_settings(payload: dict, request: Request):
        allowed = {'enabled', 'generation_mode', 'session_minutes', 'session_runs'}
        if set(payload) - allowed: raise HTTPException(400, '设置包含不支持的字段。')
        if 'enabled' in payload and not isinstance(payload['enabled'], bool): raise HTTPException(400, 'enabled 必须为布尔值。')
        mode = payload.get('generation_mode', 'confirm')
        if mode not in ('confirm', 'session'): raise HTTPException(400, 'generation_mode 无效。')
        state = _load(); state['enabled'] = payload.get('enabled', state['enabled']); state['generation_mode'] = mode
        if not state['enabled']:
            state['session_expires_at'] = None; state['remaining_runs'] = 0
        elif mode == 'session':
            minutes = payload.get('session_minutes', 30); runs = payload.get('session_runs', 20)
            if not isinstance(minutes, int) or not 1 <= minutes <= 30 or not isinstance(runs, int) or not 1 <= runs <= 20:
                raise HTTPException(400, 'session 最多 30 分钟、20 次。')
            state['session_expires_at'] = time.time() + minutes * 60; state['remaining_runs'] = runs
        else:
            state['session_expires_at'] = None; state['remaining_runs'] = 0
        _save(state); return _settings(state, str(request.base_url).rstrip('/'))

    @app.post('/api/studio/control/diagnostics')
    async def diagnostics(request: Request):
        """A subprocess check verifies the same bridge entry with no canvas edits."""
        from studio_mcp import validate_url
        try:
            url = validate_url(str(request.base_url).rstrip('/'))
        except BridgeError as exc:
            raise HTTPException(400, exc.diagnostic()) from None
        environment = dict(os.environ, DEEPWHITE_STUDIO_RUNTIME_DIR=str(Path(core.DATA_DIR).parent),
                           PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1')
        process = None
        try:
            import subprocess
            configuration = client_configuration(sys.executable, Path(__file__).parent,
                Path(core.DATA_DIR).parent, url, os.environ.get('DEEPWHITE_INSTALL_ROOT'))
            entry = configuration['client_config']['mcpServers']['deepwhite-studio']
            arguments = entry['args'] + (['-Check'] if configuration['stable_launcher'] else ['--check', '--json'])
            environment.update(entry.get('env', {}))
            process = await asyncio.create_subprocess_exec(entry['command'], *arguments,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env=environment,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=15)
            if len(stdout) > 64 * 1024:
                raise ValueError('oversized diagnostics')
            if not stdout.strip() and any(marker in stderr.lower() for marker in
                    (b'pssecurityexception', b'unauthorizedaccess', b'executionpolicies')):
                return {'ok': False, 'checks': [{'step': '客户端启动入口', 'ok': False, 'code': 'script_policy_blocked',
                    'message': 'PowerShell 或组织策略阻止执行此本地启动脚本。',
                    'hint': '入口只设置当前启动进程的执行策略；组织强制策略仍有效。请由管理员检查此文件的执行权限，不要关闭系统防护。'}]}
            result = json.loads(stdout.decode('utf-8'))
            if not isinstance(result, dict) or not isinstance(result.get('checks'), list):
                raise ValueError('invalid diagnostics')
            return result
        except asyncio.TimeoutError:
            return {'ok': False, 'checks': [{'step': '桥接进程', 'ok': False, 'code': 'diagnostic_timeout',
                'message': '连接检查超过 15 秒。', 'hint': '确认画布没有正在退出或更新，再重试。'}]}
        except (OSError, ValueError, UnicodeError):
            return {'ok': False, 'checks': [{'step': '桥接进程', 'ok': False, 'code': 'bridge_start_failed',
                'message': '桥接检查程序无法启动或返回数据无效。', 'hint': '请检查安装文件完整性与当前用户的执行权限。'}]}
        finally:
            if process and process.returncode is None:
                process.kill()
                await process.wait()

    @app.post('/api/studio/control/approvals/{approval_id}')
    async def approval(approval_id: str, payload: dict): return await _approve(approval_id, payload)

    @app.post('/api/studio/control/call')
    async def call(request: Request, payload: dict):
        _tool_auth(request)
        name = payload.get('name'); args = payload.get('arguments', {})
        if not isinstance(name, str) or name not in TOOLS or not isinstance(args, dict): raise HTTPException(400, '未知工具或 arguments 格式错误。')
        try:
            _validate(args, TOOL_SCHEMAS[name])
            if len(json.dumps(args, ensure_ascii=False, allow_nan=False).encode('utf-8')) > 256 * 1024:
                raise BridgeError('单次控制请求不能超过 256 KB。')
        except (BridgeError, ValueError, UnicodeError) as exc:
            raise HTTPException(400, str(exc)) from None
        if name in graph.TOOLS:
            return {'result': graph.call(name, args)}
        if name in packages.TOOLS:
            return {'result': packages.call(name, args)}
        if name == 'submit_feedback':
            import studio_feedback
            return {'result': await studio_feedback.submit(args, source='mcp')}
        if name == 'list_canvases':
            return {'result': {'items': [x for x in core.list_canvases() if not x.get('deleted_at') and
                core.normalize_canvas_kind(x.get('kind')) != 'smart' and
                (not args.get('project_id') or (x.get('project') or 'default') == args['project_id'])]}}
        if name == 'get_canvas':
            canvas = _canvas(args.get('canvas_id', '')); return {'result': {'canvas': _public_canvas(canvas), 'revision': plans.revision(canvas)}}
        if name == 'list_models': return {'result': {'items': _models()}}
        if name == 'list_assets':
            project = args.get('project_id')
            if not isinstance(project, str) or not project: raise HTTPException(400, 'project_id 必填。')
            return {'result': {'items': plans.project_assets(project)}}
        if name == 'apply_nodes': return {'result': _apply(args.get('canvas_id',''), args)}
        if name == 'undo_edit': return {'result': _undo(args.get('canvas_id',''), args)}
        if name == 'generate_node':
            rid = args.get('request_id')
            if not isinstance(rid, str): raise HTTPException(400, 'request_id 必填。')
            return {'result': await _generate(args.get('canvas_id',''), args.get('node_id',''), rid)}
        if name in ('get_generation', 'resume_generation'):
            jid = args.get('job_id'); state = _load()
            run = next((v for k,v in state['runs'].items() if k.startswith('gen:') and v.get('job_id') == jid), None)
            if not run: raise HTTPException(404, '此任务不属于本控制器。')
            job = generation.read(jid)
            if name == 'resume_generation' and job.get('status') in ('paused',):
                generation.start(jid)
                worker = generation.WORKERS.get(jid)
                if worker: _track_worker(worker, run['canvas_id'], run['node_id'], jid)
            elif name == 'resume_generation' and job.get('status') == 'uncertain': raise HTTPException(409, '提交结果待核实，不会重发。')
            elif job.get('status') in generation.TERMINAL: _job_done(run['canvas_id'], run['node_id'], jid)
            return {'result': generation.public(generation.read(jid))}
