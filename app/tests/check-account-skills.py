import os,sys,tempfile,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=tempfile.mkdtemp(prefix='dw-account-test-')
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from unittest.mock import patch
import httpx
import studio_account as account,studio_skills as skills,studio_pricing as pricing,studio_generation as generation

calls=[]
def upstream(req):
    calls.append(req.url.path)
    if req.url.path=='/api/user/login':
        assert json.loads(req.content)['password']=='test-only'
        return httpx.Response(200,json={'success':True,'data':{'require_2fa':True}},headers={'set-cookie':'session=private-test; Path=/'})
    if req.url.path=='/api/user/login/2fa':
        assert req.headers.get('cookie')=='session=private-test'
        return httpx.Response(200,json={'success':True,'data':{'id':42,'status':1}})
    if req.url.path=='/api/user/self':
        assert req.headers['New-Api-User']=='42'
        return httpx.Response(200,json={'success':True,'data':{'id':42,'username':'Test','quota':1000000}})
    if req.url.path=='/api/status':
        return httpx.Response(200,json={'success':True,'data':{'quota_per_unit':500000,'quota_display_type':'CNY','usd_exchange_rate':7}})
    return httpx.Response(200,json={'success':True})

account.TRANSPORT=httpx.MockTransport(upstream)
app=FastAPI();account.install(app);skills.install(app)
with TestClient(app) as c:
    assert c.get('/api/studio/account').status_code==401
    r=c.post('/api/studio/account/login',json={'username':'test','password':'test-only'})
    assert r.json()['two_factor'];assert 'HttpOnly' in r.headers['set-cookie']
    assert c.get('/api/studio/account').status_code==401
    assert c.post('/api/studio/account/verify',json={'code':'123456'}).status_code==200
    data=c.get('/api/studio/account').json();assert data['balance']==14 and 'cookies' not in data
    assert c.post('/api/studio/account/logout').status_code==200
    assert c.get('/api/studio/account').status_code==401
    files={'SKILL.md':'按用户需求列出人物和场景。','references/rules.md':'保持角色服装连续。','agent-skill.json':json.dumps({'instructionReferences':['references/rules.md']})}
    r=c.post('/api/studio/skills',json={'name':'资产测试','files':files});assert r.status_code==200,r.text
    sid=r.json()['id'];assert '服装' in skills.instructions([sid])
    for bad in [{'../SKILL.md':'bad'}, {'SKILL.md':'ok','run.py':'bad'}, {'SKILL.md':'ok','agent-skill.json':'{"instructionReferences":["references/missing.md"]}'}]:
        assert c.post('/api/studio/skills',json={'name':'bad','files':bad}).status_code==400
    with patch.object(generation,'connection',return_value=(None,None,'https://example.test')),patch.object(generation.catalog,'resolve_model',return_value='gpt-4o'):
        req=generation.Generation(request_id='skill-test-001',provider_id='test',model='gpt-4o',kind='chat',prompt='列出资产',skill_ids=[sid])
        data,_,_=generation.checked(req);assert '保持角色服装连续' in data['system_prompt']
    assert c.delete('/api/studio/skills/'+sid).status_code==200
    assert c.get('/api/studio/skills/'+sid).status_code==404
raw={'price_estimates':{'model':{'status':'ready','active_features':['quality','inputImageCount','aspectRatio'], 'entries':[{'params':{'quality':'auto','inputImageCount':1,'aspectRatio':'1:1'},'price_cny':0.2}]}}}
q=pricing.Quote(provider_id='test',model='model',params={'ratio':'1:1'},image_count=1,count=2)
assert pricing.estimate(raw,'model',q)['price']==0.4
q.image_count=2;assert pricing.estimate(raw,'model',q)['approximate'] is True
q.params['quality']='high';assert pricing.estimate(raw,'model',q)['price'] is None
q.params={'quality':'auto','ratio':'16:9'};assert pricing.estimate(raw,'model',q)['price'] is None
assert pricing.feature('duration_seconds')=='duration'
print('PASS account isolation/2FA/wallet/logout, skill validation/injection/deletion, exact/approximate pricing boundaries; no paid requests')
