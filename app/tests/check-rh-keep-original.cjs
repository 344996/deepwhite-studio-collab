/* RH-NEW-01 (handover 2026-10-26): "保留工作流原设置" is read-only and never sent; exposed fields send
   their current value, 0 and false included; the final values and their sources can be previewed.
   Classic and smart canvas pages, fake RH upstream; nothing reaches RunningHub. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start,assert}=require('./smart-p1-harness.cjs');
const FIELDS=[
 {nodeId:'410',fieldName:'text',fieldType:'STRING',label:'提示词',fieldValue:'工作流原提示',sourceFromUpstream:false},
 {nodeId:'3',fieldName:'steps',fieldType:'INT',label:'步数',fieldValue:20},
 {nodeId:'5',fieldName:'enable',fieldType:'BOOLEAN',label:'开关',fieldValue:true},
 {nodeId:'7',fieldName:'cfg',fieldType:'FLOAT',label:'CFG',fieldValue:7,sourceFromUpstream:false}];
const PARAMS={'410::text':{value:'画布里写的'},'3::steps':{value:0},'5::enable':{value:false},'7::cfg':{value:1.5}};
async function main(){
 const h=await start('rh-keep-original',{server:'tests/rh-ledger-browser-server.py'});
 const statePath=path.join(h.runtime,'fake-rh-upstream.json');
 const upstream=()=>fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf-8')):{submits:[],uploads:[]};
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 const sent=list=>Object.fromEntries((list||[]).map(i=>[i.nodeId+'.'+i.fieldName,i.fieldValue]));
 try{
  const created=(await h.api('/api/canvases','POST',{title:'keep original',kind:'classic'})).canvas;
  const classic=await h.newPage();
  await classic.goto(h.base+'/static/canvas.html?id='+created.id);
  await classic.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof rhBuildNodeInfoList==='function');
  const r=await classic.evaluate(async([fields,params])=>{
   rhActiveFields=()=>fields;rhCurrentKind=()=>'workflow';
   const node={id:'rh',rhParams:JSON.parse(JSON.stringify(params))};
   const list=await rhBuildNodeInfoList(node,{image:[],video:[],audio:[],prompt:'主输入框文字'});
   const prompts=document.createElement('div'),others=document.createElement('div');
   renderRhPromptFields(prompts,node,fields);renderRhParams(others,node,fields,{image:[],video:[],audio:[]});
   const ui=el=>({kept:[...el.querySelectorAll('[data-rh-keep]')].map(e=>e.dataset.rhKeep),editable:[...el.querySelectorAll('[data-rh-param]')].map(e=>e.dataset.rhParam)});
   return {list,prompts:ui(prompts),others:ui(others),preview:typeof rhEffectiveParams==='function'?rhEffectiveParams(node):''};
  },[FIELDS,PARAMS]);
  await check('classic: kept fields are not sent, exposed 0 and false are',()=>{
   const s=sent(r.list);
   assert(!('410.text' in s),'kept prompt was sent: '+JSON.stringify(s));assert(!('7.cfg' in s),'kept cfg was sent');
   assert.strictEqual(s['3.steps'],0);assert.strictEqual(s['5.enable'],false);
  });
  await check('classic: kept fields are shown read-only, not as editors',()=>{
   assert.deepEqual(r.prompts.kept,['410::text']);assert(!r.prompts.editable.includes('410::text'));
   assert.deepEqual(r.others.kept,['7::cfg']);assert(!r.others.editable.includes('7::cfg'));
   assert(r.others.editable.includes('3::steps'),'exposed field lost its editor');
  });
  await check('classic: the preview names each final value and where it comes from',()=>{
   assert.match(r.preview,/提示词（410\.text）：不发送，使用工作流里保存的值/);
   assert.match(r.preview,/步数（3\.steps） = 0 · 来源：画布中填写/);
   assert.match(r.preview,/开关（5\.enable） = false · 来源：画布中填写/);
  });

  const c=await h.smartCanvas('keep smart',[{id:'media',type:'smart-image',title:'RH',x:100,y:100,images:[]}]);
  const smart=await h.newPage();
  await smart.addInitScript(()=>{addEventListener('DOMContentLoaded',()=>{
   selectedRunningHubRef=()=>({kind:'app',id:'1234567890'});rhCurrentKind=()=>'app';rhActiveFields=()=>window.__rhFields;currentRunningHubWorkflowConfig=async()=>null;});});
  await h.openSmart(smart,c.id);
  const s=await smart.evaluate(async([fields,params])=>{
   window.__rhFields=fields;const node=nodes.find(n=>n.id==='media');
   let error='';try{await runRunningHubGeneration('主输入框文字',[],{...settings,engine:'runninghub',rhPayment:'free',rhParams:JSON.parse(JSON.stringify(params))},{node});}catch(e){error=String(e.message||e);}
   return {error,editor:renderRhSettingField(fields[3])};
  },[FIELDS,PARAMS]);
  await check('smart (app mode): kept fields are not sent, 0 and false are',()=>{
   assert.equal(s.error,'');const list=sent(upstream().submits.at(-1)?.nodeInfoList);
   assert(!('410.text' in list)&&!('7.cfg' in list),'kept field sent: '+JSON.stringify(list));
   assert.strictEqual(list['3.steps'],0);assert.strictEqual(list['5.enable'],false);
  });
  await check('smart: a kept field renders read-only',()=>{
   assert.match(s.editor,/data-rh-keep="7::cfg"/);assert.doesNotMatch(s.editor,/<input|<select|<textarea/);
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
