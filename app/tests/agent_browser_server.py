"""Temporary Agent UI fixture; all provider traffic is simulated, no GPU/model use."""
import os,sys,tempfile,json,base64
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='dw-agent-browser-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import studio_server
import studio_agent
import studio_catalog
import studio_assets
import main as core
import httpx
import uvicorn

core.save_api_providers([core.normalize_provider({'id':'agent-fixture','name':'离线测试平台','base_url':'https://agent.invalid/v1',
    'enabled':True,'chat_models':['fixture-chat'],'image_models':['image-g-v2.5-high'],'video_models':['seedance-2.5-standard']})])
studio_catalog.save_store({})
core.provider_env_key_value=lambda provider_id: 'sk-offline-fixture' if provider_id=='agent-fixture' else ''
canvas={'id':'agentfixture','title':'助手验收','project':'default','nodes':[],'connections':[]}
core.save_canvas(canvas)
name='agent-fixture.png'
Path(core.output_path_for(name)).write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII='))
asset=studio_assets.register_local(core.output_url_for(name),name='女主参考.png')
calls=[]
def provider(request):
    if request.url.host!='agent.invalid' or request.url.path!='/v1/chat/completions':
        return httpx.Response(503,json={'error':'This is an offline fixture'})
    body=json.loads(request.content);calls.append(body)
    if body['messages'][-1]['role']!='tool':
        message={'role':'assistant','content':None,'tool_calls':[{'id':'lookup1','type':'function','function':{'name':'list_project_assets','arguments':'{}'}}]}
    else:
        user=next(m for m in reversed(body['messages']) if m['role']=='user')['content']
        user=user if isinstance(user,str) else user[0]['text']
        video='视频' in user
        node={'key':'shot' if video else 'hero','kind':'video' if video else 'image','title':'办公室片段' if video else '女主效果图',
            'prompt':('{{asset:'+asset['version_id']+'}}缓慢走入办公室，镜头平稳推近。') if video else '一位身穿灰色西装的女性，柔和侧光，写实摄影风格。',
            'references':[{'version_id':asset['version_id'],'label':'女主'}] if video else []}
        message={'role':'assistant','content':json.dumps({'reply':'已读取当前项目素材并整理方案，请检查后写入画布。','plan':{'nodes':[node]}},ensure_ascii=False)}
    return httpx.Response(200,json={'choices':[{'message':message}],'usage':{'prompt_tokens':20,'completion_tokens':10,'total_tokens':30}})
Original=httpx.AsyncClient
def offline(*args,**kwargs):
    kwargs['transport']=httpx.MockTransport(provider)
    return Original(*args,**kwargs)
httpx.AsyncClient=offline
@studio_server.app.get('/test/agent-calls')
def test_calls():return {'count':len(calls),'messages':calls[-1]['messages'] if calls else []}
uvicorn.run(studio_server.app,host='127.0.0.1',port=3872)
