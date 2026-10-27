/* F07 (handover 2026-10-26): RH image order 0 is a real order, invalid orders and partial mappings
   block the submit. Smart and classic canvas pages, fake RH upstream that records uploads and submits. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start,assert}=require('./smart-p1-harness.cjs');
const PERSON='/api/storage-files/generated/fixture-storage.png',SCENE='/api/storage-files/generated/fixture-scene.png';
async function main(){
 const h=await start('rh-image-order',{server:'tests/rh-ledger-browser-server.py'});
 const statePath=path.join(h.runtime,'fake-rh-upstream.json');
 const upstream=()=>fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf-8')):{submits:[],uploads:[]};
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 const image=(nodeId,imageOrder,extra={})=>({nodeId,fieldName:'image',fieldType:'IMAGE',imageOrder,...extra});
 // Which uploaded file each node received; uploads are named after the source file.
 const sentFiles=submit=>Object.fromEntries((submit?.nodeInfoList||[]).map(i=>[String(i.nodeId),String(i.fieldValue).replace(/^api\/uploaded-\d+-/,'')]));
 try{
  const c=await h.smartCanvas('RH order',[{id:'media',type:'smart-image',title:'RH',x:100,y:100,images:[]}]);
  const smart=await h.newPage();
  await smart.addInitScript(()=>{addEventListener('DOMContentLoaded',()=>{
   selectedRunningHubRef=()=>({kind:'app',id:'1234567890'});rhCurrentKind=()=>'app';rhActiveFields=()=>window.__rhFields;currentRunningHubWorkflowConfig=async()=>null;});});
  await h.openSmart(smart,c.id);
  const runSmart=(fields,refs)=>smart.evaluate(async([fields,refs])=>{
   window.__rhFields=fields;const node=nodes.find(n=>n.id==='media');
   try{await runRunningHubGeneration('雨夜',refs.map(url=>({url,kind:'image'})),{...settings,engine:'runninghub',rhPayment:'free',rhParams:{}},{node});return {ok:true};}
   catch(e){return {ok:false,error:String(e.message||e)};}
  },[fields,refs]);
  const both=[PERSON,SCENE];
  for(const [label,orders] of [['0/1',[0,1]],['1/2',[1,2]]]){
   await check(`smart ${label}: node403 gets the person and node404 the scene, whatever the field order`,async()=>{
    const before=upstream().submits.length;
    const r=await runSmart([image('404',orders[1]),image('403',orders[0])],both);
    assert.equal(r.ok,true,r.error);
    const sent=sentFiles(upstream().submits[before]);
    assert.deepEqual(sent,{'403':'fixture-storage.png','404':'fixture-scene.png'},JSON.stringify(sent));
   });
  }
  await check('smart: an invalid image order blocks the submit',async()=>{
   const before=upstream().submits.length;
   const r=await runSmart([image('403','first'),image('404',1)],both);
   assert.equal(r.ok,false);assert.match(r.error,/序号/);assert.equal(upstream().submits.length,before);
  });
  await check('smart: two image fields but one connected image blocks instead of sending the sample image',async()=>{
   const before=upstream().submits.length;
   const r=await runSmart([image('403',0,{fieldValue:'sample.png'}),image('404',1,{fieldValue:'sample.png'})],[PERSON]);
   assert.equal(r.ok,false,'submitted with a missing mapping');assert.match(r.error,/素材/);assert.equal(upstream().submits.length,before);
  });

  // Classic canvas: the same rules in its own request builder.
  const created=(await h.api('/api/canvases','POST',{title:'classic order',kind:'classic'})).canvas;
  const classic=await h.newPage();
  await classic.goto(h.base+'/static/canvas.html?id='+created.id);
  await classic.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof rhBuildNodeInfoList==='function');
  const runClassic=(fields,refs)=>classic.evaluate(async([fields,refs])=>{
   rhActiveFields=()=>fields;rhCurrentKind=()=>'app';
   try{return {ok:true,list:await rhBuildNodeInfoList({id:'rh',rhParams:{}},{image:refs.map(url=>({url})),video:[],audio:[]})};}
   catch(e){return {ok:false,error:String(e.message||e)};}
  },[fields,refs]);
  await check('classic 0/1: node403 gets the person and node404 the scene',async()=>{
   const r=await runClassic([image('404',1),image('403',0)],both);assert.equal(r.ok,true,r.error);
   assert.deepEqual(sentFiles({nodeInfoList:r.list}),{'403':'fixture-storage.png','404':'fixture-scene.png'});
  });
  await check('classic: invalid order and partial mapping block the request',async()=>{
   const bad=await runClassic([image('403','first'),image('404',1)],both);assert.equal(bad.ok,false);assert.match(bad.error,/序号/);
   const partial=await runClassic([image('403',0,{fieldValue:'sample.png'}),image('404',1,{fieldValue:'sample.png'})],[PERSON]);
   assert.equal(partial.ok,false,'built '+JSON.stringify(partial.list));assert.match(partial.error,/素材/);
  });
  await check('classic: no connected image keeps the app defaults',async()=>{
   const r=await runClassic([image('403',0,{fieldValue:'sample.png'})],[]);assert.equal(r.ok,true,r.error);
   assert.equal(r.list[0].fieldValue,'sample.png');
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
