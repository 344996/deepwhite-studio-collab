"""Real isolated ASGI requests verify stale local edits cannot erase agent changes."""
import os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='studio-concurrency-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import httpx
import studio_server
import main as core


class CanvasConcurrency(unittest.IsolatedAsyncioTestCase):
    async def test_stale_and_missing_revisions_are_rejected(self):
        canvas={'id':'concurrent','title':'并行编辑','nodes':[],'connections':[],'project':'default'}
        core.save_canvas(canvas);original=canvas['updated_at']
        canvas['nodes']=[{'id':'external','type':'prompt','text':'外部智能体新节点'}]
        core.save_canvas(canvas)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=studio_server.app),base_url='http://testserver') as client:
            for timestamp in (original,0,canvas['updated_at']+100):
                response=await client.put('/api/canvases/concurrent',json={'nodes':[],'connections':[],'base_updated_at':timestamp})
                self.assertEqual(response.status_code,409,response.text)
                self.assertEqual(core.load_canvas('concurrent')['nodes'][0]['id'],'external')
            response=await client.put('/api/canvases/concurrent',json={'nodes':canvas['nodes'],'connections':[],'title':'保留节点','base_updated_at':canvas['updated_at']})
            self.assertEqual(response.status_code,200,response.text)
            self.assertGreater(response.json()['canvas']['updated_at'],canvas['updated_at'])

    async def test_same_clock_tick_produces_distinct_revisions(self):
        canvas={'id':'sameclock','nodes':[],'connections':[]}
        with patch.object(core,'now_ms',return_value=100):
            core.save_canvas(canvas);one=canvas['updated_at']
            core.save_canvas(canvas);two=canvas['updated_at']
        self.assertGreater(two,one)


if __name__=='__main__':unittest.main()
