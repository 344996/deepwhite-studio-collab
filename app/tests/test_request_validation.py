"""Request errors describe the schema, never submitted secrets or dynamic keys."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict, Field, field_validator

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix='dw-validation-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import studio_server
import main as core


class SecretFields(BaseModel):
    password: str = Field(max_length=8)
    code: int
    token: str = Field(max_length=8)


class NestedRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entries: list[SecretFields]
    labels: dict[str, int]


class CustomErrorRequest(BaseModel):
    token: str

    @field_validator('token')
    @classmethod
    def reject(cls, value):
        raise ValueError('internal validator saw ' + value)


class PromptRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=20)


class ValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app = FastAPI()
        app.add_exception_handler(RequestValidationError, core.request_validation_exception_handler)
        @app.post('/nested')
        def nested(payload: NestedRequest):
            return {}
        @app.post('/custom')
        def custom(payload: CustomErrorRequest):
            return {}
        @app.post('/prompt')
        def prompt(payload: PromptRequest):
            return {}
        cls.client = TestClient(app)

    def test_nested_credentials_and_dynamic_keys_never_echo(self):
        secrets = ['fixture-password-long', 'fixture-code-not-integer', 'fixture-token-long',
                   'fixture-dynamic-key', 'fixture-extra-key']
        response = self.client.post('/nested', json={'entries': [{'password': secrets[0],
            'code': secrets[1], 'token': secrets[2]}], 'labels': {secrets[3]: 'invalid'},
            secrets[4]: {'password': secrets[0]}})
        self.assertEqual(response.status_code, 422)
        for secret in secrets:
            self.assertNotIn(secret, response.text)
        errors = response.json()['errors']
        self.assertTrue(all(set(error) == {'loc', 'type', 'msg'} for error in errors))
        self.assertIn(['body', 'entries', 0, 'password'], [error['loc'] for error in errors])
        self.assertIn(['body', 'labels', '[key]'], [error['loc'] for error in errors])

    def test_custom_exception_context_and_message_are_not_serialized(self):
        response = self.client.post('/custom', json={'token': 'fixture-validator-secret'})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn('fixture-validator-secret', response.text)
        self.assertNotIn('internal validator', response.text)
        self.assertNotIn('ctx', response.json()['errors'][0])

    def test_prompt_limits_remain_actionable_without_echoing_prompt(self):
        response = self.client.post('/prompt', json={'prompt': 'private-prompt-' * 10})
        self.assertEqual(response.status_code, 422)
        self.assertIn('提示词', response.json()['detail'])
        self.assertIn('20', response.json()['detail'])
        self.assertIn('拆分', response.json()['detail'])
        self.assertNotIn('private-prompt-', response.text)
        self.assertIn('不能为空', self.client.post('/prompt', json={'prompt': ''}).json()['detail'])

    def test_actual_login_and_malformed_json_use_global_safe_handler(self):
        client = TestClient(studio_server.app)
        secret = 'fixture-login-password-' * 80
        response = client.post('/api/studio/account/login', json={'username': 'fixture', 'password': secret})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertNotIn(secret, response.text)
        malformed = self.client.post('/nested', content='{"password":"fixture-json-secret",broken',
            headers={'Content-Type': 'application/json'})
        self.assertEqual(malformed.status_code, 422)
        self.assertNotIn('fixture-json-secret', malformed.text)


if __name__ == '__main__':
    unittest.main()
