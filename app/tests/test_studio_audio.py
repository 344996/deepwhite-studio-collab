"""Offline contract tests for documented speech, music and sound adapters."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix='dw-audio-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name

import main as core
import studio_generation as generation
from studio_capabilities import parameters, profile
from fastapi import HTTPException


class AudioContracts(unittest.TestCase):
    def test_profiles_separate_channels_and_only_expose_documented_adapters(self):
        self.assertEqual(profile('qwen3-tts-flash', 'audio')['channel'], 'speech')
        self.assertEqual(profile('mureka-v9-bgm', 'audio')['channel'], 'music')
        self.assertEqual(profile('suno-sounds', 'audio')['channel'], 'sound')
        self.assertFalse(profile('unknown-voice-model', 'audio')['supported'])
        self.assertEqual(parameters('qwen3-tts-flash', 'audio', {'channel':'speech','voice':'calm'})['voice'], 'calm')
        with self.assertRaises(HTTPException):
            parameters('unknown-voice-model', 'audio', {})

    def test_audio_body_routes_speech_and_mureka_to_async_audio_api(self):
        endpoint, body = generation.audio_body('qwen3-tts-instruct-flash', '早上好',
            {'channel':'speech','voice':'warm','instructions':'温柔自然'})
        self.assertEqual(endpoint, '/audio/generations')
        self.assertEqual(body, {'model':'qwen3-tts-instruct-flash','prompt':'早上好',
                                'metadata':{'voice':'warm','instructions':'温柔自然'}})
        endpoint, body = generation.audio_body('mureka-v9-bgm', '悬疑片尾氛围',
            {'channel':'music','n':3,'instrumental_id':'dark'})
        self.assertEqual(endpoint, '/audio/generations')
        self.assertEqual(body['metadata'], {'n':3,'instrumental_id':'dark'})

    def test_suno_music_and_sfx_use_distinct_submission_routes(self):
        endpoint, body = generation.audio_body('suno', 'soft piano',
            {'channel':'music','version':'v5','instrumental':True})
        self.assertEqual(endpoint, '/music/generations')
        self.assertEqual(body, {'model':'suno','prompt':'soft piano','version':'v5','instrumental':True})
        endpoint, body = generation.audio_body('suno-sounds', '远处雷声', {'channel':'sound'})
        self.assertEqual(endpoint, '/music/generations/sounds')
        self.assertEqual(body, {'model':'suno','prompt':'远处雷声'})

    def test_audio_poll_responses_normalize_direct_and_ordered_track_urls(self):
        result = generation.normalize({'data':{'status':'SUCCESS','progress':'100%',
            'result_url':'https://cdn.invalid/first.mp3',
            'data':{'content':{'audio_urls':['https://cdn.invalid/first.mp3','https://cdn.invalid/second.mp3']},
                    'usage':{'amount':0.4,'currency':'CNY'}}}}, 'audio')
        self.assertEqual(result['status'],'succeeded')
        self.assertEqual(result['urls'],['https://cdn.invalid/first.mp3','https://cdn.invalid/second.mp3'])
        self.assertEqual(result['usage'],{'amount':0.4,'currency':'CNY'})
        suno = generation.normalize({'data':{'status':'completed','cost':0.05,
            'result':{'music':[{'audio_url':'https://cdn.invalid/a.mp3'},{'audio_url':'https://cdn.invalid/b.mp3'}]}}}, 'audio')
        self.assertEqual(suno['urls'],['https://cdn.invalid/a.mp3','https://cdn.invalid/b.mp3'])
        self.assertEqual(suno['usage'],{'amount':0.05,'currency':'USD'})

    def test_audio_selection_rejects_channel_mismatch_before_submission(self):
        payload=generation.Generation(request_id='audio-request-001',provider_id='deepwhite',
            model='qwen3-tts-flash',kind='audio',prompt='你好',params={'channel':'music'})
        with patch.object(core,'get_api_provider_exact',return_value={'enabled':True,'base_url':'https://api.deepwhiteai.com'}), \
             patch.object(core,'provider_env_key_value',return_value='test-key'), \
             patch.object(generation.catalog,'resolve_model',return_value='qwen3-tts-flash'):
            with self.assertRaises(HTTPException):generation.checked(payload)

    def test_mureka_accepts_either_prompt_or_instrumental_id_but_not_both(self):
        provider={'enabled':True,'base_url':'https://api.deepwhiteai.com'}
        def payload(prompt,params):return generation.Generation(request_id='mureka-request-001',provider_id='deepwhite',
            model='mureka-v9-bgm',kind='audio',prompt=prompt,params=params)
        with patch.object(core,'get_api_provider_exact',return_value=provider), \
             patch.object(core,'provider_env_key_value',return_value='test-key'), \
             patch.object(generation.catalog,'resolve_model',return_value='mureka-v9-bgm'):
            accepted,_,_=generation.checked(payload('',{'channel':'music','instrumental_id':'ambient-template'}))
            self.assertEqual(generation.audio_body('mureka-v9-bgm',accepted['prompt'],accepted['params'])[1],
                {'model':'mureka-v9-bgm','metadata':{'n':2,'instrumental_id':'ambient-template'}})
            with self.assertRaises(HTTPException):
                generation.checked(payload('music idea',{'channel':'music','instrumental_id':'ambient-template'}))


class AudioRecovery(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.old_data=core.DATA_DIR
        core.DATA_DIR=str(Path(runtime.name)/('jobs-'+next(tempfile._get_candidate_names())))

    async def asyncTearDown(self):
        core.DATA_DIR=self.old_data

    def test_audio_result_is_saved_and_registered_as_project_asset(self):
        root=Path(runtime.name)/'saved-audio';root.mkdir(parents=True,exist_ok=True)
        source=root/'source.wav';source.write_bytes(b'RIFF\x00\x00\x00\x00WAVEaudio-fixture')
        destination=root/'project-output'/'studio-audio-result-001-0-0.wav'
        url='/api/storage-files/generated/studio-audio-result.wav'
        request={'canvas_id':'canvas-1','node_id':'audio-node-1','provider_id':'provider','model':'qwen3-tts-flash','prompt':'你好'}
        with patch.object(core,'output_path_for',return_value=str(destination)), \
             patch.object(core,'output_url_for',return_value=url), \
             patch('studio_asset_integration.register_output',return_value={'url':'/api/studio/assets/asset123/file',
                 'asset_id':'asset123','version_id':'version123'}) as register:
            output=generation.persist_local_media(source,'audio','audio-result-001','0-0',request=request)
        self.assertEqual(destination.read_bytes(),source.read_bytes())
        self.assertEqual(output,{'url':'/api/studio/assets/asset123/file','kind':'audio','name':'studio-audio-result-001-0-0.wav',
            'asset_id':'asset123','version_id':'version123','asset_url':'/api/studio/assets/asset123/file'})
        register.assert_called_once_with(core,url,'studio-audio-result-001-0-0.wav',request,'audio-result-001')

    async def test_existing_audio_task_recovers_by_get_and_persists_result(self):
        class Response:
            status_code=200
            headers={}
            def raise_for_status(self):pass
            def json(self):return {'data':{'status':'SUCCESS','result_url':'https://cdn.invalid/speech.mp3',
                                           'usage':{'amount':0.08,'currency':'CNY'}}}

        class Client:
            def __init__(self):self.gets=[];self.posts=[]
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            async def post(self,*args,**kwargs):self.posts.append((args,kwargs));raise AssertionError('recovery must not resubmit')
            async def get(self,url,**kwargs):self.gets.append(url);return Response()

        client=Client();job_id='audio-recovery-001'
        generation.save({'id':job_id,'status':'running','error':'','resolved_model':'qwen3-tts-flash',
            'base_url':'https://api.deepwhiteai.com','created_at':1,'request':{
                'provider_id':'provider','kind':'audio','prompt':'你好','params':{'channel':'speech','voice':'warm'},
                'references':[],'frame_mode':False},'children':[{'status':'running','upstream_id':'audio-task-1'}]})
        saved={'url':'/api/output/studio-audio.mp3','kind':'audio','name':'studio-audio.mp3'}
        with patch.object(generation,'connection',return_value=('https://api.deepwhiteai.com/v1',{},'https://api.deepwhiteai.com')), \
             patch.object(generation.httpx,'AsyncClient',return_value=client), \
             patch.object(generation,'persist_media',new=AsyncMock(return_value=saved)) as persist:
            await generation.execute(job_id)
        result=generation.read(job_id)
        self.assertEqual(result['status'],'succeeded')
        self.assertEqual(client.gets,['https://api.deepwhiteai.com/v1/audio/generations/audio-task-1'])
        self.assertEqual(client.posts,[])
        self.assertEqual(result['children'][0]['outputs'],[saved])
        persist.assert_awaited_once_with(client,'https://cdn.invalid/speech.mp3','audio',job_id,'0-0')

    async def test_lost_audio_submit_response_is_uncertain_and_never_reposts(self):
        class Client:
            def __init__(self):self.posts=[]
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            async def post(self,url,**kwargs):
                self.posts.append((url,kwargs['json']))
                raise generation.httpx.ReadTimeout('response lost after accepted request')
            async def get(self,*args,**kwargs):raise AssertionError('uncertain submit cannot be polled without an upstream id')

        job_id='audio-submit-lost-001';client=Client()
        generation.save({'id':job_id,'status':'queued','error':'','resolved_model':'qwen3-tts-flash',
            'base_url':'https://api.deepwhiteai.com','created_at':1,'request':{
                'provider_id':'provider','kind':'audio','prompt':'你好','params':{'channel':'speech','voice':'warm'},
                'references':[],'frame_mode':False},'children':[{'status':'queued'}]})
        with patch.object(generation,'connection',return_value=('https://api.deepwhiteai.com/v1',{},'https://api.deepwhiteai.com')), \
             patch.object(generation.httpx,'AsyncClient',return_value=client):
            await generation.execute(job_id)
            self.assertEqual(generation.read(job_id)['status'],'uncertain')
            await generation.execute(job_id)
        result=generation.read(job_id)
        self.assertEqual(result['status'],'uncertain')
        self.assertEqual(result['children'][0]['status'],'submitting')
        self.assertEqual(client.posts,[('https://api.deepwhiteai.com/v1/audio/generations',
            {'model':'qwen3-tts-flash','prompt':'你好','metadata':{'voice':'warm'}})])

    async def test_suno_sound_query_uses_music_task_route(self):
        class Response:
            status_code=200
            headers={}
            def __init__(self,payload):self.payload=payload
            def raise_for_status(self):pass
            def json(self):return self.payload

        class Client:
            def __init__(self):self.posts=[];self.gets=[]
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            async def post(self,url,**kwargs):
                self.posts.append((url,kwargs['json']))
                return Response({'data':{'task_id':'sfx-task-1','status':'submitted'}})
            async def get(self,url,**kwargs):
                self.gets.append(url)
                return Response({'data':{'status':'completed','result':{'audio_url':'https://cdn.invalid/thunder.wav'}}})

        client=Client();job_id='suno-sound-route-001'
        generation.save({'id':job_id,'status':'queued','error':'','resolved_model':'suno-sounds',
            'base_url':'https://api.deepwhiteai.com','created_at':1,'request':{
                'provider_id':'provider','kind':'audio','prompt':'远处的雷声逐渐靠近','params':{'channel':'sound'},
                'references':[],'frame_mode':False},'children':[{'status':'queued'}]})
        saved={'url':'/api/output/thunder.wav','kind':'audio','name':'thunder.wav'}
        with patch.object(generation,'connection',return_value=('https://api.deepwhiteai.com/v1',{},'https://api.deepwhiteai.com')), \
             patch.object(generation.httpx,'AsyncClient',return_value=client), \
             patch.object(generation,'persist_media',new=AsyncMock(return_value=saved)):
            await generation.execute(job_id)
        result=generation.read(job_id)
        self.assertEqual(result['status'],'succeeded')
        self.assertEqual(client.posts,[('https://api.deepwhiteai.com/v1/music/generations/sounds',
            {'model':'suno','prompt':'远处的雷声逐渐靠近'})])
        self.assertEqual(client.gets,['https://api.deepwhiteai.com/v1/music/tasks/sfx-task-1'])
        self.assertEqual(result['children'][0]['outputs'],[saved])

    async def test_suno_array_submit_response_polls_music_task_and_saves_tracks(self):
        class Response:
            status_code=200
            headers={}
            def __init__(self,payload):self.payload=payload
            def raise_for_status(self):pass
            def json(self):return self.payload

        class Client:
            def __init__(self):self.gets=[];self.posts=[]
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            async def post(self,url,**kwargs):
                self.posts.append((url,kwargs['json']))
                return Response({'data':[{'task_id':'suno-task-1','status':'submitted'}]})
            async def get(self,url,**kwargs):
                self.gets.append(url)
                return Response({'data':{'status':'completed','cost':0.05,'result':{'music':[
                    {'audio_url':'https://cdn.invalid/track-1.mp3'},{'audio_url':'https://cdn.invalid/track-2.mp3'}]}}})

        client=Client();job_id='suno-audio-submit-001'
        generation.save({'id':job_id,'status':'queued','error':'','resolved_model':'suno',
            'base_url':'https://api.deepwhiteai.com','created_at':1,'request':{
                'provider_id':'provider','kind':'audio','prompt':'柔和钢琴','params':{
                    'channel':'music','version':'v5','custom':False,'instrumental':True},
                'references':[],'frame_mode':False},'children':[{'status':'queued'}]})
        saved={'url':'/api/output/track.mp3','kind':'audio','name':'track.mp3'}
        with patch.object(generation,'connection',return_value=('https://api.deepwhiteai.com/v1',{},'https://api.deepwhiteai.com')), \
             patch.object(generation.httpx,'AsyncClient',return_value=client), \
             patch.object(generation,'persist_media',new=AsyncMock(side_effect=[saved,dict(saved,name='track-2.mp3')])):
            await generation.execute(job_id)
        result=generation.read(job_id)
        self.assertEqual(result['status'],'succeeded')
        self.assertEqual(client.posts,[('https://api.deepwhiteai.com/v1/music/generations',{
            'model':'suno','prompt':'柔和钢琴','version':'v5','custom':False,'instrumental':True})])
        self.assertEqual(client.gets,['https://api.deepwhiteai.com/v1/music/tasks/suno-task-1'])
        self.assertEqual(len(result['children'][0]['outputs']),2)


if __name__ == '__main__':
    unittest.main()
