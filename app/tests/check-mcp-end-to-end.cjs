const {chromium}=require('playwright'),{spawn}=require('node:child_process'),readline=require('node:readline'),assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID}=require('node:crypto');
(async()=>{
 const base='http://127.0.0.1:3874',browser=await chromium.launch({channel:'msedge',headless:true});let child;
 try{
  const context=await browser.newContext({viewport:{width:1500,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
  const request=context.request;
  assert((await request.put(base+'/api/studio/control/settings',{data:{enabled:true}})).ok());
  const settings=await(await request.get(base+'/api/studio/control/settings')).json();
  const client=settings.client_config.mcpServers['deepwhite-studio'];
  child=spawn(client.command,client.args,{env:{...process.env,...client.env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let seq=0,stderr='';child.stderr.on('data',b=>stderr+=b.toString());
  readline.createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line),resolve=pending.get(value.id);if(resolve){pending.delete(value.id);resolve(value);}});
  function rpc(method,params){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP timeout: '+method+' '+stderr));},15000);pending.set(id,value=>{clearTimeout(timer);value.error?reject(Error(JSON.stringify(value.error))):resolve(value.result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  const init=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'offline-browser-test',version:'1'}});
  assert.equal(init.protocolVersion,'2025-06-18');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await rpc('tools/list',{});assert.equal(tools.tools.length,17);
  async function call(name,args={}){const r=await rpc('tools/call',{name,arguments:args});assert(!r.isError,JSON.stringify(r));return r.structuredContent;}
  await page.goto(base+'/static/canvas.html?id=controlfixture');await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id==='controlfixture');
  const assets=await call('list_assets',{project_id:'default'}),asset=assets.items.find(x=>x.kind==='image');assert(asset);
  const models=await call('list_models');assert(models.items.some(m=>m.model==='deepwhiteai-image-g-v2.5-lowprice'));
  const before=await call('get_canvas',{canvas_id:'controlfixture'});
  const op=randomUUID(),specs=[{key:'image',kind:'image',title:'MCP人物图',prompt:'写实人物肖像，柔和的窗边光线',provider_id:'mcp-fixture',model:'deepwhiteai-image-g-v2.5-lowprice',params:{},references:[]},
   {key:'video',kind:'video',title:'MCP视频',prompt:'镜头缓慢推近 {{asset:'+asset.version_id+'}} 中的人物',provider_id:'mcp-fixture',model:'seedance-2.5-standard',params:{},references:[{version_id:asset.version_id}]}];
  const created=await call('apply_nodes',{canvas_id:'controlfixture',expected_revision:before.revision,operation_id:op,nodes:specs});
  await page.waitForFunction(ids=>ids.every(id=>nodes.some(n=>n.id===id)),Object.values(created.node_ids));
  const again=await call('apply_nodes',{canvas_id:'controlfixture',expected_revision:before.revision,operation_id:op,nodes:specs});assert.deepEqual(again.node_ids,created.node_ids);
  const settingsPage=await context.newPage();settingsPage.on('pageerror',e=>errors.push(e.message));await settingsPage.goto(base+'/settings');await settingsPage.locator('[data-tab=control]').click();
  for(const kind of ['image','video']){
   const rid=randomUUID(),node=created.node_ids[kind];
   const proposed=await call('generate_node',{canvas_id:'controlfixture',node_id:node,request_id:rid});assert(proposed.approval_required);
   await settingsPage.locator('#controlRefresh').click();await settingsPage.locator('#controlPending .control-request').waitFor();
   settingsPage.once('dialog',d=>d.accept());await settingsPage.getByRole('button',{name:'批准并执行'}).click();
   await settingsPage.getByText('已批准；本地服务已接收执行请求。',{exact:true}).waitFor();
   let job;for(let i=0;i<20;i++){job=await call('get_generation',{job_id:rid});if(job.status==='succeeded')break;await new Promise(r=>setTimeout(r,100));}
   assert.equal(job.status,'succeeded');assert.equal(job.request.node_id,node);assert.equal(job.outputs[0].kind,kind);
   const repeat=await call('generate_node',{canvas_id:'controlfixture',node_id:node,request_id:rid});assert.equal(repeat.job_id,rid);
   await page.waitForFunction(id=>nodes.find(n=>n.id===id)?.generatedOutputs?.length>0,node);
   await page.waitForFunction(id=>connections.some(c=>c.from===id&&nodes.some(n=>n.id===c.to&&n.type==='output'&&n.images?.length)),node);
   const rev1=(await call('get_canvas',{canvas_id:'controlfixture'})).revision;await call('get_generation',{job_id:rid});assert.equal((await call('get_canvas',{canvas_id:'controlfixture'})).revision,rev1);
  }
  await settingsPage.locator('[data-tab=dreamina]').click();assert(await settingsPage.locator('#controlPanel').isHidden());await settingsPage.locator('[data-tab=control]').click();assert(await settingsPage.locator('#dreaminaPanel').isHidden());
  await page.evaluate(()=>{viewport={x:60,y:75,scale:.5};render();});
  fs.mkdirSync('test-output/mcp-v0.8',{recursive:true});await settingsPage.screenshot({path:'test-output/mcp-v0.8/settings.png'});await page.screenshot({path:'test-output/mcp-v0.8/canvas.png'});
  assert.deepEqual(errors,[]);await request.put(base+'/api/studio/control/settings',{data:{enabled:false}});
  console.log('PASS real stdio -> controller -> batch nodes + media links -> browser approvals -> mocked image/video jobs -> live canvas results; replay never creates a new job');
 }finally{child?.kill();await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
