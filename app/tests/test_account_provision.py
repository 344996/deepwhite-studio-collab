"""Session -> individual generation key -> models, with no real account/network."""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix='studio-account-provision-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import main as core
import studio_account as account
import studio_account_provision as provision
import studio_catalog as catalog
import studio_generation as generation
import studio_settings as settings
from studio_capabilities import profile

SECRET = 'sk-synthetic-generation-credential-123456789'
MODELS = ['deepwhiteai-image-g2-t2i', 'deepwhiteai-image-g2-i2i', 'deepseek-chat']


class AccountProvisionTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=runtime.name)
        self.patches = [
            patch.object(core, 'DATA_DIR', self.dir.name),
            patch.object(core, 'API_PROVIDERS_FILE', str(Path(self.dir.name) / 'api_providers.json')),
            patch.object(core, 'API_ENV_FILE', str(Path(self.dir.name) / '.env')),
            patch.object(catalog, 'metadata', AsyncMock(return_value=({}, {}))),
            patch.object(core, 'prune_runninghub_workflow_store_for_provider'),
            patch.object(core, 'sync_runninghub_provider_workflows_to_static_template'),
        ]
        for item in self.patches: item.start()
        account.SESSIONS.clear()
        account.FLOW_LOCK = asyncio.Lock()
        provision.ACTIVE = None
        self.requests = []
        self.tokens = {}
        self.uid = 10
        self.two_factor = False
        self.verification_fail = False
        self.unsupported = False
        self.legacy = False
        self.models_fail = False
        self.create_timeout = ''
        self.disabled = False
        self.creates = 0
        transport = httpx.MockTransport(self.upstream)
        account.TRANSPORT = provision.KEY_TRANSPORT = transport
        app = FastAPI()
        account.install(app)
        settings.install(app)
        app.put('/api/providers')(core.save_providers)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        account.SESSIONS.clear()
        provision.ACTIVE = None
        account.TRANSPORT = provision.KEY_TRANSPORT = None
        for item in reversed(self.patches): item.stop()
        self.dir.cleanup()

    def upstream(self, request):
        self.requests.append(request)
        path = request.url.path
        data = {}
        if path == '/api/user/login':
            if json.loads(request.content).get('username') == 'second':
                self.uid = 20
            data = {'require_2fa': True} if self.two_factor else {'id': self.uid, 'status': 1}
        elif path in ('/api/user/login/2fa', '/api/user/self'):
            if path.endswith('/2fa') and self.verification_fail:
                return httpx.Response(400, json={'success': False, 'message': 'incorrect code ' + SECRET})
            data = {'id': self.uid, 'status': 1, 'username': 'Synthetic account', 'quota': 100}
        elif path == '/api/status':
            data = {'quota_per_unit': 100, 'quota_display_type': 'USD'}
        elif path == '/api/user/logout':
            pass
        elif path.startswith('/api/token'):
            self.assertEqual(request.headers.get('new-api-user'), str(self.uid))
            self.assertNotIn('authorization', request.headers)
            if self.unsupported:
                return httpx.Response(404, json={'message': SECRET})
            if path == '/api/token/search':
                token = self.tokens.get(self.uid)
                data = {'items': [dict(token, key='sk-****', status=2 if self.disabled else 1)] if token else []}
            elif path == '/api/token/' and request.method == 'POST':
                self.creates += 1
                body = json.loads(request.content)
                self.assertEqual(body['expired_time'], -1)
                self.assertFalse(body['model_limits_enabled'])
                self.assertNotIn('password', body)
                if self.create_timeout != 'empty':
                    self.tokens[self.uid] = {'id': self.uid + 100, 'name': body['name'], 'user_id': self.uid, 'expired_time': -1}
                if self.create_timeout:
                    raise httpx.ReadTimeout(SECRET, request=request)
            elif path.endswith('/key'):
                if self.legacy: return httpx.Response(404, json={'success': False})
                data = {'key': SECRET + str(self.uid)}
            else:
                data = {**self.tokens[self.uid], 'key': SECRET + str(self.uid) if self.legacy else 'sk-****'}
        elif path == '/v1/models':
            self.assertEqual(request.headers.get('authorization'), 'Bearer ' + SECRET + str(self.uid))
            self.assertNotIn('cookie', request.headers)
            if self.models_fail: return httpx.Response(503, text=SECRET)
            return httpx.Response(200, json={'data': [{'id': model} for model in MODELS]})
        else:
            self.fail('Unexpected upstream request: ' + request.method + ' ' + path)
        return httpx.Response(200, json={'success': True, 'data': data}, headers={'set-cookie': 'session=synthetic-only; Path=/'})

    def login(self):
        response = self.client.post('/api/studio/account/login', json={'username': 'fixture', 'password': 'synthetic-password'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn(SECRET, response.text)
        return response.json()

    def test_login_creates_individual_key_and_syncs_models_without_secret_on_disk(self):
        result = self.login()
        self.assertEqual(result['generation']['status'], 'ready')
        pid = result['generation']['provider_id']
        self.assertEqual(core.provider_env_key_value(pid), SECRET + '10')
        self.assertEqual(core.get_api_provider_exact(pid)['image_models'], ['deepwhiteai-image-g2'])
        self.assertEqual(result['generation']['model_count'], 2)
        self.assertEqual(self.creates, 1)
        for path in Path(self.dir.name).rglob('*'):
            if path.is_file():
                text = path.read_text(encoding='utf-8')
                self.assertNotIn(SECRET, text)
                self.assertNotIn('synthetic-password', text)
                self.assertNotIn('synthetic-only', text)
        self.assertNotIn(SECRET, self.client.get('/api/studio/account').text)

    def test_reconnect_reuses_same_token_and_keeps_disabled_model_choice(self):
        pid = self.login()['generation']['provider_id']
        response = self.client.patch('/api/studio/model-catalog/' + pid, json={'models': [{'id': 'deepwhiteai-image-g2', 'enabled': False}]})
        self.assertEqual(response.status_code, 200)
        retried = self.client.post('/api/studio/account/provision')
        self.assertEqual(retried.json()['generation']['status'], 'ready')
        self.assertEqual(core.get_api_provider_exact(pid)['image_models'], [])
        self.assertEqual(self.creates, 1)

    def test_reconnect_keeps_manually_selected_alternative_default(self):
        pid = self.login()['generation']['provider_id']
        providers = [{**p, 'primary': False} for p in core.load_api_providers()]
        manual = core.normalize_provider({'id': 'manual', 'name': 'My default', 'base_url': 'https://custom.example/v1', 'primary': True})
        core.save_api_providers([manual, *providers])
        self.assertEqual(self.client.post('/api/studio/account/provision').json()['generation']['status'], 'ready')
        self.assertEqual(core.get_primary_provider_id(), 'manual')
        self.assertFalse(core.get_api_provider_exact(pid)['primary'])

    def test_logout_invalidates_generation_for_new_and_legacy_key_lookup(self):
        pid = self.login()['generation']['provider_id']
        self.assertTrue(generation.connection(pid)[1]['Authorization'])
        self.assertEqual(self.client.post('/api/studio/account/logout').status_code, 200)
        self.assertFalse(core.provider_env_key_value(pid))
        with self.assertRaises(HTTPException): generation.connection(pid)
        provider = next(p for p in core.load_api_providers() if p['id'] == pid)
        self.assertFalse(core.public_provider(provider)['has_key'])
        self.assertEqual(self.client.get('/api/studio/account').status_code, 401)

    def test_switch_account_never_reuses_old_key_and_preserves_manual_provider(self):
        manual = core.normalize_provider({'id': 'manual', 'name': 'My API', 'base_url': 'https://custom.example/v1', 'chat_models': ['custom-model']})
        core.save_api_providers([manual])
        core.update_env_values({core.provider_key_env('manual'): 'manual-fixture-secret'})
        first = self.login()['generation']['provider_id']
        self.uid = 20
        second = self.login()['generation']['provider_id']
        self.assertNotEqual(first, second)
        self.assertFalse(core.provider_env_key_value(first))
        self.assertEqual(core.provider_env_key_value(second), SECRET + '20')
        self.assertEqual(core.provider_env_key_value('manual'), 'manual-fixture-secret')
        self.assertEqual(core.get_api_provider_exact('manual')['chat_models'], ['custom-model'])

    def test_two_factor_does_not_create_or_enable_generation_until_verified(self):
        self.two_factor = True
        response = self.login()
        self.assertTrue(response['two_factor'])
        self.assertEqual(self.creates, 0)
        self.assertIsNone(provision.ACTIVE)
        response = self.client.post('/api/studio/account/verify', json={'code': '123456'})
        self.assertEqual(response.json()['generation']['status'], 'ready')
        self.assertEqual(self.creates, 1)

    def test_switch_to_two_factor_account_revokes_old_key_even_if_code_fails(self):
        first = self.login()['generation']['provider_id']
        self.uid = 20
        self.two_factor = self.verification_fail = True
        self.assertTrue(self.login()['two_factor'])
        self.assertFalse(core.provider_env_key_value(first))
        failed = self.client.post('/api/studio/account/verify', json={'code': '000000'})
        self.assertEqual(failed.status_code, 400)
        self.assertNotIn(SECRET, failed.text)
        self.assertEqual(self.creates, 1)
        self.assertIsNone(provision.ACTIVE)
        self.verification_fail = False
        self.assertEqual(self.client.post('/api/studio/account/verify', json={'code': '123456'}).json()['generation']['status'], 'ready')

    def test_concurrent_logins_finish_with_only_the_last_account_credential(self):
        async def metadata(_):
            await asyncio.sleep(.03)
            return {}, {}

        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.client.app), base_url='http://local.test') as first:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.client.app), base_url='http://local.test') as second:
                    with patch.object(catalog, 'metadata', metadata):
                        responses = await asyncio.gather(
                            first.post('/api/studio/account/login', json={'username': 'first', 'password': 'fixture'}),
                            second.post('/api/studio/account/login', json={'username': 'second', 'password': 'fixture'}),
                        )
                    self.assertTrue(all(r.json()['generation']['status'] == 'ready' for r in responses))
                    self.assertFalse(core.provider_env_key_value(provision.provider_id(10)))
                    self.assertEqual(core.provider_env_key_value(provision.provider_id(20)), SECRET + '20')
                    self.assertEqual((await first.get('/api/studio/account')).status_code, 401)
                    self.assertEqual((await second.get('/api/studio/account')).status_code, 200)
        asyncio.run(run())

    def test_account_refresh_and_retry_serialize_session_mutations(self):
        pid = self.login()['generation']['provider_id']
        original = account.call

        async def run():
            started, release = asyncio.Event(), asyncio.Event()
            self_reads = []
            async def delayed(session, method, path, body=None):
                if path == '/api/user/self':
                    self_reads.append(path)
                    if len(self_reads) == 1:
                        started.set()
                        await release.wait()
                        raise HTTPException(401, 'Synthetic expired refresh')
                return await original(session, method, path, body)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.client.app),
                                         base_url='http://testserver', cookies=self.client.cookies) as client:
                with patch.object(account, 'call', delayed):
                    refresh = asyncio.create_task(client.get('/api/studio/account'))
                    await started.wait()
                    retry = asyncio.create_task(client.post('/api/studio/account/provision'))
                    await asyncio.sleep(.02)
                    self.assertEqual(len(self_reads), 1)
                    release.set()
                    first, second = await asyncio.gather(refresh, retry)
                self.assertEqual(first.status_code, 401)
                self.assertEqual(second.json()['generation']['status'], 'ready')
                self.assertEqual(len(self_reads), 2)
                self.assertEqual(core.provider_env_key_value(pid), SECRET + '10')
        asyncio.run(run())

    def test_unsupported_token_api_keeps_login_and_returns_recoverable_state(self):
        self.unsupported = True
        result = self.login()
        self.assertEqual(result['generation']['status'], 'action_required')
        self.assertTrue(result['generation']['retryable'])
        self.assertEqual(self.client.get('/api/studio/account').status_code, 200)
        self.assertEqual(self.creates, 0)
        self.assertFalse(core.provider_env_key_value(result['generation']['provider_id']))

    def test_sync_failure_preserves_login_and_retries_existing_authorization(self):
        self.models_fail = True
        result = self.login()
        self.assertEqual(result['generation']['status'], 'models_pending')
        self.assertEqual(self.client.get('/api/studio/account').status_code, 200)
        self.models_fail = False
        result = self.client.post('/api/studio/account/provision').json()
        self.assertEqual(result['generation']['status'], 'ready')
        self.assertEqual(self.creates, 1)

    def test_ambiguous_create_timeout_reconciles_existing_token_without_repeating_post(self):
        self.create_timeout = 'created'
        self.assertEqual(self.login()['generation']['status'], 'action_required')
        self.create_timeout = ''
        retried = self.client.post('/api/studio/account/provision').json()
        self.assertEqual(retried['generation']['status'], 'ready')
        self.assertEqual(self.creates, 1)

    def test_ambiguous_empty_create_stays_pending_without_duplicate_or_secret_echo(self):
        self.create_timeout = 'empty'
        self.login()
        self.create_timeout = ''
        result = self.client.post('/api/studio/account/provision')
        self.assertEqual(result.json()['generation']['status'], 'action_required')
        self.assertIn('停止重复创建', result.json()['generation']['message'])
        self.assertEqual(self.creates, 1)
        self.assertNotIn(SECRET, result.text)

    def test_failed_durable_binding_write_never_sends_upstream_create(self):
        original = core._atomic_write_bytes
        for fail_at in (1, 2):
            with self.subTest(fail_at=fail_at):
                writes = []
                def failed_write(path, raw):
                    writes.append(path)
                    if len(writes) == fail_at:
                        raise OSError('synthetic disk full')
                    return original(path, raw)
                with patch.object(core, '_atomic_write_bytes', failed_write):
                    response = self.login()
                self.assertEqual(response['generation']['status'], 'action_required')
                self.assertEqual(self.creates, 0)
                self.assertFalse(core.provider_env_key_value(response['generation']['provider_id']))
        self.assertEqual(self.client.post('/api/studio/account/provision').json()['generation']['status'], 'ready')
        self.assertEqual(self.creates, 1)

    def test_disabled_upstream_token_is_not_reactivated_or_replaced(self):
        self.login()
        self.disabled = True
        result = self.client.post('/api/studio/account/provision')
        self.assertEqual(result.json()['generation']['status'], 'action_required')
        self.assertIn('不会自动重新启用', result.text)
        self.assertEqual(self.creates, 1)

    def test_expired_session_key_is_unavailable_even_before_account_request(self):
        pid = self.login()['generation']['provider_id']
        provision.ACTIVE['expires'] = time.time() - 1
        self.assertFalse(core.provider_env_key_value(pid))
        with self.assertRaises(HTTPException): generation.connection(pid)
        self.assertEqual(self.client.get('/api/studio/account').status_code, 401)

    def test_managed_address_key_edits_and_env_fallback_are_blocked(self):
        pid = self.login()['generation']['provider_id']
        denied = self.client.put('/api/studio/settings/provider', json={'id': pid, 'base_url': 'https://other.example/v1', 'api_key': 'manual-secret'})
        self.assertEqual(denied.status_code, 409)
        denied = self.client.put('/api/studio/settings/provider', json={'id': pid.upper(), 'base_url': 'https://other.example/v1', 'api_key': 'manual-secret'})
        self.assertEqual(denied.status_code, 409)
        # A tampered or imported provider record cannot redirect session keys.
        providers = core.load_api_providers()
        for row in providers:
            if row['id'] == pid: row['base_url'] = 'https://other.example/v1'
        core.save_api_providers(providers)
        core.update_env_values({core.provider_key_env(pid): 'injected-fallback-secret'})
        self.assertFalse(core.provider_env_key_value(pid))

    def test_missing_old_account_cannot_fall_back_to_new_account_in_legacy_selectors(self):
        first = self.login()['generation']['provider_id']
        stale = core.get_api_provider_exact(first)
        self.uid = 20
        second = self.login()['generation']['provider_id']
        # Simulate a pre-fix bulk deletion or an imported project with no row.
        core.save_api_providers([p for p in core.load_api_providers() if p['id'] != first])
        self.assertEqual(core.get_api_provider(second)['id'], second)
        for operation in (
            lambda: core.get_api_provider(first),
            lambda: core.get_api_provider_exact(first),
            lambda: core.pick_chat_image_provider(first, second),
            lambda: core.pick_chat_image_provider('', first),
            lambda: core.api_headers(provider=stale),
            lambda: generation.connection(first),
        ):
            with self.subTest(operation=operation), self.assertRaises(HTTPException):
                operation()

    def test_inactive_account_is_rejected_by_both_generation_stacks_and_chat_selector(self):
        for state in ('logout', 'expired', 'switched'):
            with self.subTest(state=state):
                self.uid = 10
                pid = self.login()['generation']['provider_id']
                provider = core.get_api_provider_exact(pid)
                if state == 'logout':
                    self.client.post('/api/studio/account/logout')
                elif state == 'expired':
                    provision.ACTIVE['expires'] = time.time() - 1
                else:
                    self.uid = 20
                    self.login()
                for operation in (
                    lambda: core.get_api_provider(pid),
                    lambda: core.get_api_provider_exact(pid),
                    lambda: core.pick_chat_image_provider(pid),
                    lambda: core.api_headers(provider=provider),
                    lambda: generation.connection(pid),
                ):
                    with self.assertRaises(HTTPException):
                        operation()

    def test_legacy_bulk_edit_cannot_drop_or_create_account_managed_channels(self):
        pid = self.login()['generation']['provider_id']
        before = core.load_api_providers()
        manual = core.normalize_provider({'id': 'manual', 'base_url': 'https://fixture.invalid/v1'})
        dropped = self.client.put('/api/providers', json=[manual])
        self.assertEqual(dropped.status_code, 409, dropped.text)
        self.assertEqual(core.load_api_providers(), before)
        injected = {**before[0], 'id': provision.provider_id(999)}
        response = self.client.put('/api/providers', json=[*before, injected])
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(core.provider_env_key_value(pid), SECRET + '10')
        self.assertEqual(core.load_api_providers(), before)

    def test_legacy_bulk_edits_block_managed_endpoints_even_with_replacement_key(self):
        pid = self.login()['generation']['provider_id']
        before = core.load_api_providers()
        for changes in (
            {'image_generation_endpoint': 'https://endpoint-fixture.invalid/images', 'api_key': 'manual-replacement-fixture'},
            {'image_edit_endpoint': 'https://endpoint-fixture.invalid/edits', 'clear_key': True},
            {'image_generation_endpoint': '/v1/unapproved'},
            {'base_url': 'https://endpoint-fixture.invalid/v1', 'api_key': 'manual-replacement-fixture'},
            {'protocol': 'gemini', 'api_key': 'manual-replacement-fixture'},
            {'model_protocols': {'deepwhiteai-image-g2': 'gemini'}},
            {'image_request_mode': 'openai-json'},
            {'enabled': False},
            {'api_key': 'manual-replacement-fixture'},
            {'clear_key': True},
        ):
            with self.subTest(fields=list(changes)):
                payload = [{**p, **changes} if p['id'] == pid else p for p in before]
                response = self.client.put('/api/providers', json=payload)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertEqual(core.load_api_providers(), before)
                self.assertEqual(core.provider_env_key_value(pid), SECRET + '10')
        env_file = Path(core.API_ENV_FILE)
        self.assertFalse(env_file.exists() and 'manual-replacement-fixture' in env_file.read_text())

    def test_legacy_bulk_edit_keeps_managed_fields_and_allows_manual_default(self):
        pid = self.login()['generation']['provider_id']
        managed = core.get_api_provider_exact(pid)
        manual = core.normalize_provider({'id': 'manual', 'name': 'My API',
                                          'base_url': 'https://custom.example/v1', 'primary': True})
        other = [p for p in core.load_api_providers() if p['id'] != pid]
        response = self.client.put('/api/providers', json=[
            *other, {'id': pid, 'primary': False}, {**manual, 'api_key': 'manual-fixture'},
        ])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(core.get_api_provider_exact(pid), {**managed, 'primary': False})
        self.assertEqual(core.get_primary_provider_id(), 'manual')
        self.assertEqual(core.provider_env_key_value('manual'), 'manual-fixture')

    def test_managed_key_checks_saved_and_runtime_endpoint_overrides(self):
        pid = self.login()['generation']['provider_id']
        before = core.load_api_providers()
        provider = core.get_api_provider_exact(pid)
        for change in (
            {'image_generation_endpoint': 'https://endpoint-fixture.invalid/images'},
            {'image_edit_endpoint': 'https://endpoint-fixture.invalid/edits'},
            {'image_generation_endpoint': '/v1/unapproved'},
            {'model_protocols': {'deepwhiteai-image-g2': 'gemini'}},
        ):
            with self.subTest(change=change):
                altered = {**provider, **change}
                # A caller-supplied or stale in-memory dict is checked too.
                with self.assertRaises(HTTPException):
                    core.api_headers(provider=altered)
                with self.assertRaises(HTTPException):
                    core.provider_endpoint_url(altered, 'image_generation_endpoint', '/v1/images/generations')
                core.save_api_providers([altered if p['id'] == pid else p for p in before])
                self.assertFalse(core.provider_env_key_value(pid))
                with self.assertRaises(HTTPException):
                    core.api_headers(provider=provider)
                with self.assertRaises(HTTPException):
                    generation.connection(pid)
                core.save_api_providers(before)
        self.assertEqual(core.api_headers(provider=provider)['Authorization'], 'Bearer ' + SECRET + '10')

    def test_reconnect_clears_inherited_transport_overrides_and_keeps_model_preferences(self):
        pid = self.login()['generation']['provider_id']
        self.client.patch('/api/studio/model-catalog/' + pid,
                          json={'models': [{'id': 'deepwhiteai-image-g2', 'enabled': False}]})
        providers = core.load_api_providers()
        altered = next(p for p in providers if p['id'] == pid)
        altered.update(image_generation_endpoint='https://endpoint-fixture.invalid/images',
                       image_edit_endpoint='https://endpoint-fixture.invalid/edits',
                       model_protocols={'deepseek-chat': 'gemini'})
        core.save_api_providers(providers)
        response = self.client.post('/api/studio/account/provision')
        self.assertEqual(response.json()['generation']['status'], 'ready', response.text)
        current = core.get_api_provider_exact(pid)
        self.assertEqual(current['image_generation_endpoint'], '')
        self.assertEqual(current['image_edit_endpoint'], '')
        self.assertEqual(current['model_protocols'], {})
        self.assertEqual(current['image_models'], [])
        self.assertEqual(self.creates, 1)

    def test_managed_probe_never_uses_replacement_or_protocol_fallback_credentials(self):
        pid = self.login()['generation']['provider_id']
        for values in (
            {'base_url': 'https://endpoint-fixture.invalid/v1'},
            {'base_url': provision.BASE_URL, 'api_key': 'manual-replacement-fixture'},
            {'base_url': provision.BASE_URL, 'protocol': 'runninghub'},
        ):
            payload = core.TestConnectionPayload(provider_id=pid, **values)
            with self.subTest(values=values), self.assertRaises(HTTPException):
                core.api_key_from_payload(payload)
            with self.assertRaises(HTTPException):
                settings.resolve_key(payload)
        self.client.post('/api/studio/account/logout')
        payload = core.TestConnectionPayload(provider_id=pid, base_url=core.RUNNINGHUB_DEFAULT_BASE_URL,
                                            protocol='runninghub')
        with patch.object(core, 'runninghub_wallet_key_value', return_value='unrelated-fixture-key'):
            with self.assertRaises(HTTPException):
                core.api_key_from_payload(payload)

    def test_old_project_generation_routes_reject_removed_account_before_dispatch(self):
        pid = self.login()['generation']['provider_id']
        self.uid = 20
        self.login()
        core.save_api_providers([p for p in core.load_api_providers() if p['id'] != pid])
        routes = (
            ('/api/online-image', 'online_image', {'provider_id': pid, 'model': 'deepwhiteai-image-g2', 'prompt': 'a synthetic landscape'}),
            ('/api/canvas-image-tasks', 'create_canvas_image_task', {'provider_id': pid, 'model': 'deepwhiteai-image-g2', 'prompt': 'a synthetic landscape'}),
            ('/api/canvas-llm', 'canvas_llm', {'provider': pid, 'model': 'deepseek-chat', 'message': 'synthetic text'}),
            ('/api/canvas-video', 'canvas_video', {'provider_id': pid, 'model': 'sora-2', 'prompt': 'synthetic video'}),
        )
        for has_catalog in (True, False):
            if not has_catalog:
                store = catalog.load_store()
                store.pop(pid)
                catalog.save_store(store)
            for path, target, body in routes:
                with self.subTest(path=path, has_catalog=has_catalog), patch.object(core, target, AsyncMock()) as paid:
                    response = self.client.post(path, json=body)
                    self.assertIn(response.status_code, (400, 401, 409), response.text)
                    paid.assert_not_called()

    def test_older_new_api_full_key_get_fallback(self):
        self.legacy = True
        self.assertEqual(self.login()['generation']['status'], 'ready')
        self.assertEqual(self.creates, 1)

    def test_preview_is_separate_and_cannot_enable_models(self):
        response = self.client.get('/api/studio/model-catalog').json()
        self.assertFalse(response['preview']['connected'])
        self.assertTrue(response['preview']['models'])
        self.assertTrue(all(not item['enabled'] and not item['available'] for item in response['preview']['models']))
        self.assertNotIn('deepwhite-preview', response['providers'])

    def test_save_manual_connection_automatically_syncs_and_preserves_preferences_on_refresh(self):
        values = {'id': 'manual', 'name': 'Manual', 'base_url': 'https://custom.example/v1', 'api_key': 'manual-fixture'}
        result = {'model_records': [{'id': 'gpt-image-1'}], 'model_count': 1}
        with patch.object(settings, 'read_models', AsyncMock(return_value=result)):
            response = self.client.put('/api/studio/settings/provider', json=values)
            self.assertEqual(response.json()['sync']['status'], 'ready')
            self.client.patch('/api/studio/model-catalog/manual', json={'models': [{'id': 'gpt-image-1', 'enabled': False}]})
            values.pop('api_key')
            response = self.client.put('/api/studio/settings/provider', json=values)
        self.assertEqual(response.json()['provider']['image_models'], [])
        self.assertFalse(response.json()['models'][0]['enabled'])

    def test_save_failure_keeps_key_and_existing_catalogue_with_retry_status(self):
        values = {'id': 'manual', 'name': 'Manual', 'base_url': 'https://custom.example/v1', 'api_key': 'manual-fixture'}
        with patch.object(settings, 'read_models', AsyncMock(return_value={'model_records': [{'id': 'gpt-image-1'}], 'model_count': 1})):
            self.client.put('/api/studio/settings/provider', json=values)
        before = catalog.load_store()
        with patch.object(settings, 'read_models', AsyncMock(side_effect=HTTPException(504, '连接超时。'))):
            response = self.client.put('/api/studio/settings/provider', json=values)
        self.assertEqual(response.json()['sync']['status'], 'retryable')
        self.assertEqual(catalog.load_store(), before)
        self.assertEqual(core.provider_env_key_value('manual'), 'manual-fixture')

    def test_g2_validates_prompt_before_stage_and_legacy_paid_routes(self):
        pid = self.login()['generation']['provider_id']
        for model in ('deepwhiteai-image-g2', 'deepwhiteai-image-g2-t2i', 'deepwhiteai-image-g2-i2i'):
            self.assertEqual((profile(model, 'image')['prompt_min'], profile(model, 'image')['prompt_max']), (5, 2000))
            with self.assertRaises(HTTPException):
                generation.checked(generation.Generation(request_id='fixture-request', provider_id=pid, model=model, kind='image', prompt='123'))
        with patch.object(core, 'online_image', AsyncMock()) as paid:
            response = self.client.post('/api/online-image', json={'provider_id': pid, 'model': 'deepwhiteai-image-g2', 'prompt': '123'})
            self.assertEqual(response.status_code, 400)
            paid.assert_not_called()
        with patch.object(core, 'create_canvas_image_task', AsyncMock()) as paid:
            response = self.client.post('/api/canvas-image-tasks', json={'provider_id': pid, 'model': 'deepwhiteai-image-g2', 'prompt': 'x' * 2001})
            self.assertEqual(response.status_code, 400)
            paid.assert_not_called()


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        runtime.cleanup()
