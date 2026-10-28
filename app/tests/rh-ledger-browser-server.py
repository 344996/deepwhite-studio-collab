"""Test-only server: fake RunningHub upstream that records every paid submit; no real traffic."""
import base64
import json
import os
import re
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import httpx

STATE=Path(os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'])/'fake-rh-upstream.json'
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')

def read_state():
    state=json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else {}
    state.setdefault('submits',[]);state.setdefault('uploads',[]);state.setdefault('lose_next',False)
    return state

def fake_rh(request):
    if request.url.host!='rh.fake':
        return httpx.Response(503,json={'error':'External traffic disabled in browser fixture'})
    path=request.url.path
    if path.endswith('/task/openapi/upload'):
        state=read_state();match=re.search(rb'filename="([^"]+)"',request.content or b'')
        name=match.group(1).decode('utf-8','replace') if match else 'unknown'
        state['uploads'].append(name);STATE.write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8')
        return httpx.Response(200,json={'code':0,'msg':'success','data':{'fileName':'api/uploaded-%d-%s'%(len(state['uploads']),name),'fileType':'image'}})
    if path.endswith('/task/openapi/ai-app/run') or path.endswith('/task/openapi/create'):
        state=read_state();body=json.loads(request.content or b'{}');body.pop('apiKey',None)
        state['submits'].append(body);task='fake-task-%d'%len(state['submits'])
        lose=state.get('lose_next');state['lose_next']=False
        STATE.write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8')
        # Accepted (and billed) upstream, but the response never reaches the studio.
        if lose:raise httpx.ReadError('response lost after acceptance',request=request)
        return httpx.Response(200,json={'code':0,'msg':'success','data':{'taskId':task}})
    if path.endswith('/task/openapi/outputs'):
        task=json.loads(request.content or b'{}').get('taskId','')
        return httpx.Response(200,json={'code':0,'msg':'success','data':[{'fileUrl':'https://rh.fake/out/%s.png'%task,'fileType':'png'}]})
    if path.startswith('/out/'):
        return httpx.Response(200,content=PNG,headers={'content-type':'image/png'})
    return httpx.Response(404,json={'code':404,'msg':'unknown fake path'})

_HttpClient=httpx.AsyncClient
def offline_client(*args,**kwargs):
    kwargs['transport']=httpx.MockTransport(fake_rh)
    return _HttpClient(*args,**kwargs)
httpx.AsyncClient=offline_client

import studio_server
import main
import uvicorn
PROVIDER={'id':'runninghub','name':'RunningHub fixture','base_url':'https://rh.fake','api_key':'fixture-free-key','enabled':True,'rh_apps':[],'rh_workflows':[]}
main.runninghub_provider=lambda:dict(PROVIDER)
# Managed local media that must be uploaded before RH can use it.
os.makedirs(main.OUTPUT_INPUT_DIR,exist_ok=True)
Path(main.OUTPUT_INPUT_DIR,'fixture-input.png').write_bytes(PNG)
storage=Path(main.storage_kind_dir('generated'));storage.mkdir(parents=True,exist_ok=True)
(storage/'fixture-storage.png').write_bytes(PNG)
# A second managed file with different bytes, so the asset library keeps two versions.
(storage/'fixture-scene.png').write_bytes(PNG+b'scene')
uvicorn.run(studio_server.app,host='127.0.0.1',port=int(os.getenv('DEEPWHITE_STUDIO_PORT','3860')))
