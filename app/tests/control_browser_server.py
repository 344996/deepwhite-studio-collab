"""Isolated browser fixture. Every generation executor is replaced with a local stub."""
import base64,os,sys,tempfile,asyncio
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='deepwhite-control-browser-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import studio_server,studio_control,studio_generation,studio_assets
import main as core
import httpx,uvicorn
if not any(getattr(r,'path','')=='/api/studio/control/settings' for r in core.app.routes):studio_control.install(core.app)
core.ensure_default_project()
core.save_api_providers([core.normalize_provider({'id':'mcp-fixture','name':'Offline fixture','base_url':'https://api.deepwhiteai.com/v1',
    'enabled':True,'image_models':['deepwhiteai-image-g-v2.5-lowprice'],'video_models':['seedance-2.5-standard']})])
core.provider_env_key_value=lambda *args,**kwargs:'offline-fixture-key'
core.save_canvas({'id':'controlfixture','title':'本地智能体验收','project':'default','nodes':[],'connections':[]})
name='control-fixture.png'
Path(core.output_path_for(name)).write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII='))
asset=studio_assets.register_local(core.output_url_for(name),project_id='default')
video_name='control-fixture.mp4';Path(core.output_path_for(video_name)).write_bytes(b'offline video task fixture')
video_asset=studio_assets.register_local(core.output_url_for(video_name),project_id='default')
Original=httpx.AsyncClient
def offline(*args,**kwargs):
    kwargs['transport']=httpx.MockTransport(lambda request:httpx.Response(503,json={'error':'offline fixture'}))
    return Original(*args,**kwargs)
httpx.AsyncClient=offline
async def fake_execute(job_id):
    job=studio_generation.read(job_id)
    await asyncio.sleep(.05)
    item=asset if job['request']['kind']=='image' else video_asset
    job['status']='succeeded';job['children']=[{'status':'succeeded','outputs':[{'url':item['url'],'kind':item['kind'],'version_id':item['version_id']}]}]
    studio_generation.save(job)
studio_generation.execute=fake_execute

@core.app.post('/test/external-edit')
async def edit():
    canvas=core.load_canvas('controlfixture')
    canvas['nodes'].append({'id':'external','type':'prompt','text':'智能体新节点','x':500,'y':100,'w':300})
    core.save_canvas(canvas)
    await core.manager.broadcast_canvas_updated(canvas['id'],canvas['updated_at'],'studio-mcp')
    return {'canvas':canvas}

@core.app.get('/test/control-info')
def info():return {'runtime':runtime.name,'asset':asset}

uvicorn.run(core.app,host='127.0.0.1',port=3874)
