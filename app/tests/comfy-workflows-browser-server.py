"""Isolated local browser fixture for custom ComfyUI workflows; no GPU or upstream calls."""
import os
# Old smart canvases are seeded here only to stand in for existing user data (U10).
os.environ.setdefault('DEEPWHITE_STUDIO_LEGACY_SMART_FIXTURES', '1')
import json
import os
import sys
from pathlib import Path
from fastapi import FastAPI
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import httpx
import studio_server
import uvicorn

_Client=httpx.AsyncClient
PROMPTS={}
PNG=bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082')

def upstream(request):
    path=request.url.path
    if path=='/system_stats':return httpx.Response(200,json={'system':{},'devices':[{}]})
    if path=='/queue':return httpx.Response(200,json={'queue_running':[],'queue_pending':[]})
    if path=='/object_info':
        info={
          'FixtureText':{'input':{'required':{'text':['STRING',{'multiline':True}],'steps':['INT',{'default':4,'min':1,'max':60}],'enabled':['BOOLEAN',{'default':True}],'choice':[['one','two'],{}]}},'output':['IMAGE','VIDEO','AUDIO'],'output_names':['image','video','audio']},
          'SaveImage':{'input':{'required':{'images':['IMAGE'],'filename_prefix':['STRING',{}]}},'output':[],'output_names':[]},
        }
        return httpx.Response(200,json=info)
    if path=='/prompt':
        data=json.loads(request.content);pid='browser-task-'+str(len(PROMPTS)+1);PROMPTS[pid]=data
        return httpx.Response(200,json={'prompt_id':pid})
    if path.startswith('/history/'):
        pid=path.rsplit('/',1)[-1]
        if pid not in PROMPTS:return httpx.Response(200,json={})
        return httpx.Response(200,json={pid:{'status':{'completed':True,'status_str':'success'},'outputs':{
          '1':{'images':[{'filename':'fixture.png','subfolder':'','type':'output'}],'gifs':[{'filename':'fixture.mp4','subfolder':'','type':'output'}],'audio':[{'filename':'fixture.wav','subfolder':'','type':'output'}]},
          '2':{'images':[{'filename':'fixture-save.png','subfolder':'','type':'output'}]}}}})
    if path=='/view':
        name=request.url.params.get('filename','')
        if name.endswith('.png'):return httpx.Response(200,content=PNG,headers={'content-type':'image/png'})
        if name.endswith('.mp4'):return httpx.Response(200,content=b'fixture-video-bytes',headers={'content-type':'video/mp4'})
        return httpx.Response(200,content=b'fixture-audio-bytes',headers={'content-type':'audio/wav'})
    if path=='/upload/image':return httpx.Response(200,json={'name':'fixture-input.png','subfolder':'','type':'input'})
    return httpx.Response(404,json={'detail':'fixture route not found'})

def offline_client(*args,**kwargs):
    kwargs['transport']=httpx.MockTransport(upstream)
    kwargs['trust_env']=False
    return _Client(*args,**kwargs)

httpx.AsyncClient=offline_client
@studio_server.app.get('/api/test/comfy-prompt-count')
def comfy_prompt_count():return {'count':len(PROMPTS)}
uvicorn.run(studio_server.app,host='127.0.0.1',port=int(os.getenv('DEEPWHITE_STUDIO_PORT','3862')))
