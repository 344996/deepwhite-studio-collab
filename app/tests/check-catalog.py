import os
import sys
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='deepwhite-catalog-test-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import httpx
import main as core
import studio_server
import studio_catalog as catalog
import studio_settings

MODELS=['demo-image-t2i','demo-image-i2i','demo-image-pro-t2i','demo-video-t2v','demo-video-i2v','demo-video-multi','demo-video-fast-t2v','demo-video-fast-i2v','demo-chat','demo-audio','needs-image-i2i']
RECORDS=[{'id':mid,'kind':'chat' if mid=='demo-chat' else 'audio' if mid=='demo-audio' else 'image' if 'image' in mid else 'video'} for mid in MODELS]
KEY='sk-fixture-catalog-only-12345678'
PAYLOAD={'id':'deepwhite','name':'DeepWhite','base_url':'https://example.test/v1','api_key':KEY,'primary':True}

class CatalogTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        catalog.save_store({})
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=studio_server.app),base_url='http://testserver')
        self.read=patch.object(studio_settings,'read_models',AsyncMock(return_value={'model_records':RECORDS,'model_count':len(RECORDS)}));self.read.start()
        self.meta=patch.object(catalog,'metadata',AsyncMock(return_value=({},{})));self.meta.start()
    async def asyncTearDown(self):
        self.read.stop();self.meta.stop();await self.client.aclose()
    async def sync(self):
        r=await self.client.post('/api/studio/settings/sync-models',json=PAYLOAD)
        self.assertEqual(r.status_code,200,r.text)
        self.assertNotIn(KEY,r.text)
        return r.json()
    async def test_auto_import_and_preferences_survive_refresh(self):
        result=await self.sync()
        self.assertEqual(len(result['models']),7)
        self.assertTrue(all(m['enabled'] for m in result['models']))
        self.assertEqual(set(result['provider']['image_models']),{'demo-image','demo-image-pro'})
        self.assertEqual(set(result['provider']['video_models']),{'demo-video','demo-video-fast'})
        r=await self.client.patch('/api/studio/model-catalog/deepwhite',json={'models':[{'id':'demo-image','enabled':False},{'id':'demo-video','removed':True}]})
        self.assertEqual(r.status_code,200)
        result=await self.sync()
        self.assertNotIn('demo-image',result['provider']['image_models'])
        self.assertNotIn('demo-video',result['provider']['video_models'])
        self.assertTrue(next(m for m in result['models'] if m['id']=='demo-video')['removed'])
        r=await self.client.patch('/api/studio/model-catalog/deepwhite',json={'models':[{'id':'demo-image','enabled':True},{'id':'demo-video','enabled':True,'removed':False}]})
        self.assertIn('demo-image',r.json()['provider']['image_models'])
        self.assertIn('demo-video',r.json()['provider']['video_models'])
    async def test_actual_image_endpoints_resolve_after_input_changes(self):
        await self.sync()
        for path,method in [('/api/online-image','online_image'),('/api/canvas-image-tasks','create_canvas_image_task')]:
            with patch.object(core,method,AsyncMock(return_value={'ok':True})) as generate:
                p={'provider_id':'deepwhite','model':'demo-image','prompt':'fixture'}
                r=await self.client.post(path,json=p);self.assertEqual(r.status_code,200)
                self.assertEqual(generate.call_args.args[0].model,'demo-image-t2i')
                p['reference_images']=[{'url':'https://assets.test/ref.png'}]
                r=await self.client.post(path,json=p);self.assertEqual(r.status_code,200)
                self.assertEqual(generate.call_args.args[0].model,'demo-image-i2i')
                # Legacy raw IDs still respect current inputs instead of pinning the old mode.
                p['model']='demo-image-t2i'
                r=await self.client.post(path,json=p);self.assertEqual(r.status_code,200)
                self.assertEqual(generate.call_args.args[0].model,'demo-image-i2i')
    async def test_video_routes_and_disabled_models(self):
        await self.sync()
        with patch.object(core,'canvas_video',AsyncMock(return_value={'ok':True})) as generate:
            p={'provider_id':'deepwhite','model':'demo-video','prompt':'fixture'}
            await self.client.post('/api/canvas-video',json=p);self.assertEqual(generate.call_args.args[0].model,'demo-video-t2v')
            p['images']=[{'url':'https://assets.test/ref.png'}]
            await self.client.post('/api/canvas-video',json=p);self.assertEqual(generate.call_args.args[0].model,'demo-video-i2v')
            p['videos']=['https://assets.test/ref.mp4']
            await self.client.post('/api/canvas-video',json=p);self.assertEqual(generate.call_args.args[0].model,'demo-video-multi')
            p['model']='demo-video-fast'
            r=await self.client.post('/api/canvas-video',json=p);self.assertEqual(r.status_code,400)
        await self.client.patch('/api/studio/model-catalog/deepwhite',json={'models':[{'id':'demo-image','enabled':False}]})
        with patch.object(core,'online_image',AsyncMock()) as generate:
            r=await self.client.post('/api/online-image',json={'provider_id':'deepwhite','model':'demo-image-t2i','prompt':'fixture'})
            self.assertEqual(r.status_code,400);generate.assert_not_called()
            r=await self.client.post('/api/online-image',json={'provider_id':'deepwhite','model':'needs-image','prompt':'fixture'})
            self.assertEqual(r.status_code,400);generate.assert_not_called()
    async def test_public_catalog_classifies_real_names_without_user_input(self):
        raw=json.loads(catalog.SNAPSHOT.read_text(encoding='utf-8'))
        meta={m['model_name']:m for m in raw['data']}
        entries=catalog.build_catalog(list(meta),meta,{str(v['id']):v['name'] for v in raw['vendors']})
        self.assertTrue(all(m['kind'] in (*catalog.KINDS,'other') for m in entries))
        self.assertEqual({m['id'] for m in entries if m['kind']=='other'}, {'hunyuan3d-v3.1-image-to-3d','hunyuan3d-v3.1-text-to-3d','kling-lip-sync-identify-face'})
        self.assertEqual(next(m for m in entries if m['id']=='minmax-h3-context-ir-image')['kind'],'chat')
        family=next(m for m in entries if m['id']=='deepwhiteai-image-g2')
        self.assertEqual(set(family['variants']),{'t2i','i2i'})
        self.assertTrue(all(not catalog.MODE.search(m['name']) for m in entries if m['kind'] in ('image','video')))
    async def test_sync_failure_does_not_erase_existing_models(self):
        await self.sync();before=catalog.load_store()
        studio_settings.read_models.return_value={'model_records':[],'model_count':0}
        r=await self.client.post('/api/studio/settings/sync-models',json=PAYLOAD)
        self.assertEqual(r.status_code,400);self.assertEqual(catalog.load_store(),before)

if __name__=='__main__':
    try:unittest.main()
    finally:runtime.cleanup()
