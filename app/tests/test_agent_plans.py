"""Offline canvas plan transaction and stable material mapping checks."""
import os,sys,tempfile,unittest,uuid,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='dw-agent-plans-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import studio_server
import studio_agent as agent
import studio_agent_plans as plans
import studio_assets as assets
import studio_generation as generation
import studio_catalog as catalog
import main as core
from fastapi import HTTPException

class Plans(unittest.TestCase):
    def setUp(self):
        self.cid=uuid.uuid4().hex
        self.pid='p_'+uuid.uuid4().hex
        core.save_api_providers([core.normalize_provider({'id':'agent-fixture','name':'Fixture','base_url':'https://fixture.invalid/v1',
            'enabled':True,'chat_models':['fixture-chat'],'image_models':['image-g-v2.5-high'],'video_models':['seedance-2.5-standard']})])
        catalog.save_store({})
        self.canvas={'id':self.cid,'title':'Agent fixture','project':self.pid,'nodes':[],'connections':[]}
        core.save_canvas(self.canvas)
        self.targets=agent.available_models()[1]
        self.selection={'image':{'provider_id':'agent-fixture','model':'image-g-v2.5-high'},
            'video':{'provider_id':'agent-fixture','model':'seedance-2.5-standard'}}
    def ctx(self,refs=[]):
        value=plans.context(self.cid,[],refs);value['target_models']=self.selection;return value
    def asset(self,project=None):
        name=uuid.uuid4().hex+'.png';Path(core.output_path_for(name)).write_bytes(b'image fixture')
        return assets.register_local(core.output_url_for(name),project_id=project or self.pid)
    def session(self,plan):
        return {'id':uuid.uuid4().hex,'canvas_id':self.cid,'project_id':self.pid,'status':'completed','plan':plan,'messages':[]}
    def test_image_plan_apply_is_idempotent_and_never_runs(self):
        plan=plans.validate_plan({'nodes':[{'key':'hero','kind':'image','title':'主角','prompt':'一位身穿灰色西装的女性，写实摄影风格'}]},self.ctx(),self.targets)
        session=self.session(plan);agent.save_session(session)
        first=plans.apply_plan(session,plan);second=plans.apply_plan(session,plan)
        self.assertEqual(first['node_ids'],second['node_ids'])
        self.assertEqual(len(first['canvas']['nodes']),1)
        self.assertFalse(first['canvas']['nodes'][0].get('running'))
        self.assertTrue(second['already_applied'])
    def test_video_mapping_compiles_stable_asset_versions(self):
        item=self.asset()
        plan=plans.validate_plan({'nodes':[{'key':'shot1','kind':'video','title':'进入办公室',
            'prompt':'{{asset:'+item['version_id']+'}} 走进办公室，缓慢推近。',
            'references':[{'version_id':item['version_id'],'label':'女主'}]}]},self.ctx([item['version_id']]),self.targets)
        result=plans.apply_plan(self.session(plan),plan)
        video=next(n for n in result['canvas']['nodes'] if n['type']=='video')
        self.assertIn('@图片1',video['studioPrompt'])
        self.assertTrue(video['multimodal']);self.assertFalse(video['useFrameRoles'])
        self.assertEqual(video['studioRefLabels'][item['url']],'@图片1')
        self.assertEqual(len(result['canvas']['connections']),1)
        sent=generation.seedance_prompt(video['studioPrompt'],plan['nodes'][0]['references'])
        self.assertIn('@Image 1',sent)
    def test_changed_canvas_rejects_plan(self):
        plan=plans.validate_plan({'nodes':[{'key':'hero','kind':'image','prompt':'人物效果图，柔和侧光'}]},self.ctx(),self.targets)
        self.canvas['nodes']=[{'id':'user','type':'prompt','text':'手工修改'}];core.save_canvas(self.canvas)
        with self.assertRaises(HTTPException) as error:plans.apply_plan(self.session(plan),plan)
        self.assertEqual(error.exception.status_code,409)
        self.assertEqual(core.load_canvas(self.cid)['nodes'][0]['text'],'手工修改')
    def test_foreign_and_unbound_references_rejected(self):
        foreign=self.asset('foreign')
        raw={'nodes':[{'key':'x','kind':'video','prompt':'缓慢推近','references':[{'version_id':foreign['version_id']}]}]}
        with self.assertRaises(HTTPException):plans.validate_plan(raw,self.ctx(),self.targets)
        raw['nodes'][0].update(references=[],prompt='{{asset:'+foreign['version_id']+'}} 缓慢推近')
        with self.assertRaises(HTTPException):plans.validate_plan(raw,self.ctx(),self.targets)

    def test_uncertain_active_generation_cannot_be_rewritten(self):
        self.canvas['nodes']=[{'id':'existing','type':'generator','studioJobState':'uncertain','x':0,'y':0}]
        core.save_canvas(self.canvas)
        with self.assertRaises(HTTPException) as error:
            plans.validate_plan({'nodes':[{'key':'hero','kind':'image','target_node_id':'existing',
                'prompt':'灰色西装女性角色设定图'}]},self.ctx(),self.targets)
        self.assertEqual(error.exception.status_code,409)
    def test_revise_existing_node_preserves_outputs(self):
        self.canvas['nodes']=[{'id':'existing','type':'generator','studioPrompt':'旧文案','images':[{'url':'/old.png'}],'x':0,'y':0}]
        core.save_canvas(self.canvas)
        plan=plans.validate_plan({'nodes':[{'key':'hero','kind':'image','target_node_id':'existing','prompt':'更新后的角色提示词，灰色西装'}]},self.ctx(),self.targets)
        result=plans.apply_plan(self.session(plan),plan)
        self.assertEqual(len(result['canvas']['nodes']),1)
        self.assertEqual(result['canvas']['nodes'][0]['images'],[{'url':'/old.png'}])
        self.assertIn('更新',result['canvas']['nodes'][0]['studioPrompt'])

    def test_agent_chain_uses_metadata_links_and_reuses_nodes_on_revision(self):
        chain_sid=uuid.uuid4().hex
        source={'id':'script-source','type':'prompt','text':'女主进入办公室。','studioTitle':'剧本.txt',
                'studioAgentNodeKind':'script-source','studioAgentSession':chain_sid}
        self.canvas['nodes']=[source];core.save_canvas(self.canvas)
        session={'id':chain_sid,'canvas_id':self.cid,'project_id':self.pid,'status':'completed',
            'plan':None,'turns':[],'applied_node_ids':[]}
        agent.save_session(session)
        def make_plan(requirement):
            ctx=self.ctx();ctx['nodes']=[{'id':'script-source','type':'prompt','title':'剧本.txt','prompt':'女主进入办公室。'}]
            plan=plans.validate_plan({'nodes':[{'key':'hero','kind':'image','title':'女主','prompt':requirement}]},ctx,self.targets)
            session['plan']=plan
            session['turns'].append({'status':'completed','plan':plan,'request_id':'turn-'+str(len(session['turns'])),
                'user_message':requirement,'node_ids':['script-source'],'skill_snapshots':{'skill-1':{'name':'角色资产技能'}}})
            return plan
        first=make_plan('灰色西装的女性角色设定图')
        result1=plans.apply_plan(session,first)
        image1=next(n for n in result1['canvas']['nodes'] if n['type']=='generator')
        skill1=next(n for n in result1['canvas']['nodes'] if n.get('studioAgentNodeKind')=='skill-run')
        self.assertEqual(skill1['studioSkillNode']['input_node_ids'],['script-source'])
        self.assertEqual(skill1['studioSkillNode']['output_node_ids'],[image1['id']])
        self.assertEqual(image1['studioAgentSkillNodeId'],skill1['id'])
        self.assertEqual(result1['canvas']['connections'],[])
        image1['images']=[{'url':'/preserved.png'}]
        core.save_canvas(result1['canvas'])

        second=make_plan('更新：灰色西装，柔和侧光的女性角色设定图')
        result2=plans.apply_plan(session,second)
        image2=next(n for n in result2['canvas']['nodes'] if n['type']=='generator')
        skill2=next(n for n in result2['canvas']['nodes'] if n.get('studioAgentNodeKind')=='skill-run')
        self.assertEqual(image2['id'],image1['id'])
        self.assertEqual(skill2['id'],skill1['id'])
        self.assertEqual(image2['images'],[{'url':'/preserved.png'}])
        self.assertIn('更新',image2['studioPrompt'])

if __name__=='__main__':unittest.main()
