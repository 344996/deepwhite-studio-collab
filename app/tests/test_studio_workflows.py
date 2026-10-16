"""Offline ComfyUI workflow conversion, parameter and durable task tests."""
import os
import json
import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = tempfile.mkdtemp(prefix='dw-comfy-workflows-')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import studio_workflows as workflows
import main as core
from fastapi import HTTPException, FastAPI


class WorkflowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='workflow-case-')
        self.old_data=core.DATA_DIR
        core.DATA_DIR=self.temp.name

    def tearDown(self):
        core.DATA_DIR=self.old_data
        self.temp.cleanup()

    def test_api_prompt_is_preserved(self):
        source={'4':{'class_type':'SaveImage','inputs':{'filename_prefix':'dw','images':['2',0]}},'2':{'class_type':'EmptyLatentImage','inputs':{'width':512}}}
        self.assertEqual(workflows._normalize_prompt(source),source)

    def test_saved_video_nodes_remain_selectable_with_generic_output_socket(self):
        prompt={'7':{'class_type':'VHS_VideoCombine','inputs':{'images':['2',0]}}}
        info={'VHS_VideoCombine':{'input':{'required':{'images':['IMAGE']}},'output':['STRING'],'output_names':['filename']}}
        self.assertEqual(workflows._outputs(prompt,info),[{'node_id':'7','slot':0,'type':'video','name':'VHS_VideoCombine'}])

    def test_regular_comfy_graph_becomes_api_prompt(self):
        info={'Text':{'input':{'required':{'text':['STRING',{'widget':{'name':'text'}}]}}},
              'SaveImage':{'input':{'required':{'images':['IMAGE'],'filename_prefix':['STRING',{'widget':{'name':'filename_prefix'}}]}}}}
        graph={'nodes':[{'id':1,'type':'Text','inputs':[],'widgets_values':['hello'],'outputs':[{'links':[1]}]},
                        {'id':2,'type':'SaveImage','inputs':[{'name':'images','link':1}],'widgets_values':['result'],'outputs':[]}],
               'links':[[1,1,0,2,0,'IMAGE']]}
        prompt=workflows._convert_ui(graph,info)
        self.assertEqual(prompt['1']['inputs']['text'],'hello')
        self.assertEqual(prompt['2']['inputs']['filename_prefix'],'result')
        self.assertEqual(prompt['2']['inputs']['images'],['1',0])

    def test_binding_validation_rejects_bad_target_and_typed_values(self):
        prompt={'1':{'class_type':'KSampler','inputs':{'seed':5,'cfg':1.0,'enabled':True,'mode':'fast'}}}
        with self.assertRaises(HTTPException):workflows._validate_bindings(prompt,[{'node_id':'9','input':'seed','type':'seed'}])
        fields=workflows._validate_bindings(prompt,[
            {'node_id':'1','input':'seed','type':'seed'},
            {'node_id':'1','input':'cfg','type':'number','min':0,'max':20},
            {'node_id':'1','input':'enabled','type':'bool'},
            {'node_id':'1','input':'mode','type':'enum','values':['fast','slow']}])
        with self.assertRaises(HTTPException):workflows._validate_value(fields[0],5.5)
        with self.assertRaises(HTTPException):workflows._validate_value(fields[1],21)
        with self.assertRaises(HTTPException):workflows._validate_value(fields[2],'true')
        with self.assertRaises(HTTPException):workflows._validate_value(fields[3],'other')

    def test_wire_preserves_safe_values_and_does_not_mutate_persisted_graph(self):
        big=18446744073709551615
        source={'seed':big,'negative':-big,'zero':0,'safe':9007199254740991,'enabled':False,'text':'123','enum':[0,False,'123',big]}
        wire=workflows._wire(source)
        self.assertEqual(wire['seed'],str(big));self.assertEqual(wire['negative'],str(-big))
        self.assertEqual(wire['enum'],[0,False,'123',str(big)])
        self.assertEqual(wire['safe'],9007199254740991);self.assertIs(wire['enabled'],False)
        self.assertEqual(source['seed'],big);self.assertIsInstance(source['seed'],int)
        path=Path(self.temp.name)/'precision.json';workflows._write(path,source)
        self.assertEqual(workflows._read(path),source)

    def test_seed_integer_validation_rejects_lossy_and_nonfinite_values(self):
        field={'type':'seed','label':'随机种子','required':True}
        for value in (0,'0',18446744073709551615,'18446744073709551615',5.0):
            with self.subTest(value=value):self.assertEqual(workflows._validate_value(field,value),int(value))
        for value in (True,'1.5','1e20',' 1','+1','not a seed',5.5,float(9007199254740992),float('nan'),float('inf'),float('-inf')):
            with self.subTest(value=value),self.assertRaises(HTTPException) as caught:workflows._validate_value(field,value)
            self.assertEqual(caught.exception.status_code,400)

    def test_schema_restores_only_integer_sockets_and_numeric_enum_options(self):
        big=18446744073709551615
        info={'Sampler':{'input':{'required':{'seed':['INT',{'min':0,'max':big}],'text':['STRING'],'model':[['123','456']],'mode':[['1',1]],'choice':[[big]],'enabled':['BOOL']}}}}
        prompt={'1':{'class_type':'Sampler','inputs':{'seed':str(big),'text':'123','model':'123','mode':'1','choice':str(big),'enabled':False}}}
        workflows._restore_integer_inputs(prompt,info)
        self.assertEqual(prompt['1']['inputs'],{'seed':big,'text':'123','model':'123','mode':'1','choice':big,'enabled':False})
        workflows._validate_graph(prompt,info)
        prompt['1']['inputs']['seed']=str(big+1)
        with self.assertRaises(HTTPException):workflows._restore_integer_inputs(prompt,info)

    def test_binding_integer_defaults_and_bounds_use_exact_schema(self):
        big=18446744073709551615
        prompt={'1':{'class_type':'Sampler','inputs':{'seed':0,'count':0,'text':'123'}}}
        info={'Sampler':{'input':{'required':{'seed':['INT',{'min':0,'max':big}],'count':['INTEGER',{'min':0,'max':big}],'text':['STRING']}}}}
        fields=workflows._validate_bindings(prompt,[{'id':'seed','node_id':'1','input':'seed','type':'seed','default':str(big),'min':'0','max':str(big),'step':'1'},
            {'id':'count','node_id':'1','input':'count','type':'number','default':str(big)},
            {'id':'text','node_id':'1','input':'text','type':'text','default':'123'}],info)
        self.assertEqual(fields[0]['default'],big);self.assertEqual(fields[0]['max'],big)
        self.assertEqual(fields[1]['default'],big);self.assertEqual(fields[2]['default'],'123')
        for changes in ({'default':str(big+1)},{'min':'2','max':'1'},{'step':'0'},{'max':float('inf')}):
            raw={'node_id':'1','input':'seed','type':'seed','default':'0',**changes}
            with self.subTest(changes=changes),self.assertRaises(HTTPException):workflows._validate_bindings(prompt,[raw],info)

    def precision_fixture(self, enum_choices=None):
        big=18446744073709551615
        info={'Sampler':{'input':{'required':{'seed':['INT',{'min':0,'max':big,'step':1}],'text':['STRING'],'enabled':['BOOL'],'mode':[['123','456']]}},'output':['IMAGE']}}
        if enum_choices is not None:info['Sampler']['input']['required']['mode']=[enum_choices]
        graph={'1':{'class_type':'Sampler','inputs':{'seed':big,'text':'123','enabled':False,'mode':'123'}}}
        bindings=[{'id':'seed','node_id':'1','input':'seed','type':'seed','default':str(big)},
            {'id':'text','node_id':'1','input':'text','type':'text','default':'123'},
            {'id':'enabled','node_id':'1','input':'enabled','type':'bool','default':False},
            {'id':'mode','node_id':'1','input':'mode','type':'enum','values':['123','456'],'default':'123'}]
        requests=[]
        def upstream(request):
            requests.append(request)
            if request.method=='GET' and request.url.path=='/object_info':return httpx.Response(200,json=info)
            if request.method=='POST' and request.url.path=='/prompt':return httpx.Response(200,json={'prompt_id':'remote-exact'})
            raise AssertionError('Unexpected upstream request '+str(request.url))
        app=FastAPI();workflows.install(app)
        real_client=httpx.AsyncClient
        browser=real_client(transport=httpx.ASGITransport(app=app),base_url='http://test')
        def client_factory(*args,**kwargs):return real_client(*args,transport=httpx.MockTransport(upstream),**kwargs)
        return big,graph,bindings,requests,browser,client_factory

    async def test_http_raw_integer_import_wire_update_and_remote_submission_are_exact(self):
        big,graph,bindings,requests,browser,factory=self.precision_fixture()
        with patch.object(workflows.httpx,'AsyncClient',factory),patch.object(workflows.engine,'ensure',AsyncMock()),patch.object(workflows.engine,'base_url',return_value='http://upstream'):
            async with browser:
                raw=json.dumps({'workflow':graph,'bindings':bindings}).encode()
                response=await browser.post('/api/studio/comfy/workflows/import',content=raw,headers={'Content-Type':'application/json'})
                self.assertEqual(response.status_code,200,response.text)
                wf=response.json();wid=wf['id'];version=wf['versions'][0]
                self.assertEqual(version['prompt']['1']['inputs']['seed'],str(big))
                self.assertEqual(version['bindings'][0]['default'],str(big))
                self.assertEqual(workflows._load(wid)['versions'][0]['prompt']['1']['inputs']['seed'],big)
                self.assertEqual((await browser.get('/api/studio/comfy/workflows/'+wid)).json()['versions'][0]['prompt']['1']['inputs']['seed'],str(big))
                self.assertEqual((await browser.get('/api/studio/comfy/workflows')).json()['items'][0]['fields'][0]['default'],str(big))
                self.assertEqual((await browser.get('/api/studio/comfy/object-info')).json()['Sampler']['input']['required']['seed'][1]['max'],str(big))
                changed=await browser.put('/api/studio/comfy/workflows/'+wid,json={'expected_revision':1,'prompt':version['prompt'],'bindings':version['bindings']})
                self.assertEqual(changed.status_code,200,changed.text);self.assertEqual(changed.json()['versions'][-1]['revision'],2)
                payload={'revision':2,'request_id':'request_exact_seed','canvas_id':'canvas-1','node_id':'node-1','values':{'seed':str(big)}}
                submitted=await browser.post('/api/studio/comfy/workflows/'+wid+'/submit',json=payload)
                self.assertEqual(submitted.status_code,200,submitted.text)
                task=submitted.json();self.assertEqual(task['values']['seed'],str(big))
                remote=[r for r in requests if r.method=='POST'];self.assertEqual(len(remote),1)
                remote_graph=json.loads(remote[0].content)['prompt']['1']['inputs']
                self.assertEqual(remote_graph,{'seed':big,'text':'123','enabled':False,'mode':'123'})
                self.assertIsInstance(remote_graph['seed'],int);self.assertIs(remote_graph['enabled'],False)
                replay=await browser.post('/api/studio/comfy/workflows/'+wid+'/submit',json=payload)
                self.assertEqual(replay.json()['id'],task['id']);self.assertEqual(len([r for r in requests if r.method=='POST']),1)
                for value in (str(big-1),big):
                    conflict=await browser.post('/api/studio/comfy/workflows/'+wid+'/submit',json={**payload,'values':{'seed':value}})
                    self.assertEqual(conflict.status_code,409,conflict.text)
                requests.clear()
                found=await browser.get('/api/studio/comfy/tasks/by-request/request_exact_seed')
                self.assertEqual(found.json()['id'],task['id']);self.assertEqual(found.json()['request_id'],payload['request_id'])
                self.assertEqual(found.json()['values']['seed'],str(big));self.assertEqual(requests,[])
                self.assertEqual((await browser.get('/api/studio/comfy/tasks/by-request/unknown_request')).status_code,404)
                self.assertEqual((await browser.get('/api/studio/comfy/tasks/by-request/bad!')).status_code,400)
                self.assertEqual(requests,[])

    async def test_preview_ui_string_seed_is_exact_nonpersistent_and_saves_on_explicit_import(self):
        big,graph,bindings,requests,browser,factory=self.precision_fixture()
        ui={'nodes':[{'id':1,'type':'Sampler','inputs':[],'widgets_values':[str(big),'123',False,'123']}],'links':[]}
        with patch.object(workflows.httpx,'AsyncClient',factory),patch.object(workflows.engine,'ensure',AsyncMock()),patch.object(workflows.engine,'base_url',return_value='http://upstream'):
            async with browser:
                preview=await browser.post('/api/studio/comfy/workflows/preview',json={'workflow':ui,'bindings':bindings,'name':'草稿'})
                self.assertEqual(preview.status_code,200,preview.text)
                draft=preview.json();self.assertTrue(draft['draft']);self.assertNotIn('id',draft)
                self.assertEqual(draft['versions'][0]['prompt']['1']['inputs']['seed'],str(big))
                self.assertEqual(list(Path(self.temp.name).rglob('*.json')),[])
                self.assertEqual([r for r in requests if r.method=='POST'],[])
                saved=await browser.post('/api/studio/comfy/workflows/import',json={'workflow':draft['versions'][0]['prompt'],'bindings':draft['versions'][0]['bindings'],'name':draft['name']})
                self.assertEqual(saved.status_code,200,saved.text)
                self.assertEqual(workflows._load(saved.json()['id'])['versions'][0]['prompt']['1']['inputs']['seed'],big)
                self.assertEqual(len(list(workflows._dir('workflows').glob('*.json'))),1)
                self.assertEqual([r for r in requests if r.method=='POST'],[])

    async def test_default_and_zero_seeds_reach_prompt_as_exact_integers(self):
        big,graph,bindings,requests,browser,factory=self.precision_fixture()
        with patch.object(workflows.httpx,'AsyncClient',factory),patch.object(workflows.engine,'ensure',AsyncMock()),patch.object(workflows.engine,'base_url',return_value='http://upstream'):
            async with browser:
                saved=await browser.post('/api/studio/comfy/workflows/import',json={'workflow':graph,'bindings':bindings})
                wid=saved.json()['id']
                for index,values in enumerate(({}, {'seed':0}, {'seed':'0'})):
                    response=await browser.post('/api/studio/comfy/workflows/'+wid+'/submit',json={'request_id':'seed_default_zero_'+str(index),'values':values})
                    self.assertEqual(response.status_code,200,response.text)
                    expected=big if index==0 else 0
                    self.assertEqual(response.json()['values']['seed'],str(big) if index==0 else 0)
                    remote=json.loads([r for r in requests if r.method=='POST'][-1].content)['prompt']['1']['inputs']
                    self.assertEqual(remote['seed'],expected);self.assertIsInstance(remote['seed'],int)
                    self.assertIs(remote['enabled'],False);self.assertEqual(remote['mode'],'123')
                self.assertEqual(len([r for r in requests if r.method=='POST']),3)

    async def test_invalid_integer_import_and_submit_never_dispatch(self):
        big,graph,bindings,requests,browser,factory=self.precision_fixture()
        with patch.object(workflows.httpx,'AsyncClient',factory),patch.object(workflows.engine,'ensure',AsyncMock()),patch.object(workflows.engine,'base_url',return_value='http://upstream'):
            async with browser:
                wf=(await browser.post('/api/studio/comfy/workflows/import',json={'workflow':graph,'bindings':bindings})).json()
                for value in ('1.2','1e3',True,str(big+1),float(9007199254740992),float('nan'),float('inf')):
                    with self.subTest(value=value):
                        payload={'workflow':{'1':{'class_type':'Sampler','inputs':{**graph['1']['inputs'],'seed':value}}},'bindings':bindings}
                        preview=await browser.post('/api/studio/comfy/workflows/preview',content=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
                        self.assertEqual(preview.status_code,400,preview.text)
                        submitted=await browser.post('/api/studio/comfy/workflows/'+wf['id']+'/submit',content=json.dumps({'request_id':'invalid_seed_request','values':{'seed':value}}).encode(),headers={'Content-Type':'application/json'})
                        self.assertEqual(submitted.status_code,400,submitted.text)
                self.assertEqual([r for r in requests if r.method=='POST'],[])
                self.assertEqual(list(workflows._dir('tasks').glob('*.json')),[])

    async def test_by_request_rejects_inconsistent_local_identity_without_remote_calls(self):
        big,graph,bindings,requests,browser,factory=self.precision_fixture()
        workflows._write(workflows._dir('requests')/'request_identity.json',{'task_id':'task-identity'})
        workflows._write(workflows._dir('tasks')/'task-identity.json',{'request_id':'another_request'})
        with patch.object(workflows.httpx,'AsyncClient',factory):
            async with browser:
                response=await browser.get('/api/studio/comfy/tasks/by-request/request_identity')
        self.assertEqual(response.status_code,409);self.assertEqual(requests,[])

    async def test_numeric_enum_wire_is_restored_but_ambiguous_choices_are_rejected(self):
        big=18446744073709551615
        for choices,valid in (([big],True),(['123','456'],True),([big,str(big)],False)):
            with self.subTest(choices=choices):
                big,graph,bindings,requests,browser,factory=self.precision_fixture(choices)
                graph['1']['inputs']['mode']=str(big) if choices[0]==big else '123'
                bindings[-1]['values']=workflows._wire(choices);bindings[-1]['default']=graph['1']['inputs']['mode']
                with patch.object(workflows.httpx,'AsyncClient',factory),patch.object(workflows.engine,'ensure',AsyncMock()),patch.object(workflows.engine,'base_url',return_value='http://upstream'):
                    async with browser:
                        response=await browser.post('/api/studio/comfy/workflows/import',json={'workflow':graph,'bindings':bindings})
                        metadata=await browser.get('/api/studio/comfy/object-info')
                        if not valid:
                            self.assertEqual(response.status_code,400,response.text);self.assertIn('无法无损区分',response.text)
                            self.assertEqual(metadata.status_code,400);self.assertEqual([r for r in requests if r.method=='POST'],[])
                            continue
                        self.assertEqual(response.status_code,200,response.text);wf=response.json()
                        submitted=await browser.post('/api/studio/comfy/workflows/'+wf['id']+'/submit',json={'request_id':'enum_precision_'+str(choices[0]),'values':{'mode':graph['1']['inputs']['mode']}})
                        self.assertEqual(submitted.status_code,200,submitted.text)
                        remote=json.loads([r for r in requests if r.method=='POST'][-1].content)['prompt']['1']['inputs']['mode']
                        if choices[0]==big:self.assertEqual(remote,big);self.assertIsInstance(remote,int)
                        else:self.assertEqual(remote,'123');self.assertIsInstance(remote,str)

    def test_declared_seed_step_is_checked_with_integer_arithmetic(self):
        field={'type':'seed','label':'随机种子','min':9007199254740993,'max':9007199254741013,'step':2}
        self.assertEqual(workflows._validate_value(field,'9007199254740995'),9007199254740995)
        with self.assertRaises(HTTPException):workflows._validate_value(field,'9007199254740994')

    def test_boolean_enum_does_not_accept_zero_as_false(self):
        field={'type':'enum','label':'模式','values':[False]}
        self.assertIs(workflows._validate_value(field,False),False)
        with self.assertRaises(HTTPException):workflows._validate_value(field,0)
        field['values']=[0]
        self.assertEqual(workflows._validate_value(field,0),0)
        with self.assertRaises(HTTPException):workflows._validate_value(field,False)

    async def test_corrupt_library_is_visible_and_original_bytes_are_kept(self):
        path=workflows._dir('workflows')/'broken-record.json';path.write_text('{broken',encoding='utf-8')
        app=FastAPI();workflows.install(app)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
            response=await client.get('/api/studio/comfy/workflows')
            self.assertEqual(response.status_code,503)
            response=await client.get('/api/studio/comfy/workflows/broken-record')
            self.assertEqual(response.status_code,503)
        self.assertEqual(path.read_text(encoding='utf-8'),'{broken')

    async def test_preview_rejects_missing_link_and_unavailable_model_without_save(self):
        info={'Loader':{'input':{'required':{'model':[['installed.safetensors']]}},'output':['IMAGE']},
              'SaveImage':{'input':{'required':{'images':['IMAGE']}},'output':[]}}
        graphs=[{'1':{'class_type':'Loader','inputs':{'model':'missing.safetensors'}}},
                {'1':{'class_type':'SaveImage','inputs':{'images':['99',0]}}}]
        with patch.object(workflows,'_info',AsyncMock(return_value=info)):
            for graph in graphs:
                with self.assertRaises(HTTPException):await workflows._import_draft({'workflow':graph})
        self.assertEqual(list(Path(self.temp.name).rglob('*.json')),[])

    async def test_workflow_capabilities_are_read_only_without_engine_or_upstream(self):
        big,graph,bindings,requests,browser,factory=self.precision_fixture()
        with patch.object(workflows.httpx,'AsyncClient',factory),patch.object(workflows.engine,'ensure',AsyncMock()) as ensure:
            async with browser:
                response=await browser.get('/api/studio/comfy/workflow-capabilities')
        self.assertEqual(response.json(),{'schema':1,'preview':True,'integer_wire':'decimal-string','request_lookup':True})
        self.assertEqual(requests,[]);ensure.assert_not_awaited();self.assertEqual(list(Path(self.temp.name).rglob('*.json')),[])

    async def test_concurrent_updates_commit_only_one_revision_and_keep_original(self):
        big,graph,bindings,requests,browser,factory=self.precision_fixture()
        info={'Sampler':{'input':{'required':{'seed':['INT',{'min':0,'max':big}],'text':['STRING'],'enabled':['BOOL'],'mode':[['123','456']]}},'output':['IMAGE']}}
        entered=0;both_entered=asyncio.Event()
        async def delayed_info(*args):
            nonlocal entered
            entered+=1
            if entered==2:both_entered.set()
            await asyncio.wait_for(both_entered.wait(),2)
            return info
        with patch.object(workflows.httpx,'AsyncClient',factory),patch.object(workflows.engine,'base_url',return_value='http://upstream'):
            async with browser:
                saved=(await browser.post('/api/studio/comfy/workflows/import',json={'workflow':graph,'bindings':bindings})).json()
                with patch.object(workflows,'_info',side_effect=delayed_info):
                    responses=await asyncio.gather(*(browser.put('/api/studio/comfy/workflows/'+saved['id'],json={'expected_revision':1,'name':name}) for name in ('First','Second')))
        self.assertEqual(sorted(r.status_code for r in responses),[200,409])
        persisted=workflows._load(saved['id'])
        self.assertEqual([v['revision'] for v in persisted['versions']],[1,2])
        self.assertEqual(persisted['versions'][0]['prompt'],graph)
        self.assertEqual(persisted['name'],next(r.json()['name'] for r in responses if r.status_code==200))
        self.assertEqual([r for r in requests if r.method=='POST'],[])

    async def test_submit_timeout_is_saved_uncertain_and_not_repolled_as_submission(self):
        wf={'id':'workflow-12345678','versions':[{'revision':1,'prompt':{'1':{'class_type':'SaveImage','inputs':{}}},'bindings':[],'outputs':[]}]}
        client=AsyncMock()
        client.__aenter__.return_value=client
        client.post.side_effect=httpx.ConnectError('lost response',request=None)
        with patch.object(workflows.engine,'ensure',AsyncMock()),patch.object(workflows,'_info',AsyncMock(return_value={'SaveImage':{'input':{'required':{}}}})),patch.object(workflows.httpx,'AsyncClient',return_value=client):
            with self.assertRaises(HTTPException) as caught:await workflows._submit_version(wf,1,{},'request_123456')
            replay=await workflows._submit_version(wf,1,{},'request_123456')
        self.assertEqual(caught.exception.status_code,502)
        task=next(workflows._dir('tasks').glob('*.json'))
        record=workflows._read(task)
        self.assertEqual(record['status'],'uncertain')
        self.assertEqual(replay['id'],record['id'])
        client.post.assert_called_once()
        with patch.object(workflows.httpx,'AsyncClient') as no_request:
            self.assertEqual((await workflows._refresh_task(record))['status'],'uncertain')
            no_request.assert_not_called()

    async def test_successful_submit_pins_revision_and_prompt_id(self):
        wf={'id':'workflow-12345678','versions':[{'revision':3,'prompt':{'1':{'class_type':'SaveImage','inputs':{}}},'bindings':[],'outputs':[]}]}
        client=AsyncMock()
        client.__aenter__.return_value=client
        response=Mock();response.status_code=200;response.json.return_value={'prompt_id':'upstream-1'}
        client.post.return_value=response
        with patch.object(workflows.engine,'ensure',AsyncMock()),patch.object(workflows,'_info',AsyncMock(return_value={'SaveImage':{'input':{'required':{}}}})),patch.object(workflows.httpx,'AsyncClient',return_value=client):
            task=await workflows._submit_version(wf,3,{},'request_123456')
            replay=await workflows._submit_version(wf,3,{},'request_123456')
        self.assertEqual(task['status'],'running')
        self.assertEqual(task['revision'],3)
        self.assertEqual(task['prompt_id'],'upstream-1')
        self.assertEqual(replay['id'],task['id'])
        client.post.assert_called_once()

    async def test_task_keeps_submit_address_and_retries_failed_output_archive(self):
        task={'id':'task-12345678','prompt_id':'upstream','base_url':'http://127.0.0.1:9191','status':'running','outputs_selected':[{'node_id':'7','type':'image'},{'node_id':'7','type':'video'}],'outputs':[]}
        workflows._write(workflows._dir('tasks')/(task['id']+'.json'),task)
        response=Mock();response.raise_for_status.return_value=None
        response.json.return_value={'upstream':{'status':{'completed':True},'outputs':{'7':{'images':[{'filename':'out.png','type':'output'}],'gifs':[{'filename':'out.mp4','type':'output'}]}}}}
        client=AsyncMock();client.__aenter__.return_value=client;client.get.return_value=response
        saved={'url':'/api/studio/assets/a/file','kind':'image','name':'out.png'}
        archive=AsyncMock(side_effect=[OSError('disk busy'),saved,{'url':'/api/studio/assets/b/file','kind':'video','name':'out.mp4'}])
        with patch.object(workflows.httpx,'AsyncClient',return_value=client),patch.object(workflows,'_persist_media',archive):
            first=await workflows._refresh_task(task)
            self.assertEqual(first['status'],'saving')
            self.assertEqual(len(first['expected_outputs']),2)
            second=await workflows._refresh_task(first)
        self.assertEqual(second['status'],'succeeded')
        self.assertEqual(second['outputs'][0]['url'],saved['url'])
        self.assertEqual(client.get.await_args_list[0].args[0],'http://127.0.0.1:9191/history/upstream')
        self.assertEqual(archive.await_count,3)
        self.assertEqual({item['kind'] for item in second['outputs']},{'image','video'})

    async def test_empty_output_selection_archives_no_media(self):
        task={'id':'task-no-output','prompt_id':'upstream','base_url':'http://127.0.0.1:9191','status':'running','outputs_selected':[],'outputs':[]}
        response=Mock();response.raise_for_status.return_value=None
        response.json.return_value={'upstream':{'status':{'completed':True},'outputs':{'7':{'images':[{'filename':'out.png','type':'output'}]}}}}
        client=AsyncMock();client.__aenter__.return_value=client;client.get.return_value=response
        with patch.object(workflows.httpx,'AsyncClient',return_value=client),patch.object(workflows,'_persist_media',AsyncMock()) as archive:
            result=await workflows._refresh_task(task)
        self.assertEqual(result['status'],'succeeded')
        self.assertEqual(result['expected_outputs'],[])
        archive.assert_not_awaited()


if __name__=='__main__':unittest.main()
