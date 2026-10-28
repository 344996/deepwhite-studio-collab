/* F03 (handover 2026-10-26): RH image fields never receive a local asset-version path.
   Classic and smart canvas pages, real temporary storage, fake RH upstream that records uploads. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start,assert}=require('./smart-p1-harness.cjs');
async function main(){
 const h=await start('rh-asset-versions',{server:'tests/rh-ledger-browser-server.py'});
 const statePath=path.join(h.runtime,'fake-rh-upstream.json');
 const upstream=()=>fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf-8')):{submits:[],uploads:[]};
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const person=(await h.api('/api/studio/assets/register','POST',{url:'/api/storage-files/generated/fixture-scene.png',name:'人物'})).item.url;
  const scene=(await h.api('/api/studio/assets/register','POST',{url:'/api/storage-files/generated/fixture-storage.png',name:'场景'})).item.url;
  assert.match(person,/^\/api\/studio\/assets\/[a-f0-9]{32}\/file$/);assert.notEqual(person,scene);

  // Smart canvas: the real request builder, upload and ledger submit; only the selected RH entry is stubbed.
  const c=await h.smartCanvas('RH assets',[{id:'media',type:'smart-image',title:'RH',x:100,y:100,images:[]}]);
  const smart=await h.newPage();
  await smart.addInitScript(()=>{addEventListener('DOMContentLoaded',()=>{
   selectedRunningHubRef=()=>({kind:'app',id:'1234567890'});rhCurrentKind=()=>'app';rhActiveFields=()=>window.__rhFields;currentRunningHubWorkflowConfig=async()=>null;});});
  await h.openSmart(smart,c.id);
  const result=await smart.evaluate(async refs=>{
   window.__rhFields=[{nodeId:'403',fieldName:'image',fieldType:'IMAGE',imageOrder:1},{nodeId:'404',fieldName:'image',fieldType:'IMAGE',imageOrder:2}];
   const node=nodes.find(n=>n.id==='media');
   try{await runRunningHubGeneration('雨夜',refs,{...settings,engine:'runninghub',rhPayment:'free',rhParams:{}},{node});return {ok:true};}
   catch(e){return {ok:false,error:String(e.message||e)};}
  },[{url:person,kind:'image'},{url:scene,kind:'image'}]);
  const sent=(upstream().submits[0]||{}).nodeInfoList||[];
  const value=id=>String(sent.find(item=>String(item.nodeId)===id)?.fieldValue??'');
  await check('smart canvas uploads both asset versions and sends RH file names in order',()=>{
   assert.equal(result.ok,true,result.error);
   assert(!sent.some(item=>String(item.fieldValue).startsWith('/')),'a local path reached RH: '+JSON.stringify(sent));
   assert.match(value('403'),/^api\/uploaded-\d+-/);assert.match(value('404'),/^api\/uploaded-\d+-/);
   const uploads=upstream().uploads;assert.equal(uploads.length,2,JSON.stringify(uploads));
   assert.equal(value('403'),'api/uploaded-1-'+uploads[0]);assert.equal(value('404'),'api/uploaded-2-'+uploads[1]);
  });

  // Classic canvas: the shared upload helper used by its RH request builder.
  const created=(await h.api('/api/canvases','POST',{title:'classic assets',kind:'classic'})).canvas;
  const classic=await h.newPage();
  await classic.goto(h.base+'/static/canvas.html?id='+created.id);
  await classic.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof rhUploadValueIfNeeded==='function');
  const upload=url=>classic.evaluate(async url=>{try{return {ok:true,value:await rhUploadValueIfNeeded(url,{},'image')};}catch(e){return {ok:false,error:String(e.message||e)};}},url);
  await check('classic canvas uploads an asset version instead of passing the local path',async()=>{
   const before=upstream().uploads.length,r=await upload(person);
   assert.equal(r.ok,true,r.error);assert.match(String(r.value),/^api\/uploaded-\d+-/,'sent '+JSON.stringify(r.value));
   assert.equal(upstream().uploads.length,before+1);
  });
  await check('classic canvas blocks a local path the server cannot resolve',async()=>{
   const before=upstream().uploads.length,r=await upload('/static/missing-file.png');
   assert.equal(r.ok,false,'returned '+JSON.stringify(r.value));assert.match(r.error,/素材上传失败/);
   assert.equal(upstream().uploads.length,before);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
