"""Offline integration: real canvas jobs with mocked ComfyUI. No GPU tasks."""
import asyncio, base64, json, os, sys, tempfile, unittest, uuid
from pathlib import Path
from unittest.mock import patch, AsyncMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='deepwhite-comfy-test-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import httpx
import studio_server
import studio_generation as gen
import studio_comfy as comfy
import main as core
from fastapi import HTTPException
Client=httpx.AsyncClient
from io import BytesIO
from PIL import Image
buffer=BytesIO();Image.new('RGB',(16,16),'blue').save(buffer,format='PNG');PNG=buffer.getvalue()

class LocalComfy(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls=[];self.failure='';self.submitted=[]
        self.engine=patch('studio_comfy_engine.ensure',new_callable=AsyncMock);self.engine.start()
        async def no_socket(job,ready):ready.set()
        self.progress=patch('studio_comfy.watch_progress',side_effect=no_socket);self.progress.start()
        comfy._models=[];comfy._models_verified=False;comfy._models_at=0
        self.installed_models=[comfy.DEFAULT_UNET,'qwen_image_2.1_bf16.safetensors','flux.safetensors']
        p=Path(core.output_path_for('local-ref.png'));p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(PNG)
        self.ref=core.output_url_for('local-ref.png')
        self.transport=patch.object(httpx,'AsyncClient',side_effect=lambda **kw:Client(**{**kw,'transport':httpx.MockTransport(self.upstream)}));self.transport.start()

    async def asyncTearDown(self):
        for t in list(gen.WORKERS.values()):t.cancel()
        await asyncio.gather(*list(gen.WORKERS.values()),return_exceptions=True)
        self.transport.stop()
        self.engine.stop()
        self.progress.stop()

    def upstream(self,r):
        self.calls.append(r);self.assertEqual(r.url.host,'127.0.0.1');self.assertNotIn('authorization',r.headers)
        path=r.url.path
        if path=='/object_info/UNETLoader':
            return httpx.Response(200,json={'UNETLoader':{'input':{'required':{'unet_name':[[comfy.DEFAULT_UNET,'qwen_image_2.1_bf16.safetensors','flux.safetensors']]}}}})
        if path=='/object_info':
            if self.failure=='offline':raise httpx.ConnectError('offline',request=r)
            g=json.loads(comfy.TEMPLATE.read_text(encoding='utf-8'))
            return httpx.Response(200,json={n['class_type']:{'input':{'required':{'unet_name':[self.installed_models]}} if n['class_type']=='UNETLoader' else {}} for n in g.values()})
        if path=='/upload/image':return httpx.Response(200,json={'name':'uploaded.png','subfolder':'','type':'input'})
        if path=='/prompt':
            self.submitted.append(json.loads(r.content)['prompt'])
            if self.failure=='submit_timeout':raise httpx.ReadTimeout('lost',request=r)
            return httpx.Response(200,json={'prompt_id':'local-prompt-123'})
        if path.startswith('/history/'):
            if self.failure=='poll':raise httpx.ConnectError('offline',request=r)
            return httpx.Response(200,json={'local-prompt-123':{'status':{'completed':True,'status_str':'success'},'outputs':{'468':{'images':[{'filename':'result.png','subfolder':'DeepWhite','type':'output'}]}}}})
        if path=='/view':return httpx.Response(200,content=PNG,headers={'content-type':'image/png'})
        raise AssertionError(str(r.url))

    def payload(self,**kw):
        return gen.Generation(**dict(request_id=uuid.uuid4().hex,provider_id=comfy.PROVIDER,model=comfy.MODEL,kind='image',prompt='把外套改成蓝色',references=[{'url':self.ref,'kind':'image'}],**kw))

    async def finish(self,p):
        result=await gen.submit(p)
        task=gen.WORKERS.get(result['id'])
        if task:await task
        return gen.read(result['id'])

    async def test_edit_and_idempotency(self):
        p=self.payload();j=await self.finish(p)
        self.assertEqual(j['status'],'succeeded');self.assertEqual(len(j['children'][0]['outputs']),1)
        g=self.submitted[0];self.assertEqual(g['177']['inputs']['image'],'uploaded.png')
        self.assertEqual(g['458']['inputs']['prompt'],p.prompt);self.assertNotIn('486',g)
        self.assertEqual(g['408']['inputs']['prompt'],['458',0])
        await gen.submit(p);self.assertEqual(len(self.submitted),1)

    async def test_optimization_and_batch(self):
        j=await self.finish(self.payload(count=2,params={'optimize_prompt':True,'steps':30,'ratio':'3:4'}))
        self.assertEqual(j['status'],'succeeded');self.assertEqual(len(self.submitted),2)
        self.assertIn('486',self.submitted[0]);self.assertEqual(self.submitted[0]['409']['inputs']['steps'],30)
        self.assertNotEqual(self.submitted[0]['409']['inputs']['seed'],self.submitted[1]['409']['inputs']['seed'])

    async def test_missing_image_rejected(self):
        p=self.payload();p.references=[]
        with self.assertRaises(HTTPException):await gen.submit(p)
        self.assertEqual(self.calls,[])

    async def test_offline(self):
        self.failure='offline';j=await self.finish(self.payload())
        self.assertEqual(j['status'],'failed');self.assertIn('8188',j['error']);self.assertEqual(self.submitted,[])

    async def test_poll_resume_never_resubmits(self):
        self.failure='poll';j=await self.finish(self.payload());self.assertEqual(j['status'],'paused')
        self.failure='';await comfy.execute(j['id'])
        self.assertEqual(gen.read(j['id'])['status'],'succeeded');self.assertEqual(len(self.submitted),1)

    async def test_submit_timeout_uncertain(self):
        self.failure='submit_timeout';j=await self.finish(self.payload());self.assertEqual(j['status'],'uncertain')
        await comfy.execute(j['id']);self.assertEqual(len(self.submitted),1)

    async def test_public_endpoints(self):
        async with Client(transport=httpx.ASGITransport(app=studio_server.app),base_url='http://testserver') as client:
            providers=(await client.get('/api/providers')).json()['providers']
            self.assertTrue(any(p['id']==comfy.PROVIDER for p in providers))
            caps=(await client.get('/api/studio/capabilities')).json()['providers']
            self.assertEqual(caps[comfy.PROVIDER][comfy.MODEL]['max_images'],1)
            choices=caps[comfy.PROVIDER][comfy.MODEL]['fields']['main_model']['values']
            self.assertIn('qwen_image_2.1_bf16.safetensors',choices);self.assertNotIn('flux.safetensors',choices)
            q=await client.post('/api/studio/quote',json={'provider_id':comfy.PROVIDER,'model':comfy.MODEL,'kind':'image'})
            self.assertEqual(q.json()['price'],0)

    async def test_selected_main_model_and_cfg(self):
        await comfy.refresh_models()
        job=await self.finish(self.payload(params={'main_model':'qwen_image_2.1_bf16.safetensors','cfg':1.5}))
        self.assertEqual(job['status'],'succeeded')
        graph=self.submitted[0]
        self.assertEqual(next(n for n in graph.values() if n['class_type']=='UNETLoader')['inputs']['unet_name'],'qwen_image_2.1_bf16.safetensors')
        self.assertEqual(graph['409']['inputs']['cfg'],1.5)
        with self.assertRaises(HTTPException):await gen.submit(self.payload(params={'main_model':'flux.safetensors'}))

    async def test_live_model_mismatch_stops_before_submission(self):
        await comfy.refresh_models()
        self.installed_models=[comfy.DEFAULT_UNET]
        j=await self.finish(self.payload(params={'main_model':'qwen_image_2.1_bf16.safetensors'}))
        self.assertEqual(j['status'],'failed')
        self.assertIn('本地工作流缺少模型或参数不匹配',j['error'])
        self.assertEqual(self.submitted,[])

    async def test_saved_nondefault_model_survives_engine_restart(self):
        self.assertFalse(comfy._models_verified)
        j=await self.finish(self.payload(params={'main_model':'qwen_image_2.1_bf16.safetensors'}))
        self.assertEqual(j['status'],'succeeded')
        self.assertEqual(next(n for n in self.submitted[0].values() if n['class_type']=='UNETLoader')['inputs']['unet_name'],'qwen_image_2.1_bf16.safetensors')
        with self.assertRaises(HTTPException):comfy.checked(self.payload(params={'main_model':'flux.safetensors'}))

if __name__=='__main__':unittest.main()
