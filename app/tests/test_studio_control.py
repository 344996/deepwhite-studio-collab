"""Controller contract checks. Every generation boundary is mocked; no paid/local executor runs."""
import asyncio
import copy
import importlib
import os
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix='dw-studio-control-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import studio_server
import main as core
import studio_control as control
import studio_agent_plans as plans
import studio_assets as assets
import studio_generation as generation
import studio_catalog as catalog
import studio_graph as graph
from fastapi import HTTPException
from fastapi.testclient import TestClient


class StudioControl(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not any(getattr(r,'path','')=='/api/studio/control/settings' for r in studio_server.app.routes):control.install(studio_server.app)
        cls.client = TestClient(studio_server.app)

    def setUp(self):
        self.cid = uuid.uuid4().hex
        self.pid = 'p_' + uuid.uuid4().hex
        self.provider = 'control-fixture'
        core.save_api_providers([core.normalize_provider({'id':self.provider,'name':'Fixture','base_url':'https://fixture.invalid/v1',
            'enabled':True,'chat_models':[],'image_models':['deepwhiteai-image-g-v2.5-lowprice'], 'video_models':['seedance-2.5-standard']})])
        catalog.save_store({})
        self.canvas = {'id':self.cid,'title':'Control fixture','project':self.pid,'kind':'classic','nodes':[],'connections':[]}
        core.save_canvas(self.canvas)
        self.cfg = control.path()
        if self.cfg.exists(): self.cfg.unlink()
        state = control._load(); state['enabled'] = True; control._save(state); self.token = state['token']

    def call(self, name, arguments, token=None):
        return self.client.post('/api/studio/control/call', json={'name':name,'arguments':arguments},
            headers={'Authorization':'Bearer '+(token or self.token)})

    def image_spec(self, **kwargs):
        value = {'key':'hero','kind':'image','title':'角色图','prompt':'写实人像，柔和侧光',
                 'provider_id':self.provider,'model':'deepwhiteai-image-g-v2.5-lowprice','params':{},'references':[]}
        value.update(kwargs); return value

    def test_token_generated_and_settings_never_returns_it(self):
        response = self.client.get('/api/studio/control/settings')
        self.assertEqual(response.status_code,200)
        self.assertNotIn(self.token, response.text)
        self.assertTrue(self.cfg.exists())
        self.assertEqual(len(control._load()['token']),54)

    def test_control_disabled_and_bad_token_are_rejected(self):
        response = self.client.put('/api/studio/control/settings', json={'enabled':False})
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.call('list_canvases',{}).status_code,403)
        self.client.put('/api/studio/control/settings', json={'enabled':True})
        self.assertEqual(self.call('list_canvases',{},'wrong').status_code,401)

    def test_get_canvas_returns_revision_without_secret_fields(self):
        self.canvas['nodes']=[{'id':'n','type':'prompt','text':'hello','nested':{'api_key':'secret'}}]; core.save_canvas(self.canvas)
        response=self.call('get_canvas',{'canvas_id':self.cid})
        self.assertEqual(response.status_code,200)
        data=response.json()['result']; self.assertTrue(data['revision'])
        self.assertNotIn('api_key',data['canvas']['nodes'][0]['nested'])

    def test_apply_nodes_checks_cas_and_keeps_tool_params_strict(self):
        revision=plans.revision(self.canvas)
        stale=self.call('apply_nodes',{'canvas_id':self.cid,'operation_id':'operation-stale','expected_revision':'0'*64,'nodes':[self.image_spec()]})
        self.assertEqual(stale.status_code,409)
        bad=self.call('apply_nodes',{'canvas_id':self.cid,'operation_id':'operation-badpar','expected_revision':revision,
            'nodes':[self.image_spec(params={'unsupported':1})]})
        self.assertEqual(bad.status_code,400)
        self.assertEqual(core.load_canvas(self.cid)['nodes'],[])

    def test_edit_is_idempotent_and_operation_id_cannot_change_payload(self):
        args={'canvas_id':self.cid,'operation_id':'operation-one','expected_revision':plans.revision(self.canvas),'nodes':[self.image_spec()]}
        first=self.call('apply_nodes',args); second=self.call('apply_nodes',args)
        self.assertEqual(first.status_code,200); self.assertEqual(first.json(),second.json())
        self.assertEqual(len(core.load_canvas(self.cid)['nodes']),1)
        changed={**args,'nodes':[self.image_spec(title='different')]}
        self.assertEqual(self.call('apply_nodes',changed).status_code,409)

    def test_undo_requires_unchanged_applied_revision(self):
        args={'canvas_id':self.cid,'operation_id':'operation-undo','expected_revision':plans.revision(self.canvas),'nodes':[self.image_spec()]}
        self.call('apply_nodes',args)
        applied=core.load_canvas(self.cid); revision=plans.revision(applied)
        changed=copy.deepcopy(applied); changed['nodes'][0]['studioTitle']='manual change'; core.save_canvas(changed)
        self.assertEqual(self.call('undo_edit',{'canvas_id':self.cid,'operation_id':'operation-undo','expected_revision':plans.revision(changed)}).status_code,409)
        self.assertEqual(core.load_canvas(self.cid)['nodes'][0]['studioTitle'],'manual change')

    def edit_args(self, operation='atomic-model-edit'):
        return {'canvas_id': self.cid, 'operation_id': operation,
                'expected_revision': plans.revision(core.load_canvas(self.cid)),
                'nodes': [self.image_spec()]}

    def test_edit_does_not_depend_on_a_second_control_file_write(self):
        args = self.edit_args()
        with patch.object(control, '_save', side_effect=OSError('control disk unavailable')):
            first = self.call('apply_nodes', args)
        self.assertEqual(first.status_code, 200, first.text)
        saved = core.load_canvas(self.cid)
        self.assertIn(args['operation_id'], saved[graph.JOURNAL]['records'])
        importlib.reload(control)
        self.assertEqual(first.json(), self.call('apply_nodes', dict(args,
            expected_revision=plans.revision(saved))).json())
        self.assertEqual(len(core.load_canvas(self.cid)['nodes']), 1)
        undo = {'canvas_id': self.cid, 'operation_id': args['operation_id'],
                'expected_revision': first.json()['result']['revision']}
        with patch.object(control, '_save', side_effect=OSError('still unavailable')):
            undone = self.call('undo_edit', undo)
        self.assertEqual(undone.status_code, 200, undone.text)
        self.assertEqual(core.load_canvas(self.cid)['nodes'], [])

    def test_failed_canvas_replace_keeps_content_receipt_and_undo_unchanged(self):
        import studio_asset_integration
        args = self.edit_args()
        before = Path(core.canvas_path(self.cid)).read_bytes()
        with patch.object(studio_asset_integration.os, 'replace', side_effect=OSError('disk unavailable')):
            failed = self.call('apply_nodes', args)
        self.assertEqual(failed.status_code, 507, failed.text)
        self.assertEqual(Path(core.canvas_path(self.cid)).read_bytes(), before)
        applied = self.call('apply_nodes', args).json()['result']
        undo = {'canvas_id': self.cid, 'operation_id': args['operation_id'], 'expected_revision': applied['revision']}
        before = Path(core.canvas_path(self.cid)).read_bytes()
        with patch.object(studio_asset_integration.os, 'replace', side_effect=OSError('disk unavailable')):
            failed = self.call('undo_edit', undo)
        self.assertEqual(failed.status_code, 507, failed.text)
        self.assertEqual(Path(core.canvas_path(self.cid)).read_bytes(), before)
        self.assertEqual(self.call('undo_edit', undo).status_code, 200)

    def test_lost_edit_and_undo_responses_are_replayable_after_reload(self):
        args = self.edit_args()
        save = core.save_canvas
        def save_then_disconnect(canvas):
            save(canvas)
            raise RuntimeError('response lost after durable commit')
        with patch.object(core, 'save_canvas', side_effect=save_then_disconnect):
            with self.assertRaises(RuntimeError):
                self.call('apply_nodes', args)
        importlib.reload(control)
        applied = self.call('apply_nodes', args).json()['result']
        self.assertEqual(len(core.load_canvas(self.cid)['nodes']), 1)
        undo = {'canvas_id': self.cid, 'operation_id': args['operation_id'], 'expected_revision': applied['revision']}
        with patch.object(core, 'save_canvas', side_effect=save_then_disconnect):
            with self.assertRaises(RuntimeError):
                self.call('undo_edit', undo)
        importlib.reload(graph)
        self.assertEqual(self.call('undo_edit', undo).status_code, 200)
        self.assertEqual(self.call('apply_nodes', args).json()['result'], applied)
        self.assertEqual(core.load_canvas(self.cid)['nodes'], [])

    def test_legacy_edit_receipts_migrate_without_writing_or_reviving_undo(self):
        args = self.edit_args('旧版模型节点操作编号')
        self._save_generator()
        applied = {'canvas_id': self.cid, 'node_ids': {'hero': 'node1'},
                   'revision': plans.revision(core.load_canvas(self.cid))}
        fingerprint = control.hashlib.sha256(control.json.dumps(
            {k: v for k, v in args.items() if k != 'expected_revision'},
            sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        state = control._load()
        key = self.cid + ':' + args['operation_id']
        state['runs']['edit:' + key] = {**applied, 'fingerprint': fingerprint}
        state['undo'][key] = {'nodes': [], 'connections': [], 'applied_revision': applied['revision']}
        control._save(state)
        before = self.cfg.read_bytes()
        self.assertEqual(self.call('apply_nodes', args).json()['result'], applied)
        undo = {'canvas_id': self.cid, 'operation_id': args['operation_id'], 'expected_revision': applied['revision']}
        self.assertEqual(self.call('undo_edit', undo).status_code, 200)
        self.assertEqual(self.call('undo_edit', undo).status_code, 200)
        self.assertEqual(self.cfg.read_bytes(), before)
        self.assertEqual(core.load_canvas(self.cid)['nodes'], [])
        self.assertEqual(self.call('apply_nodes', args).json()['result'], applied)

    def test_model_and_graph_operations_share_namespace_and_latest_undo(self):
        args = self.edit_args()
        applied = self.call('apply_nodes', args).json()['result']
        graph_args = {'canvas_id': self.cid, 'operation_id': args['operation_id'],
                      'expected_revision': applied['revision'],
                      'operations': [{'op': 'add_prompt', 'key': 'text', 'text': 'hello', 'x': 0, 'y': 0}]}
        self.assertEqual(self.call('edit_canvas', graph_args).status_code, 409)
        graph_args['operation_id'] = 'later-graph-edit'
        later = self.call('edit_canvas', graph_args).json()['result']
        self.assertEqual(self.call('undo_edit', {'canvas_id': self.cid,
            'operation_id': args['operation_id'], 'expected_revision': later['revision']}).status_code, 409)
        self.assertEqual(self.call('apply_nodes', dict(args,
            operation_id=graph_args['operation_id'])).status_code, 409)
        copied = copy.deepcopy(core.load_canvas(self.cid))
        copied['id'] = uuid.uuid4().hex
        core.save_canvas(copied)
        copied_args = dict(args, canvas_id=copied['id'], expected_revision=plans.revision(copied))
        self.assertEqual(self.call('undo_edit', {k:v for k,v in copied_args.items() if k != 'nodes'}).status_code, 404)
        duplicate = self.call('apply_nodes', copied_args)
        self.assertEqual(duplicate.status_code, 200, duplicate.text)
        self.assertNotEqual(duplicate.json()['result']['node_ids'], applied['node_ids'])

    def test_http_tools_enforce_advertised_schema_and_project_filter(self):
        for name, args in [('list_models', {'private-extra-fixture': 'secret'}),
                           ('get_canvas', {'canvas_id': '../' + self.cid}),
                           ('apply_nodes', dict(self.edit_args(), operation_id='short'))]:
            response = self.call(name, args)
            self.assertEqual(response.status_code, 400, response.text)
            self.assertNotIn('private-extra-fixture', response.text)
        other = dict(self.canvas, id=uuid.uuid4().hex, project='other-project')
        core.save_canvas(other)
        rows = self.call('list_canvases', {'project_id': self.pid}).json()['result']['items']
        self.assertEqual([row['id'] for row in rows], [self.cid])
        schema = self.call('get_node_schema', {}).json()['result']['input_schemas']
        self.assertEqual(set(schema), control.TOOLS)
        self.assertEqual(schema['apply_nodes']['properties']['operation_id']['minLength'], 8)

    def test_canvas_read_filters_nested_credentials_with_mixed_key_names(self):
        self.canvas['nodes'] = [{'id': 'n', 'type': 'prompt', 'text': 'keep user content',
            'nested': {'apiKey': 'fixture-key', 'accessToken': 'fixture-token',
                       'clientSecret': 'fixture-secret', 'password': 'fixture-password'}}]
        core.save_canvas(self.canvas)
        response = self.call('get_canvas', {'canvas_id': self.cid})
        self.assertEqual(response.status_code, 200)
        for value in ['fixture-key', 'fixture-token', 'fixture-secret', 'fixture-password']:
            self.assertNotIn(value, response.text)
        self.assertIn('keep user content', response.text)

    def test_concurrent_identical_model_edits_return_one_durable_result(self):
        args = self.edit_args()
        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(lambda _: control._apply(self.cid, args), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(len(core.load_canvas(self.cid)['nodes']), 1)

    def test_asset_mapping_compiles_bound_token_and_creates_reference_edge(self):
        filename=uuid.uuid4().hex+'.png'; Path(core.output_path_for(filename)).write_bytes(b'fixture')
        item=assets.register_local(core.output_url_for(filename),project_id=self.pid)
        entry=self.image_spec(prompt='{{asset:'+item['version_id']+'}} 请保持人物构图',references=[{'version_id':item['version_id']}])
        args={'canvas_id':self.cid,'operation_id':'operation-asset','expected_revision':plans.revision(self.canvas),'nodes':[entry]}
        response=self.call('apply_nodes',args); self.assertEqual(response.status_code,200,response.text)
        canvas=core.load_canvas(self.cid); node=next(n for n in canvas['nodes'] if n['type']=='generator')
        self.assertIn('@图片1',node['studioPrompt']); self.assertEqual(len(node['studioRefs']),1)
        self.assertEqual(len(canvas['connections']),1)

    def test_generate_requires_approval_and_node_change_invalidates_approval(self):
        self._save_generator()
        with patch.object(generation,'checked',return_value=None):
            result=asyncio.run(control._generate(self.cid,'node1','request-001'))
        self.assertTrue(result['approval_required'])
        changed=core.load_canvas(self.cid); changed['nodes'][0]['studioPrompt']='changed after approval'; core.save_canvas(changed)
        response=self.client.post('/api/studio/control/approvals/'+result['approval_id'],json={'action':'approve'})
        self.assertEqual(response.status_code,409)

    def test_rejected_generation_cannot_be_retried_with_same_request_id(self):
        self._save_generator()
        with patch.object(generation,'checked',return_value=None):
            result=asyncio.run(control._generate(self.cid,'node1','request-002'))
        rejected=asyncio.run(control._approve(result['approval_id'],{'action':'reject'}))
        self.assertEqual(rejected['status'],'rejected')
        self.assertEqual(asyncio.run(control._generate(self.cid,'node1','request-002'))['status'],'rejected')

    def test_session_limit_and_request_id_are_idempotent(self):
        self._save_generator()
        state=control._load(); state.update(generation_mode='session',session_expires_at=__import__('time').time()+1000,remaining_runs=1); control._save(state)
        fake={'id':'request-003','status':'queued'}
        with patch.object(generation,'checked',return_value=None), patch.object(generation,'submit',new=AsyncMock(return_value=fake)) as submit:
            first=asyncio.run(control._generate(self.cid,'node1','request-003'))
            second=asyncio.run(control._generate(self.cid,'node1','request-003'))
        self.assertEqual(first['job_id'],second['job_id']); self.assertEqual(submit.await_count,1)
        self.assertEqual(control._load()['remaining_runs'],0)

    def test_approval_submits_once_and_job_result_is_persisted_to_node(self):
        self._save_generator()
        with patch.object(generation,'checked',return_value=None):
            pending=asyncio.run(control._generate(self.cid,'node1','request-004'))
        with patch.object(generation,'checked',return_value=None), patch.object(generation,'submit',new=AsyncMock(return_value={'id':'request-004','status':'queued'})) as submit:
            result=asyncio.run(control._approve(pending['approval_id'],{'action':'approve'}))
            repeat=asyncio.run(control._approve(pending['approval_id'],{'action':'approve'}))
        self.assertEqual(result['job_id'],repeat['job_id']); self.assertEqual(submit.await_count,1)
        mock_job={'id':'request-004','status':'succeeded','error':'','outputs':[{'url':'/result.png','kind':'image','asset_url':'/result.png'}]}
        with patch.object(generation,'read',return_value=mock_job), patch.object(generation,'public',side_effect=lambda job:job):
            control._job_done(self.cid,'node1','request-004')
        node=core.load_canvas(self.cid)['nodes'][0]
        self.assertEqual(node['studioJobState'],'succeeded'); self.assertEqual(node['images'][0]['url'],'/result.png')
        self.assertIn('/result.png',node['studioAccepted'])
        saved=core.load_canvas(self.cid)
        out=next(n for n in saved['nodes'] if n.get('type')=='output')
        self.assertEqual(out['images'][0]['url'],'/result.png')
        self.assertTrue(any(c['from']=='node1' and c['to']==out['id'] for c in saved['connections']))
        timestamp=saved['updated_at']
        with patch.object(generation,'read',return_value=mock_job), patch.object(generation,'public',side_effect=lambda job:job):
            control._job_done(self.cid,'node1','request-004')
        self.assertEqual(core.load_canvas(self.cid)['updated_at'],timestamp)

    def _save_generator(self):
        self.canvas['nodes']=[{'id':'node1','type':'generator','studioTitle':'角色','studioPrompt':'生成一张角色图',
            'apiProvider':self.provider,'model':'deepwhiteai-image-g-v2.5-lowprice','studioParams':{},'studioRefs':[],
            'studioAssetRefs':[],'running':False}]
        core.save_canvas(self.canvas)


if __name__ == '__main__': unittest.main()
