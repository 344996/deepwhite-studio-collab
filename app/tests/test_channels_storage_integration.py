"""Cross-module checks: cached generation results, selected storage, stable URLs."""
import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='dw-storage-integration-')
external=tempfile.TemporaryDirectory(prefix='dw-storage-integration-media-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import httpx
import studio_server
import studio_assets
import studio_generation
import studio_dreamina
import studio_control
import main as core

PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=')

class Integration(unittest.IsolatedAsyncioTestCase):
    async def test_remote_result_project_directory_and_migration(self):
        core.ensure_default_project()
        core.save_canvas({'id':'storageintegration','project':'default','nodes':[],'connections':[]})
        first=Path(external.name)/'first';second=Path(external.name)/'second'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=studio_server.app),base_url='http://testserver') as api:
            r=await api.put('/api/studio/storage/projects/default',json={'path':str(first),'migrate':True})
            self.assertEqual(r.status_code,200,r.text)
            calls=[]
            def download(request):
                calls.append(request.method)
                self.assertNotIn('authorization',request.headers)
                return httpx.Response(200,headers={'content-type':'image/png'},content=PNG)
            async with httpx.AsyncClient(transport=httpx.MockTransport(download)) as client:
                output=await studio_generation.persist_media(client,'https://cdn.invalid/image','image','integrationjob','0',
                    request={'canvas_id':'storageintegration','provider_id':'test','model':'fixture','prompt':'测试提示词','params':{'ratio':'1:1'}})
            self.assertEqual(calls,['GET'])
            self.assertTrue(output['url'].startswith('/api/studio/assets/'))
            old=studio_assets.file_path(output['version_id'])
            self.assertTrue(Path(old).is_relative_to(first))
            self.assertEqual(Path(old).read_bytes(),PNG)
            response=await api.get(output['url']);self.assertEqual(response.content,PNG)
            r=await api.put('/api/studio/storage/projects/default',json={'path':str(second),'migrate':True})
            self.assertEqual(r.status_code,200,r.text)
            self.assertTrue(Path(studio_assets.file_path(output['version_id'])).is_relative_to(second))
            self.assertEqual((await api.get(output['url'])).content,PNG)
            self.assertTrue(Path(old).is_file(),'Migration must retain the old media')

    async def test_mcp_lists_optional_channel_without_cli_call(self):
        # External agents plan through MCP list_models; listing must not run the CLI.
        model=studio_dreamina.models()[0]
        with patch.object(studio_dreamina,'config',return_value={'enabled':True,'cli_path':'','models':{model['id']:True}}),              patch.object(studio_dreamina,'_run_cli',side_effect=AssertionError('Listing cannot invoke CLI')):
            rows=studio_control._models()
        self.assertTrue(any(r['provider_id']==studio_dreamina.PROVIDER and r['model']==model['id'] for r in rows))

if __name__=='__main__':unittest.main()
