"""U10 (handover 2026-10-26): smart canvases are retired without losing anything.

An old smart canvas is copied into a new classic canvas from a backup; nodes without a classic
equivalent become notes that keep their original data; the original is never changed; repeating
the migration returns the same copy; agents can no longer create smart canvases.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix='dw-smart-retire-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import studio_server
import main as core
import studio_control as control
import studio_smart_retire as retire

NODES = [
    {'id': 'p', 'type': 'smart-prompt', 'title': '剧本', 'text': '林夏走进修表铺', 'x': 10, 'y': 20},
    {'id': 'one', 'type': 'smart-image', 'title': '人物', 'images': [{'url': '/output/person.png'}], 'x': 400, 'y': 20},
    {'id': 'many', 'type': 'smart-image', 'title': '分镜', 'images': [{'url': '/output/a.png'}, {'url': '/output/b.png'}],
     'runSettings': {'engine': 'api', 'model': 'deepwhiteai-image-g2'}, 'x': 800, 'y': 20},
    {'id': 'grp', 'type': 'smart-group', 'title': '第一场', 'x': 0, 'y': 500},
    {'id': 'loop', 'type': 'smart-loop', 'x': 400, 'y': 500, 'count': 3},
]


class SmartRetireTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)
        smart = core.new_canvas('七码头', kind='smart')
        canvas = core.load_canvas(smart['id'])
        canvas.update(nodes=NODES, connections=[{'from': 'p', 'to': 'many', 'kind': 'input'}, {'from': 'p', 'to': 'gone'}])
        core.save_canvas(canvas)
        self.smart_id = smart['id']
        self.before = json.dumps(core.load_canvas(self.smart_id), ensure_ascii=False, sort_keys=True)

    def migrate(self):
        response = self.client.post(f'/api/canvases/{self.smart_id}/migrate-classic')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_copy_converts_what_it_can_and_keeps_the_rest_as_notes(self):
        result = self.migrate()
        copy = core.load_canvas(result['canvas_id'])
        self.assertEqual(copy['kind'], 'classic')
        self.assertEqual(copy['title'], '七码头（经典版）')
        types = {n['id']: n['type'] for n in copy['nodes']}
        self.assertEqual(types, {'p': 'prompt', 'one': 'image', 'many': 'output', 'grp': 'prompt', 'loop': 'prompt'})
        nodes = {n['id']: n for n in copy['nodes']}
        self.assertEqual(nodes['p']['text'], '林夏走进修表铺')
        self.assertEqual(nodes['one']['url'], '/output/person.png')
        self.assertEqual([i['url'] for i in nodes['many']['images']], ['/output/a.png', '/output/b.png'])
        self.assertIn('未自动转换', nodes['loop']['text'])
        for original in NODES:
            self.assertEqual(nodes[original['id']]['legacySmart'], original, 'original node data was not kept')
        self.assertEqual([(c['from'], c['to']) for c in copy['connections']], [('p', 'many')])
        self.assertEqual((result['converted'], result['unconverted']), (3, 2))

    def test_original_is_untouched_and_backed_up(self):
        result = self.migrate()
        self.assertEqual(json.dumps(core.load_canvas(self.smart_id), ensure_ascii=False, sort_keys=True), self.before)
        backup = json.loads((retire.directory() / result['backup']).read_text(encoding='utf-8'))
        self.assertEqual(json.dumps(backup, ensure_ascii=False, sort_keys=True), self.before)

    def test_repeating_the_migration_returns_the_same_copy(self):
        first, second = self.migrate(), self.migrate()
        self.assertEqual(first['canvas_id'], second['canvas_id'])

    def test_classic_canvases_are_not_migrated(self):
        classic = core.new_canvas('普通')
        self.assertEqual(self.client.post(f'/api/canvases/{classic["id"]}/migrate-classic').status_code, 400)

    def test_agents_can_no_longer_create_smart_canvases(self):
        state = control._load(); state['enabled'] = True; control._save(state)
        project = core.new_project('退役测试')
        revision = self.client.post('/api/studio/control/call', json={'name': 'list_projects', 'arguments': {}},
                                    headers={'Authorization': 'Bearer ' + state['token']}).json()['result']['revision']
        response = self.client.post('/api/studio/control/call', headers={'Authorization': 'Bearer ' + state['token']}, json={
            'name': 'create_canvas', 'arguments': {'project_id': project['id'], 'title': '新智能', 'kind': 'smart',
                                                   'expected_revision': revision, 'operation_id': 'op-smart-retired-1'}})
        self.assertEqual(response.status_code, 400, response.text)


if __name__ == '__main__':
    unittest.main()
