"""Offline tests for the optional Dreamina CLI adapter. No account calls are made."""
import asyncio
import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix='dw-dreamina-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import httpx
import studio_server
import studio_generation as generation
import studio_dreamina as dreamina
import main as core
from fastapi import HTTPException


class DreaminaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root=Path(runtime.name)/('case-'+next(tempfile._get_candidate_names()))
        self.root.mkdir(parents=True)
        self.exe=self.root/'dreamina.exe';self.exe.write_bytes(b'mock executable')
        self.old_data=core.DATA_DIR
        core.DATA_DIR=str(self.root/'data')
        dreamina._CORE=core;dreamina._AUTH=None;dreamina._STATUS_AT=0;dreamina._ACCOUNT=None;dreamina._CREDIT=None
        dreamina._LOGIN.clear()
        dreamina._write_config({'enabled':True,'cli_path':str(self.exe),'models':{m['id']:True for m in dreamina._MODELS}})
        self.api=httpx.AsyncClient(transport=httpx.ASGITransport(app=studio_server.app),base_url='http://testserver')

    async def asyncTearDown(self):
        await self.api.aclose()
        core.DATA_DIR=self.old_data

    def payload(self,kind='image',model='dreamina-image-5.0',refs=None,**kwargs):
        params=kwargs.pop('params',{})
        return generation.Generation(request_id='request-'+next(tempfile._get_candidate_names()),provider_id=dreamina.PROVIDER,
            model=model,kind=kind,prompt='用电影摄影方式呈现',references=refs or [],params=params,**kwargs)

    def local_ref(self,ext='.png',kind='image'):
        name='input'+ext;path=Path(core.output_path_for(name));path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'fixture')
        return {'url':core.output_url_for(name),'kind':kind}

    def test_model_catalog_and_profile_are_cli_specific(self):
        entries=dreamina.models()
        self.assertTrue(all(row['enabled'] for row in entries))
        self.assertEqual(next(row for row in entries if row['id']=='dreamina-video-seedance-2.5')['versions'],['seedance2.5'])
        self.assertEqual(dreamina.spec('dreamina-image-5.0')['max_images'],10)
        self.assertEqual(dreamina.spec('dreamina-video-seedance-2.0')['max_images'],9)
        self.assertEqual(dreamina.spec('dreamina-video-seedance-2.5')['max_videos'],10)
        self.assertIn('单次任务费用未知',dreamina.spec('dreamina-image-5.0')['note'])
        self.assertIn('不代表本次费用',dreamina.spec('dreamina-image-5.0')['note'])

    def test_checked_selects_supported_modes_and_rejects_remote_refs(self):
        req,version,_=dreamina.checked(self.payload())
        self.assertEqual(version,'5.0');self.assertEqual(req['dreamina_command'],'text2image')
        req,_,_=dreamina.checked(self.payload(refs=[self.local_ref()]))
        self.assertEqual(req['dreamina_command'],'image2image')
        with self.assertRaises(HTTPException):
            dreamina.checked(self.payload(model='dreamina-image-3.1',refs=[self.local_ref()]))
        video_payload=self.payload(kind='video',model='dreamina-video-seedance-2.5',refs=[self.local_ref()]);video_payload.prompt='@图片1 缓慢推近'
        req,_,_=dreamina.checked(video_payload)
        self.assertEqual(req['dreamina_command'],'multimodal2video')
        self.assertIn('@Image 1',req['prompt'])
        req,_,_=dreamina.checked(self.payload(kind='video',model='dreamina-video-seedance-2.5',frame_mode=True,refs=[self.local_ref()]))
        self.assertEqual(req['dreamina_command'],'image2video')
        req,_,_=dreamina.checked(self.payload(kind='video',model='dreamina-video-seedance-1.5-pro',refs=[self.local_ref()]))
        self.assertEqual(req['dreamina_command'],'image2video')
        with self.assertRaises(HTTPException):
            dreamina.checked(self.payload(kind='video',model='dreamina-video-seedance-2.5',refs=[{'url':'https://example.invalid/a.png','kind':'image'}]))

    def test_command_args_keep_model_mode_and_omit_seedance25_reference_ratio(self):
        ref=self.local_ref()
        payload=self.payload(kind='video',model='dreamina-video-seedance-2.5',frame_mode=True,refs=[ref],params={'ratio':'9:16','duration':8,'resolution':'720p'})
        request,model,_=dreamina.checked(payload)
        args=dreamina._generation_args({'request':request},0,str(self.root/'out'))
        self.assertIn('image2video',args[0]);self.assertIn('--model_version=seedance2.5',args)
        self.assertIn('--image='+str(Path(core.output_file_from_url(ref['url'])).resolve()),args)
        self.assertFalse(any(arg.startswith('--download_dir=') for arg in args))
        self.assertFalse(any(arg.startswith('--ratio=') for arg in args))
        self.assertEqual(model,'seedance2.5')

    def test_reference_total_and_conflicting_cli_receipts_are_rejected(self):
        refs=[self.local_ref()]*9+[self.local_ref('.mp4','video')]*3+[self.local_ref('.wav','audio')]
        with self.assertRaises(HTTPException):
            dreamina.checked(self.payload(kind='video',model='dreamina-video-seedance-2.0',refs=refs))
        output='{"submit_id":"first"}\n{"submit_id":"second","gen_status":"success"}'
        self.assertTrue(dreamina._has_conflicting_submit_ids(output))
        self.assertIsNone(dreamina._submit_id(output))
        self.assertEqual(dreamina._submit_id('submit_id: first\n{"submit_id":"first"}'),'first')

    async def test_disabled_status_is_cached_and_does_not_spawn_cli(self):
        cfg=dreamina.config();cfg['enabled']=False;dreamina._write_config(cfg)
        with patch.object(dreamina,'_run_cli') as run:
            result=await self.api.get('/api/studio/dreamina/status')
        self.assertEqual(result.status_code,200)
        self.assertFalse(result.json()['enabled']);self.assertTrue(result.json()['models'])
        run.assert_not_called()

    async def test_login_device_code_stays_server_side_and_checks_account(self):
        outcomes=[SimpleNamespace(returncode=0,stdout=json.dumps({'verification_uri':'https://www.dreamina.com/login','user_code':'ABCD-EFGH','device_code':'private-device'}),stderr=''),
                  SimpleNamespace(returncode=0,stdout='Login success',stderr=''),
                  SimpleNamespace(returncode=0,stdout='{"data":{"user_id":"u-123","username":"artist"}}',stderr='')]
        with patch.object(dreamina,'_run_cli',side_effect=outcomes) as run:
            started=await self.api.post('/api/studio/dreamina/login')
            self.assertEqual(started.status_code,200,started.text)
            body=started.json();self.assertNotIn('device_code',body)
            self.assertEqual(dreamina._LOGIN[body['login_id']]['device_code'],'private-device')
            complete=await self.api.post('/api/studio/dreamina/login-check',json={'login_id':body['login_id'],'poll':1})
        self.assertEqual(complete.status_code,200,complete.text)
        self.assertTrue(complete.json()['authenticated']);self.assertEqual(dreamina._ACCOUNT,'artist')
        self.assertEqual(run.call_args_list[0].args[0],['relogin','--headless'])
        self.assertTrue(any('private-device' in ' '.join(call.args[0]) for call in run.call_args_list))

    async def test_logout_uses_cli_and_clears_cached_identity_and_pending_authorization(self):
        dreamina._AUTH=True;dreamina._ACCOUNT='old-account';dreamina._CREDIT=17;dreamina._STATUS_AT=123
        dreamina._LOGIN['pending']={'device_code':'private','expires_at':9999999999}
        with patch.object(dreamina,'_run_cli',return_value=SimpleNamespace(returncode=0,stdout='Logged out',stderr='')) as run:
            result=await self.api.post('/api/studio/dreamina/logout')
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(run.call_args.args[0],['logout'])
        self.assertFalse(dreamina._AUTH);self.assertIsNone(dreamina._ACCOUNT);self.assertIsNone(dreamina._CREDIT)
        self.assertEqual(dreamina._STATUS_AT,0);self.assertEqual(dreamina._LOGIN,{})

    async def test_logout_is_blocked_while_generation_result_is_unresolved(self):
        unresolved={'id':'waiting-task','status':'paused','request':{'provider_id':dreamina.PROVIDER}}
        with patch.object(dreamina,'_active_jobs',return_value=[unresolved]),patch.object(dreamina,'_run_cli') as run:
            result=await self.api.post('/api/studio/dreamina/logout')
        self.assertEqual(result.status_code,409)
        self.assertIn('未完成或待核实',result.json()['detail'])
        run.assert_not_called()

    async def test_cancelled_authorization_can_immediately_start_fresh_device_flow(self):
        starts=[
            SimpleNamespace(returncode=0,stdout=json.dumps({'verification_uri':'https://www.dreamina.com/login','user_code':'OLD-CODE','device_code':'old-device'}),stderr=''),
            SimpleNamespace(returncode=0,stdout=json.dumps({'verification_uri':'https://www.dreamina.com/login','user_code':'NEW-CODE','device_code':'new-device'}),stderr=''),
        ]
        with patch.object(dreamina,'_run_cli',side_effect=starts) as run:
            first=(await self.api.post('/api/studio/dreamina/login')).json()
            cancelled=await self.api.post('/api/studio/dreamina/login-cancel',json={'login_id':first['login_id']})
            second=await self.api.post('/api/studio/dreamina/login')
        self.assertTrue(cancelled.json()['cancelled'])
        self.assertEqual(second.status_code,200,second.text)
        self.assertNotIn(first['login_id'],dreamina._LOGIN)
        self.assertEqual(list(dreamina._LOGIN.values())[0]['device_code'],'new-device')
        self.assertEqual([call.args[0] for call in run.call_args_list],[['relogin','--headless'],['relogin','--headless']])

    async def test_cancel_during_poll_cannot_apply_late_auth_result(self):
        started=threading.Event();release=threading.Event()
        dreamina._LOGIN['in-flight']={'device_code':'private','expires_at':9999999999}
        calls=[]
        def fake_run(args,timeout=90):
            calls.append(list(args))
            if args[0]=='login':
                started.set();release.wait(3)
                return SimpleNamespace(returncode=0,stdout='{"user_id":"late-user","login_status":"success"}',stderr='')
            if args[0]=='logout': return SimpleNamespace(returncode=0,stdout='Logged out',stderr='')
            raise AssertionError(args)
        with patch.object(dreamina,'_run_cli',side_effect=fake_run):
            pending=asyncio.create_task(self.api.post('/api/studio/dreamina/login-check',json={'login_id':'in-flight','poll':1}))
            self.assertTrue(await asyncio.to_thread(started.wait,2))
            cancelled=await self.api.post('/api/studio/dreamina/login-cancel',json={'login_id':'in-flight'})
            release.set()
            result=await pending
        self.assertTrue(cancelled.json()['cancelled'])
        self.assertEqual(result.status_code,410,result.text)
        self.assertEqual([item[0] for item in calls],['login','logout'])
        self.assertIsNone(dreamina._AUTH);self.assertIsNone(dreamina._ACCOUNT);self.assertIsNone(dreamina._CREDIT)

    async def test_cancel_and_expiry_remove_pending_authorization_state(self):
        dreamina._LOGIN['cancel-me']={'device_code':'private','expires_at':9999999999}
        cancelled=await self.api.post('/api/studio/dreamina/login-cancel',json={'login_id':'cancel-me'})
        self.assertTrue(cancelled.json()['cancelled']);self.assertNotIn('cancel-me',dreamina._LOGIN)
        dreamina._LOGIN['expired']={'device_code':'private','expires_at':0}
        expired=await self.api.post('/api/studio/dreamina/login-check',json={'login_id':'expired','poll':1})
        self.assertEqual(expired.status_code,410);self.assertNotIn('expired',dreamina._LOGIN)

    async def test_submit_query_download_save_and_retry_never_resubmits(self):
        call_log=[];persisted=[];submit_count=0
        def fake_run(args,timeout=90):
            nonlocal submit_count
            args=list(args);call_log.append(args)
            if args[0]=='user_credit':return SimpleNamespace(returncode=0,stdout='{"user_id":"bound-user","credit":22}',stderr='')
            if args[0]=='text2image':
                submit_count+=1
                return SimpleNamespace(returncode=0,stdout='{"submit_id":"task-44","gen_status":"querying"}',stderr='')
            if args[0]=='query_result':
                if any(a.startswith('--download_dir=') for a in args):
                    folder=Path(next(a.split('=',1)[1] for a in args if a.startswith('--download_dir=')))
                    folder.mkdir(parents=True,exist_ok=True);(folder/'generated.png').write_bytes(b'png result')
                return SimpleNamespace(returncode=0,stdout='{"submit_id":"task-44","gen_status":"success"}',stderr='')
            raise AssertionError(args)
        def fail_persist(*args,**kwargs): raise HTTPException(507,'disk full')
        with patch.object(dreamina,'_run_cli',side_effect=fake_run),patch.object(generation,'persist_local_media',side_effect=fail_persist):
            payload=self.payload()
            with patch.object(generation,'start'):
                await generation.submit(payload)
            await dreamina.execute(payload.request_id)
        paused=generation.read(payload.request_id)
        self.assertEqual(paused['status'],'paused');self.assertEqual(paused['children'][0]['upstream_id'],'task-44')
        self.assertIn('不会重新生成',paused['error'])
        with patch.object(dreamina,'_run_cli',side_effect=fake_run),patch.object(generation,'persist_local_media',side_effect=lambda path,*a,**kw:(persisted.append(Path(path)) or {'url':'/api/studio/assets/v/file'})):
            await dreamina.execute(payload.request_id)
        completed=generation.read(payload.request_id)
        self.assertEqual(completed['status'],'succeeded');self.assertEqual(submit_count,1)
        self.assertEqual(len(persisted),1)
        self.assertEqual(completed['children'][0]['outputs'][0]['url'],'/api/studio/assets/v/file')
        self.assertEqual(sum(args[0]=='query_result' for args in call_log),4)

    async def test_account_switch_rejects_query_and_failure_text_is_sanitized(self):
        job={'id':'account-job-12345678','status':'paused','request':{'provider_id':dreamina.PROVIDER},'base_url':'dreamina-cli://local',
             'children':[{'status':'running','upstream_id':'task-1'}],'dreamina_account_binding':hashlib.sha256(b'old-user').hexdigest()}
        generation.save(job)
        with patch.object(dreamina,'_run_cli',return_value=SimpleNamespace(returncode=0,stdout='{"user_id":"new-user"}',stderr='')) as run:
            await dreamina.execute(job['id'])
        self.assertEqual(generation.read(job['id'])['status'],'paused')
        self.assertIn('账号与此任务',generation.read(job['id'])['error'])
        self.assertNotIn('secret',dreamina._failure('{"access_token":"secret"}',{}))
        self.assertNotIn('secret',dreamina._scrub('{"access_token":"secret"}'))

    async def test_unknown_query_state_pauses_instead_of_hot_polling(self):
        job={'id':'unknown-state-job','status':'paused','request':{'provider_id':dreamina.PROVIDER,'kind':'image'},
             'base_url':'dreamina-cli://local','children':[{'status':'running','upstream_id':'task-unknown'}]}
        generation.save(job);calls=[]
        def fake_run(args,timeout=90):
            calls.append(list(args))
            if args[0]=='user_credit': return SimpleNamespace(returncode=0,stdout='{"user_id":"bound-user"}',stderr='')
            return SimpleNamespace(returncode=0,stdout='submit_id: task-unknown\ngen_status: new_state',stderr='')
        with patch.object(dreamina,'_run_cli',side_effect=fake_run): await dreamina.execute(job['id'])
        self.assertEqual(generation.read(job['id'])['status'],'paused')
        self.assertEqual(sum(x[0]=='query_result' for x in calls),1)
        self.assertEqual(dreamina._gen_state('submit_id: abc\ngen_status: success')[0],'success')

    async def test_submit_without_task_id_is_uncertain_not_retryable_failure(self):
        payload=self.payload()
        with patch.object(generation,'start'):
            await generation.submit(payload)
        calls=[]
        def fake_run(args,timeout=90):
            calls.append(list(args))
            if args[0]=='user_credit': return SimpleNamespace(returncode=0,stdout='{"user_id":"bound-user"}',stderr='')
            return SimpleNamespace(returncode=1,stdout='',stderr='connection lost')
        with patch.object(dreamina,'_run_cli',side_effect=fake_run): await dreamina.execute(payload.request_id)
        job=generation.read(payload.request_id)
        self.assertEqual(job['status'],'uncertain')
        self.assertEqual(job['children'][0]['status'],'submitting')
        self.assertEqual(sum(x[0]=='text2image' for x in calls),1)

    async def test_local_result_is_saved_and_registered_through_shared_asset_flow(self):
        source=self.root/'result.png';source.write_bytes(b'local dreamina result')
        saved=generation.persist_local_media(source,'image','save-job-12345678','0')
        self.assertTrue(saved['url'].startswith('/api/studio/assets/'))
        target=Path(core.output_file_from_url(saved['url']))
        self.assertEqual(target.read_bytes(),source.read_bytes())
        self.assertEqual(saved['asset_url'],saved['url'])

    async def test_disabled_model_blocks_a_queued_submit_on_resume(self):
        payload=self.payload()
        with patch.object(generation,'start'):await generation.submit(payload)
        cfg=dreamina.config();cfg['models'][payload.model]=False;dreamina._write_config(cfg)
        with patch.object(dreamina,'_run_cli',return_value=SimpleNamespace(returncode=0,stdout='{"user_id":"bound-user"}',stderr='')) as run:
            await dreamina.execute(payload.request_id)
        self.assertEqual(generation.read(payload.request_id)['status'],'paused')
        self.assertEqual([call.args[0][0] for call in run.call_args_list],['user_credit'])


if __name__=='__main__': unittest.main()
