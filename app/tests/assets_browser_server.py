"""Disposable asset UI server. No production data or upstream network."""
import os
import sys
import tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='dw-asset-browser-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import httpx
original_client=httpx.AsyncClient
def offline(*args,**kwargs):
    kwargs['transport']=httpx.MockTransport(lambda r:httpx.Response(503,json={'detail':'Offline test server'}))
    return original_client(*args,**kwargs)
httpx.AsyncClient=offline
import studio_server
import uvicorn
uvicorn.run(studio_server.app,host='127.0.0.1',port=3871)
