import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock,patch

os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=tempfile.mkdtemp(prefix='rh-durable-')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import studio_runninghub as rh

class DurableTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Other suites deliberately replace the configured provider catalogue.
        provider=patch.object(rh.core,'runninghub_provider',return_value={'id':'runninghub'})
        provider.start();self.addCleanup(provider.stop)
        key=patch.object(rh.core,'runninghub_api_key',return_value='isolated-key')
        key.start();self.addCleanup(key.stop)

    def request(self,key):return rh.Submit(request_id=key,canvas_id='canvas',node_id='node',kind='app',payload={'webappId':'12345678','nodeInfoList':[]})

    async def test_idempotency_and_conflict(self):
        request=self.request('request-0001');submit=AsyncMock(return_value={'data':{'taskId':'remote-1'}})
        with patch.object(rh.core,'runninghub_api_key',return_value='fake'),patch.object(rh.core,'runninghub_submit',submit):
            first=await rh.submit(request);second=await rh.submit(request)
            self.assertEqual(first['task_id'],second['task_id']);submit.assert_awaited_once()
            request.payload['webappId']='87654321'
            with self.assertRaises(rh.HTTPException) as error:await rh.submit(request)
            self.assertEqual(error.exception.status_code,409)

    async def test_uncertain_not_resubmitted(self):
        request=self.request('request-0002');submit=AsyncMock(side_effect=TimeoutError())
        with patch.object(rh.core,'runninghub_api_key',return_value='fake'),patch.object(rh.core,'runninghub_submit',submit):
            self.assertEqual((await rh.submit(request))['status'],'uncertain')
            self.assertEqual((await rh.submit(request))['status'],'uncertain');submit.assert_awaited_once()

    async def test_restart_and_archive_retry(self):
        record={'id':'request-0003','request':self.request('request-0003').model_dump(),'status':'queued','task_id':'remote-3','outputs':[],'error':''};rh.save(record)
        with patch.object(rh.core,'runninghub_query',AsyncMock(return_value={'data':{'status':'SUCCESS','urls':['https://example.test/result.mp4']}})):
            self.assertEqual((await rh.query(record['id']))['status'],'archiving')
        with patch.object(rh.core,'runninghub_query',AsyncMock(return_value={'data':{'status':'SUCCESS','urls':['/output/result.mp4']}})) as query:
            result=await rh.query(record['id']);self.assertEqual(result['status'],'succeeded');await rh.query(record['id']);query.assert_awaited_once()

    async def test_interrupted_submission_and_bad_id(self):
        rh.save({'id':'request-0004','request':self.request('request-0004').model_dump(),'status':'submitting','task_id':'','outputs':[],'error':''})
        self.assertEqual(rh.read('request-0004')['status'],'uncertain')
        with self.assertRaises(rh.HTTPException):rh.read('../escape')

    async def test_changed_provider_cannot_query_another_service(self):
        record={'id':'request-0005','request':self.request('request-0005').model_dump(),'base_url':'https://original.invalid','status':'queued','task_id':'remote-5','outputs':[],'error':''};rh.save(record)
        with patch.object(rh.core,'runninghub_query',AsyncMock()) as query:
            result=await rh.query(record['id']);query.assert_not_awaited()
            self.assertEqual(result['status'],'queued');self.assertIn('地址已改变',result['error'])

if __name__=='__main__':unittest.main()
