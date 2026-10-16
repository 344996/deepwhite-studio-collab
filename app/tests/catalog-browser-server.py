"""Test-only server: public catalogue fixture, no external API requests."""
import sys
import json
import os
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import studio_server
import studio_settings
import studio_catalog
import studio_pricing
import uvicorn
import httpx
# Fail closed: browser mocks own all generation responses; this fixture may never call an upstream.
_HttpClient=httpx.AsyncClient
def offline_client(*args,**kwargs):
    kwargs['transport']=httpx.MockTransport(lambda request:httpx.Response(503,json={'error':'External traffic disabled in browser fixture'}))
    return _HttpClient(*args,**kwargs)
httpx.AsyncClient=offline_client

raw=json.loads(studio_catalog.SNAPSHOT.read_text(encoding='utf-8'))
async def read_models(payload):
    if payload.api_key=='invalid-fixture':
        from fastapi import HTTPException
        raise HTTPException(502,'密钥无效（模拟）')
    records=[{'id':m['model_name']} for m in raw['data']]
    return {'model_records':records,'models':records,'model_count':len(records),'message':'连接成功（模拟），未发起生成任务。'}
async def metadata(base):
    return {m['model_name']:m for m in raw['data']},{str(v['id']):v['name'] for v in raw['vendors']}
studio_settings.read_models=read_models
studio_catalog.metadata=metadata
async def pricing_snapshot(): return raw
studio_pricing.snapshot=pricing_snapshot
uvicorn.run(studio_server.app,host='127.0.0.1',port=int(os.getenv('DEEPWHITE_STUDIO_PORT','3860')))
