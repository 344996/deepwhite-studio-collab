"""Test-only server: fake MJ upstream that counts every paid POST; no real traffic."""
import os
# Old smart canvases are seeded here only to stand in for existing user data (U10).
os.environ.setdefault('DEEPWHITE_STUDIO_LEGACY_SMART_FIXTURES', '1')
import json
import os
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import httpx

_HttpClient=httpx.AsyncClient
def offline_client(*args,**kwargs):
    kwargs['transport']=httpx.MockTransport(lambda request:httpx.Response(503,json={'error':'External traffic disabled in browser fixture'}))
    return _HttpClient(*args,**kwargs)
httpx.AsyncClient=offline_client

import studio_server
import main
import studio_midjourney as mj
import uvicorn

STATE=Path(os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'])/'fake-mj-upstream.json'
PROVIDER={'id':'mjfake','name':'MJ fixture','base_url':'https://mj.fake','enabled':True}

def read_state():
    return json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else {'posts':[],'queries':[]}

async def upstream(provider_id,method,suffix,data=None,action=''):
    state=read_state()
    if state.get('offline'):
        # What the real adapter raises when the connection never opens.
        raise mj.NotSubmitted(503,'网络未连接，MJ 请求没有发出，未产生费用；恢复网络后可以重新生成。')
    if method=='POST':
        state['posts'].append({'suffix':suffix,'prompt':(data or {}).get('prompt','')});task='mj-fake-%d'%len(state['posts'])
    else:
        task=suffix.rsplit('/',1)[-1];state['queries'].append(task)
    STATE.write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8')
    # Stays in progress so the page keeps a pending task and never downloads media.
    return mj.normalize({'data':{'task_id':task,'status':'IN_PROGRESS'}},action)

original=main.get_api_provider
main.get_api_provider=lambda pid:dict(PROVIDER) if pid=='mjfake' else original(pid)
mj.require_action=lambda provider_id,action:dict(PROVIDER)
mj.upstream=upstream
uvicorn.run(studio_server.app,host='127.0.0.1',port=int(os.getenv('DEEPWHITE_STUDIO_PORT','3860')))
