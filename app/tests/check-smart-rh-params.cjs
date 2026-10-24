/* RH-SMART-MANAGED-MEDIA, RH-SMART-INSTANCE-TYPE, RH-SMART-SEED-PRECISION: what the smart canvas
   actually sends to RunningHub. Simulated only: a fake RH upstream records uploads and submits. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start,assert}=require('./smart-p1-harness.cjs');
const SEED='18446744073709551615';
const image=id=>({id,type:'smart-image',title:'RH '+id,x:100,y:100,images:[]});
async function main(){
 const h=await start('smart-rh-params',{server:'tests/rh-ledger-browser-server.py'});
 const statePath=path.join(h.runtime,'fake-rh-upstream.json');
 const upstream=()=>fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf-8')):{submits:[],uploads:[]};
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e));}};
 try{
  const c=await h.smartCanvas('RH params',['media','plus','range','broken'].map(image));
  const page=await h.newPage();
  // Stub only which RH entry and fields are selected; value building, upload, ledger submit and polling are real.
  await page.addInitScript(()=>{
   addEventListener('DOMContentLoaded',()=>{
    selectedRunningHubRef=()=>({kind:window.__rhKind,id:'1234567890'});
    rhCurrentKind=()=>window.__rhKind;
    rhActiveFields=()=>window.__rhFields;
    currentRunningHubWorkflowConfig=async()=>window.__rhWorkflow||null;
   });
  });
  await h.openSmart(page,c.id);
  const run=(id,{kind='app',fields,refs=[],params={},extra={},workflow=null})=>page.evaluate(async({id,kind,fields,refs,params,extra,workflow})=>{
   window.__rhKind=kind;window.__rhFields=fields;window.__rhWorkflow=workflow;
   const rhParams=Object.fromEntries(Object.entries(params).map(([k,v])=>[k,{value:v}]));
   const node=nodes.find(n=>n.id===id);
   try{const urls=await runRunningHubGeneration('雨夜',refs,{...settings,engine:'runninghub',rhPayment:'free',rhParams,...extra},{node});return {ok:true,urls,snapshot:node.studioRhSnapshot};}
   catch(e){return {ok:false,error:String(e.message||e),request:node.studioRhRequest||''};}
  },{id,kind,fields,refs,params,extra,workflow});
  const seedField={nodeId:'3',fieldName:'seed',fieldType:'INT'};

  // 06 + 08 on an app: managed paths are uploaded, a public URL field keeps its URL, the seed stays exact.
  const media=await run('media',{
   fields:[{nodeId:'1',fieldName:'image',fieldType:'IMAGE',imageOrder:1},{nodeId:'2',fieldName:'image',fieldType:'IMAGE',imageOrder:2},{nodeId:'5',fieldName:'url',fieldType:'IMAGE',imageOrder:3},seedField],
   refs:[{url:'/input/fixture-input.png',kind:'image'},{url:'/api/storage-files/generated/fixture-storage.png',kind:'image'},{url:'https://cdn.example.com/public.png',kind:'image'}],
   params:{'3::seed':SEED}});
  const sent=(upstream().submits[0]||{}).nodeInfoList||[];
  const value=nodeId=>sent.find(item=>String(item.nodeId)===nodeId)?.fieldValue;
  await check('06 managed /input/ and /api/storage-files/ media are uploaded and referenced by RH fileName',()=>{
   assert.equal(media.ok,true,media.error);
   assert.match(String(value('1')),/^api\/uploaded-\d+-fixture-input\.png$/,'node 1 sent '+JSON.stringify(value('1')));
   assert.match(String(value('2')),/^api\/uploaded-\d+-fixture-storage\.png$/,'node 2 sent '+JSON.stringify(value('2')));
   assert(!sent.some(item=>/^\/(input|api\/storage-files)\//.test(String(item.fieldValue))),'a local path reached RH');
  });
  await check('06 a URL field keeps the public URL',()=>{
   assert.equal(value('5'),'https://cdn.example.com/public.png');
   assert.deepEqual(upstream().uploads.sort(),['fixture-input.png','fixture-storage.png']);
  });
  await check('08 seed '+SEED+' is sent and saved digit for digit',()=>{
   assert.equal(value('3'),SEED,'RH received '+JSON.stringify(value('3')));
   assert.equal(media.snapshot?.payload?.nodeInfoList?.find(item=>item.nodeId==='3')?.fieldValue,SEED,'request snapshot changed the seed');
  });

  // 07 + 08 on a workflow: instanceType=plus is kept; the seed inside the workflow JSON stays exact.
  const plus=await run('plus',{kind:'workflow',fields:[seedField],params:{'3::seed':SEED},extra:{rhInstanceType:'plus'},
   workflow:{workflowJson:{'3':{class_type:'KSampler',inputs:{seed:0}}},optionalImageMode:'prune-workflow'}});
  const workflowSubmit=upstream().submits.find(s=>s.workflowId)||{};
  await check('07 workflow submit and saved snapshot keep instanceType=plus',()=>{
   assert.equal(plus.ok,true,plus.error);
   assert.equal(workflowSubmit.instanceType,'plus','RH received instanceType '+JSON.stringify(workflowSubmit.instanceType));
   assert.equal(plus.snapshot?.payload?.instanceType,'plus','snapshot instanceType '+JSON.stringify(plus.snapshot?.payload?.instanceType));
  });
  await check('08 seed inside the workflow JSON is an exact integer',()=>{
   assert.match(String(workflowSubmit.workflow||''),new RegExp('"seed":\\s*'+SEED+'\\b'),'workflow sent '+String(workflowSubmit.workflow).slice(0,200));
  });

  const before=upstream().submits.length;
  // 08: a field range is enforced on the exact value; nothing is rounded or submitted.
  const range=await run('range',{fields:[{...seedField,min:0,max:4294967295}],params:{'3::seed':SEED}});
  await check('08 a seed outside the field range is rejected before submitting',()=>{
   assert.equal(range.ok,false);assert.match(range.error,/范围/);
   assert.equal(range.request,'','a ledger request was reserved');
   assert.equal(upstream().submits.length,before);
  });
  // 06: a failed upload blocks the submit and names the stage.
  const broken=await run('broken',{fields:[{nodeId:'1',fieldName:'image',fieldType:'IMAGE'}],refs:[{url:'/input/missing.png',kind:'image'}]});
  await check('06 a failed upload blocks the submit with a stage error',()=>{
   assert.equal(broken.ok,false);assert.match(broken.error,/素材上传失败/);
   assert.equal(broken.request,'');assert.equal(upstream().submits.length,before);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-3000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
