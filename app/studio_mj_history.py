"""Durable MJ attempts, kept separate from generic generation workers."""
import json
import time
import uuid
from pathlib import Path
import main as core

def directory():
    path=Path(core.DATA_DIR)/'studio_mj_history'
    path.mkdir(parents=True,exist_ok=True)
    return path

def save(record):
    path=directory()/(record['id']+'.json')
    temp=path.with_suffix('.tmp')
    temp.write_text(json.dumps(record,ensure_ascii=False),encoding='utf-8')
    temp.replace(path)

def begin(request,params):
    model='midjourney-'+request.action
    record={'id':'mj_'+uuid.uuid4().hex,'source':'mj','created_at':time.time(),
        'base_url':core.get_api_provider(request.provider_id)['base_url'],
        'status':'uncertain','error':'提交结果待核对','resolved_model':model,
        'request':{'canvas_id':request.canvas_id,'node_id':request.node_id,'provider_id':request.provider_id,
            'model':model,'kind':'chat' if request.action=='describe' else 'video' if request.action=='video' else 'image',
            'prompt':params.get('prompt',''),'params':params,'references':[],'count':1},
        'task_ids':[],'outputs':[],'text':'','children':[]}
    save(record)
    return record

def update(record,result):
    record['status']={'pending':'running','modal':'modal'}.get(result['status'],result['status'])
    record['updated_at']=time.time()
    record['error']=result.get('error','')
    task=result.get('task_id')
    if task:record['task_ids']=[task]
    record['outputs']=[{'url':u,'kind':kind} for field,kind in [('images','image'),('videos','video')] for u in result.get(field,[])]
    record['text']=result.get('text','')
    record['children']=[{'usage':result.get('usage')}]
    save(record)

def items(canvas_id=''):
    result=[]
    for path in directory().glob('*.json'):
        record=json.loads(path.read_text(encoding='utf-8'))
        if not canvas_id or record['request']['canvas_id']==canvas_id:result.append(record)
    return result

def update_task(provider_id,task_id,result):
    base=core.get_api_provider(provider_id)['base_url']
    for record in items():
        if record['request']['provider_id']==provider_id and task_id in record['task_ids'] and record['base_url']==base:
            update(record,result)
