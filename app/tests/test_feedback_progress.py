import asyncio,json,sys,unittest,os,tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='studio-feedback-progress-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import studio_comfy as comfy
from studio_account import wallet

class Feedback(unittest.IsolatedAsyncioTestCase):
    async def test_progress_only_matches_current_prompt(self):
        child={'status':'running','upstream_id':'mine'};job={'id':'test','children':[child]};records=[]
        events=[{'type':'progress','data':{'prompt_id':'other','value':99,'max':100}},
                {'type':'progress','data':{'prompt_id':'mine','value':10,'max':40}},
                {'type':'executing','data':{'prompt_id':'mine','node':None}}]
        class Socket:
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            def __aiter__(self):return self
            async def __anext__(self):
                if not events:raise StopAsyncIteration
                return json.dumps(events.pop(0))
        ready=asyncio.Event()
        with patch('websockets.connect',return_value=Socket()),patch('studio_generation.save',side_effect=lambda j:records.append(dict(child))):
            await comfy.watch_progress(job,ready)
        self.assertTrue(ready.is_set());self.assertEqual(len(records),2)
        self.assertEqual(records[0]['progress'],25);self.assertNotIn('progress',records[1])
        self.assertEqual(records[1]['stage'],'整理输出')

    def test_avatar_is_optional_and_unsafe_schemes_rejected(self):
        self.assertEqual(wallet({'username':'tester','avatar_url':'/avatar/a.png'}, {})['avatar_url'],'https://api.deepwhiteai.com/avatar/a.png')
        self.assertNotIn('avatar_url',wallet({'avatar':'javascript:alert(1)'},{}))
        self.assertNotIn('avatar_url',wallet({'avatar':{'nested':'value'}},{}))

if __name__=='__main__':unittest.main()
