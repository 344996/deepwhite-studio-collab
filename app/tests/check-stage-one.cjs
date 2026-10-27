/* Real local storage/UI, simulated generation; fixture blocks every external backend request. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-stage-ui-')),out=path.join(root,'test-output'),port=process.env.STUDIO_STAGE_TEST_PORT||'3860',base='http://127.0.0.1:'+port;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=';
const pause=ms=>new Promise(r=>setTimeout(r,ms)),jobs=new Map(),submitted=[],errors=[],checks=[];
let child,browser,page,log='',pauseNext=false,resumes=0,canvasId;
async function api(route,method='GET',data){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});assert(r.ok,await r.clone().text());return r.json();}
async function openParameters(){if(!await page.locator('.studio-image-settings-popup:popover-open').count())await page.locator('.studio-image-settings').click();}
async function closeParameters(){await page.locator('.studio-image-settings-popup:popover-open header button').click();}
async function openReferences(){if(!await page.locator('.studio-input-popover:popover-open').count())await page.getByRole('button',{name:'查看输入素材',exact:true}).click();}
async function openArrange(){await page.locator('#studioArrangeToggle0929').click();}
(async()=>{
 child=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:port,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'}});child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 for(let i=0;i<100;i++){try{await api('/api/studio/health');break;}catch{await pause(200);}}
 await api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'DeepWhite',base_url:'https://api.deepwhiteai.com/v1',api_key:'sk-stage-ui-only',enabled:true,primary:true});
 const project=(await api('/api/projects','POST',{name:'第一阶段模拟验收'})).project;
 canvasId=(await api('/api/canvases','POST',{title:'第一阶段验收',kind:'classic',project:project.id})).canvas.id;
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1500,height:1100}});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!==base)throw Error('Unexpected external browser traffic');
   if(url.pathname==='/api/studio/generations'&&req.method()==='POST'){
     const body=req.postDataJSON();submitted.push(body);
     const job={id:body.request_id,request:body,resolved_model:body.model,status:pauseNext?'paused':'succeeded',created_at:Date.now()/1000,updated_at:Date.now()/1000,children:[{usage:{total_tokens:25}}],task_ids:['test-'+submitted.length],outputs:body.kind==='chat'||pauseNext?[]:[{url:body.references[0]?.url||'/static/studio-mark.svg',kind:body.kind,name:'test.png'}],text:body.kind==='chat'?'这是改写后的结果。':'',error:pauseNext?'模拟查询中断，可继续查询。':''};if(body.kind==='image'&&body.count>1&&!pauseNext)job.outputs=Array.from({length:body.count},(_,i)=>({url:'/static/studio-mark.svg?batch='+i,kind:'image'}));pauseNext=false;jobs.set(job.id,job);return route.fulfill({json:job});
   }
   if(url.pathname==='/api/studio/generations')return route.fulfill({json:{items:[...jobs.values()].filter(j=>j.request.canvas_id===url.searchParams.get('canvas_id')).reverse()}});
   if(url.pathname.startsWith('/api/studio/generations/')){
     const job=jobs.get(url.pathname.split('/')[4]);if(req.method()==='POST'){resumes++;job.status='succeeded';job.error='';job.outputs=[{url:job.request.references[0]?.url||'/static/studio-mark.svg',kind:job.request.kind,name:'result.png'}];}return route.fulfill({json:job||{detail:'不存在'},status:job?200:404});
   }
   if(req.method()==='POST'&&/\/api\/(canvas-(image|video|llm)|online-image|studio\/mj\/submit)/.test(url.pathname))throw Error('Unexpected legacy generation route');
   return route.continue();
 });
 await page.goto(`${base}/static/canvas.html?id=${canvasId}`);await page.locator('#shell:not(.no-canvas) #board').waitFor();
 await page.evaluate(()=>{const n=addGeneratorNode({x:80,y:100});n.model='deepwhiteai-image-g2';render();});
 await page.getByLabel('图片提示词',{exact:true}).fill('一只猫站在窗边，柔和晨光。');
 await openParameters();const resolution=page.getByRole('group',{name:'分辨率',exact:true});await resolution.waitFor();assert.equal(await resolution.getByRole('button').count(),1);assert.equal(await resolution.getByRole('button',{name:'1k',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.locator('select[data-studio-param="resolution"] option').count(),1);await closeParameters();
 await openReferences();const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'上传参考素材',exact:true}).click()]);await chooser.setFiles([{name:'参考A.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')},{name:'参考B.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')}]);
 await page.waitForFunction(()=>nodes[0].studioRefs?.length===2);await openReferences();await page.locator('.studio-ref-item [data-down]').first().click();await openReferences();
 assert((await page.locator('.studio-ref-name').first().innerText()).includes('参考B'));
 await page.locator('.studio-ref-item [data-remove]').last().click();assert.equal(await page.locator('.studio-ref-item').count(),1);await openReferences();
 const [replacement]=await Promise.all([page.waitForEvent('filechooser'),page.locator('[data-replace]').click()]);await replacement.setFiles({name:'替换.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.waitForFunction(()=>nodes[0].studioRefs?.[0]?.name.includes('替换'));
 await page.evaluate(png=>{const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'粘贴.png',{type:'image/png'}));document.querySelector('.generator-node').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true}));},png);
 await page.waitForFunction(()=>nodes[0].studioRefs?.length===2);
 await page.evaluate(()=>{const text=addNode({id:uid('prompt'),type:'prompt',x:900,y:850,text:'参考内容：保持主体一致。'});connections.push({from:text.id,to:nodes[0].id});render();});
 await openParameters();await page.locator('.studio-sent summary').click();await page.waitForFunction(()=>document.querySelector('.studio-sent pre')?.textContent.includes('保持主体一致'));await closeParameters();
 await page.locator('.generator-node .gen-btn').click();await page.waitForFunction(()=>nodes[0].runStatus==='done');
 assert.equal(submitted[0].references.length,2);assert(submitted[0].prompt.includes('保持主体一致'));assert.equal(submitted[0].params.resolution,'1k');
 checks.push('上传、替换、移除、排序与粘贴参考素材；本地提示词和连接文本合并；参数仅显示模型允许值');
 page.once('dialog',d=>d.accept('产品主视觉'));await page.locator('.generator-node .node-title').dblclick();assert.equal(await page.locator('.generator-node .node-title').innerText(),'产品主视觉');
 await page.evaluate(async()=>await saveCanvas());const count=submitted.length;await page.reload();await page.getByLabel('图片提示词',{exact:true}).waitFor();await pause(1800);assert.equal(submitted.length,count);assert.equal(await page.locator('.generator-node .node-title').innerText(),'产品主视觉');assert.equal(await page.locator('.studio-ref-item').count(),2);
 await page.getByRole('button',{name:'任务记录',exact:true}).click();await page.locator('.studio-history article').waitFor();assert((await page.locator('.studio-history article').innerText()).includes('保持主体一致'));assert.equal(await page.locator('.studio-history a[download]').count(),1);
 await page.getByRole('button',{name:'复用这次设置',exact:true}).click();assert.equal(await page.locator('.generator-node').count(),2);assert.equal(submitted.length,count);
 checks.push('重命名和素材随画布保存；刷新不重复提交；记录显示输入和任务编号，可下载结果或复用设置');
 await page.evaluate(()=>{const n=nodes.find(n=>n.type==='generator');nodes=nodes.filter(x=>x===n||x.type==='output');connections=[];n.x=60;n.y=80;render();});
 pauseNext=true;await page.locator('.generator-node .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.type==='generator')?.studioJobState==='paused');await page.evaluate(async()=>await saveCanvas());const beforeResume=submitted.length;
 await page.reload();await page.getByLabel('图片提示词',{exact:true}).waitFor();await page.locator('.studio-basics button').filter({hasText:'继续查询'}).click();await page.waitForFunction(()=>nodes.find(n=>n.type==='generator')?.studioJobState==='succeeded');assert.equal(submitted.length,beforeResume);assert.equal(resumes,1);
 checks.push('中断记录刷新后可继续查询，未再次提交生成');
 await page.evaluate(()=>{nodes=[];connections=[];const n=addLLMNode({x:100,y:80});n.llmProvider='deepwhite';render();});
 await page.getByLabel('文本任务',{exact:true}).selectOption('rewrite');await page.getByLabel('文本提示词',{exact:true}).fill('请把这段文字改得更简洁。');
 await page.locator('.llm-run').first().click();await page.waitForFunction(()=>nodes.find(n=>n.type==='llm')?.outputText==='这是改写后的结果。');assert(submitted.at(-1).system_prompt.includes('改写'));assert.equal(submitted.at(-1).kind,'chat');
 await page.getByRole('button',{name:'将结果放入文本节点',exact:true}).click();assert(await page.evaluate(()=>nodes.some(n=>n.type==='prompt'&&n.text==='这是改写后的结果。')));
 await page.getByRole('button',{name:'任务记录',exact:true}).click();await page.getByRole('button',{name:'下载文本',exact:true}).waitFor();await page.getByRole('button',{name:'关闭生成记录',exact:true}).click();
 await page.screenshot({path:path.join(out,'stage-one-text.png')});
 checks.push('文本生成/改写/自定义入口；文本结果复制、下载、复用为节点');
 // Regression: the live lowprice model rejects 1–4 characters, despite stale public docs.
 await page.evaluate(()=>{nodes=[];connections=[];const n=addGeneratorNode({x:80,y:60});n.model='deepwhiteai-image-g-v2.5-lowprice';render();});
 await page.getByLabel('图片提示词',{exact:true}).fill('一只猫');assert(await page.locator('.generator-node .gen-btn').isDisabled());assert((await page.locator('.studio-prompt-count').innerText()).includes('5–5000'));
 assert(await page.locator('.studio-prompt-count').isVisible());assert.equal(await page.getByLabel('图片提示词',{exact:true}).getAttribute('aria-invalid'),'true');const shortCount=submitted.length;
 await page.getByLabel('图片提示词',{exact:true}).fill('长'.repeat(5001));assert(await page.locator('.generator-node .gen-btn').isDisabled());assert(await page.locator('.studio-prompt-count').isVisible());assert((await page.locator('.studio-prompt-count').innerText()).includes('5001'));assert.equal(submitted.length,shortCount);
 await page.getByLabel('图片提示词',{exact:true}).fill('一只白色猫');assert(await page.locator('.generator-node .gen-btn').isEnabled());assert.equal(await page.getByLabel('图片提示词',{exact:true}).getAttribute('aria-invalid'),null);assert.equal(await page.locator('.studio-prompt-count').isVisible(),false);assert.equal(submitted.length,shortCount);
 await page.locator('.generator-node .gen-btn').click();await page.waitForFunction(()=>nodes[0].runStatus==='done');
 checks.push('G2.5 低价版不足 5 字或超过 5000 字时阻止提交并显示原因；有效 5 字清除错误且可提交');
 const imageRefs=submitted[0].references;
 await page.evaluate(refs=>{nodes=[];connections=[];const n=addVideoNode({x:60,y:50});n.model='seedance-2.0-fast';n.studioRefs=refs.map((r,i)=>({...r,name:i?'背景图':'人物图'}));render();},imageRefs);
 const videoPrompt=page.getByLabel('视频提示词',{exact:true});await videoPrompt.fill('让 @');await page.locator('#studioMentionMenu:popover-open').waitFor();
 await page.locator('#studioMentionMenu [role="option"]').filter({hasText:'@图片1'}).click();assert((await videoPrompt.inputValue()).includes('@图片1'));
 await videoPrompt.press('End');await videoPrompt.pressSequentially('走入 @');await videoPrompt.press('ArrowDown');await videoPrompt.press('Enter');assert((await videoPrompt.inputValue()).includes('@图片2'));
 await openReferences();await page.locator('.studio-ref-item [data-down]').first().click();assert.equal(await page.locator('.studio-ref-mention').first().innerText(),'@图片2');
 await openParameters();await page.locator('.studio-sent summary').click();await page.waitForFunction(()=>document.querySelector('.studio-sent pre')?.textContent.includes('让 @Image 2 走入 @Image 1'));await closeParameters();
 await page.evaluate(async()=>await saveCanvas());await page.reload();await page.getByLabel('视频提示词',{exact:true}).waitFor();assert.equal(await page.locator('.studio-ref-mention').first().innerText(),'@图片2');assert((await videoPrompt.inputValue()).includes('@图片1'));
 await page.locator('.video-node .gen-btn').click();await page.waitForFunction(()=>nodes[0].runStatus==='done');assert.equal(submitted.at(-1).references[0].mention,'@图片2');assert.equal(submitted.at(-1).references[1].mention,'@图片1');
 await page.screenshot({path:path.join(out,'seedance-mentions.png')});
 const beforeMissing=submitted.length;await openReferences();await page.locator('.studio-ref-item [data-remove]').last().click();assert(await page.locator('.video-node .gen-btn').isDisabled());assert(await page.locator('.studio-prompt-count').isVisible());assert((await page.locator('.studio-prompt-count').innerText()).includes('重新关联'));assert.equal(submitted.length,beforeMissing);
 checks.push('Seedance 输入 @ 弹出素材，鼠标/键盘选取；排序、保存重开后仍绑定原素材，删除被引用素材时阻止提交');
 // The visible menu now uses the shared grid layout, preserving connections and undo.
 await page.evaluate(()=>{nodes=[];connections=[];selected.clear();const a=addNode({id:'arrange-a',type:'prompt',x:650,y:650,text:'起点'}),b=addNode({id:'arrange-b',type:'prompt',x:80,y:40,text:'中间'}),c=addNode({id:'arrange-c',type:'prompt',x:100,y:60,text:'终点'});connections.push({from:a.id,to:b.id},{from:b.id,to:c.id});window.beforeArrange=nodes.map(n=>({id:n.id,x:n.x,y:n.y}));window.beforeConnections=JSON.stringify(connections);window.arrangeMoves=[];const native=translateCanvasNodeWithMembers;translateCanvasNodeWithMembers=(n,...args)=>{window.arrangeMoves.push(n.id);return native(n,...args);};render();});
 await openArrange();assert(await page.getByRole('button',{name:'整理全部',exact:true}).isVisible());assert(await page.getByRole('button',{name:'整理选中',exact:true}).isDisabled());
 await page.getByRole('button',{name:'整理全部',exact:true}).click();assert.deepEqual(await page.evaluate(()=>arrangeMoves),['arrange-a','arrange-b','arrange-c']);assert(await page.evaluate(()=>nodes[0].x===nodes[2].x&&nodes[0].y===nodes[1].y&&nodes[1].x>nodes[0].x&&nodes[2].y>nodes[0].y));assert.equal(await page.evaluate(()=>JSON.stringify(connections)),await page.evaluate(()=>beforeConnections));
 await page.keyboard.press('Control+z');assert.deepEqual(await page.evaluate(()=>nodes.map(n=>({id:n.id,x:n.x,y:n.y}))),await page.evaluate(()=>beforeArrange));
 await page.evaluate(()=>{selected.clear();selected.add('arrange-b');selected.add('arrange-c');arrangeMoves=[];render();});await openArrange();await page.getByRole('button',{name:'整理选中',exact:true}).click();assert(await page.evaluate(()=>arrangeMoves.length>0&&arrangeMoves.every(id=>['arrange-b','arrange-c'].includes(id))));assert(await page.evaluate(()=>nodes[0].x===beforeArrange[0].x&&nodes[0].y===beforeArrange[0].y&&nodes[1].y===nodes[2].y&&nodes[1].x<nodes[2].x));assert.equal(await page.evaluate(()=>JSON.stringify(connections)),await page.evaluate(()=>beforeConnections));
 await page.evaluate(async()=>await saveCanvas());const positions=await page.evaluate(()=>nodes.map(n=>({id:n.id,x:n.x,y:n.y})));await page.reload();await page.waitForFunction(()=>nodes.length===3);assert.deepEqual(await page.evaluate(()=>nodes.map(n=>({id:n.id,x:n.x,y:n.y}))),positions);
 await page.screenshot({path:path.join(out,'canvas-arrange.png')});checks.push('可见整理全部/选中调用共享位置更新；网格分行分列，连线完整保留，未选中节点不动，支持撤销和保存重开');
 // Batch results remain one node, with navigation only in the enlarged gallery.
 await page.evaluate(()=>{nodes=[];connections=[];selected.clear();const n=addGeneratorNode({x:80,y:60});n.model='deepwhiteai-image-g-v2.5-lowprice';n.count=3;n.studioPrompt='三只不同的小猫';render();});
 await page.locator('.generator-node .gen-btn').click();await page.waitForFunction(()=>nodes.find(n=>n.type==='output')?.images.length===3);
 assert.equal(await page.evaluate(()=>nodes.filter(n=>n.type==='output').length),1);
 await page.evaluate(()=>{const n=nodes.find(n=>n.type==='output');selected.clear();selected.add(n.id);openOutputLightbox(n.images[0].url,n);});
 assert.equal(await page.locator('.studio-gallery-nav span').innerText(),'1 / 3');
 await page.getByRole('button',{name:'下一张图片',exact:true}).click();assert.equal(await page.locator('.studio-gallery-nav span').innerText(),'2 / 3');
 await page.screenshot({path:path.join(out,'batch-gallery.png')});
 await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('.studio-gallery-nav span').innerText(),'1 / 3');
 await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>nodes.length),2);
 await page.keyboard.press('Escape');
 // Selecting a header must release the previous editor's focus; text editing remains safe.
 await page.getByLabel('图片提示词',{exact:true}).focus();await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>nodes.length),2);
 await page.locator('.generator-node .node-head').click();await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>nodes.some(n=>n.type==='generator')),false);
 await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>nodes.some(n=>n.type==='generator')),true);
 await page.evaluate(()=>{nodes=[];connections=[];selected.clear();const n=addVideoNode({x:80,y:50});n.model='seedance-2.0-fast';render();});
 await page.locator('.studio-model-trigger img').waitFor();assert((await page.locator('.studio-model-trigger img').getAttribute('src')).includes('bytedance.svg'));
 assert(await page.locator('.studio-model-trigger img').evaluate(el=>el.complete&&el.naturalWidth>0));
 await page.locator('.video-node .node-head').click();await page.locator('.studio-model-trigger').focus();await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>nodes.length),0);
 await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>nodes.length),1);
 checks.push('批量三图同一结果节点；大图按钮/方向键/计数；输入框与查看器防误删、标题选择和按钮焦点下 Delete、撤销；Seedance 厂商图标本地加载');
 for(const type of ['prompt','image','output','llm','midjourney']){
   await page.evaluate(type=>{nodes=[];connections=[];selected.clear();const n=type==='llm'?addLLMNode({x:200,y:100}):addNode({id:'delete-'+type,type,x:200,y:100,text:'删除检查',url:'/static/studio-mark.svg',images:[],inputs:[]});render();},type);
   await page.locator('#nodes .node-head').first().click();await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>nodes.length),0,type+' Delete');
   await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>nodes.length),1,type+' undo');
 }
 checks.push('文本素材、图片素材、结果、语言和 MJ 工具节点逐类删除与撤销');
 assert.deepEqual(errors,[]);checks.push('浏览器无脚本错误；所有上游生成均模拟，测试服务禁止外部请求');
 fs.writeFileSync(path.join(out,'stage-one-browser-checks.json'),JSON.stringify({passed:true,checks,submissions:submitted.length,resumes},null,2));console.log(JSON.stringify({passed:true,checks},null,2));
})().catch(async e=>{console.error(e);if(page){console.error('Validation state:',await page.locator('.studio-prompt-count').evaluateAll(es=>es.map(el=>({text:el.textContent,hidden:el.hidden,style:el.getAttribute('style'),display:getComputedStyle(el).display,parent:el.parentElement.className}))).catch(()=>[]));await page.screenshot({path:path.join(out,'stage-one-failure.png')}).catch(()=>{});}fs.writeFileSync(path.join(out,'stage-one-server.log'),log);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child){const exit=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exit,pause(4000)]);}const target=path.resolve(runtime);assert(target.startsWith(path.join(os.tmpdir(),'deepwhite-stage-ui-')));fs.rmSync(target,{recursive:true,force:true});});
