"""Real Stage 1 adapter with a fake upstream; zero paid/network calls."""
import asyncio, base64, json, os, sys, tempfile, unittest, uuid
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='deepwhite-stage-one-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import httpx
import studio_server
import studio_generation as gen
import studio_catalog as catalog
import main as core
from fastapi import HTTPException

Client=httpx.AsyncClient
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=')
RAW=json.loads(catalog.SNAPSHOT.read_text(encoding='utf-8'))

class StageOne(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        core.save_api_providers([core.normalize_provider({'id':'deepwhite','name':'DeepWhite','base_url':'https://api.deepwhiteai.com/v1','enabled':True,'primary':True})])
        models=catalog.build_catalog([r['model_name'] for r in RAW['data']],{r['model_name']:r for r in RAW['data']})
        catalog.save_store({'deepwhite':{'base_url':'https://api.deepwhiteai.com/v1','models':models}})
        self.calls=[];self.failure='';self.get_failure=False;self.pending=0
        self.key=patch.object(core,'provider_env_key_value',return_value='sk-offline-test-only');self.key.start()
        self.transport=patch.object(httpx,'AsyncClient',side_effect=lambda **kw:Client(**{**kw,'transport':httpx.MockTransport(self.upstream)}));self.transport.start()
        self.sleep=patch.object(gen,'POLL_SECONDS',0);self.sleep.start()
        self.api=Client(transport=httpx.ASGITransport(app=studio_server.app),base_url='http://testserver')

    async def asyncTearDown(self):
        for t in list(gen.WORKERS.values()):t.cancel()
        await asyncio.gather(*list(gen.WORKERS.values()),return_exceptions=True)
        self.key.stop();self.transport.stop();self.sleep.stop();await self.api.aclose()

    def upstream(self,r):
        self.calls.append(r)
        if r.url.host=='cdn.test':
            self.assertNotIn('authorization',r.headers)
            return httpx.Response(200,content=PNG,headers={'content-type':'video/mp4' if r.url.path.endswith('.mp4') else 'image/png'})
        self.assertEqual(r.url.host,'api.deepwhiteai.com')
        self.assertEqual(r.headers['authorization'],'Bearer sk-offline-test-only')
        if r.url.path.endswith('/files/upload'):return httpx.Response(200,json={'url':'https://cdn.test/upload.png','expires_in':86400})
        if r.method=='POST':
            if self.failure=='timeout':raise httpx.ReadTimeout('secret must not escape',request=r)
            if self.failure=='balance':return httpx.Response(402,json={'error':'sk-offline-test-only'})
            if self.failure=='bad_prompt':return httpx.Response(400,json={'error':{'message':'prompt length must be between 5 and 5000 characters; key sk-offline-test-only'}},headers={'x-request-id':'fixture-request-400'})
            if self.failure=='server':return httpx.Response(503,json={'error':'upstream failure'})
            if r.url.path.endswith('/chat/completions'):return httpx.Response(200,json={'choices':[{'message':{'content':'模拟生成的文本'}}],'usage':{'prompt_tokens':10,'completion_tokens':15}})
            return httpx.Response(200,json={'id':'upstream-'+str(len(self.calls)),'status':'queued'})
        if self.get_failure:return httpx.Response(502,json={'error':'暂时不可读'})
        if self.pending>0:
            self.pending-=1;return httpx.Response(200,json={'status':'in_progress','progress':50})
        if '/videos/' in r.url.path:return httpx.Response(200,json={'status':'completed','metadata':{'url':'https://cdn.test/movie.mp4'},'usage':{'total_cost':1.2}})
        return httpx.Response(200,json={'data':{'status':'SUCCESS','data':{'content':{'image_urls':['https://cdn.test/one.png','https://cdn.test/two.png']},'usage':{'total_cost':.2}}}})

    def payload(self,**kw):return gen.Generation(**{'request_id':uuid.uuid4().hex,'provider_id':'deepwhite','canvas_id':'test-canvas','node_id':'node-1','model':'deepwhiteai-image-g2','kind':'image','prompt':'一只猫在窗边晒太阳',**kw})
    async def finish(self,payload):
        result=await gen.submit(payload);task=gen.WORKERS.get(result['id'])
        if task:await task
        return gen.public(gen.read(result['id']))
    def posts(self):return [r for r in self.calls if r.method=='POST' and not r.url.path.endswith('/files/upload')]

    async def test_image_protocol_poll_multi_output_local_save_and_usage(self):
        self.pending=2
        job=await self.finish(self.payload(params={'ratio':'16:9','resolution':'1k'}))
        self.assertEqual(job['status'],'succeeded');self.assertEqual(len(job['outputs']),2)
        req=self.posts()[0];self.assertEqual(req.url.path,'/v1/image/generations')
        body=json.loads(req.content);self.assertEqual(body['model'],'deepwhiteai-image-g2-t2i');self.assertEqual(body['metadata'],{'ratio':'16:9','resolution':'1k'})
        for out in job['outputs']:self.assertTrue(Path(core.output_file_from_url(out['url'])).exists())
        self.assertEqual(job['children'][0]['usage']['total_cost'],.2)
        self.assertEqual(len(self.posts()),1)

    async def test_uploaded_reference_cached_and_routes_i2i(self):
        path=Path(core.output_path_for('stage-reference.png','input'));path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(PNG)
        ref={'url':core.output_url_for(path.name,'input'),'kind':'image'}
        for _ in range(2):
            job=await self.finish(self.payload(references=[ref]));self.assertEqual(job['status'],'succeeded')
        self.assertEqual(sum(r.url.path.endswith('/files/upload') for r in self.calls),1)
        for r in self.posts():
            b=json.loads(r.content);self.assertEqual(b['model'],'deepwhiteai-image-g2-i2i');self.assertEqual(b['images'],['https://cdn.test/upload.png'])

    async def test_seedance_text_multi_and_first_last_contract(self):
        for refs,frames,mode in [([],False,'t2v'),([{'url':'https://cdn.test/ref.png','kind':'image'}],False,'multi'),([{'url':'https://cdn.test/last.png','kind':'image','role':'last_frame'},{'url':'https://cdn.test/first.png','kind':'image','role':'first_frame'}],True,'i2v')]:
            job=await self.finish(self.payload(kind='video',model='seedance-2.0-fast',references=refs,frame_mode=frames,params={'duration':5,'resolution':'720p','generate_audio':True,'ratio':'16:9'}))
            self.assertEqual(job['status'],'succeeded',job['error']);b=json.loads(self.posts()[-1].content)
            self.assertEqual(b['model'],'seedance-2.0-fast-'+mode);self.assertEqual(b['seconds'],'5')
            if mode=='multi':self.assertEqual(b['metadata']['content'][0]['type'],'image_url');self.assertNotIn('images',b)
            if mode=='i2v':self.assertEqual(b['images'],['https://cdn.test/first.png','https://cdn.test/last.png'])

    async def test_nano_and_g25_different_parameter_locations(self):
        for model in ['deepwhiteai-image-nb-pro','deepwhiteai-image-g-v2.5-flare']:
            job=await self.finish(self.payload(model=model,params={'resolution':'2k','ratio':'9:16'}));self.assertEqual(job['status'],'succeeded')
            b=json.loads(self.posts()[-1].content);self.assertEqual(b['size'],'9:16')
            if 'nb-' in model:self.assertEqual(b['metadata']['resolution'],'2k')
            else:self.assertEqual(b['resolution'],'2k');self.assertEqual(b['quality'],'auto');self.assertNotIn('metadata',b)

    async def test_text_request_history_and_result(self):
        model=next(e['model_name'] for e in RAW['data'] if 'deepseek' in e['model_name'])
        job=await self.finish(self.payload(kind='chat',model=model,system_prompt='改写，不改变原意。',messages=[{'role':'assistant','content':'此前回答'}]))
        self.assertEqual(job['status'],'succeeded');self.assertEqual(job['text'],'模拟生成的文本')
        b=json.loads(self.posts()[0].content);self.assertEqual(b['messages'][0]['role'],'system');self.assertFalse(b['stream'])
        history=(await self.api.get('/api/studio/generations?canvas_id=test-canvas')).json()
        self.assertTrue(any(j['id']==job['id'] and j['text'] for j in history['items']))

    async def test_repeat_request_id_does_not_charge_twice(self):
        p=self.payload();job=await self.finish(p);await gen.submit(p)
        self.assertEqual(len(self.posts()),1)
        with self.assertRaises(HTTPException):await gen.submit(p.model_copy(update={'prompt':'changed'}))

    async def test_poll_failure_resume_only_get(self):
        self.get_failure=True;p=self.payload();job=await self.finish(p);self.assertEqual(job['status'],'paused')
        self.get_failure=False
        r=await self.api.post(f'/api/studio/generations/{job["id"]}/resume');self.assertEqual(r.status_code,200)
        task=gen.WORKERS.get(job['id'])
        if task:await task
        self.assertEqual(gen.read(job['id'])['status'],'succeeded');self.assertEqual(len(self.posts()),1)

    async def test_lost_submit_response_stops_no_retry(self):
        for failure in ('timeout','server'):
            self.calls=[];self.failure=failure;job=await self.finish(self.payload());self.assertEqual(job['status'],'uncertain')
            r=await self.api.post(f'/api/studio/generations/{job["id"]}/resume');self.assertEqual(r.status_code,409)
            self.assertEqual(len(self.posts()),1);self.assertNotIn('sk-offline',json.dumps(job))

    async def test_restart_during_submit_is_uncertain(self):
        p=self.payload()
        with patch.object(gen,'start'):
            job=await gen.submit(p)
        saved=gen.read(job['id']);saved['children'][0]['status']='submitting';gen.save(saved)
        await gen.execute(job['id']);self.assertEqual(gen.read(job['id'])['status'],'uncertain');self.assertEqual(len(self.posts()),0)

    async def test_restart_with_task_id_recovers_without_submit(self):
        p=self.payload()
        with patch.object(gen,'start'):job=await gen.submit(p)
        saved=gen.read(job['id']);saved['children'][0].update(status='running',upstream_id='restored-id');gen.save(saved)
        await gen.execute(job['id']);self.assertEqual(gen.read(job['id'])['status'],'succeeded');self.assertEqual(len(self.posts()),0)

    async def test_validation_rejects_before_any_upload_or_charge(self):
        for kw in [{'params':{'resolution':'4k'}},{'model':'deepwhiteai-image-g-v2.5-flare','params':{'background':'transparent','output_format':'jpeg'}},{'kind':'video','model':'seedance-2.0-fast','frame_mode':True},{'references':[{'url':'C:/private/file.png'}]}]:
            with self.assertRaises(HTTPException):await gen.submit(self.payload(**kw))
        self.assertEqual(self.calls,[])

    async def test_auth_balance_error_sanitized(self):
        self.failure='balance';job=await self.finish(self.payload());self.assertEqual(job['status'],'failed');self.assertIn('额度',job['error']);self.assertNotIn('sk-offline',json.dumps(job))

    async def test_batch_preserves_each_task(self):
        job=await self.finish(self.payload(count=3));self.assertEqual(job['status'],'succeeded');self.assertEqual(len(job['task_ids']),3);self.assertEqual(len(job['outputs']),6);self.assertEqual(len(self.posts()),3)

    async def test_changed_base_blocks_resume(self):
        self.get_failure=True;job=await self.finish(self.payload());core.save_api_providers([core.normalize_provider({'id':'deepwhite','base_url':'https://other.test/v1','enabled':True})])
        r=await self.api.post(f'/api/studio/generations/{job["id"]}/resume');self.assertEqual(r.status_code,400);self.assertEqual(len(self.posts()),1)

    async def test_wan_reference_and_omni_top_level_fields(self):
        job=await self.finish(self.payload(kind='video',model='wan-3.0',references=[{'url':'https://cdn.test/ref.mp4','kind':'video'}]))
        self.assertEqual(job['status'],'succeeded',job['error']);body=json.loads(self.posts()[-1].content)
        self.assertEqual(body['model'],'wan-3.0-r2v');self.assertEqual(body['metadata']['video_url'],['https://cdn.test/ref.mp4']);self.assertEqual(body['metadata']['resolution'],'720P')
        job=await self.finish(self.payload(kind='video',model='deepwhiteai-video-g-omni-flash-lowprice',references=[{'url':'https://cdn.test/ref.mp4','kind':'video'}]))
        self.assertEqual(job['status'],'succeeded',job['error']);body=json.loads(self.posts()[-1].content)
        self.assertEqual(body['resolution'],'720p');self.assertEqual(body['aspect_ratio'],'16:9');self.assertNotIn('seconds',body);self.assertEqual(body['metadata']['video_url'],'https://cdn.test/ref.mp4')
        with self.assertRaises(HTTPException):await gen.submit(self.payload(kind='video',model='deepwhiteai-video-g-omni-flash-lowprice',references=[{'url':'https://cdn.test/a.png','kind':'image'},{'url':'https://cdn.test/b.png','kind':'image'}]))

    async def test_lowprice_actual_prompt_minimum_and_safe_platform_error(self):
        for prompt in ['猫','一只猫','    猫    ']:
            with self.assertRaises(HTTPException) as caught:await gen.submit(self.payload(model='deepwhiteai-image-g-v2.5-lowprice',prompt=prompt))
            self.assertIn('5–5000',str(caught.exception.detail))
        self.assertEqual(self.calls,[])
        job=await self.finish(self.payload(model='deepwhiteai-image-g-v2.5-lowprice',prompt='一只白色猫'))
        self.assertEqual(job['status'],'succeeded');self.assertEqual(json.loads(self.posts()[0].content)['prompt'],'一只白色猫')
        self.failure='bad_prompt'
        job=await self.finish(self.payload(model='deepwhiteai-image-g-v2.5-lowprice'))
        self.assertIn('prompt length must be between 5 and 5000',job['error']);self.assertNotIn('sk-offline-test-only',json.dumps(job));self.assertEqual(job['children'][0]['platform_request_id'],'fixture-request-400')

    async def test_seedance_mentions_follow_media_identity_and_validate_missing(self):
        refs=[{'kind':'image','url':'https://cdn.test/b.png','mention':'@图片2'},{'kind':'video','url':'https://cdn.test/v.mp4','mention':'@视频1'},{'kind':'image','url':'https://cdn.test/a.png','mention':'@图片1'},{'kind':'audio','url':'https://cdn.test/a.mp3','mention':'@音频1'}]
        text='让 @图片1 参照 @视频1 运动，背景为 @图片2，声音参考 @音频1'
        job=await self.finish(self.payload(kind='video',model='seedance-2.0-fast',references=refs,prompt=text))
        self.assertEqual(job['status'],'succeeded',job['error']);body=json.loads(self.posts()[0].content)
        self.assertEqual(body['prompt'],'让 @Image 2 参照 @Video 1 运动，背景为 @Image 1，声音参考 @Audio 1')
        self.assertEqual(job['request']['input_prompt'],text);self.assertEqual(body['metadata']['content'][0]['image_url']['url'],'https://cdn.test/b.png')
        before=len(self.calls)
        for prompt in ['引用 @图片3','引用 @Video 2','引用 @Audio 0']:
            with self.assertRaises(HTTPException):await gen.submit(self.payload(kind='video',model='seedance-2.0-fast',references=refs,prompt=prompt))
        with self.assertRaises(HTTPException):await gen.submit(self.payload(kind='video',model='seedance-2.0-fast',references=refs[:2],prompt='引用 @图片1'))
        self.assertEqual(before,len(self.calls))

if __name__=='__main__':
    unittest.main()
