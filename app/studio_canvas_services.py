"""Shared canvas revision, asset context and validated generation-node drafts.

No conversation, assistant session or model inference dependency lives here.
"""
import copy
import hashlib
import json
import re
import threading
import uuid
from pathlib import Path
from fastapi import HTTPException
import main as core
import studio_assets as assets
import studio_catalog as catalog
from studio_capabilities import profile

APPLY_LOCK = threading.RLock()
TOKEN = re.compile(r'\{\{asset:([a-f0-9]{32})\}\}')
ACTIVE_JOB_STATES = {'queued','submitting','submitted','running','paused','uncertain','polling','cancelling','canceling'}


def node_job_active(node):
    state=str(node.get('studioJobState') or node.get('jobState') or '').strip().lower()
    return bool(node.get('running')) or state in ACTIVE_JOB_STATES


def revision(canvas):
    def clean(value):
        if isinstance(value, dict):
            result={}
            for key,item in value.items():
                if key=='studioAssetRefs':continue
                if key=='studioSkillNode' and isinstance(item,dict):
                    result[key]={k:clean(v) for k,v in item.items() if k not in ('status','statusLabel')}
                else:result[key]=clean(item)
            return result
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value
    return hashlib.sha256(json.dumps(clean({'nodes':canvas.get('nodes',[]),
        'connections':canvas.get('connections',[])}),sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def project_assets(project_id):
    with assets.connect() as db:
        rows=db.execute('SELECT * FROM versions WHERE project_id=? ORDER BY created_at DESC LIMIT 500',(project_id,)).fetchall()
    return [assets.public(row) for row in rows]


def context(canvas_id, node_ids=None, asset_version_ids=None):
    canvas=core.load_canvas(canvas_id)
    project=canvas.get('project') or 'default'
    wanted=set(node_ids or [])
    if len(wanted)>60 or len(asset_version_ids or [])>40:
        raise HTTPException(400,'一次最多选择 60 个节点和 40 项资产。')
    selected=[n for n in canvas.get('nodes',[]) if n.get('id') in wanted]
    if len(selected)!=len(wanted):
        raise HTTPException(409,'所选节点已变更，请重新选择。')
    version_ids=set(asset_version_ids or [])
    for node in selected:
        version_ids.update(r['version_id'] for r in node.get('studioAssetRefs',[]) if isinstance(r,dict) and r.get('version_id'))
    refs=[]
    for vid in sorted(version_ids):
        item=assets.public(assets._row(vid))
        if item['project_id']!=project:
            raise HTTPException(400,'不能读取其他项目的资产。')
        refs.append({k:item[k] for k in ('version_id','asset_id','name','kind','url','missing')})
    nodes=[]
    for n in selected:
        nodes.append({'id':n['id'],'type':n.get('type'),'title':n.get('studioTitle') or n.get('name',''),
          'prompt':str(n.get('studioPrompt') or n.get('text') or n.get('userInput') or '')[:20000],
          'agent_node_kind':n.get('studioAgentNodeKind'),'attachment_id':n.get('studioAgentAttachmentId'),
          'asset_version_ids':[r['version_id'] for r in n.get('studioAssetRefs',[]) if isinstance(r,dict) and r.get('version_id')]})
    return {'canvas_id':canvas_id,'project_id':project,'base_updated_at':canvas.get('updated_at',0),
        'base_revision':revision(canvas),'nodes':nodes,'assets':refs,'models':[]}


def validate_plan(raw, ctx, targets):
    if raw is None:
        return None
    if not isinstance(raw,dict) or not isinstance(raw.get('nodes'),list) or not 1<=len(raw['nodes'])<=40:
        raise HTTPException(400,'节点方案需要包含 1–40 个节点。')
    current=core.load_canvas(ctx['canvas_id'])
    live={n['id']:n for n in current.get('nodes',[])}
    seen=set(); updates=set(); normalized=[]
    for entry in raw['nodes']:
        if not isinstance(entry,dict):raise HTTPException(400,'节点方案格式错误。')
        key=str(entry.get('key',''))
        if not re.fullmatch(r'[\w-]{1,80}',key) or key in seen:raise HTTPException(400,'节点方案编号缺失或重复。')
        seen.add(key)
        kind=entry.get('kind')
        if kind not in ('image','video'):raise HTTPException(400,'此操作只创建图片或视频生成节点。')
        target=(ctx.get('target_models') or {}).get(kind) or {}
        model=next((m for m in targets if m.get('kind')==kind and m.get('provider_id')==target.get('provider_id') and m.get('model')==target.get('model')),None)
        if not model:raise HTTPException(400,'请先选择可用的'+('生图' if kind=='image' else '视频')+'模型，再生成节点方案。')
        title=str(entry.get('title') or key).strip()[:120]
        prompt=entry.get('prompt')
        if not isinstance(prompt,str) or not prompt.strip():raise HTTPException(400,'生成节点缺少提示词。')
        refs=[]; ref_ids=set(); counts={'image':0,'video':0,'audio':0}
        rawrefs=entry.get('references') or []
        if not isinstance(rawrefs,list) or len(rawrefs)>24:raise HTTPException(400,'节点参考素材格式错误或数量过多。')
        for reference in rawrefs:
            if not isinstance(reference,dict):raise HTTPException(400,'参考素材格式错误。')
            vid=reference.get('version_id')
            if vid in ref_ids:raise HTTPException(400,'同一参考素材重复绑定。')
            item=assets.public(assets._row(vid))
            if item['project_id']!=ctx['project_id'] or not assets.file_path(vid):
                raise HTTPException(400,'参考素材不属于当前项目或文件已缺失。')
            if item['kind'] not in counts or (kind=='image' and item['kind']!='image'):
                raise HTTPException(400,'此节点不支持该类型参考素材。')
            ref_ids.add(vid);counts[item['kind']]+=1
            mention='@'+{'image':'图片','video':'视频','audio':'音频'}[item['kind']]+str(counts[item['kind']])
            refs.append({'version_id':vid,'asset_id':item['asset_id'],'url':item['url'],'kind':item['kind'],
                'label':str(reference.get('label') or item['name'])[:120], 'name':item['name'],'mention':mention})
        if any(vid not in ref_ids for vid in TOKEN.findall(prompt)):
            raise HTTPException(400,'提示词引用了未绑定的资产版本。')
        mapping={r['version_id']:r['mention'] for r in refs}
        prompt=TOKEN.sub(lambda m:mapping[m.group(1)],prompt).strip()
        if '{{asset:' in prompt:raise HTTPException(400,'素材引用标记不完整。')
        for mark in re.findall(r'@(图片|视频|音频)\s*([0-9]+)',prompt):
            if '@'+''.join(mark) not in mapping.values():raise HTTPException(400,'提示词中的素材编号没有对应输入。')
        if re.search(r'@(Image|Video|Audio)\s*\d+',prompt,re.I):
            raise HTTPException(400,'请使用绑定资产标记，不要手写接口素材编号。')
        if refs and kind=='video':
            missing=[r for r in refs if r['mention'] not in prompt]
            if missing:prompt+='\n参考素材：'+'；'.join(r['mention']+'：'+r['label'] for r in missing)
        import studio_dreamina
        if model['provider_id']==studio_dreamina.PROVIDER:
            spec=studio_dreamina.spec(model['model'])
        else:
            resolved=catalog.resolve_model(model['provider_id'],model['model'],kind,
                [r for r in refs if r['kind']=='image'],[r for r in refs if r['kind']=='video'],[r for r in refs if r['kind']=='audio'],True)
            spec=profile(resolved,kind)
        if not spec['supported']:raise HTTPException(400,'所选模型尚未适配此功能。')
        if not spec['prompt_min']<=len(prompt)<=spec['prompt_max']:raise HTTPException(400,f'“{title}”提示词长度不符合模型要求，请调整后重试。')
        for media,number in counts.items():
            if number>spec['max_'+{'image':'images','video':'videos','audio':'audios'}[media]]:
                raise HTTPException(400,f'“{title}”的{media}参考素材超过模型限制。')
        target_id=str(entry.get('target_node_id') or '')
        if target_id:
            n=live.get(target_id)
            if target_id in updates or not n or n.get('type')!=('generator' if kind=='image' else 'video'):
                raise HTTPException(409,'要更新的节点不存在、重复或类型不匹配。')
            if node_job_active(n):raise HTTPException(409,'任务尚未确认结束的节点不能被外部控制器修改。')
            updates.add(target_id)
        normalized.append({'key':key,'kind':kind,'title':title,'prompt':prompt,'references':refs,
            'target_node_id':target_id,'provider_id':model['provider_id'],'model':model['model'],
            'params':{k:v['default'] for k,v in spec['fields'].items()}})
    return {'id':uuid.uuid4().hex,'canvas_id':ctx['canvas_id'],'project_id':ctx['project_id'],
        'base_updated_at':ctx['base_updated_at'],'base_revision':ctx['base_revision'],'nodes':normalized}
