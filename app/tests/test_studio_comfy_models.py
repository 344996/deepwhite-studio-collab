"""Offline tests for installed ComfyUI model discovery and its unverified state."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
import studio_comfy as comfy


class Response:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class Client:
    def __init__(self, payload=None, error=None, **kwargs):
        self.payload = payload
        self.error = error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url):
        if self.error:
            raise self.error
        return Response(self.payload)


def model_response(choices):
    return {'UNETLoader': {'input': {'required': {'unet_name': [choices]}}}}


class ComfyModelDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        comfy._models = []
        comfy._models_verified = False
        comfy._models_at = 0

    def spec_model(self):
        return comfy.spec()['fields']['main_model']

    async def test_offline_clears_candidates_and_names_fixed_compatibility_value(self):
        offline = httpx.ConnectError('offline', request=None)
        with patch.object(comfy.httpx, 'AsyncClient', side_effect=lambda **kwargs: Client(error=offline)):
            await comfy.refresh_models()

        field = self.spec_model()
        self.assertFalse(comfy.spec()['models_verified'])
        self.assertEqual(field['values'], [])
        self.assertEqual(field['default'], comfy.DEFAULT_UNET)
        self.assertIn('未检测', field['label'])
        self.assertIn('固定值', field['label'])

    async def test_success_lists_only_installed_compatible_models(self):
        choices = [comfy.DEFAULT_UNET, 'qwen_image_2.1_bf16.safetensors', 'flux.safetensors']
        with patch.object(comfy.httpx, 'AsyncClient', side_effect=lambda **kwargs: Client(payload=model_response(choices))):
            await comfy.refresh_models()

        field = self.spec_model()
        self.assertTrue(comfy.spec()['models_verified'])
        self.assertEqual(field['values'], choices[:2])
        self.assertEqual(field['default'], comfy.DEFAULT_UNET)

    async def test_success_with_no_compatible_models_does_not_invent_a_choice(self):
        with patch.object(comfy.httpx, 'AsyncClient', side_effect=lambda **kwargs: Client(payload=model_response(['flux.safetensors']))):
            await comfy.refresh_models()

        field = self.spec_model()
        self.assertTrue(comfy.spec()['models_verified'])
        self.assertEqual(field['values'], [])
        self.assertEqual(field['default'], comfy.DEFAULT_UNET)
        self.assertIn('未检测到已安装的兼容模型', field['label'])

    async def test_malformed_response_remains_unverified(self):
        with patch.object(comfy.httpx, 'AsyncClient', side_effect=lambda **kwargs: Client(payload={'unexpected': {}})):
            await comfy.refresh_models()

        self.assertFalse(comfy.spec()['models_verified'])
        self.assertEqual(self.spec_model()['values'], [])
        self.assertIn('未检测', self.spec_model()['label'])


if __name__ == '__main__':
    unittest.main()
