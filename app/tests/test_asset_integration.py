"""Real local asset routes and canvas migration, isolated from user data/network."""
import asyncio
import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix='dw-assets-integration-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import httpx
import studio_server
import main as core
import studio_assets as assets
import studio_midjourney as mj

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=')
Client = httpx.AsyncClient

class Integration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.api = Client(transport=httpx.ASGITransport(app=studio_server.app), base_url='http://testserver')

    async def asyncTearDown(self):
        await self.api.aclose()

    async def test_lifecycle_canvas_roundtrip_and_file_resolution(self):
        upload = await self.api.post('/api/studio/assets/import', files={'file': ('portrait.png', PNG, 'image/png')}, data={'project_id':'integration'})
        self.assertEqual(upload.status_code,200,upload.text)
        item = upload.json()['item']
        self.assertEqual(item['status'],'candidate')
        self.assertEqual(Path(core.output_file_from_url(item['url'])).read_bytes(),PNG)
        original={'id':'integrationcanvas','project':'integration','nodes':[{'id':'n1','type':'image','url':item['url'],'custom':{'keep':True}}],'connections':[]}
        core.save_canvas(original)
        restored=core.load_canvas('integrationcanvas')
        self.assertTrue(restored['nodes'][0]['custom']['keep'])
        self.assertEqual(restored['nodes'][0]['studioAssetRefs'][0]['version_id'],item['version_id'])
        confirmed=await self.api.post('/api/studio/assets/'+item['version_id']+'/confirm',json={'name':'人物设定','category':'character'})
        self.assertEqual(confirmed.status_code,200,confirmed.text)
        confirmed=confirmed.json()['item']
        self.assertEqual(confirmed['status'],'confirmed')
        self.assertEqual(confirmed['version_id'],item['version_id'])
        self.assertEqual(confirmed['sha256'],item['sha256'])
        self.assertEqual((await self.api.get(item['url'])).content,PNG)
        restored['nodes']=[];core.save_canvas(restored)
        self.assertEqual(restored['studioAssetRefs'],[])
        self.assertEqual((await self.api.get(item['url'])).status_code,200)
        archived=await self.api.post('/api/studio/assets/'+item['version_id']+'/archive',json={})
        self.assertEqual(archived.json()['item']['status'],'archived')
        self.assertEqual((await self.api.get(item['url'])).content,PNG)

    async def test_old_local_node_lazy_migration(self):
        path=Path(core.output_path_for('old-picture.png'));path.write_bytes(PNG)
        original={'id':'oldcanvas','project':'legacy','nodes':[{'id':'old','type':'image','url':core.output_url_for(path.name)}],'connections':[]}
        core.save_canvas(original)
        restored=core.load_canvas('oldcanvas')
        ref=restored['nodes'][0]['studioAssetRefs'][0]
        self.assertEqual(restored['nodes'][0]['url'],core.output_url_for(path.name))
        core.save_canvas(restored)
        self.assertEqual(core.load_canvas('oldcanvas')['nodes'][0]['studioAssetRefs'][0]['version_id'],ref['version_id'])

    async def test_mj_download_retry_does_not_resubmit(self):
        calls=[]
        def upstream(req):
            calls.append(req)
            self.assertEqual(req.method,'GET')
            self.assertNotIn('authorization',req.headers)
            return httpx.Response(200,content=PNG,headers={'content-type':'image/png'})
        result={'status':'succeeded','images':['https://result.test/durable.png'],'videos':[]}
        with patch.object(httpx,'AsyncClient',side_effect=lambda **kw:Client(**{**kw,'transport':httpx.MockTransport(upstream)})):
            await mj.persist_result(result,{})
            again={'status':'succeeded','images':['https://result.test/durable.png'],'videos':[]}
            await mj.persist_result(again,{})
        self.assertEqual(len(calls),1)
        self.assertEqual(again['images'],result['images'])
        self.assertTrue(result['asset_refs'][0]['version_id'])

if __name__=='__main__':
    unittest.main()
