"""Isolated local UI server; no real provider credentials or model requests."""
import base64
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix='dw-channels-storage-browser-')
external = tempfile.TemporaryDirectory(prefix='dw-channels-storage-dest-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import studio_server
import main as core
import studio_assets
import httpx
import uvicorn

core.save_api_providers([])
core.ensure_default_project()
core.save_canvas({'id':'storagefixture','title':'通道与存储验收','project':'default','nodes':[],'connections':[]})
name='storage-fixture.png'
Path(core.output_path_for(name)).write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII='))
asset=studio_assets.register_local(core.output_url_for(name),name='参考图.png',project_id='default')
Original=httpx.AsyncClient
def offline(*args,**kwargs):
    kwargs['transport']=httpx.MockTransport(lambda request:httpx.Response(503,json={'error':'Offline fixture'}))
    return Original(*args,**kwargs)
httpx.AsyncClient=offline

@studio_server.app.get('/test/storage-fixture')
def fixture():
    return {'default_root':str(Path(external.name)/'new-projects'),'destination':str(Path(external.name)/'chosen-project'),
            'asset_url':asset['url'],'version_id':asset['version_id']}

uvicorn.run(studio_server.app,host='127.0.0.1',port=3873)
