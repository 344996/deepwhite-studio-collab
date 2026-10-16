import os,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='studio-inputs-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import studio_server,studio_assets
import main as core
from fastapi import HTTPException
from studio_control_inputs import node_request,request_fingerprint

class Inputs(unittest.TestCase):
    def setUp(self):
        name='input.png';Path(core.output_path_for(name)).write_bytes(b'image fixture')
        self.asset=studio_assets.register_local(core.output_url_for(name),project_id='default')
        self.node={'id':'video','type':'video','model':'seedance-2.5','apiProvider':'deepwhite','studioPrompt':'使用 @图片7 拍摄','studioRefLabels':{self.asset['url']:'@图片7'}}
        self.canvas={'id':'inputs','project':'default','nodes':[self.node,{'id':'img','type':'image','url':self.asset['url']},{'id':'text','type':'prompt','text':'白天的街道'}],
            'connections':[{'from':'text','to':'video'},{'from':'img','to':'video'}]}

    def test_connections_prompt_mapping_and_digest(self):
        first=node_request(self.canvas,self.node,'request-123')
        self.assertIn('白天的街道',first.prompt)
        self.assertEqual(first.references[0]['mention'],'@图片7')
        self.assertEqual(first.references[0]['version_id'],self.asset['version_id'])
        self.canvas['nodes'][2]['text']='夜晚的街道'
        second=node_request(self.canvas,self.node,'request-123')
        self.assertNotEqual(request_fingerprint(first),request_fingerprint(second))

    def test_exclusion_deduplication_and_frame_roles(self):
        self.node['studioRefs']=[{'url':self.asset['url'],'kind':'image'}]
        self.assertEqual(len(node_request(self.canvas,self.node,'request-123').references),1)
        self.node['useFrameRoles']=True
        with self.assertRaises(HTTPException):node_request(self.canvas,self.node,'request-123')
        self.node['studioRefRoles']={self.asset['url']:'first_frame'}
        self.assertTrue(node_request(self.canvas,self.node,'request-123').frame_mode)
        self.node['useFrameRoles']=False;self.node['studioExcludedRefs']=[self.asset['url']]
        self.assertEqual(node_request(self.canvas,self.node,'request-123').references,[])

    def test_other_project_and_pending_upstream_fail_closed(self):
        self.canvas['project']='other'
        with self.assertRaises(HTTPException):node_request(self.canvas,self.node,'request-123')
        self.canvas['project']='default';self.canvas['nodes'][1]={'id':'img','type':'generator','generatedOutputs':[]}
        with self.assertRaises(HTTPException):node_request(self.canvas,self.node,'request-123')

    def test_workflow_relation_is_not_generation_input(self):
        self.canvas['nodes'].append({'id':'skill','type':'prompt','text':'internal skill instructions'})
        self.canvas['connections'].append({'from':'skill','to':'video','studioRole':'agent-workflow'})
        request=node_request(self.canvas,self.node,'request-123')
        self.assertNotIn('internal skill instructions',request.prompt)
        self.assertIn('白天的街道',request.prompt)

if __name__=='__main__':unittest.main()
