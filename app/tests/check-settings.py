"""No upstream network: all provider responses use httpx.MockTransport."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix='deepwhite-settings-test-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import httpx
from fastapi import HTTPException
import studio_server
import studio_settings as settings
import main as core

KEY = 'sk-fixture-only-no-real-credit-12345678'


class SettingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=studio_server.app), base_url='http://testserver')

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_read_only_models(self):
        calls = []
        def upstream(request):
            calls.append(request)
            self.assertEqual(request.headers['Authorization'], 'Bearer ' + KEY)
            return httpx.Response(200, json={'data':[{'id':m} for m in ['deepseek-chat','gpt-image-1','seedance-2-fast','minimax-h3','seedaudio','unclassified-v2']]})
        payload = core.TestConnectionPayload(base_url='https://example.test',api_key=KEY)
        result = await settings.read_models(payload,httpx.MockTransport(upstream))
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0].method,'GET')
        self.assertEqual(str(calls[0].url),'https://example.test/v1/models')
        self.assertEqual({m['kind'] for m in result['models']},{'chat','image','video','audio','unknown'})
        self.assertNotIn(KEY,str(result))
        self.assertEqual(settings.models_url('https://example.test/v1/'),'https://example.test/v1/models')

    async def test_errors_do_not_probe_or_echo_secrets(self):
        payload = core.TestConnectionPayload(base_url='https://example.test/v1',api_key=KEY)
        for status in (401,403,404,429,500,302):
            calls = []
            def upstream(request):
                calls.append(request)
                return httpx.Response(status,text=KEY,headers={'Location':'https://elsewhere.test/v1/models'})
            with self.assertRaises(HTTPException) as caught:
                await settings.read_models(payload,httpx.MockTransport(upstream))
            self.assertNotIn(KEY,caught.exception.detail)
            self.assertEqual(len(calls),1)
            self.assertEqual(calls[0].method,'GET')
        for response in (httpx.Response(200,text='<html>website</html>'),httpx.Response(200,json={'error':'oops'})):
            with self.assertRaises(HTTPException):
                await settings.read_models(payload,httpx.MockTransport(lambda request:response))
        def timeout(request):
            raise httpx.ReadTimeout('fixture',request=request)
        with self.assertRaises(HTTPException) as caught:
            await settings.read_models(payload,httpx.MockTransport(timeout))
        self.assertEqual(caught.exception.status_code,504)

    async def test_save_preserve_refresh_clear_and_host_guard(self):
        # The save endpoint now attempts model discovery automatically. Keep
        # this legacy storage-focused check fully offline on a failed discovery.
        probe = patch.object(settings, 'read_models', AsyncMock(side_effect=HTTPException(504, 'offline fixture')))
        probe.start()
        self.addCleanup(probe.stop)
        original = core.load_api_providers()
        payload={'id':'studio-fixture','name':'Fixture','base_url':'https://example.test/v1','api_key':KEY,'primary':True,'chat_models':['fixture-chat'],'image_models':['fixture-image'],'video_models':['fixture-video']}
        response = await self.client.put('/api/studio/settings/provider',json=payload)
        self.assertEqual(response.status_code,200)
        self.assertNotIn(KEY,response.text)
        self.assertTrue(response.json()['provider']['has_key'])
        self.assertEqual(core.provider_env_key_value(payload['id']),KEY)
        self.assertEqual(set(p['id'] for p in core.load_api_providers()),set(p['id'] for p in original)|{payload['id']})
        primary = [p for p in core.load_api_providers() if p.get('primary')]
        self.assertEqual([p['id'] for p in primary],[payload['id']])
        payload.pop('api_key')
        payload['chat_models']=['changed-chat']
        response=await self.client.put('/api/studio/settings/provider',json=payload)
        self.assertEqual(response.status_code,200)
        self.assertEqual(core.provider_env_key_value(payload['id']),KEY)
        self.assertEqual(core.get_api_provider_exact(payload['id'])['chat_models'],['changed-chat'])
        payload['base_url']='https://elsewhere.test/v1'
        self.assertEqual((await self.client.put('/api/studio/settings/provider',json=payload)).status_code,400)
        with self.assertRaises(HTTPException):
            settings.resolve_key(core.TestConnectionPayload(base_url=payload['base_url'],provider_id=payload['id']))
        payload['clear_key']=True
        response=await self.client.put('/api/studio/settings/provider',json=payload)
        self.assertEqual(response.status_code,200)
        self.assertFalse(response.json()['provider']['has_key'])
        self.assertFalse(core.provider_env_key_value(payload['id']))

    async def test_invalid_address_and_key(self):
        for url in ('file:///tmp/key','http://example.test','https://user:pass@example.test','https://example.test?key=x'):
            with self.assertRaises(HTTPException): settings.models_url(url)
        with self.assertRaises(HTTPException): settings.validate_key('test\nOTHER=secret')

    async def test_chinese_model_suggestions(self):
        for model,kind in [('全能图片G2.5-高品质版','image'),('全能视频-极速版','video'),('语音合成模型','audio'),('语言模型','chat'),('unclassified-v2','unknown')]:
            self.assertEqual(settings.suggested_kind(model),kind)


if __name__ == '__main__':
    try: unittest.main()
    finally: runtime.cleanup()
