/* Isolated UI plus real browser video decode/capture; every paid call is mocked. */
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-media-ui-')),base='http://127.0.0.1:3860',out=path.join(root,'test-output');
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,browser,page,log='';const errors=[],submitted=[],jobs=new Map(),checks=[];
async function api(url,body){const r=await fetch(base+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert(r.ok,await r.clone().text());return r.json();}
// MediaRecorder omits WebM duration. Add standard EBML Duration (timecode scale 1 ms)
// to its Info element so the fixture is a finite, seekable two-second video.
function durationWebm(data,ms){const pos=data.indexOf(Buffer.from([0x15,0x49,0xa9,0x66]));assert(pos>=0);const start=pos+4;let width=1,mask=0x80;while(!(data[start]&mask)){width++;mask>>=1;}let size=data[start]&~mask;for(let i=1;i<width;i++)size=size*256+data[start+i];const tag=Buffer.alloc(11);tag.set([0x44,0x89,0x88]);tag.writeDoubleBE(ms,3);let next=size+tag.length;const encoded=Buffer.alloc(width);for(let i=width-1;i>=0;i--){encoded[i]=next%256;next=Math.floor(next/256);}encoded[0]|=mask;return Buffer.concat([data.subarray(0,start),encoded,data.subarray(start+width,start+width+size),tag,data.subarray(start+width+size)]);}
(async()=>{
 child=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:'3860',DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'}});child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 for(let i=0;i<100;i++){try{await api('/api/studio/health');break;}catch{await pause(200);}}
 await api('/api/studio/settings/sync-models',{id:'deepwhite',name:'DeepWhite',base_url:'https://api.deepwhiteai.com/v1',api_key:'sk-media-fixture-only',enabled:true,primary:true});
 const project=(await api('/api/projects',{name:'素材处理模拟验收'})).project;
 const canvas=(await api('/api/canvases',{title:'人设图与关键帧',kind:'classic',project:project.id})).canvas;
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1500,height:1050}});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',route=>{const req=route.request(),u=new URL(req.url());assert.equal(u.origin,base,'No external traffic');
   if(u.pathname==='/api/studio/generations'&&req.method()==='POST'){const body=req.postDataJSON();submitted.push(body);const job={id:body.request_id,request:body,resolved_model:body.model,status:'succeeded',created_at:Date.now()/1000,updated_at:Date.now()/1000,children:[],task_ids:['mock-character'],outputs:[{url:'/static/studio-mark.svg?character-result',kind:'image'}],text:'',error:''};jobs.set(job.id,job);return route.fulfill({json:job});}
   if(u.pathname==='/api/studio/generations')return route.fulfill({json:{items:[...jobs.values()]}});
   if(u.pathname.startsWith('/api/studio/generations/'))return route.fulfill({json:jobs.get(u.pathname.split('/')[4])});
   if(req.method()==='POST'&&/\/api\/(canvas-(image|video|llm)|studio\/mj\/submit)/.test(u.pathname))throw Error('Unexpected paid route');return route.continue();
 });
 await page.goto(base+'/static/canvas.html?id='+canvas.id);await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id);await page.locator('#shell:not(.no-canvas) #board').waitFor();await pause(300);
 await page.evaluate(()=>createImageCardFromUrl('/static/studio-mark.svg',{x:400,y:220},'人物参考'));
 await page.locator('.image-preview-wrap img').click();
 const bar=page.getByRole('toolbar',{name:'图片处理工具'});await bar.waitFor();assert.equal(await page.locator('#outputLightbox.open').count(),0);assert.equal(await page.locator('#imageEditModal.open').count(),0);
 await page.screenshot({path:path.join(out,'image-processing-toolbar.png')});
 await bar.getByRole('button',{name:'裁剪',exact:true}).click();await page.locator('#imageEditModal.open').waitFor();assert.equal(await page.evaluate(()=>imageEditMode),'crop');await page.evaluate(()=>closeImageEditor());
 await bar.getByRole('button',{name:'标准人设图',exact:true}).click();
 const d=page.locator('dialog.studio-media-tools');await d.getByLabel('人设图模型').waitFor();
 assert((await d.getByLabel('人设图模型').locator('option:checked').innerText()).includes('高品质版'));
 assert.equal(await d.locator('pre').count(),0);assert.equal(await d.getByAltText('标准人设图效果案例').count(),1);
 await page.screenshot({path:path.join(out,'standard-character-dialog.png')});assert.equal(submitted.length,0);
 await d.getByRole('button',{name:'生成标准人设图',exact:true}).click();await page.waitForFunction(()=>nodes.some(n=>n.studioProcessing?.type==='standard-character'&&n.runStatus==='done'));
 assert.equal(submitted.length,1);const request=submitted[0];assert.equal(request.model,'deepwhiteai-image-g-v2.5-sunburst');assert.equal(request.count,1);assert.equal(request.params.ratio,'4:3');assert.equal(request.references.length,1);assert.equal(request.references[0].url,'/static/studio-mark.svg');assert.equal(request.prompt.trim(),fs.readFileSync(path.join(root,'static/prompts/standard-character.txt'),'utf8').trim());
 assert(await page.evaluate(()=>nodes.some(n=>n.type==='image'&&n.url==='/static/studio-mark.svg')));await page.evaluate(async()=>await saveCanvas());await page.reload();await page.waitForFunction(()=>nodes.some(n=>n.studioProcessing?.type==='standard-character'));await pause(300);assert.equal(submitted.length,1);
 checks.push('图片处理入口；默认 G2.5 高品质版；原文提示词、4:3、单张、唯一参考图；原图保留、结果保存、刷新不重提');
 // Create actual red/blue media, then exercise production decoding and PNG upload.
 const bytes=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=320;c.height=180;const ctx=c.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,320,180);const stream=c.captureStream(12),rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];rec.ondataavailable=e=>chunks.push(e.data);const stopped=new Promise(r=>rec.onstop=r);const tick=setInterval(()=>ctx.fillRect(0,0,320,180),70);rec.start();await new Promise(r=>setTimeout(r,1000));ctx.fillStyle='blue';ctx.fillRect(0,0,320,180);await new Promise(r=>setTimeout(r,1000));rec.stop();clearInterval(tick);await stopped;stream.getTracks().forEach(t=>t.stop());return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));});
 const video=durationWebm(Buffer.from(bytes),2100);const upload=await context.request.post(base+'/api/ai/upload',{multipart:{files:{name:'red-blue.webm',mimeType:'video/webm',buffer:video}}});assert(upload.ok());const ref=(await upload.json()).files[0];
 await page.evaluate(ref=>{nodes=[];connections=[];selected.clear();createImageCardFromUrl(ref.url,{x:80,y:70},ref.name);},ref);
 await page.getByRole('button',{name:'截取关键帧',exact:true}).click();await page.waitForFunction(()=>document.querySelector('dialog video')?.readyState>=2);
 await d.getByLabel('定位时间（秒）').fill('-1');await d.getByRole('button',{name:'定位到此时间',exact:true}).click();assert((await d.getByRole('status').innerText()).includes('范围内'));
 for(const t of [.3,1.5]){await d.getByLabel('定位时间（秒）').fill(String(t));await d.getByRole('button',{name:'定位到此时间',exact:true}).click();await page.waitForFunction(t=>{const v=document.querySelector('dialog video');return !v.seeking&&Math.abs(v.currentTime-t)<.01;},t);await d.getByRole('button',{name:'添加当前时间点',exact:true}).click();}
 await d.getByRole('button',{name:'添加当前时间点',exact:true}).click();assert.equal(await d.locator('.studio-frame-times button').count(),2);
 await page.screenshot({path:path.join(out,'keyframe-dialog.png')});await d.getByRole('button',{name:'保存关键帧到画布',exact:true}).click();await page.waitForFunction(()=>nodes.some(n=>n.studioProcessing?.type==='keyframes'));
 const frames=await page.evaluate(()=>nodes.find(n=>n.studioProcessing?.type==='keyframes'));assert.equal(frames.images.length,2);assert.deepEqual(frames.studioProcessing.times,[.3,1.5]);
 const pixels=await page.evaluate(async urls=>{const result=[];for(const url of urls){const img=new Image();img.src=url;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);result.push({w:img.width,h:img.height,pixel:Array.from(ctx.getImageData(50,50,1,1).data)});}return result;},frames.images.map(x=>x.url));
 assert(pixels.every(p=>p.w===320&&p.h===180));assert(pixels[0].pixel[0]>200&&pixels[0].pixel[2]<50);assert(pixels[1].pixel[2]>200&&pixels[1].pixel[0]<50);assert.equal(submitted.length,1);
 await page.evaluate(async()=>await saveCanvas());await page.reload();await page.waitForFunction(()=>nodes.some(n=>n.studioProcessing?.type==='keyframes'));assert.equal(await page.evaluate(()=>nodes.find(n=>n.studioProcessing?.type==='keyframes').images.length),2);
 // Result images expose the same operation; missing default never silently substitutes.
 await page.locator('.output-img-wrap img').first().click();await bar.waitFor();assert.equal(await page.locator('#outputLightbox.open').count(),0);
 await page.locator('.output-img-wrap img').last().click();await bar.getByRole('button',{name:'查看大图',exact:true}).click();await page.locator('#outputLightbox.open').waitFor();assert.equal(await page.evaluate(()=>currentOutputLightboxUrl),frames.images[1].url);await page.keyboard.press('Escape');
 await page.locator('.output-img-wrap img').first().dblclick();await page.locator('#outputLightbox.open').waitFor();assert.equal(await page.evaluate(()=>currentOutputLightboxUrl),frames.images[0].url);await page.keyboard.press('Escape');
 await page.locator('.output-img-wrap img').first().click();await bar.getByRole('button',{name:'标准人设图',exact:true}).click();await d.getByLabel('人设图模型').waitFor();
 assert.equal(await d.locator('.studio-character-reference').getAttribute('src'),frames.images[0].url);await d.getByRole('button',{name:'关闭素材处理'}).click();assert.equal(submitted.length,1);
 await page.route('**/api/studio/model-catalog',async route=>{const response=await route.fetch(),data=await response.json();for(const p of Object.values(data.providers))for(const m of p.models)if(m.id==='deepwhiteai-image-g-v2.5-sunburst')m.enabled=false;await route.fulfill({json:data});});
 await bar.getByRole('button',{name:'标准人设图',exact:true}).click();await d.getByLabel('人设图模型').waitFor();assert.equal(await d.getByLabel('人设图模型').inputValue(),'');assert(await d.getByRole('button',{name:'生成标准人设图',exact:true}).isDisabled());await d.getByRole('button',{name:'关闭素材处理'}).click();assert.equal(submitted.length,1);
 await bar.getByRole('button',{name:'宫格裁剪',exact:true}).click();await page.locator('#imageEditModal.open').waitFor();assert.equal(await page.evaluate(()=>imageEditMode),'grid');assert.equal(await page.evaluate(()=>nodes.find(n=>n.studioProcessing?.type==='keyframes').images.length),2);await page.evaluate(()=>closeImageEditor());
 await page.mouse.click(1250,800);await page.waitForFunction(()=>document.querySelector('.studio-image-toolbar').hidden);
 checks.push('上传图与生成图单击显示统一工具栏，切换单张素材、双击大图、原生裁剪/宫格编辑、点击空白隐藏，原结果集合保留');
 checks.push('结果中的单张图片可处理；关闭窗口不提交；高品质版停用后不自动改用其他模型');
 checks.push('真实 WebM 解码定位、越界提示、时间点去重；红蓝两帧内容与尺寸校验；PNG 本地上传保存、时间信息持久化；截帧无生成请求');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'media-tools-checks.json'),JSON.stringify({passed:true,checks},null,2));console.log(JSON.stringify({passed:true,checks},null,2));
})().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(out,'media-tools-failure.png')}).catch(()=>{});fs.writeFileSync(path.join(out,'media-tools-server.log'),log);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child){const done=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([done,pause(4000)]);}assert(path.resolve(runtime).startsWith(path.join(os.tmpdir(),'deepwhite-media-ui-')));fs.rmSync(runtime,{recursive:true,force:true});});
