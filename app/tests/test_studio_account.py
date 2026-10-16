import sys
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import studio_account as account
import studio_account_extension as account_extension


class StudioAccountTests(unittest.TestCase):
    def setUp(self):
        self.runtime = tempfile.TemporaryDirectory(prefix='studio-account-test-')
        self.app = FastAPI()
        self.original_transport = account.TRANSPORT
        self.original_sessions = dict(account.SESSIONS)
        self.original_cooldowns = dict(account_extension.VERIFICATION_REQUESTS)
        account.SESSIONS.clear()
        account_extension.VERIFICATION_REQUESTS.clear()
        self.requests = []

        def upstream(request):
            self.requests.append(request)
            if request.url.path == '/api/status':
                return httpx.Response(200, json={'success': True, 'data': {
                    'register_enabled': True, 'password_register_enabled': True,
                    'email_verification': True, 'turnstile_check': False,
                    'user_agreement_enabled': True, 'privacy_policy_enabled': True,
                    'quota_per_unit': 100, 'quota_display_type': 'CNY', 'usd_exchange_rate': 7,
                }})
            if request.url.path == '/api/verification':
                return httpx.Response(200, json={'success': True, 'data': {'message': '验证码已发送'}})
            if request.url.path == '/api/user/register':
                return httpx.Response(200, json={'success': True, 'data': {}})
            if request.url.path == '/api/user/login':
                return httpx.Response(200, json={'success': True, 'data': {'require_2fa': True}}, headers={'set-cookie': 'session=private; Path=/'})
            if request.url.path == '/api/user/login/2fa':
                return httpx.Response(200, json={'success': True, 'data': {'id': 42, 'status': 1}})
            if request.url.path == '/api/user/self':
                return httpx.Response(200, json={'success': True, 'data': {'id': 42, 'username': 'Test', 'quota': 1000}})
            if request.url.path == '/api/user/logout':
                return httpx.Response(200, json={'success': True})
            return httpx.Response(404, json={'success': False, 'message': 'missing'})

        self.original_call = account.call
        account.TRANSPORT = httpx.MockTransport(upstream)
        self.upstream = upstream
        account.install(self.app)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        account.call = self.original_call
        account.TRANSPORT = None
        self.original_transport = account.TRANSPORT
        self.original_sessions = dict(account.SESSIONS)
        self.original_cooldowns = dict(account_extension.VERIFICATION_REQUESTS)
        account.SESSIONS.clear()
        account_extension.VERIFICATION_REQUESTS.clear()
        self.runtime.cleanup()

    def test_public_flags_verification_cooldown_register_payload_and_disabled_mode(self):
        flags = self.client.get('/api/studio/account/capabilities').json()
        self.assertTrue(flags['email_verification'])
        self.assertTrue(flags['user_agreement_enabled'])
        first = self.client.get('/api/studio/account/verification', params={'email': 'person@example.test'})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()['retry_after'], account_extension.VERIFICATION_COOLDOWN)
        repeated = self.client.get('/api/studio/account/verification', params={'email': 'person@example.test'})
        self.assertEqual(repeated.status_code, 429)
        payload = {'username': 'sample_user', 'password': 'password123', 'confirm_password': 'password123',
                   'email': 'person@example.test', 'verification_code': '123456', 'agree_terms': True, 'agree_privacy': True}
        result = self.client.post('/api/studio/account/register', json=payload)
        self.assertEqual(result.status_code, 200, result.text)
        req = next(r for r in self.requests if r.url.path == '/api/user/register')
        self.assertEqual(req.url.params['turnstile'], '')
        sent = json.loads(req.read())
        self.assertEqual(sent, {'username': 'sample_user', 'password': 'password123', 'email': 'person@example.test',
                               'verification_code': '123456', 'turnstile': '', 'aff_code': ''})
        self.assertNotIn('confirm_password', sent)
        self.assertNotIn('agree_terms', sent)
        with patch.object(account_extension, '_safe_call', return_value={'register_enabled': False, 'password_register_enabled': False}):
            denied = self.client.post('/api/studio/account/register', json=payload)
        self.assertEqual(denied.status_code, 403)

    def test_registration_validates_password_agreements_and_maps_duplicate_expired_and_rate_errors(self):
        payload = {'username': 'sample_user', 'password': 'password123', 'confirm_password': 'mismatch123',
                   'email': 'person@example.test', 'verification_code': '123456', 'agree_terms': True, 'agree_privacy': True}
        mismatch = self.client.post('/api/studio/account/register', json=payload)
        self.assertEqual(mismatch.status_code, 422)
        payload['confirm_password'] = payload['password']
        payload['agree_terms'] = False
        self.assertIn('用户协议', self.client.post('/api/studio/account/register', json=payload).json()['detail'])
        with patch.object(account_extension, '_safe_call', side_effect=account_extension._error_for(400, {'message': 'user already exists'})):
            duplicate = self.client.post('/api/studio/account/register', json={**payload, 'agree_terms': True})
        self.assertEqual(duplicate.status_code, 409)
        with patch.object(account_extension, '_safe_call', side_effect=account_extension._error_for(400, {'message': 'verification code expired'})):
            expired = self.client.post('/api/studio/account/register', json={**payload, 'agree_terms': True})
        self.assertIn('过期', expired.json()['detail'])
        with patch.object(account_extension, '_safe_call', side_effect=account_extension._error_for(429)):
            limited = self.client.get('/api/studio/account/verification', params={'email': 'another@example.test'})
        self.assertEqual(limited.status_code, 429)

    def test_existing_login_2fa_wallet_and_logout_flow(self):
        self.assertEqual(self.client.get('/api/studio/account').status_code, 401)
        login = self.client.post('/api/studio/account/login', json={'username': 'test', 'password': 'not-recorded'})
        self.assertTrue(login.json()['two_factor'])
        self.assertIn('HttpOnly', login.headers['set-cookie'])
        self.assertEqual(self.client.get('/api/studio/account').status_code, 401)
        self.assertEqual(self.client.post('/api/studio/account/verify', json={'code': '123456'}).status_code, 200)
        account_data = self.client.get('/api/studio/account').json()
        self.assertEqual(account_data['balance'], 70)
        self.assertNotIn('cookies', account_data)
        self.assertEqual(self.client.post('/api/studio/account/logout').status_code, 200)
        self.assertEqual(self.client.get('/api/studio/account').status_code, 401)

    def test_channel_balances_report_supported_deepwhite_key_and_unsupported_channels(self):
        def upstream(request):
            self.requests.append(request)
            if request.url.path == '/api/usage/wallet/':
                self.assertEqual(request.headers.get('authorization'), 'Bearer test-wallet-key')
                return httpx.Response(200, json={'code': True, 'data': {'amount': 12.5, 'display_type': 'CNY'}})
            return self.upstream(request)

        account.TRANSPORT = httpx.MockTransport(upstream)
        fake_core = SimpleNamespace(
            load_api_providers=lambda: [
                {'id': 'deepwhiteai', 'name': 'DeepWhite API', 'base_url': 'https://api.deepwhiteai.com/v1'},
                {'id': 'runninghub', 'name': 'RunningHub', 'base_url': 'https://www.runninghub.ai'},
            ],
            provider_env_key_value=lambda provider_id: 'test-wallet-key' if provider_id == 'deepwhiteai' else '',
        )
        with patch.dict(sys.modules, {'main': fake_core}), patch.dict('os.environ', {'DEEPWHITE_TEST_ACCOUNT': 'unused'}):
            with patch.object(account_extension, '_deepwhite_key_balance', wraps=account_extension._deepwhite_key_balance):
                # Avoid invoking the optional CLI executable in this contract test.
                with patch.dict(sys.modules, {'studio_dreamina': SimpleNamespace(status=lambda: {'available': False, 'enabled': False})}):
                    response = self.client.get('/api/studio/channel-balances')
        self.assertEqual(response.status_code, 200, response.text)
        items = {item['id']: item for item in response.json()['items']}
        self.assertEqual(items['deepwhiteai']['balance'], 12.5)
        self.assertEqual(items['deepwhiteai']['unit'], 'CNY')
        self.assertEqual(items['runninghub']['status'], 'unsupported')
        self.assertEqual(items['dreamina-cli']['status'], 'unsupported')
        self.assertTrue(items['deepwhiteai']['updated_at'])
        self.assertNotIn('test-wallet-key', response.text)


if __name__ == '__main__':
    unittest.main()
