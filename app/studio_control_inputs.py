"""Compile saved ordinary-canvas inputs for both approval and MCP execution."""
import hashlib,json,re
from urllib.parse import urlsplit
from fastapi import HTTPException
import studio_assets as assets
from studio_generation import Generation


# F06: what external agents may start, and why the rest must be run on the canvas.
UNSUPPORTED={
    'runninghub':'RunningHub 工作流需要在画布中选择流程、上传素材并按积分确认，外部智能体暂不能发起；可以读取和编辑该节点，请在画布中点击运行。',
    'audio':'音频（配音、音乐、音效）生成暂不支持由外部智能体发起；可以编辑节点，请在画布中点击生成。',
    'midjourney':'MJ 工具节点使用独立的任务与回执流程，外部智能体暂不能发起；请在画布中执行。',
}


def node_request(canvas,node,request_id):
    if node.get('type') in UNSUPPORTED:
        raise HTTPException(400,UNSUPPORTED[node['type']])
    if node.get('type') not in ('generator','video'):
        raise HTTPException(400,'外部智能体只能发起图片和视频生成节点；其他节点可以读取和编辑，请在画布中运行。')
    if str(node.get('model') or '').startswith('midjourney-'):
        # The generic image adapter would send it to the wrong endpoint.
        raise HTTPException(400,'MJ 生成使用独立的任务与回执流程，外部智能体暂不能发起；请在画布中点击生成。')
    project=canvas.get('project') or 'default'
    indexed={n['id']:n for n in canvas.get('nodes',[])}
    refs=[];texts=[]
    def media(item,owner=None):
        value={'url':item} if isinstance(item,str) else dict(item or {})
        if not value.get('url'):return
        owner=owner or {}
        value.setdefault('name',owner.get('name','参考素材'))
        value.setdefault('kind',owner.get('mediaKind') or '')
        for asset in owner.get('studioAssetRefs',[]):
            if value['url'] in (asset.get('url'),asset.get('source_url')):
                value.setdefault('version_id',asset.get('version_id'));break
        refs.append(value)
    def source(source_node,in_group=False):
        kind=source_node.get('type')
        if kind=='image':media({'url':source_node.get('url'),'role':source_node.get('role','')},source_node)
        elif kind=='prompt':texts.append(str(source_node.get('text') or ''))
        elif kind=='llm':texts.append(str(source_node.get('outputText') or ''))
        elif kind=='output':
            values=[v for v in source_node.get('images',[]) if (v if isinstance(v,str) else v.get('url'))]
            if values:media(values[-1],source_node)
            else:raise HTTPException(409,'连接的结果节点还没有素材，请先完成上游生成。')
        elif kind in ('generator','video'):
            if not source_node.get('generatedOutputs'):raise HTTPException(409,'连接的上游节点还没有生成结果，请先完成上游任务。')
            for value in source_node.get('generatedOutputs',[]):media(value,source_node)
        elif kind=='group' and not in_group:
            for nid in source_node.get('items',[]):
                if nid in indexed:source(indexed[nid],True)
        elif kind=='loop':raise HTTPException(400,'本地智能体暂不执行循环节点，请先把所需素材或文本连接到生成节点。')
    for connection in canvas.get('connections',[]):
        if connection.get('studioRole')=='agent-workflow':continue
        if connection.get('to')==node['id'] and connection.get('from') in indexed:
            source(indexed[connection['from']])
    texts.append(str(node.get('studioPrompt') or node.get('text') or node.get('userInput') or ''))
    for value in node.get('studioRefs',[]):media(value,node)
    excluded=set(node.get('studioExcludedRefs') or [])
    order=node.get('studioRefOrder') or []
    refs.sort(key=lambda r:order.index(r['url']) if r['url'] in order else len(order))
    normalized=[];seen=set();counts={'image':0,'video':0,'audio':0}
    for ref in refs:
        original=ref['url']
        if original in excluded:continue
        vid=ref.get('version_id')
        match=re.fullmatch(r'/api/studio/assets/([a-f0-9]{32})/file(?:\?.*)?',original)
        if match:
            if vid and vid!=match[1]:raise HTTPException(400,'素材编号与地址不一致。')
            vid=match[1]
        if vid:
            item=assets.public(assets._row(vid))
            if not item or item['project_id']!=project:raise HTTPException(400,'参考素材不属于当前项目。')
            if not assets.file_path(vid):raise HTTPException(400,'参考素材文件已缺失。')
        else:
            # Legacy canvas uploads are imported via the existing confined media resolver.
            if urlsplit(original).scheme or not original.startswith('/'):
                raise HTTPException(400,'请先将参考素材导入当前项目资产，再交给本地智能体使用。')
            item=assets.register_local(original,name=ref.get('name',''),project_id=project)
            vid=item['version_id']
        if vid in seen:continue
        seen.add(vid);kind=item['kind']
        if ref.get('kind') and ref['kind']!=kind:raise HTTPException(400,'素材类型与已保存资产不一致。')
        counts[kind]+=1
        role=(node.get('studioRefRoles') or {}).get(original,ref.get('role') or '')
        label=(node.get('studioRefLabels') or {}).get(original) or ref.get('mention')
        out={'url':item['url'],'kind':kind,'name':item['name'],'role':role,'version_id':vid}
        if label:out['mention']=label
        else:out['mention']='@'+{'image':'图片','video':'视频','audio':'音频'}[kind]+str(counts[kind])
        normalized.append(out)
    if node.get('useFrameRoles'):
        roles=[r['role'] for r in normalized]
        if any(r not in ('first_frame','last_frame') for r in roles) or roles.count('first_frame')!=1 or roles.count('last_frame')>1:
            raise HTTPException(400,'首尾帧模式需要明确指定一个首帧和至多一个尾帧。')
    try:
        return Generation(request_id=request_id,canvas_id=canvas['id'],node_id=node['id'],
            provider_id=node.get('apiProvider') or node.get('provider_id') or '',model=node.get('model') or '',
            kind='image' if node['type']=='generator' else 'video',prompt='\n\n'.join(t for t in texts if t.strip()),
            params=node.get('studioParams') or {},references=normalized,
            count=node.get('count') or 1,multimodal=bool(node.get('multimodal',True)),frame_mode=bool(node.get('useFrameRoles')))
    except ValueError as exc:raise HTTPException(400,'节点参数、提示词或请求编号格式不正确。') from exc


def request_fingerprint(payload):
    return hashlib.sha256(json.dumps(payload.model_dump(),sort_keys=True,ensure_ascii=False).encode()).hexdigest()
