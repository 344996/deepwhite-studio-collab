"""RH configuration library only: temporary files and mock metadata; never run RH."""
import copy
import json
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

os.environ.setdefault('DEEPWHITE_STUDIO_RUNTIME_DIR', tempfile.mkdtemp(prefix='dw-rh-library-import-'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI, HTTPException
import studio_rh_workflows as library


def definition(kind='workflow'):
    fields = [
        {'nodeId': '1', 'fieldName': 'seed', 'fieldType': 'INT', 'fieldValue': '18446744073709551615', 'enabled': True, 'sourceFromUpstream': False},
        {'nodeId': '1', 'fieldName': 'steps', 'fieldType': 'INT', 'fieldValue': 0, 'enabled': True},
        {'nodeId': '1', 'fieldName': 'flag', 'fieldType': 'BOOLEAN', 'fieldValue': False, 'enabled': True},
        {'nodeId': '2', 'fieldName': 'image', 'fieldType': 'IMAGE', 'fieldValue': '', 'enabled': True, 'required': False, 'imageOrder': 0},
    ]
    entry = {'id': '12345678', 'title': 'SeedVR2 隔离配置', 'fields': fields}
    if kind == 'workflow':
        entry.update(workflowJson={'1': {'class_type': 'Sampler', 'inputs': {'seed': 18446744073709551615, 'steps': 0, 'flag': False, 'image': ['2', 0]}},
                                  '2': {'class_type': 'LoadImage', 'inputs': {'image': ''}}}, optionalImageMode='prune-workflow')
    return {'kind': kind, 'target_id': '12345678', 'entry': entry}


class LibraryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dw-rh-library-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.provider = {'id': 'runninghub', 'base_url': 'https://rh.invalid', 'enabled': True, 'rh_apps': [], 'rh_workflows': []}
        patches = [patch.object(library.core, 'DATA_DIR', str(self.root)),
                   patch.object(library.core, 'RUNNINGHUB_WORKFLOW_STORE_FILE', str(self.root / 'legacy.json')),
                   patch.object(library.core, 'runninghub_provider', return_value=self.provider),
                   patch.object(library.core, 'runninghub_api_key', return_value='isolated-secret'),
                   patch.object(library.core, 'load_api_providers', return_value=[self.provider]),
                   patch.object(library.core, 'save_api_providers', Mock()),
                   patch.object(library.core, 'runninghub_submit', AsyncMock()),
                   patch.object(library.core, 'runninghub_workflow_submit', AsyncMock())]
        for helper in patches: helper.start(); self.addCleanup(helper.stop)

    def save(self, value=None, **kwargs):
        return library.save_version({'name': '同名配置', 'definition': value or definition(), **kwargs})

    async def test_local_preview_has_zero_writes_and_no_task(self):
        result = await library.preview({'definition': definition()})
        self.assertTrue(result['draft']); self.assertEqual(result['revision'], 0)
        self.assertEqual(list(self.root.iterdir()), [])
        library.core.save_api_providers.assert_not_called()
        library.core.runninghub_submit.assert_not_called()
        library.core.runninghub_workflow_submit.assert_not_called()

    async def test_remote_workflow_preview_is_full_graph_without_save(self):
        entry = definition()['entry']
        with patch.object(library.core, 'fetch_runninghub_workflow', AsyncMock(return_value={'data': entry})) as fetch:
            draft = await library.preview({'kind': 'workflow', 'source': 'https://www.runninghub.cn/run/workflow/12345678?tracking=99999999'})
            self.assertEqual(fetch.await_args.args[0].workflowId, '12345678')
        self.assertEqual(draft['versions'][0]['definition']['entry']['workflowJson']['1']['inputs']['seed'], '18446744073709551615')
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_remote_app_preview_does_not_keep_raw_key(self):
        with patch.object(library.core, 'runninghub_app_info', AsyncMock(return_value={'data': {'webappName': '应用', 'nodeInfoList': definition('app')['entry']['fields'], 'apiKey': 'isolated-secret'}})):
            draft = await library.preview({'kind': 'app', 'source': '12345678'})
        self.assertNotIn('isolated-secret', json.dumps(draft))
        self.assertEqual(draft['kind'], 'app')
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_remote_error_redacts_known_key_and_url(self):
        with patch.object(library.core, 'runninghub_app_info', AsyncMock(side_effect=HTTPException(502, 'isolated-secret https://rh.invalid/?apiKey=isolated-secret'))):
            with self.assertRaises(HTTPException) as found: await library.preview({'kind': 'app', 'source': '12345678'})
        self.assertNotIn('isolated-secret', found.exception.detail)
        self.assertNotIn('https://', found.exception.detail)
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_real_metadata_function_uses_only_mock_transport(self):
        calls = []
        graph = definition()['entry']['workflowJson']
        original = httpx.AsyncClient
        def handle(request):
            calls.append(request)
            return httpx.Response(200, json={'code': 0, 'data': {'prompt': json.dumps(graph)}})
        with patch.object(library.core.httpx, 'AsyncClient', side_effect=lambda **kw: original(transport=httpx.MockTransport(handle), **kw)):
            result = await library.preview({'kind': 'workflow', 'source': '12345678'})
        self.assertEqual(len(calls), 1); self.assertTrue(calls[0].url.path.endswith('/getJsonApiFormat'))
        self.assertEqual(result['versions'][0]['definition']['entry']['workflowJson']['1']['inputs']['seed'], '18446744073709551615')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_save_reload_and_immutable_version(self):
        first = self.save()
        updated = definition(); updated['entry']['fields'][1]['fieldValue'] = 24; updated['entry']['workflowJson']['1']['inputs']['steps'] = 24
        second = library.save_version({'name': '新名称', 'definition': updated, 'expected_revision': 1}, first['id'])
        restored = library.read(first['id'])
        self.assertEqual(second, restored); self.assertEqual(restored['revision'], 2)
        self.assertEqual(restored['versions'][0], first['versions'][0])
        self.assertEqual(restored['versions'][0]['definition']['entry']['workflowJson']['1']['inputs']['steps'], 0)
        self.assertNotEqual(restored['versions'][0]['definition_hash'], restored['versions'][1]['definition_hash'])

    def test_same_names_have_independent_local_ids(self):
        first, second = self.save(), self.save()
        self.assertNotEqual(first['id'], second['id']); self.assertEqual(len(library.list_items()), 2)

    def test_conflict_does_not_change_old_bytes(self):
        saved = self.save(); path = library._path(saved['id']); before = path.read_bytes()
        with self.assertRaises(HTTPException) as found: library.save_version({'definition': definition(), 'expected_revision': 0}, saved['id'])
        self.assertEqual(found.exception.status_code, 409); self.assertEqual(before, path.read_bytes())

    def test_concurrent_same_revision_only_one_success(self):
        saved = self.save()
        def update(index):
            value = definition(); value['entry']['fields'][1]['fieldValue'] = index
            try: return library.save_version({'definition': value, 'expected_revision': 1}, saved['id'])['revision']
            except HTTPException as exc: return exc.status_code
        with ThreadPoolExecutor(max_workers=2) as pool: states = list(pool.map(update, (11, 12)))
        self.assertEqual(sorted(states), [2, 409]); result = library.read(saved['id'])
        self.assertEqual(len(result['versions']), 2); self.assertEqual(result['versions'][0], saved['versions'][0])

    def test_failed_replace_preserves_previous_version(self):
        saved = self.save(); before = library._path(saved['id']).read_bytes()
        with patch.object(library.os, 'replace', side_effect=OSError('mock disk full')):
            with self.assertRaises(HTTPException) as found: library.save_version({'definition': definition(), 'expected_revision': 1}, saved['id'])
        self.assertEqual(found.exception.status_code, 503)
        self.assertEqual(before, library._path(saved['id']).read_bytes()); self.assertFalse(list(library.directory().glob('*.tmp')))

    def test_zero_false_long_seed_and_order_remain_exact(self):
        value = self.save()['versions'][0]['definition']['entry']['fields']
        self.assertEqual(value[0]['fieldValue'], '18446744073709551615'); self.assertEqual(value[1]['fieldValue'], 0)
        self.assertIs(value[2]['fieldValue'], False); self.assertEqual(value[3]['imageOrder'], 0)
        self.assertIs(value[0]['sourceFromUpstream'], False)

    def test_ambiguous_or_wrong_source_rejected(self):
        for source, kind in [('https://rh.invalid/run/ai-app/12345678', 'workflow'), ('https://rh.invalid/foo?task=12345678', 'app'), ('../12345678', 'app'), ('https://www.runninghub.cn/post/12345678', 'workflow'), ('https://www.runninghub.cn/ai-detail/12345678', 'workflow'), ('https://[broken', 'app')]:
            with self.assertRaises(HTTPException): library.target_id(source, kind)

    async def test_preview_preserves_typed_enum_and_exact_limits(self):
        value = definition('app')
        field = value['entry']['fields'][0]
        field.update(options=[0, False, 'literal', 18446744073709551615], min=0, max=18446744073709551615, step=1)
        result = await library.preview({'definition': value})
        actual = result['fields'][0]
        self.assertEqual(actual['options'], [0, False, 'literal', '18446744073709551615'])
        self.assertIs(actual['options'][1], False)
        self.assertEqual(actual['max'], '18446744073709551615')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_unsafe_float_limits_and_graph_values_are_rejected(self):
        for location in ('limit', 'graph', 'enum'):
            value = definition()
            if location == 'limit': value['entry']['fields'][0]['max'] = 1e20
            elif location == 'enum': value['entry']['fields'][0]['options'] = [1e20]
            else: value['entry']['workflowJson']['1']['inputs']['seed'] = 1e20
            with self.assertRaises(HTTPException): library.normalize_definition(value)

    def test_invalid_typed_defaults_never_save(self):
        for raw in ({'fieldType': 'INT', 'fieldValue': '1.5'},
                    {'fieldType': 'NUMBER', 'fieldValue': 'bad'},
                    {'fieldType': 'INT', 'fieldValue': 5, 'max': 4},
                    {'fieldType': 'INT', 'fieldValue': 5, 'step': 2},
                    {'fieldType': 'BOOLEAN', 'fieldValue': 'hello'}):
            value = definition('app'); value['entry']['fields'][0].update(raw)
            with self.assertRaises(HTTPException): library.save_version({'definition': value})
        self.assertEqual(list(self.root.iterdir()), [])

    def test_legacy_boolean_text_is_normalized_without_truthiness(self):
        for raw, expected in [('False', False), ('0', False), ('True', True), ('1', True)]:
            value = definition('app'); value['entry']['fields'][2]['fieldValue'] = raw
            self.assertIs(library.normalize_definition(value)['entry']['fields'][2]['fieldValue'], expected)

    def test_current_and_legacy_direct_share_links(self):
        cases = [
            ('https://www.runninghub.cn/ai-detail/1937084629516193794?invite=123', 'app', '1937084629516193794'),
            ('https://runninghub.cn/#/workflow/1837084301916794881?invite=123', 'workflow', '1837084301916794881'),
            ('https://www.runninghub.ai/run/workflow/12345678', 'workflow', '12345678'),
        ]
        for source, kind, expected in cases:
            self.assertEqual(library.target_id(source, kind), expected)

    def test_plain_or_ui_json_is_not_fake_api_graph(self):
        for graph in ({'hello': 'world'}, {'nodes': []}, {}):
            value = definition(); value['entry']['workflowJson'] = graph
            with self.assertRaises(HTTPException): library.normalize_definition(value)

    def test_links_cannot_be_editable_fields(self):
        value = definition(); value['entry']['fields'].append({'nodeId': '1', 'fieldName': 'image', 'fieldValue': ['2', 0]})
        with self.assertRaises(HTTPException): library.normalize_definition(value)

    def test_missing_node_or_duplicate_mapping_rejected(self):
        for invalid in ('missing', 'duplicate'):
            value = definition()
            if invalid == 'missing': value['entry']['fields'][0]['nodeId'] = '99'
            else: value['entry']['fields'].append(copy.deepcopy(value['entry']['fields'][0]))
            with self.assertRaises(HTTPException): library.normalize_definition(value)

    def test_credentials_rejected_and_source_cannot_mutate(self):
        value = definition(); value['entry']['workflowJson']['1']['inputs']['api_key'] = 'test-key'
        with self.assertRaises(HTTPException): library.normalize_definition(value)
        saved = self.save(); changed = definition(); changed['target_id'] = '87654321'
        with self.assertRaises(HTTPException) as found: library.save_version({'definition': changed, 'expected_revision': 1}, saved['id'])
        self.assertEqual(found.exception.status_code, 409)

    def test_corrupt_record_does_not_become_empty_library(self):
        saved = self.save(); path = library._path(saved['id']); path.write_text('{broken', encoding='utf-8')
        with self.assertRaises(HTTPException) as found: library.list_items()
        self.assertEqual(found.exception.status_code, 503); self.assertEqual(path.read_text(), '{broken')

    def test_legacy_combines_store_without_mutation(self):
        self.provider['rh_apps'] = [{'id': '11111111', 'appId': '11111111', 'title': '应用', 'fields': definition('app')['entry']['fields']}]
        cfg = definition()['entry']; cfg['workflowId'] = cfg['id']; cfg['updatedAt'] = 5
        (self.root / 'legacy.json').write_text(json.dumps({'12345678': cfg}), encoding='utf-8')
        with patch.object(library.core, 'runninghub_saved_hidden_workflow_ids', return_value=set()): items = library.legacy_items()
        self.assertEqual({x['kind'] for x in items}, {'app', 'workflow'})
        self.assertFalse(library.directory().exists()); library.core.save_api_providers.assert_not_called()

    async def test_get_routes_are_read_only_and_save_conflict_is_409(self):
        app = FastAPI(); library.install(app)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
            response = await client.get('/api/studio/runninghub/workflows'); self.assertEqual(response.json(), {'items': []})
            self.assertFalse(library.directory().exists())
            draft = await client.post('/api/studio/runninghub/workflows/preview', json={'definition': definition()}); self.assertEqual(draft.status_code, 200)
            self.assertFalse(library.directory().exists())
            result = (await client.post('/api/studio/runninghub/workflows', json={'definition': definition()})).json()
            conflict = await client.put('/api/studio/runninghub/workflows/' + result['id'], json={'definition': definition(), 'expected_revision': 0})
            self.assertEqual(conflict.status_code, 409)
            self.assertEqual((await client.get('/api/studio/runninghub/workflows/' + result['id'])).json()['revision'], 1)
        library.core.runninghub_submit.assert_not_called(); library.core.runninghub_workflow_submit.assert_not_called()


if __name__ == '__main__': unittest.main()
