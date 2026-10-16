"""Saved, versioned local ComfyUI API workflows and durable task polling."""
import copy
import hashlib
import json
import math
import os
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException
import main as core
import studio_comfy_engine as engine

MAX_WORKFLOW_BYTES = 12 * 1024 * 1024
FIELD_TYPES = {'text', 'number', 'bool', 'enum', 'seed', 'model', 'image', 'video', 'audio'}
SUBMIT_LOCK = __import__('asyncio').Lock()
UPDATE_LOCK = __import__('asyncio').Lock()
WIDGET_TYPES = {'INT','INTEGER','FLOAT','NUMBER','STRING','STR','BOOLEAN','BOOL'}
JS_SAFE_INTEGER = 9007199254740991


def _wire(value):
    """Keep browser JSON exact without changing the persisted/execution graph."""
    if isinstance(value, bool): return value
    if isinstance(value, int): return str(value) if abs(value)>JS_SAFE_INTEGER else value
    if isinstance(value, float) and (not math.isfinite(value) or (value.is_integer() and abs(value)>JS_SAFE_INTEGER)): raise HTTPException(400,'数值已超出可确认的浮点精度；整数请使用十进制字符串。')
    if isinstance(value, list): return [_wire(item) for item in value]
    if isinstance(value, dict): return {key:_wire(item) for key,item in value.items()}
    return value


def _integer(value, label):
    if isinstance(value, bool): raise HTTPException(400,f'参数“{label}”需要整数。')
    if isinstance(value, int): return value
    if isinstance(value, str) and re.fullmatch(r'-?[0-9]{1,1000}',value): return int(value)
    if isinstance(value, float) and math.isfinite(value) and abs(value)<=JS_SAFE_INTEGER and value.is_integer(): return int(value)
    raise HTTPException(400,f'参数“{label}”需要精确整数；超出安全范围时请使用十进制字符串。')


def _definition(prompt, field, info):
    schema=info.get(prompt[field['node_id']]['class_type'],{}).get('input',{}) if info else {}
    return next((schema.get(group,{}).get(field['input']) for group in ('required','optional') if field['input'] in schema.get(group,{})),None)


def _integer_definition(definition):
    return isinstance(definition,list) and bool(definition) and str(definition[0]).upper() in ('INT','INTEGER')


def _enum_choices(definition):
    if not isinstance(definition,list) or not definition: return None
    options=definition[1] if len(definition)>1 and isinstance(definition[1],dict) else {}
    choices=definition[0] if isinstance(definition[0],list) else options.get('options')
    if not isinstance(choices,list): return None
    # Decimal wire strings cannot distinguish these two *different* choices.
    # Reject the schema instead of silently selecting the textual option.
    if any(isinstance(value,int) and not isinstance(value,bool) and abs(value)>JS_SAFE_INTEGER and str(value) in choices for value in choices):
        raise HTTPException(400,'枚举同时包含大整数和同值数字文本，无法无损区分；请调整 ComfyUI 节点选项。')
    return choices


def _has_choice(value, choices):
    # Python equates False with 0 and True with 1; JSON enum controls do not.
    return any(value == choice and isinstance(value, bool) == isinstance(choice, bool) for choice in choices)


def _check_info_choices(info):
    for node in info.values():
        for group in ('required','optional'):
            for definition in node.get('input',{}).get(group,{}).values(): _enum_choices(definition)


def _restore_integer_inputs(prompt, info):
    # A decimal-looking STRING/model value remains a string. Only live INT
    # sockets (or an exact numeric enum option) authorize wire restoration.
    for node in prompt.values():
        schema=info.get(node['class_type'],{}).get('input',{})
        for group in ('required','optional'):
            for name,definition in schema.get(group,{}).items():
                if name not in node['inputs'] or isinstance(node['inputs'][name],list): continue
                value=node['inputs'][name]
                choices=_enum_choices(definition)
                if _integer_definition(definition):
                    value=_integer(value,name)
                    options=definition[1] if len(definition)>1 and isinstance(definition[1],dict) else {}
                    if ('min' in options and value<_integer(options['min'],name+'最小值')) or ('max' in options and value>_integer(options['max'],name+'最大值')): raise HTTPException(400,f'参数“{name}”超出 ComfyUI 允许范围。')
                    node['inputs'][name]=value
                elif choices is not None and isinstance(value,str) and value not in choices:
                    match=next((option for option in choices if isinstance(option,int) and not isinstance(option,bool) and str(option)==value),None)
                    if match is not None: node['inputs'][name]=match
                if isinstance(value,float) and (not math.isfinite(value) or (value.is_integer() and abs(value)>JS_SAFE_INTEGER)): raise HTTPException(400,f'参数“{name}”不是安全数值。')
    return prompt


def _widget_definition(definition):
    return isinstance(definition,list) and bool(definition) and (isinstance(definition[0],list) or str(definition[0]).upper() in WIDGET_TYPES or (len(definition)>1 and isinstance(definition[1],dict) and 'widget' in definition[1]))


def _dir(name):
    path = Path(core.DATA_DIR) / 'comfy-workflows' / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read(path):
    try: return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError: raise HTTPException(404, '工作流或任务不存在。')
    except (OSError, ValueError): raise HTTPException(503, '工作流或任务文件损坏或暂不可读取，原文件未覆盖。')


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(temp, path)


def _workflow_id(value):
    value = str(value or '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}', value): raise HTTPException(404, '工作流不存在。')
    return value


def _task_id(value):
    value = str(value or '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}', value): raise HTTPException(404, '任务不存在。')
    return value


def _load(wid): return _read(_dir('workflows') / (_workflow_id(wid) + '.json'))


async def _info(client,base=None):
    response = await client.get((base or engine.base_url()) + '/object_info', timeout=15)
    response.raise_for_status()
    value = response.json()
    if not isinstance(value, dict): raise HTTPException(502, 'ComfyUI object_info 格式无效。')
    return value


def _convert_ui(data, info):
    """Convert regular LiteGraph export to API prompt format using live socket metadata."""
    nodes = data.get('nodes')
    links = data.get('links')
    if not isinstance(nodes, list) or not isinstance(links, list): raise HTTPException(400, 'JSON 不是可转换的 ComfyUI 画布工作流。')
    by_id = {str(node.get('id')): node for node in nodes if isinstance(node, dict)}
    link_map = {}
    for link in links:
        if isinstance(link, dict):
            lid, source, slot, target, target_slot = (link.get(k) for k in ('id','origin_id','origin_slot','target_id','target_slot'))
        elif isinstance(link, list) and len(link) >= 5:
            lid, source, slot, target, target_slot = link[:5]
        else: continue
        link_map[(str(target), int(target_slot))] = [str(source), int(slot)]
    prompt = {}
    for node in nodes:
        if not isinstance(node, dict): continue
        cls = node.get('type') or node.get('class_type')
        if cls not in info: raise HTTPException(400, f'ComfyUI 缺少节点：{cls or "未知"}')
        node_id = str(node.get('id'))
        schema = info[cls].get('input', {})
        inputs = {}
        for group in ('required', 'optional'):
            definitions = schema.get(group, {})
            if not isinstance(definitions, dict): continue
            for key, definition in definitions.items():
                if not isinstance(definition, list) or not definition: continue
                widget = _widget_definition(definition)
                if not widget: continue
                link_id = next((i for i,x in enumerate(node.get('inputs', [])) if isinstance(x,dict) and x.get('name')==key and x.get('link') is not None), None)
                if link_id is not None:
                    link = node['inputs'][link_id].get('link')
                    link_row = next((item for item in links if (isinstance(item,dict) and item.get('id')==link) or (isinstance(item,list) and item[0]==link)), None)
                    if link_row:
                        if isinstance(link_row,dict): inputs[key]=[str(link_row['origin_id']),int(link_row['origin_slot'])]
                        else: inputs[key]=[str(link_row[1]),int(link_row[2])]
                    continue
                order = []
                for g in ('required','optional'):
                    for field, spec in info[cls].get('input',{}).get(g,{}).items():
                        if _widget_definition(spec): order.append(field)
                slot = order.index(key) if key in order else -1
                widgets = node.get('widgets_values') or []
                if 0 <= slot < len(widgets): inputs[key] = widgets[slot]
        for index, socket in enumerate(node.get('inputs') or []):
            if not isinstance(socket,dict) or socket.get('link') is None: continue
            row = next((item for item in links if (isinstance(item,dict) and item.get('id')==socket['link']) or (isinstance(item,list) and item[0]==socket['link'])),None)
            if row:
                if isinstance(row,dict): inputs[socket['name']]=[str(row['origin_id']),int(row['origin_slot'])]
                else: inputs[socket['name']]=[str(row[1]),int(row[2])]
        prompt[node_id] = {'class_type':cls,'inputs':inputs}
    return prompt


def _normalize_prompt(value):
    if isinstance(value, dict) and value and all(isinstance(v,dict) and 'class_type' in v and isinstance(v.get('inputs'),dict) for v in value.values()):
        prompt=value
    elif isinstance(value,dict) and isinstance(value.get('prompt'),dict): prompt=_normalize_prompt(value['prompt'])
    else: raise HTTPException(400,'请提供 ComfyUI API JSON，或可识别节点与连线的普通画布 JSON。')
    if len(prompt)>2000: raise HTTPException(413,'单个工作流最多包含 2000 个节点。')
    for node in prompt.values():
        for item in node['inputs'].values():
            if isinstance(item,str) and len(item)>100000: raise HTTPException(400,'工作流字段值过长。')
    return copy.deepcopy(prompt)


def _validate_bindings(prompt, bindings, info=None):
    if not isinstance(bindings,list) or len(bindings)>200: raise HTTPException(400,'参数映射必须是最多 200 个字段的数组。')
    seen=set(); result=[]
    for raw in bindings:
        if not isinstance(raw,dict): raise HTTPException(400,'参数映射格式无效。')
        node=str(raw.get('node_id','')); key=str(raw.get('input','')); kind=raw.get('type')
        if node not in prompt or key not in prompt[node]['inputs'] or isinstance(prompt[node]['inputs'][key],list): raise HTTPException(400,f'映射目标不存在或不是可编辑字段：{node}.{key}')
        if kind not in FIELD_TYPES: raise HTTPException(400,f'不支持的字段类型：{kind}')
        field_id=str(raw.get('id') or f'{node}:{key}')
        if not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,140}',field_id) or field_id in seen: raise HTTPException(400,'字段 ID 为空或重复。')
        seen.add(field_id)
        entry={'id':field_id,'node_id':node,'input':key,'type':kind,'label':str(raw.get('label') or key)[:120], 'default':raw.get('default',prompt[node]['inputs'][key]),'required':bool(raw.get('required',True))}
        definition=_definition(prompt,entry,info)
        choices=_enum_choices(definition)
        if kind=='enum':
            vals=raw.get('values')
            if not isinstance(vals,list) or not vals or len(vals)>500: raise HTTPException(400,f'{field_id} 需要提供枚举选项。')
            _enum_choices([vals])
            if choices is not None:
                vals=[next((option for option in choices if isinstance(option,int) and not isinstance(option,bool) and isinstance(value,str) and value not in choices and str(option)==value),value) for value in vals]
                if isinstance(entry['default'],str) and entry['default'] not in vals: entry['default']=next((value for value in vals if isinstance(value,int) and str(value)==entry['default']),entry['default'])
            entry['values']=vals
            if not _has_choice(entry['default'], vals):
                raise HTTPException(400,f'参数“{entry["label"]}”的默认值不在枚举选项内。')
        if kind in ('number','seed'):
            for bound in ('min','max','step'):
                if bound in raw:
                    value=raw[bound]
                    if kind=='seed' or _integer_definition(definition): value=_integer(value,bound)
                    if not isinstance(value,(float,int)) or isinstance(value,bool) or (isinstance(value,float) and (not math.isfinite(value) or (value.is_integer() and abs(value)>JS_SAFE_INTEGER))): raise HTTPException(400,f'参数“{entry["label"]}”的范围无效。')
                    entry[bound]=value
            if ('min' in entry and 'max' in entry and entry['max']<entry['min']) or ('step' in entry and entry['step']<=0): raise HTTPException(400,f'参数“{entry["label"]}”的范围无效。')
            entry['default']=_validate_value(entry,entry['default'],definition)
        result.append(entry)
    return result


def _validate_value(field, value, definition=None):
    kind=field['type']; label=field['label']
    if value is None and not field.get('required'): return None
    valid=True
    if kind in ('text','model'): valid=isinstance(value,str) and len(value)<=20000 and (not field.get('required') or bool(value.strip()))
    elif kind in ('number','seed'):
        if kind=='seed' or _integer_definition(definition): value=_integer(value,label)
        valid=isinstance(value,(int,float)) and not isinstance(value,bool) and (not isinstance(value,float) or (math.isfinite(value) and not (value.is_integer() and abs(value)>JS_SAFE_INTEGER)))
    elif kind=='bool': valid=isinstance(value,bool)
    elif kind=='enum':
        choices=_enum_choices(definition)
        if isinstance(value,str) and choices is not None and value not in choices: value=next((option for option in choices if isinstance(option,int) and not isinstance(option,bool) and str(option)==value),value)
        valid=_has_choice(value, field['values'])
    elif kind in ('image','video','audio'): valid=isinstance(value,str) and len(value)<4096
    if kind in ('number','seed') and valid:
        valid=('min' not in field or value>=field['min']) and ('max' not in field or value<=field['max'])
        if (kind=='seed' or _integer_definition(definition)) and 'step' in field:
            step=_integer(field['step'],label+'步长')
            valid=valid and step>0 and (value-field.get('min',0))%step==0
        if isinstance(definition,list) and len(definition)>1 and isinstance(definition[1],dict):
            options=definition[1]
            minimum=_integer(options['min'],label+'最小值') if 'min' in options and _integer_definition(definition) else options.get('min')
            maximum=_integer(options['max'],label+'最大值') if 'max' in options and _integer_definition(definition) else options.get('max')
            valid=valid and (minimum is None or value>=minimum) and (maximum is None or value<=maximum)
    if not valid: raise HTTPException(400,f'参数“{label}”的值类型或范围不匹配。')
    return value


def _validate_graph(prompt,info):
    _restore_integer_inputs(prompt,info)
    missing=sorted({node['class_type'] for node in prompt.values()}-set(info))
    if missing:raise HTTPException(400,'当前 ComfyUI 缺少节点：'+', '.join(missing))
    for node_id,node in prompt.items():
        schema=info[node['class_type']].get('input',{})
        for group in ('required','optional'):
            for name,definition in schema.get(group,{}).items():
                if name not in node['inputs']:
                    if group=='required':raise HTTPException(400,f'工作流缺少必填输入：{node["class_type"]}.{name}')
                    continue
                value=node['inputs'][name]
                if isinstance(value,list):
                    if len(value)!=2 or not isinstance(value[0],(str,int)) or isinstance(value[0],bool) or type(value[1]) is not int or value[1]<0 or str(value[0]) not in prompt:
                        raise HTTPException(400,f'工作流连线无效：{node["class_type"]}.{name}')
                    source=prompt[str(value[0])]
                    sockets=info[source['class_type']].get('output')
                    if isinstance(sockets,list) and value[1]>=len(sockets):
                        raise HTTPException(400,f'工作流连线输出端口不存在：{node["class_type"]}.{name}')
                    continue
                if not isinstance(definition,list) or not definition:continue
                options=definition[1] if len(definition)>1 and isinstance(definition[1],dict) else {}
                choices=_enum_choices(definition)
                if choices is not None and not _has_choice(value, choices):raise HTTPException(400,f'参数值未安装或不兼容：{node["class_type"]}.{name}')
                kind=str(definition[0]).upper()
                if choices is not None or kind in WIDGET_TYPES or 'widget' in options:
                    if kind in ('INT','INTEGER') and (not isinstance(value,int) or isinstance(value,bool)):raise HTTPException(400,f'参数“{name}”需要整数。')
                    if kind in ('FLOAT','NUMBER') and (not isinstance(value,(int,float)) or isinstance(value,bool)):raise HTTPException(400,f'参数“{name}”需要数值。')
                    if kind in ('BOOLEAN','BOOL') and not isinstance(value,bool):raise HTTPException(400,f'参数“{name}”需要开关值。')
                    if kind in ('STRING','STR') and not isinstance(value,str):raise HTTPException(400,f'参数“{name}”需要文本值。')
                    if isinstance(value,(int,float)) and not isinstance(value,bool):
                        minimum=_integer(options['min'],name+'最小值') if 'min' in options and _integer_definition(definition) else options.get('min')
                        maximum=_integer(options['max'],name+'最大值') if 'max' in options and _integer_definition(definition) else options.get('max')
                        if (minimum is not None and value<minimum) or (maximum is not None and value>maximum):raise HTTPException(400,f'参数“{name}”超出 ComfyUI 允许范围。')
    return True


def _outputs(prompt, info):
    result=[]
    for node_id,node in prompt.items():
        schema=info.get(node['class_type'],{})
        names=schema.get('output_names') or []
        types=schema.get('output') or []
        cls=node['class_type'].lower()
        saved_kind='video' if 'savevideo' in cls or 'videocombine' in cls else 'audio' if 'saveaudio' in cls else 'image' if 'saveimage' in cls else None
        # Some custom output nodes expose a generic/empty output socket while
        # their completed history still contains saved media (for example VHS
        # VideoCombine -> ``gifs``). Preserve those as selectable outputs.
        if saved_kind and not any({'IMAGE':'image','VIDEO':'video','AUDIO':'audio'}.get(str(kind).upper()) == saved_kind for kind in types):
            result.append({'node_id':str(node_id),'slot':0,'type':saved_kind,'name':node['class_type']})
        for index,kind in enumerate(types):
            if kind in ('IMAGE','VIDEO','AUDIO'):
                result.append({'node_id':str(node_id),'slot':index,'type':{'IMAGE':'image','VIDEO':'video','AUDIO':'audio'}[kind], 'name':names[index] if index<len(names) else f'output_{index}'})
    return result


def _validate_outputs(prompt,info,requested=None):
    available=_outputs(prompt,info)
    if requested is None:return available
    if not isinstance(requested,list) or len(requested)>100:raise HTTPException(400,'输出映射必须是最多 100 个输出的数组。')
    normalized=[];seen=set()
    for row in requested:
        if not isinstance(row,dict):raise HTTPException(400,'输出映射格式错误。')
        key=(str(row.get('node_id','')),str(row.get('type','')))
        match=next((item for item in available if (item['node_id'],item['type'])==key),None)
        if not match:raise HTTPException(400,'输出映射目标不属于当前工作流。')
        if key not in seen:normalized.append(match);seen.add(key)
    return normalized


async def _persist_audio(client,url,task_id,index,item):
    suffix=Path(str(item.get('filename') or '')).suffix.lower()
    if suffix not in {'.wav','.mp3','.ogg','.flac','.m4a','.opus'}:suffix='.wav'
    name=f'studio-comfy-{task_id}-{index}{suffix}'
    path=Path(core.output_path_for(name));path.parent.mkdir(parents=True,exist_ok=True);temp=path.with_suffix(path.suffix+'.part');total=0
    try:
        async with client.stream('GET',url,follow_redirects=False) as response:
            response.raise_for_status();mime=response.headers.get('content-type','').split(';')[0]
            if mime and not mime.startswith('audio/') and mime!='application/octet-stream':raise HTTPException(502,'ComfyUI 返回的音频格式无效。')
            with temp.open('wb') as stream:
                async for chunk in response.aiter_bytes():
                    total+=len(chunk)
                    if total>1024*1024*1024:raise HTTPException(502,'工作流音频结果超过 1 GB。')
                    stream.write(chunk)
        if not total:raise HTTPException(502,'ComfyUI 返回了空音频。')
        os.replace(temp,path)
    finally:
        if temp.exists():temp.unlink()
    from studio_asset_integration import register_output
    row=register_output(core,core.output_url_for(name),name,{},task_id)
    return {'url':row['url'],'kind':'audio','name':name,'asset_id':row['asset_id'],'version_id':row['version_id'],'asset_url':row['url']}


async def _persist_media(client,url,task,kind,index,item):
    if kind=='audio':return await _persist_audio(client,url,task['id'],index,item)
    suffix=Path(str(item.get('filename') or '')).suffix.lower()
    allowed={'.png','.jpg','.jpeg','.webp','.bmp'} if kind=='image' else {'.mp4','.mov','.webm','.m4v'}
    if suffix not in allowed:suffix='.png' if kind=='image' else '.mp4'
    safe_index=re.sub(r'[^a-zA-Z0-9_-]','_',str(index))
    name=f'studio-comfy-{task["id"]}-{safe_index}{suffix}'
    path=Path(core.output_path_for(name));path.parent.mkdir(parents=True,exist_ok=True);temp=path.with_suffix(path.suffix+'.part');total=0
    async with client.stream('GET',url,follow_redirects=False) as response:
        response.raise_for_status();mime=response.headers.get('content-type','').split(';')[0]
        if mime and mime!='application/octet-stream' and not mime.startswith(kind+'/'):raise HTTPException(502,'ComfyUI 返回的媒体格式与工作流输出类型不匹配。')
        try:
            with temp.open('wb') as stream:
                async for chunk in response.aiter_bytes():
                    total+=len(chunk)
                    if total>1024*1024*1024:raise HTTPException(502,'工作流媒体结果超过 1 GB。')
                    stream.write(chunk)
            if not total:raise HTTPException(502,'ComfyUI 返回了空媒体。')
            os.replace(temp,path)
        finally:
            if temp.exists():temp.unlink()
    from studio_asset_integration import register_output
    request={'canvas_id':task.get('canvas_id',''),'node_id':task.get('node_id',''),'provider_id':'deepwhite-local-comfy','model':task.get('workflow_id',''),'params':task.get('values',{})}
    row=register_output(core,core.output_url_for(name),name,request,task['id'])
    return {'url':row['url'],'kind':kind,'name':name,'asset_id':row['asset_id'],'version_id':row['version_id'],'asset_url':row['url']}


async def _submit_version(wf, revision, values, request_id, canvas_id='', node_id=''):
    request_id=str(request_id or '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}',request_id):raise HTTPException(400,'request_id 无效。')
    for name,value in (('canvas_id',canvas_id),('node_id',node_id)):
        if value and (not isinstance(value,str) or len(value)>120 or not re.fullmatch(r'[\w:.-]+',value)):raise HTTPException(400,f'{name} 无效。')
    try:
        # Preserve the original representation in the idempotency fingerprint;
        # execution-only integer restoration must not migrate existing IDs.
        fingerprint=hashlib.sha256(json.dumps({'workflow_id':wf['id'],'revision':revision,'values':values,'canvas_id':canvas_id,'node_id':node_id},sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    except (ValueError,TypeError): raise HTTPException(400,'提交参数包含无效数值。')
    index_path=_dir('requests')/(request_id+'.json')
    if index_path.exists():
        old=_read(index_path)
        if old.get('fingerprint')!=fingerprint:raise HTTPException(409,'request_id 已用于不同的工作流提交。')
        return _read(_dir('tasks')/(old['task_id']+'.json'))
    await engine.ensure()
    version=next((v for v in wf['versions'] if v['revision']==revision),None)
    if not version:raise HTTPException(404,'工作流版本不存在。')
    if not isinstance(values,dict):raise HTTPException(400,'values 必须是对象。')
    fields=version['bindings']; allowed={x['id'] for x in fields}
    if set(values)-allowed:raise HTTPException(400,'values 含有未映射字段。')
    prompt=copy.deepcopy(version['prompt']); stored={}
    base=engine.base_url()
    async with httpx.AsyncClient(timeout=15,trust_env=False) as client:
        try:info=await _info(client,base)
        except (httpx.HTTPError,ValueError,TypeError) as exc:raise HTTPException(503,'无法读取工作流节点依赖，请先检查 ComfyUI 连接。') from exc
    for field in fields:
        value=_validate_value(field,values.get(field['id'],field.get('default')),_definition(prompt,field,info))
        prompt[field['node_id']]['inputs'][field['input']]=value;stored[field['id']]=value
    _validate_graph(prompt,info)
    async with httpx.AsyncClient(timeout=httpx.Timeout(60,connect=5),trust_env=False) as client:
        for field in fields:
            if field['type'] not in ('image','video','audio'): continue
            value=stored[field['id']]
            if not isinstance(value,str) or not value.startswith('/'): continue
            path=core.output_file_from_url(value)
            if not path or not Path(path).is_file():raise HTTPException(400,f'媒体参数“{field["label"]}”必须是已保存到画布的本地素材。')
            path=Path(path)
            if path.stat().st_size>50*1024*1024:raise HTTPException(400,'工作流单个媒体参数不能超过 50 MB。')
            with path.open('rb') as stream:
                response=await client.post(base+'/upload/image',files={'image':(path.name,stream)},data={'type':'input','overwrite':'false'})
            response.raise_for_status();uploaded=response.json()
            prompt[field['node_id']]['inputs'][field['input']]='/'.join(x for x in (uploaded.get('subfolder',''),uploaded.get('name','')) if x)
    task={'id':uuid.uuid4().hex,'request_id':request_id,'request_fingerprint':fingerprint,'workflow_id':wf['id'],'revision':revision,'base_url':base,'canvas_id':canvas_id,'node_id':node_id,'status':'submitting','created_at':time.time(),'updated_at':time.time(),'prompt_id':'','error':'','values':stored,'outputs':[],'outputs_selected':version.get('outputs',[])}
    _write(_dir('tasks')/(task['id']+'.json'),task)
    _write(index_path,{'task_id':task['id'],'fingerprint':fingerprint})
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30,connect=5),trust_env=False) as client:
            response=await client.post(base+'/prompt',json={'prompt':prompt,'client_id':'deepwhite-workflow-'+task['id']})
            if response.status_code>=400:
                task.update(status='failed',error='ComfyUI 拒绝工作流：'+response.text[:500]);_write(_dir('tasks')/(task['id']+'.json'),task)
                raise HTTPException(400,task['error'])
            data=response.json(); prompt_id=data.get('prompt_id')
            if not isinstance(prompt_id,str) or not prompt_id:raise ValueError('ComfyUI 未返回 prompt_id')
            task.update(status='running',prompt_id=prompt_id);_write(_dir('tasks')/(task['id']+'.json'),task)
    except HTTPException: raise
    except Exception as exc:
        task.update(status='uncertain',error='提交结果待核实；不会自动重复提交。');_write(_dir('tasks')/(task['id']+'.json'),task)
        raise HTTPException(502,task['error']) from exc
    return task


async def _import_draft(payload):
    _wire(payload)  # Reject lossy/nonfinite floats before writing any draft data.
    raw=payload.get('workflow')
    try: size=len(json.dumps(raw,ensure_ascii=False,allow_nan=False).encode())
    except (ValueError,TypeError): raise HTTPException(400,'工作流包含无效数值。')
    if not isinstance(raw,dict) or size>MAX_WORKFLOW_BYTES:raise HTTPException(413,'工作流文件为空或超过 12 MB。')
    async with httpx.AsyncClient(timeout=15,trust_env=False) as client:
        try: info=await _info(client)
        except (httpx.HTTPError,ValueError,TypeError) as exc:raise HTTPException(400,'无法读取 ComfyUI object_info；请先连接 ComfyUI。') from exc
    prompt=_convert_ui(raw,info) if isinstance(raw.get('nodes'),list) else _normalize_prompt(raw)
    missing=sorted({n['class_type'] for n in prompt.values()}-set(info))
    if missing:raise HTTPException(400,'当前 ComfyUI 未安装工作流节点：'+', '.join(missing))
    _validate_graph(prompt,info)
    bindings=_validate_bindings(prompt,payload.get('bindings',[]),info)
    version={'revision':1,'created_at':time.time(),'prompt':prompt,'bindings':bindings,'outputs':_validate_outputs(prompt,info,payload.get('outputs'))}
    return {'draft':True,'name':str(payload.get('name') or '导入的 ComfyUI 工作流')[:120],'versions':[version]}


async def _refresh_task(task):
    if task['status']=='submitting':
        task.update(status='uncertain',error='服务在提交确认前中断，请先核实 ComfyUI 队列；不会自动重复提交。',message='提交结果待核实。');task['updated_at']=time.time();_write(_dir('tasks')/(task['id']+'.json'),task);return task
    if task['status'] not in ('running','queued','saving') or not task.get('prompt_id'): return task
    base=task.get('base_url') or engine.base_url()
    try:
        async with httpx.AsyncClient(timeout=10,trust_env=False) as client:
            if task['status']!='saving':
                r=await client.get(base+'/history/'+task['prompt_id']);r.raise_for_status();history=r.json().get(task['prompt_id'])
                if not history:
                    q=await client.get(base+'/queue');q.raise_for_status();queue=q.json();prompt_id=task['prompt_id']
                    def contains(rows):
                        for row in rows:
                            if isinstance(row,list) and len(row)>1 and str(row[1])==prompt_id:return True
                            if isinstance(row,dict) and str(row.get('prompt_id',''))==prompt_id:return True
                        return False
                    task['status']='queued' if contains(queue.get('queue_pending',[])) else 'running' if contains(queue.get('queue_running',[])) else task['status']
                    task['updated_at']=time.time();_write(_dir('tasks')/(task['id']+'.json'),task);return task
                state=history.get('status',{})
                if state.get('status_str')=='error':task.update(status='failed',error='ComfyUI 工作流运行失败。');task['updated_at']=time.time();_write(_dir('tasks')/(task['id']+'.json'),task);return task
                if not state.get('completed'):task['status']='running';task['updated_at']=time.time();_write(_dir('tasks')/(task['id']+'.json'),task);return task
                expected=[]
                selected={(str(row['node_id']),row['type']) for row in task.get('outputs_selected',[])} if isinstance(task.get('outputs_selected'),list) else None
                for node_id,bucket in history.get('outputs',{}).items():
                    if not isinstance(bucket,dict):continue
                    for kind,key in (('image','images'),('video','videos'),('audio','audio'),('video','gifs')):
                        for index,item in enumerate(bucket.get(key,[]) or []):
                            if isinstance(item,dict) and item.get('filename'):
                                if selected is not None and (str(node_id),kind) not in selected:continue
                                expected.append({'key':f'{node_id}:{kind}:{index}','node_id':str(node_id),'kind':kind,'index':index,'item':item})
                task['expected_outputs']=expected;task['status']='saving';task['updated_at']=time.time();_write(_dir('tasks')/(task['id']+'.json'),task)
            saved_keys={item.get('_key') for item in task.get('outputs',[])}
            for item in task.get('expected_outputs',[]):
                if item['key'] in saved_keys:continue
                url=base+'/view?'+urlencode({k:item['item'][k] for k in ('filename','subfolder','type') if k in item['item']})
                saved=await _persist_media(client,url,task,item['kind'],f'{item["node_id"]}-{item["index"]}',item['item'])
                saved['_key']=item['key'];task.setdefault('outputs',[]).append(saved);task['updated_at']=time.time();_write(_dir('tasks')/(task['id']+'.json'),task)
            task.update(status='succeeded',error='',message='');task['updated_at']=time.time();_write(_dir('tasks')/(task['id']+'.json'),task)
    except Exception:
        # Keep the history snapshot and completed files so a later poll can retry only the missing downloads.
        task['message']='任务结果保存中断；恢复连接后继续归档，不会重复提交。';task['updated_at']=time.time();_write(_dir('tasks')/(task['id']+'.json'),task)
    return task


def install(app):
    @app.get('/api/studio/comfy/workflow-capabilities')
    def workflow_capabilities():
        return {'schema':1,'preview':True,'integer_wire':'decimal-string','request_lookup':True}

    @app.get('/api/studio/comfy/workflows')
    def list_workflows():
        rows=[]
        for path in _dir('workflows').glob('*.json'):
            try:
                wf=_read(path); version=wf['versions'][-1]
                rows.append({'id':wf['id'],'name':wf['name'],'revision':version['revision'],'updated_at':wf['updated_at'],'fields':version['bindings'],'outputs':version['outputs'],'state':'ready'})
            except Exception:
                raise HTTPException(503,'ComfyUI 工作流库包含无法读取的记录，原文件未覆盖；请检查本地数据后刷新。')
        return _wire({'items':sorted(rows,key=lambda x:x['updated_at'],reverse=True)})

    @app.get('/api/studio/comfy/workflows/{workflow_id}')
    def get_workflow(workflow_id:str): return _wire(_load(workflow_id))

    @app.post('/api/studio/comfy/workflows/preview')
    async def preview_workflow(payload:dict): return _wire(await _import_draft(payload))

    @app.post('/api/studio/comfy/workflows/import')
    async def import_workflow(payload:dict):
        draft=await _import_draft(payload); now=time.time(); wid=uuid.uuid4().hex
        wf={'id':wid,'name':draft['name'],'created_at':now,'updated_at':now,'versions':draft['versions']}
        _write(_dir('workflows')/(wid+'.json'),wf);return _wire(wf)

    @app.put('/api/studio/comfy/workflows/{workflow_id}')
    async def update_workflow(workflow_id:str,payload:dict):
        _wire(payload)
        wf=_load(workflow_id)
        expected=payload.get('expected_revision')
        current=wf['versions'][-1]['revision']
        if expected is not None and expected!=current:raise HTTPException(409,'工作流已被其他操作更新，请重新读取。')
        current_version=wf['versions'][-1]
        prompt=_normalize_prompt(payload.get('prompt',current_version['prompt']))
        if 'name' in payload:wf['name']=str(payload['name'])[:120]
        async with httpx.AsyncClient(timeout=15,trust_env=False) as client:
            try:info=await _info(client)
            except (httpx.HTTPError,ValueError,TypeError) as exc:raise HTTPException(503,'无法读取 ComfyUI object_info。') from exc
        _restore_integer_inputs(prompt,info)
        bindings=_validate_bindings(prompt,payload.get('bindings',current_version['bindings']),info)
        version={'revision':current+1,'created_at':time.time(),'prompt':prompt,'bindings':bindings,'outputs':_validate_outputs(prompt,info,payload.get('outputs',current_version['outputs']))}
        # Metadata lookup may yield to another editor. Recheck only while
        # committing; never hold this lock during network requests.
        async with UPDATE_LOCK:
            latest=_load(workflow_id)
            if latest['versions'][-1]['revision']!=current:raise HTTPException(409,'工作流已被其他操作更新，请重新读取。')
            if 'name' in payload:latest['name']=wf['name']
            latest['versions'].append(version);latest['updated_at']=time.time()
            _write(_dir('workflows')/(latest['id']+'.json'),latest)
        return _wire(latest)

    @app.delete('/api/studio/comfy/workflows/{workflow_id}')
    def delete_workflow(workflow_id:str):
        wf=_load(workflow_id);(_dir('workflows')/(wf['id']+'.json')).unlink();return {'deleted':True}

    @app.get('/api/studio/comfy/object-info')
    async def object_info():
        async with httpx.AsyncClient(timeout=15,trust_env=False) as client:
            try:
                info=await _info(client);_check_info_choices(info);return _wire(info)
            except httpx.HTTPError as exc:raise HTTPException(503,'无法读取 ComfyUI object_info。') from exc

    @app.post('/api/studio/comfy/workflows/{workflow_id}/validate')
    async def validate_workflow(workflow_id:str,payload:dict):
        wf=_load(workflow_id);revision=payload.get('revision',wf['versions'][-1]['revision']);version=next((x for x in wf['versions'] if x['revision']==revision),None)
        if not version:raise HTTPException(404,'工作流版本不存在。')
        async with httpx.AsyncClient(timeout=15,trust_env=False) as client:
            try:info=await _info(client)
            except httpx.HTTPError as exc:raise HTTPException(503,'无法读取 ComfyUI object_info。') from exc
        missing=sorted({n['class_type'] for n in version['prompt'].values()}-set(info))
        missing_fields=[]
        for node_id,node in version['prompt'].items():
            schema=info.get(node['class_type'],{}).get('input',{}).get('required',{})
            for field in schema:
                if field not in node['inputs'] and not any(b['node_id']==node_id and b['input']==field for b in version['bindings']):missing_fields.append(f'{node_id}.{field}')
        return {'valid':not missing and not missing_fields,'missing_nodes':missing,'missing_fields':missing_fields,'dependency_state':'missing' if missing else 'ready'}

    @app.post('/api/studio/comfy/workflows/{workflow_id}/submit')
    async def submit_workflow(workflow_id:str,payload:dict):
        wf=_load(workflow_id)
        async with SUBMIT_LOCK:
            return _wire(await _submit_version(wf,int(payload.get('revision') or wf['versions'][-1]['revision']),payload.get('values',{}),payload.get('request_id'),payload.get('canvas_id',''),payload.get('node_id','')))

    @app.get('/api/studio/comfy/tasks')
    def list_tasks():
        rows=[]
        for path in _dir('tasks').glob('*.json'):
            try:rows.append(_read(path))
            except Exception:continue
        return _wire({'items':sorted(rows,key=lambda x:x['created_at'],reverse=True)[:200]})

    @app.get('/api/studio/comfy/tasks/by-request/{request_id}')
    def get_task_by_request(request_id:str):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}',request_id):raise HTTPException(400,'request_id 无效。')
        index=_read(_dir('requests')/(request_id+'.json'))
        task=_read(_dir('tasks')/(_task_id(index.get('task_id'))+'.json'))
        if task.get('request_id')!=request_id:raise HTTPException(409,'原任务请求编号不匹配。')
        return _wire(task)

    @app.get('/api/studio/comfy/tasks/{task_id}')
    async def get_task(task_id:str):
        path=_dir('tasks')/(_task_id(task_id)+'.json');return _wire(await _refresh_task(_read(path)))
