"""Quotes and MJ action contracts. All upstream traffic uses MockTransport."""
import os, sys, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='deepwhite-commerce-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import httpx
import studio_server
import studio_catalog as catalog
import studio_pricing as pricing
import studio_midjourney as mj
import main as core
from fastapi import HTTPException

RAW=json.loads(catalog.SNAPSHOT.read_text(encoding='utf-8'))
META={m['model_name']:m for m in RAW['data']}
KEY='sk-mock-commerce-only'
HTTPClient=httpx.AsyncClient

class CommerceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        core.save_api_providers([core.normalize_provider({'id':'deepwhite','name':'DeepWhite','base_url':'https://api.deepwhiteai.com/v1','enabled':True,'primary':True})])
        self.key=patch.object(core,'provider_env_key_value',return_value=KEY);self.key.start()
        entries=catalog.build_catalog(list(META),META)
        catalog.save_store({'deepwhite':{'base_url':'https://api.deepwhiteai.com/v1','models':entries}})
        catalog.apply_to_provider('deepwhite',entries)
        self.client=HTTPClient(transport=httpx.ASGITransport(app=studio_server.app),base_url='http://testserver')
        self.prices=patch.object(pricing,'snapshot',AsyncMock(return_value=RAW));self.prices.start()
    async def asyncTearDown(self):
        self.key.stop();self.prices.stop();await self.client.aclose()

    async def test_image_only_generation_and_two_level_metadata(self):
        models=core.get_api_provider('deepwhite')['image_models']
        self.assertIn('midjourney-imagine',models)
        self.assertNotIn('midjourney-describe',models)
        self.assertNotIn('midjourney-video',models)
        self.assertNotIn('deepwhiteai-image-gk-v2-edit',models)
        self.assertEqual(catalog.series_name('deepwhiteai-image-nb-2-lite'),'Nano Banana')
        self.assertEqual(catalog.series_name('seedance-2.0-fast'),'Seedance')

    async def test_seedance_defaults_to_multi_and_quote_matches_request(self):
        payload={'provider_id':'deepwhite','model':'seedance-2.0-fast','prompt':'本地视频提示词'}
        with patch.object(core,'canvas_video',AsyncMock(return_value={'ok':True})) as generate:
            r=await self.client.post('/api/canvas-video',json=payload)
            self.assertEqual(r.status_code,200,r.text)
            self.assertEqual(generate.call_args.args[0].model,'seedance-2.0-fast-t2v')
            self.assertTrue(generate.call_args.args[0].multimodal)
            self.assertEqual(generate.call_args.args[0].prompt,payload['prompt'])
            quote=(await self.client.post('/api/studio/quote',json={**{k:v for k,v in payload.items() if k!='prompt'},'kind':'video','multimodal':True})).json()
            self.assertEqual(quote['model'],'seedance-2.0-fast-t2v')
            await self.client.post('/api/canvas-video',json={**payload,'multimodal':False,'images':[{'url':'https://assets.test/first.png','role':'first_frame'}]})
            self.assertEqual(generate.call_args.args[0].model,'seedance-2.0-fast-i2v')
            await self.client.post('/api/canvas-video',json={**payload,'multimodal':True,'images':[{'url':'https://assets.test/ref.png'}]})
            self.assertEqual(generate.call_args.args[0].model,'seedance-2.0-fast-multi')

    async def test_quote_price_batch_mode_and_speed(self):
        p={'provider_id':'deepwhite','model':'deepwhiteai-image-g2','kind':'image'}
        a=(await self.client.post('/api/studio/quote',json=p)).json()
        b=(await self.client.post('/api/studio/quote',json={**p,'count':3})).json()
        self.assertGreater(a['price'],0);self.assertAlmostEqual(b['price'],a['price']*3)
        p.update(model='midjourney-imagine',params={'speed':'relax'})
        a=(await self.client.post('/api/studio/quote',json=p)).json()
        p['params']['speed']='turbo'
        b=(await self.client.post('/api/studio/quote',json=p)).json()
        self.assertGreater(b['price'],a['price'])

    async def test_unknown_feature_zero_and_video_duration_not_extrapolated(self):
        q=pricing.Quote(provider_id='deepwhite',model='demo',kind='video',params={'duration':5,'resolution':'720p'})
        raw={'price_estimates':{'demo':{'status':'ready','active_features':['seconds','resolution'],'entries':[{'params':{'seconds':10,'resolution':'480p'},'price_cny':2}]}}}
        self.assertIsNone(pricing.estimate(raw,'demo',q)['price'])
        raw['price_estimates']['demo']['entries'][0].update(params={'seconds':5,'resolution':'720p'},price_cny=0)
        self.assertIsNone(pricing.estimate(raw,'demo',q)['price'])
        raw['price_estimates']['demo']['entries'][0]['price_cny']=2
        self.assertEqual(pricing.estimate(raw,'demo',q)['price'],2)
        raw['price_estimates']['demo']['active_features'].append('unknown_feature')
        self.assertIsNone(pricing.estimate(raw,'demo',q)['price'])

    async def test_every_mj_action_uses_own_endpoint_and_body(self):
        samples={
          'imagine':{'prompt':'a cat','speed':'relax'}, 'blend':{'image_urls':['https://assets.test/a.png','https://assets.test/b.png']},
          'describe':{'image_urls':['https://assets.test/a.png']},'edits':{'prompt':'blue','image_urls':['https://assets.test/a.png']},
          'modal':{'task_id':'task_previous','prompt':'blue','mask_url':'https://assets.test/mask.png'},
          'video':{'image_urls':['https://assets.test/a.png'],'prompt':'move','animate_mode':'manual','video_type':'vid_1.1_i2v_480','batch_size':1},
        }
        requests=[]
        def transport(request):
            requests.append(request)
            return httpx.Response(200,json={'data':[{'task_id':'task_'+str(len(requests)),'status':'SUBMITTED'}]})
        with patch.object(mj.httpx,'AsyncClient',side_effect=lambda **kw:HTTPClient(transport=httpx.MockTransport(transport),**kw)):
            for action in mj.SPECS:
                body=samples.get(action,{'task_id':'task_previous',**({'index':1} if action in ['upscale','variation','high-variation','low-variation','remix-strong','remix-subtle'] else {}),**({'direction':'left'} if action=='pan' else {})})
                r=await self.client.post('/api/studio/mj/submit',json={'provider_id':'deepwhite','action':action,'params':body})
                self.assertEqual(r.status_code,200,(action,r.text))
                self.assertEqual(requests[-1].url.path,'/v1/midjourney/generations/'+action)
                self.assertEqual(json.loads(requests[-1].content),{**body,**({'version':'8.2'} if action=='imagine' else {})})
                self.assertNotIn(KEY,r.text)
        self.assertEqual(len(requests),16)

    async def test_validation_before_network_and_disabled_action(self):
        for action,params in [('blend',{'image_urls':['https://assets.test/a.png']}),('upscale',{'task_id':'task_old'}),('pan',{'task_id':'task_old'}),('modal',{'task_id':'task_old'}),('video',{'task_id':'task_old','image_urls':['https://assets.test/a.png']}),('upscale',{'task_id':'task_old','index':0}),('edits',{'prompt':'x','duration':10})]:
            with patch.object(mj,'upstream',AsyncMock()) as network:
                r=await self.client.post('/api/studio/mj/submit',json={'provider_id':'deepwhite','action':action,'params':params})
                self.assertEqual(r.status_code,400,(action,r.text));network.assert_not_called()
        store=catalog.load_store();next(m for m in store['deepwhite']['models'] if m['id']=='midjourney-blend')['enabled']=False;catalog.save_store(store)
        with self.assertRaises(HTTPException): mj.require_action('deepwhite','blend')

    async def test_result_families_modal_failure_and_prompt_describe(self):
        self.assertEqual(mj.normalize({'data':{'status':'MODAL','task_id':'task_m'}})['status'],'modal')
        self.assertEqual(mj.normalize({'status':'FAILURE'})['status'],'failed')
        result=mj.normalize({'data':{'prompt':'1. cat\n2. kitten'}},'describe')
        self.assertEqual(result['status'],'succeeded');self.assertIn('kitten',result['text'])
        result=mj.normalize({'data':{'status':'SUCCESS','video_url':'https://assets.test/video.mp4'}})
        self.assertEqual(len(result['videos']),1);self.assertFalse(result['images'])

    async def test_poll_is_get_and_address_change_blocks_existing_task(self):
        mj.remember('deepwhite',{'task_id':'task_existing'},'describe')
        requests=[]
        def transport(request):
            requests.append(request);return httpx.Response(200,json={'data':{'status':'SUCCESS','prompt':'four prompts'}})
        with patch.object(mj.httpx,'AsyncClient',side_effect=lambda **kw:HTTPClient(transport=httpx.MockTransport(transport),**kw)):
            result=await mj.poll('deepwhite','task_existing')
        self.assertEqual(result['text'],'four prompts');self.assertEqual(requests[0].method,'GET')
        p=core.load_api_providers();next(x for x in p if x['id']=='deepwhite')['base_url']='https://example.test/v1';core.save_api_providers(p)
        with patch.object(mj,'upstream',AsyncMock()) as network:
            with self.assertRaises(HTTPException): await mj.poll('deepwhite','task_existing')
            network.assert_not_called()

    async def test_mj_history_scope_poll_failure_and_no_truncation(self):
        import studio_mj_history as history
        self.assertEqual(mj.validated('imagine',{'prompt':'cat'})['version'],'8.2')
        self.assertEqual(mj.validated('imagine',{'prompt':'cat','version':'6.1'})['version'],'6.1')
        request=mj.Submission(provider_id='deepwhite',action='imagine',params={'prompt':'cat'},canvas_id='history-check',node_id='node-check')
        with patch.object(mj,'upstream',AsyncMock(return_value={'task_id':'history-task','status':'pending'})):
            await mj.submit(request)
        def media_response(request):
            self.assertEqual(request.url.host,'example.test')
            self.assertNotIn('authorization',request.headers)
            import base64
            png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=')
            return httpx.Response(200,content=png,headers={'content-type':'image/png'})
        with patch.object(mj,'upstream',AsyncMock(return_value={'task_id':'history-task','status':'succeeded','images':['https://example.test/a.png','https://example.test/b.png']})), patch.object(mj.httpx,'AsyncClient',side_effect=lambda **kw:HTTPClient(transport=httpx.MockTransport(media_response),**kw)):
            await mj.poll('deepwhite','history-task')
        response=await self.client.get('/api/studio/generations?canvas_id=history-check')
        items=response.json()['items'];self.assertEqual(len(items),1)
        self.assertEqual(len(items[0]['outputs']),2);self.assertEqual(items[0]['request']['params']['version'],'8.2')
        self.assertEqual((await self.client.get('/api/studio/generations?canvas_id=other-check')).json()['items'],[])
        with patch.object(mj,'upstream',AsyncMock(side_effect=HTTPException(502,'network'))):
            with self.assertRaises(HTTPException):await mj.submit(request)
        self.assertTrue(any(j['status']=='uncertain' for j in history.items('history-check')))
        for _ in range(301):history.begin(mj.Submission(provider_id='deepwhite',action='describe',canvas_id='many-check'),{})
        self.assertEqual(len((await self.client.get('/api/studio/generations?canvas_id=many-check')).json()['items']),301)

if __name__=='__main__':
    try: unittest.main()
    finally: runtime.cleanup()
