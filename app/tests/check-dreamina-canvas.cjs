const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const base='http://127.0.0.1:3873',browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1500,height:1050}}),errors=[],submitted=[],jobs=new Map();let resumes=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!==base)throw Error('Unexpected external browser request: '+url.origin);
   if(url.pathname==='/api/studio/dreamina/status')return route.fulfill({json:{available:true,enabled:true,authenticated:true,account:'验收账号',credit:88,error:null,models:[
    {id:'dreamina-image-5.0',name:'即梦图像 5.0',series:'即梦图像',kind:'image',enabled:true,versions:['5.0']},
    {id:'dreamina-video-seedance-2.5',name:'Seedance 2.5',series:'Seedance',kind:'video',enabled:true,versions:['seedance2.5']}
   ]}});
   if(url.pathname==='/api/studio/dreamina/config')return route.fulfill({json:{enabled:true,cli_path:'C:\\mock\\dreamina.exe',models:{'dreamina-image-5.0':true,'dreamina-video-seedance-2.5':true}}});
   if(url.pathname==='/api/studio/capabilities')return route.fulfill({json:{providers:{'dreamina-cli':{
    'dreamina-image-5.0':{kind:'image',supported:true,note:'图片演示参数',prompt_min:1,prompt_max:20000,max_images:10,max_videos:0,max_audios:0,fields:{ratio:{label:'比例',values:['1:1','16:9'],default:'1:1'},resolution:{label:'分辨率',values:['2k','4k'],default:'2k'}}},
    'dreamina-video-seedance-2.5':{kind:'video',supported:true,note:'视频演示参数',prompt_min:1,prompt_max:20000,max_images:30,max_videos:10,max_audios:10,fields:{ratio:{label:'比例',values:['16:9','9:16'],default:'16:9'},resolution:{label:'分辨率',values:['720p','1080p'],default:'720p'},duration:{label:'时长（秒）',values:[5,6],default:5}}}
   }}}});
   if(url.pathname==='/api/studio/generations'&&req.method()==='POST'){
    const body=req.postDataJSON();submitted.push(body);
    const job={id:body.request_id,request:body,resolved_model:body.model,status:body.kind==='image'?'paused':'succeeded',created_at:Date.now()/1000,updated_at:Date.now()/1000,children:[{status:'queued',usage:null}],task_ids:['mock-'+submitted.length],outputs:[],error:body.kind==='image'?'模拟查询暂停，可继续查询。':''};jobs.set(job.id,job);return route.fulfill({json:job});
   }
   if(url.pathname==='/api/studio/generations'&&req.method()==='GET')return route.fulfill({json:{items:[...jobs.values()].filter(j=>j.request.canvas_id===url.searchParams.get('canvas_id'))}});
   const match=url.pathname.match(/^\/api\/studio\/generations\/([^/]+)(?:\/(resume))?$/);
   if(match){const job=jobs.get(match[1]);if(!job)return route.fulfill({status:404,json:{detail:'mock job missing'}});if(match[2]){resumes++;job.status='succeeded';job.error='';job.updated_at=Date.now()/1000;}return route.fulfill({json:job});}
   if(req.method()==='POST'&&/\/api\/(canvas-(?:image|video)|online-image)/.test(url.pathname))throw Error('Dreamina must use the stage-one generations API');
   return route.continue();
  });
  await page.goto(base+'/static/canvas.html?id=storagefixture');await page.locator('#shell:not(.no-canvas) #board').waitFor();
  await page.waitForFunction(()=>typeof apiProviders!=='undefined'&&apiProviders.some(p=>p.id==='dreamina-cli'&&p.enabled));
  await page.evaluate(()=>{nodes=[];connections=[];const n=addGeneratorNode({x:90,y:90});n.apiProvider='dreamina-cli';n.model='dreamina-image-5.0';n.studioRefs=[{url:'/static/examples/standard-character.png',kind:'image',name:'人物参考图'}];render();});
  const imagePrompt=page.getByLabel('图片提示词',{exact:true});await imagePrompt.fill('暖色晨光中的人物近景，电影剧照构图。');
  await page.locator('.generator-node .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.type==='generator')?.studioJobState==='paused');
  assert.equal(submitted.length,1);const image=submitted[0];
  assert.equal(image.canvas_id,'storagefixture');assert.equal(image.node_id,await page.locator('.generator-node').getAttribute('data-id'));
  assert.equal(image.provider_id,'dreamina-cli');assert.equal(image.model,'dreamina-image-5.0');assert(image.prompt.includes('暖色晨光'));assert.equal(image.references.length,1);assert.equal(image.references[0].url,'/static/examples/standard-character.png');
  await page.locator('.generator-node .studio-job-state button').filter({hasText:'继续查询'}).click();await page.waitForFunction(()=>nodes.find(n=>n.type==='generator')?.studioJobState==='succeeded');
  assert.equal(resumes,1);assert.equal(submitted.length,1,'续查不得重复提交生成');

  await page.evaluate(()=>{nodes=[];connections=[];const n=addVideoNode({x:120,y:100});n.apiProvider='dreamina-cli';n.model='dreamina-video-seedance-2.5';n.studioRefs=[{url:'/static/examples/motion-reference.mp4',kind:'video',name:'运动参考片段'}];n.multimodal=true;render();});
  const videoPrompt=page.getByLabel('视频提示词',{exact:true});await videoPrompt.fill('镜头跟随主体，沿用 @视频1 的移动节奏。');
  await page.locator('.video-node .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.type==='video')?.studioJobState==='succeeded');
  assert.equal(submitted.length,2);const video=submitted[1];
  assert.equal(video.canvas_id,'storagefixture');assert.equal(video.node_id,await page.locator('.video-node').getAttribute('data-id'));
  assert.equal(video.provider_id,'dreamina-cli');assert.equal(video.model,'dreamina-video-seedance-2.5');assert.equal(video.references[0].kind,'video');assert.equal(video.references[0].mention,'@视频1');assert.equal(video.multimodal,true);assert.equal(video.frame_mode,false);
  // The browser compiles bound @素材 labels into Seedance markers in reference order (the server accepts both forms).
  assert(video.prompt.includes('@Video 1'),video.prompt);assert(!video.prompt.includes('@视频1'),video.prompt);
  assert.deepEqual(errors,[]);
  console.log('PASS classic canvas image/video Dreamina generation payloads, @video multimodal references, and paused resume without resubmission; all Dreamina endpoints mocked');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
