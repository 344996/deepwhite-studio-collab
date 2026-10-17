"""Security regressions with virtual credentials and an in-process ASGI service.

Every upstream request uses MockTransport. Runtime files stay in this copy's
.test-runtime directory; no application startup hooks or paid requests run.
"""
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT.parent / '.test-runtime'
TEST_ROOT.mkdir(exist_ok=True)
runtime = tempfile.TemporaryDirectory(prefix='security-', dir=TEST_ROOT)
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
sys.path.insert(0, str(ROOT))
import studio_server
import studio_settings as settings
import main as core


class CredentialBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.providers = [core.normalize_provider({
            'id': 'fixture', 'name': 'Fixture', 'base_url': 'https://saved.invalid/v1',
            'protocol': 'openai', 'chat_models': ['fixture-chat'],
        })]
        self.keys = {core.provider_key_env('fixture'): 'dummy-fixture-key'}
        self.outbound = []
        self.saved = []
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)

        def save(providers):
            self.saved.append(copy.deepcopy(providers))
            self.providers = copy.deepcopy(providers)

        def upstream(request):
            self.outbound.append(request)
            return httpx.Response(200, json={'data': [{'id': 'fixture-chat'}]})

        original_client = httpx.AsyncClient
        patches = [
            patch.object(core, 'load_api_providers', side_effect=lambda: copy.deepcopy(self.providers)),
            patch.object(core, 'save_api_providers', side_effect=save),
            patch.object(core, 'provider_env_key_value', side_effect=lambda pid: self.keys.get(core.provider_key_env(pid), '')),
            patch.object(core, 'runninghub_wallet_key_value', side_effect=lambda: self.keys.get(core.runninghub_wallet_key_env(), '')),
            patch.object(core, 'volcengine_access_key_value', side_effect=lambda: self.keys.get(core.volcengine_access_key_env(), '')),
            patch.object(core, 'volcengine_secret_key_value', side_effect=lambda: self.keys.get(core.volcengine_secret_key_env(), '')),
            patch.object(core, 'update_env_values', side_effect=lambda values: self.keys.update(values)),
            patch.object(core, 'reload_env_globals'),
            patch.object(core, 'sync_runninghub_provider_workflows_to_static_template'),
            patch.object(core, 'preserve_runninghub_hidden_overrides', side_effect=lambda provider: provider),
            patch.object(core, 'prune_runninghub_workflow_store_for_provider'),
            patch.object(settings.catalog, 'metadata', new=AsyncMock(return_value=({}, {}))),
            patch.object(core.httpx, 'AsyncClient', side_effect=lambda **kwargs: original_client(
                **{**kwargs, 'transport': httpx.MockTransport(upstream)})),
            patch.dict(os.environ, {core.runninghub_wallet_key_env(): ''}),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def payload(self, **changes):
        return {'provider_id': 'fixture', 'base_url': 'https://changed.invalid/v1', **changes}

    def test_all_model_probe_routes_reject_changed_address_before_network(self):
        for path in ('/api/providers/test-connection', '/api/providers/fetch-models',
                     '/api/providers/probe-async', '/api/studio/settings/test'):
            with self.subTest(path=path):
                response = self.client.post(path, json=self.payload())
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn('地址', response.json()['detail'])
        self.assertEqual(self.outbound, [])

    def test_legacy_save_cannot_rebind_a_stored_key(self):
        before = copy.deepcopy(self.providers)
        response = self.client.put('/api/providers', json=[{
            **self.providers[0], 'base_url': 'https://changed.invalid/v1',
        }])
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.providers, before)
        self.assertEqual(self.saved, [])

    def test_new_save_and_sync_reject_changed_address(self):
        payload = {**self.providers[0], 'base_url': 'https://changed.invalid/v1'}
        response = self.client.put('/api/studio/settings/provider', json=payload)
        self.assertEqual(response.status_code, 400, response.text)
        response = self.client.post('/api/studio/settings/sync-models', json=payload)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.outbound, [])
        self.assertEqual(self.saved, [])

    def test_custom_image_endpoint_cannot_forward_saved_key_to_new_host(self):
        for path, body in (
                ('/api/providers', [{**self.providers[0], 'image_generation_endpoint': 'https://changed.invalid/images/generations'}]),
                ('/api/studio/settings/provider', {**self.providers[0], 'image_edit_endpoint': 'https://changed.invalid/images/edits'})):
            with self.subTest(path=path):
                response = self.client.put(path, json=body)
                self.assertEqual(response.status_code, 400, response.text[:500])
        self.assertEqual(self.saved, [])

    def test_unchanged_custom_endpoint_query_allows_name_only_save(self):
        self.providers[0]['image_generation_endpoint'] = 'https://saved.invalid/images/generations?api-version=1'
        self.providers[0]['image_edit_endpoint'] = 'https://saved.invalid/images/edits?api-version=1'
        for path in ('/api/providers', '/api/studio/settings/provider'):
            with self.subTest(path=path):
                provider = {**self.providers[0], 'name': 'Renamed fixture'}
                response = self.client.put(path, json=[provider] if path == '/api/providers' else provider)
                self.assertEqual(response.status_code, 200, response.text[:500])
                self.assertEqual(self.providers[0]['name'], 'Renamed fixture')
                self.assertEqual(self.providers[0]['image_generation_endpoint'],
                                 'https://saved.invalid/images/generations?api-version=1')
                self.assertEqual(self.keys[core.provider_key_env('fixture')], 'dummy-fixture-key')

    def test_custom_endpoint_query_does_not_bypass_host_or_userinfo_checks(self):
        self.providers[0]['image_generation_endpoint'] = 'https://saved.invalid/images/generations?api-version=1'
        for endpoint in ('https://changed.invalid/images/generations?api-version=1',
                         'https://user:pass@saved.invalid/images/generations?api-version=1'):
            for path in ('/api/providers', '/api/studio/settings/provider'):
                with self.subTest(endpoint=endpoint, path=path):
                    provider = {**self.providers[0], 'image_generation_endpoint': endpoint}
                    response = self.client.put(path, json=[provider] if path == '/api/providers' else provider)
                    self.assertEqual(response.status_code, 400, response.text[:500])
        self.assertEqual(self.saved, [])

    def test_changed_port_or_tenant_path_requires_a_new_key(self):
        for address in ('https://saved.invalid:444/v1', 'https://saved.invalid:0/v1',
                        'https://saved.invalid/another-tenant/v1'):
            with self.subTest(address=address):
                response = self.client.post('/api/providers/fetch-models', json=self.payload(base_url=address))
                self.assertEqual(response.status_code, 400, response.text[:500])
        self.assertEqual(self.outbound, [])

    def test_same_endpoint_and_explicit_replacement_remain_usable(self):
        for address, explicit, expected in (
                ('https://saved.invalid/v1/', '', 'dummy-fixture-key'),
                ('https://saved.invalid', '', 'dummy-fixture-key'),
                ('https://changed.invalid/v1', 'dummy-new-key', 'dummy-new-key'),
                ('http://127.0.0.1:11434/v1', 'dummy-local-key', 'dummy-local-key')):
            with self.subTest(address=address):
                response = self.client.post('/api/providers/fetch-models', json=self.payload(
                    base_url=address, api_key=explicit))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(self.outbound[-1].headers['Authorization'], 'Bearer ' + expected)

    def test_legacy_save_accepts_explicit_replacement_or_clear(self):
        for change in ({'api_key': 'dummy-new-key'}, {'clear_key': True}):
            with self.subTest(change=change):
                self.providers[0]['base_url'] = 'https://saved.invalid/v1'
                self.keys[core.provider_key_env('fixture')] = 'dummy-fixture-key'
                response = self.client.put('/api/providers', json=[{
                    **self.providers[0], 'base_url': 'https://changed.invalid/v1', **change,
                }])
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(self.providers[0]['base_url'], 'https://changed.invalid/v1')
                self.assertEqual(self.keys[core.provider_key_env('fixture')], change.get('api_key', ''))

    def test_orphaned_key_requires_explicit_rebinding(self):
        self.providers = []
        response = self.client.put('/api/studio/settings/provider', json={
            'id': 'fixture', 'name': 'Fixture', 'base_url': 'https://changed.invalid/v1',
        })
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.saved, [])

    def test_secondary_credentials_are_not_rebound_when_only_primary_is_replaced(self):
        for provider_id, extra_env in (
                ('runninghub', core.runninghub_wallet_key_env()),
                ('volcengine', core.volcengine_secret_key_env())):
            with self.subTest(provider_id=provider_id):
                provider = core.normalize_provider({'id': provider_id, 'base_url': 'https://saved.invalid'})
                self.providers = [provider]
                self.keys[extra_env] = 'dummy-secondary-key'
                response = self.client.put('/api/providers', json=[{
                    **provider, 'base_url': 'https://changed.invalid', 'api_key': 'dummy-new-key',
                }])
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(self.providers, [provider])

    def test_runninghub_wallet_probe_rejects_changed_address(self):
        self.providers = [core.normalize_provider({'id': 'runninghub', 'base_url': 'https://saved.invalid'})]
        self.keys[core.runninghub_wallet_key_env()] = 'dummy-wallet-key'
        with patch.dict(os.environ, {core.runninghub_wallet_key_env(): 'dummy-wallet-key'}):
            response = self.client.post('/api/providers/test-connection', json=self.payload(
                provider_id='runninghub'))
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.outbound, [])

    def test_runninghub_implicit_provider_cannot_fall_back_to_saved_wallet(self):
        self.providers = [core.normalize_provider({'id': 'runninghub', 'base_url': 'https://saved.invalid'})]
        self.keys[core.runninghub_wallet_key_env()] = 'dummy-wallet-key'
        for path in ('/api/providers/test-connection', '/api/providers/fetch-models'):
            with self.subTest(path=path):
                response = self.client.post(path, json=self.payload(provider_id='', protocol='runninghub'))
                self.assertEqual(response.status_code, 400, response.text[:500])
        self.assertEqual(self.outbound, [])

    def test_runninghub_explicit_probe_key_is_not_replaced_by_saved_wallet(self):
        self.providers = [core.normalize_provider({'id': 'runninghub', 'base_url': 'https://saved.invalid'})]
        self.keys[core.runninghub_wallet_key_env()] = 'dummy-wallet-key'
        for path in ('/api/providers/test-connection', '/api/providers/fetch-models'):
            with self.subTest(path=path):
                self.outbound.clear()
                response = self.client.post(path, json=self.payload(
                    provider_id='runninghub', api_key='dummy-new-key'))
                self.assertEqual(response.status_code, 200, response.text[:500])
                authenticated = [request for request in self.outbound if 'Authorization' in request.headers]
                self.assertTrue(authenticated)
                self.assertTrue(all(request.headers['Authorization'] == 'Bearer dummy-new-key'
                                    for request in authenticated))

    def test_volcengine_implicit_provider_fallback_cannot_send_saved_key_elsewhere(self):
        self.providers = [core.normalize_provider({'id': 'volcengine', 'base_url': 'https://saved.invalid'})]
        self.keys[core.provider_key_env('volcengine')] = 'dummy-ark-key'
        response = self.client.post('/api/providers/fetch-models', json=self.payload(
            provider_id='', protocol='volcengine'))
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.outbound, [])


class WebSocketBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(studio_server.app, base_url='http://127.0.0.1:3848')
        self.addCleanup(self.client.close)

    def test_cross_site_null_origin_and_rebinding_hosts_are_denied(self):
        for host, origin in (
                ('127.0.0.1:3848', 'https://foreign.invalid'),
                ('127.0.0.1:3848', 'null'),
                ('127.0.0.1:3848', 'http://127.0.0.1:9999'),
                ('rebinding.invalid:3848', 'http://rebinding.invalid:3848')):
            with self.subTest(host=host, origin=origin):
                with self.assertRaises(WebSocketDisconnect):
                    with self.client.websocket_connect('ws://127.0.0.1:3848/ws/stats', headers={'host': host, 'origin': origin}):
                        self.fail('Untrusted WebSocket origin was accepted')

    def test_same_origin_and_native_local_clients_receive_normal_events(self):
        for headers in ({'origin': 'http://127.0.0.1:3848'}, {}):
            with self.subTest(headers=headers):
                with self.client.websocket_connect('ws://127.0.0.1:3848/ws/stats', headers=headers) as websocket:
                    self.assertEqual(websocket.receive_json()['type'], 'stats')
                    websocket.send_text('ping')
                    self.assertEqual(websocket.receive_json(), {'type': 'pong'})

    def test_http_boundary_still_rejects_cross_site_requests(self):
        response = self.client.get('/api/studio/health', headers={'origin': 'https://foreign.invalid'})
        self.assertEqual(response.status_code, 403)


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        runtime.cleanup()
